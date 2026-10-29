// Island on your phone: the phone website shows the island live and controls it from anywhere
// (design: docs/superpowers/specs/2026-10-22-island-phone-design.md; the shared contract:
// src/remote/protocol.ts). This is the island's end of the connection.
//
// It has an iroh endpoint of its own (its own key, `<data dir>/phone-endpoint.key`; n0's relays,
// like Land anywhere), so phones work with Land anywhere off and Land's rules stay untouched. The
// endpoint runs while a phone is paired or being paired. Any key may connect on `island-phone/1`:
// the phone opens a control stream whose first line pairs (with the one-time code from the QR
// code) or says hi (a key in `<data dir>/phones.json`); anything else is closed within 10 s.
// After that each line is one JSON object: Rust answers pings, keeps push subscriptions and
// answers about terminals, and hands every other line to the island's TypeScript as
// `remote-msg`. Files and terminals (terms.rs) each get a stream of their own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iroh::Endpoint;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::time::timeout;

use crate::anywhere::Relays;
use crate::land::Emit;
use crate::term::{TermInfo, Terms};

mod files;
mod lines;
mod net;
mod pair;
mod push;
mod session;
mod store;
mod terms;
#[cfg(test)]
mod tests;

use lines::{kind_of, line, Line};
use pair::Pairing;
use session::Session;
use store::{clean_phone_name, Store};

/// The phone's protocol (ALPN), the only one this endpoint speaks.
pub const ALPN: &[u8] = b"island-phone/1";
/// The protocol version this build speaks.
pub const PROTOCOL_V: u64 = 1;
/// One control line, its newline included, is at most this many bytes.
pub const MAX_LINE: usize = 1024 * 1024;
/// A pairing code works this long.
pub const PAIR_FOR: Duration = Duration::from_secs(10 * 60);
/// Where the phone website lives, when the island doesn't say.
const PHONE_SITE: &str = "https://islandphone.vercel.app";
/// How long a pairing waits for the endpoint to reach its home relay before making the code.
const ONLINE_WAIT: Duration = Duration::from_secs(5);
/// Lines waiting their turn for one phone (pills and views don't count); more and it is too
/// slow to keep.
const OUTBOX_CAP: usize = 256;
/// How long a removed phone gets to hear "bye".
const BYE_WAIT: Duration = Duration::from_secs(5);

// Why the island closed a connection (QUIC application close codes).
const CLOSE_DONE: u32 = 0;
const CLOSE_BAD: u32 = 400;
const CLOSE_DENIED: u32 = 403;
const CLOSE_SILENT: u32 = 408;
const CLOSE_REPLACED: u32 = 409;
const CLOSE_REMOVED: u32 = 410;
const CLOSE_TOO_LONG: u32 = 413;
const CLOSE_TOO_SLOW: u32 = 429;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where the remote keeps its things and how it reaches phones.
pub struct Config {
    /// Where phones.json and the keys are.
    pub dir: PathBuf,
    /// Where files from phones go (None: the user's Downloads, looked up each time).
    pub downloads: Option<PathBuf>,
    /// The computer's name the phones show (None: the system's, looked up when needed).
    pub name: Option<String>,
    pub relays: Relays,
    pub pair_for: Duration,
}

impl Config {
    pub fn live() -> Config {
        Config { dir: crate::log::data_dir(), downloads: None, name: None, relays: Relays::N0, pair_for: PAIR_FOR }
    }
}

/// A pairing code to show: its address, the QR code of it, and when it stops working.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub url: String,
    /// `size` modules a side, row by row, '1' for dark (like Land's share).
    pub qr: String,
    pub size: usize,
    /// ms since 1970.
    pub expires: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneInfo {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: u64,
    pub connected: bool,
    /// Whether it has a Web Push subscription.
    pub push: bool,
}

pub struct Remote {
    cfg: Config,
    emit: Emit,
    store: Mutex<Store>,
    pairing: Mutex<Option<Pairing>>,
    pair_seq: AtomicU64,
    /// The connected phones, by key.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    session_seq: AtomicU64,
    net: tokio::sync::Mutex<Option<Endpoint>>,
    /// The VAPID key, once loaded (push.rs).
    vapid: Mutex<Option<Arc<ring::signature::EcdsaKeyPair>>>,
    /// This computer's terminals (src/term), and whether phones may have them (terms.rs).
    terms: Arc<Terms>,
    term_allowed: AtomicBool,
}

