// File primitives for the TypeScript activities. Heavy scanning (a first pass
// over 100+ MB of transcripts) happens here so only small results cross IPC.
// Reads are limited to the user's own profile folders.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

const CHUNK: usize = 4 * 1024 * 1024;
const MAX_USER_TEXTS: usize = 24;

fn roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    const VARS: &[&str] = &["USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "OneDrive"];
    #[cfg(not(windows))]
    const VARS: &[&str] = &["HOME", "CLAUDE_CONFIG_DIR"];
    for var in VARS {
        if let Some(v) = std::env::var_os(var) {
            out.push(PathBuf::from(v));
        }
    }
    out
}

/// Only paths under the user's profile folders are readable from the webview.
pub fn allowed(path: &Path) -> bool {
    allowed_in(path, &roots())
}

fn allowed_in(path: &Path, roots: &[PathBuf]) -> bool {
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let norm = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\");
    let lower = norm(path);
    roots.iter().any(|r| {
        let root = norm(r);
        let root = root.trim_end_matches('\\');
        // The root itself or something in it; not a sibling that only starts with its name ("Downloads2").
        let inside = !root.is_empty() && (lower == root || lower.strip_prefix(root).is_some_and(|rest| rest.starts_with('\\')));
        inside && !through_link(r, path)
    })
}

/// A link or junction below the root could lead anywhere on the disk, so a path through one is refused.
fn through_link(root: &Path, path: &Path) -> bool {
    let skip = root.components().count();
    let mut at = PathBuf::new();
    for (i, c) in path.components().enumerate() {
        at.push(c);
        if i >= skip && std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return true;
        }
    }
    false
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    size: f64,
    mtime_ms: f64,
    dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
    size: f64,
    mtime_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tail {
    size: f64,
    mtime_ms: f64,
    lines: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMeta {
    /// Bytes consumed so far; a trailing partial line is left for next time.
    consumed: f64,
    size: f64,
    ai_title: Option<String>,
    custom_title: Option<String>,
    permission_mode: Option<String>,
    /// Leading text of user turns (not sidechain/meta, not tool results), in order.
    user_texts: Vec<String>,
    /// What turns and the context did, in file order: ["p", ts, 0] a prompt, ["e", ts, 0] a
    /// finished reply, ["x", ts, 0] an interrupt or an API error, ["c", ts, 0] a compaction,
    /// ["u", ts, tokens] the context after one API response (its input, cache and output).
    marks: Vec<(&'static str, f64, f64)>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageScan {
    consumed: f64,
    size: f64,
    /// [dedupe key, timestamp ms, input, cache creation, output, cache read]
    entries: Vec<(String, f64, f64, f64, f64, f64)>,
}

fn stat_one(path: &str) -> Option<Stat> {
    let p = Path::new(path);
    if !allowed(p) {
        return None;
    }
    let m = std::fs::metadata(p).ok()?;
    Some(Stat { size: m.len() as f64, mtime_ms: mtime_ms(&m), dir: m.is_dir() })
}

/// Reads complete lines from `offset`, calling `each` per line, and returns the
/// new offset (just past the last newline).
fn scan_lines(path: &Path, offset: u64, size: u64, mut each: impl FnMut(&[u8])) -> std::io::Result<u64> {
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut pos = offset;
    let mut carry: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    while pos < size {
        let want = CHUNK.min((size - pos) as usize);
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        pos += n as u64;
        carry.extend_from_slice(&buf[..n]);
        let mut start = 0;
        while let Some(i) = carry[start..].iter().position(|b| *b == b'\n') {
            each(&carry[start..start + i]);
            start += i + 1;
        }
        carry.drain(..start);
    }
    Ok(pos - carry.len() as u64)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn leading_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            // Usage Clip's promptDisplay: any tool_result means this is not a prompt.
            if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            blocks
                .iter()
                .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .and_then(|b| b.get("text").and_then(Value::as_str))
                .map(str::to_string)
        }
        _ => None,
    }
}

