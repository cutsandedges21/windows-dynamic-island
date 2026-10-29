//! The phone site's iroh endpoint, in the browser (docs/superpowers/specs/2026-10-22-island-phone-design.md).
//! phone/web/src/link/index.ts is its only user and wraps it in the app's `Link` (api.ts).
//! In a browser iroh goes through n0's relays over WebSocket (no UDP); QUIC and its TLS 1.3
//! handshake still run end to end between the phone and the PC.
//!
//! JS API (wasm-bindgen --target web):
//!   phoneId(secret)                      the EndpointId of a 32-byte key
//!   Phone.bind(secret)                   -> Promise<Phone>, this phone's endpoint
//!   phone.connect(island, relays, ms)    -> Promise<Session>: dialed on island-phone/1, control stream open
//!   session.send(line) onLine(cb) onClosed(cb) onFile(cb(header, FileIn)) openFile(header) openTerm(header) close(why)
//!   FileOut: write(bytes) finish() -> the PC's answer line, abort()
//!   FileIn:  read() -> bytes | undefined at the end, reply(line)
//!   Term:    reply() -> the PC's answer line, onFrame(cb(kind, bytes), ended(why)), send(kind, bytes), close()
#![cfg(all(target_family = "wasm", target_os = "unknown"))]

// The kinds other than data mean something only to index.ts (and the fake island).
#[allow(dead_code)]
mod frames;

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::str::FromStr;
use std::time::Duration;

use iroh::address_lookup::{EndpointInfo, PkarrRelayClient, N0_DNS_PKARR_RELAY_PROD};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey};
use js_sys::{Function, Promise, Uint8Array};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, spawn_local};

/// protocol.ts ALPN_PHONE.
const ALPN: &[u8] = b"island-phone/1";
/// protocol.ts MAX_LINE: one control line, its newline included.
const MAX_LINE: usize = 1024 * 1024;
/// protocol.ts MAX_DOWNLOAD: the largest file the PC may send to a phone.
const MAX_DOWNLOAD: u64 = 200 * 1024 * 1024;
/// A file stream's header or answer line.
const MAX_FILE_LINE: usize = 64 * 1024;
/// A terminal stream's header or answer line.
const MAX_TERM_LINE: usize = 64 * 1024;
/// The PC answers a terminal stream's header within this long (it starts the shell first).
const TERM_ANSWER: Duration = Duration::from_secs(20);
/// QUIC close codes this side uses.
const CLOSE_NORMAL: u32 = 0;
const CLOSE_LINE_TOO_LONG: u32 = 413;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{e:#}"))
}

fn js_val(e: impl std::fmt::Display) -> JsValue {
    js_err(e).into()
}

/// iroh issue 4550: n0's relay names are fully qualified (`use1-1.relay.n0.iroh.link.`), and a
/// browser's WebSocket to such a name can hang, so the dot goes.
fn strip_dot(url: &RelayUrl) -> RelayUrl {
    let mut u: url::Url = url.clone().into();
    if let Some(host) = u.host_str().map(str::to_owned) {
        let trimmed = host.trim_end_matches('.');
        if trimmed != host {
            let _ = u.set_host(Some(trimmed));
        }
    }
    RelayUrl::from(u)
}

/// n0's production relays, browser-safe.
fn n0_relays() -> RelayMap {
    let urls: Vec<RelayUrl> = iroh::defaults::prod::default_relay_map().urls();
    urls.iter().map(strip_dot).collect()
}

