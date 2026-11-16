// Antigravity access that has to be native: where Antigravity keeps its files (one agent behind its
// app, its IDE and its CLI), finding them, bringing one up, and Island's hooks in
// ~/.gemini/config/hooks.json, which all three read. Conversation tracking itself is TypeScript
// (src/activities/antigravity).
//
// Antigravity runs a hook command through `cmd /c` on Windows (its own docs, built into its agent),
// from ~/.gemini/config. A path without spaces runs the same whether that command line reaches cmd
// raw or escaped, so the command uses the relay's 8.3 short path when the real one has a space.
// Its hooks.json holds named hooks: Island's is "island" (`{"enabled": true, "<Event>": [...]}`);
// tool events wrap their handlers in `{matcher, hooks}`. Timeouts are in seconds.
// Design: docs/superpowers/specs/2026-10-30-antigravity-in-island-design.md.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::claude::{home, hook_exe_path};
use crate::hooks::{fingerprint, pretty, stamp, unified_diff, write_embedded_hook};

/// Island's events, with their timeouts (seconds). Stop may wait for a reply typed in the island
/// (island-hook gives up at 290 s).
pub const AG_EVENTS: &[(&str, u64)] = &[("SessionStart", 10), ("PreInvocation", 10), ("Stop", 300)];
/// With "Ask me here before Antigravity runs a command": its shell commands wait for Allow or Deny.
const GATE_TIMEOUT: u64 = 120;
const GATE_MATCHER: &str = "run_command";
/// Island's entry in hooks.json.
const NAME: &str = "island";
const MARKER: &str = "island-hook";
/// Where each Antigravity keeps its conversations, under ~/.gemini.
const DATA_DIRS: &[&str] = &["antigravity", "antigravity-cli", "antigravity-ide"];

pub fn gemini_home() -> PathBuf {
    home().join(".gemini")
}

pub fn hooks_path() -> PathBuf {
    gemini_home().join("config").join("hooks.json")
}

fn local_programs(rel: &[&str]) -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Programs");
    for part in rel {
        p.push(part);
    }
    p.is_file().then_some(p)
}

pub fn app_exe() -> Option<PathBuf> {
    local_programs(&["Antigravity", "Antigravity.exe"])
}

pub fn ide_exe() -> Option<PathBuf> {
    local_programs(&["Antigravity IDE", "Antigravity IDE.exe"])
}

/// agy.exe: where its installer puts it, else on PATH.
pub fn cli_exe() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("agy.exe")).find(|p| p.is_file())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityEnv {
    home: String,
    app_exe: Option<String>,
    ide_exe: Option<String>,
    cli_exe: Option<String>,
    hook_exe: String,
    hook_ready: bool,
}

