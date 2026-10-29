// One phone's connection. The phone opens the control stream and its first line pairs or says
// hi; after that Rust answers pings, keeps push subscriptions, answers about terminals
// (`term-list`, `term-kill`: terms.rs), and passes every other line to the island's TypeScript
// as `remote-msg`. What the island sends waits in the session's outbox.

use iroh::endpoint::{Connection, SendStream, VarInt};
use tokio::sync::Notify;

use super::lines::{End, Kind, LineError, LineReader, Outbox};
use super::pair::Check;
use super::*;

/// The phone opens the control stream and says who it is within this.
const FIRST_LINE_WITHIN: Duration = Duration::from_secs(10);
/// How long a last line (denied, bye) gets to reach the phone before the connection closes.
const LAST_WORD: Duration = Duration::from_secs(3);
/// After its last line, the phone gets this long to close the connection itself.
const LET_GO: Duration = Duration::from_millis(1500);

pub(crate) struct Session {
    pub gen: u64,
    pub conn: Connection,
    out: Mutex<Outbox>,
    wake: Notify,
}

impl Session {
    fn new(gen: u64, conn: Connection) -> Session {
        Session { gen, conn, out: Mutex::new(Outbox::new(OUTBOX_CAP)), wake: Notify::new() }
    }

    /// Queues a line; false when the phone is too slow (it is let go).
    pub fn send(&self, kind: Kind, line: Line) -> bool {
        if self.out.lock().unwrap().push(kind, line).is_err() {
            crate::log::line("remote: a phone fell too far behind; letting it go");
            self.conn.close(VarInt::from_u32(CLOSE_TOO_SLOW), b"too slow");
            return false;
        }
        self.wake.notify_one();
        true
    }

    /// `last` goes after what waits, then the connection closes.
    pub fn end(&self, last: Option<Line>, code: u32, reason: &'static [u8]) {
        self.out.lock().unwrap().end(last, End { code, reason });
        self.wake.notify_one();
    }
}

/// Writes what waits in the outbox, in its order, until the connection closes.
async fn write_loop(s: Arc<Session>, mut send: SendStream) {
    loop {
        let (next, end) = {
            let mut out = s.out.lock().unwrap();
            let next = out.pop();
            (next, out.ending())
        };
        if let Some(line) = next {
            if send.write_all(&line).await.is_err() {
                break;
            }
            continue;
        }
        if let Some(end) = end {
            let _ = send.finish();
            let _ = timeout(LAST_WORD, async {
                let _ = send.stopped().await;
                let _ = timeout(LET_GO, s.conn.closed()).await;
            })
            .await;
            s.conn.close(VarInt::from_u32(end.code), end.reason);
            break;
        }
        tokio::select! {
            _ = s.wake.notified() => {}
            _ = s.conn.closed() => break,
        }
    }
}

/// Writes a last line, gives the phone a moment to read it, and closes the connection.
async fn last_word(conn: &Connection, send: &mut SendStream, line: &[u8], code: u32, reason: &[u8]) {
    let _ = timeout(LAST_WORD, async {
        if send.write_all(line).await.is_ok() && send.finish().is_ok() {
            let _ = send.stopped().await;
            let _ = timeout(LET_GO, conn.closed()).await;
        }
    })
    .await;
    conn.close(VarInt::from_u32(code), reason);
}

/// A phone's first line.
#[derive(Debug, PartialEq)]
pub(super) enum Hello {
    Pair { code: String, name: String },
    Hi,
    /// Pair or hi in a version this build doesn't speak.
    Version,
    /// Anything else: not a phone.
    Bad,
}

pub(super) fn hello(line: &[u8]) -> Hello {
    let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(line) else { return Hello::Bad };
    let t = m.get("t").and_then(Value::as_str);
    if !matches!(t, Some("pair" | "hi")) {
        return Hello::Bad;
    }
    if m.get("v").and_then(Value::as_u64) != Some(PROTOCOL_V) {
        return Hello::Version;
    }
    match t {
        Some("pair") => Hello::Pair {
            code: m.get("code").and_then(Value::as_str).unwrap_or("").to_string(),
            name: clean_phone_name(m.get("name").and_then(Value::as_str).unwrap_or("")),
        },
        _ => Hello::Hi,
    }
}

fn denied(why: &str) -> Line {
    line(&json!({ "t": "denied", "why": why }))
}

/// The first 8 characters of a key, for the log.
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

