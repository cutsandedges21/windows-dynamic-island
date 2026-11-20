// Cursor access that has to be native: where Cursor keeps its files, finding Cursor.exe,
// bringing a folder's Cursor window up, and Island's hooks in ~/.cursor/hooks.json. Session
// tracking itself is TypeScript (src/activities/cursor).
//
// Cursor (3.27) runs a hook command through PowerShell, like Codex, so the command uses the
// call operator: `& 'C:\…\island-hook.exe' cursor stop`. Its hook entries are flat
// (`{"command", "timeout"}` under the event, no inner "hooks" list) and the file carries
// `"version": 1`. User hooks need no trust. A hook can deny a command or make Cursor ask,
// but not approve one: Island's Allow only lets it through to Cursor's own rules, so the
// two command hooks go in only when the user asks for them (`gate`).
// Design: docs/superpowers/specs/2026-10-30-cursor-in-island-design.md.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::claude::{home, hook_exe_path};
use crate::hooks::{fingerprint, pretty, stamp, unified_diff, write_embedded_hook};

/// Every event the island reacts to, with the timeout written to hooks.json (seconds). stop may
/// wait for a reply typed in the island (island-hook gives up at 290 s).
pub const CURSOR_EVENTS: &[(&str, u64)] = &[("sessionStart", 10), ("sessionEnd", 5), ("beforeSubmitPrompt", 10), ("afterAgentResponse", 10), ("stop", 300)];
/// The command hooks, only with "Ask me here before Cursor runs a command": each waits for
/// Allow or Deny in the island (island-hook gives up at 110 s).
pub const GATE_EVENTS: &[(&str, u64)] = &[("beforeShellExecution", 120), ("beforeMCPExecution", 120)];

const MARKER: &str = "island-hook";

pub fn cursor_home() -> PathBuf {
    home().join(".cursor")
}

pub fn hooks_path() -> PathBuf {
    cursor_home().join("hooks.json")
}

/// A Mac: the Cursor app bundle.
#[cfg(target_os = "macos")]
pub fn find_cursor_exe() -> Option<PathBuf> {
    crate::mac::ai::app_bundle("Cursor")
}

