// Codex access that has to be native: where Codex keeps its files, finding codex.exe,
// reopening a chat in a console, and Island's hooks in ~/.codex/hooks.json, which Codex
// runs only once they are trusted. Island trusts its own through Codex's own settings
// call (`codex app-server`: hooks/list, then config/batchWrite of
// hooks.state."<key>".trusted_hash), shown in the preview before the click. Session
// tracking itself is TypeScript (src/activities/codex).
//
// Codex on Windows runs a hook command through `powershell.exe -NoProfile -Command`, so
// the command uses PowerShell's call operator: `& 'C:\…\island-hook.exe' codex Stop`.
// Verified with Codex 0.158 on 2026-10-30: docs/superpowers/specs/2026-10-30-codex-in-island-design.md.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::claude::{home, hook_exe_path};
use crate::hooks::{fingerprint, pretty, stamp, unified_diff, write_embedded_hook};
use crate::nowindow::NoWindow;

/// Every event the island reacts to, with the hook timeout written to hooks.json (seconds).
/// PermissionRequest waits for a human (island-hook gives up at 110 s), Stop may wait for a
/// reply typed in the island (290 s); SessionEnd and Interrupt allow 3 s at most.
pub const CODEX_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 3),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 300),
    ("Interrupt", 3),
    ("SubagentStop", 10),
];

const MARKER: &str = "island-hook";
/// The whole trust exchange with `codex app-server`.
const TRUST_BUDGET: Duration = Duration::from_secs(20);

pub fn codex_home() -> PathBuf {
    match std::env::var_os("CODEX_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(".codex"),
    }
}

pub fn hooks_path() -> PathBuf {
    codex_home().join("hooks.json")
}

const CODEX_BIN: &str = if cfg!(windows) { "codex.exe" } else { "codex" };

/// codex.exe: on PATH, else the copy npm installed, else the newest one the Codex app keeps.
pub fn find_codex_exe() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(CODEX_BIN);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let mut found: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let vendor = PathBuf::from(appdata).join("npm").join("node_modules").join("@openai").join("codex").join("vendor");
        collect_named(&vendor, CODEX_BIN, 3, &mut found);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let app_bins = PathBuf::from(local).join("OpenAI").join("Codex").join("bin");
        collect_named(&app_bins, CODEX_BIN, 1, &mut found);
    }
    // A Mac: where Homebrew and npm put it (an app from the Dock has only the system's PATH), else
    // the copy inside the Codex app.
    #[cfg(target_os = "macos")]
    {
        if let Some(p) = crate::mac::ai::program(CODEX_BIN) {
            return Some(p);
        }
        if let Some(app) = crate::mac::ai::app_bundle("Codex") {
            collect_named(&app.join("Contents").join("Resources"), CODEX_BIN, 3, &mut found);
        }
    }
    found.into_iter().max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

fn collect_named(dir: &Path, name: &str, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_named(&p, name, depth - 1, out);
            }
        } else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            out.push(p);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEnv {
    home: String,
    sessions_dir: String,
    archived_dir: String,
    index_path: String,
    codex_exe: Option<String>,
    hook_exe: String,
    hook_ready: bool,
}

/// None when Codex has never run on this PC (no Codex home).
#[tauri::command]
pub fn codex_env() -> Option<CodexEnv> {
    let root = codex_home();
    if !root.is_dir() {
        return None;
    }
    let hook = hook_exe_path();
    Some(CodexEnv {
        home: root.to_string_lossy().to_string(),
        sessions_dir: root.join("sessions").to_string_lossy().to_string(),
        archived_dir: root.join("archived_sessions").to_string_lossy().to_string(),
        index_path: root.join("session_index.jsonl").to_string_lossy().to_string(),
        codex_exe: find_codex_exe().map(|p| p.to_string_lossy().to_string()),
        hook_ready: hook.is_file(),
        hook_exe: hook.to_string_lossy().to_string(),
    })
}

// ------------------------------------------------------------------ resume

