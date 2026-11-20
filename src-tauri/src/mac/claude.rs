// Claude Code on a Mac, for claude.rs: where its sign-in lives (the Keychain), reaching the limits
// API through the system's curl, reopening a chat in Terminal, typing a reply into the Terminal or
// iTerm tab a chat runs in, and picking a chat's tab by its title.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;

use super::osa;

/// Claude Code's sign-in, which it keeps in the login Keychain on a Mac ("Claude Code-credentials").
/// Read with Apple's own `security` tool, which is the one Claude Code writes it with, so macOS
/// doesn't ask. Re-read on every poll: Island never refreshes the token itself.
pub fn keychain_token() -> Option<String> {
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    token_from(&String::from_utf8_lossy(&out.stdout))
}

/// The access token in Claude Code's credentials JSON.
pub fn token_from(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    v.get("claudeAiOauth")?.get("accessToken")?.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// The limits API through /usr/bin/curl, which uses the Mac's own certificates and proxy settings.
/// The token goes over stdin, never onto a command line. (status, body)
pub fn curl_get(url: &str, token: &str, ua: &str) -> Option<(u16, Option<Value>)> {
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "-m", "15", "-K", "-", "-w", "\n%{http_code}"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let config = format!(
        "url = \"{url}\"\nheader = \"Authorization: Bearer {token}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\nheader = \"Content-Type: application/json\"\nheader = \"User-Agent: {ua}\"\n"
    );
    child.stdin.take()?.write_all(config.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, status) = text.rsplit_once('\n')?;
    let status = status.trim().parse::<u16>().ok().filter(|s| *s != 0)?;
    Some((status, serde_json::from_str(body).ok()))
}

/// Where a program a Terminal would find lives, for an app started from the Dock (whose PATH is
/// only the system's folders).
pub fn find_program(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"] {
        dirs.push(home.join(d));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

const TERMINAL_RUN: &str = r#"on run argv
set cmd to item 1 of argv
set mini to (item 2 of argv) is "1"
tell application "Terminal"
  set t to do script cmd
  delay 0.3
  if mini then
    try
      set miniaturized of (front window) to true
    end try
  else
    activate
  end if
end tell
return "ok"
end run"#;

/// Runs a command line in a new Terminal window, in `cwd`; minimized (the user stays where they
/// are) or in front.
pub fn run_in_terminal(cwd: &str, argv: &[String], minimized: bool) -> bool {
    let mut line = format!("cd {} &&", osa::sh_quote(cwd));
    for a in argv {
        line.push(' ');
        line.push_str(&osa::sh_quote(a));
    }
    osa::run(TERMINAL_RUN, &[&line, if minimized { "1" } else { "0" }], Duration::from_secs(20)).is_some()
}

/// Finds the Terminal or iTerm tab reading from `tty` and types `text` and Return there.
const TYPE_INTO: &str = r#"on run argv
set dev to item 1 of argv
set txt to item 2 of argv
if application "Terminal" is running then
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is dev then
          do script txt in t
          return "terminal"
        end if
      end repeat
    end repeat
  end tell
end if
if application "iTerm" is running then
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is dev then
            tell s to write text txt newline no
            delay 0.2
            tell s to write text ""
            return "iterm"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if
return ""
end run"#;

/// Types `text` + Return into the terminal tab of a live CLI chat. Err when its tab isn't in
/// Terminal or iTerm (VS Code's terminal and others can't be typed into from outside).
pub fn type_into(pid: u32, text: &str) -> Result<(), String> {
    let tty = chat_tty(pid).ok_or("this chat has no terminal")?;
    match osa::run(TYPE_INTO, &[&tty, text], Duration::from_secs(10)).as_deref() {
        Some("terminal") | Some("iterm") => Ok(()),
        Some(_) => Err("this chat's terminal isn't Terminal or iTerm".into()),
        None => Err("macOS didn't let Island type into the terminal (Privacy & Security › Automation)".into()),
    }
}

/// Selects the Terminal or iTerm tab whose title holds `needle` and brings its window up.
const SELECT_TAB: &str = r#"on run argv
set needle to item 1 of argv
if application "Terminal" is running then
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          set n to (custom title of t) & " " & (name of w)
        on error
          set n to name of w
        end try
        if n contains needle then
          set selected of t to true
          set index of w to 1
          activate
          return "Terminal"
        end if
      end repeat
    end repeat
  end tell
end if
if application "iTerm" is running then
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (name of s) contains needle then
            select w
            tell t to select
            tell s to select
            activate
            return "iTerm2"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if
return ""
end run"#;

/// The window number of the terminal window now in front, after its tab was picked; None when no
/// Terminal or iTerm tab carries that title.
pub fn select_tab(needle: &str) -> Option<isize> {
    let owner = osa::run(SELECT_TAB, &[needle], Duration::from_secs(8))?;
    if owner.is_empty() {
        return None;
    }
    std::thread::sleep(Duration::from_millis(150));
    crate::mac::cf::on_screen_windows().into_iter().find(|w| w.layer == 0 && w.owner == owner).map(|w| w.id as isize)
}

/// Selects the Terminal or iTerm tab reading from `tty` and brings its window up.
const FOCUS_TTY: &str = r#"on run argv
set dev to item 1 of argv
if application "Terminal" is running then
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is dev then
          set selected of t to true
          set index of w to 1
          activate
          return "terminal"
        end if
      end repeat
    end repeat
  end tell
end if
if application "iTerm" is running then
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is dev then
            select w
            tell t to select
            tell s to select
            activate
            return "iterm"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if
return ""
end run"#;

/// The terminal device of a chat: its own, or its nearest parent's (a hook's shell).
fn chat_tty(pid: u32) -> Option<String> {
    let mut p = pid;
    for _ in 0..4 {
        if p <= 1 {
            return None;
        }
        if let Some(t) = crate::procs::tty_of(p) {
            return Some(t);
        }
        p = crate::procs::parent_of(p);
    }
    None
}

/// Brings up the Terminal or iTerm tab a CLI chat runs in (a Mac's answer to picking a Windows
/// Terminal tab). False when the chat runs elsewhere (VS Code's terminal, Warp…).
#[tauri::command]
pub async fn mac_focus_chat(pid: u32) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(tty) = chat_tty(pid) else { return false };
        let ok = osa::run(FOCUS_TTY, &[&tty], Duration::from_secs(8)).is_some_and(|r| !r.is_empty());
        crate::log::line(format!("focus chat pid={pid} tty={tty} ok={ok}"));
        ok
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_comes_out_of_claude_codes_credentials() {
        let json = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"r","expiresAt":1,"scopes":[]}}"#;
        assert_eq!(token_from(json).as_deref(), Some("sk-ant-oat01-x"));
        assert_eq!(token_from("{}"), None);
        assert_eq!(token_from("not json"), None);
        assert_eq!(token_from(r#"{"claudeAiOauth":{"accessToken":""}}"#), None);
    }

    #[test]
    fn no_sign_in_means_no_token() {
        // The CI Mac has no Claude Code sign-in; this must answer None, not hang or prompt.
        let started = std::time::Instant::now();
        let _ = keychain_token();
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
