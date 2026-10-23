// Land: Island's file sharing between computers on the same network, like AirDrop.
//
// Finding each other. Every Island with Land on listens on UDP 47821 (the multicast
// group 239.255.77.77 and broadcast) and says who it is in a small JSON packet: its
// name, its system, the TCP port it takes files on and its public key. "ask" gets an
// answer from everyone who can receive, "here" announces (at start and every 30 s),
// "bye" says it is leaving. Packets only go to the multicast group (TTL 1) and to each
// interface's own broadcast address, and connections are only made to and taken from
// addresses on one of this computer's subnets, so nothing crosses a router.
//
// Sending. The sender connects over TCP and both sides run a Noise XX handshake
// (X25519, ChaCha20-Poly1305, BLAKE2s): everything after it is encrypted and
// authenticated, and each side learns the other's public key. The sender checks it is
// the key the device announced. It then offers the files (names and sizes); the
// receiving user accepts or declines, and nothing is written before that. The files
// then stream in 60 KB frames. The receiver writes `<name>.landing` files in Downloads
// and gives them their real names only when every byte is in, without ever replacing
// a file that is already there.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use iroh::endpoint::{Connection, VarInt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;

mod discovery;
mod files;
mod place;
mod receive;
mod send;
pub(crate) mod share;
#[cfg(test)]
mod tests;
mod transfer;
mod wire;

pub(crate) use discovery::{clean_name, clean_os};
use discovery::*;
use files::*;
use place::*;
use transfer::*;
use wire::*;

pub const DISCOVERY_PORT: u16 = 47821;
const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
const NOISE: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"island-land/1";
/// File bytes per encrypted frame (a Noise message holds at most 65 535 bytes).
const CHUNK: usize = 60 * 1024;
pub const MAX_FILES: usize = 10_000;
const MAX_DEPTH: usize = 32;
const MAX_JSON: usize = 4 * 1024 * 1024;
const ANNOUNCE_EVERY: Duration = Duration::from_secs(30);
const PEER_TTL: Duration = Duration::from_secs(95);
/// How long the receiving user has to accept.
pub const ASK_FOR: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
/// Offers waiting for an answer at once; more are told "busy".
const MAX_ASKING: usize = 3;
/// After a decline, the same device's next offers are turned away this long (no prompt spam).
const DECLINE_QUIET: Duration = Duration::from_secs(15);
/// Room left on the disk after an accepted transfer.
const SPARE_BYTES: u64 = 64 * 1024 * 1024;
/// Dropped items listed in a transfer's events (the count and total cover them all).
const LISTED: usize = 20;

// The first byte of every decrypted frame.
const F_JSON_PART: u8 = 1;
const F_JSON: u8 = 2;
const F_DATA: u8 = 3;

/// Noise's largest message and its authentication tag.
const NOISE_MAX: usize = 65_535;
const NOISE_TAG: usize = 16;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// An id short enough for the log (a friend's is a 64-character key).
fn short(id: &str) -> &str {
    &id[..id.len().min(16)]
}

fn noise_params() -> snow::params::NoiseParams {
    NOISE.parse().expect("a valid Noise pattern")
}

// ------------------------------------------------------------------ the running service

#[derive(Clone, Debug)]
struct Peer {
    info: PeerInfo,
    addr: SocketAddr,
    key: Vec<u8>,
    seen: Instant,
}

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// How long Land keeps trying after a connection drops, and keeps the pieces of a dropped receive.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// The sender's first try again comes after this; each next waits twice as long, up to `retry_max`.
    pub retry_first: Duration,
    pub retry_max: Duration,
    /// The sender gives up after trying this long.
    pub retry_for: Duration,
    /// The receiver keeps a dropped transfer's pieces this long, for the sender to come back.
    pub pause_keep: Duration,
    /// Reaching a friend on another network: the key lookup and a relay can take a while.
    pub far_connect: Duration,
    /// A send to a friend who is away tries again this often (and at once when they say hello)...
    pub queue_retry: Duration,
    /// ...for this long, then gives up.
    pub queue_for: Duration,
    /// Land says hello to its friends this long after it starts (time to reach a relay first).
    pub hello_after: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            retry_first: Duration::from_secs(2),
            retry_max: Duration::from_secs(300),
            retry_for: Duration::from_secs(30 * 60),
            pause_keep: Duration::from_secs(2 * 3600),
            far_connect: Duration::from_secs(20),
            queue_retry: Duration::from_secs(120),
            queue_for: Duration::from_secs(3 * 24 * 3600),
            hello_after: Duration::from_secs(5),
        }
    }
}

