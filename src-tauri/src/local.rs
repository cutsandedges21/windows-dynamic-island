// Local AI: the chat behind the "local" activity. A question, with the turns before
// it, goes to a model running on this PC. For now that is Ollama's server on
// 127.0.0.1:11434; llama.cpp's llama-server speaks the same OpenAI-style chat API,
// so a bundled one can take its place later without touching the activity.
//
// The answer streams back as "local-delta" events while the model writes it, and
// Stop really stops it: dropping the request makes the server stop generating, so a
// stopped question does not keep the CPU busy. As in chat.rs, the log records that
// an ask happened and how it ended, never what was asked or answered.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::chat::{clean_turns, Turn};

const OLLAMA: &str = "http://127.0.0.1:11434";
/// Pill answers are short; this also caps how long a runaway answer keeps the CPU busy.
const MAX_TOKENS: u32 = 512;
const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const LIMITS: Limits = Limits { first: Duration::from_secs(120), next: Duration::from_secs(30) };
const MAX_STREAM_BYTES: usize = 4 * 1024 * 1024;
/// The webview hears about the answer at most this often while it is written.
const EMIT_EVERY: Duration = Duration::from_millis(40);

const SYSTEM_PROMPT: &str = "You are Local AI, a small assistant inside Island, answering from a panel at the edge of the user's screen. \
You run on the user's own Windows PC. Lead with the answer and keep it short unless the question needs more. \
Use plain text with line breaks: no markdown, no headings, no bullet dashes.";
const FACTS_INTRO: &str = "Here is what Island can see on the user's PC right now. Use it to answer questions about the time, \
the date, this PC, its battery, disks, network, sound, music, calendar and apps. If a question needs something \
that is not listed, say you cannot see that from here.";
/// How long Ollama keeps the model in memory after the last use (its default is 5 minutes,
/// after which the next question waits seconds for the model to load again).
const KEEP_ALIVE: &str = "30m";
/// The facts are a few hundred characters; this only guards against a runaway list.
const MAX_CONTEXT: usize = 4000;

// ------------------------------------------------------------------ types

/// A model the local server has.
#[derive(Serialize, Debug, PartialEq)]
pub struct LocalModel {
    pub name: String,
    /// Bytes on disk.
    pub size: u64,
    pub family: String,
    /// Parameter count as the server labels it ("1.7B").
    pub params: String,
}

#[derive(Serialize, Debug)]
pub struct LocalStatus {
    /// Ollama answered.
    pub running: bool,
    pub models: Vec<LocalModel>,
    /// Island's own runtime (src/llama.rs), for PCs without Ollama.
    pub bundled: crate::llama::Bundled,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LocalReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Stopped by the user: not an error. What was written so far already went out as deltas.
    pub cancelled: bool,
}

impl LocalReply {
    fn answer(text: String) -> Self {
        LocalReply { ok: true, text: Some(text), error: None, cancelled: false }
    }
    fn failure(error: impl Into<String>) -> Self {
        LocalReply { ok: false, text: None, error: Some(error.into()), cancelled: false }
    }
    fn stopped() -> Self {
        LocalReply { ok: false, text: None, error: None, cancelled: true }
    }
}

/// The answer so far, for the question `id`.
#[derive(Serialize, Clone)]
struct Delta {
    id: u64,
    text: String,
}

/// What one line of the server's event stream says.
#[derive(Debug, PartialEq)]
enum Piece {
    Text(String),
    Done,
    Failed(String),
    Skip,
}

/// Why an answer ended without finishing.
#[derive(Debug, PartialEq)]
enum Ended {
    Cancelled,
    Failed(String),
}

struct Limits {
    /// Until the server sends anything: loading the model from disk can take a while.
    first: Duration,
    /// Between pieces once it is writing.
    next: Duration,
}

// ------------------------------------------------------------------ commands

