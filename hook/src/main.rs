//! island-hook: the relay Claude Code runs on every hook event, adapted from
//! Coucou's coucou-hook (MIT, Louis Raillé).
//!
//!   island-hook <EventName>      hook mode: JSON on stdin → \\.\pipe\island-<sid>
//!   island-hook inject <pid>     types stdin + Enter into that process's console
//!   island-hook activity         forwards a JSON activity (stdin) to the island
//!
//! Hard rule: never block Claude Code.
//! * No pipe (Island is closed) → exit 0 at once with nothing on stdout.
//! * Every step runs under a deadline enforced by the main thread.
//! * Only PermissionRequest and Stop wait for an answer. No answer means empty
//!   stdout, and Claude Code carries on exactly as if Island were not installed.
//!   Island answers a Stop within milliseconds unless it is showing a reply box.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

mod win;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay in the island before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);
/// Ceiling for a finished chat waiting on a reply typed in the island; the
/// installer gives the Stop hook 300 s, so we always let go first.
const REPLY_BUDGET: Duration = Duration::from_secs(290);
const MAX_REPLY_LEN: usize = 8_000;
/// ERROR_PIPE_BUSY: every instance is serving someone else; the one error worth retrying.
const ERROR_PIPE_BUSY: i32 = 231;
/// Pointless to forward and possibly enormous.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript"];
const MAX_FIELD_LEN: usize = 2_000;

fn pipe_path() -> String {
    let key = win::current_user_sid().unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\island-{key}")
}

fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                // Somebody else's server on our pipe name gets nothing from us.
                return win::pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("inject") => {
            let pid = args.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let mut text = String::new();
            let _ = std::io::stdin().read_to_string(&mut text);
            let code = match win::inject(pid, &clean_prompt(&text)) {
                Ok(()) => 0,
                Err(err) => {
                    eprintln!("{err}");
                    2
                }
            };
            std::process::exit(code);
        }
        Some("activity") => {
            let mut raw = String::new();
            let _ = std::io::stdin().read_to_string(&mut raw);
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) {
                if let Some(map) = v.as_object_mut() {
                    map.insert("island".into(), serde_json::Value::String("activity".into()));
                    let mut line = v.to_string();
                    line.push('\n');
                    let (tx, rx) = mpsc::channel();
                    std::thread::spawn(move || {
                        let _ = tx.send(talk(&line, false));
                    });
                    let _ = rx.recv_timeout(FIRE_AND_FORGET_BUDGET);
                }
            }
            std::process::exit(0);
        }
        _ => hook_mode(),
    }
}