/// The turn mark one transcript entry makes, if any (see TranscriptMeta::marks).
fn turn_marks(entry: &Value, ts: f64, meta: bool, last_message: &mut String, marks: &mut Vec<(&'static str, f64, f64)>) {
    match entry.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            if entry.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                marks.push(("x", ts, 0.0));
                return;
            }
            let Some(message) = entry.get("message") else { return };
            if let Some(usage) = message.get("usage").filter(|u| u.is_object()) {
                let id = message.get("id").and_then(Value::as_str).unwrap_or("");
                let tokens = num(usage.get("input_tokens")) + num(usage.get("cache_creation_input_tokens")) + num(usage.get("cache_read_input_tokens")) + num(usage.get("output_tokens"));
                if tokens > 0.0 && (id.is_empty() || id != last_message.as_str()) {
                    marks.push(("u", ts, tokens));
                }
                *last_message = id.to_string();
            }
            if message.get("stop_reason").and_then(Value::as_str) == Some("end_turn") {
                marks.push(("e", ts, 0.0));
            }
        }
        Some("user") if !meta => {
            let Some(text) = entry.get("message").and_then(|m| m.get("content")).and_then(leading_text) else { return };
            let text = text.trim_start();
            if text.starts_with("[Request interrupted by user") {
                marks.push(("x", ts, 0.0));
            } else if !text.starts_with("<local-command-") {
                marks.push(("p", ts, 0.0));
            }
        }
        Some("system") if entry.get("subtype").and_then(Value::as_str) == Some("compact_boundary") => marks.push(("c", ts, 0.0)),
        _ => {}
    }
}

pub fn transcript_meta(path: &Path, offset: u64, need_user: bool) -> std::io::Result<TranscriptMeta> {
    let size = std::fs::metadata(path)?.len();
    let mut out = TranscriptMeta { size: size as f64, ..Default::default() };
    let offset = if offset > size { 0 } else { offset };
    // One API response is written as several lines sharing one usage block: one "u" mark each.
    let mut last_message = String::new();
    let consumed = scan_lines(path, offset, size, |line| {
        let interesting = contains(line, b"ai-title") || contains(line, b"custom-title") || contains(line, b"permissionMode");
        let user = need_user && out.user_texts.len() < MAX_USER_TEXTS && contains(line, b"\"user\"");
        let assistant = contains(line, b"\"type\":\"assistant\"");
        // Tool results (the bulk of a transcript) are never prompts, so they are not even parsed for it.
        let prompt = contains(line, b"\"type\":\"user\"") && !contains(line, b"\"tool_use_id\"");
        let compact = contains(line, b"compact_boundary");
        if !interesting && !user && !assistant && !prompt && !compact {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else { return };
        let sidechain = entry.get("isSidechain").and_then(Value::as_bool) == Some(true);
        let meta = entry.get("isMeta").and_then(Value::as_bool) == Some(true);
        if !sidechain {
            if let Some(m) = entry.get("permissionMode").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                out.permission_mode = Some(m.to_string());
            }
            if let Some(ts) = entry.get("timestamp").and_then(Value::as_str).and_then(parse_ts) {
                turn_marks(&entry, ts, meta, &mut last_message, &mut out.marks);
            }
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(t) = entry.get("aiTitle").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    out.ai_title = Some(t.to_string());
                }
            }
            Some("custom-title") => {
                if let Some(t) = entry.get("customTitle").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    out.custom_title = Some(t.to_string());
                }
            }
            Some("user") if user && !sidechain && !meta => {
                if let Some(text) = entry.get("message").and_then(|m| m.get("content")).and_then(leading_text) {
                    out.user_texts.push(text);
                }
            }
            _ => {}
        }
    })?;
    out.consumed = consumed as f64;
    Ok(out)
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0)
}

