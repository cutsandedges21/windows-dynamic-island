// Ask Claude: the chat behind the "ask" activity. A question, with the turns
// before it, goes either to Claude Code (headless `claude -p`, which uses the
// user's own Claude login, so no key is needed) or to the Messages API with web
// search (a key the user saved as "ask.apikey"). Prompts and keys stay in this
// process: the log only records that an ask happened and how it ended, never what
// was asked or answered.
//
// The API request follows Coucou's client (MIT, Louis Raillé): the same endpoint,
// the server-side web search tool and the server-side fallback, so a policy
// decline is retried on another model inside the same call.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const API_KEY_SECRET: &str = "ask.apikey";
const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MODEL: &str = "claude-sonnet-5-5";
const MAX_TOKENS: u32 = 1024;
const SEARCH_TOOL: &str = "web_search_20260209";
const MAX_SEARCHES: u32 = 5;
/// A turn the API pauses (a long run of searches) is resumed at most this many times.
const MAX_RESUMES: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const API_DEADLINE: Duration = Duration::from_secs(100);
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const CLAUDE_CODE_LIMIT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

/// Messages kept from the chat so far, and the longest one, in characters.
const MAX_TURNS: usize = 12;
const MAX_CHARS: usize = 8000;
/// Earlier turns are squeezed to this many characters in Claude Code's transcript.
const EARLIER_CHARS: usize = 600;

const SYSTEM_PROMPT: &str = "You are Claude, answering from a small panel at the edge of the user's screen. \
Lead with the answer and keep it short unless the question needs more. \
Use plain text with line breaks: no markdown, no headings, no bullet dashes. \
Search the web when the question depends on recent facts.";

const CODE_PREAMBLE: &str = "You are answering from a small panel at the edge of the user's screen. \
Lead with the answer and keep it short unless the question needs more. \
Use plain text with line breaks: no markdown, no headings, no bullet dashes.";

// ------------------------------------------------------------------ types