impl Remote {
    /// A connection that finished its handshake: it pairs, says hi from a paired key, or goes.
    pub(super) async fn incoming(self: Arc<Self>, conn: Connection) {
        let phone = conn.remote_id().to_string();
        let first = timeout(FIRST_LINE_WITHIN, async {
            let (send, recv) = conn.accept_bi().await.ok()?;
            let mut reader = LineReader::new(recv, MAX_LINE);
            let line = reader.next_line().await.ok()??;
            Some((send, reader, line))
        })
        .await;
        let Ok(Some((mut send, reader, first))) = first else {
            conn.close(VarInt::from_u32(CLOSE_SILENT), b"no hello");
            return;
        };
        match hello(&first) {
            Hello::Bad => conn.close(VarInt::from_u32(CLOSE_BAD), b"not a phone"),
            Hello::Version => last_word(&conn, &mut send, &denied("version"), CLOSE_DENIED, b"version").await,
            Hello::Hi => {
                if self.store.lock().unwrap().get(&phone).is_none() {
                    crate::log::line(format!("remote: {} is not a paired phone", short(&phone)));
                    last_word(&conn, &mut send, &denied("unknown"), CLOSE_DENIED, b"unknown").await;
                    return;
                }
                self.run(phone, conn, send, reader, None).await;
            }
            Hello::Pair { code, name } => {
                let check = {
                    let mut slot = self.pairing.lock().unwrap();
                    pair::check(&mut slot, &code, Instant::now())
                };
                if check != Check::Ok {
                    crate::log::line(format!("remote: {} tried to pair with a {} code", short(&phone), if check == Check::Wrong { "wrong" } else { "used or expired" }));
                    let why = if check == Check::Wrong { "code" } else { "expired" };
                    last_word(&conn, &mut send, &denied(why), CLOSE_DENIED, b"denied").await;
                    // The code may have ended with this try.
                    self.settle().await;
                    return;
                }
                {
                    let mut store = self.store.lock().unwrap();
                    store.pair(&phone, &name, now_ms());
                    self.save(&store);
                }
                crate::log::line(format!("remote: paired with {} ({})", name, short(&phone)));
                if send.write_all(&line(&json!({ "t": "paired", "name": self.name() }))).await.is_err() {
                    return;
                }
                self.run(phone, conn, send, reader, Some(name)).await;
            }
        }
    }

    /// The session, until the phone goes: a newer one from the same phone replaces it.
    async fn run(self: Arc<Self>, phone: String, conn: Connection, send: SendStream, mut reader: LineReader, paired: Option<String>) {
        let gen = self.session_seq.fetch_add(1, Ordering::Relaxed);
        let session = Arc::new(Session::new(gen, conn.clone()));
        if let Some(old) = self.sessions.lock().unwrap().insert(phone.clone(), session.clone()) {
            old.conn.close(VarInt::from_u32(CLOSE_REPLACED), b"replaced");
        }
        tokio::spawn(write_loop(session.clone(), send));
        tokio::spawn(self.clone().file_streams(phone.clone(), conn.clone()));
        self.seen(&phone);
        self.emit_phones();
        if let Some(name) = paired {
            (self.emit)("remote-paired", json!({ "phone": phone, "name": name }));
        }
        crate::log::line(format!("remote: {} connected", short(&phone)));
        let pong = line(&json!({ "t": "pong" }));
        let (code, reason): (u32, &[u8]) = loop {
            let bytes = match reader.next_line().await {
                Ok(Some(bytes)) => bytes,
                Ok(None) => break (CLOSE_DONE, b"bye"),
                Err(LineError::TooLong) => break (CLOSE_TOO_LONG, b"line too long"),
                Err(LineError::Read) => break (CLOSE_DONE, b"gone"),
            };
            let Ok(text) = std::str::from_utf8(&bytes) else { break (CLOSE_BAD, b"not utf-8") };
            let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else { continue };
            match msg.get("t").and_then(Value::as_str) {
                Some("ping") => {
                    session.send(Kind::Fifo, pong.clone());
                }
                Some("push-sub") => self.set_push(&phone, msg.get("sub")),
                Some("term-list" | "term-kill") => self.term_control(&phone, &msg),
                Some("pair" | "hi") => {}
                _ => (self.emit)("remote-msg", json!({ "phone": phone, "msg": Value::Object(msg) })),
            }
        };
        conn.close(VarInt::from_u32(code), reason);
        let current = {
            let mut sessions = self.sessions.lock().unwrap();
            let mine = sessions.get(&phone).is_some_and(|s| s.gen == gen);
            if mine {
                sessions.remove(&phone);
            }
            mine
        };
        if current {
            self.seen(&phone);
            self.emit_phones();
        }
        crate::log::line(format!("remote: {} went ({})", short(&phone), String::from_utf8_lossy(reason)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_lines_pair_say_hi_or_are_turned_away() {
        let code = "0123456789abcdef0123456789abcdef";
        assert_eq!(hello(format!(r#"{{"t":"pair","v":1,"code":"{code}","name":" iPhone "}}"#).as_bytes()), Hello::Pair { code: code.into(), name: "iPhone".into() });
        assert_eq!(hello(br#"{"t":"pair","v":1}"#), Hello::Pair { code: String::new(), name: "Phone".into() });
        assert_eq!(hello(br#"{"t":"hi","v":1}"#), Hello::Hi);
        assert_eq!(hello(br#"{"t":"hi","v":2}"#), Hello::Version);
        assert_eq!(hello(br#"{"t":"hi"}"#), Hello::Version);
        assert_eq!(hello(br#"{"t":"nav","open":"grid"}"#), Hello::Bad);
        assert_eq!(hello(b"hi"), Hello::Bad);
        assert_eq!(hello(b"{\"t\":\"hi\",\"v\":1,\"x\":\"\xff\"}"), Hello::Bad, "not UTF-8");
    }
}