/// Cursor.exe: the per-user install, else a machine-wide one, else the one whose `cursor` command is on PATH.
#[cfg(not(target_os = "macos"))]
pub fn find_cursor_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs").join("cursor").join("Cursor.exe"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("cursor").join("Cursor.exe"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            // …\cursor\resources\app\bin\cursor.cmd → …\cursor\Cursor.exe
            if dir.join("cursor.cmd").is_file() {
                if let Some(root) = dir.parent().and_then(Path::parent).and_then(Path::parent) {
                    candidates.push(root.join("Cursor.exe"));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEnv {
    home: String,
    projects_dir: String,
    cursor_exe: Option<String>,
    hook_exe: String,
    hook_ready: bool,
}

/// None when Cursor isn't on this PC (no Cursor.exe and no ~/.cursor).
#[tauri::command]
pub fn cursor_env() -> Option<CursorEnv> {
    let root = cursor_home();
    let exe = find_cursor_exe();
    if !root.is_dir() && exe.is_none() {
        return None;
    }
    let hook = hook_exe_path();
    Some(CursorEnv {
        home: root.to_string_lossy().to_string(),
        projects_dir: root.join("projects").to_string_lossy().to_string(),
        cursor_exe: exe.map(|p| p.to_string_lossy().to_string()),
        hook_ready: hook.is_file(),
        hook_exe: hook.to_string_lossy().to_string(),
    })
}

/// Brings up Cursor's window for a folder, opening the folder if no window has it.
#[tauri::command]
pub fn cursor_open(folder: String) -> bool {
    if !crate::claude::cwd_ok(&folder) {
        crate::log::line("cursor open refused: not a folder");
        return false;
    }
    let Some(exe) = find_cursor_exe() else {
        crate::log::line("cursor open: Cursor.exe not found");
        return false;
    };
    // Cursor.exe hands the folder to the Cursor that runs, which brings that window up (a Mac: the
    // app is opened with the folder, the same way).
    #[cfg(target_os = "macos")]
    let ok = crate::mac::ai::open_app(&exe, &[&folder]);
    #[cfg(not(target_os = "macos"))]
    let ok = Command::new(&exe).arg(&folder).env_remove("ELECTRON_RUN_AS_NODE").spawn().is_ok();
    crate::log::line(format!("cursor open ok={ok}"));
    ok
}

// ------------------------------------------------------------------ transcripts

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTranscript {
    path: String,
    id: String,
    size: u64,
    mtime_ms: f64,
    /// The folder the chat ran in, worked out from Cursor's name for it; None when that fails.
    folder: Option<String>,
}

/// Agent transcripts written in the last `max_age_ms`: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl.
/// Only those folders are read (the project folders also hold whole node_modules trees).
#[tauri::command]
pub fn cursor_transcripts(max_age_ms: f64) -> Vec<CursorTranscript> {
    let now = std::time::SystemTime::now();
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(cursor_home().join("projects")) else { return out };
    for project in projects.flatten() {
        let dir = project.path().join("agent-transcripts");
        let Ok(chats) = std::fs::read_dir(&dir) else { continue };
        let mut folder: Option<Option<String>> = None;
        for chat in chats.flatten() {
            let id = chat.file_name().to_string_lossy().to_string();
            let file = chat.path().join(format!("{id}.jsonl"));
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let age = now.duration_since(modified).map(|d| d.as_millis() as f64).unwrap_or(0.0);
            if age > max_age_ms {
                continue;
            }
            let folder = folder.get_or_insert_with(|| slug_folder(&project.file_name().to_string_lossy())).clone();
            let mtime_ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
            out.push(CursorTranscript { path: file.to_string_lossy().to_string(), id, size: meta.len(), mtime_ms, folder });
        }
    }
    out
}

/// Cursor names a project's folder after its path with every separator a dash
/// ("c-Users-me-my-app"), so a dash may also be part of a name: the folder is found by
/// walking down from the drive, taking the longest run of parts that exists at each step.
#[cfg(not(target_os = "macos"))]
fn slug_folder(slug: &str) -> Option<String> {
    let (drive, rest) = slug.split_once('-')?;
    if drive.len() != 1 || !drive.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let parts: Vec<&str> = rest.split('-').collect();
    let mut at = PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()));
    let mut i = 0;
    while i < parts.len() {
        let next = (i + 1..=parts.len()).rev().find_map(|j| {
            ["-", " ", "."].iter().map(|sep| at.join(parts[i..j].join(sep))).find(|p| p.is_dir()).map(|p| (j, p))
        })?;
        i = next.0;
        at = next.1;
    }
    Some(at.to_string_lossy().to_string())
}

/// The same on a Mac, where a path starts at / and the slug leaves it out ("Users-me-my-app").
#[cfg(target_os = "macos")]
fn slug_folder(slug: &str) -> Option<String> {
    let parts: Vec<&str> = slug.split('-').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut at = PathBuf::from("/");
    let mut i = 0;
    while i < parts.len() {
        let next = (i + 1..=parts.len()).rev().find_map(|j| {
            ["-", " ", "."].iter().map(|sep| at.join(parts[i..j].join(sep))).find(|p| p.is_dir()).map(|p| (j, p))
        })?;
        i = next.0;
        at = next.1;
    }
    Some(at.to_string_lossy().to_string())
}

// ------------------------------------------------------------------ hooks.json

/// The command Cursor runs for one event: through PowerShell on Windows, where a quoted
/// path is a string, not a command, so the call operator runs it.
pub fn hook_command(exe: &Path, event: &str) -> String {
    let path = exe.to_string_lossy();
    if cfg!(windows) {
        format!("& '{}' cursor {event}", path.replace('\'', "''"))
    } else {
        format!("'{}' cursor {event}", path.replace('\'', "'\\''"))
    }
}

fn entry(exe: &Path, event: &str, timeout: u64) -> Value {
    let mut e = json!({ "command": hook_command(exe, event), "timeout": timeout });
    // Each reply typed in the island is one follow-up; Cursor stops at 5 unless told otherwise.
    if event == "stop" {
        e["loop_limit"] = Value::Null;
    }
    e
}