impl Remote {
    pub fn new(cfg: Config, emit: Emit, terms: Arc<Terms>) -> Arc<Remote> {
        let store = Store::load(cfg.dir.join("phones.json"));
        let remote = Arc::new(Remote {
            cfg,
            emit,
            store: Mutex::new(store),
            pairing: Mutex::new(None),
            pair_seq: AtomicU64::new(0),
            sessions: Mutex::new(HashMap::new()),
            session_seq: AtomicU64::new(0),
            net: tokio::sync::Mutex::new(None),
            vapid: Mutex::new(None),
            terms: terms.clone(),
            term_allowed: AtomicBool::new(false),
        });
        // Every phone hears the terminal list when it changes.
        let weak = Arc::downgrade(&remote);
        terms.listen(Arc::new(move |list: &[TermInfo]| {
            if let Some(remote) = weak.upgrade() {
                remote.send_terms(None, list);
            }
        }));
        remote
    }

    fn name(&self) -> String {
        self.cfg.name.clone().unwrap_or_else(crate::land::share::computer_name)
    }

    fn save(&self, store: &Store) {
        if let Err(e) = store.save() {
            crate::log::line(format!("remote: cannot save phones: {e}"));
        }
    }

    pub fn phones(&self) -> Vec<PhoneInfo> {
        let connected: HashSet<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        let store = self.store.lock().unwrap();
        store
            .phones()
            .iter()
            .map(|p| PhoneInfo { id: p.id.clone(), name: p.name.clone(), paired_at: p.paired_at, last_seen: p.last_seen, connected: connected.contains(&p.id), push: p.push.is_some() })
            .collect()
    }

    fn emit_phones(&self) {
        (self.emit)("remote-phones", json!(self.phones()));
    }

    fn seen(&self, id: &str) {
        let mut store = self.store.lock().unwrap();
        if store.seen(id, now_ms()) {
            self.save(&store);
        }
    }

    /// A phone's `push-sub` line: its subscription, or null to drop it.
    fn set_push(&self, id: &str, sub: Option<&Value>) {
        let sub = match sub {
            None | Some(Value::Null) => None,
            Some(v) => match store::read_push_sub(v) {
                Some(s) => Some(s),
                None => return,
            },
        };
        let changed = {
            let mut store = self.store.lock().unwrap();
            let changed = store.set_push(id, sub);
            if changed {
                self.save(&store);
            }
            changed
        };
        if changed {
            self.emit_phones();
        }
    }

    pub fn rename(&self, id: &str, name: &str) -> bool {
        let renamed = {
            let mut store = self.store.lock().unwrap();
            let renamed = store.rename(id, name);
            if renamed {
                self.save(&store);
            }
            renamed
        };
        if renamed {
            self.emit_phones();
        }
        renamed
    }

    /// Sends one line to a phone, or to every connected phone (None). False when it reached
    /// none, isn't a JSON object, or is longer than MAX_LINE.
    pub fn send(&self, phone: Option<&str>, msg: &Value) -> bool {
        if !msg.is_object() {
            return false;
        }
        let l = line(msg);
        if l.len() > MAX_LINE {
            return false;
        }
        let kind = kind_of(msg);
        let targets: Vec<Arc<Session>> = {
            let sessions = self.sessions.lock().unwrap();
            match phone {
                Some(id) => sessions.get(id).cloned().into_iter().collect(),
                None => sessions.values().cloned().collect(),
            }
        };
        let mut sent = false;
        for s in targets {
            sent |= s.send(kind, l.clone());
        }
        sent
    }

    /// Forgets a phone: it hears "bye", its connection closes, and it has to pair again.
    pub async fn forget(self: &Arc<Self>, id: &str) -> bool {
        let removed = {
            let mut store = self.store.lock().unwrap();
            let removed = store.remove(id);
            if removed {
                self.save(&store);
            }
            removed
        };
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(s) = &session {
            s.end(Some(line(&json!({ "t": "bye", "why": "removed" }))), CLOSE_REMOVED, b"removed");
            let _ = timeout(BYE_WAIT, s.conn.closed()).await;
        }
        if removed || session.is_some() {
            crate::log::line("remote: a phone was removed");
            self.emit_phones();
        }
        self.settle().await;
        removed
    }

