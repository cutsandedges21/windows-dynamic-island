// The hook relay's server on a Mac: what pipe.rs does over a named pipe on Windows, here over a
// Unix socket in Island's folder (~/Library/Application Support/Island/hook.sock), which only this
// user can reach. island-hook (hook/src/unix.rs) connects to it for every AI hook event.
//
// Same rules as Windows: every hook event goes to the island as `hook`; {"island":"activity"}
// lines become `external-activity`; PermissionRequest, Stop, Claude's AskUserQuestion PreToolUse
// and {"island":"ask"} keep their connection open until the island answers, and never past
// island-hook's own deadlines, so an AI is never blocked by Island.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::overlay::LABEL as ISLAND;

/// Slightly under island-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// A finished chat never waits longer than this (island-hook gives up at 290 s).
const REPLY_MAX: Duration = Duration::from_secs(280);
/// Reply window when the island acknowledges a Stop without naming one.
const REPLY_DEFAULT: Duration = Duration::from_secs(45);
/// An activity API question waits this long at most (island-hook's ask gives up at 30 min).
const ASK_TIMEOUT: Duration = Duration::from_secs(29 * 60 + 50);
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
    /// Not the island's to answer: the AI carries on as if Island weren't there.
    Pass,
    /// Handed back: the AI asks in its own window.
    Decline,
}

/// How a waiting hook ends, for island-hook.
enum Outcome {
    Say(String),
    Silent,
}

#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// Must match island-hook's `socket_path()` (hook/src/unix.rs) exactly.
pub fn socket_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library").join("Application Support").join("Island").join("hook.sock")
}

/// The relay Claude Code (and Codex, Cursor, Antigravity) run, in Island's folder: the copy built
/// into Island, put there (or refreshed) on every start. Written beside and renamed over the old
/// one, so a relay that is running keeps its own file.
pub fn ensure_hook(dest: &Path) {
    let embedded = crate::hooks::embedded_hook();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin").join("island-hook");
    let bytes = if !embedded.is_empty() {
        embedded.to_vec()
    } else if let Ok(b) = std::fs::read(&dev) {
        b
    } else {
        crate::log::line("island-hook is not built into this Island; AI hooks cannot reach it");
        return;
    };
    if std::fs::read(dest).is_ok_and(|b| b == bytes) {
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
        return;
    }
    let Some(dir) = dest.parent() else { return };
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".island-hook.new");
    let written = std::fs::write(&tmp, &bytes)
        .and_then(|_| std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&tmp, dest));
    match written {
        Ok(()) => crate::log::line(format!("island-hook installed at {}", dest.display())),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            crate::log::line(format!("could not install island-hook: {err}"));
        }
    }
}

pub fn start(app: AppHandle) {
    ensure_hook(&crate::claude::hook_exe_path());
    tauri::async_runtime::spawn(async move {
        let path = socket_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // A socket left by an Island that stopped: nobody answers on it, so it goes. One that
        // answers belongs to an Island already running, and stays.
        if path.exists() && std::os::unix::net::UnixStream::connect(&path).is_err() {
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                crate::log::line(format!("cannot open the hook socket: {err}"));
                return;
            }
        };
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        crate::log::line(format!("hook socket listening on {}", path.display()));
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    // Somebody else's program gets nothing from us.
                    let me = unsafe { libc::getuid() };
                    if stream.peer_cred().map(|c| c.uid() != me).unwrap_or(true) {
                        continue;
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { handle(app, stream).await });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    });
}

