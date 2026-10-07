// Named-pipe server for island-hook, adapted from Coucou's pipe.rs (MIT).
//
// `\\.\pipe\island-<sid>`, one instance per connection. Every hook event is
// forwarded to the island as `hook`; lines marked {"island":"activity"} become
// `external-activity` (the activity API for other programs). PermissionRequest
// and Stop keep their connection open until the island answers.
//
// Claude Code is never blocked by us:
//   * island-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island confirms the card is on screen,
//     and a Stop only for the reply window the island asked for;
//   * whatever happens we drop the connection before island-hook gives up.
// What we write back is a word (`allow`, `deny`) or one JSON line; island-hook
// turns it into Claude Code's JSON, so that wire format lives in one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;
use tokio::time::Instant;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::overlay::LABEL as ISLAND;

/// Slightly under island-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// A finished chat never waits longer than this (island-hook gives up at 290 s).
const REPLY_MAX: Duration = Duration::from_secs(280);
/// Reply window when the island acknowledges a Stop without naming one.
const REPLY_DEFAULT: Duration = Duration::from_secs(45);
/// How long the island gets to say "the card is up".
const ACK_TIMEOUT: Duration = Duration::from_millis(900);
const MAX_PAYLOAD: usize = 1 << 20;

pub enum Reply {
    /// The card is on screen; wait this long (or the event's default).
    Ack(Option<Duration>),
    /// Keep waiting this long from now (the user is typing).
    Hold(Duration),
    /// The answer, sent to island-hook as one line.
    Answer(String),
    Decline,
}

#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

