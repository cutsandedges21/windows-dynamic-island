// Claude Code access that has to be native: the plan-limits API (the OAuth token
// is read and used here and never enters the webview), resuming a session,
// typing a prompt into a live session's console, and picking a Windows
// Terminal tab by name. Session tracking itself is TypeScript (src/activities/claude).

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWMINNOACTIVE, SW_SHOWNORMAL};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const FALLBACK_VERSION: &str = "2.1.204";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(".claude"),
    }
}

pub fn hook_exe_path() -> PathBuf {
    crate::log::data_dir().join("bin").join("island-hook.exe")
}

fn find_claude_exe() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let local = home().join(".local").join("bin").join("claude.exe");
    local.is_file().then_some(local)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEnv {
    config_dir: String,
    home: String,
    desktop_blob_dirs: Vec<String>,
    usage_clip_cache: String,
    hook_exe: String,
    hook_ready: bool,
    claude_exe: Option<String>,
}

#[tauri::command]
pub fn claude_env() -> ClaudeEnv {
    let mut blobs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        blobs.push(PathBuf::from(&appdata).join("Claude").join("IndexedDB").join("https_claude.ai_0.indexeddb.blob"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        // Store (MSIX) builds may virtualize %APPDATA% into the package folder.
        blobs.push(
            PathBuf::from(local)
                .join("Packages")
                .join("Claude_pzs8sxrjxfjjc")
                .join("LocalCache")
                .join("Roaming")
                .join("Claude")
                .join("IndexedDB")
                .join("https_claude.ai_0.indexeddb.blob"),
        );
    }
    let usage_clip = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("Usage Clip").join("usage-cache.json");
    let hook = hook_exe_path();
    ClaudeEnv {
        config_dir: config_dir().to_string_lossy().to_string(),
        home: home().to_string_lossy().to_string(),
        desktop_blob_dirs: blobs.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        usage_clip_cache: usage_clip.to_string_lossy().to_string(),
        hook_ready: hook.is_file(),
        hook_exe: hook.to_string_lossy().to_string(),
        claude_exe: find_claude_exe().map(|p| p.to_string_lossy().to_string()),
    }
}

// ------------------------------------------------------------------ limits API

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFetch {
    status: u16,
    retry_after: Option<f64>,
    body: Option<Value>,
    no_token: bool,
}

/// Claude Code's own OAuth token, re-read on every poll; this app never refreshes it.
fn read_token() -> Option<String> {
    let bytes = std::fs::read(config_dir().join(".credentials.json")).ok()?;
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let v: Value = serde_json::from_slice(text).ok()?;
    v.get("claudeAiOauth")?.get("accessToken")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

#[tauri::command]
pub async fn claude_usage_fetch(version: Option<String>) -> UsageFetch {
    let Some(token) = read_token() else {
        return UsageFetch { status: 0, retry_after: None, body: None, no_token: true };
    };
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(_) => return UsageFetch { status: 0, retry_after: None, body: None, no_token: false },
    };
    let ua = format!("claude-code/{}", version.filter(|v| !v.is_empty()).unwrap_or_else(|| FALLBACK_VERSION.into()));
    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .header("User-Agent", ua)
        .send()
        .await;
    match resp {
        Err(_) => UsageFetch { status: 0, retry_after: None, body: None, no_token: false },
        Ok(r) => {
            let status = r.status().as_u16();
            let retry_after = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<f64>().ok());
            let body = r.json::<Value>().await.ok();
            UsageFetch { status, retry_after, body, no_token: false }
        }
    }
}

// ------------------------------------------------------------------ resume / continue

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn cwd_ok(cwd: &str) -> bool {
    !cwd.is_empty() && !cwd.contains(['"', ';', '\r', '\n', '\0']) && Path::new(cwd).is_dir()
}

