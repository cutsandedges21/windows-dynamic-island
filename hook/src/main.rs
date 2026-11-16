//! island-hook: the relay Claude Code runs on every hook event, adapted from
//! Coucou's coucou-hook (MIT, Louis Raillé).
//!
//!   island-hook <EventName>          hook mode for Claude Code: JSON on stdin → \\.\pipe\island-<sid>
//!   island-hook <agent> <EventName>  hook mode for another AI (`codex`, `cursor`); the event carries "agent"
//!   island-hook inject <pid>         types stdin + Enter into that process's console
//!   island-hook activity             forwards a JSON activity (stdin) to the island
//!   island-hook ask                  the same with buttons; prints the id of the one pressed
//!
//! Hard rule: never block the AI.
//! * No pipe (Island is closed) → exit 0 at once with nothing on stdout.
//! * Every step runs under a deadline enforced by the main thread.
//! * Only PermissionRequest, Stop and Claude's AskUserQuestion PreToolUse wait for an answer
//!   (Cursor: beforeShellExecution, beforeMCPExecution and stop). No answer means empty
//!   stdout, and the AI carries on exactly as if Island were not installed. Island answers a
//!   Stop within milliseconds unless it is showing a reply box, and lets a question go at once
//!   when its chat is the window in front. Codex reads Claude Code's answer shapes for
//!   PermissionRequest and Stop; Cursor has its own (`cursor_output`).

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
/// Ceiling for an activity API question (`ask`); the island lets go a few seconds sooner.
const ASK_BUDGET: Duration = Duration::from_secs(30 * 60);
/// An ask carries this many buttons at most.
const MAX_BUTTONS: usize = 3;
/// ERROR_PIPE_BUSY: every instance is serving someone else; the one error worth retrying.
const ERROR_PIPE_BUSY: i32 = 231;
/// Pointless to forward and possibly enormous.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript"];
const MAX_FIELD_LEN: usize = 2_000;
/// AIs other than Claude Code, named before the event: `island-hook codex Stop`.
const AGENTS: &[&str] = &["codex", "cursor", "antigravity"];

/// (agent, event argument). The old form, `island-hook <Event>`, is Claude Code's.
fn parse_agent(args: &[String]) -> (String, String) {
    match args.get(1).map(String::as_str) {
        Some(a) if AGENTS.contains(&a) => (a.to_string(), args.get(2).cloned().unwrap_or_default()),
        other => ("claude".to_string(), other.unwrap_or_default().to_string()),
    }
}

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
        Some("ask") => {
            let mut raw = String::new();
            let _ = std::io::stdin().read_to_string(&mut raw);
            let Some((line, buttons)) = ask_line(&raw) else { std::process::exit(2) };
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(talk(&line, true));
            });
            // Killing this process (the question no longer stands) takes the card off the island.
            if let Ok(Some(answer)) = rx.recv_timeout(ASK_BUDGET) {
                if let Some(id) = pressed(&answer, &buttons) {
                    let mut out = std::io::stdout();
                    let _ = writeln!(out, "{id}");
                    let _ = out.flush();
                }
            }
            std::process::exit(0);
        }
        _ => hook_mode(),
    }
}

/// `ask`'s stdin made into the pipe line, with the ids of its buttons. None (exit 2): not a JSON
/// object with an `id` and 1 to 3 buttons, each with an `id` (letters, digits, - and _) and a label.
fn ask_line(raw: &str) -> Option<(String, Vec<String>)> {
    let mut v = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok()?;
    let map = v.as_object_mut()?;
    map.get("id").and_then(Value::as_str).filter(|s| !s.trim().is_empty())?;
    let list = map.get("buttons").and_then(Value::as_array)?;
    if list.is_empty() || list.len() > MAX_BUTTONS {
        return None;
    }
    let mut ids = Vec::new();
    for b in list {
        let id = b.get("id").and_then(Value::as_str)?;
        let label = b.get("label").and_then(Value::as_str)?;
        let ok = !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !ok || label.trim().is_empty() || ids.iter().any(|x| x == id) {
            return None;
        }
        ids.push(id.to_string());
    }
    map.insert("island".into(), Value::String("ask".into()));
    let mut line = v.to_string();
    line.push('\n');
    Some((line, ids))
}