pub struct Options {
    pub name: String,
    /// Take files (listen and announce); off still lets this device send.
    pub visible: bool,
    pub downloads: PathBuf,
    /// UDP port for finding devices; 0 turns discovery off (tests).
    pub discovery: u16,
    /// Friends on other networks (src/anywhere.rs); None leaves it off.
    pub anywhere: Option<crate::anywhere::Setup>,
}

pub struct Running {
    me: Identity,
    name: Mutex<String>,
    pub visible: bool,
    pub port: u16,
    discovery: u16,
    downloads: PathBuf,
    udp: Option<Arc<UdpSocket>>,
    nets: Mutex<Vec<Net>>,
    peers: Mutex<HashMap<String, Peer>>,
    asks: Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>,
    cancels: Mutex<HashMap<String, watch::Sender<bool>>>,
    replied: Mutex<HashMap<IpAddr, Instant>>,
    /// Devices whose offer this user declined, and when.
    declined: Mutex<HashMap<String, Instant>>,
    shouting: tokio::sync::Mutex<()>,
    stop: watch::Sender<bool>,
    emit: Emit,
    seq: AtomicU64,
    /// Whether Land anywhere was asked for, and its endpoint when it started.
    pub anywhere: bool,
    far: Option<Arc<crate::anywhere::Far>>,
    timing: Mutex<Timing>,
    /// Accepted transfers whose connection dropped, by sender and transfer (`resume_key`).
    paused: Mutex<HashMap<String, Paused>>,
    /// Paused transfers this user cancelled: their comeback is turned away, and when.
    refused_resume: Mutex<HashMap<String, Instant>>,
    /// Sends waiting for friends who are away, and where they are kept (with Land anywhere on).
    waiting: Mutex<Vec<Waiting>>,
    queue_file: Option<PathBuf>,
    /// What wakes the sends waiting for each friend (by key).
    kicks: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    /// Computers found at this place over the internet (place.rs), its topic, and when this
    /// Island last asked there and last answered.
    place: Mutex<HashMap<String, PlacePeer>>,
    place_topic: Mutex<Option<String>>,
    place_asked: Mutex<Option<Instant>>,
    place_answered: Mutex<Option<Instant>>,
    /// Tests: the next send loses its connection after this many bytes (0: never).
    #[cfg(test)]
    cut: AtomicU64,
}