    // -------------------------------------------------------------- pairing

    /// A new one-time code (the last one stops working) and the QR code a phone scans.
    pub async fn pair_start(self: &Arc<Self>, site: &str) -> Result<PairInfo, String> {
        let code = pair::new_code()?;
        let seq = self.pair_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let expires = now_ms() + self.cfg.pair_for.as_millis() as u64;
        // Waiting before the endpoint starts, so nothing stops it meanwhile.
        *self.pairing.lock().unwrap() = Some(Pairing::new(code.clone(), Instant::now(), self.cfg.pair_for, seq));
        let ep = match self.ensure_net().await {
            Ok(ep) => ep,
            Err(e) => {
                self.end_pairing(seq);
                return Err(e);
            }
        };
        // Its home relay goes in the code; the first time it takes a few seconds to pick one.
        let _ = timeout(ONLINE_WAIT, ep.online()).await;
        let relays = net::browser_relays(&ep);
        let payload = pair::payload(&ep.id().to_string(), &relays, &code, &pair::payload_name(&self.name()));
        let url = pair::url(site, &payload);
        let (size, qr) = match crate::land::share::qr(&url) {
            Ok(q) => q,
            Err(e) => {
                self.end_pairing(seq);
                return Err(e);
            }
        };
        let weak = Arc::downgrade(self);
        let valid = self.cfg.pair_for;
        tokio::spawn(async move {
            tokio::time::sleep(valid).await;
            if let Some(remote) = weak.upgrade() {
                if remote.end_pairing(seq) {
                    remote.settle().await;
                }
            }
        });
        crate::log::line(format!("remote: pairing code ready ({} relays)", relays.len()));
        Ok(PairInfo { url, qr, size, expires })
    }

    /// Ends pairing `seq` if it is still the one waiting; true when it was.
    fn end_pairing(&self, seq: u64) -> bool {
        let mut slot = self.pairing.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.seq == seq) {
            *slot = None;
            return true;
        }
        false
    }

    pub async fn pair_stop(self: &Arc<Self>) {
        *self.pairing.lock().unwrap() = None;
        self.settle().await;
    }

    // -------------------------------------------------------------- the endpoint

    /// The endpoint, started if it isn't running.
    async fn ensure_net(self: &Arc<Self>) -> Result<Endpoint, String> {
        let mut slot = self.net.lock().await;
        if let Some(ep) = slot.as_ref().filter(|ep| !ep.is_closed()) {
            return Ok(ep.clone());
        }
        let file = self.cfg.dir.join("phone-endpoint.key");
        let key = tokio::task::spawn_blocking(move || crate::anywhere::load_or_create_key(&file))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "Island can't save the key phones reach it with.".to_string())?;
        let ep = net::bind(key, &self.cfg.relays).await?;
        tokio::spawn(net::accept_loop(ep.clone(), Arc::downgrade(self)));
        crate::log::line(format!("remote: on as {}", ep.id().fmt_short()));
        *slot = Some(ep.clone());
        Ok(ep)
    }

    /// Stops the endpoint when no phone is paired and none is pairing.
    async fn settle(&self) {
        let mut slot = self.net.lock().await;
        let idle = self.store.lock().unwrap().is_empty() && self.pairing.lock().unwrap().is_none();
        if idle {
            if let Some(ep) = slot.take() {
                ep.close().await;
                crate::log::line("remote: off (no phones)");
            }
        }
    }

    /// At start: the endpoint runs when a phone is paired.
    pub async fn start_if_paired(self: &Arc<Self>) {
        if self.store.lock().unwrap().is_empty() {
            return;
        }
        if let Err(e) = self.ensure_net().await {
            crate::log::line(format!("remote: {e}"));
        }
    }

    #[cfg(test)]
    async fn running(&self) -> bool {
        self.net.lock().await.as_ref().is_some_and(|ep| !ep.is_closed())
    }

    #[cfg(test)]
    async fn endpoint(&self) -> Option<Endpoint> {
        self.net.lock().await.clone()
    }

    #[cfg(test)]
    async fn close(&self) {
        if let Some(ep) = self.net.lock().await.take() {
            ep.close().await;
        }
    }
}

// ------------------------------------------------------------------ commands

/// The remote, once the app's setup made it.
#[derive(Default)]
pub struct RemoteState(OnceLock<Arc<Remote>>);