/// None when no Antigravity is on this PC (no app, IDE or CLI, and none of their folders).
#[tauri::command]
pub fn antigravity_env() -> Option<AntigravityEnv> {
    let root = gemini_home();
    let (app, ide, cli) = (app_exe(), ide_exe(), cli_exe());
    let has_data = DATA_DIRS.iter().any(|d| root.join(d).is_dir());
    if app.is_none() && ide.is_none() && cli.is_none() && !has_data {
        return None;
    }
    let hook = hook_exe_path();
    let s = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().to_string());
    Some(AntigravityEnv { home: root.to_string_lossy().to_string(), app_exe: s(app), ide_exe: s(ide), cli_exe: s(cli), hook_ready: hook.is_file(), hook_exe: hook.to_string_lossy().to_string() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgTranscript {
    path: String,
    id: String,
    size: u64,
    mtime_ms: f64,
}

/// Transcripts written in the last `max_age_ms`: ~/.gemini/<data dir>/brain/<id>/.system_generated/logs/transcript.jsonl.
#[tauri::command]
pub fn antigravity_transcripts(max_age_ms: f64) -> Vec<AgTranscript> {
    let now = std::time::SystemTime::now();
    let mut out = Vec::new();
    for dir in DATA_DIRS {
        let Ok(chats) = std::fs::read_dir(gemini_home().join(dir).join("brain")) else { continue };
        for chat in chats.flatten() {
            let file = chat.path().join(".system_generated").join("logs").join("transcript.jsonl");
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let Ok(modified) = meta.modified() else { continue };
            if now.duration_since(modified).map(|d| d.as_millis() as f64).unwrap_or(0.0) > max_age_ms {
                continue;
            }
            let mtime_ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
            out.push(AgTranscript { path: file.to_string_lossy().to_string(), id: chat.file_name().to_string_lossy().to_string(), size: meta.len(), mtime_ms });
        }
    }
    out
}

/// Starts (or brings up) the Antigravity app, or the IDE on a folder.
#[tauri::command]
pub fn antigravity_open(product: String, folder: String) -> bool {
    let exe = match product.as_str() {
        "ide" => ide_exe(),
        _ => app_exe(),
    };
    let Some(exe) = exe else { return false };
    let mut cmd = Command::new(&exe);
    if product == "ide" && crate::claude::cwd_ok(&folder) {
        cmd.arg(&folder);
    }
    let ok = cmd.env_remove("ELECTRON_RUN_AS_NODE").spawn().is_ok();
    crate::log::line(format!("antigravity open {product} ok={ok}"));
    ok
}

// ------------------------------------------------------------------ hooks.json

/// A path cmd.exe reads the same raw or escaped: the real one if it has no space, else its 8.3 name.
fn plain_path(exe: &Path) -> String {
    let path = exe.to_string_lossy().to_string();
    if !path.contains(' ') {
        return path;
    }
    #[cfg(windows)]
    if let Some(short) = short_path(exe) {
        if !short.contains(' ') {
            return short;
        }
    }
    format!("\"{path}\"")
}

#[cfg(windows)]
fn short_path(p: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    let n = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buf)) } as usize;
    (n > 0 && n < buf.len()).then(|| String::from_utf16_lossy(&buf[..n]))
}

/// `& exit 0` at the end: a cmd AutoRun that fails (some PCs set one in the registry) leaves
/// `cmd /c` exiting 1 after a hook that worked, and Antigravity takes that for a failed hook.
pub fn hook_command(exe: &Path, event: &str) -> String {
    if cfg!(windows) {
        format!("{} antigravity {event} & exit 0", plain_path(exe))
    } else {
        format!("'{}' antigravity {event}", exe.to_string_lossy().replace('\'', "'\\''"))
    }
}

fn handler(exe: &Path, event: &str, timeout: u64) -> Value {
    json!({ "type": "command", "command": hook_command(exe, event), "timeout": timeout })
}

fn island_entry(exe: &Path, gate: bool) -> Value {
    let mut e = Map::new();
    e.insert("enabled".into(), json!(true));
    for (event, timeout) in AG_EVENTS {
        e.insert((*event).to_string(), json!([handler(exe, event, *timeout)]));
    }
    if gate {
        e.insert("PreToolUse".into(), json!([{ "matcher": GATE_MATCHER, "hooks": [handler(exe, "PreToolUse", GATE_TIMEOUT)] }]));
    }
    Value::Object(e)
}

/// Is this hooks.json entry Island's (any of its commands runs island-hook)?
fn is_ours(entry: &Value) -> bool {
    entry.to_string().contains(MARKER)
}

fn merged(existing: &Value, exe: &Path, gate: bool) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    root.retain(|_, v| !is_ours(v));
    root.insert(NAME.into(), island_entry(exe, gate));
    Value::Object(root)
}

fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    root.retain(|_, v| !is_ours(v));
    Value::Object(root)
}