pub async fn start(me: Identity, opts: Options, emit: Emit) -> Result<Arc<Running>, String> {
    let listener = if opts.visible {
        Some(TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|e| format!("Land cannot take files: {e}"))?)
    } else {
        None
    };
    let port = listener.as_ref().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);
    let udp = if opts.discovery > 0 {
        match bind_udp(opts.discovery) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                // Something else holds the port: asking still works, answers come back to any port.
                crate::log::line(format!("land: discovery port {} taken ({e}), asking only", opts.discovery));
                bind_udp(0).ok().map(Arc::new)
            }
        }
    } else {
        None
    };
    let anywhere = opts.anywhere.is_some();
    // Sends that waited for friends when Land last stopped, kept next to the friends.
    let queue_file = opts.anywhere.as_ref().map(|s| s.book.with_file_name("land-queue.json"));
    let waiting: Vec<Waiting> = queue_file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let far = match opts.anywhere {
        Some(s) => match crate::anywhere::Far::start(s.key, s.relays, s.book, &opts.name, emit.clone(), ASK_FOR).await {
            Ok(f) => Some(f),
            Err(e) => {
                crate::log::line(format!("land: {e}"));
                None
            }
        },
        None => None,
    };
    let (stop, _) = watch::channel(false);
    let run = Arc::new(Running {
        me,
        name: Mutex::new(clean_name(&opts.name)),
        visible: opts.visible,
        port,
        discovery: opts.discovery,
        downloads: opts.downloads,
        udp,
        nets: Mutex::new(networks()),
        peers: Mutex::new(HashMap::new()),
        asks: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
        replied: Mutex::new(HashMap::new()),
        declined: Mutex::new(HashMap::new()),
        shouting: tokio::sync::Mutex::new(()),
        stop,
        emit,
        seq: AtomicU64::new(0),
        anywhere,
        far,
        timing: Mutex::new(Timing::default()),
        paused: Mutex::new(HashMap::new()),
        refused_resume: Mutex::new(HashMap::new()),
        waiting: Mutex::new(waiting),
        queue_file,
        kicks: Mutex::new(HashMap::new()),
        place: Mutex::new(HashMap::new()),
        place_topic: Mutex::new(None),
        place_asked: Mutex::new(None),
        place_answered: Mutex::new(None),
        #[cfg(test)]
        cut: AtomicU64::new(0),
    });
    if let Some(l) = listener {
        tokio::spawn(run.clone().accept_loop(l));
    }
    if let Some(u) = run.udp.clone() {
        tokio::spawn(run.clone().listen_loop(u));
        tokio::spawn(run.clone().announce_loop());
    }
    // Islands at the same place whose Wi-Fi keeps devices apart: only with Land anywhere on.
    if run.far.is_some() && run.discovery > 0 {
        tokio::spawn(run.clone().place_loop());
    }
    // Friends' files from other networks; ends with the endpoint (or with Land).
    if let Some(mut conns) = run.far.as_ref().and_then(|f| f.land_connections()) {
        let weak = Arc::downgrade(&run);
        tokio::spawn(async move {
            while let Some(conn) = conns.recv().await {
                let Some(run) = weak.upgrade() else { break };
                tokio::spawn(run.receive_far(conn));
            }
        });
    }
    let far_note = run.far.as_ref().map(|f| format!(", anywhere as {}", f.id().fmt_short())).unwrap_or_default();
    crate::log::line(format!("land: on as {} ({}), {}{far_note}", run.name(), run.me.id, if run.visible { format!("taking files on {port}") } else { "not taking files".into() }));
    run.restore_waiting();
    // Hello to the friends, a moment after starting: their sends waiting for this Island go now,
    // and so do the ones here waiting for any of them who answers.
    if let Some(far) = run.far.clone() {
        let weak = Arc::downgrade(&run);
        tokio::spawn(async move {
            let Some(after) = weak.upgrade().map(|r| r.timing.lock().unwrap().hello_after) else { return };
            tokio::time::sleep(after).await;
            let online = far.online().await;
            let Some(run) = weak.upgrade() else { return };
            for id in online {
                run.kick(&id);
            }
        });
    }
    Ok(run)
}

impl Running {
    pub fn id(&self) -> &str {
        &self.me.id
    }

    pub fn name(&self) -> String {
        self.name.lock().unwrap().clone()
    }

    /// Land anywhere, when it is on.
    pub fn far(&self) -> Option<Arc<crate::anywhere::Far>> {
        self.far.clone()
    }

    /// The announcement: who this is, where it takes files, and its signed friend key.
    pub fn hello(&self, kind: &str) -> Hello {
        let mut h = Hello::new(kind, &self.me, &self.name(), self.port);
        if let Some(f) = &self.far {
            let (ak, aks) = f.claim(&self.me.public);
            h.ak = Some(ak);
            h.aks = Some(aks);
        }
        h
    }