/// One message of the chat, as the webview keeps it.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Reply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    fn answer(text: String) -> Self {
        Reply { ok: true, text: Some(text), error: None }
    }
    fn failure(error: impl Into<String>) -> Self {
        Reply { ok: false, text: None, error: Some(error.into()) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backends {
    pub claude_code: bool,
    pub api: bool,
}

// ------------------------------------------------------------------ commands

/// Which ways of asking work right now: Claude Code installed, an API key saved.
#[tauri::command]
pub async fn ask_backends() -> Backends {
    Backends { claude_code: find_claude_exe().is_some(), api: secrets::get(API_KEY_SECRET).is_some() }
}

/// Answers the last message of `messages` (which must be the user's) using `backend`:
/// "claude-code" or "api".
#[tauri::command]
pub async fn ask_claude(backend: String, messages: Vec<Turn>) -> Reply {
    let started = Instant::now();
    let turns = match clean_turns(messages) {
        Ok(turns) => turns,
        Err(why) => return Reply::failure(why),
    };
    let outcome = match backend.as_str() {
        "claude-code" => ask_claude_code(&turns).await,
        "api" => match tokio::time::timeout(API_DEADLINE, ask_api(&turns)).await {
            Ok(done) => done,
            Err(_) => Err("Claude took too long to answer.".to_string()),
        },
        _ => Err("Pick Claude Code or the API in the Ask Claude options.".to_string()),
    };
    let seconds = started.elapsed().as_secs_f32();
    match outcome {
        Ok(text) => {
            crate::log::line(format!("ask {backend}: answered in {seconds:.1}s"));
            Reply::answer(text)
        }
        Err(why) => {
            crate::log::line(format!("ask {backend}: failed after {seconds:.1}s"));
            Reply::failure(why)
        }
    }
}

// ------------------------------------------------------------------ the chat

/// Characters, not bytes, so a clipped emoji never splits.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Keeps what can be sent: user and assistant messages with text, the most recent ones,
/// starting with a user message and ending with the question being asked.
pub(crate) fn clean_turns(messages: Vec<Turn>) -> Result<Vec<Turn>, String> {
    let mut turns: Vec<Turn> = messages
        .into_iter()
        .filter(|t| t.role == "user" || t.role == "assistant")
        .filter_map(|t| {
            let content = t.content.trim();
            (!content.is_empty()).then(|| Turn { role: t.role, content: clip(content, MAX_CHARS) })
        })
        .collect();
    if turns.len() > MAX_TURNS {
        turns.drain(..turns.len() - MAX_TURNS);
    }
    while turns.first().is_some_and(|t| t.role == "assistant") {
        turns.remove(0);
    }
    match turns.last() {
        Some(last) if last.role == "user" => Ok(turns),
        _ => Err("There is no question to answer.".to_string()),
    }
}

// ------------------------------------------------------------------ Claude Code

fn find_claude_exe() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let local = crate::claude::home().join(".local").join("bin").join("claude.exe");
    local.is_file().then_some(local)
}

/// Claude Code runs here, away from the user's projects, so it reads no project files and
/// its transcripts do not mix with real sessions.
fn ask_dir() -> PathBuf {
    crate::log::data_dir().join("ask")
}

/// One prompt for `claude -p`: earlier turns as a short transcript, then the question.
fn transcript_prompt(turns: &[Turn]) -> String {
    let mut prompt = String::from(CODE_PREAMBLE);
    let Some((question, earlier)) = turns.split_last() else { return prompt };
    if !earlier.is_empty() {
        prompt.push_str("\n\nThe chat so far:");
        for turn in earlier {
            let who = if turn.role == "user" { "User" } else { "Claude" };
            let one_line = turn.content.split_whitespace().collect::<Vec<_>>().join(" ");
            prompt.push_str(&format!("\n{who}: {}", clip(&one_line, EARLIER_CHARS)));
        }
    }
    prompt.push_str("\n\nThe user now asks:\n");
    prompt.push_str(&question.content);
    prompt
}

/// The answer in `claude -p --output-format json`: one result object (or, with some
/// versions, a list of events ending in one). A warning line may come before it.
fn parse_claude_output(stdout: &str) -> Result<String, String> {
    let unreadable = || "Claude Code answered in a form Island could not read.".to_string();
    let text = stdout.trim();
    let value: Value = serde_json::from_str(text)
        .ok()
        .or_else(|| {
            text.lines()
                .rev()
                .map(str::trim)
                .filter(|l| l.starts_with('{') || l.starts_with('['))
                .find_map(|l| serde_json::from_str(l).ok())
        })
        .ok_or_else(unreadable)?;
    let result = match &value {
        Value::Array(events) => events.iter().rev().find(|e| e["type"] == "result"),
        Value::Object(_) => Some(&value),
        _ => None,
    }
    .ok_or_else(unreadable)?;

    let answer = result["result"].as_str().map(str::trim).unwrap_or("");
    if result["is_error"].as_bool() == Some(true) {
        return Err(if answer.is_empty() {
            format!("Claude Code reported an error ({}).", result["subtype"].as_str().unwrap_or("unknown"))
        } else {
            clip(answer, 300)
        });
    }
    if answer.is_empty() {
        return Err("Claude Code returned no answer.".to_string());
    }
    Ok(answer.to_string())
}

async fn ask_claude_code(turns: &[Turn]) -> Result<String, String> {
    let Some(exe) = find_claude_exe() else {
        return Err("Claude Code is not installed. Install it, or add an API key in the Ask Claude options.".to_string());
    };
    let prompt = transcript_prompt(turns);
    tokio::task::spawn_blocking(move || run_claude_code(&exe, &prompt))
        .await
        .map_err(|_| "Claude Code stopped unexpectedly.".to_string())?
}

fn run_claude_code(exe: &Path, prompt: &str) -> Result<String, String> {
    let dir = ask_dir();
    std::fs::create_dir_all(&dir).map_err(|_| "Island could not prepare its Ask folder.".to_string())?;
    let mut command = Command::new(exe);
    command
        .args(["-p", "--output-format", "json"])
        .arg(prompt)
        .current_dir(&dir)
        // A Claude Code session that launched Island must not make this look like a nested one.
        .env_remove("CLAUDECODE");
    match run_hidden(command, CLAUDE_CODE_LIMIT) {
        Err(RunFailure::Start) => Err("Island could not start Claude Code.".to_string()),
        Err(RunFailure::Timeout) => Err("Claude Code took longer than 2 minutes, so Island stopped it.".to_string()),
        Err(RunFailure::Lost) => Err("Island lost track of Claude Code.".to_string()),
        Ok(done) => {
            // A failed run still prints its JSON result, which says why.
            parse_claude_output(&done.stdout).map_err(|why| match done.status.code() {
                Some(0) | None => why,
                Some(code) => {
                    let first_line = done.stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
                    if first_line.is_empty() {
                        format!("Claude Code stopped with code {code}.")
                    } else {
                        format!("Claude Code stopped with code {code}: {}", clip(first_line, 160))
                    }
                }
            })
        }
    }
}

// ------------------------------------------------------------------ a hidden child with a deadline

struct Finished {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

enum RunFailure {
    Start,
    Timeout,
    Lost,
}

/// Reads a pipe on its own thread so a chatty child can never fill it and stall.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        }
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

/// A shell may have started helpers of its own, so the whole tree goes, not just the child.
fn kill_tree(child: &mut Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs a command with no window and no input, and waits for it up to `limit`.
fn run_hidden(mut command: Command, limit: Duration) -> Result<Finished, RunFailure> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| RunFailure::Start)?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(&mut child);
                return Err(RunFailure::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(RunFailure::Lost),
        }
    };
    // A helper that outlives the child can hold a pipe open; do not wait for it forever.
    let grace = Duration::from_secs(5);
    Ok(Finished { status, stdout: out.recv_timeout(grace).unwrap_or_default(), stderr: err.recv_timeout(grace).unwrap_or_default() })
}