async fn handle(app: AppHandle, mut sock: UnixStream) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match sock.read(&mut chunk).await {
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
    let island = payload.get("island").and_then(Value::as_str).unwrap_or_default().to_string();
    if island == "activity" {
        let _ = app.emit_to(ISLAND, "external-activity", payload);
        return;
    }
    let ask = island == "ask";
    let event = payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default().to_string();
    let agent = payload.get("agent").and_then(Value::as_str).unwrap_or("claude").to_string();
    let session: String = payload.get("session_id").and_then(Value::as_str).unwrap_or("").chars().take(8).collect();
    let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some((limit, window)) = waits(&island, &agent, &event, &tool) else {
        crate::log::line(format!("hook {agent} {event} session={session}"));
        let _ = app.emit_to(ISLAND, "hook", payload);
        return;
    };

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(16);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    payload["request_id"] = json!(id);
    if ask {
        crate::log::line(format!("ask id={id} item={}", payload.get("id").and_then(Value::as_str).unwrap_or("-")));
    } else {
        crate::log::line(format!("hook {agent} {event} id={id} session={session} tool={}", payload.get("tool_name").and_then(Value::as_str).unwrap_or("-")));
    }
    let _ = app.emit_to(ISLAND, if ask { "external-activity" } else { "hook" }, payload);

    // The AI may stop waiting first (Esc, an answer typed in the terminal, its own timeout), and so
    // may an ask's sender: island-hook ends, the socket closes, and the card must go.
    let outcome = tokio::select! {
        o = wait_for_answer(&id, &mut rx, limit, window) => o,
        _ = closed_by_client(&mut sock) => {
            crate::log::line(format!("hook id={id}: {} stopped waiting", if ask { "the sender".to_string() } else { agent.clone() }));
            Outcome::Silent
        }
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    let said = match outcome {
        Outcome::Say(a) => {
            let _ = sock.write_all(format!("{a}\n").as_bytes()).await;
            let _ = sock.flush().await;
            a != "pass" && a != "decline"
        }
        Outcome::Silent => false,
    };
    if !said {
        let _ = app.emit_to(ISLAND, "hook-expired", json!({ "request_id": id }));
    }
    let _ = sock.shutdown().await;
}

/// (ceiling, default window) for events that wait for the island; None passes straight through.
/// The same table as pipe.rs on Windows and island-hook's `waits_for`.
fn waits(island: &str, agent: &str, event: &str, tool: &str) -> Option<(Duration, Duration)> {
    if island == "ask" {
        return Some((ASK_TIMEOUT, ASK_TIMEOUT));
    }
    match (agent, event, tool) {
        ("cursor", "beforeShellExecution" | "beforeMCPExecution", _) => Some((DECISION_TIMEOUT, DECISION_TIMEOUT)),
        ("cursor", "stop", _) => Some((REPLY_MAX, REPLY_DEFAULT)),
        ("cursor", _, _) => None,
        ("antigravity", "PreToolUse", _) => Some((DECISION_TIMEOUT, DECISION_TIMEOUT)),
        ("antigravity", "Stop", _) => Some((REPLY_MAX, REPLY_DEFAULT)),
        ("antigravity", _, _) => None,
        (_, "PermissionRequest", _) | ("claude", "PreToolUse", "AskUserQuestion") => Some((DECISION_TIMEOUT, DECISION_TIMEOUT)),
        (_, "Stop", _) => Some((REPLY_MAX, REPLY_DEFAULT)),
        _ => None,
    }
}

/// Resolves when island-hook's end goes away: it sends nothing after its one line.
async fn closed_by_client(sock: &mut UnixStream) {
    let mut sink = [0u8; 256];
    loop {
        match sock.read(&mut sink).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

async fn wait_for_answer(id: &str, rx: &mut mpsc::Receiver<Reply>, limit: Duration, window: Duration) -> Outcome {
    let started = Instant::now();
    let mut deadline = match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack(w))) => Instant::now() + w.unwrap_or(window),
        Ok(Some(Reply::Hold(w))) => Instant::now() + w,
        Ok(Some(Reply::Answer(a))) => {
            crate::log::line(format!("hook id={id} answered at once"));
            return Outcome::Say(a);
        }
        Ok(Some(Reply::Decline)) => {
            crate::log::line(format!("hook id={id} handed back"));
            return Outcome::Say("decline".into());
        }
        Ok(Some(Reply::Pass)) | Ok(None) => {
            crate::log::line(format!("hook id={id} passed"));
            return Outcome::Say("pass".into());
        }
        Err(_) => {
            crate::log::line(format!("hook id={id} never acknowledged"));
            return Outcome::Say("pass".into());
        }
    };
    loop {
        deadline = deadline.min(started + limit);
        let now = Instant::now();
        if now >= deadline {
            crate::log::line(format!("hook id={id} window closed"));
            return Outcome::Silent;
        }
        match tokio::time::timeout(deadline - now, rx.recv()).await {
            Ok(Some(Reply::Answer(a))) => {
                crate::log::line(format!("hook id={id} answered"));
                return Outcome::Say(a);
            }
            Ok(Some(Reply::Hold(w))) => deadline = Instant::now() + w,
            Ok(Some(Reply::Ack(w))) => {
                if let Some(w) = w {
                    deadline = Instant::now() + w;
                }
            }
            Ok(Some(Reply::Decline)) => {
                crate::log::line(format!("hook id={id} handed back"));
                return Outcome::Say("decline".into());
            }
            Ok(Some(Reply::Pass)) | Ok(None) => {
                crate::log::line(format!("hook id={id} let go"));
                return Outcome::Say("pass".into());
            }
            Err(_) => {
                crate::log::line(format!("hook id={id} window closed"));
                return Outcome::Silent;
            }
        }
    }
}