fn entry_is_ours(entry: &Value) -> bool {
    entry.get("command").and_then(Value::as_str).map(|c| c.contains(MARKER)).unwrap_or(false)
}

fn is_gate(event: &str) -> bool {
    GATE_EVENTS.iter().any(|(g, _)| *g == event)
}

/// Island's hooks in `existing`, everything else kept; the command hooks only with `gate`.
fn merged(existing: &Value, exe: &Path, gate: bool) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    if !root.contains_key("version") {
        root.insert("version".into(), json!(1));
    }
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, timeout) in CURSOR_EVENTS.iter().chain(GATE_EVENTS) {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        list.retain(|e| !entry_is_ours(e));
        if gate || !is_gate(event) {
            list.push(entry(exe, event, *timeout));
        }
        if list.is_empty() {
            hooks.remove(*event);
        } else {
            hooks.insert((*event).to_string(), Value::Array(list));
        }
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
    root.insert("hooks".into(), Value::Object(out));
    Value::Object(root)
}

/// Are Island's command hooks in there?
fn has_gate(doc: &Value) -> bool {
    GATE_EVENTS.iter().any(|(event, _)| doc.get("hooks").and_then(|h| h.get(*event)).and_then(Value::as_array).is_some_and(|l| l.iter().any(entry_is_ours)))
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorHookStatus {
    installed: bool,
    up_to_date: bool,
    /// Island's command hooks are in (Ask me here before Cursor runs a command).
    gate: bool,
    cursor_found: bool,
    hooks_path: String,
    hook_path: String,
    hook_ready: bool,
    error: Option<String>,
}

pub fn status() -> CursorHookStatus {
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
    let gate = has_gate(&current);
    CursorHookStatus {
        installed,
        up_to_date: installed && merged(&current, &hook, gate) == current,
        gate,
        cursor_found: find_cursor_exe().is_some(),
        hooks_path: hooks_path().to_string_lossy().to_string(),
        hook_ready: hook.is_file(),
        hook_path: hook.to_string_lossy().to_string(),
        error,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorHookPreview {
    diff: String,
    backup: String,
    hooks_path: String,
    fingerprint: String,
}

pub fn preview(install: bool, gate: bool) -> Result<CursorHookPreview, String> {
    let current = read_hooks()?;
    let next = if install { merged(&current, &hook_exe_path(), gate) } else { without_ours(&current) };
    Ok(CursorHookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        hooks_path: hooks_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(),
    })
}

/// Writes hooks.json after a dated backup, and only if the file is still the one previewed.
/// Returns the backup's path (empty when there was no file to back up).
pub fn write(install: bool, gate: bool, fp: &str) -> Result<String, String> {
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
    let next = if install { merged(&current, &hook_exe_path(), gate) } else { without_ours(&current) };
    let mut text = pretty(&next);
    text.push('\n');
    let temp = path.with_extension(format!("json.island-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    crate::log::line(format!("cursor hooks {} gate={gate} (backup {})", if install { "installed" } else { "removed" }, if backup.is_empty() { "none" } else { &backup }));
    Ok(backup)
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn cursor_hooks_status() -> CursorHookStatus {
    status()
}

#[tauri::command]
pub fn cursor_hooks_preview(install: bool, gate: bool) -> Value {
    match preview(install, gate) {
        Ok(p) => serde_json::to_value(p).unwrap_or(Value::Null),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn cursor_hooks_write(install: bool, gate: bool, fingerprint: String) -> Value {
    match write(install, gate, &fingerprint) {
        Ok(backup) => json!({ "ok": true, "backup": backup }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// `island.exe --install-cursor-hooks [--cursor-gate]` / `--remove-cursor-hooks`.
pub fn cli(install: bool, gate: bool) -> i32 {
    let hook = hook_exe_path();
    if install {
        write_embedded_hook(&hook);
        if !hook.is_file() {
            println!("island-hook.exe is missing at {}. Start Island once, then try again.", hook.display());
            return 2;
        }
    }
    let plan = match preview(install, gate) {
        Ok(p) => p,
        Err(e) => {
            println!("{e}");
            return 1;
        }
    };
    println!("{}\n{}", plan.hooks_path, plan.diff);
    match write(install, gate, &plan.fingerprint) {
        Ok(backup) => {
            println!("{} Cursor hooks.{}", if install { "Installed" } else { "Removed" }, if backup.is_empty() { String::new() } else { format!(" Backup: {backup}") });
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
            assert_eq!(hook_command(exe, "stop"), r"& 'C:\Users\O''Neil\AppData\Local\Island\bin\island-hook.exe' cursor stop");
        } else {
            assert!(hook_command(exe, "stop").ends_with("' cursor stop"));
        }
    }

    #[test]
    fn merging_keeps_everything_else_and_removing_restores_it() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let existing = json!({
            "version": 1,
            "hooks": {
                "stop": [{ "command": "node notify.mjs", "timeout": 5 }],
                "afterFileEdit": [{ "command": "./format.sh" }]
            }
        });
        let after = merged(&existing, exe, false);
        let stop = after["hooks"]["stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["command"], "node notify.mjs");
        assert_eq!(stop[1]["timeout"], 300);
        assert!(stop[1]["loop_limit"].is_null() && stop[1].get("loop_limit").is_some(), "replies aren't capped at 5");
        assert_eq!(after["hooks"]["afterFileEdit"], existing["hooks"]["afterFileEdit"]);
        assert_eq!(after["hooks"]["sessionEnd"][0]["timeout"], 5);
        assert!(after["hooks"].get("beforeShellExecution").is_none(), "no command hooks unless asked for");
        assert_eq!(merged(&after, exe, false), after, "installing twice changes nothing");
        assert_eq!(without_ours(&after), existing);
    }

    #[test]
    fn a_new_file_gets_cursor_s_version() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let after = merged(&json!({}), exe, false);
        assert_eq!(after["version"], 1);
        assert_eq!(after["hooks"].as_object().unwrap().len(), CURSOR_EVENTS.len());
        assert!(after["hooks"]["stop"][0]["command"].as_str().unwrap().contains("island-hook.exe' cursor stop") || !cfg!(windows));
    }

    #[test]
    fn a_project_slug_finds_its_folder_even_with_dashes_in_names() {
        let root = std::env::temp_dir().join(format!("island-slug-{}", std::process::id()));
        let deep = root.join("my-app").join("web site");
        std::fs::create_dir_all(&deep).unwrap();
        let s = if cfg!(target_os = "macos") {
            // /var/folders/… is var-folders-…; the temp folder is a link there (/var → /private/var).
            root.canonicalize().unwrap().to_string_lossy().trim_start_matches('/').replace(['/', ' '], "-")
        } else {
            root.to_string_lossy().replace(":\\", "-").replace(['\\', ' '], "-")
        };
        let deep = if cfg!(target_os = "macos") { deep.canonicalize().unwrap() } else { deep };
        let slug = format!("{s}-my-app-web-site");
        assert_eq!(slug_folder(&slug).map(|p| p.to_lowercase()), Some(deep.to_string_lossy().to_lowercase()));
        assert_eq!(slug_folder("empty-window"), None);
        assert_eq!(slug_folder(&format!("{s}-no-such-thing")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_command_hooks_come_and_go_with_the_switch() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let mine = json!({ "version": 1, "hooks": { "beforeShellExecution": [{ "command": "audit.exe", "timeout": 3 }] } });
        let on = merged(&mine, exe, true);
        assert!(has_gate(&on));
        let shell = on["hooks"]["beforeShellExecution"].as_array().unwrap();
        assert_eq!(shell.len(), 2);
        assert_eq!(shell[1]["timeout"], 120);
        assert_eq!(on["hooks"]["beforeMCPExecution"][0]["timeout"], 120);
        let off = merged(&on, exe, false);
        assert!(!has_gate(&off));
        assert_eq!(off["hooks"]["beforeShellExecution"], mine["hooks"]["beforeShellExecution"], "the user's own command hook stays");
        assert!(off["hooks"].get("beforeMCPExecution").is_none());
        assert_eq!(merged(&off, exe, true), on);
    }
}