    /// Asks a computer nearby that announced a friend key to be friends: no code needed.
    pub async fn befriend(&self, peer_id: &str) -> Result<crate::anywhere::Friend, String> {
        let far = self.far.clone().ok_or_else(|| "Turn on Friends on other networks first (Activities \u{203a} Land).".to_string())?;
        let key = self.peers.lock().unwrap().get(peer_id).and_then(|p| p.info.anywhere.clone());
        let key = key.or_else(|| self.place.lock().unwrap().get(peer_id).and_then(|p| p.info.anywhere.clone()));
        let key = key.ok_or_else(|| "That computer can't be added this way: it needs Island with Friends on other networks on.".to_string())?;
        let id: iroh::EndpointId = key.parse().map_err(|_| "That computer announced a damaged key.".to_string())?;
        far.ask(id).await
    }

    fn next_id(&self, dir: &str) -> String {
        format!("{dir}-{:x}-{}", now_ms(), self.seq.fetch_add(1, Ordering::Relaxed))
    }

    fn publish(&self, t: &Transfer) {
        if let Ok(v) = serde_json::to_value(t) {
            (self.emit)("land-transfer", v);
        }
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        let mut list: Vec<PeerInfo> = self.peers.lock().unwrap().values().map(|p| p.info.clone()).collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        list
    }

    fn emit_peers(&self) {
        (self.emit)("land-peers", json!(self.peers()));
    }

    #[cfg(test)]
    fn set_timing(&self, t: Timing) {
        *self.timing.lock().unwrap() = t;
    }

    /// Tests: the next send loses its connection after `bytes`, as if the network dropped.
    #[cfg(test)]
    fn cut_after(&self, bytes: u64) {
        self.cut.store(bytes, Ordering::Relaxed);
    }

    /// A device heard of some other way than the network (tests, and nothing else).
    #[cfg(test)]
    fn add_peer(&self, info: PeerInfo, addr: SocketAddr, key: Vec<u8>) {
        self.peers.lock().unwrap().insert(info.id.clone(), Peer { info, addr, key, seen: Instant::now() });
    }

    pub async fn rename(&self, name: &str) {
        let name = clean_name(name);
        if let Some(f) = &self.far {
            f.set_name(&name);
        }
        let changed = {
            let mut n = self.name.lock().unwrap();
            let changed = *n != name;
            *n = name;
            changed
        };
        if changed && self.visible {
            self.shout("here").await;
        }
    }

    /// Stops listening and announcing, says goodbye, and ends every transfer.
    pub async fn shutdown(&self) {
        if self.visible {
            self.shout("bye").await;
        }
        // send_replace: kept even when nothing listens yet (`send` would drop it), so a waiting
        // send can tell Land is stopping and stay on disk.
        self.stop.send_replace(true);
        for (_, (_, tx)) in self.asks.lock().unwrap().drain() {
            let _ = tx.send(false);
        }
        for c in self.cancels.lock().unwrap().values() {
            let _ = c.send(true);
        }
        if let Some(f) = &self.far {
            f.close().await;
        }
        // Pieces waiting for a sender to come back go with Land.
        self.paused.lock().unwrap().clear();
        crate::log::line("land: off");
    }

    // -------------------------------------------------------------- answering

    /// The user's answer to an offer. False when it is no longer waiting.
    pub fn answer(&self, id: &str, accept: bool) -> bool {
        match self.asks.lock().unwrap().remove(id) {
            Some((_, tx)) => tx.send(accept).is_ok(),
            None => false,
        }
    }

    /// Stops a transfer in either direction (an ask is declined).
    pub fn cancel(&self, id: &str) -> bool {
        if self.answer(id, false) {
            return true;
        }
        // A receive waiting for its sender to come back: the pieces go, and so does the comeback.
        let stopped = {
            let mut paused = self.paused.lock().unwrap();
            let key = paused.iter().find(|(_, p)| p.transfer.id == id).map(|(k, _)| k.clone());
            key.and_then(|k| paused.remove(&k).map(|p| (k, p)))
        };
        if let Some((key, p)) = stopped {
            self.refused_resume.lock().unwrap().insert(key, Instant::now());
            let mut t = p.transfer;
            t.state = "cancelled";
            t.error = Some("Cancelled.".into());
            self.publish(&t);
            return true;
        }
        match self.cancels.lock().unwrap().get(id) {
            Some(c) => c.send(true).is_ok(),
            None => false,
        }
    }
}