fn parse_ts(s: &str) -> Option<f64> {
    // 2026-09-30T21:23:43.123Z → epoch ms (UTC; transcripts always write Z).
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut ms = 0i64;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        if !frac.is_empty() {
            ms = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
        }
    }
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) * 1000 + ms) as f64)
}

pub fn usage_entries(path: &Path, offset: u64) -> std::io::Result<UsageScan> {
    let size = std::fs::metadata(path)?.len();
    let offset = if offset > size { 0 } else { offset };
    let mut out = UsageScan { size: size as f64, ..Default::default() };
    let consumed = scan_lines(path, offset, size, |line| {
        if !contains(line, b"\"usage\":") {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else { return };
        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(message) = entry.get("message") else { return };
        let Some(usage) = message.get("usage").filter(|u| u.is_object()) else { return };
        let Some(ts) = entry.get("timestamp").and_then(Value::as_str).and_then(parse_ts) else { return };
        let id = message.get("id").and_then(Value::as_str).unwrap_or("");
        let req = entry.get("requestId").and_then(Value::as_str).unwrap_or("");
        let key = if !id.is_empty() || !req.is_empty() {
            format!("{id}:{req}")
        } else if let Some(uuid) = entry.get("uuid").and_then(Value::as_str) {
            uuid.to_string()
        } else {
            return;
        };
        out.entries.push((
            key,
            ts,
            num(usage.get("input_tokens")),
            num(usage.get("cache_creation_input_tokens")),
            num(usage.get("output_tokens")),
            num(usage.get("cache_read_input_tokens")),
        ));
    })?;
    out.consumed = consumed as f64;
    Ok(out)
}

// ------------------------------------------------------------------ Claude Status

const WORK_EVENTS_MAX: usize = 5000;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkScan {
    consumed: f64,
    size: f64,
    /// In file order. { k: "prompt" | "stop" | "todo" | "taskCreate" | "taskUpdate" | "shell" | "result", at, ... }
    events: Vec<Value>,
}

fn clip_chars(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// What Claude Status follows in a transcript from `offset` on: prompts (a run
/// starts), turn ends (Claude Code's turn_duration line), Claude's task list (TodoWrite, TaskCreate, TaskUpdate), the shell
/// commands it ran (Bash, PowerShell), and the results of those commands, also
/// of the `open` ones an earlier scan saw without a result yet.
pub fn transcript_work(path: &Path, offset: u64, open: &[String]) -> std::io::Result<WorkScan> {
    let size = std::fs::metadata(path)?.len();
    let offset = if offset > size { 0 } else { offset };
    let mut out = WorkScan { size: size as f64, ..Default::default() };
    let mut shells: std::collections::HashSet<String> = open.iter().cloned().collect();
    let consumed = scan_lines(path, offset, size, |line| {
        let tool = contains(line, b"\"tool_use\"");
        let user = contains(line, b"\"type\":\"user\"");
        let stop = contains(line, b"\"turn_duration\"");
        if !tool && !user && !stop {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else { return };
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) || entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(at) = entry.get("timestamp").and_then(Value::as_str).and_then(parse_ts) else { return };
        let content = entry.get("message").and_then(|m| m.get("content"));
        let blocks = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let mut push = |v: Value| {
            if out.events.len() < WORK_EVENTS_MAX {
                out.events.push(v);
            }
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                for b in blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")) {
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    match b.get("name").and_then(Value::as_str).unwrap_or("") {
                        "TodoWrite" => {
                            let todos = input.get("todos").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                            let done = todos.iter().filter(|t| t.get("status").and_then(Value::as_str) == Some("completed")).count();
                            push(serde_json::json!({ "k": "todo", "at": at, "total": todos.len(), "done": done }));
                        }
                        "TaskCreate" => push(serde_json::json!({ "k": "taskCreate", "at": at })),
                        "TaskUpdate" => {
                            let id = input.get("taskId").or_else(|| input.get("id")).map(|v| match v {
                                Value::String(s) => s.clone(),
                                other => other.to_string(),
                            });
                            push(serde_json::json!({ "k": "taskUpdate", "at": at, "id": id.unwrap_or_default(), "status": s("status") }));
                        }
                        "Bash" | "PowerShell" => {
                            let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let cmd = clip_chars(&s("command"), 400);
                            if id.is_empty() || cmd.is_empty() {
                                continue;
                            }
                            shells.insert(id.clone());
                            push(serde_json::json!({
                                "k": "shell", "at": at, "id": id, "cmd": cmd, "desc": clip_chars(&s("description"), 80),
                                "bg": input.get("run_in_background").and_then(Value::as_bool) == Some(true),
                            }));
                        }
                        _ => {}
                    }
                }
            }
            Some("system") if entry.get("subtype").and_then(Value::as_str) == Some("turn_duration") => {
                push(serde_json::json!({ "k": "stop", "at": at }));
            }
            Some("user") => {
                let results: Vec<&Value> = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")).collect();
                if results.is_empty() {
                    let text = content.and_then(leading_text).unwrap_or_default();
                    let t = text.trim_start();
                    // A prompt you sent (what UserPromptSubmit sees): newer Claude Code marks
                    // it origin "human"; without that, not a local command's output or a
                    // background task's notice.
                    let human = match entry.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str) {
                        Some(kind) => kind == "human",
                        None => !t.starts_with("<local-command") && !t.starts_with("Caveat:") && !t.starts_with("<task-notification>"),
                    };
                    if human && !t.is_empty() {
                        push(serde_json::json!({ "k": "prompt", "at": at }));
                    }
                    return;
                }
                let task = entry.get("toolUseResult").and_then(|r| r.get("backgroundTaskId")).and_then(Value::as_str);
                for r in results {
                    let Some(id) = r.get("tool_use_id").and_then(Value::as_str) else { continue };
                    if shells.contains(id) {
                        push(serde_json::json!({ "k": "result", "at": at, "id": id, "task": task }));
                    }
                }
            }
            _ => {}
        }
    })?;
    out.consumed = consumed as f64;
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    session: String,
    started: u32,
    finished: u32,
    first_ms: f64,
}