/// Questions being answered, so Stop can reach them.
fn running() -> &'static Mutex<HashMap<u64, Arc<Notify>>> {
    static RUNNING: OnceLock<Mutex<HashMap<u64, Arc<Notify>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// The stop signal for `id`, made on first use by either the question or its Stop.
fn stop_signal(id: u64) -> Arc<Notify> {
    running().lock().unwrap().entry(id).or_insert_with(|| Arc::new(Notify::new())).clone()
}

/// Whether the local server is up, and the models it has.
#[tauri::command]
pub async fn local_status() -> LocalStatus {
    let reply = client().get(format!("{OLLAMA}/api/tags")).timeout(STATUS_TIMEOUT).send().await;
    let Ok(response) = reply else {
        return LocalStatus { running: false, models: Vec::new(), bundled: crate::llama::status() };
    };
    let body: Value = response.json().await.unwrap_or(Value::Null);
    LocalStatus { running: true, models: models_from_tags(&body), bundled: crate::llama::status() }
}

/// Loads `model` into memory so the question being typed does not wait for it. True once loaded.
#[tauri::command]
pub async fn local_warm(model: String, backend: Option<String>) -> bool {
    let started = Instant::now();
    let ok = if island(&backend) {
        crate::llama::ensure(model.trim()).await.is_ok()
    } else {
        let reply = client().post(format!("{OLLAMA}/api/generate")).timeout(LIMITS.first).json(&warm_body(model.trim())).send().await;
        reply.is_ok_and(|r| r.status().is_success())
    };
    crate::log::line(format!("local: warm {} in {:.1}s", if ok { "ok" } else { "failed" }, started.elapsed().as_secs_f32()));
    ok
}

/// Island's own models as the picker shows them: this PC, every model, what is downloading.
#[tauri::command]
pub async fn local_models() -> crate::llama::Models {
    crate::llama::models()
}

/// How a download ended, sent as "local-setup-end" to every window.
#[derive(Serialize, Clone)]
struct SetupEnd {
    model: &'static str,
    ok: bool,
    error: Option<String>,
    cancelled: bool,
}

/// Wakes the download under way, which then stops.
fn setup_stop() -> &'static Notify {
    static STOP: OnceLock<Notify> = OnceLock::new();
    STOP.get_or_init(Notify::new)
}

/// Starts downloading Island's runtime and the model `model` (empty: the one recommended for
/// this PC) and returns once it has begun. "local-setup" events follow its progress and one
/// "local-setup-end" says how it ended, so every window can follow a download it did not
/// start, and it carries on when the window that asked closes. A download of another model
/// gives way; asking again for the one already downloading changes nothing.
#[tauri::command]
pub async fn local_setup(app: AppHandle, model: Option<String>) -> Result<(), String> {
    let tier = crate::llama::wanted(model.as_deref().unwrap_or(""))?;
    match crate::llama::downloading_now() {
        Some(id) if id == tier.id => return Ok(()),
        Some(_) => {
            setup_stop().notify_waiters();
            // Its slot frees itself as soon as the stopped download lets go.
            for _ in 0..50 {
                if crate::llama::downloading_now().is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => {}
    }
    let slot = crate::llama::claim(tier)?;
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut last_emit: Option<Instant> = None;
        let events = app.clone();
        let outcome = tokio::select! {
            biased;
            _ = setup_stop().notified() => Err(None),
            done = crate::llama::setup(tier, slot, |p| {
                if p.done < p.total && last_emit.is_some_and(|at| at.elapsed() < Duration::from_millis(250)) {
                    return;
                }
                last_emit = Some(Instant::now());
                let _ = events.emit("local-setup", p);
            }) => done.map_err(Some),
        };
        let how = match &outcome {
            Ok(()) => "done",
            Err(None) => "cancelled",
            Err(Some(_)) => "failed",
        };
        crate::log::line(format!("local: setup {} {how} after {:.0}s", tier.id, started.elapsed().as_secs_f32()));
        let (ok, cancelled) = (outcome.is_ok(), matches!(outcome, Err(None)));
        let _ = app.emit("local-setup-end", SetupEnd { model: tier.id, ok, error: outcome.err().flatten(), cancelled });
    });
    Ok(())
}