fn secret_key(secret: &[u8]) -> Result<SecretKey, JsError> {
    let bytes: [u8; 32] = secret.try_into().map_err(|_| JsError::new("the phone's key must be 32 bytes"))?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// The EndpointId (Display form) of a 32-byte secret key: the phone's id, without binding anything.
#[wasm_bindgen(js_name = phoneId)]
pub fn phone_id(secret: &[u8]) -> Result<String, JsError> {
    Ok(secret_key(secret)?.public().to_string())
}

// ------------------------------------------------------------------ the endpoint

#[wasm_bindgen]
pub struct Phone {
    ep: Endpoint,
}

#[wasm_bindgen]
impl Phone {
    /// Binds this phone's endpoint, its key being `secret` (32 bytes), on n0's relays.
    pub async fn bind(secret: Vec<u8>) -> Result<Phone, JsError> {
        let ep = Endpoint::builder(presets::Minimal)
            .secret_key(secret_key(&secret)?)
            .relay_mode(RelayMode::Custom(n0_relays()))
            .bind()
            .await
            .map_err(js_err)?;
        Ok(Phone { ep })
    }

    pub fn id(&self) -> String {
        self.ep.id().to_string()
    }

    /// Dials the island (`island` = its EndpointId) through `relays`, each attempt at most
    /// `timeout_ms`; if that fails, asks n0's pkarr relay where it is now and tries once more.
    /// Resolves with a Session whose control stream is open (nothing sent yet).
    pub fn connect(&self, island: String, relays: Vec<String>, timeout_ms: u32) -> Promise {
        let ep = self.ep.clone();
        future_to_promise(async move {
            let session = connect(ep, island, relays, Duration::from_millis(timeout_ms.into())).await?;
            Ok(session.into())
        })
    }

    pub fn close(&self) -> Promise {
        let ep = self.ep.clone();
        future_to_promise(async move {
            ep.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

async fn connect(ep: Endpoint, island: String, relays: Vec<String>, wait: Duration) -> Result<Session, JsError> {
    let id = EndpointId::from_str(island.trim()).map_err(|_| JsError::new("that isn't an island's id"))?;
    let given: Vec<RelayUrl> = relays.iter().filter_map(|r| RelayUrl::from_str(r).ok()).map(|u| strip_dot(&u)).collect();
    let conn = match dial(&ep, id, &given, wait).await {
        Ok(conn) => conn,
        Err(first) => {
            // Its home relay may have changed since pairing: every island publishes where it
            // is to n0's pkarr relay (presets::N0), which answers over plain HTTPS.
            let found = match lookup(id).await {
                Ok(found) if !found.is_empty() && found != given => found,
                _ => return Err(first),
            };
            dial(&ep, id, &found, wait).await?
        }
    };
    let (send, recv) = conn.open_bi().await.map_err(js_err)?;
    Ok(Session::start(conn, send, recv))
}

async fn dial(ep: &Endpoint, id: EndpointId, relays: &[RelayUrl], wait: Duration) -> Result<Connection, JsError> {
    let addr = relays.iter().fold(EndpointAddr::new(id), |a, r| a.with_relay_url(r.clone()));
    match n0_future::time::timeout(wait, ep.connect(addr, ALPN)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) => Err(js_err(e)),
        Err(_) => Err(JsError::new("the island didn't answer in time")),
    }
}

/// Where an endpoint is now, from its id alone (n0's pkarr relay, dns.iroh.link).
async fn lookup(id: EndpointId) -> Result<Vec<RelayUrl>, JsError> {
    let client = PkarrRelayClient::new(N0_DNS_PKARR_RELAY_PROD.parse::<url::Url>().map_err(js_err)?);
    let packet = client.resolve(id).await.map_err(js_err)?;
    let info = EndpointInfo::from_pkarr_signed_packet(&packet).map_err(js_err)?;
    Ok(info.relay_urls().map(strip_dot).collect())
}

// ------------------------------------------------------------------ the session

/// The JS callbacks of one session. Lines that arrive before `onLine` is set wait in `pending`.
#[derive(Default)]
struct Hooks {
    line: RefCell<Option<Function>>,
    pending: RefCell<Vec<String>>,
    closed: RefCell<Option<Function>>,
    closed_why: RefCell<Option<String>>,
    file: RefCell<Option<Function>>,
}

impl Hooks {
    fn line(&self, line: String) {
        let cb = self.line.borrow().clone();
        match cb {
            Some(cb) => {
                let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&line));
            }
            None => self.pending.borrow_mut().push(line),
        }
    }

    /// The first reason wins; later ones are the same ending seen from elsewhere.
    fn closed(&self, why: String) {
        if self.closed_why.borrow().is_some() {
            return;
        }
        *self.closed_why.borrow_mut() = Some(why.clone());
        let cb = self.closed.borrow().clone();
        if let Some(cb) = cb {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&why));
        }
    }
}