fn created_ms(meta: &std::fs::Metadata) -> f64 {
    meta.created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_else(|| mtime_ms(meta))
}

/// Background workflow agents still working for these sessions, from
/// <projects>/<project>/<session>/subagents/workflows/<run>/journal.jsonl
/// (launched / started / result / failed). A run whose files have not changed
/// for `stale_ms` is dead, not running.
pub fn workflows(projects: &Path, sessions: &[String], stale_ms: f64) -> Vec<WorkflowRun> {
    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
    let Ok(rd) = std::fs::read_dir(projects) else { return Vec::new() };
    let project_dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    let mut out = Vec::new();
    for sid in sessions.iter().filter(|s| crate::claude::is_uuid(s)) {
        let (mut started, mut finished, mut first) = (0u32, 0u32, f64::MAX);
        for proj in &project_dirs {
            let Ok(runs) = std::fs::read_dir(proj.join(sid).join("subagents").join("workflows")) else { continue };
            for run in runs.flatten().map(|e| e.path()) {
                let journal = run.join("journal.jsonl");
                let Ok(jmeta) = std::fs::metadata(&journal) else { continue };
                let last = std::fs::read_dir(&run)
                    .map(|rd| {
                        rd.flatten()
                            .filter(|e| e.file_name().to_string_lossy().ends_with(".jsonl"))
                            .filter_map(|e| e.metadata().ok())
                            .map(|m| mtime_ms(&m))
                            .fold(0.0, f64::max)
                    })
                    .unwrap_or(0.0);
                if now - last > stale_ms {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&journal) else { continue };
                let (mut s, mut f) = (0u32, 0u32);
                for line in text.lines() {
                    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                    match v.get("type").and_then(Value::as_str) {
                        Some("started") => s += 1,
                        Some("result") | Some("failed") => f += 1,
                        _ => {}
                    }
                }
                if s > f {
                    started += s;
                    finished += f;
                    first = first.min(created_ms(&jmeta));
                }
            }
        }
        if started > 0 {
            out.push(WorkflowRun { session: sid.clone(), started, finished, first_ms: first });
        }
    }
    out
}