/// Stops the download under way. What it fetched stays, and the next try carries on from it.
#[tauri::command]
pub fn local_setup_cancel() {
    setup_stop().notify_waiters();
}

/// Deletes one of Island's own models (`model`), or with none, the runtime and every model.
#[tauri::command]
pub async fn local_remove(model: Option<String>) -> Result<(), String> {
    crate::llama::remove(model.as_deref()).await
}

/// "island": Island's own runtime. Anything else: Ollama.
fn island(backend: &Option<String>) -> bool {
    backend.as_deref() == Some("island")
}

/// What Island can tell the model about this PC beyond what the activities already read.
#[tauri::command]
pub async fn local_device_info() -> DeviceInfo {
    device_info()
}

/// Answers the last message of `messages` (which must be the user's) with `model`,
/// sending the answer so far as "local-delta" events tagged with `id`. `context` is
/// what Island can see on the PC right now; it joins the system prompt.
#[tauri::command]
pub async fn local_ask(app: AppHandle, id: u64, model: String, messages: Vec<Turn>, context: Option<String>, backend: Option<String>) -> LocalReply {
    let started = Instant::now();
    let turns = match clean_turns(messages) {
        Ok(turns) => turns,
        Err(why) => return LocalReply::failure(why),
    };
    let model = model.trim().to_string();
    if model.is_empty() {
        return LocalReply::failure("Pick a model in the Local AI options.");
    }
    let cancel = stop_signal(id);
    let bundled = island(&backend);
    // Island's own server may have to start first; Stop works while it does.
    let base = if bundled {
        tokio::select! {
            biased;
            _ = cancel.notified() => Err(Ended::Cancelled),
            port = crate::llama::ensure(&model) => port.map(|p| format!("http://127.0.0.1:{p}")).map_err(Ended::Failed),
        }
    } else {
        Ok(OLLAMA.to_string())
    };
    let outcome = match base {
        Err(ended) => Err(ended),
        Ok(base) => {
            let mut last_emit: Option<Instant> = None;
            stream_answer(&format!("{base}/v1/chat/completions"), &request_body(&model, &turns, context.as_deref()), &model, &cancel, LIMITS, |text| {
                if last_emit.is_some_and(|at| at.elapsed() < EMIT_EVERY) {
                    return; // the reply carries the whole answer, so a skipped delta loses nothing
                }
                last_emit = Some(Instant::now());
                let _ = app.emit("local-delta", Delta { id, text: text.to_string() });
            })
            .await
        }
    };
    running().lock().unwrap().remove(&id);
    if bundled {
        crate::llama::touch().await;
    }
    let seconds = started.elapsed().as_secs_f32();
    match outcome {
        Ok(text) => {
            crate::log::line(format!("local: answered in {seconds:.1}s"));
            LocalReply::answer(text)
        }
        Err(Ended::Cancelled) => {
            crate::log::line(format!("local: stopped after {seconds:.1}s"));
            LocalReply::stopped()
        }
        Err(Ended::Failed(why)) => {
            crate::log::line(format!("local: failed after {seconds:.1}s"));
            LocalReply::failure(why)
        }
    }
}

/// Stops the answer for `id`. A Stop that beats its question to Rust is kept and
/// picked up when the question starts. One that comes after the answer finished
/// leaves an unused entry behind, which costs nothing worth cleaning up.
#[tauri::command]
pub fn local_cancel(id: u64) {
    stop_signal(id).notify_one();
}

// ------------------------------------------------------------------ the stream

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // A system proxy must never see a request to this machine.
    CLIENT.get_or_init(|| reqwest::Client::builder().no_proxy().user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build().unwrap_or_default())
}