/// The island's answer to an ask, {"kind":"button","id":…}, as the id of a button it was given.
fn pressed(answer: &str, buttons: &[String]) -> Option<String> {
    let v = serde_json::from_str::<Value>(answer.trim()).ok()?;
    if v.get("kind").and_then(Value::as_str) != Some("button") {
        return None;
    }
    let id = v.get("id").and_then(Value::as_str)?;
    buttons.iter().find(|b| b.as_str() == id).cloned()
}

fn hook_mode() {
    let Some((payload, agent, event, tool)) = read_event() else {
        // Antigravity needs an answer even from a relay with nothing to say.
        let (agent, event) = parse_agent(&std::env::args().collect::<Vec<_>>());
        if let Some(json) = neutral_output(&agent, &event) {
            println!("{json}");
        }
        std::process::exit(0)
    };
    let wait = waits_for(&agent, &event, &tool);
    let waits_for_answer = wait.is_some();

    // The worker owns every blocking call. If it overruns the budget we stop
    // listening and exit; the process dying takes the pipe handle with it.
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    let answer = match rx.recv_timeout(wait.unwrap_or(FIRE_AND_FORGET_BUDGET)) {
        Ok(answer) => answer,
        // The island had the event and said nothing in time: the same as an empty answer.
        Err(_) if waits_for_answer => Some(String::new()),
        Err(_) => None,
    };
    if let Some(json) = answer.and_then(|a| output_json(&agent, &event, &a)).or_else(|| neutral_output(&agent, &event)) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
    std::process::exit(0);
}