/// A background shell that ran to the end (not stopped): Claude Code ends its
/// output file, %TEMP%\claude\<project>\<session>\tasks\<task>.output, with
/// "[exited with code N]".
pub fn task_finished(session: &str, task: &str) -> bool {
    if !crate::claude::is_uuid(session) || task.is_empty() || !task.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir().join("claude")) else { return false };
    for proj in rd.flatten() {
        let file = proj.path().join(session).join("tasks").join(format!("{task}.output"));
        let Ok(mut f) = std::fs::File::open(&file) else { continue };
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(size.saturating_sub(200))).is_ok() && f.read_to_end(&mut buf).is_ok() {
            return contains(&buf, b"[exited with code");
        }
    }
    false
}

fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<Tail> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let start = size.saturating_sub(max_bytes);
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    f.take(size - start).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // a partial line
    }
    Ok(Tail { size: size as f64, mtime_ms: mtime_ms(&meta), lines })
}

fn list_files(dir: &Path, recursive: bool, ext: &str, max_age_ms: f64, out: &mut Vec<Entry>, depth: u32) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let path = e.path();
        if meta.is_dir() {
            if recursive && depth < 6 {
                list_files(&path, recursive, ext, max_age_ms, out, depth + 1);
            }
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !ext.is_empty() && !name.to_lowercase().ends_with(ext) {
            continue;
        }
        let m = mtime_ms(&meta);
        if max_age_ms > 0.0 && now - m > max_age_ms {
            continue;
        }
        out.push(Entry { name, path: path.to_string_lossy().to_string(), dir: false, size: meta.len() as f64, mtime_ms: m });
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn fs_stat_many(paths: Vec<String>) -> Vec<Option<Stat>> {
    paths.iter().map(|p| stat_one(p)).collect()
}

#[tauri::command]
pub fn fs_read_dir(path: String) -> Option<Vec<Entry>> {
    let p = PathBuf::from(&path);
    if !allowed(&p) {
        return None;
    }
    let rd = std::fs::read_dir(&p).ok()?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        out.push(Entry {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            dir: meta.is_dir(),
            size: meta.len() as f64,
            mtime_ms: mtime_ms(&meta),
        });
    }
    Some(out)
}

#[tauri::command]
pub async fn fs_list_files(dir: String, recursive: bool, ext: String, max_age_ms: f64) -> Vec<Entry> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&dir);
        let mut out = Vec::new();
        if allowed(&p) {
            list_files(&p, recursive, &ext.to_lowercase(), max_age_ms, &mut out, 0);
        }
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn fs_read_tail(path: String, max_bytes: u64) -> Option<Tail> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return None;
        }
        read_tail(&p, max_bytes.clamp(1024, 64 * 1024 * 1024)).ok()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn fs_read_text(path: String, max_bytes: u64) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return None;
        }
        let meta = std::fs::metadata(&p).ok()?;
        if meta.len() > max_bytes.max(1) {
            return None;
        }
        let bytes = std::fs::read(&p).ok()?;
        let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        Some(String::from_utf8_lossy(text).to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn fs_read_bytes(path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return Err("not allowed".to_string());
        }
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.len() > max_bytes {
            return Err("too large".to_string());
        }
        std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_transcript_meta(path: String, offset: f64, need_user: bool) -> Option<TranscriptMeta> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return None;
        }
        transcript_meta(&p, offset.max(0.0) as u64, need_user).ok()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn claude_usage_entries(path: String, offset: f64) -> Option<UsageScan> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return None;
        }
        usage_entries(&p, offset.max(0.0) as u64).ok()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn claude_transcript_work(path: String, offset: f64, open: Vec<String>) -> Option<WorkScan> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !allowed(&p) {
            return None;
        }
        transcript_work(&p, offset.max(0.0) as u64, &open).ok()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn claude_workflows(projects_dir: String, sessions: Vec<String>, stale_ms: f64) -> Vec<WorkflowRun> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&projects_dir);
        if !allowed(&p) {
            return Vec::new();
        }
        workflows(&p, &sessions, stale_ms)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn claude_task_finished(session_id: String, task: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || task_finished(&session_id, &task)).await.unwrap_or(false)
}