/// Characters, not bytes, so a clipped emoji never splits.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Cuts a byte stream into lines. Network chunks split anywhere, even inside a
/// character, so bytes wait here until their line is complete.
#[derive(Default)]
struct Lines {
    buf: Vec<u8>,
}

impl Lines {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=end).collect();
            out.push(String::from_utf8_lossy(&line[..end]).trim_end_matches('\r').to_string());
        }
        out
    }
}

/// The server's own sentence in an error body: `{"error":{"message":…}}` or `{"error":"…"}`.
fn error_detail(v: &Value) -> Option<String> {
    let error = &v["error"];
    error["message"].as_str().or(error.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(|s| clip(s, 200))
}

/// One line of the OpenAI-style event stream. Reasoning models send their thoughts in
/// their own field first; only the answer's words count.
fn parse_line(line: &str) -> Piece {
    let Some(data) = line.strip_prefix("data:") else {
        return Piece::Skip;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Piece::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return Piece::Skip;
    };
    if let Some(why) = error_detail(&v) {
        return Piece::Failed(why);
    }
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(text) if !text.is_empty() => Piece::Text(text.to_string()),
        _ => Piece::Skip,
    }
}

fn models_from_tags(body: &Value) -> Vec<LocalModel> {
    let Some(list) = body["models"].as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|m| {
            let name = m["name"].as_str().or(m["model"].as_str())?.to_string();
            let details = &m["details"];
            Some(LocalModel {
                name,
                size: m["size"].as_u64().unwrap_or(0),
                family: details["family"].as_str().unwrap_or("").to_string(),
                params: details["parameter_size"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// What Island can tell the model about this PC.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub computer: String,
    pub user: String,
    pub os: String,
    pub cpu: String,
    pub threads: usize,
    pub uptime_secs: u64,
    pub drives: Vec<Drive>,
}

#[derive(Serialize, Debug)]
pub struct Drive {
    pub root: String,
    pub free: u64,
    pub total: u64,
}

/// Windows 11 still calls itself "Windows 10" in ProductName; the build number tells them apart.
fn os_label(product: &str, display: &str, build: &str, ubr: Option<u32>) -> String {
    let eleven = build.parse::<u32>().is_ok_and(|b| b >= 22000);
    let name = if eleven { product.replacen("Windows 10", "Windows 11", 1) } else { product.to_string() };
    let version = if display.is_empty() { String::new() } else { format!(" {display}") };
    let build = match ubr {
        Some(u) => format!("{build}.{u}"),
        None => build.to_string(),
    };
    format!("{name}{version} (build {build})")
}

fn device_info() -> DeviceInfo {
    let nt = windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok();
    let text = |name: &str| nt.as_ref().and_then(|k| k.get_string(name).ok()).unwrap_or_default();
    let os = os_label(&text("ProductName"), &text("DisplayVersion"), &text("CurrentBuildNumber"), nt.as_ref().and_then(|k| k.get_u32("UBR").ok()));
    let cpu = crate::llama::cpu_name();
    DeviceInfo {
        computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        user: std::env::var("USERNAME").unwrap_or_default(),
        os,
        cpu,
        threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        uptime_secs: unsafe { windows::Win32::System::SystemInformation::GetTickCount64() } / 1000,
        drives: fixed_drives(),
    }
}

/// Local disks only: asking a sleeping network drive for its free space can hang.
fn fixed_drives() -> Vec<Drive> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let root = format!("{}:\\", (b'A' + i) as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let path = PCWSTR(wide.as_ptr());
            if unsafe { GetDriveTypeW(path) } != DRIVE_FIXED {
                return None;
            }
            let (mut free, mut total) = (0u64, 0u64);
            unsafe { GetDiskFreeSpaceExW(path, Some(&mut free as *mut u64), Some(&mut total as *mut u64), None) }.ok()?;
            Some(Drive { root, free, total })
        })
        .collect()
}

fn request_body(model: &str, turns: &[Turn], context: Option<&str>) -> Value {
    let system = match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(facts) => format!("{SYSTEM_PROMPT}\n\n{FACTS_INTRO}\n{}", clip(facts, MAX_CONTEXT)),
        None => SYSTEM_PROMPT.to_string(),
    };
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(turns.iter().map(|t| json!({ "role": t.role, "content": t.content })));
    json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS, "keep_alive": KEEP_ALIVE })
}

