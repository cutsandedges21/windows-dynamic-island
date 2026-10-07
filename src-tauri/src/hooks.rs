// Claude Code hook installation, adapted from Coucou (MIT, Louis Raillé).
//
// Read %USERPROFILE%\.claude\settings.json, take a dated backup, merge without
// touching anybody else's hooks, show the diff, and write only after an explicit
// click. Uninstall removes Island's entries and nothing else.
//
// The command is only the quoted exe path in forward slashes plus the event
// name: on Windows Claude Code runs hook commands through Git Bash.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::claude::{config_dir, hook_exe_path};

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
/// Stop may wait for a reply typed in the island (at most 290 s in island-hook).
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 300),
    ("SubagentStop", 10),
];

const MARKER: &str = "island-hook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    /// Installing again would change nothing (false after an update changes a timeout).
    pub up_to_date: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    pub fingerprint: String,
}

pub fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

/// The only error that means "start from nothing" is the file not being there.
fn read_settings() -> Result<Value, String> {
    let path = settings_path();
    match std::fs::read(&path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
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

fn hook_command(event: &str) -> String {
    let exe = hook_exe_path().to_string_lossy().replace('\\', "/");
    format!("\"{exe}\" {event}")
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| hooks.iter().any(|h| h.get("command").and_then(Value::as_str).map(|c| c.contains(MARKER)).unwrap_or(false)))
        .unwrap_or(false)
}

fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, timeout) in HOOK_EVENTS {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(json!({ "hooks": [{ "type": "command", "command": hook_command(event), "timeout": timeout }] }));
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

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

fn backup_path() -> PathBuf {
    settings_path().with_file_name(format!("settings.json.bak-{}", stamp()))
}

/// FNV-1a: "is this still the file I showed the user?"
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_fingerprint() -> String {
    match std::fs::read(settings_path()) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

pub fn status() -> HookStatus {
    let current = read_settings().unwrap_or_else(|_| json!({}));
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| hooks.values().filter_map(Value::as_array).flatten().any(entry_is_ours))
        .unwrap_or(false);
    let hook_path = hook_exe_path();
    HookStatus {
        installed,
        up_to_date: installed && merged(&current) == current,
        settings_path: settings_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    let current = read_settings()?;
    let next = if install { merged(&current) } else { without_ours(&current) };
    Ok(HookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        settings_path: settings_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(),
    })
}

/// Writes after a dated backup, and only if the file is still the one previewed.
pub fn write(install: bool, fp: &str) -> Result<String, String> {
    let path = settings_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let current = read_settings()?;
    if current_fingerprint() != fp {
        return Err(format!("{} changed since the preview. Nothing was written; review the new diff.", path.display()));
    }
    let backup = backup_path();
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }
    let next = if install { merged(&current) } else { without_ours(&current) };
    let mut text = pretty(&next);
    text.push('\n');
    let temp = path.with_extension(format!("json.island-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    crate::log::line(format!("hooks {} (backup {})", if install { "installed" } else { "removed" }, backup.display()));
    Ok(backup.to_string_lossy().to_string())
}

/// Copies island-hook.exe to %LOCALAPPDATA%\Island\bin on launch: from the app
/// resources when installed, from src-tauri/bin in development.
pub fn ensure_hook_exe(app: &AppHandle) {
    let dest = hook_exe_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("island-hook.exe", tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("island-hook.exe"));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("bin").join("island-hook.exe"));
    let Some(src) = candidates.into_iter().find(|p| p.is_file()) else {
        crate::log::line("island-hook.exe not found; Claude Code hooks cannot work");
        return;
    };
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() <= b.modified().ok(),
        _ => false,
    };
    if !same {
        if let Err(err) = std::fs::copy(&src, &dest) {
            if !dest.exists() {
                crate::log::line(format!("could not install island-hook.exe: {err}"));
            }
        }
    }
}

/// settings.json is short, so a plain O(n·m) LCS diff is enough.
fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }
    let changed: Vec<usize> = out.iter().enumerate().filter(|(_, l)| l.starts_with('+') || l.starts_with('-')).map(|(i, _)| i).collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        for k in idx.saturating_sub(3)..(idx + 4).min(out.len()) {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

/// `island.exe --install-hooks` / `--remove-hooks`: the same preview + backup +
/// write as the Activities button, for scripts and first-time setup.
pub fn cli(install: bool) -> i32 {
    let hook = hook_exe_path();
    if install && !hook.is_file() {
        // The app copies the relay on launch; a portable exe keeps one beside it.
        let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("island-hook.exe")));
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin").join("island-hook.exe");
        if let Some(src) = beside.filter(|p| p.is_file()).or_else(|| dev.is_file().then_some(dev)) {
            if let Some(dir) = hook.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::copy(&src, &hook);
        }
    }
    if install && !hook.is_file() {
        println!("island-hook.exe is missing at {}. Start Island once, then try again.", hook.display());
        return 2;
    }
    let plan = match preview(install) {
        Ok(p) => p,
        Err(e) => {
            println!("{e}");
            return 1;
        }
    };
    println!("{}\n{}", plan.settings_path, plan.diff);
    match write(install, &plan.fingerprint) {
        Ok(backup) => {
            println!("{} hooks. Backup: {backup}", if install { "Installed" } else { "Removed" });
            0
        }
        Err(e) => {
            println!("{e}");
            1
        }
    }
}

#[tauri::command]
pub fn hooks_status() -> HookStatus {
    status()
}

#[tauri::command]
pub fn hooks_preview(install: bool) -> Value {
    match preview(install) {
        Ok(p) => serde_json::to_value(p).unwrap_or(Value::Null),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn hooks_write(install: bool, fingerprint: String) -> Value {
    match write(install, &fingerprint) {
        Ok(backup) => json!({ "ok": true, "backup": backup }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bom_is_stripped_and_garbage_refused() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus"}"#);
        assert_eq!(parse_settings(&bytes, "s").unwrap()["model"], "opus");
        for bad in [&b"{ not json"[..], &b"[1,2]"[..], &b"\"s\""[..]] {
            assert!(parse_settings(bad, "s").is_err());
        }
        assert_eq!(parse_settings(b"  \n", "s").unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_everything_else_and_removing_restores_it() {
        let existing = json!({
            "model": "claude-opus-5",
            "hooks": {
                "PreToolUse": [{ "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }],
                "Other": [{ "hooks": [{ "type": "command", "command": "keep-me.exe" }] }]
            }
        });
        let after = merged(&existing);
        assert_eq!(after["model"], "claude-opus-5");
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| e.to_string().contains("someone-elses-tool.exe")));
        assert!(pre.iter().any(entry_is_ours));
        assert!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] == 120);
        assert_eq!(without_ours(&after), existing);
        // Installing twice does not duplicate.
        let twice = merged(&after);
        assert_eq!(twice["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn fingerprints_notice_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
    }

    #[test]
    fn diffs_show_only_changed_regions() {
        let d = unified_diff("a\nb\nc", "a\nb\nc\nd");
        assert!(d.contains("+ d"));
        assert_eq!(unified_diff("x", "x"), "No change.");
    }
}