// ------------------------------------------------------------------ watching

#[derive(Default)]
pub struct Watches(pub Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsChange {
    id: String,
    kind: String,
    paths: Vec<String>,
}

/// Watches a folder and emits `fs-change` { id, kind, paths } to the island.
#[tauri::command]
pub fn fs_watch(app: AppHandle, state: tauri::State<'_, Watches>, id: String, path: String, recursive: bool) -> bool {
    let p = PathBuf::from(&path);
    if !allowed(&p) || !p.is_dir() {
        return false;
    }
    let emit_id = id.clone();
    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let kind = match ev.kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
            notify::EventKind::Modify(_) => "modify",
            notify::EventKind::Remove(_) => "remove",
            _ => return,
        };
        let paths = ev.paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let _ = handle.emit_to(crate::overlay::LABEL, "fs-change", FsChange { id: emit_id.clone(), kind: kind.into(), paths });
    });
    let Ok(mut watcher) = watcher else { return false };
    let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
    if watcher.watch(&p, mode).is_err() {
        return false;
    }
    state.0.lock().unwrap().insert(id, watcher);
    true
}

#[tauri::command]
pub fn fs_unwatch(state: tauri::State<'_, Watches>, id: String) {
    state.0.lock().unwrap().remove(&id);
}

/// Home-relative well-known folders the activities watch.
#[tauri::command]
pub fn known_folders() -> serde_json::Value {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let one = std::env::var("OneDrive").unwrap_or_default();
    let pick = |rel: &str| -> String {
        let local = Path::new(&home).join(rel);
        let synced = Path::new(&one).join(rel);
        if !one.is_empty() && synced.is_dir() && !local.is_dir() {
            synced.to_string_lossy().to_string()
        } else {
            local.to_string_lossy().to_string()
        }
    };
    let shots_local = Path::new(&home).join("Pictures").join("Screenshots");
    let shots_synced = Path::new(&one).join("Pictures").join("Screenshots");
    let mut screenshots = Vec::new();
    for p in [shots_local, shots_synced] {
        if p.is_dir() {
            screenshots.push(p.to_string_lossy().to_string());
        }
    }
    serde_json::json!({
        "home": home,
        "downloads": Path::new(&home).join("Downloads").to_string_lossy(),
        "desktop": pick("Desktop"),
        "pictures": pick("Pictures"),
        "screenshots": screenshots,
        "appData": std::env::var("APPDATA").unwrap_or_default(),
        "localAppData": std::env::var("LOCALAPPDATA").unwrap_or_default(),
        // Island's own folder (log, relay, models) on either system.
        "islandData": crate::log::data_dir().to_string_lossy(),
    })
}

#[allow(dead_code)]
pub fn debounce() -> Duration {
    Duration::from_millis(120)
}

#[cfg(test)]
mod tests {