fn has_gate(doc: &Value) -> bool {
    doc.as_object().is_some_and(|o| o.values().any(|v| is_ours(v) && v.get("PreToolUse").is_some()))
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
pub struct AgHookStatus {
    installed: bool,
    up_to_date: bool,
    gate: bool,
    hooks_path: String,
    hook_path: String,
    hook_ready: bool,
    error: Option<String>,
}

pub fn status() -> AgHookStatus {
    let hook = hook_exe_path();
    let (current, error) = match read_hooks() {
        Ok(v) => (v, None),
        Err(e) => (json!({}), Some(e)),
    };
    let installed = current.as_object().is_some_and(|o| o.values().any(is_ours));
    let gate = has_gate(&current);
    AgHookStatus {
        installed,
        up_to_date: installed && merged(&current, &hook, gate) == current,
        gate,
        hooks_path: hooks_path().to_string_lossy().to_string(),
        hook_ready: hook.is_file(),
        hook_path: hook.to_string_lossy().to_string(),
        error,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgHookPreview {
    diff: String,
    backup: String,
    hooks_path: String,
    fingerprint: String,
}

pub fn preview(install: bool, gate: bool) -> Result<AgHookPreview, String> {
    let current = read_hooks()?;
    let next = if install { merged(&current, &hook_exe_path(), gate) } else { without_ours(&current) };
    Ok(AgHookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        hooks_path: hooks_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(),
    })
}

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
    crate::log::line(format!("antigravity hooks {} gate={gate} (backup {})", if install { "installed" } else { "removed" }, if backup.is_empty() { "none" } else { &backup }));
    Ok(backup)
}

#[tauri::command]
pub fn antigravity_hooks_status() -> AgHookStatus {
    status()
}

#[tauri::command]
pub fn antigravity_hooks_preview(install: bool, gate: bool) -> Value {
    match preview(install, gate) {
        Ok(p) => serde_json::to_value(p).unwrap_or(Value::Null),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn antigravity_hooks_write(install: bool, gate: bool, fingerprint: String) -> Value {
    match write(install, gate, &fingerprint) {
        Ok(backup) => json!({ "ok": true, "backup": backup }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// `island.exe --install-antigravity-hooks [--antigravity-gate]` / `--remove-antigravity-hooks`.
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
            println!("{} Antigravity hooks.{}", if install { "Installed" } else { "Removed" }, if backup.is_empty() { String::new() } else { format!(" Backup: {backup}") });
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
    fn the_command_has_no_space_cmd_could_split_on() {
        if !cfg!(windows) {
            return;
        }
        assert_eq!(hook_command(Path::new(r"C:\Users\me\AppData\Local\Island\bin\island-hook.exe"), "Stop"), r"C:\Users\me\AppData\Local\Island\bin\island-hook.exe antigravity Stop & exit 0");
        let spaced = hook_command(Path::new(r"C:\No Such Folder\island-hook.exe"), "Stop");
        // A path that doesn't exist has no short name: it is quoted.
        assert_eq!(spaced, r#""C:\No Such Folder\island-hook.exe" antigravity Stop & exit 0"#);
    }

    #[test]
    fn island_s_entry_comes_and_goes_and_everything_else_stays() {
        let exe = Path::new(r"C:\Island\bin\island-hook.exe");
        let existing = json!({ "my-linter": { "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "type": "command", "command": "lint.cmd" }] }] } });
        let after = merged(&existing, exe, false);
        assert_eq!(after["my-linter"], existing["my-linter"]);
        assert_eq!(after["island"]["enabled"], true);
        assert_eq!(after["island"]["Stop"][0]["timeout"], 300);
        assert!(after["island"]["Stop"][0]["command"].as_str().unwrap().starts_with(r"C:\Island\bin\island-hook.exe antigravity Stop"));
        assert!(after["island"].get("PreToolUse").is_none(), "no command hook unless asked for");
        assert_eq!(merged(&after, exe, false), after, "installing twice changes nothing");
        assert_eq!(without_ours(&after), existing);
        let gated = merged(&after, exe, true);
        assert!(has_gate(&gated));
        assert_eq!(gated["island"]["PreToolUse"][0]["matcher"], "run_command");
        assert_eq!(gated["island"]["PreToolUse"][0]["hooks"][0]["timeout"], 120);
        assert!(!has_gate(&merged(&gated, exe, false)));
    }
}