/// Ollama loads a model, and answers nothing, when asked to generate without a prompt.
fn warm_body(model: &str) -> Value {
    json!({ "model": model, "keep_alive": KEEP_ALIVE })
}

fn server_error(status: u16, body: &str, model: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| error_detail(&v)).unwrap_or_default();
    if status == 404 && detail.contains("not found") {
        return format!("{model} is not installed. Run: ollama pull {model}");
    }
    if detail.is_empty() {
        format!("The model server answered with error {status}.")
    } else {
        format!("The model server said: {detail}")
    }
}

/// Never put the error text in the message: it can carry the request's address.
fn network_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Ollama isn't running. Start it, or get it from ollama.com.".to_string()
    } else {
        "Lost the connection to the model.".to_string()
    }
}

/// Sends the question and reads the answer as it is written, calling `on_text` with the
/// whole answer so far after each new piece. Notifying `cancel` ends it at once and
/// drops the connection, which makes the server stop generating.
async fn stream_answer(url: &str, body: &Value, model: &str, cancel: &Notify, limits: Limits, on_text: impl FnMut(&str)) -> Result<String, Ended> {
    tokio::select! {
        biased;
        _ = cancel.notified() => Err(Ended::Cancelled),
        done = read_stream(url, body, model, &limits, on_text) => done.map_err(Ended::Failed),
    }
}

