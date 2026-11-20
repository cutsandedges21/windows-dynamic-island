// AppleScript through osascript, for the apps that answer to it (Terminal, iTerm). Values travel
// as arguments (`on run argv`), never spliced into the script. The first time Island asks an app,
// macOS asks the user once whether Island may control it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Runs `script` (which starts with `on run argv`) with `args`; its output, or None when it failed
/// or took longer than `limit`.
pub fn run(script: &str, args: &[&str], limit: Duration) -> Option<String> {
    let mut child = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut e) = child.stderr.take() {
                        let _ = e.read_to_string(&mut err);
                    }
                    crate::log::line(format!("osascript failed: {}", err.trim()));
                    return None;
                }
                return Some(out.trim().to_string());
            }
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                crate::log::line("osascript took too long");
                return None;
            }
        }
    }
}

/// One argument for a POSIX shell, in single quotes.
pub fn sh_quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@,+%".contains(c)) {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_arguments_are_quoted_safely() {
        assert_eq!(sh_quote("plain-arg_1.2"), "plain-arg_1.2");
        assert_eq!(sh_quote("two words"), "'two words'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn arguments_reach_the_script_as_they_are() {
        let out = run("on run argv\nreturn (item 1 of argv) & \"|\" & (item 2 of argv)\nend run", &["a \"quoted\" one", "x'y"], Duration::from_secs(20));
        assert_eq!(out.as_deref(), Some("a \"quoted\" one|x'y"));
    }
}