// ------------------------------------------------------------------ the Messages API

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build().unwrap_or_default())
}

fn api_body(turns: &[Turn]) -> Value {
    let messages: Vec<Value> = turns.iter().map(|t| json!({ "role": t.role, "content": t.content })).collect();
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": SEARCH_TOOL, "name": "web_search", "max_uses": MAX_SEARCHES }],
        // A quick answer: low effort keeps the small token budget for the answer itself.
        "output_config": { "effort": "low" },
        "fallbacks": "default",
        "messages": messages,
    })
}

/// What the API's answer means for the chat.
#[derive(Debug, PartialEq)]
enum Outcome {
    Answer(String),
    /// The turn was paused part-way (long server-side searches): send these blocks back to resume it.
    Resume(Vec<Value>),
    Failed(String),
}

/// The words of the answer. Web search puts narration ("let me look") and tool results
/// before it, so only the text after the last search counts; text split around citations
/// is one sentence and joins without a gap.
fn answer_text(blocks: &[Value]) -> String {
    let kind = |b: &Value| b["type"].as_str().unwrap_or("").to_string();
    let is_search = |b: &Value| matches!(kind(b).as_str(), "server_tool_use" | "web_search_tool_result");
    let join = |from: usize| -> String {
        blocks[from..].iter().filter(|b| kind(b) == "text").filter_map(|b| b["text"].as_str()).collect::<String>().trim().to_string()
    };
    let after_search = blocks.iter().rposition(is_search).map(|i| i + 1).unwrap_or(0);
    let answer = join(after_search);
    if answer.is_empty() { join(0) } else { answer }
}