async fn read_stream(url: &str, body: &Value, model: &str, limits: &Limits, mut on_text: impl FnMut(&str)) -> Result<String, String> {
    let too_slow = || "The model took too long to answer.".to_string();
    // Until the first piece arrives, one deadline covers connecting and loading the model.
    let first_deadline = tokio::time::Instant::now() + limits.first;
    let mut response = tokio::time::timeout_at(first_deadline, client().post(url).json(body).send())
        .await
        .map_err(|_| too_slow())?
        .map_err(|e| network_error(&e))?;
    let status = response.status();
    if !status.is_success() {
        let text = tokio::time::timeout(limits.next, response.text()).await.ok().and_then(Result::ok).unwrap_or_default();
        return Err(server_error(status.as_u16(), &text, model));
    }
    let mut lines = Lines::default();
    let mut answer = String::new();
    let mut received = 0usize;
    loop {
        let piece = if received == 0 {
            tokio::time::timeout_at(first_deadline, response.chunk()).await
        } else {
            tokio::time::timeout(limits.next, response.chunk()).await
        };
        let bytes = match piece {
            Err(_) if answer.is_empty() => return Err(too_slow()),
            Err(_) => return Err("The model stopped writing part-way.".to_string()),
            // The server hung up: keep what was written.
            Ok(Err(_)) | Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        received += bytes.len();
        if received > MAX_STREAM_BYTES {
            return Err("The answer was too long.".to_string());
        }
        for line in lines.push(&bytes) {
            match parse_line(&line) {
                Piece::Text(text) => {
                    answer.push_str(&text);
                    on_text(&answer);
                }
                Piece::Done => return finished(answer),
                Piece::Failed(why) => return Err(why),
                Piece::Skip => {}
            }
        }
    }
    finished(answer)
}

fn finished(answer: String) -> Result<String, String> {
    if answer.trim().is_empty() {
        Err("The model sent no answer.".to_string())
    } else {
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn turn(role: &str, content: &str) -> Turn {
        Turn { role: role.to_string(), content: content.to_string() }
    }

    fn delta(text: &str) -> String {
        format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }] }))
    }

    const DONE: &str = "data: [DONE]\n\n";

    const QUICK: Limits = Limits { first: Duration::from_secs(5), next: Duration::from_secs(5) };

    // ------------------------------------------------------------ lines

    #[test]
    fn lines_wait_for_the_end_of_a_line() {
        let mut lines = Lines::default();
        assert!(lines.push(b"data: a").is_empty());
        assert_eq!(lines.push(b"bc\ndata: d\r\n"), vec!["data: abc", "data: d"]);
    }

    #[test]
    fn lines_keep_a_character_split_across_chunks() {
        let bytes = "data: é\n".as_bytes();
        let mut lines = Lines::default();
        assert!(lines.push(&bytes[..7]).is_empty());
        assert_eq!(lines.push(&bytes[7..]), vec!["data: é"]);
    }

    // ------------------------------------------------------------ stream lines

    #[test]
    fn a_delta_line_is_text() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Ott"},"finish_reason":null}]}"#;
        assert_eq!(parse_line(line), Piece::Text("Ott".to_string()));
    }

    #[test]
    fn done_ends_the_stream() {
        assert_eq!(parse_line("data: [DONE]"), Piece::Done);
        assert_eq!(parse_line("data:[DONE]"), Piece::Done);
    }

    #[test]
    fn lines_without_answer_text_are_skipped() {
        for line in [
            "",
            ": keep-alive",
            "event: message",
            "data: {oops",
            r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ] {
            assert_eq!(parse_line(line), Piece::Skip, "{line}");
        }
    }

    #[test]
    fn an_error_line_fails_with_the_servers_words() {
        assert_eq!(parse_line(r#"data: {"error":{"message":"model is loading"}}"#), Piece::Failed("model is loading".to_string()));
        assert_eq!(parse_line(r#"data: {"error":"out of memory"}"#), Piece::Failed("out of memory".to_string()));
    }

    // ------------------------------------------------------------ models and requests

    #[test]
    fn models_come_from_ollamas_tag_list() {
        let body = json!({ "models": [
            { "name": "llama3.1:8b", "model": "llama3.1:8b", "size": 4920753328u64, "details": { "family": "llama", "parameter_size": "8.0B" } },
            { "name": "nomic-embed-text:latest", "size": 274302450u64, "details": { "family": "nomic-bert", "parameter_size": "137M" } },
        ] });
        assert_eq!(
            models_from_tags(&body),
            vec![
                LocalModel { name: "llama3.1:8b".into(), size: 4920753328, family: "llama".into(), params: "8.0B".into() },
                LocalModel { name: "nomic-embed-text:latest".into(), size: 274302450, family: "nomic-bert".into(), params: "137M".into() },
            ]
        );
    }

    #[test]
    fn no_models_when_the_reply_is_not_a_tag_list() {
        assert!(models_from_tags(&Value::Null).is_empty());
        assert!(models_from_tags(&json!({ "models": "nope" })).is_empty());
    }

    #[test]
    fn the_request_streams_with_the_system_prompt_first() {
        let body = request_body("qwen3:1.7b", &[turn("user", "Hi"), turn("assistant", "Hello"), turn("user", "Capital of Canada?")], None);
        assert_eq!(body["model"], "qwen3:1.7b");
        assert_eq!(body["stream"], true);
        let roles: Vec<&str> = body["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["system", "user", "assistant", "user"]);
        assert_eq!(body["messages"][3]["content"], "Capital of Canada?");
    }

    #[test]
    fn facts_about_the_pc_go_into_the_system_prompt() {
        let body = request_body("m", &[turn("user", "What time is it?")], Some("- Time: Tuesday 2:55 PM"));
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("- Time: Tuesday 2:55 PM"), "{system}");
        let plain = request_body("m", &[turn("user", "Hi")], None);
        assert!(!plain["messages"][0]["content"].as_str().unwrap().contains("- Time"));
    }

    #[test]
    fn warming_loads_the_model_without_asking_anything() {
        let body = warm_body("llama3.2:3b");
        assert_eq!(body["model"], "llama3.2:3b");
        assert_eq!(body["keep_alive"], KEEP_ALIVE);
        assert!(body.get("prompt").is_none() && body.get("messages").is_none());
    }

    #[test]
    fn questions_keep_the_model_loaded_too() {
        assert_eq!(request_body("m", &[turn("user", "Hi")], None)["keep_alive"], KEEP_ALIVE);
    }

    #[test]
    fn windows_11_is_called_windows_11() {
        assert_eq!(os_label("Windows 10 Home", "24H2", "26300", Some(1234)), "Windows 11 Home 24H2 (build 26300.1234)");
        assert_eq!(os_label("Windows 10 Pro", "22H2", "19045", None), "Windows 10 Pro 22H2 (build 19045)");
        assert_eq!(os_label("Windows 10 Pro", "", "19045", None), "Windows 10 Pro (build 19045)");
    }

    #[test]
    fn this_pc_reports_its_basics() {
        let info = device_info();
        assert!(info.os.starts_with("Windows"), "{}", info.os);
        assert!(!info.cpu.is_empty() && info.threads > 0 && info.uptime_secs > 0, "{info:?}");
        assert!(info.drives.iter().any(|d| d.root.starts_with('C') && d.total >= d.free && d.total > 0), "{:?}", info.drives);
    }

    #[test]
    fn a_missing_model_says_how_to_get_it() {
        let body = r#"{"error":{"message":"model \"qwen3:1.7b\" not found, try pulling it first","type":"api_error"}}"#;
        let why = server_error(404, body, "qwen3:1.7b");
        assert!(why.contains("ollama pull qwen3:1.7b"), "{why}");
    }

    #[test]
    fn other_server_errors_carry_the_servers_words() {
        let why = server_error(500, r#"{"error":"model requires more system memory (9.0 GiB) than is available (4.1 GiB)"}"#, "big");
        assert!(why.contains("more system memory"), "{why}");
        assert!(server_error(502, "", "m").contains("502"));
    }

    // ------------------------------------------------------------ the stream, against a fake server

    async fn read_request(sock: &mut TcpStream) {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = sock.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            data.extend_from_slice(&buf[..n]);
            if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
                let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                if data.len() >= end + 4 + len {
                    return;
                }
            }
        }
    }

    /// Answers one request with `status`, then writes each part after its delay (ms) and hangs up.
    async fn serve(status: &'static str, parts: Vec<(u64, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            read_request(&mut sock).await;
            let head = format!("HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n");
            if sock.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            for (wait, part) in parts {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                if sock.write_all(part.as_bytes()).await.is_err() {
                    return;
                }
            }
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}/v1/chat/completions")
    }

    fn body() -> Value {
        json!({ "model": "m", "messages": [], "stream": true })
    }

    #[tokio::test]
    async fn the_answer_streams_until_done() {
        let url = serve("200 OK", vec![(0, delta("Hel")), (20, delta("lo")), (0, DONE.to_string())]).await;
        let mut seen = Vec::new();
        let answer = stream_answer(&url, &body(), "m", &Notify::new(), QUICK, |t| seen.push(t.to_string())).await;
        assert_eq!(answer, Ok("Hello".to_string()));
        assert_eq!(seen, vec!["Hel", "Hello"]);
    }

    #[tokio::test]
    async fn stop_ends_the_answer_at_once() {
        let url = serve("200 OK", vec![(0, delta("Hel")), (10_000, delta("lo"))]).await;
        let cancel = std::sync::Arc::new(Notify::new());
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            stopper.notify_one();
        });
        let started = Instant::now();
        let answer = stream_answer(&url, &body(), "m", &cancel, QUICK, |_| {}).await;
        assert_eq!(answer, Err(Ended::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_stop_before_the_question_starts_still_counts() {
        let url = serve("200 OK", vec![(10_000, delta("late"))]).await;
        let cancel = Notify::new();
        cancel.notify_one();
        assert_eq!(stream_answer(&url, &body(), "m", &cancel, QUICK, |_| {}).await, Err(Ended::Cancelled));
    }

    #[tokio::test]
    async fn an_http_error_is_explained() {
        let error = r#"{"error":{"message":"model \"x\" not found, try pulling it first"}}"#.to_string();
        let url = serve("404 Not Found", vec![(0, error)]).await;
        match stream_answer(&url, &body(), "x", &Notify::new(), QUICK, |_| {}).await {
            Err(Ended::Failed(why)) => assert!(why.contains("ollama pull x"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn silence_before_the_first_word_times_out() {
        let url = serve("200 OK", vec![(5_000, delta("late"))]).await;
        let limits = Limits { first: Duration::from_millis(300), next: Duration::from_secs(5) };
        let started = Instant::now();
        assert!(matches!(stream_answer(&url, &body(), "m", &Notify::new(), limits, |_| {}).await, Err(Ended::Failed(_))));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn silence_in_the_middle_times_out_too() {
        let url = serve("200 OK", vec![(0, delta("Hel")), (5_000, delta("lo"))]).await;
        let limits = Limits { first: Duration::from_secs(5), next: Duration::from_millis(300) };
        assert!(matches!(stream_answer(&url, &body(), "m", &Notify::new(), limits, |_| {}).await, Err(Ended::Failed(_))));
    }

    #[tokio::test]
    async fn thinking_keeps_the_answer_alive() {
        // A reasoning model sends thoughts, not text, for a while: each piece resets the clock.
        let thought = || format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "hmm" } }] }));
        let parts = vec![(0, thought()), (200, thought()), (200, thought()), (200, delta("Yes")), (0, DONE.to_string())];
        let url = serve("200 OK", parts).await;
        let limits = Limits { first: Duration::from_millis(400), next: Duration::from_millis(400) };
        assert_eq!(stream_answer(&url, &body(), "m", &Notify::new(), limits, |_| {}).await, Ok("Yes".to_string()));
    }

    #[tokio::test]
    async fn a_stream_cut_short_keeps_what_was_written() {
        let url = serve("200 OK", vec![(0, delta("Hel"))]).await;
        assert_eq!(stream_answer(&url, &body(), "m", &Notify::new(), QUICK, |_| {}).await, Ok("Hel".to_string()));
    }

    #[tokio::test]
    async fn a_stream_with_no_words_fails() {
        let url = serve("200 OK", vec![(0, DONE.to_string())]).await;
        assert!(matches!(stream_answer(&url, &body(), "m", &Notify::new(), QUICK, |_| {}).await, Err(Ended::Failed(_))));
    }

    /// Against the Ollama on this PC, smallest chat model: `cargo test --lib local:: -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_ollama_streams_an_answer() {
        let status = local_status().await;
        assert!(status.running, "Ollama is not running");
        let model = status.models.iter().filter(|m| !m.name.contains("embed")).min_by_key(|m| m.size).expect("no chat model").name.clone();
        let body = request_body(&model, &[turn("user", "In one short sentence: what is the capital of Canada?")], None);
        let mut pieces = 0;
        let started = Instant::now();
        let answer = stream_answer(&format!("{OLLAMA}/v1/chat/completions"), &body, &model, &Notify::new(), LIMITS, |_| pieces += 1).await.expect("an answer");
        println!("{model}: {pieces} pieces in {:?}: {answer}", started.elapsed());
        assert!(answer.to_lowercase().contains("ottawa"), "{answer}");
        assert!(pieces > 1, "the answer did not stream");
    }

    #[tokio::test]
    async fn no_server_says_ollama_is_not_running() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        match stream_answer(&format!("http://{addr}/v1/chat/completions"), &body(), "m", &Notify::new(), QUICK, |_| {}).await {
            Err(Ended::Failed(why)) => assert!(why.contains("Ollama"), "{why}"),
            other => panic!("{other:?}"),
        }
    }
}