/// One connection to an island: its control stream (lines, queued in order) and file streams.
#[wasm_bindgen]
pub struct Session {
    conn: Connection,
    out: mpsc::UnboundedSender<String>,
    hooks: Rc<Hooks>,
}

impl Session {
    fn start(conn: Connection, send: SendStream, recv: RecvStream) -> Session {
        let hooks = Rc::new(Hooks::default());
        let (out, rx) = mpsc::unbounded_channel();
        spawn_local(write_lines(send, rx));
        spawn_local(read_lines(conn.clone(), recv, hooks.clone()));
        spawn_local(accept_files(conn.clone(), hooks.clone()));
        let (c, h) = (conn.clone(), hooks.clone());
        spawn_local(async move { h.closed(c.closed().await.to_string()) });
        Session { conn, out, hooks }
    }
}

#[wasm_bindgen]
impl Session {
    /// Queues one control line (no newline in it; it's added). False if it's too long or the
    /// session is over.
    pub fn send(&self, line: String) -> bool {
        if line.len() + 1 > MAX_LINE || line.contains('\n') || self.hooks.closed_why.borrow().is_some() {
            return false;
        }
        self.out.send(line).is_ok()
    }

    /// Every line from the island, without its newline; the ones that came first are given now.
    #[wasm_bindgen(js_name = onLine)]
    pub fn on_line(&self, cb: Function) {
        *self.hooks.line.borrow_mut() = Some(cb.clone());
        let pending = std::mem::take(&mut *self.hooks.pending.borrow_mut());
        for line in pending {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&line));
        }
    }

    /// Called once with why the connection ended (at once if it already has).
    #[wasm_bindgen(js_name = onClosed)]
    pub fn on_closed(&self, cb: Function) {
        *self.hooks.closed.borrow_mut() = Some(cb.clone());
        let why = self.hooks.closed_why.borrow().clone();
        if let Some(why) = why {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&why));
        }
    }

    /// `cb(header, FileIn)` for every file the PC sends; without it files are refused.
    #[wasm_bindgen(js_name = onFile)]
    pub fn on_file(&self, cb: Function) {
        *self.hooks.file.borrow_mut() = Some(cb);
    }

    /// Opens a file stream to the PC and writes its header line. Resolves with a FileOut.
    #[wasm_bindgen(js_name = openFile)]
    pub fn open_file(&self, header: String) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            if header.len() + 1 > MAX_FILE_LINE || header.contains('\n') {
                return Err(js_val("the file's header is too long"));
            }
            let (mut send, recv) = conn.open_bi().await.map_err(js_val)?;
            send.write_all(format!("{header}\n").as_bytes()).await.map_err(js_val)?;
            Ok(FileOut { send: Rc::new(RefCell::new(Some(send))), recv: Rc::new(RefCell::new(Some(recv))) }.into())
        })
    }

    /// Opens a terminal stream to the PC: writes its header line (`{"t":"term",…}`) and reads the
    /// PC's one-line answer. Resolves with a Term whatever the answer was (`term-ok`: frames follow;
    /// anything else: the stream is over); rejects with "no answer" if the PC ended the stream
    /// without one (an Island from before terminals) or "no answer in time".
    #[wasm_bindgen(js_name = openTerm)]
    pub fn open_term(&self, header: String) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            if header.len() + 1 > MAX_TERM_LINE || header.contains('\n') {
                return Err(js_val("the terminal's header is too long"));
            }
            let (mut send, mut recv) = conn.open_bi().await.map_err(js_val)?;
            send.write_all(format!("{header}\n").as_bytes()).await.map_err(js_val)?;
            let answer = match n0_future::time::timeout(TERM_ANSWER, read_line(&mut recv, MAX_TERM_LINE)).await {
                Ok(Ok(answer)) => Ok(answer),
                Ok(Err(e)) if e == ENDED_EARLY => Err("no answer".to_string()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("no answer in time".to_string()),
            };
            let (reply, head) = match answer {
                Ok(answer) => answer,
                Err(e) => {
                    let _ = send.reset(VarInt::from_u32(1));
                    let _ = recv.stop(VarInt::from_u32(1));
                    return Err(js_val(e));
                }
            };
            let hooks = Rc::new(TermHooks::default());
            let stop = Rc::new(Notify::new());
            let ok = serde_json::from_str::<Value>(&reply).is_ok_and(|v| v["t"] == "term-ok");
            let out = if ok {
                let (out, rx) = mpsc::unbounded_channel();
                spawn_local(write_frames(send, rx));
                spawn_local(read_frames(recv, head, stop.clone(), hooks.clone()));
                Some(out)
            } else {
                // `term-error` (the PC finishes its side after it): this side is done too.
                let _ = recv.stop(VarInt::from_u32(CLOSE_NORMAL));
                let _ = send.finish();
                *hooks.ended_why.borrow_mut() = Some("refused".into());
                hooks.told.set(true);
                None
            };
            Ok(Term { reply, out: RefCell::new(out), stop, hooks }.into())
        })
    }

    /// Ends the connection now (the island sees `why`).
    pub fn close(&self, why: String) {
        self.conn.close(VarInt::from_u32(CLOSE_NORMAL), why.as_bytes());
        self.hooks.closed(format!("closed by this phone ({why})"));
    }

    /// The connection's paths as JSON (for tests): [{addr, relay, selected, rttMs}].
    pub fn paths(&self) -> String {
        let paths = self.conn.paths();
        let v: Vec<Value> = paths
            .iter()
            .map(|p| json!({ "addr": format!("{:?}", p.remote_addr()), "relay": p.is_relay(), "selected": p.is_selected(), "rttMs": p.rtt().as_secs_f64() * 1000.0 }))
            .collect();
        Value::Array(v).to_string()
    }
}