impl RemoteState {
    fn get(&self) -> Option<Arc<Remote>> {
        self.0.get().cloned()
    }
}

fn remote_of(app: &tauri::AppHandle) -> Option<Arc<Remote>> {
    use tauri::Manager;
    app.state::<RemoteState>().get()
}

fn not_ready() -> String {
    "Island is still starting. Try again in a moment.".into()
}

/// Makes the remote (events: `remote-phones` and `remote-paired` to every window, the rest to
/// the island) and starts its endpoint when a phone is paired, without holding up the start.
pub fn setup(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let handle = app.clone();
    let emit: Emit = Arc::new(move |event: &str, payload: Value| {
        let _ = match event {
            "remote-phones" | "remote-paired" => handle.emit(event, payload),
            _ => handle.emit_to(crate::overlay::LABEL, event, payload),
        };
    });
    let terms = app.state::<crate::term::TermState>().0.clone();
    let remote = Remote::new(Config::live(), emit, terms);
    if app.state::<RemoteState>().0.set(remote.clone()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move { remote.start_if_paired().await });
}

/// A new pairing code for `site` (the phone website's address): `{url, qr, size, expires}`.
#[tauri::command]
pub async fn remote_pair_start(app: tauri::AppHandle, site: String) -> Result<PairInfo, String> {
    remote_of(&app).ok_or_else(not_ready)?.pair_start(&site).await
}

#[tauri::command]
pub async fn remote_pair_stop(app: tauri::AppHandle) {
    if let Some(r) = remote_of(&app) {
        r.pair_stop().await;
    }
}

#[tauri::command]
pub fn remote_phones(state: tauri::State<'_, RemoteState>) -> Vec<PhoneInfo> {
    state.get().map(|r| r.phones()).unwrap_or_default()
}

#[tauri::command]
pub fn remote_rename(state: tauri::State<'_, RemoteState>, id: String, name: String) -> bool {
    state.get().is_some_and(|r| r.rename(&id, &name))
}

#[tauri::command]
pub async fn remote_forget(app: tauri::AppHandle, id: String) -> bool {
    match remote_of(&app) {
        Some(r) => r.forget(&id).await,
        None => false,
    }
}

/// One line to a phone (`phone`: its id), or to every connected phone (null).
#[tauri::command]
pub fn remote_send(state: tauri::State<'_, RemoteState>, phone: Option<String>, msg: Value) -> bool {
    state.get().is_some_and(|r| r.send(phone.as_deref(), &msg))
}

/// Sends a file (at most 200 MB) to a connected phone: the name the phone kept it under.
#[tauri::command]
pub async fn remote_send_file(app: tauri::AppHandle, phone: String, path: String) -> Result<String, String> {
    remote_of(&app).ok_or_else(not_ready)?.send_file(&phone, Path::new(&path)).await
}

/// The key phones subscribe to pushes with (`applicationServerKey`): base64url of the
/// uncompressed P-256 point; empty if Island can't make it.
#[tauri::command]
pub fn remote_vapid(state: tauri::State<'_, RemoteState>) -> String {
    match state.get().map(|r| r.vapid()) {
        Some(Ok(key)) => key,
        Some(Err(e)) => {
            crate::log::line(format!("remote: {e}"));
            String::new()
        }
        None => String::new(),
    }
}

/// A notification to every phone with a push subscription: how many push services took it.
#[tauri::command]
pub async fn remote_push(app: tauri::AppHandle, title: String, body: String, tag: Option<String>, open: Option<String>, urgent: bool) -> usize {
    match remote_of(&app) {
        Some(r) => r.push(&title, &body, tag.as_deref(), open.as_deref(), urgent).await,
        None => 0,
    }
}

/// The computer's name as phones see it (works with Land off).
#[tauri::command]
pub fn remote_name(state: tauri::State<'_, RemoteState>) -> String {
    state.get().map(|r| r.name()).unwrap_or_else(crate::land::share::computer_name)
}

/// Whether paired phones may open terminals on this computer (Settings › Your phone › Terminal
/// from your phone, and Windows Hello not asked before Allow). Off at start; the island says
/// at boot and on every change. Off lets go of every terminal a phone shows.
#[tauri::command]
pub fn remote_term_allow(state: tauri::State<'_, RemoteState>, on: bool) {
    if let Some(r) = state.get() {
        r.term_allow(on);
    }
}