/// Must match island-hook's `pipe_path()` exactly.
pub fn pipe_name() -> String {
    let key = current_user_sid().unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\island-{key}")
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance: refuse to join a pipe somebody else already owns.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                crate::log::line(format!("cannot open the hook pipe: {err}"));
                return;
            }
        };
        crate::log::line(format!("hook pipe listening on {name}"));
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    crate::log::line(format!("cannot reopen the hook pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle(app: AppHandle, mut pipe: NamedPipeServer) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }
    if payload.get("island").and_then(Value::as_str) == Some("activity") {
        let _ = app.emit_to(ISLAND, "external-activity", payload);
        let _ = pipe.disconnect();
        return;
    }
    let event = payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default().to_string();
    let session: String = payload.get("session_id").and_then(Value::as_str).unwrap_or("").chars().take(8).collect();
    let (limit, window) = match event.as_str() {
        "PermissionRequest" => (DECISION_TIMEOUT, DECISION_TIMEOUT),
        "Stop" => (REPLY_MAX, REPLY_DEFAULT),
        _ => {
            crate::log::line(format!("hook {event} session={session}"));
            let _ = app.emit_to(ISLAND, "hook", payload);
            let _ = pipe.disconnect();
            return;
        }
    };

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(16);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    payload["request_id"] = json!(id);
    crate::log::line(format!("hook {event} id={id} session={session} tool={}", payload.get("tool_name").and_then(Value::as_str).unwrap_or("-")));
    let _ = app.emit_to(ISLAND, "hook", payload);

    // Claude Code may stop waiting first (Esc, an answer typed in the terminal,
    // its own timeout): island-hook dies, the pipe closes, and the card must go.
    let answer = tokio::select! {
        a = wait_for_answer(&id, &mut rx, limit, window) => a,
        _ = closed_by_client(&mut pipe) => {
            crate::log::line(format!("hook id={id}: Claude Code stopped waiting"));
            None
        }
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    match answer {
        Some(a) => {
            let _ = pipe.write_all(format!("{a}\n").as_bytes()).await;
            let _ = pipe.flush().await;
        }
        // Claude Code carries on by itself now; the island's card must not pretend otherwise.
        None => {
            let _ = app.emit_to(ISLAND, "hook-expired", json!({ "request_id": id }));
        }
    }
    let _ = pipe.disconnect();
}

/// Resolves when island-hook's end of the pipe goes away. It sends nothing
/// after its one line, so any read that returns is end of file or an error.
async fn closed_by_client(pipe: &mut NamedPipeServer) {
    let mut sink = [0u8; 256];
    loop {
        match pipe.read(&mut sink).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

/// Waits for the island: first a quick "it's on screen" (or an answer, or a
/// pass), then the answer until the window closes. `hold` moves the window;
/// nothing moves it past `limit`.
async fn wait_for_answer(id: &str, rx: &mut mpsc::Receiver<Reply>, limit: Duration, window: Duration) -> Option<String> {
    let started = Instant::now();
    let mut deadline = match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack(w))) => Instant::now() + w.unwrap_or(window),
        Ok(Some(Reply::Hold(w))) => Instant::now() + w,
        Ok(Some(Reply::Answer(a))) => {
            crate::log::line(format!("hook id={id} answered at once"));
            return Some(a);
        }
        Ok(Some(Reply::Decline)) | Ok(None) => {
            crate::log::line(format!("hook id={id} passed"));
            return None;
        }
        Err(_) => {
            crate::log::line(format!("hook id={id} never acknowledged"));
            return None;
        }
    };
    loop {
        deadline = deadline.min(started + limit);
        let now = Instant::now();
        if now >= deadline {
            crate::log::line(format!("hook id={id} window closed"));
            return None;
        }
        match tokio::time::timeout(deadline - now, rx.recv()).await {
            Ok(Some(Reply::Answer(a))) => {
                crate::log::line(format!("hook id={id} answered"));
                return Some(a);
            }
            Ok(Some(Reply::Hold(w))) => deadline = Instant::now() + w,
            Ok(Some(Reply::Ack(w))) => {
                if let Some(w) = w {
                    deadline = Instant::now() + w;
                }
            }
            Ok(Some(Reply::Decline)) | Ok(None) => {
                crate::log::line(format!("hook id={id} let go"));
                return None;
            }
            Err(_) => {
                crate::log::line(format!("hook id={id} window closed"));
                return None;
            }
        }
    }
}

/// One island word: `ack`, `ack:<ms>`, `hold:<ms>`, `allow`, `deny`,
/// `pass`/`decline`, or a JSON object that island-hook knows how to read.
fn parse_reply(reply: &str) -> Reply {
    let ms = |s: &str| s.trim().parse::<u64>().ok().map(|ms| Duration::from_millis(ms.clamp(1_000, REPLY_MAX.as_millis() as u64)));
    let r = reply.trim();
    if let Some(rest) = r.strip_prefix("ack:") {
        return Reply::Ack(ms(rest));
    }
    if let Some(rest) = r.strip_prefix("hold:") {
        return Reply::Hold(ms(rest).unwrap_or(REPLY_DEFAULT));
    }
    match r {
        "ack" => Reply::Ack(None),
        "allow" | "deny" => Reply::Answer(r.to_string()),
        _ if r.starts_with('{') => match serde_json::from_str::<Value>(r) {
            // Re-serialised: guaranteed to be one line on the wire.
            Ok(v) if v.is_object() => Reply::Answer(v.to_string()),
            _ => Reply::Decline,
        },
        _ => Reply::Decline,
    }
}

/// False when nothing waits under that id any more (the window closed): the
/// island then sends the reply another way instead of losing it.
#[tauri::command]
pub fn hook_reply(app: AppHandle, request_id: String, reply: String) -> bool {
    let msg = parse_reply(&reply);
    let keep = matches!(msg, Reply::Ack(_) | Reply::Hold(_));
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep {
            map.get(&request_id).cloned()
        } else {
            map.remove(&request_id)
        }
    };
    match sender {
        Some(tx) => tx.try_send(msg).is_ok(),
        None => {
            crate::log::line(format!("reply for id={request_id}: no pending request"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_parse_into_island_words() {
        assert!(matches!(parse_reply("ack"), Reply::Ack(None)));
        assert!(matches!(parse_reply("ack:45000"), Reply::Ack(Some(d)) if d == Duration::from_secs(45)));
        // Windows are clamped: never under a second, never past the ceiling.
        assert!(matches!(parse_reply("hold:5"), Reply::Hold(d) if d == Duration::from_secs(1)));
        assert!(matches!(parse_reply("hold:99999999"), Reply::Hold(d) if d == REPLY_MAX));
        assert!(matches!(parse_reply("allow"), Reply::Answer(ref a) if a == "allow"));
        assert!(matches!(parse_reply("pass"), Reply::Decline));
        assert!(matches!(parse_reply("{not json"), Reply::Decline));
        match parse_reply("{\"kind\": \"reply\",\n \"text\": \"a\\nb\"}") {
            Reply::Answer(a) => assert!(!a.contains('\n') && a.contains("\"kind\":\"reply\"")),
            _ => panic!("expected an answer"),
        }
    }
}