fn read_reply(response: &Value) -> Outcome {
    let Some(blocks) = response["content"].as_array() else {
        return Outcome::Failed("Claude's answer was not in a form Island could read.".to_string());
    };
    let stop = response["stop_reason"].as_str().unwrap_or("");
    match stop {
        // A policy decline is an ordinary 200 with this stop reason.
        "refusal" => {
            let why = response["stop_details"]["explanation"].as_str().map(str::trim).filter(|s| !s.is_empty());
            return Outcome::Failed(clip(why.unwrap_or("Claude declined to answer that."), 300));
        }
        "pause_turn" if !blocks.is_empty() => return Outcome::Resume(blocks.clone()),
        _ => {}
    }
    let text = answer_text(blocks);
    match (text.is_empty(), stop) {
        (true, "max_tokens") => Outcome::Failed("The answer ran out of room. Try a shorter question.".to_string()),
        (true, _) => Outcome::Failed("Claude sent no text.".to_string()),
        (false, "max_tokens") => Outcome::Answer(format!("{text} …")),
        (false, _) => Outcome::Answer(text),
    }
}

/// The API's own sentence for a bad request; a refused key and a busy service get plainer words.
fn api_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or_default();
    match status {
        401 => "The API key was refused (401). Save it again in the Ask Claude options.".to_string(),
        403 => "The API key is not allowed to do that (403).".to_string(),
        429 => "Rate limited. Try again in a moment.".to_string(),
        500..=599 => format!("Claude is having trouble right now (error {status}). Try again."),
        _ if !detail.is_empty() => format!("Claude API {status}: {}", clip(&detail, 200)),
        _ => format!("Claude API error {status}."),
    }
}

/// Never put the error text in the message: it can carry the request's address.
fn network_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Claude took too long to answer.".to_string()
    } else if e.is_builder() {
        "The saved API key has characters Claude cannot accept. Save it again.".to_string()
    } else {
        "No connection to Claude.".to_string()
    }
}

async fn call_api(key: &str, body: &Value) -> Result<Value, String> {
    let response = client()
        .post(ENDPOINT)
        .timeout(REQUEST_TIMEOUT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .json(body)
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = response.status();
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE_BYTES) {
        return Err("Claude's answer was too large.".to_string());
    }
    let text = response.text().await.map_err(|_| "Claude's answer was cut off.".to_string())?;
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &text));
    }
    serde_json::from_str(&text).map_err(|_| "Claude's answer was not in a form Island could read.".to_string())
}