/// One argument, quoted for the MSVC / Bun command-line parser.
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"', '\n']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Starts `exe args…` in its own console, optionally minimized without focus.
fn spawn_console(exe: &Path, args: &[&str], cwd: &str, minimized: bool) -> bool {
    let exe_s = exe.to_string_lossy().to_string();
    let mut line = quote_arg(&exe_s);
    for a in args {
        line.push(' ');
        line.push_str(&quote_arg(a));
    }
    let app_w = wide(&exe_s);
    let mut line_w = wide(&line);
    let cwd_w = wide(cwd);
    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: if minimized { SW_SHOWMINNOACTIVE.0 as u16 } else { SW_SHOWNORMAL.0 as u16 },
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();
    let ok = unsafe {
        CreateProcessW(
            PCWSTR(app_w.as_ptr()),
            Some(PWSTR(line_w.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            None,
            PCWSTR(cwd_w.as_ptr()),
            &si,
            &mut pi,
        )
        .is_ok()
    };
    if ok {
        unsafe {
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
        }
    }
    ok
}

fn clean_prompt(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\n', '\r', '\t'], " ").chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

/// Reopens a closed session. With a prompt (Continue Session) or `minimized`,
/// claude runs in its own minimized console, so the user stays where they are
/// and the session shows up live in the island again. Without, it opens in
/// Windows Terminal like Usage Clip does.
#[tauri::command]
pub fn claude_resume(session_id: String, cwd: String, prompt: Option<String>, minimized: bool) -> bool {
    if !is_uuid(&session_id) || !cwd_ok(&cwd) {
        crate::log::line(format!("resume refused id_ok={} cwd_ok={}", is_uuid(&session_id), cwd_ok(&cwd)));
        return false;
    }
    let prompt = prompt.map(|p| clean_prompt(&p)).filter(|p| !p.is_empty());
    if prompt.is_some() || minimized {
        let Some(exe) = find_claude_exe() else {
            crate::log::line("resume: claude.exe not found on PATH");
            return false;
        };
        let mut args = vec!["--resume", session_id.as_str()];
        if let Some(p) = prompt.as_deref() {
            args.push(p);
        }
        let ok = spawn_console(&exe, &args, &cwd, minimized);
        crate::log::line(format!("resume {session_id} prompt={} minimized={minimized} ok={ok}", prompt.is_some()));
        return ok;
    }
    let wt = Command::new("wt.exe").args(["-d", &cwd, "claude", "--resume", &session_id]).creation_flags(DETACHED_PROCESS).spawn();
    if wt.is_ok() {
        crate::log::line(format!("resume {session_id} in Windows Terminal"));
        return true;
    }
    let fallback = Command::new("cmd.exe")
        .raw_arg(format!("/d /c start \"\" /D \"{cwd}\" cmd /k claude --resume {session_id}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok();
    crate::log::line(format!("resume {session_id} via cmd ok={fallback}"));
    fallback
}

#[derive(Serialize)]
pub struct InjectResult {
    ok: bool,
    error: Option<String>,
}

fn hook_exe() -> Option<PathBuf> {
    let installed = hook_exe_path();
    if installed.is_file() {
        return Some(installed);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin").join("island-hook.exe");
    dev.is_file().then_some(dev)
}

/// Types `text` + Enter into the console of a live CLI session (island-hook inject).
#[tauri::command]
pub async fn claude_inject(pid: u32, text: String) -> InjectResult {
    let text = clean_prompt(&text);
    if pid == 0 || text.is_empty() {
        return InjectResult { ok: false, error: Some("nothing to send".into()) };
    }
    let Some(exe) = hook_exe() else {
        return InjectResult { ok: false, error: Some("island-hook.exe is missing".into()) };
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = Command::new(exe)
            .args(["inject", &pid.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(out)) if out.status.success() => Ok(()),
            Ok(Ok(out)) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("timed out".into()),
        }
    })
    .await;
    let r = result.unwrap_or_else(|e| Err(e.to_string()));
    crate::log::line(format!("inject pid={pid} ok={} {}", r.is_ok(), r.as_ref().err().cloned().unwrap_or_default()));
    match r {
        Ok(()) => InjectResult { ok: true, error: None },
        Err(e) => InjectResult { ok: false, error: Some(e) },
    }
}

// Select a Windows Terminal tab by name through UI Automation (ported from Usage
// Clip). The title travels in an environment variable, never spliced into the
// script. Prints the hosting window handle on success.
const WT_TAB_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$needle = $env:ISLAND_TITLE
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$tabCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {
  foreach ($tab in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
    if ($tab.Current.Name.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      [Console]::Out.Write($w.Current.NativeWindowHandle)
      exit 0
    }
  }
}
exit 1
"#;

#[tauri::command]
pub async fn claude_select_wt_tab(title: String) -> Option<isize> {
    let needle = title.trim().to_string();
    if needle.chars().count() < 3 {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WT_TAB_SCRIPT])
            .env("ISLAND_TITLE", &needle)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok()?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        let out = rx.recv_timeout(Duration::from_secs(5)).ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse::<isize>().ok().filter(|h| *h > 0)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_checked_strictly() {
        assert!(is_uuid("9ef06229-3953-4aea-95ce-2d36bbbaf580"));
        assert!(!is_uuid("9ef06229-3953-4aea-95ce-2d36bbbaf58"));
        assert!(!is_uuid("9ef06229x3953-4aea-95ce-2d36bbbaf580"));
        assert!(!is_uuid("../../etc/passwd-0000-0000-000000000000"));
    }

    #[test]
    fn arguments_survive_the_command_line() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg("two words"), "\"two words\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn prompts_are_one_line() {
        assert_eq!(clean_prompt("a\r\nb\nc\t"), "a b c");
    }
}