async fn write_lines(mut send: SendStream, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = rx.recv().await {
        line.push('\n');
        if send.write_all(line.as_bytes()).await.is_err() {
            return;
        }
    }
    let _ = send.finish();
}

async fn read_lines(conn: Connection, mut recv: RecvStream, hooks: Rc<Hooks>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => {
                let mut scan = buf.len();
                buf.extend_from_slice(&chunk[..n]);
                let mut from = 0;
                while let Some(off) = buf[scan..].iter().position(|b| *b == b'\n') {
                    let end = scan + off;
                    if end + 1 - from > MAX_LINE {
                        break;
                    }
                    hooks.line(String::from_utf8_lossy(&buf[from..end]).into_owned());
                    from = end + 1;
                    scan = from;
                }
                buf.drain(..from);
                if buf.len() >= MAX_LINE {
                    conn.close(VarInt::from_u32(CLOSE_LINE_TOO_LONG), b"line over 1 MiB");
                    return hooks.closed("the island sent a line over 1 MiB".into());
                }
            }
            Ok(None) => break,
            Err(e) => return hooks.closed(e.to_string()),
        }
    }
    conn.close(VarInt::from_u32(CLOSE_NORMAL), b"control stream ended");
    hooks.closed("the island ended the session".into());
}

/// read_line's error when the stream ends before a whole line.
const ENDED_EARLY: &str = "the stream ended before its line";

/// One line (without its newline) and whatever was read past it.
async fn read_line(recv: &mut RecvStream, max: usize) -> Result<(String, Vec<u8>), String> {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        if let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let rest = buf.split_off(pos + 1);
            buf.pop();
            return Ok((String::from_utf8_lossy(&buf).into_owned(), rest));
        }
        if buf.len() >= max {
            return Err("line too long".into());
        }
        match recv.read(&mut chunk).await.map_err(|e| e.to_string())? {
            Some(n) => buf.extend_from_slice(&chunk[..n]),
            None => return Err(ENDED_EARLY.into()),
        }
    }
}