fn hook_mode() {
    let Some((payload, event)) = read_event() else { std::process::exit(0) };
    let wait = match event.as_str() {
        "PermissionRequest" => Some(DECISION_BUDGET),
        "Stop" => Some(REPLY_BUDGET),
        _ => None,
    };
    let waits_for_answer = wait.is_some();

    // The worker owns every blocking call. If it overruns the budget we stop
    // listening and exit; the process dying takes the pipe handle with it.
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(answer)) = rx.recv_timeout(wait.unwrap_or(FIRE_AND_FORGET_BUDGET)) {
        if let Some(json) = output_json(&event, &answer) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

/// One line, no control characters: what gets typed into the session's prompt.
fn clean_prompt(text: &str) -> String {
    text.replace("\r\n", " ")
        .replace(['\n', '\r', '\t'], " ")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// Turns the island's answer into Claude Code's documented hook output
/// (https://code.claude.com/docs/en/hooks). Anything unrecognised prints
/// nothing, which means "carry on as if Island were not installed".
///
/// PermissionRequest: `allow` | `deny` | {"kind":"deny","message"} |
///   {"kind":"answer","updatedInput"} (AskUserQuestion answered in the island).
/// Stop: {"kind":"reply","text"}: Claude keeps going with the user's reply.
fn output_json(event: &str, answer: &str) -> Option<String> {
    let answer = answer.trim();
    let parsed = if answer.starts_with('{') { serde_json::from_str::<Value>(answer).ok() } else { None };
    let kind = parsed.as_ref().and_then(|v| v.get("kind")).and_then(Value::as_str).unwrap_or("");
    match event {
        "PermissionRequest" => {
            let decision = match (answer, kind) {
                ("allow" | "always", _) => json!({ "behavior": "allow" }),
                ("deny", _) => json!({ "behavior": "deny", "message": "Denied from Island" }),
                (_, "deny") => {
                    let note = parsed.as_ref()?.get("message").and_then(Value::as_str).map(one_line).unwrap_or_default();
                    let message = if note.is_empty() { "Denied from Island".to_string() } else { format!("Denied from Island: {note}") };
                    json!({ "behavior": "deny", "message": message })
                }
                (_, "answer") => {
                    let input = parsed.as_ref()?.get("updatedInput")?.clone();
                    if !input.is_object() {
                        return None;
                    }
                    json!({ "behavior": "allow", "updatedInput": input })
                }
                _ => return None,
            };
            Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string())
        }
        "Stop" if kind == "reply" => {
            let text = parsed.as_ref()?.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let text: String = text.chars().take(MAX_REPLY_LEN).collect();
            let reason = format!("The user replied from the Island app instead of the chat box. Treat this as their next message and carry on:\n\n{text}");
            Some(json!({ "decision": "block", "reason": reason }).to_string())
        }
        _ => None,
    }
}

fn one_line(text: &str) -> String {
    clean_prompt(text).chars().take(MAX_REPLY_LEN).collect()
}

fn read_event() -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }
    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    let arg_event = std::env::args().nth(1).unwrap_or_default();
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));
    for field in DROPPED_FIELDS {
        map.remove(*field);
    }
    let cwd_missing = map.get("cwd").and_then(|v| v.as_str()).map(str::is_empty).unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert("cwd".into(), serde_json::Value::String(cwd.to_string_lossy().to_string()));
        }
    }
    // Which process tree this hook runs in: lets the island tie it to a session.
    map.insert("hook_pid".into(), serde_json::json!(std::process::id()));
    map.insert("hook_ppid".into(), serde_json::json!(win::parent_pid()));
    for (key, var) in [("term_program", "TERM_PROGRAM"), ("wt_session", "WT_SESSION"), ("vscode_pid", "VSCODE_PID")] {
        if !map.contains_key(key) {
            map.insert(key.into(), serde_json::Value::String(std::env::var(var).unwrap_or_default()));
        }
    }
    truncate_strings(&mut payload);
    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;
    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();
    if !waits_for_answer {
        return None;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(event: &str, answer: &str) -> Value {
        serde_json::from_str(&output_json(event, answer).expect("some output")).unwrap()
    }

    #[test]
    fn permission_answers_match_the_documented_shape() {
        assert_eq!(
            out("PermissionRequest", "allow"),
            json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } })
        );
        assert_eq!(out("PermissionRequest", "deny")["hookSpecificOutput"]["decision"], json!({ "behavior": "deny", "message": "Denied from Island" }));
        assert_eq!(out("PermissionRequest", "always")["hookSpecificOutput"]["decision"]["behavior"], "allow");
        let why = out("PermissionRequest", r#"{"kind":"deny","message":"use rg\ninstead"}"#);
        assert_eq!(why["hookSpecificOutput"]["decision"]["message"], "Denied from Island: use rg instead");
    }

    #[test]
    fn question_answers_pass_the_updated_input() {
        let answer = r#"{"kind":"answer","updatedInput":{"questions":[{"question":"Which?"}],"answers":{"Which?":"A"}}}"#;
        let v = out("PermissionRequest", answer);
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["Which?"], "A");
        assert!(output_json("PermissionRequest", r#"{"kind":"answer","updatedInput":"nope"}"#).is_none());
    }

    #[test]
    fn a_reply_keeps_the_chat_going() {
        let v = out("Stop", r#"{"kind":"reply","text":"  now add tests  "}"#);
        assert_eq!(v["decision"], "block");
        assert!(v["reason"].as_str().unwrap().ends_with("now add tests"));
        assert!(output_json("Stop", r#"{"kind":"reply","text":"   "}"#).is_none());
        // A permission word never stops a chat from ending.
        assert!(output_json("Stop", "allow").is_none());
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(output_json("PermissionRequest", "").is_none());
        assert!(output_json("PermissionRequest", "maybe").is_none());
        assert!(output_json("PermissionRequest", r#"{"kind":"reply","text":"hi"}"#).is_none());
        assert!(output_json("Stop", "").is_none());
        assert!(output_json("Notification", "allow").is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn prompts_become_one_clean_line() {
        assert_eq!(clean_prompt("fix it\r\nthen test\n"), "fix it then test");
        assert_eq!(clean_prompt("\u{7}bell\tgone "), "bell gone");
    }
}