/// Reopens a chat: `codex resume <id> [prompt]` in its own console, minimized without focus
/// when `minimized` (a reply sent from the island), else in front.
#[cfg(windows)]
#[tauri::command]
pub fn codex_resume(session_id: String, cwd: String, prompt: Option<String>, minimized: bool) -> bool {
    if !crate::claude::is_uuid(&session_id) || !crate::claude::cwd_ok(&cwd) {
        crate::log::line(format!("codex resume refused id_ok={} cwd_ok={}", crate::claude::is_uuid(&session_id), crate::claude::cwd_ok(&cwd)));
        return false;
    }
    let Some(exe) = find_codex_exe() else {
        crate::log::line("codex resume: codex.exe not found");
        return false;
    };
    let prompt = prompt.map(|p| crate::claude::clean_prompt(&p)).filter(|p| !p.is_empty());
    let mut args = vec!["resume", session_id.as_str()];
    if let Some(p) = prompt.as_deref() {
        args.push(p);
    }
    let ok = crate::claude::spawn_console(&exe, &args, &cwd, minimized);
    crate::log::line(format!("codex resume {session_id} prompt={} minimized={minimized} ok={ok}", prompt.is_some()));
    ok
}

/// A Mac: `codex resume <id> [prompt]` in a new Terminal window, minimized when the reply came from
/// the island.
#[cfg(not(windows))]
#[tauri::command]
pub async fn codex_resume(session_id: String, cwd: String, prompt: Option<String>, minimized: bool) -> bool {
    if !crate::claude::is_uuid(&session_id) || !crate::claude::cwd_ok(&cwd) {
        crate::log::line(format!("codex resume refused id_ok={} cwd_ok={}", crate::claude::is_uuid(&session_id), crate::claude::cwd_ok(&cwd)));
        return false;
    }
    let Some(exe) = find_codex_exe() else {
        crate::log::line("codex resume: codex not found");
        return false;
    };
    let prompt = prompt.map(|p| crate::claude::clean_prompt(&p)).filter(|p| !p.is_empty());
    let quiet = minimized || prompt.is_some();
    let mut argv = vec![exe.to_string_lossy().to_string(), "resume".to_string(), session_id.clone()];
    if let Some(p) = prompt.clone() {
        argv.push(p);
    }
    let ok = tauri::async_runtime::spawn_blocking(move || crate::mac::claude::run_in_terminal(&cwd, &argv, quiet)).await.unwrap_or(false);
    crate::log::line(format!("codex resume {session_id} in Terminal prompt={} minimized={quiet} ok={ok}", prompt.is_some()));
    ok
}

// ------------------------------------------------------------------ hooks.json

/// The command Codex runs for one event. On Windows it goes through PowerShell, where a
/// quoted path is a string, not a command: the call operator runs it.
pub fn hook_command(exe: &Path, event: &str) -> String {
    let path = exe.to_string_lossy();
    if cfg!(windows) {
        format!("& '{}' codex {event}", path.replace('\'', "''"))
    } else {
        format!("'{}' codex {event}", path.replace('\'', "'\\''"))
    }
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| hooks.iter().any(|h| h.get("command").and_then(Value::as_str).map(|c| c.contains(MARKER)).unwrap_or(false)))
        .unwrap_or(false)
}