// ------------------------------------------------------------------ files

/// A file going to the PC: header written; bytes next, then `finish` for the PC's answer.
#[wasm_bindgen]
pub struct FileOut {
    send: Rc<RefCell<Option<SendStream>>>,
    recv: Rc<RefCell<Option<RecvStream>>>,
}

#[wasm_bindgen]
impl FileOut {
    /// Writes the next piece (resolves once it's queued in QUIC's send window).
    pub fn write(&self, chunk: Vec<u8>) -> Promise {
        let send = self.send.clone();
        future_to_promise(async move {
            let mut s = send.borrow_mut().take().ok_or_else(|| js_val("the file stream is busy or done"))?;
            let r = s.write_all(&chunk).await;
            *send.borrow_mut() = Some(s);
            r.map_err(js_val)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Ends the upload and resolves with the PC's one-line answer (`file-ok` / `file-error`).
    pub fn finish(&self) -> Promise {
        let (send, recv) = (self.send.clone(), self.recv.clone());
        future_to_promise(async move {
            let mut s = send.borrow_mut().take().ok_or_else(|| js_val("the file stream is busy or done"))?;
            s.finish().map_err(js_val)?;
            let mut r = recv.borrow_mut().take().ok_or_else(|| js_val("the file stream is done"))?;
            let (line, _) = read_line(&mut r, MAX_FILE_LINE).await.map_err(js_val)?;
            Ok(JsValue::from_str(&line))
        })
    }

    pub fn abort(&self) {
        if let Some(mut s) = self.send.borrow_mut().take() {
            let _ = s.reset(VarInt::from_u32(1));
        }
        if let Some(mut r) = self.recv.borrow_mut().take() {
            let _ = r.stop(VarInt::from_u32(1));
        }
    }
}

/// A file coming from the PC: read it piece by piece (nothing is kept here), then `reply`.
#[wasm_bindgen]
pub struct FileIn {
    recv: Rc<RefCell<Option<RecvStream>>>,
    send: Rc<RefCell<Option<SendStream>>>,
    /// The body's first bytes, read along with the header line.
    head: Rc<RefCell<Vec<u8>>>,
    left: Rc<Cell<u64>>,
}

#[wasm_bindgen]
impl FileIn {
    /// The next piece, or undefined once all `size` bytes are in; rejects if the stream breaks,
    /// ends early or carries more than its header said.
    pub fn read(&self) -> Promise {
        let (recv, head, left) = (self.recv.clone(), self.head.clone(), self.left.clone());
        future_to_promise(async move {
            let first = std::mem::take(&mut *head.borrow_mut());
            if !first.is_empty() {
                left.set(left.get() - first.len() as u64);
                return Ok(Uint8Array::from(&first[..]).into());
            }
            let mut r = recv.borrow_mut().take().ok_or_else(|| js_val("the file stream is busy or done"))?;
            let mut chunk = vec![0u8; 64 * 1024];
            let got = r.read(&mut chunk).await;
            *recv.borrow_mut() = Some(r);
            match got.map_err(js_val)? {
                Some(n) if n as u64 > left.get() => Err(js_val("the file is longer than its header said")),
                Some(n) => {
                    left.set(left.get() - n as u64);
                    Ok(Uint8Array::from(&chunk[..n]).into())
                }
                None if left.get() == 0 => Ok(JsValue::UNDEFINED),
                None => Err(js_val("the file was cut short")),
            }
        })
    }

    /// Answers the PC with one line and ends the stream.
    pub fn reply(&self, line: String) -> Promise {
        let (send, recv) = (self.send.clone(), self.recv.clone());
        future_to_promise(async move {
            if let Some(mut r) = recv.borrow_mut().take() {
                let _ = r.stop(VarInt::from_u32(CLOSE_NORMAL));
            }
            let mut s = send.borrow_mut().take().ok_or_else(|| js_val("already answered"))?;
            s.write_all(format!("{}\n", line.trim_end()).as_bytes()).await.map_err(js_val)?;
            let _ = s.finish();
            Ok(JsValue::UNDEFINED)
        })
    }
}

async fn accept_files(conn: Connection, hooks: Rc<Hooks>) {
    while let Ok((send, mut recv)) = conn.accept_bi().await {
        let hooks = hooks.clone();
        spawn_local(async move {
            let Ok((header, head)) = read_line(&mut recv, MAX_FILE_LINE).await else {
                let _ = recv.stop(VarInt::from_u32(1));
                return;
            };
            let v: Value = serde_json::from_str(&header).unwrap_or(Value::Null);
            let id = v["id"].as_str().unwrap_or("").to_string();
            let size = v["size"].as_u64();
            let cb = hooks.file.borrow().clone();
            let refuse = match (size, &cb) {
                _ if v["t"] != "file" => Some("not a file"),
                (None, _) => Some("no size"),
                (Some(s), _) if s > MAX_DOWNLOAD => Some("too big for a phone (200 MB at most)"),
                (Some(s), _) if head.len() as u64 > s => Some("longer than its header said"),
                (_, None) => Some("this page isn't taking files"),
                _ => None,
            };
            if let (None, Some(size), Some(cb)) = (refuse, size, cb) {
                let file = FileIn { recv: Rc::new(RefCell::new(Some(recv))), send: Rc::new(RefCell::new(Some(send))), head: Rc::new(RefCell::new(head)), left: Rc::new(Cell::new(size)) };
                let _ = cb.call2(&JsValue::NULL, &JsValue::from_str(&header), &file.into());
            } else {
                let _ = recv.stop(VarInt::from_u32(1));
                let mut send = send;
                let line = json!({ "t": "file-error", "id": id, "error": refuse.unwrap_or("refused") });
                let _ = send.write_all(format!("{line}\n").as_bytes()).await;
                let _ = send.finish();
            }
        });
    }
}

// ------------------------------------------------------------------ terminals

/// The JS side of one terminal stream. Frames that arrive before `onFrame` is set wait in `pending`.
#[derive(Default)]
struct TermHooks {
    frame: RefCell<Option<Function>>,
    ended: RefCell<Option<Function>>,
    pending: RefCell<Vec<(u8, Vec<u8>)>>,
    /// Set once the stream is over (or closed from this side): nothing more goes to JS.
    ended_why: RefCell<Option<String>>,
    /// The `ended` callback has been given (or never will be: closed from this side).
    told: Cell<bool>,
}

impl TermHooks {
    fn frame(&self, kind: u8, payload: Vec<u8>) {
        if self.ended_why.borrow().is_some() {
            return;
        }
        let cb = self.frame.borrow().clone();
        match cb {
            Some(cb) => {
                let _ = cb.call2(&JsValue::NULL, &JsValue::from(kind), &Uint8Array::from(&payload[..]).into());
            }
            None => self.pending.borrow_mut().push((kind, payload)),
        }
    }

    /// The first reason wins; JS hears it after the frames that came before it.
    fn ended(&self, why: String) {
        if self.ended_why.borrow().is_some() {
            return;
        }
        *self.ended_why.borrow_mut() = Some(why.clone());
        let cb = self.ended.borrow().clone();
        if let Some(cb) = cb {
            self.told.set(true);
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&why));
        }
    }
}

/// A terminal on the PC, on a stream of its own (frames.rs). It keeps running on the PC when
/// this stream closes.
#[wasm_bindgen]
pub struct Term {
    reply: String,
    /// Frames to the PC, written in order; None once closed (or refused).
    out: RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    /// Wakes the reader to stop.
    stop: Rc<Notify>,
    hooks: Rc<TermHooks>,
}

#[wasm_bindgen]
impl Term {
    /// The PC's answer line: `term-ok` (frames follow) or `term-error` (the stream is over).
    pub fn reply(&self) -> String {
        self.reply.clone()
    }

