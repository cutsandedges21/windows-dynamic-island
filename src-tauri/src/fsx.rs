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
    for var in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "OneDrive"] {
        if let Some(v) = std::env::var_os(var) {
            out.push(PathBuf::from(v));
        }
    }
    out
}

/// Only paths under the user's profile folders are readable from the webview.
pub fn allowed(path: &Path) -> bool {
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let lower = path.to_string_lossy().to_lowercase().replace('/', "\\");
    roots().iter().any(|r| {
        let root = r.to_string_lossy().to_lowercase().replace('/', "\\");
        !root.is_empty() && lower.starts_with(&root)
    })
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

pub fn transcript_meta(path: &Path, offset: u64, need_user: bool) -> std::io::Result<TranscriptMeta> {
    let size = std::fs::metadata(path)?.len();
    let mut out = TranscriptMeta { size: size as f64, ..Default::default() };
    let offset = if offset > size { 0 } else { offset };
    let consumed = scan_lines(path, offset, size, |line| {
        let interesting = contains(line, b"ai-title") || contains(line, b"custom-title") || contains(line, b"permissionMode");
        let user = need_user && out.user_texts.len() < MAX_USER_TEXTS && contains(line, b"\"user\"");
        if !interesting && !user {
            return;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else { return };
        let sidechain = entry.get("isSidechain").and_then(Value::as_bool) == Some(true);
        let meta = entry.get("isMeta").and_then(Value::as_bool) == Some(true);
        if !sidechain {
            if let Some(m) = entry.get("permissionMode").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                out.permission_mode = Some(m.to_string());
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
    let home = std::env::var("USERPROFILE").unwrap_or_default();
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
    })
}

#[allow(dead_code)]
pub fn debounce() -> Duration {
    Duration::from_millis(120)
}

#[cfg(test)]
mod tests {
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
}