fn merged(existing: &Value, exe: &Path) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, timeout) in CODEX_EVENTS {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(json!({ "hooks": [{ "type": "command", "command": hook_command(exe, event), "timeout": timeout }] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> = list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn parse_hooks(bytes: &[u8], path: &str) -> Result<Value, String> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object, so Island won't touch it.")),
        Err(err) => Err(format!("{path} isn't valid JSON ({err}). Fix or move it, then try again.")),
    }
}

fn read_hooks() -> Result<Value, String> {
    let path = hooks_path();
    match std::fs::read(&path) {
        Ok(bytes) => parse_hooks(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn current_fingerprint() -> String {
    match std::fs::read(hooks_path()) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

fn backup_path() -> PathBuf {
    hooks_path().with_file_name(format!("hooks.json.bak-{}", stamp()))
}

/// "PermissionRequest" → "permission_request": how Codex names an event in a hook's key.
fn snake(event: &str) -> String {
    let mut out = String::new();
    for (i, c) in event.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The trust entries Codex will hold for Island's hooks in `doc`: `<hooks.json>:<event>:<group>:0`,
/// where the group is the position of Island's entry in that event's list.
fn trust_lines(doc: &Value, hooks_file: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for (event, _) in CODEX_EVENTS {
        let Some(list) = doc.get("hooks").and_then(|h| h.get(*event)).and_then(Value::as_array) else { continue };
        if let Some(group) = list.iter().position(entry_is_ours) {
            out.push(format!("hooks.state.'{}:{}:{group}:0'.trusted_hash", hooks_file.display(), snake(event)));
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookStatus {
    installed: bool,
    up_to_date: bool,
    codex_found: bool,
    hooks_path: String,
    hook_path: String,
    hook_ready: bool,
    error: Option<String>,
}

pub fn status() -> CodexHookStatus {
    let hook = hook_exe_path();
    let (current, error) = match read_hooks() {
        Ok(v) => (v, None),
        Err(e) => (json!({}), Some(e)),
    };
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| hooks.values().filter_map(Value::as_array).flatten().any(entry_is_ours))
        .unwrap_or(false);
    CodexHookStatus {
        installed,
        up_to_date: installed && merged(&current, &hook) == current,
        codex_found: find_codex_exe().is_some(),
        hooks_path: hooks_path().to_string_lossy().to_string(),
        hook_ready: hook.is_file(),
        hook_path: hook.to_string_lossy().to_string(),
        error,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookPreview {
    diff: String,
    backup: String,
    hooks_path: String,
    fingerprint: String,
    /// What installing also writes to config.toml through Codex: one trust entry per hook.
    trust: Vec<String>,
}

pub fn preview(install: bool) -> Result<CodexHookPreview, String> {
    let current = read_hooks()?;
    let next = if install { merged(&current, &hook_exe_path()) } else { without_ours(&current) };
    Ok(CodexHookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        hooks_path: hooks_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(),
        trust: if install { trust_lines(&next, &hooks_path()) } else { Vec::new() },
    })
}

/// Writes hooks.json after a dated backup, and only if the file is still the one previewed.
/// Returns the backup's path (empty when there was no file to back up).
pub fn write(install: bool, fp: &str) -> Result<String, String> {
    let path = hooks_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let current = read_hooks()?;
    if current_fingerprint() != fp {
        return Err(format!("{} changed since the preview. Nothing was written; review the new diff.", path.display()));
    }
    let mut backup = String::new();
    if path.exists() {
        let b = backup_path();
        std::fs::copy(&path, &b).map_err(|e| format!("backup failed: {e}"))?;
        backup = b.to_string_lossy().to_string();
    }
    let next = if install { merged(&current, &hook_exe_path()) } else { without_ours(&current) };
    let mut text = pretty(&next);
    text.push('\n');
    let temp = path.with_extension(format!("json.island-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    crate::log::line(format!("codex hooks {} (backup {})", if install { "installed" } else { "removed" }, if backup.is_empty() { "none" } else { &backup }));
    Ok(backup)
}

// ------------------------------------------------------------------ trust, through codex app-server

/// Island's hooks from a hooks/list reply (`data[].hooks[]`).
fn island_hooks(list: &Value) -> Vec<&Value> {
    list.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|h| h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER)))
        .collect()
}

/// config/batchWrite edits that trust Island's hooks Codex doesn't trust yet.
fn trust_edits(list: &Value) -> Vec<Value> {
    island_hooks(list)
        .into_iter()
        .filter(|h| matches!(h.get("trustStatus").and_then(Value::as_str), Some("untrusted" | "modified")))
        .filter_map(|h| {
            let key = h.get("key")?.as_str()?;
            let hash = h.get("currentHash")?.as_str()?;
            Some(json!({ "keyPath": format!("hooks.state.{}.trusted_hash", Value::String(key.to_string())), "value": hash, "mergeStrategy": "upsert" }))
        })
        .collect()
}

/// True when Island has hooks there and Codex trusts every one of them.
fn all_trusted(list: &Value) -> bool {
    let ours = island_hooks(list);
    !ours.is_empty() && ours.iter().all(|h| matches!(h.get("trustStatus").and_then(Value::as_str), Some("trusted" | "managed")))
}

/// One `codex app-server` over stdio: JSON lines, requests answered by id. Killed when dropped.
struct AppServer {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next: u64,
    deadline: Instant,
}

impl AppServer {
    fn start(exe: &Path) -> Result<AppServer, String> {
        let mut child = Command::new(exe)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
            .map_err(|e| format!("Couldn't start Codex: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr_pipe = child.stderr.take().ok_or("no stderr")?;
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = stderr.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
                let mut s = sink.lock().unwrap();
                s.push_str(&line);
                s.push('\n');
                if s.len() > 4096 {
                    let cut = s.len() - 4096;
                    s.drain(..cut);
                }
            }
        });
        Ok(AppServer { child, stdin, lines, stderr, next: 1, deadline: Instant::now() + TRUST_BUDGET })
    }

    /// Codex's own words when it stopped (its error, e.g. a config it can't read), else `fallback`.
    fn why(&self, fallback: &str) -> String {
        let err = self.stderr.lock().unwrap();
        let last = err.lines().rev().find(|l| !l.trim().is_empty() && !l.trim_start().starts_with("Caused by")).unwrap_or("").trim();
        if last.is_empty() {
            fallback.to_string()
        } else {
            last.trim_start_matches("Error: ").to_string()
        }
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{msg}").and_then(|_| self.stdin.flush()).map_err(|_| self.why("Codex stopped"))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        loop {
            let left = self.deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(left) {
                Ok(l) => l,
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(format!("Codex didn't answer {method} in time")),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Its stderr may still be arriving.
                    std::thread::sleep(Duration::from_millis(150));
                    return Err(self.why("Codex stopped"));
                }
            };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if msg.get("method").is_some() {
                // A request from Codex (approvals and the like) gets a polite no; notifications pass.
                if let Some(rid) = msg.get("id").cloned() {
                    let _ = self.send(&json!({ "id": rid, "error": { "code": -32601, "message": "not handled by Island" } }));
                }
                continue;
            }
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(err.get("message").and_then(Value::as_str).unwrap_or("Codex refused").to_string());
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Asks Codex whether it trusts Island's hooks, and with `trust` has it trust them first.
/// Ok(true): every Island hook runs. Err: Codex's own message.
fn trust_session(trust: bool) -> Result<bool, String> {
    let exe = find_codex_exe().ok_or("Codex isn't installed on this PC (codex.exe not found).")?;
    let mut server = AppServer::start(&exe)?;
    server.request(
        "initialize",
        json!({ "clientInfo": { "name": "island", "title": "Island", "version": env!("CARGO_PKG_VERSION") }, "capabilities": { "experimentalApi": true, "requestAttestation": false } }),
    )?;
    server.send(&json!({ "method": "initialized" }))?;
    let cwds = json!({ "cwds": [codex_home().to_string_lossy()] });
    let mut list = server.request("hooks/list", cwds.clone())?;
    if trust {
        let edits = trust_edits(&list);
        if !edits.is_empty() {
            let n = edits.len();
            server.request("config/batchWrite", json!({ "edits": edits, "reloadUserConfig": true }))?;
            crate::log::line(format!("codex hooks: trusted {n}"));
            list = server.request("hooks/list", cwds)?;
        }
    }
    Ok(all_trusted(&list))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustResult {
    trusted: bool,
    error: Option<String>,
}

fn trust_result(trust: bool) -> TrustResult {
    match trust_session(trust) {
        Ok(trusted) => TrustResult { trusted, error: None },
        Err(e) => {
            crate::log::line(format!("codex hooks trust{}: {e}", if trust { "" } else { " check" }));
            TrustResult { trusted: false, error: Some(e) }
        }
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn codex_hooks_status() -> CodexHookStatus {
    status()
}

#[tauri::command]
pub fn codex_hooks_preview(install: bool) -> Value {
    match preview(install) {
        Ok(p) => serde_json::to_value(p).unwrap_or(Value::Null),
        Err(e) => json!({ "error": e }),
    }
}

/// Installs (then trusts) or removes Island's Codex hooks.
#[tauri::command]
pub async fn codex_hooks_write(install: bool, fingerprint: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || match write(install, &fingerprint) {
        Ok(backup) if install => {
            let t = trust_result(true);
            json!({ "ok": true, "backup": backup, "trusted": t.trusted, "trustError": t.error })
        }
        Ok(backup) => json!({ "ok": true, "backup": backup }),
        Err(e) => json!({ "ok": false, "error": e }),
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

/// Does Codex run Island's hooks? With `trust`, it is asked to first (the panel's Try again).
#[tauri::command]
pub async fn codex_hooks_trust(trust: bool) -> TrustResult {
    tauri::async_runtime::spawn_blocking(move || trust_result(trust)).await.unwrap_or(TrustResult { trusted: false, error: Some("Island stopped asking".into()) })
}

/// `island.exe --install-codex-hooks` / `--remove-codex-hooks`.
pub fn cli(install: bool) -> i32 {
    let hook = hook_exe_path();
    if install {
        write_embedded_hook(&hook);
        if !hook.is_file() {
            println!("island-hook.exe is missing at {}. Start Island once, then try again.", hook.display());
            return 2;
        }
    }
    let plan = match preview(install) {
        Ok(p) => p,
        Err(e) => {
            println!("{e}");
            return 1;
        }
    };
    println!("{}\n{}", plan.hooks_path, plan.diff);
    match write(install, &plan.fingerprint) {
        Ok(backup) => {
            println!("{} Codex hooks.{}", if install { "Installed" } else { "Removed" }, if backup.is_empty() { String::new() } else { format!(" Backup: {backup}") });
            if install {
                let t = trust_result(true);
                match t.error {
                    Some(e) => println!("Codex didn't trust them yet: {e}"),
                    None if t.trusted => println!("Codex trusts them."),
                    None => println!("Codex still lists some as not trusted: open Codex and type /hooks."),
                }
            }
            0
        }
        Err(e) => {
            println!("{e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_goes_through_powershell_s_call_operator() {
        let exe = Path::new(r"C:\Users\O'Neil\AppData\Local\Island\bin\island-hook.exe");
        if cfg!(windows) {
            assert_eq!(hook_command(exe, "Stop"), r"& 'C:\Users\O''Neil\AppData\Local\Island\bin\island-hook.exe' codex Stop");
        } else {
            assert!(hook_command(exe, "Stop").ends_with("' codex Stop"));
        }
    }

    #[test]
    fn merging_keeps_everything_else_and_removing_restores_it() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let existing = json!({
            "description": "my hooks",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "node notify.mjs", "timeout": 5 }] }],
                "Other": [{ "matcher": "x", "hooks": [{ "type": "command", "command": "keep-me.exe" }] }]
            }
        });
        let after = merged(&existing, exe);
        assert_eq!(after["description"], "my hooks");
        let stop = after["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert!(stop[0].to_string().contains("notify.mjs"));
        assert_eq!(stop[1]["hooks"][0]["timeout"], 300);
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains("island-hook.exe' codex Stop") || !cfg!(windows));
        assert_eq!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 120);
        assert_eq!(after["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3);
        assert_eq!(merged(&after, exe), after, "installing twice changes nothing");
        assert_eq!(without_ours(&after), existing);
        assert_eq!(without_ours(&merged(&json!({}), exe)), json!({}));
    }

    #[test]
    fn trust_lines_name_codex_s_keys() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let existing = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "node notify.mjs" }] }] } });
        let lines = trust_lines(&merged(&existing, exe), Path::new(r"C:\Users\x\.codex\hooks.json"));
        assert!(lines.contains(&r"hooks.state.'C:\Users\x\.codex\hooks.json:stop:1:0'.trusted_hash".to_string()));
        assert!(lines.contains(&r"hooks.state.'C:\Users\x\.codex\hooks.json:permission_request:0:0'.trusted_hash".to_string()));
        assert_eq!(lines.len(), CODEX_EVENTS.len());
        assert_eq!(snake("UserPromptSubmit"), "user_prompt_submit");
    }

    /// A hooks/list reply from Codex 0.158 (the probe, 2026-10-30), with two of Island's hooks.
    fn list_reply() -> Value {
        json!({ "data": [{ "cwd": r"C:\Users\x\.codex", "warnings": [], "errors": [], "hooks": [
            { "key": r"C:\Users\x\.codex\hooks.json:stop:1:0", "eventName": "stop", "command": r"& 'C:\Island\bin\island-hook.exe' codex Stop", "currentHash": "sha256:aa", "trustStatus": "untrusted", "source": "user" },
            { "key": r"C:\Users\x\.codex\hooks.json:permission_request:0:0", "eventName": "permissionRequest", "command": r"& 'C:\Island\bin\island-hook.exe' codex PermissionRequest", "currentHash": "sha256:bb", "trustStatus": "trusted", "source": "user" },
            { "key": r"C:\Users\x\.codex\hooks.json:stop:0:0", "eventName": "stop", "command": "node notify.mjs", "currentHash": "sha256:cc", "trustStatus": "untrusted", "source": "user" }
        ]}]})
    }

    #[test]
    fn only_island_s_untrusted_hooks_get_trusted() {
        let edits = trust_edits(&list_reply());
        assert_eq!(edits.len(), 1, "someone else's hook and a trusted one are left alone");
        assert_eq!(edits[0]["keyPath"], r#"hooks.state."C:\\Users\\x\\.codex\\hooks.json:stop:1:0".trusted_hash"#);
        assert_eq!(edits[0]["value"], "sha256:aa");
        assert_eq!(edits[0]["mergeStrategy"], "upsert");
        assert!(!all_trusted(&list_reply()));
        let mut done = list_reply();
        done["data"][0]["hooks"][0]["trustStatus"] = json!("trusted");
        assert!(all_trusted(&done));
        assert!(!all_trusted(&json!({ "data": [{ "hooks": [] }] })), "no Island hooks: not trusted");
    }
}