    #[test]
    fn only_inside_a_root_and_not_a_lookalike_sibling() {
        let root = std::env::temp_dir().join(format!("island-fsx-{}", std::process::id()));
        let roots = vec![root.join("Downloads")];
        assert!(super::allowed_in(&root.join("Downloads").join("a.txt"), &roots));
        assert!(super::allowed_in(&root.join("Downloads"), &roots));
        assert!(!super::allowed_in(&root.join("Downloads2").join("a.txt"), &roots), "a sibling that starts with the root's name");
        assert!(!super::allowed_in(&root.join("Downloads").join("..").join("x"), &roots));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_below_a_root_is_refused() {
        let root = std::env::temp_dir().join(format!("island-fsx-j-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::fs::write(root.join("elsewhere").join("secret.txt"), "x").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("home").join("link"))
            .arg(root.join("elsewhere"))
            .output()
            .is_ok_and(|o| o.status.success());
        if !made {
            return; // no junctions here (another file system): nothing to check
        }
        let roots = vec![root.join("home")];
        assert!(!super::allowed_in(&root.join("home").join("link").join("secret.txt"), &roots));
        assert!(super::allowed_in(&root.join("home").join("plain.txt"), &roots));
        let _ = std::fs::remove_dir_all(&root);
    }

    use super::*;

    #[test]
    fn timestamps_parse_to_epoch_ms() {
        assert_eq!(parse_ts("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_ts("2026-09-30T21:23:43.123Z"), Some(1_790_803_423_123.0));
        assert_eq!(parse_ts("2026-09-30T21:23:43Z"), Some(1_790_803_423_000.0));
        assert_eq!(parse_ts("nope"), None);
    }

    #[test]
    fn meta_and_usage_scans_read_complete_lines_only() {
        let dir = std::env::temp_dir().join(format!("island-fsx-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("t.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"hello there"},"permissionMode":"default","timestamp":"2026-09-30T00:00:00.000Z"}"#,
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100}},"timestamp":"2026-09-30T00:00:01.000Z"}"#,
            r#"{"type":"ai-title","aiTitle":"Greeting"}"#,
            r#"{"type":"user","isSidechain":true,"permissionMode":"plan","message":{"content":"side"}}"#,
        ];
        let mut body = lines.join("\n");
        body.push('\n');
        body.push_str(r#"{"type":"custom-title","customTitle":"partial"#); // no newline yet
        std::fs::write(&file, &body).unwrap();

        let meta = transcript_meta(&file, 0, true).unwrap();
        assert_eq!(meta.ai_title.as_deref(), Some("Greeting"));
        assert_eq!(meta.custom_title, None, "a partial line must wait");
        assert_eq!(meta.permission_mode.as_deref(), Some("default"), "sidechain modes are ignored");
        assert_eq!(meta.user_texts, vec!["hello there".to_string()]);
        assert!(meta.consumed < meta.size);

        let usage = usage_entries(&file, 0).unwrap();
        assert_eq!(usage.entries.len(), 1);
        assert_eq!(usage.entries[0].0, "m1:r1");
        assert_eq!(usage.entries[0].2, 10.0);
        assert_eq!(usage.entries[0].5, 100.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn turn_marks_say_when_turns_start_and_end_and_how_full_the_context_is() {
        let dir = std::env::temp_dir().join(format!("island-fsx-marks-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("t.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"fix the bug"},"timestamp":"2026-09-30T00:00:00.000Z"}"#,
            // One response written as two lines: one "u" mark.
            r#"{"type":"assistant","message":{"id":"m1","stop_reason":"tool_use","usage":{"input_tokens":2,"cache_creation_input_tokens":1000,"cache_read_input_tokens":9000,"output_tokens":50}},"timestamp":"2026-09-30T00:00:05.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"m1","stop_reason":"tool_use","usage":{"input_tokens":2,"cache_creation_input_tokens":1000,"cache_read_input_tokens":9000,"output_tokens":50}},"timestamp":"2026-09-30T00:00:05.000Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"timestamp":"2026-09-30T00:00:06.000Z"}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"a reminder"},"timestamp":"2026-09-30T00:00:07.000Z"}"#,
            r#"{"type":"assistant","message":{"id":"m2","stop_reason":"end_turn","usage":{"input_tokens":3,"cache_read_input_tokens":11000,"output_tokens":400}},"timestamp":"2026-09-30T00:01:00.000Z"}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"s1","stop_reason":"end_turn","usage":{"input_tokens":9}},"timestamp":"2026-09-30T00:01:01.000Z"}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>Set model</local-command-stdout>"},"timestamp":"2026-09-30T00:02:00.000Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-09-30T00:03:00.000Z"}"#,
            r#"{"type":"assistant","isApiErrorMessage":true,"message":{"id":"m3"},"timestamp":"2026-09-30T00:04:00.000Z"}"#,
            r#"{"type":"system","subtype":"compact_boundary","timestamp":"2026-09-30T00:05:00.000Z"}"#,
        ];
        let mut body = lines.join("\n");
        body.push('\n');
        std::fs::write(&file, &body).unwrap();

        let meta = transcript_meta(&file, 0, false).unwrap();
        let t0 = parse_ts("2026-09-30T00:00:00.000Z").unwrap();
        let marks: Vec<(&str, f64, f64)> = meta.marks.iter().map(|(k, ts, n)| (*k, (ts - t0) / 1000.0, *n)).collect();
        assert_eq!(
            marks,
            vec![("p", 0.0, 0.0), ("u", 5.0, 10_052.0), ("u", 60.0, 11_403.0), ("e", 60.0, 0.0), ("x", 180.0, 0.0), ("x", 240.0, 0.0), ("c", 300.0, 0.0)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn work_scan_follows_prompts_tasks_and_shells() {
        let dir = std::env::temp_dir().join(format!("island-work-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("w.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"build it"},"timestamp":"2026-09-30T00:00:00.000Z"}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"},"timestamp":"2026-09-30T00:00:00.500Z"}"#,
            r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>done</task-notification>"},"timestamp":"2026-09-30T00:00:00.600Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"status":"completed"},{"status":"pending"}]}},{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"npm run dev","description":"Dev server","run_in_background":true}}]},"timestamp":"2026-09-30T00:00:01.000Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"started"}]},"toolUseResult":{"backgroundTaskId":"b9"},"timestamp":"2026-09-30T00:00:02.000Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"timestamp":"2026-09-30T00:00:02.500Z"}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"s1","name":"TaskCreate","input":{}}]},"timestamp":"2026-09-30T00:00:03.000Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"TaskUpdate","input":{"taskId":7,"status":"completed"}}]},"timestamp":"2026-09-30T00:00:04.000Z"}"#,
            r#"{"type":"system","subtype":"turn_duration","durationMs":4000,"timestamp":"2026-09-30T00:00:04.500Z"}"#,
            r#"{"type":"system","subtype":"away_summary","timestamp":"2026-09-30T00:09:00.000Z"}"#,
        ];
        let mut body = lines.join("\n");
        body.push('\n');
        std::fs::write(&file, &body).unwrap();

        let scan = transcript_work(&file, 0, &[]).unwrap();
        let kinds: Vec<&str> = scan.events.iter().map(|e| e["k"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["prompt", "todo", "shell", "result", "taskUpdate", "stop"], "local output, other results, sidechains and later notes are skipped");
        assert_eq!(scan.events[1]["total"], 2);
        assert_eq!(scan.events[1]["done"], 1);
        assert_eq!(scan.events[2]["cmd"], "npm run dev");
        assert_eq!(scan.events[2]["bg"], true);
        assert_eq!(scan.events[3]["task"], "b9");
        assert_eq!(scan.events[4]["id"], "7");
        assert_eq!(scan.consumed, scan.size);

        // A later scan still sees results for calls an earlier one left open.
        std::fs::write(&file, format!("{body}{}\n", r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"done"}]},"timestamp":"2026-09-30T00:00:05.000Z"}"#)).unwrap();
        let later = transcript_work(&file, scan.consumed as u64, &["t9".to_string()]).unwrap();
        assert_eq!(later.events.len(), 1);
        assert_eq!(later.events[0]["k"], "result");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