/// How long an event may wait for the island. A Claude question is answered before it is
/// asked (PreToolUse), the documented way that works wherever Claude Code runs: the VS Code
/// extension shows its own question box alongside a PermissionRequest hook and keeps it.
/// Codex has no question a hook can answer, so its PreToolUse never waits. Cursor's events
/// have their own names; its command hooks are installed only when the user asked for them.
fn waits_for(agent: &str, event: &str, tool: &str) -> Option<Duration> {
    match (agent, event, tool) {
        ("cursor", "beforeShellExecution" | "beforeMCPExecution", _) => Some(DECISION_BUDGET),
        ("cursor", "stop", _) => Some(REPLY_BUDGET),
        ("cursor", _, _) => None,
        ("antigravity", "PreToolUse", _) => Some(DECISION_BUDGET),
        ("antigravity", "Stop", _) => Some(REPLY_BUDGET),
        ("antigravity", _, _) => None,
        (_, "PermissionRequest", _) | ("claude", "PreToolUse", "AskUserQuestion") => Some(DECISION_BUDGET),
        (_, "Stop", _) => Some(REPLY_BUDGET),
        _ => None,
    }
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
/// PreToolUse: {"kind":"answer","updatedInput"} only: the question runs with the answers
///   filled in, without asking. Nothing else is ever said there.
/// Stop: {"kind":"reply","text"}: Claude keeps going with the user's reply.
///
/// Codex documents the same shapes for PermissionRequest and Stop
/// (https://developers.openai.com/codex/hooks); it has no PreToolUse answer.
fn output_json(agent: &str, event: &str, answer: &str) -> Option<String> {
    let answer = answer.trim();
    let parsed = if answer.starts_with('{') { serde_json::from_str::<Value>(answer).ok() } else { None };
    let kind = parsed.as_ref().and_then(|v| v.get("kind")).and_then(Value::as_str).unwrap_or("");
    if agent == "cursor" {
        return cursor_output(event, answer, kind, parsed.as_ref());
    }
    if agent == "antigravity" {
        return antigravity_output(event, answer, kind, parsed.as_ref());
    }
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
        "PreToolUse" if kind == "answer" && agent == "claude" => {
            let input = parsed.as_ref()?.get("updatedInput")?.clone();
            if !input.is_object() {
                return None;
            }
            Some(json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": input } }).to_string())
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

/// Cursor's documented hook output (https://cursor.com/docs/agent/hooks). Its `allow` only lets
/// the command through to Cursor's own rules (Cursor still asks unless its Auto-run is on);
/// `ask` makes Cursor ask in its window even then.
///
/// beforeShellExecution / beforeMCPExecution: `allow`, `deny` or {"kind":"deny","message"};
///   `pass` (the island isn't answering these) prints nothing; anything else, including no
///   answer after the card was up, hands the command back: Cursor asks.
/// stop: {"kind":"reply","text"}: the reply goes in as the chat's next message.
fn cursor_output(event: &str, answer: &str, kind: &str, parsed: Option<&Value>) -> Option<String> {
    match event {
        "beforeShellExecution" | "beforeMCPExecution" => {
            let out = match (answer, kind) {
                ("pass", _) => return None,
                ("allow" | "always", _) => json!({ "permission": "allow" }),
                ("deny", _) | (_, "deny") => {
                    let note = parsed.and_then(|v| v.get("message")).and_then(Value::as_str).map(one_line).unwrap_or_default();
                    let agent_message = if note.is_empty() {
                        "The user denied this from Island.".to_string()
                    } else {
                        format!("The user denied this from Island and said: {note}")
                    };
                    json!({ "permission": "deny", "user_message": "Denied from Island", "agent_message": agent_message })
                }
                _ => json!({ "permission": "ask", "user_message": "Not answered in Island, so Cursor asks here." }),
            };
            Some(out.to_string())
        }
        "stop" if kind == "reply" => {
            let text = parsed?.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let text: String = text.chars().take(MAX_REPLY_LEN).collect();
            Some(json!({ "followup_message": text }).to_string())
        }
        _ => None,
    }
}

/// Antigravity's documented hook output (https://antigravity.google/docs/hooks). Its command hook
/// (`PreToolUse` on run_command, only with "Ask me here") must always say something: a missing
/// or unknown decision blocks the tool. Allow approves where Antigravity would have asked
/// (`auto_approve`); Deny blocks with the user's note; anything else hands it back (`ask`).
/// Stop: a reply keeps it going (`continue`, the reply as its system message).
fn antigravity_output(event: &str, answer: &str, kind: &str, parsed: Option<&Value>) -> Option<String> {
    match event {
        "PreToolUse" => Some(match (answer, kind) {
            ("allow" | "always", _) => json!({ "decision": "auto_approve" }).to_string(),
            ("deny", _) | (_, "deny") => {
                let note = parsed.and_then(|v| v.get("message")).and_then(Value::as_str).map(one_line).unwrap_or_default();
                let reason = if note.is_empty() { "The user denied this from Island.".to_string() } else { format!("The user denied this from Island and said: {note}") };
                json!({ "decision": "deny", "reason": reason }).to_string()
            }
            _ => json!({ "decision": "ask", "reason": "Not answered in Island." }).to_string(),
        }),
        "Stop" if kind == "reply" => {
            let text = parsed?.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let text: String = text.chars().take(MAX_REPLY_LEN).collect();
            let reason = format!("The user replied from the Island app. Treat this as their next message and carry on:

{text}");
            Some(json!({ "decision": "continue", "reason": reason }).to_string())
        }
        _ => None,
    }
}

/// What an AI hears when Island has nothing to say (closed, busy, or not answering): nothing at
/// all, except Antigravity, which wants an answer every time: its own way, never approving.
fn neutral_output(agent: &str, event: &str) -> Option<String> {
    if agent != "antigravity" {
        return None;
    }
    Some(match event {
        "PreToolUse" => json!({ "decision": "ask" }).to_string(),
        "Stop" => json!({ "decision": "stop" }).to_string(),
        _ => "{}".to_string(),
    })
}

/// Cursor also runs Claude Code's hooks from ~/.claude/settings.json (its third-party setting),
/// with Cursor's own event: Island's Cursor hooks already speak for Cursor, so that copy
/// stays out of the island instead of showing up as a Claude chat.
fn cursor_running_claude_hook(agent: &str, payload: &serde_json::Map<String, Value>) -> bool {
    agent == "claude" && payload.contains_key("cursor_version")
}

fn one_line(text: &str) -> String {
    clean_prompt(text).chars().take(MAX_REPLY_LEN).collect()
}

/// (one JSON line for the pipe, agent, event, tool name).
fn read_event() -> Option<(String, String, String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }
    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    let (agent, arg_event) = parse_agent(&std::env::args().collect::<Vec<_>>());
    if cursor_running_claude_hook(&agent, map) {
        return None;
    }
    map.insert("agent".into(), serde_json::Value::String(agent.clone()));
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));
    let tool = map.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    for field in DROPPED_FIELDS {
        map.remove(*field);
    }
    let cwd_missing = map.get("cwd").and_then(|v| v.as_str()).map(str::is_empty).unwrap_or(true);
    // Cursor and Antigravity run hooks from their config folders: their own fields name the project.
    if cwd_missing && agent != "cursor" && agent != "antigravity" {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert("cwd".into(), serde_json::Value::String(cwd.to_string_lossy().to_string()));
        }
    }
    // Which process tree this hook runs in: lets the island tie it to a session.
    let (parent, grandparent) = win::parents();
    map.insert("hook_pid".into(), serde_json::json!(std::process::id()));
    map.insert("hook_ppid".into(), serde_json::json!(parent));
    map.insert("hook_gppid".into(), serde_json::json!(grandparent));
    for (key, var) in [("term_program", "TERM_PROGRAM"), ("wt_session", "WT_SESSION"), ("vscode_pid", "VSCODE_PID")] {
        if !map.contains_key(key) {
            map.insert(key.into(), serde_json::Value::String(std::env::var(var).unwrap_or_default()));
        }
    }
    truncate_strings(&mut payload);
    let mut line = payload.to_string();
    line.push('\n');
    Some((line, agent, event, tool))
}

fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) if s.len() > MAX_FIELD_LEN => {
            let mut end = MAX_FIELD_LEN;
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push('…');
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
    // Empty when the island closed the pipe without a word: its card went unanswered.
    Some(String::from_utf8_lossy(&buf).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(event: &str, answer: &str) -> Value {
        serde_json::from_str(&output_json("claude", event, answer).expect("some output")).unwrap()
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
        assert!(output_json("claude", "PermissionRequest", r#"{"kind":"answer","updatedInput":"nope"}"#).is_none());
    }

    #[test]
    fn a_question_is_answered_before_it_is_asked() {
        let answer = r#"{"kind":"answer","updatedInput":{"questions":[{"question":"Which?","options":[{"label":"A"}]}],"answers":{"Which?":"A"}}}"#;
        let v = out("PreToolUse", answer);
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(v["hookSpecificOutput"]["updatedInput"]["answers"]["Which?"], "A");
        assert_eq!(v["hookSpecificOutput"]["updatedInput"]["questions"][0]["question"], "Which?", "the questions go back as they came");
        // PreToolUse never allows or denies anything else from the island.
        assert!(output_json("claude", "PreToolUse", "allow").is_none());
        assert!(output_json("claude", "PreToolUse", "deny").is_none());
        assert!(output_json("claude", "PreToolUse", r#"{"kind":"answer","updatedInput":"nope"}"#).is_none());
    }

    #[test]
    fn only_questions_wait_among_pre_tool_uses() {
        assert_eq!(waits_for("claude", "PreToolUse", "AskUserQuestion"), Some(DECISION_BUDGET));
        assert_eq!(waits_for("claude", "PreToolUse", "Bash"), None);
        assert_eq!(waits_for("claude", "PermissionRequest", "Bash"), Some(DECISION_BUDGET));
        assert_eq!(waits_for("claude", "Stop", ""), Some(REPLY_BUDGET));
        assert_eq!(waits_for("claude", "PostToolUse", "AskUserQuestion"), None);
    }

    #[test]
    fn a_reply_keeps_the_chat_going() {
        let v = out("Stop", r#"{"kind":"reply","text":"  now add tests  "}"#);
        assert_eq!(v["decision"], "block");
        assert!(v["reason"].as_str().unwrap().ends_with("now add tests"));
        assert!(output_json("claude", "Stop", r#"{"kind":"reply","text":"   "}"#).is_none());
        // A permission word never stops a chat from ending.
        assert!(output_json("claude", "Stop", "allow").is_none());
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(output_json("claude", "PermissionRequest", "").is_none());
        assert!(output_json("claude", "PermissionRequest", "maybe").is_none());
        assert!(output_json("claude", "PermissionRequest", r#"{"kind":"reply","text":"hi"}"#).is_none());
        assert!(output_json("claude", "Stop", "").is_none());
        assert!(output_json("claude", "Notification", "allow").is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_agent_comes_before_the_event() {
        assert_eq!(parse_agent(&args(&["island-hook", "codex", "Stop"])), ("codex".to_string(), "Stop".to_string()));
        // The old form is Claude Code's, so installs from before agents keep working.
        assert_eq!(parse_agent(&args(&["island-hook", "Stop"])), ("claude".to_string(), "Stop".to_string()));
        assert_eq!(parse_agent(&args(&["island-hook", "PermissionRequest"])), ("claude".to_string(), "PermissionRequest".to_string()));
        assert_eq!(parse_agent(&args(&["island-hook"])), ("claude".to_string(), String::new()));
    }

    #[test]
    fn codex_waits_only_for_permissions_and_replies() {
        assert_eq!(waits_for("codex", "PermissionRequest", "Bash"), Some(DECISION_BUDGET));
        assert_eq!(waits_for("codex", "Stop", ""), Some(REPLY_BUDGET));
        // Codex has no question a hook can answer: its PreToolUse never waits.
        assert_eq!(waits_for("codex", "PreToolUse", "AskUserQuestion"), None);
        assert_eq!(waits_for("codex", "UserPromptSubmit", ""), None);
    }

    #[test]
    fn codex_answers_use_claude_codes_shapes() {
        assert_eq!(out_for("codex", "PermissionRequest", "allow"), out_for("claude", "PermissionRequest", "allow"));
        let why = out_for("codex", "PermissionRequest", r#"{"kind":"deny","message":"use rg"}"#);
        assert_eq!(why["hookSpecificOutput"]["decision"]["message"], "Denied from Island: use rg");
        assert_eq!(out_for("codex", "Stop", r#"{"kind":"reply","text":"go on"}"#)["decision"], "block");
        let answer = r#"{"kind":"answer","updatedInput":{"questions":[],"answers":{}}}"#;
        assert!(output_json("codex", "PreToolUse", answer).is_none());
    }

    fn out_for(agent: &str, event: &str, answer: &str) -> Value {
        serde_json::from_str(&output_json(agent, event, answer).expect("some output")).unwrap()
    }

    #[test]
    fn cursor_waits_for_its_command_hooks_and_its_stop() {
        assert_eq!(parse_agent(&args(&["island-hook", "cursor", "stop"])), ("cursor".to_string(), "stop".to_string()));
        assert_eq!(waits_for("cursor", "beforeShellExecution", ""), Some(DECISION_BUDGET));
        assert_eq!(waits_for("cursor", "beforeMCPExecution", ""), Some(DECISION_BUDGET));
        assert_eq!(waits_for("cursor", "stop", ""), Some(REPLY_BUDGET));
        assert_eq!(waits_for("cursor", "beforeSubmitPrompt", ""), None);
        assert_eq!(waits_for("cursor", "afterAgentResponse", ""), None);
        assert_eq!(waits_for("cursor", "PermissionRequest", "Bash"), None, "Cursor has no such event");
    }

    #[test]
    fn cursor_permissions_use_cursor_s_shape() {
        assert_eq!(out_for("cursor", "beforeShellExecution", "allow"), json!({ "permission": "allow" }));
        let deny = out_for("cursor", "beforeShellExecution", "deny");
        assert_eq!(deny["permission"], "deny");
        assert_eq!(deny["agent_message"], "The user denied this from Island.");
        let why = out_for("cursor", "beforeMCPExecution", r#"{"kind":"deny","message":"not\nthat one"}"#);
        assert_eq!(why["agent_message"], "The user denied this from Island and said: not that one");
        // Not answered (window closed, hand-back, timeout): Cursor asks in its own window.
        assert_eq!(out_for("cursor", "beforeShellExecution", "")["permission"], "ask");
        assert_eq!(out_for("cursor", "beforeShellExecution", "decline")["permission"], "ask");
        // The island isn't answering these: Cursor carries on as if Island weren't there.
        assert!(output_json("cursor", "beforeShellExecution", "pass").is_none());
    }

    #[test]
    fn a_cursor_reply_is_its_next_message() {
        assert_eq!(out_for("cursor", "stop", r#"{"kind":"reply","text":"  now the tests  "}"#), json!({ "followup_message": "now the tests" }));
        assert!(output_json("cursor", "stop", r#"{"kind":"reply","text":"  "}"#).is_none());
        assert!(output_json("cursor", "stop", "pass").is_none());
        assert!(output_json("cursor", "stop", "").is_none());
        assert!(output_json("cursor", "sessionStart", "allow").is_none());
    }

    #[test]
    fn claude_hooks_run_by_cursor_stay_out() {
        let from_cursor = json!({ "hook_event_name": "stop", "cursor_version": "3.27.22", "session_id": "x" });
        let from_claude = json!({ "hook_event_name": "Stop", "session_id": "x" });
        assert!(cursor_running_claude_hook("claude", from_cursor.as_object().unwrap()));
        assert!(!cursor_running_claude_hook("claude", from_claude.as_object().unwrap()));
        assert!(!cursor_running_claude_hook("cursor", from_cursor.as_object().unwrap()), "Island's own Cursor hooks go through");
    }

    #[test]
    fn antigravity_always_gets_an_answer_and_is_never_approved_by_default() {
        assert_eq!(waits_for("antigravity", "PreToolUse", ""), Some(DECISION_BUDGET));
        assert_eq!(waits_for("antigravity", "Stop", ""), Some(REPLY_BUDGET));
        assert_eq!(waits_for("antigravity", "PreInvocation", ""), None);
        assert_eq!(out_for("antigravity", "PreToolUse", "allow"), json!({ "decision": "auto_approve" }));
        let why = out_for("antigravity", "PreToolUse", r#"{"kind":"deny","message":"use rg"}"#);
        assert_eq!(why["decision"], "deny");
        assert_eq!(why["reason"], "The user denied this from Island and said: use rg");
        for none in ["", "pass", "decline", "maybe"] {
            assert_eq!(out_for("antigravity", "PreToolUse", none)["decision"], "ask", "{none:?} hands it back");
        }
        let go = out_for("antigravity", "Stop", r#"{"kind":"reply","text":"and the docs"}"#);
        assert_eq!(go["decision"], "continue");
        assert!(go["reason"].as_str().unwrap().ends_with("and the docs"));
        assert!(output_json("antigravity", "Stop", "pass").is_none());
        // Nothing from the island (or no Island at all): its neutral answers.
        assert_eq!(neutral_output("antigravity", "PreToolUse").unwrap(), r#"{"decision":"ask"}"#);
        assert_eq!(neutral_output("antigravity", "Stop").unwrap(), r#"{"decision":"stop"}"#);
        assert_eq!(neutral_output("antigravity", "PostToolUse").unwrap(), "{}");
        assert_eq!(neutral_output("antigravity", "SessionStart").unwrap(), "{}");
        assert!(neutral_output("claude", "Stop").is_none() && neutral_output("cursor", "stop").is_none());
    }

    #[test]
    fn an_ask_needs_an_id_and_named_buttons() {
        let (line, ids) = ask_line(r#"{"id":"fw","title":"Allow?","buttons":[{"id":"allow","label":"Allow","primary":true},{"id":"cancel","label":"Cancel"}]}"#).unwrap();
        assert_eq!(ids, vec!["allow", "cancel"]);
        assert!(line.ends_with('\n') && line.trim().lines().count() == 1);
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["island"], "ask");
        assert!(ask_line("\u{feff}{\"id\":\"a\",\"buttons\":[{\"id\":\"ok\",\"label\":\"OK\"}]}").is_some());
        assert!(ask_line(r#"{"id":"fw","buttons":[]}"#).is_none());
        assert!(ask_line(r#"{"buttons":[{"id":"ok","label":"OK"}]}"#).is_none());
        assert!(ask_line(r#"{"id":"fw","buttons":[{"id":"o k","label":"OK"}]}"#).is_none());
        assert!(ask_line(r#"{"id":"fw","buttons":[{"id":"ok","label":" "}]}"#).is_none());
        assert!(ask_line(r#"{"id":"fw","buttons":[{"id":"ok","label":"A"},{"id":"ok","label":"B"}]}"#).is_none());
        assert!(ask_line(r#"{"id":"fw","buttons":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},{"id":"d","label":"D"}]}"#).is_none());
        assert!(ask_line("not json").is_none());
    }

    #[test]
    fn only_a_given_button_is_printed() {
        let ids = vec!["allow".to_string(), "cancel".to_string()];
        assert_eq!(pressed(r#"{"kind":"button","id":"cancel"}"#, &ids).as_deref(), Some("cancel"));
        assert_eq!(pressed(r#"{"kind":"button","id":"rm-rf"}"#, &ids), None);
        assert_eq!(pressed("allow", &ids), None);
        assert_eq!(pressed(r#"{"kind":"reply","text":"allow"}"#, &ids), None);
    }

    #[test]
    fn prompts_become_one_clean_line() {
        assert_eq!(clean_prompt("fix it\r\nthen test\n"), "fix it then test");
        assert_eq!(clean_prompt("\u{7}bell\tgone "), "bell gone");
    }
}