/// One island word: `ack`, `ack:<ms>`, `hold:<ms>`, `allow`, `deny`, `pass`, `decline`, or a
/// JSON object that island-hook knows how to read.
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
        "pass" => Reply::Pass,
        "allow" | "deny" => Reply::Answer(r.to_string()),
        _ if r.starts_with('{') => match serde_json::from_str::<Value>(r) {
            Ok(v) if v.is_object() => Reply::Answer(v.to_string()),
            _ => Reply::Decline,
        },
        _ => Reply::Decline,
    }
}

/// False when nothing waits under that id any more (the window closed): the island then sends
/// the reply another way instead of losing it.
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
    fn waits_by_agent() {
        assert_eq!(waits("", "claude", "PreToolUse", "AskUserQuestion"), Some((DECISION_TIMEOUT, DECISION_TIMEOUT)));
        assert_eq!(waits("", "claude", "PreToolUse", "Bash"), None);
        assert_eq!(waits("", "codex", "PreToolUse", "AskUserQuestion"), None);
        assert_eq!(waits("", "codex", "PermissionRequest", "Bash"), Some((DECISION_TIMEOUT, DECISION_TIMEOUT)));
        assert_eq!(waits("", "codex", "Stop", ""), Some((REPLY_MAX, REPLY_DEFAULT)));
        assert_eq!(waits("", "cursor", "beforeShellExecution", ""), Some((DECISION_TIMEOUT, DECISION_TIMEOUT)));
        assert_eq!(waits("", "cursor", "stop", ""), Some((REPLY_MAX, REPLY_DEFAULT)));
        assert_eq!(waits("", "cursor", "sessionStart", ""), None);
        assert_eq!(waits("", "antigravity", "PreToolUse", "run_command"), Some((DECISION_TIMEOUT, DECISION_TIMEOUT)));
        assert_eq!(waits("", "antigravity", "PreInvocation", ""), None);
        assert_eq!(waits("ask", "", "", ""), Some((ASK_TIMEOUT, ASK_TIMEOUT)));
    }

    #[test]
    fn replies_parse_into_island_words() {
        assert!(matches!(parse_reply("ack"), Reply::Ack(None)));
        assert!(matches!(parse_reply("ack:45000"), Reply::Ack(Some(d)) if d == Duration::from_secs(45)));
        assert!(matches!(parse_reply("hold:5"), Reply::Hold(d) if d == Duration::from_secs(1)));
        assert!(matches!(parse_reply("allow"), Reply::Answer(ref a) if a == "allow"));
        assert!(matches!(parse_reply("pass"), Reply::Pass));
        assert!(matches!(parse_reply("{not json"), Reply::Decline));
        match parse_reply("{\"kind\": \"reply\",\n \"text\": \"a\\nb\"}") {
            Reply::Answer(a) => assert!(!a.contains('\n') && a.contains("\"kind\":\"reply\"")),
            _ => panic!("expected an answer"),
        }
    }

    #[test]
    fn the_socket_matches_island_hooks() {
        let p = socket_path();
        assert!(p.ends_with("Library/Application Support/Island/hook.sock"));
        assert!(p.as_os_str().len() < 104, "a Unix socket path has 104 bytes at most");
    }

    /// A whole round trip on a real socket: a waiting event is answered, a plain one goes through.
    #[test]
    fn a_waiting_hook_gets_its_answer_over_the_socket() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("island-sock-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("t.sock");
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).unwrap();
            let server = tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap();
                let v: Value = serde_json::from_slice(&buf[..n]).unwrap();
                assert_eq!(v["hook_event_name"], "PermissionRequest");
                let (tx, mut rx) = mpsc::channel::<Reply>(4);
                tx.send(Reply::Ack(None)).await.unwrap();
                tx.send(parse_reply("allow")).await.unwrap();
                match wait_for_answer("t", &mut rx, DECISION_TIMEOUT, DECISION_TIMEOUT).await {
                    Outcome::Say(a) => sock.write_all(format!("{a}\n").as_bytes()).await.unwrap(),
                    Outcome::Silent => panic!("expected an answer"),
                }
            });
            let mut client = UnixStream::connect(&path).await.unwrap();
            client.write_all(b"{\"hook_event_name\":\"PermissionRequest\",\"agent\":\"claude\"}\n").await.unwrap();
            let mut answer = String::new();
            client.read_to_string(&mut answer).await.unwrap();
            assert_eq!(answer.trim(), "allow");
            server.await.unwrap();
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