    /// `frame(kind, bytes)` for every frame from the PC, then `ended(why)` once when the stream
    /// is over (never after close); what came before this call is given now.
    #[wasm_bindgen(js_name = onFrame)]
    pub fn on_frame(&self, frame: Function, ended: Function) {
        if self.hooks.told.get() {
            return;
        }
        *self.hooks.frame.borrow_mut() = Some(frame.clone());
        *self.hooks.ended.borrow_mut() = Some(ended.clone());
        let pending = std::mem::take(&mut *self.hooks.pending.borrow_mut());
        for (kind, payload) in pending {
            // A callback may close it.
            if self.hooks.told.get() {
                return;
            }
            let _ = frame.call2(&JsValue::NULL, &JsValue::from(kind), &Uint8Array::from(&payload[..]).into());
        }
        let why = self.hooks.ended_why.borrow().clone();
        if let (Some(why), false) = (why, self.hooks.told.get()) {
            self.hooks.told.set(true);
            let _ = ended.call1(&JsValue::NULL, &JsValue::from_str(&why));
        }
    }

    /// Queues a frame to the PC; data longer than a frame goes as several. False (nothing sent)
    /// if another kind is over 64 KiB or the stream is done.
    pub fn send(&self, kind: u8, payload: Vec<u8>) -> bool {
        let bytes = if kind == frames::DATA { Some(frames::encode_data(&payload)) } else { frames::encode(kind, &payload) };
        let (Some(bytes), Some(out)) = (bytes, self.out.borrow().clone()) else { return false };
        bytes.is_empty() || out.send(bytes).is_ok()
    }