// ------------------------------------------------------------------ commands

#[derive(Default)]
pub struct LandState {
    run: tokio::sync::Mutex<Option<Arc<Running>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandInfo {
    id: String,
    name: String,
    visible: bool,
    peers: Vec<PeerInfo>,
    /// Land's first start on this computer (its key was just made): the island explains the
    /// firewall or local network question the system asks now.
    fresh: bool,
    /// Friends on other networks (empty while Land anywhere is off).
    friends: Vec<crate::anywhere::Friend>,
}

fn info(run: &Running, fresh: bool) -> LandInfo {
    let friends = run.far().map(|f| f.friends()).unwrap_or_default();
    LandInfo { id: run.id().into(), name: run.name(), visible: run.visible, peers: run.peers(), fresh, friends }
}

/// Turns Land on (or updates its name, its visibility, and whether friends on other networks
/// can reach it). Idempotent.
#[tauri::command]
pub async fn land_start(app: tauri::AppHandle, state: tauri::State<'_, LandState>, name: Option<String>, visible: bool, anywhere: Option<bool>) -> Result<LandInfo, String> {
    use tauri::Emitter;
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(computer_name);
    let anywhere = anywhere.unwrap_or(false);
    let mut slot = state.run.lock().await;
    if let Some(run) = slot.as_ref() {
        if run.visible == visible && run.anywhere == anywhere {
            run.rename(&name).await;
            return Ok(info(run, false));
        }
    }
    if let Some(old) = slot.take() {
        old.shutdown().await;
    }
    let key = crate::log::data_dir().join("land.key");
    let fresh = !key.exists();
    let me = tokio::task::spawn_blocking(move || Identity::load_or_create(&key)).await.map_err(|e| e.to_string())??;
    let emit: Emit = Arc::new(move |event: &str, payload: Value| {
        let _ = app.emit_to(crate::overlay::LABEL, event, payload);
    });
    let setup = if anywhere {
        let file = crate::anywhere::key_file();
        let key = tokio::task::spawn_blocking(move || crate::anywhere::load_or_create_key(&file)).await.map_err(|e| e.to_string())??;
        Some(crate::anywhere::Setup { key, relays: crate::anywhere::Relays::N0, book: crate::anywhere::book_file() })
    } else {
        None
    };
    let run = start(me, Options { name, visible, downloads: downloads_dir(), discovery: DISCOVERY_PORT, anywhere: setup }, emit).await?;
    let info = info(&run, fresh);
    *slot = Some(run);
    Ok(info)
}

/// This Island's Land code (works with Land off; the key is made on first use).
#[tauri::command]
pub async fn land_me() -> Result<crate::anywhere::Me, String> {
    tokio::task::spawn_blocking(crate::anywhere::me).await.map_err(|e| e.to_string())?
}

async fn far(state: &tauri::State<'_, LandState>) -> Option<Arc<crate::anywhere::Far>> {
    state.run.lock().await.as_ref().and_then(|r| r.far())
}

/// Friends on other networks; read from the file while Land anywhere is off.
#[tauri::command]
pub async fn land_friends(state: tauri::State<'_, LandState>) -> Result<Vec<crate::anywhere::Friend>, String> {
    match far(&state).await {
        Some(f) => Ok(f.friends()),
        None => Ok(crate::anywhere::Book::load(&crate::anywhere::book_file()).friends().to_vec()),
    }
}

/// The friends whose Island answers right now (each gets 3 s).
#[tauri::command]
pub async fn land_friends_online(state: tauri::State<'_, LandState>) -> Result<Vec<String>, String> {
    match far(&state).await {
        Some(f) => Ok(f.online().await),
        None => Ok(Vec::new()),
    }
}

/// Asks the Island whose code was pasted to be friends; resolves when its user answers.
#[tauri::command]
pub async fn land_friend_add(state: tauri::State<'_, LandState>, code: String) -> Result<crate::anywhere::Friend, String> {
    let id = crate::anywhere::parse_code(&code)?;
    let f = far(&state).await.ok_or_else(|| "Turn on Land and \u{201c}Friends on other networks\u{201d} first (Activities \u{203a} Land).".to_string())?;
    f.ask(id).await
}

/// Asks a computer nearby (by its Land id) to be friends, with the friend key it announced: no code needed.
#[tauri::command]
pub async fn land_friend_add_nearby(state: tauri::State<'_, LandState>, id: String) -> Result<crate::anywhere::Friend, String> {
    running(&state).await?.befriend(&id).await
}

/// The user's answer to a `land-friend-ask`: "add", "no" or "block".
#[tauri::command]
pub async fn land_friend_answer(state: tauri::State<'_, LandState>, id: String, reply: String) -> Result<bool, String> {
    let reply = match reply.as_str() {
        "add" => crate::anywhere::Reply::Add,
        "block" => crate::anywhere::Reply::Block,
        _ => crate::anywhere::Reply::No,
    };
    Ok(far(&state).await.is_some_and(|f| f.answer(&id, reply)))
}

/// Removes a friend (they are not told), or blocks them too.
#[tauri::command]
pub async fn land_friend_remove(state: tauri::State<'_, LandState>, id: String, block: bool) -> Result<(), String> {
    if let Some(f) = far(&state).await {
        if block {
            f.block(&id);
        } else {
            f.remove(&id);
        }
        return Ok(());
    }
    let file = crate::anywhere::book_file();
    let mut book = crate::anywhere::Book::load(&file);
    if block {
        book.block(&id);
    } else {
        book.remove(&id);
    }
    book.save(&file).map_err(|e| format!("cannot save friends: {e}"))
}

#[tauri::command]
pub async fn land_stop(state: tauri::State<'_, LandState>) -> Result<(), String> {
    if let Some(run) = state.run.lock().await.take() {
        run.shutdown().await;
    }
    Ok(())
}

async fn running(state: &tauri::State<'_, LandState>) -> Result<Arc<Running>, String> {
    state.run.lock().await.clone().ok_or_else(|| "Land is off.".to_string())
}

#[tauri::command]
pub async fn land_scan(state: tauri::State<'_, LandState>) -> Result<Vec<PeerInfo>, String> {
    let run = running(&state).await?;
    run.scan().await;
    Ok(run.peers())
}

/// Computers at the same place found over the internet (Wi-Fi that keeps devices apart).
#[tauri::command]
pub async fn land_place(state: tauri::State<'_, LandState>) -> Result<Vec<PeerInfo>, String> {
    Ok(running(&state).await?.place_peers())
}

#[tauri::command]
pub async fn land_send(state: tauri::State<'_, LandState>, peer: String, paths: Vec<String>) -> Result<String, String> {
    let run = running(&state).await?;
    run.send(&peer, paths.into_iter().map(PathBuf::from).collect()).await
}

/// Sends text (a link, a note) to a computer nearby or a friend.
#[tauri::command]
pub async fn land_send_text(state: tauri::State<'_, LandState>, peer: String, text: String) -> Result<String, String> {
    let run = running(&state).await?;
    run.send_text(&peer, &text).await
}

#[tauri::command]
pub async fn land_answer(state: tauri::State<'_, LandState>, id: String, accept: bool) -> Result<bool, String> {
    Ok(running(&state).await?.answer(&id, accept))
}

#[tauri::command]
pub async fn land_cancel(state: tauri::State<'_, LandState>, id: String) -> Result<bool, String> {
    Ok(running(&state).await?.cancel(&id))
}

/// Names, sizes and file counts of dropped paths (folders are walked).
#[tauri::command]
pub async fn land_stage(paths: Vec<String>) -> Vec<Staged> {
    tokio::task::spawn_blocking(move || paths.iter().map(|p| stage(p)).collect()).await.unwrap_or_default()
}