async fn ask_api(turns: &[Turn]) -> Result<String, String> {
    let Some(key) = secrets::get(API_KEY_SECRET) else {
        return Err("No API key saved. Add one in the Ask Claude options.".to_string());
    };
    let mut body = api_body(turns);
    for _ in 0..=MAX_RESUMES {
        let response = call_api(&key, &body).await?;
        match read_reply(&response) {
            Outcome::Answer(text) => return Ok(text),
            Outcome::Failed(why) => return Err(why),
            Outcome::Resume(blocks) => {
                if let Some(messages) = body["messages"].as_array_mut() {
                    messages.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
        }
    }
    Err("Claude kept searching without finishing. Try a narrower question.".to_string())
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, content: &str) -> Turn {
        Turn { role: role.to_string(), content: content.to_string() }
    }

    #[test]
    fn the_chat_keeps_real_turns_and_ends_on_the_question() {
        let kept = clean_turns(vec![
            turn("assistant", "stray opener"),
            turn("system", "ignored"),
            turn("user", "  What is Rust?  "),
            turn("assistant", "A language."),
            turn("user", "   "),
            turn("user", "And Tauri?"),
        ])
        .unwrap();
        assert_eq!(kept, vec![turn("user", "What is Rust?"), turn("assistant", "A language."), turn("user", "And Tauri?")]);
        assert!(clean_turns(vec![]).is_err());
        assert!(clean_turns(vec![turn("user", "Hi"), turn("assistant", "Hello")]).is_err());
    }

    #[test]
    fn a_long_chat_keeps_its_latest_turns_and_clips_long_ones() {
        let mut chat: Vec<Turn> = (0..30).map(|i| turn(if i % 2 == 0 { "user" } else { "assistant" }, &format!("message {i}"))).collect();
        chat.push(turn("user", &"x".repeat(MAX_CHARS + 500)));
        let kept = clean_turns(chat).unwrap();
        assert!(kept.len() <= MAX_TURNS);
        assert_eq!(kept[0].role, "user");
        let last = kept.last().unwrap();
        assert_eq!(last.content.chars().count(), MAX_CHARS);
        assert!(last.content.ends_with('…'));
    }

    #[test]
    fn claude_code_gets_earlier_turns_as_a_short_transcript() {
        let prompt = transcript_prompt(&[turn("user", "Capital of France?"), turn("assistant", "Paris.\n\nIt is on the Seine."), turn("user", "Population?")]);
        assert!(prompt.starts_with(CODE_PREAMBLE));
        assert!(prompt.contains("The chat so far:\nUser: Capital of France?\nClaude: Paris. It is on the Seine."));
        assert!(prompt.ends_with("The user now asks:\nPopulation?"));
        let first = transcript_prompt(&[turn("user", "Hello")]);
        assert!(!first.contains("The chat so far"));
        assert!(first.ends_with("Hello"));
        let long = transcript_prompt(&[turn("assistant", &"word ".repeat(400)), turn("user", "More?")]);
        assert!(long.chars().count() < CODE_PREAMBLE.chars().count() + EARLIER_CHARS + 120);
    }

    #[test]
    fn claude_code_json_gives_its_result() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"  Paris.  ","session_id":"abc","total_cost_usd":0.01}"#;
        assert_eq!(parse_claude_output(out).as_deref(), Ok("Paris."));
        // A warning line before the JSON, and a trailing newline.
        assert_eq!(parse_claude_output(&format!("warning: update available\n{out}\n")).as_deref(), Ok("Paris."));
        // A list of events: the result is the last one.
        let events = r#"[{"type":"system","subtype":"init"},{"type":"assistant"},{"type":"result","is_error":false,"result":"Done."}]"#;
        assert_eq!(parse_claude_output(events).as_deref(), Ok("Done."));
    }

    #[test]
    fn claude_code_errors_say_why() {
        let login = r#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#;
        assert_eq!(parse_claude_output(login), Err("Invalid API key · Please run /login".to_string()));
        let turns = r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        assert_eq!(parse_claude_output(turns), Err("Claude Code reported an error (error_max_turns).".to_string()));
        assert_eq!(parse_claude_output(r#"{"type":"result","is_error":false,"result":"  "}"#), Err("Claude Code returned no answer.".to_string()));
        assert!(parse_claude_output("not json at all").is_err());
        assert!(parse_claude_output("").is_err());
        assert!(parse_claude_output("[1,2]").is_err());
    }

    #[test]
    fn the_api_request_has_the_search_tool_and_the_whole_chat() {
        let body = api_body(&[turn("user", "Hi"), turn("assistant", "Hello"), turn("user", "News?")]);
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["tools"][0]["type"], "web_search_20260209");
        assert_eq!(body["tools"][0]["name"], "web_search");
        assert_eq!(body["tools"][0]["max_uses"], 5);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["messages"][2], json!({ "role": "user", "content": "News?" }));
        // The key travels in a header only, never in the body.
        assert!(!body.to_string().contains("x-api-key"));
    }

    #[test]
    fn the_answer_is_the_text_after_the_last_search() {
        let reply = json!({ "stop_reason": "end_turn", "content": [
            { "type": "text", "text": "Let me look that up." },
            { "type": "server_tool_use", "id": "s1", "name": "web_search", "input": { "query": "x" } },
            { "type": "web_search_tool_result", "tool_use_id": "s1", "content": [] },
            { "type": "text", "text": "Shannon was born in 1916 ", "citations": [] },
            { "type": "text", "text": "in Michigan." }
        ] });
        assert_eq!(read_reply(&reply), Outcome::Answer("Shannon was born in 1916 in Michigan.".to_string()));
        let plain = json!({ "stop_reason": "end_turn", "content": [ { "type": "text", "text": "Hi there" } ] });
        assert_eq!(read_reply(&plain), Outcome::Answer("Hi there".to_string()));
        // Only narration, no text after the search: better than nothing.
        let narration = json!({ "stop_reason": "end_turn", "content": [
            { "type": "text", "text": "Searching." }, { "type": "web_search_tool_result", "content": [] } ] });
        assert_eq!(read_reply(&narration), Outcome::Answer("Searching.".to_string()));
    }

    #[test]
    fn declines_pauses_and_cut_offs_are_told_apart() {
        let refusal = json!({ "stop_reason": "refusal", "content": [], "stop_details": { "type": "refusal", "explanation": "That is not something Claude can help with." } });
        assert_eq!(read_reply(&refusal), Outcome::Failed("That is not something Claude can help with.".to_string()));
        let silent = json!({ "stop_reason": "refusal", "content": [] });
        assert_eq!(read_reply(&silent), Outcome::Failed("Claude declined to answer that.".to_string()));

        let blocks = json!([{ "type": "server_tool_use", "id": "s1", "name": "web_search", "input": {} }]);
        let paused = json!({ "stop_reason": "pause_turn", "content": blocks });
        assert_eq!(read_reply(&paused), Outcome::Resume(blocks.as_array().unwrap().clone()));

        let cut = json!({ "stop_reason": "max_tokens", "content": [ { "type": "text", "text": "Half an ans" } ] });
        assert_eq!(read_reply(&cut), Outcome::Answer("Half an ans …".to_string()));
        let thought_all_day = json!({ "stop_reason": "max_tokens", "content": [ { "type": "thinking", "thinking": "" } ] });
        assert!(matches!(read_reply(&thought_all_day), Outcome::Failed(_)));
        assert!(matches!(read_reply(&json!({ "stop_reason": "end_turn", "content": [] })), Outcome::Failed(_)));
        assert!(matches!(read_reply(&json!({ "type": "error" })), Outcome::Failed(_)));
    }

    #[test]
    fn api_errors_read_plainly() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}"#;
        assert_eq!(api_error(400, body), "Claude API 400: max_tokens: too large");
        assert!(api_error(401, "").contains("refused"));
        assert!(api_error(403, "").contains("403"));
        assert!(api_error(429, "").starts_with("Rate limited"));
        assert!(api_error(529, "overloaded").contains("529"));
        assert_eq!(api_error(404, "<html>"), "Claude API error 404.");
    }

    #[test]
    fn a_missing_key_is_a_plain_message_not_a_request() {
        // The Credential Manager has no "ask.apikey" on a clean test machine; if the
        // developer has one saved the call would be real, so only check the shape.
        if secrets::get(API_KEY_SECRET).is_none() {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let reply = rt.block_on(ask_claude("api".to_string(), vec![turn("user", "hi")]));
            assert!(!reply.ok);
            assert!(reply.error.unwrap().contains("No API key"));
        }
    }

    #[test]
    fn replies_serialize_without_empty_fields() {
        assert_eq!(serde_json::to_value(Reply::answer("x".into())).unwrap(), json!({ "ok": true, "text": "x" }));
        assert_eq!(serde_json::to_value(Reply::failure("no")).unwrap(), json!({ "ok": false, "error": "no" }));
        assert_eq!(serde_json::to_value(Backends { claude_code: true, api: false }).unwrap(), json!({ "claudeCode": true, "api": false }));
    }

    #[test]
    fn a_hidden_child_is_collected_and_a_slow_one_is_stopped() {
        let mut quick = Command::new("cmd");
        // /D: a cmd AutoRun hook on the developer machine must not decide the exit code.
        quick.args(["/D", "/C", "echo hello"]);
        let done = run_hidden(quick, Duration::from_secs(20)).ok().expect("cmd should run");
        assert!(done.status.success());
        assert!(done.stdout.contains("hello"));

        let mut slow = Command::new("ping");
        slow.args(["-n", "30", "127.0.0.1"]);
        let started = Instant::now();
        assert!(matches!(run_hidden(slow, Duration::from_millis(400)), Err(RunFailure::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(10));

        assert!(matches!(run_hidden(Command::new("definitely-not-a-program-island"), Duration::from_secs(1)), Err(RunFailure::Start)));
    }
}