    /// Finishes this side once what's queued is written, and stops reading: no callbacks after
    /// this. The terminal keeps running on the PC.
    pub fn close(&self) {
        self.out.borrow_mut().take();
        if self.hooks.ended_why.borrow().is_none() {
            *self.hooks.ended_why.borrow_mut() = Some("closed by this phone".into());
        }
        self.hooks.told.set(true);
        self.hooks.frame.borrow_mut().take();
        self.hooks.ended.borrow_mut().take();
        self.hooks.pending.borrow_mut().clear();
        self.stop.notify_one();
    }
}

async fn write_frames(mut send: SendStream, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(bytes) = rx.recv().await {
        if send.write_all(&bytes).await.is_err() {
            return;
        }
    }
    let _ = send.finish();
}

/// Frames from the PC to the hooks, starting with `head` (read along with the answer line).
async fn read_frames(mut recv: RecvStream, head: Vec<u8>, stop: Rc<Notify>, hooks: Rc<TermHooks>) {
    let mut frames = frames::Decoder::default();
    frames.push(&head);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        loop {
            match frames.next() {
                Ok(Some((kind, payload))) => hooks.frame(kind, payload),
                Ok(None) => break,
                Err(frames::TooLong(_)) => {
                    let _ = recv.stop(VarInt::from_u32(1));
                    return hooks.ended("the PC sent a frame over 64 KiB".into());
                }
            }
        }
        // Closed from this side (from a frame callback, say): stop now, even with more waiting.
        if hooks.ended_why.borrow().is_some() {
            let _ = recv.stop(VarInt::from_u32(CLOSE_NORMAL));
            return;
        }
        let read = n0_future::future::or(
            async {
                stop.notified().await;
                None
            },
            async { Some(recv.read(&mut chunk).await) },
        )
        .await;
        match read {
            None => {
                let _ = recv.stop(VarInt::from_u32(CLOSE_NORMAL));
                return;
            }
            Some(Ok(Some(n))) => frames.push(&chunk[..n]),
            Some(Ok(None)) if frames.pending() > 0 => return hooks.ended("the PC cut a frame short".into()),
            Some(Ok(None)) => return hooks.ended("the PC ended the terminal stream".into()),
            Some(Err(e)) => return hooks.ended(e.to_string()),
        }
    }
}
