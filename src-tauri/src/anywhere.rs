// Land anywhere: Land between Islands that are not on the same network (docs/LAND-ANYWHERE.md).
//
// Each Island gets a second key for this, an Ed25519 key (iroh's), kept in
// `<data dir>/land-anywhere.key`. Its public half is the Island's address anywhere: iroh dials
// it over QUIC, straight through both routers when it can (hole punching, UPnP/NAT-PMP) and
// through a relay when it can't. Everything is encrypted end to end; a relay only passes bytes.
// Friends swap codes: `land:` and the key in base32 with a checksum.
//
// Only friends get in. A connection from any other key is closed as soon as its handshake
// proves who it is, except on the friend-request protocol, which anyone may use.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use data_encoding::BASE32_NOPAD;
use iroh::endpoint::{presets, Connection, ConnectionError, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::land::{clean_name, clean_os, Emit};

/// Files between friends (slice 3).
pub const ALPN_LAND: &[u8] = b"island-land/2";
/// Asking to be friends: the only protocol a stranger may use (slice 2).
pub const ALPN_FRIEND: &[u8] = b"island-friend/1";
/// Why a connection was closed: the key is not a friend's.
pub const NOT_A_FRIEND: u32 = 403;

const CODE_PREFIX: &str = "land:";
/// A code is this byte, the 32-byte key and 2 check bytes: 56 base32 characters.
const CODE_VERSION: u8 = 1;
const CODE_CHARS: usize = 56;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Reaching another Island, the first time through a relay and its key lookup.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Why a connection was closed: Land isn't taking files right now.
const NOT_TAKING: u32 = 503;
/// How long "who is online" waits for each friend.
const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// Friend requests waiting for an answer at once; more are told "busy".
const MAX_ASKING: usize = 3;
/// After a no, the same Island's next requests are turned away this long (no prompt spam).
const QUIET_AFTER_NO: Duration = Duration::from_secs(10 * 60);
/// One friend-request message, as JSON.
const MAX_MESSAGE: usize = 4096;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Which relays the endpoint may use when no direct path works.
#[derive(Clone, Debug)]
pub enum Relays {
    /// None, and no key lookup either: direct addresses only (tests).
    #[cfg(test)]
    Off,
    /// n0's free public relays and their key lookup (free for development and hobby use).
    N0,
    /// n0's relays only, never a direct path: two networks that can't reach each other (tests).
    #[cfg(test)]
    N0RelayOnly,
    /// Our own relay (an iroh-relay server), with n0's key lookup to find friends by key.
    Mine(iroh::RelayUrl),
    /// A relay running in the test itself (self-signed certificate), relay only, no lookup.
    #[cfg(test)]
    Local(iroh::RelayMap),
}

/// A relay address from the setting: a web address, like https://relay.example.com.
pub fn relay_url(text: &str) -> Result<iroh::RelayUrl, String> {
    let text = text.trim();
    let bad = || format!("\u{201c}{text}\u{201d} isn't a relay address. It looks like https://relay.example.com.");
    if !text.starts_with("https://") {
        return Err(bad());
    }
    let url: iroh::RelayUrl = text.parse().map_err(|_| bad())?;
    if url.host_str().is_none_or(|h| h.trim_matches('.').is_empty()) {
        return Err(bad());
    }
    Ok(url)
}

/// What Land needs to start Land anywhere.
pub struct Setup {
    pub key: SecretKey,
    pub relays: Relays,
    /// Where the friends are kept.
    pub book: PathBuf,
}

pub fn key_file() -> PathBuf {
    crate::log::data_dir().join("land-anywhere.key")
}

pub fn book_file() -> PathBuf {
    crate::log::data_dir().join("land-friends.json")
}

/// This Island's key and the code friends paste.
#[derive(Serialize)]
pub struct Me {
    pub id: String,
    pub code: String,
}

/// Works with Land off: the key is made on first use.
pub fn me() -> Result<Me, String> {
    let id = load_or_create_key(&key_file())?.public();
    Ok(Me { id: id.to_string(), code: code(&id) })
}

/// The key, made on first use and kept (32 bytes, the secret half).
pub fn load_or_create_key(file: &Path) -> Result<SecretKey, String> {
    if let Ok(bytes) = std::fs::read(file) {
        if let Ok(secret) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&secret));
        }
    }
    let key = SecretKey::generate();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(file, key.to_bytes()).map_err(|e| format!("cannot save the Land anywhere key: {e}"))?;
    Ok(key)
}

/// Two bytes of SHA-256 over the version and key: a mistyped code fails it.
fn check(payload: &[u8]) -> [u8; 2] {
    let h = Sha256::new().chain_update(b"island land code").chain_update(payload).finalize();
    [h[0], h[1]]
}

/// The code a friend pastes to add this Island.
pub fn code(id: &EndpointId) -> String {
    let mut bytes = vec![CODE_VERSION];
    bytes.extend_from_slice(id.as_bytes());
    let sum = check(&bytes);
    bytes.extend_from_slice(&sum);
    format!("{CODE_PREFIX}{}", BASE32_NOPAD.encode(&bytes).to_lowercase())
}

/// Reads a pasted code: case, spaces, dashes and the `land:` prefix don't matter; a typo does.
pub fn parse_code(text: &str) -> Result<EndpointId, String> {
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
    let body = cleaned.strip_prefix(&CODE_PREFIX.to_uppercase()).unwrap_or(&cleaned);
    let not_a_code = || "That isn't a Land code.".to_string();
    // The right length but unreadable: most likely a character changed on the way.
    let typo = || "That code has a typo. Copy it again.".to_string();
    if body.len() != CODE_CHARS {
        return Err(not_a_code());
    }
    let bytes = BASE32_NOPAD.decode(body.as_bytes()).map_err(|_| typo())?;
    let (payload, sum) = bytes.split_at(1 + 32);
    if payload[0] != CODE_VERSION || check(payload) != sum {
        return Err(typo());
    }
    let key: &[u8; 32] = payload[1..].try_into().map_err(|_| typo())?;
    EndpointId::from_bytes(key).map_err(|_| typo())
}

/// The running endpoint: accepts friends (and friend requests) and dials others.
pub struct Anywhere {
    ep: Endpoint,
    friends: Arc<Mutex<HashSet<EndpointId>>>,
}

impl Anywhere {
    /// Binds the endpoint. Connections that get in (a friend's, or anyone's friend request)
    /// arrive on `deliver`.
    pub async fn start(key: SecretKey, relays: Relays, deliver: mpsc::Sender<Connection>) -> Result<Self, String> {
        let builder = match relays {
            #[cfg(test)]
            Relays::Off => Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled),
            Relays::N0 => Endpoint::builder(presets::N0),
            #[cfg(test)]
            Relays::N0RelayOnly => Endpoint::builder(presets::N0).clear_ip_transports(),
            Relays::Mine(url) => Endpoint::builder(presets::N0).relay_mode(iroh::RelayMode::custom([url])),
            #[cfg(test)]
            Relays::Local(map) => Endpoint::builder(presets::Minimal)
                .relay_mode(iroh::RelayMode::Custom(map))
                .ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
                .clear_ip_transports(),
        };
        let ep = builder
            .secret_key(key)
            .alpns(vec![ALPN_LAND.to_vec(), ALPN_FRIEND.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("Land anywhere cannot start: {e}"))?;
        let friends = Arc::new(Mutex::new(HashSet::new()));
        tokio::spawn(accept_loop(ep.clone(), friends.clone(), deliver));
        Ok(Self { ep, friends })
    }

    pub fn id(&self) -> EndpointId {
        self.ep.id()
    }

    /// Where this endpoint can be reached right now (its direct addresses and relay).
    #[cfg(test)]
    pub fn addr(&self) -> EndpointAddr {
        self.ep.addr()
    }

    /// The keys allowed in on `ALPN_LAND`.
    pub fn set_friends(&self, ids: impl IntoIterator<Item = EndpointId>) {
        *self.friends.lock().unwrap() = ids.into_iter().collect();
    }

    pub async fn connect(&self, to: impl Into<EndpointAddr>, alpn: &[u8]) -> Result<Connection, String> {
        self.ep.connect(to, alpn).await.map_err(|e| e.to_string())
    }

    /// Ends every connection and the accept loop.
    pub async fn close(&self) {
        self.ep.close().await;
    }
}

/// Lets in friends on `ALPN_LAND` and anyone on `ALPN_FRIEND`; closes everything else once
/// the handshake has proved the other side's key. Ends when the endpoint closes.
async fn accept_loop(ep: Endpoint, friends: Arc<Mutex<HashSet<EndpointId>>>, deliver: mpsc::Sender<Connection>) {
    while let Some(incoming) = ep.accept().await {
        let (friends, deliver) = (friends.clone(), deliver.clone());
        tokio::spawn(async move {
            let Ok(accepting) = incoming.accept() else { return };
            let Ok(Ok(conn)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, accepting).await else { return };
            let alpn = conn.alpn();
            let allowed = alpn == ALPN_FRIEND || (alpn == ALPN_LAND && friends.lock().unwrap().contains(&conn.remote_id()));
            if allowed {
                let _ = deliver.send(conn).await;
            } else {
                conn.close(VarInt::from_u32(NOT_A_FRIEND), b"not a friend");
            }
        });
    }
}

// ------------------------------------------------------------------ friends

/// Someone this Island takes files from, and sends to, on any network.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Friend {
    /// Their key (hex).
    pub id: String,
    pub name: String,
    /// When they were added (ms since 1970).
    pub added: u64,
}

/// Friends and blocked keys, kept in `<data dir>/land-friends.json`.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Book {
    friends: Vec<Friend>,
    blocked: Vec<String>,
}

impl Book {
    /// A missing or unreadable file is an empty book.
    pub fn load(file: &Path) -> Book {
        std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// Written to a temporary file first, so a crash never leaves half a book.
    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let temp = file.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        std::fs::rename(&temp, file)
    }

    pub fn friends(&self) -> &[Friend] {
        &self.friends
    }

    pub fn is_friend(&self, id: &str) -> bool {
        self.friends.iter().any(|f| f.id == id)
    }

    pub fn is_blocked(&self, id: &str) -> bool {
        self.blocked.iter().any(|b| b == id)
    }

    /// Adds or renames a friend (and unblocks them).
    pub fn add(&mut self, id: &str, name: &str) {
        self.blocked.retain(|b| b != id);
        match self.friends.iter_mut().find(|f| f.id == id) {
            Some(f) => f.name = name.to_string(),
            None => self.friends.push(Friend { id: id.to_string(), name: name.to_string(), added: now_ms() }),
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.friends.retain(|f| f.id != id);
    }

    /// Removes a friend and turns their key away from now on.
    pub fn block(&mut self, id: &str) {
        self.remove(id);
        if !self.is_blocked(id) {
            self.blocked.push(id.to_string());
        }
    }

    fn ids(&self) -> Vec<EndpointId> {
        self.friends.iter().filter_map(|f| f.id.parse().ok()).collect()
    }
}

/// The user's answer to someone asking to be friends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reply {
    Add,
    No,
    /// No, and never show their requests again (they are told only "no").
    Block,
}

/// Friends over the endpoint: asking, being asked, the book.
///
/// A friend request is one message each way on a stream of `ALPN_FRIEND`:
/// `{"t":"ask","name","os"}`, then `{"t":"yes","name"}` or `{"t":"no","why":"declined"|"timeout"|"busy"}`.
/// The asker closes the connection once it has read the answer. A blocked Island is only
/// ever told no.
pub struct Far {
    net: Anywhere,
    name: Mutex<String>,
    file: PathBuf,
    book: Mutex<Book>,
    /// Requests waiting for this user: ask id → (their key, where the answer goes).
    asks: Mutex<HashMap<String, (String, oneshot::Sender<Reply>)>>,
    /// Islands this user said no to, and when.
    quiet: Mutex<HashMap<String, Instant>>,
    emit: Emit,
    ask_for: Duration,
    seq: AtomicU64,
    /// Where some Islands are, so dialling them skips the lookup (tests).
    hints: Mutex<HashMap<EndpointId, EndpointAddr>>,
    /// Friends' connections for files, handed to Land.
    land_tx: mpsc::Sender<Connection>,
    land_rx: Mutex<Option<mpsc::Receiver<Connection>>>,
}

/// What a friend key signs to say "this Land key is mine too".
fn claim_message(land_key: &[u8]) -> Vec<u8> {
    [b"island land: this Land key belongs to me: ".as_slice(), land_key].concat()
}

/// Whether `aks` is `ak`'s signature over `land_key`: the friend key a computer nearby announces
/// is really its own.
pub fn verify_claim(ak: &str, aks: &str, land_key: &[u8]) -> bool {
    let Ok(key) = ak.parse::<EndpointId>() else { return false };
    let Some(sig) = data_encoding::HEXLOWER_PERMISSIVE.decode(aks.as_bytes()).ok().and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok()) else { return false };
    key.verify(&claim_message(land_key), &iroh::Signature::from_bytes(&sig)).is_ok()
}

/// How a connection runs right now: "direct" (straight between the two computers) or "relay".
pub fn via(conn: &Connection) -> &'static str {
    match conn.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => "relay",
        Some(_) => "direct",
        None => "relay",
    }
}

/// Whether the other side closed the connection because this key is not its friend.
pub fn refused(conn: &Connection) -> bool {
    matches!(conn.close_reason(), Some(ConnectionError::ApplicationClosed(c)) if c.error_code == VarInt::from_u32(NOT_A_FRIEND))
}

fn unreachable() -> String {
    "Couldn't reach that Island. It needs Island open, with Land on.".into()
}

impl Far {
    pub async fn start(key: SecretKey, relays: Relays, book: PathBuf, name: &str, emit: Emit, ask_for: Duration) -> Result<Arc<Far>, String> {
        let (tx, mut rx) = mpsc::channel(16);
        let net = Anywhere::start(key, relays, tx).await?;
        let loaded = Book::load(&book);
        net.set_friends(loaded.ids());
        let (land_tx, land_rx) = mpsc::channel(8);
        let far = Arc::new(Far {
            net,
            name: Mutex::new(clean_name(name)),
            file: book,
            book: Mutex::new(loaded),
            asks: Mutex::default(),
            quiet: Mutex::default(),
            emit,
            ask_for,
            seq: AtomicU64::new(0),
            hints: Mutex::default(),
            land_tx,
            land_rx: Mutex::new(Some(land_rx)),
        });
        let weak = Arc::downgrade(&far);
        tokio::spawn(async move {
            while let Some(conn) = rx.recv().await {
                let Some(far) = weak.upgrade() else { break };
                tokio::spawn(far.incoming(conn));
            }
        });
        Ok(far)
    }

    pub fn id(&self) -> EndpointId {
        self.net.id()
    }

    #[cfg(test)]
    pub fn addr(&self) -> EndpointAddr {
        self.net.addr()
    }

    fn name(&self) -> String {
        self.name.lock().unwrap().clone()
    }

    /// The name sent with requests and answers.
    pub fn set_name(&self, name: &str) {
        *self.name.lock().unwrap() = clean_name(name);
    }

    pub fn friends(&self) -> Vec<Friend> {
        self.book.lock().unwrap().friends().to_vec()
    }

    /// Saves the book, lets its friends in, and tells the island.
    fn changed(&self, book: &Book) {
        if let Err(e) = book.save(&self.file) {
            crate::log::line(format!("land: cannot save friends: {e}"));
        }
        self.net.set_friends(book.ids());
        (self.emit)("land-friends", json!(book.friends()));
    }

    fn keep(&self, id: &str, name: &str) {
        let mut book = self.book.lock().unwrap();
        book.add(id, name);
        self.changed(&book);
    }

    pub fn remove(&self, id: &str) {
        let mut book = self.book.lock().unwrap();
        book.remove(id);
        self.changed(&book);
    }

    pub fn block(&self, id: &str) {
        let mut book = self.book.lock().unwrap();
        book.block(id);
        self.changed(&book);
    }

    /// A friend added without asking (tests).
    #[cfg(test)]
    pub(crate) fn add_known(&self, id: &str, name: &str) {
        self.keep(id, name);
    }

    /// Where an Island is, for dialling it without a lookup (tests have no relays or lookup).
    #[cfg(test)]
    pub(crate) fn remember(&self, addr: EndpointAddr) {
        self.hints.lock().unwrap().insert(addr.id, addr);
    }

    /// This Island's friend key and its signature over `land_key`, for the announcement nearby.
    pub fn claim(&self, land_key: &[u8]) -> (String, String) {
        let sig = self.net.ep.secret_key().sign(&claim_message(land_key));
        (self.id().to_string(), data_encoding::HEXLOWER.encode(&sig.to_bytes()))
    }

    pub fn friend(&self, id: &str) -> Option<Friend> {
        self.book.lock().unwrap().friends().iter().find(|f| f.id == id).cloned()
    }

    /// Dials an Island by key (its address remembered, else found through the relays' lookup).
    pub async fn dial(&self, id: EndpointId, alpn: &[u8]) -> Result<Connection, String> {
        let to = self.hints.lock().unwrap().get(&id).cloned().unwrap_or_else(|| id.into());
        self.net.connect(to, alpn).await
    }

    /// The friends whose Island answers right now (each gets `PING_TIMEOUT`), in the book's order.
    pub async fn online(self: &Arc<Self>) -> Vec<String> {
        let ids = self.book.lock().unwrap().ids();
        let mut checks = tokio::task::JoinSet::new();
        for (i, id) in ids.into_iter().enumerate() {
            let far = self.clone();
            checks.spawn(async move {
                let up = match timeout(PING_TIMEOUT, far.dial(id, ALPN_LAND)).await {
                    Ok(Ok(conn)) => {
                        // No stream: the other side takes it as a ping and lets go.
                        conn.close(VarInt::from_u32(0), b"ping");
                        true
                    }
                    _ => false,
                };
                (i, id, up)
            });
        }
        let mut up = Vec::new();
        while let Some(Ok((i, id, ok))) = checks.join_next().await {
            if ok {
                up.push((i, id.to_string()));
            }
        }
        up.sort();
        up.into_iter().map(|(_, id)| id).collect()
    }

    /// Friends' connections for files (`ALPN_LAND`); Land takes them once.
    pub fn land_connections(&self) -> Option<mpsc::Receiver<Connection>> {
        self.land_rx.lock().unwrap().take()
    }

    /// Asks another Island to be friends; resolves when its user answers (or doesn't).
    pub async fn ask(self: &Arc<Self>, to: impl Into<EndpointAddr>) -> Result<Friend, String> {
        let to = to.into();
        if to.id == self.id() {
            return Err("That's this Island's own code. Send it to a friend instead.".into());
        }
        // A key alone: where it is, if known (tests); else the relays' lookup finds it.
        let to = if to.addrs.is_empty() { self.hints.lock().unwrap().get(&to.id).cloned().unwrap_or(to) } else { to };
        let conn = timeout(CONNECT_TIMEOUT, self.net.connect(to.clone(), ALPN_FRIEND)).await.map_err(|_| unreachable())?.map_err(|_| unreachable())?;
        let answer = self.ask_on(&conn).await;
        conn.close(VarInt::from_u32(0), b"done");
        let name = answer?;
        let id = to.id.to_string();
        self.keep(&id, &name);
        Ok(Friend { id: id.clone(), name, added: self.friends().iter().find(|f| f.id == id).map(|f| f.added).unwrap_or_else(now_ms) })
    }

    async fn ask_on(&self, conn: &Connection) -> Result<String, String> {
        let said_no = || "They said no.".to_string();
        let lost = |conn: &Connection| match conn.close_reason() {
            // A blocked Island is turned away before it can ask; it hears only no.
            Some(ConnectionError::ApplicationClosed(c)) if c.error_code == VarInt::from_u32(NOT_A_FRIEND) => said_no(),
            _ => "The connection to that Island dropped. Try again.".to_string(),
        };
        let (mut send, mut recv) = conn.open_bi().await.map_err(|_| lost(conn))?;
        let ask = json!({ "t": "ask", "name": self.name(), "os": std::env::consts::OS });
        send.write_all(ask.to_string().as_bytes()).await.map_err(|_| lost(conn))?;
        send.finish().map_err(|_| lost(conn))?;
        let bytes = timeout(self.ask_for + Duration::from_secs(15), recv.read_to_end(MAX_MESSAGE))
            .await
            .map_err(|_| "No answer. Ask again when they're at their computer.".to_string())?
            .map_err(|_| lost(conn))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "That Island answered something Island doesn't understand.".to_string())?;
        if v["t"] == "yes" {
            let name = clean_name(v["name"].as_str().unwrap_or(""));
            return Ok(if name.is_empty() { "Island".into() } else { name });
        }
        Err(match v["why"].as_str() {
            Some("timeout") => "No answer. Ask again when they're at their computer.".into(),
            Some("busy") => "They're answering other requests. Try again in a minute.".into(),
            _ => said_no(),
        })
    }

    /// The user's answer to an ask shown as a `land-friend-ask` event.
    pub fn answer(&self, ask: &str, reply: Reply) -> bool {
        match self.asks.lock().unwrap().remove(ask) {
            Some((_, tx)) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    async fn incoming(self: Arc<Self>, conn: Connection) {
        if conn.alpn() == ALPN_FRIEND {
            self.asked(conn).await;
        } else if let Err(e) = self.land_tx.try_send(conn) {
            // Land isn't taking them (or is swamped).
            e.into_inner().close(VarInt::from_u32(NOT_TAKING), b"not taking files");
        }
    }

    /// Someone asks to be friends: a friend already is added back at once, anyone else is
    /// shown to the user (at most `MAX_ASKING` at a time).
    async fn asked(self: Arc<Self>, conn: Connection) {
        let from = conn.remote_id().to_string();
        if self.book.lock().unwrap().is_blocked(&from) {
            conn.close(VarInt::from_u32(NOT_A_FRIEND), b"not a friend");
            return;
        }
        let Ok(Ok((mut send, mut recv))) = timeout(HANDSHAKE_TIMEOUT, conn.accept_bi()).await else { return };
        let Ok(Ok(bytes)) = timeout(HANDSHAKE_TIMEOUT, recv.read_to_end(MAX_MESSAGE)).await else { return };
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return };
        if v["t"] != "ask" {
            return;
        }
        let name = clean_name(v["name"].as_str().unwrap_or(""));
        let name = if name.is_empty() { format!("Island {}", &from[..8]) } else { name };
        let os = clean_os(v["os"].as_str().unwrap_or(""));
        let known = self.book.lock().unwrap().is_friend(&from);
        let reply = if known {
            self.keep(&from, &name);
            Some(json!({ "t": "yes", "name": self.name() }))
        } else {
            self.prompt(&conn, &from, &name, &os).await
        };
        if let Some(reply) = reply {
            let _ = send.write_all(reply.to_string().as_bytes()).await;
            let _ = send.finish();
            // The asker closes the connection once it has read the answer.
            let _ = timeout(Duration::from_secs(10), conn.closed()).await;
        }
    }

    /// Shows the request and waits for the user; None if the asker gave up first.
    async fn prompt(&self, conn: &Connection, from: &str, name: &str, os: &str) -> Option<Value> {
        let quiet = self.quiet.lock().unwrap().get(from).is_some_and(|t| t.elapsed() < QUIET_AFTER_NO);
        let busy = quiet || {
            let asks = self.asks.lock().unwrap();
            asks.len() >= MAX_ASKING || asks.values().any(|(f, _)| f == from)
        };
        if busy {
            return Some(json!({ "t": "no", "why": "busy" }));
        }
        let id = format!("friend-{:x}-{}", now_ms(), self.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.asks.lock().unwrap().insert(id.clone(), (from.to_string(), tx));
        let who = json!({ "id": from, "name": name, "os": os });
        (self.emit)("land-friend-ask", json!({ "id": id, "from": who, "state": "asking", "expires": now_ms() + self.ask_for.as_millis() as u64 }));
        crate::log::line(format!("land: {} asks to be friends", &from[..8]));
        enum Said {
            Reply(Reply),
            Late,
            Gone,
        }
        let said = tokio::select! {
            r = rx => Said::Reply(r.unwrap_or(Reply::No)),
            _ = tokio::time::sleep(self.ask_for) => Said::Late,
            _ = conn.closed() => Said::Gone,
        };
        self.asks.lock().unwrap().remove(&id);
        let (state, reply) = match said {
            Said::Reply(Reply::Add) => {
                self.keep(from, name);
                ("added", Some(json!({ "t": "yes", "name": self.name() })))
            }
            Said::Reply(Reply::No) => {
                self.quiet.lock().unwrap().insert(from.to_string(), Instant::now());
                ("declined", Some(json!({ "t": "no", "why": "declined" })))
            }
            Said::Reply(Reply::Block) => {
                self.block(from);
                ("blocked", Some(json!({ "t": "no", "why": "declined" })))
            }
            Said::Late => ("expired", Some(json!({ "t": "no", "why": "timeout" }))),
            Said::Gone => ("gone", None),
        };
        (self.emit)("land-friend-ask", json!({ "id": id, "from": who, "state": state }));
        reply
    }

    /// Answers every waiting request with no and closes the endpoint.
    pub async fn close(&self) {
        for (_, (_, tx)) in self.asks.lock().unwrap().drain() {
            let _ = tx.send(Reply::No);
        }
        self.net.close().await;
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use iroh::endpoint::{ConnectionError, VarInt};
    use std::time::Duration;
    use tokio::time::timeout;

    const WAIT: Duration = Duration::from_secs(20);

    /// A relay server on this computer (self-signed certificate) for tests: its map, its address,
    /// and the server, which stops when dropped.
    pub(crate) async fn local_relay() -> (iroh::RelayMap, iroh::RelayUrl, iroh_relay::server::Server) {
        use iroh_relay::server::{CertConfig, RelayConfig, Server, ServerConfig, TlsConfig};
        let (_certs, tls_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
        let mut relay = RelayConfig::new((std::net::Ipv4Addr::LOCALHOST, 0));
        relay.tls = Some(TlsConfig::new((std::net::Ipv4Addr::LOCALHOST, 0), CertConfig::Manual { server_config: tls_config }));
        relay.key_cache_capacity = Some(1024);
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let server = Server::spawn(config).await.unwrap();
        let url: iroh::RelayUrl = format!("https://{}", server.https_addr().unwrap()).parse().unwrap();
        let map: iroh::RelayMap = iroh::RelayConfig::new(url.clone(), None).into();
        (map, url, server)
    }

    #[test]
    fn a_relay_address_is_a_web_address() {
        assert_eq!(relay_url(" https://relay.example.com ").unwrap().to_string(), "https://relay.example.com/");
        for bad in ["relay.example.com", "ftp://relay.example.com", "https://", "hello"] {
            assert!(relay_url(bad).is_err(), "{bad}");
        }
    }

    fn temp_file(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("island-anywhere-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("land-anywhere.key")
    }

    #[test]
    fn the_key_is_made_once_and_kept() {
        let file = temp_file("key");
        let first = load_or_create_key(&file).unwrap();
        assert_eq!(std::fs::read(&file).unwrap().len(), 32);
        let again = load_or_create_key(&file).unwrap();
        assert_eq!(first.public(), again.public());
    }

    #[test]
    fn codes_round_trip() {
        let id = SecretKey::generate().public();
        let c = code(&id);
        assert!(c.starts_with("land:"), "{c}");
        assert_eq!(parse_code(&c).unwrap(), id);
    }

    #[test]
    fn pasted_codes_survive_chat_apps() {
        let id = SecretKey::generate().public();
        let c = code(&id);
        let body = c.trim_start_matches("land:");
        let spaced: String = body.chars().enumerate().flat_map(|(i, ch)| if i > 0 && i % 8 == 0 { vec!['-', ch] } else { vec![ch] }).collect();
        for pasted in [format!("  {c}\n"), c.to_uppercase(), body.to_string(), format!("land: {spaced}"), format!("LAND:{}", body.replace('a', "A"))] {
            assert_eq!(parse_code(&pasted).unwrap(), id, "{pasted:?}");
        }
    }

    #[test]
    fn a_typo_in_a_code_is_caught() {
        let id = SecretKey::generate().public();
        let c = code(&id);
        // Change one character of the key part.
        let mut chars: Vec<char> = c.chars().collect();
        let i = "land:".len() + 10;
        chars[i] = if chars[i] == 'a' { 'b' } else { 'a' };
        let typo: String = chars.into_iter().collect();
        assert!(parse_code(&typo).unwrap_err().contains("typo"), "{typo}");
    }

    #[test]
    fn things_that_are_not_codes_are_refused() {
        for text in ["", "land:", "hello", "land:abc", &"a".repeat(200)] {
            assert!(parse_code(text).is_err(), "{text:?}");
        }
    }

    async fn endpoint() -> (Anywhere, mpsc::Receiver<Connection>) {
        let (tx, rx) = mpsc::channel(8);
        (Anywhere::start(SecretKey::generate(), Relays::Off, tx).await.unwrap(), rx)
    }

    /// The other side refused: either the handshake already failed, or the connection closes with NOT_A_FRIEND.
    async fn refused(conn: Result<Connection, String>) -> bool {
        match conn {
            Err(e) => e.contains(&NOT_A_FRIEND.to_string()) || e.contains("not a friend"),
            Ok(c) => match timeout(WAIT, c.closed()).await {
                Ok(ConnectionError::ApplicationClosed(close)) => close.error_code == VarInt::from_u32(NOT_A_FRIEND),
                _ => false,
            },
        }
    }

    #[tokio::test]
    async fn a_friend_gets_through() {
        let (home, mut arrivals) = endpoint().await;
        let (friend, _) = endpoint().await;
        home.set_friends([friend.id()]);
        let conn = timeout(WAIT, friend.connect(home.addr(), ALPN_LAND)).await.unwrap().unwrap();
        let (mut send, _recv) = conn.open_bi().await.unwrap();
        send.write_all(b"hi").await.unwrap();
        send.finish().unwrap();
        let got = timeout(WAIT, arrivals.recv()).await.unwrap().unwrap();
        assert_eq!(got.remote_id(), friend.id());
        assert_eq!(got.alpn(), ALPN_LAND);
        let (_send, mut recv) = got.accept_bi().await.unwrap();
        assert_eq!(recv.read_to_end(16).await.unwrap(), b"hi");
        friend.close().await;
        home.close().await;
    }

    #[tokio::test]
    async fn a_stranger_is_turned_away() {
        let (home, mut arrivals) = endpoint().await;
        let (stranger, _) = endpoint().await;
        let attempt = timeout(WAIT, stranger.connect(home.addr(), ALPN_LAND)).await.unwrap();
        assert!(refused(attempt).await);
        assert!(arrivals.try_recv().is_err(), "nothing reached Land");
        stranger.close().await;
        home.close().await;
    }

    #[tokio::test]
    async fn a_removed_friend_is_turned_away() {
        let (home, _arrivals) = endpoint().await;
        let (old_friend, _) = endpoint().await;
        home.set_friends([old_friend.id()]);
        home.set_friends([]);
        let attempt = timeout(WAIT, old_friend.connect(home.addr(), ALPN_LAND)).await.unwrap();
        assert!(refused(attempt).await);
        old_friend.close().await;
        home.close().await;
    }

    #[tokio::test]
    async fn anyone_may_ask_to_be_friends() {
        let (home, mut arrivals) = endpoint().await;
        let (stranger, _) = endpoint().await;
        let _conn = timeout(WAIT, stranger.connect(home.addr(), ALPN_FRIEND)).await.unwrap().unwrap();
        let got = timeout(WAIT, arrivals.recv()).await.unwrap().unwrap();
        assert_eq!(got.remote_id(), stranger.id());
        assert_eq!(got.alpn(), ALPN_FRIEND);
        stranger.close().await;
        home.close().await;
    }

    // ------------------------------------------------------------ friends

    #[test]
    fn the_book_remembers_friends_and_blocks() {
        let file = temp_file("book").with_file_name("land-friends.json");
        let (alex, sam) = (SecretKey::generate().public().to_string(), SecretKey::generate().public().to_string());
        let mut book = Book::load(&file);
        book.add(&alex, "Alex");
        book.add(&sam, "Sam");
        book.add(&alex, "Alex's laptop");
        book.block(&sam);
        book.save(&file).unwrap();
        let book = Book::load(&file);
        assert_eq!(book.friends().len(), 1);
        assert_eq!(book.friends()[0].name, "Alex's laptop");
        assert!(book.is_friend(&alex) && !book.is_friend(&sam));
        assert!(book.is_blocked(&sam) && !book.is_blocked(&alex));
        let mut book = book;
        book.add(&sam, "Sam");
        assert!(!book.is_blocked(&sam), "adding someone unblocks them");
        book.remove(&alex);
        assert!(!book.is_friend(&alex));
    }

    type Events = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    async fn far(tag: &str, name: &str, ask_for: Duration) -> (Arc<Far>, Events) {
        let events: Events = Arc::default();
        let log = events.clone();
        let emit: crate::land::Emit = Arc::new(move |e: &str, v: serde_json::Value| log.lock().unwrap().push((e.to_string(), v)));
        let file = temp_file(&format!("far-{tag}-{name}")).with_file_name("land-friends.json");
        let f = Far::start(SecretKey::generate(), Relays::Off, file, name, emit, ask_for).await.unwrap();
        (f, events)
    }

    /// The newest "asking" friend request seen by an Island.
    async fn asked(events: &Events) -> serde_json::Value {
        for _ in 0..200 {
            let found = events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").map(|(_, v)| v.clone());
            if let Some(v) = found {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no friend request arrived");
    }

    fn asks_seen(events: &Events) -> usize {
        events.lock().unwrap().iter().filter(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").count()
    }

    #[tokio::test]
    async fn asking_and_being_added_makes_both_friends() {
        let (moss, _) = far("added", "Moss", WAIT).await;
        let (alex, alex_events) = far("added", "Alex", WAIT).await;
        let asking = tokio::spawn({
            let (moss, to) = (moss.clone(), alex.addr());
            async move { moss.ask(to).await }
        });
        let ask = asked(&alex_events).await;
        assert_eq!(ask["from"]["name"], "Moss");
        assert_eq!(ask["from"]["id"], moss.id().to_string());
        assert!(alex.answer(ask["id"].as_str().unwrap(), Reply::Add));
        let friend = asking.await.unwrap().unwrap();
        assert_eq!(friend.name, "Alex");
        assert!(moss.friends().iter().any(|f| f.id == alex.id().to_string()));
        assert!(alex.friends().iter().any(|f| f.id == moss.id().to_string() && f.name == "Moss"));
        moss.close().await;
        alex.close().await;
    }

    #[tokio::test]
    async fn a_no_adds_nobody() {
        let (moss, _) = far("no", "Moss", WAIT).await;
        let (alex, alex_events) = far("no", "Alex", WAIT).await;
        let asking = tokio::spawn({
            let (moss, to) = (moss.clone(), alex.addr());
            async move { moss.ask(to).await }
        });
        let ask = asked(&alex_events).await;
        alex.answer(ask["id"].as_str().unwrap(), Reply::No);
        assert!(asking.await.unwrap().unwrap_err().contains("said no"));
        assert!(moss.friends().is_empty() && alex.friends().is_empty());
        moss.close().await;
        alex.close().await;
    }

    #[tokio::test]
    async fn a_blocked_island_cannot_ask_again() {
        let (moss, _) = far("block", "Moss", WAIT).await;
        let (alex, alex_events) = far("block", "Alex", WAIT).await;
        let asking = tokio::spawn({
            let (moss, to) = (moss.clone(), alex.addr());
            async move { moss.ask(to).await }
        });
        let ask = asked(&alex_events).await;
        alex.answer(ask["id"].as_str().unwrap(), Reply::Block);
        assert!(asking.await.unwrap().is_err());
        assert!(moss.ask(alex.addr()).await.is_err());
        assert_eq!(asks_seen(&alex_events), 1, "the second ask never showed");
        moss.close().await;
        alex.close().await;
    }

    #[tokio::test]
    async fn a_friend_asking_again_is_added_without_a_prompt() {
        let (moss, _) = far("again", "Moss", WAIT).await;
        let (alex, alex_events) = far("again", "Alex", WAIT).await;
        alex.add_known(&moss.id().to_string(), "Moss");
        let friend = moss.ask(alex.addr()).await.unwrap();
        assert_eq!(friend.name, "Alex");
        assert_eq!(asks_seen(&alex_events), 0);
        moss.close().await;
        alex.close().await;
    }

    #[tokio::test]
    async fn no_answer_in_time_is_a_no() {
        let (moss, _) = far("late", "Moss", WAIT).await;
        let (alex, _) = far("late", "Alex", Duration::from_millis(300)).await;
        assert!(moss.ask(alex.addr()).await.unwrap_err().contains("No answer"));
        assert!(moss.friends().is_empty() && alex.friends().is_empty());
        moss.close().await;
        alex.close().await;
    }

    #[tokio::test]
    async fn your_own_code_is_refused() {
        let (moss, events) = far("self", "Moss", WAIT).await;
        assert!(moss.ask(moss.addr()).await.unwrap_err().contains("this Island"));
        assert_eq!(asks_seen(&events), 0);
        moss.close().await;
    }

    /// Asks the Island running on this computer to be friends, through n0, by its code alone:
    /// its island shows "Island test wants to be friends" for a few seconds, then this gives up
    /// and the request goes away. Land and Friends on other networks must be on.
    /// `cargo test --lib anywhere::tests::ask_the_island_running_here -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn ask_the_island_running_here() {
        let island = parse_code(&me().unwrap().code).unwrap();
        let (tx, _) = mpsc::channel(8);
        let net = Anywhere::start(SecretKey::generate(), Relays::N0, tx).await.unwrap();
        let conn = timeout(Duration::from_secs(60), net.connect(island, ALPN_FRIEND)).await.unwrap().unwrap();
        let (mut send, _recv) = conn.open_bi().await.unwrap();
        send.write_all(br#"{"t":"ask","name":"Island test","os":"windows"}"#).await.unwrap();
        send.finish().unwrap();
        // How long until the island has the request: its log says so.
        let sent = Instant::now();
        let log = crate::log::path();
        let before = std::fs::read_to_string(&log).unwrap_or_default().matches("asks to be friends").count();
        let mut shown = None;
        while sent.elapsed() < Duration::from_secs(20) {
            if std::fs::read_to_string(&log).unwrap_or_default().matches("asks to be friends").count() > before {
                shown = Some(sent.elapsed());
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        println!("asked the island here; it had the request after {shown:?}; paths: {:?}", conn.paths());
        assert!(shown.is_some(), "the island never logged the request");
        tokio::time::sleep(Duration::from_secs(3)).await;
        conn.close(VarInt::from_u32(0), b"test over");
        net.close().await;
    }

    /// Through n0's real relays and key lookup, by key alone (no addresses given), from this network:
    /// `cargo test --lib anywhere::tests::found_by_key_through_n0 -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn found_by_key_through_n0() {
        let (tx, mut arrivals) = mpsc::channel(8);
        let home = Anywhere::start(SecretKey::generate(), Relays::N0, tx).await.unwrap();
        let (tx2, _) = mpsc::channel(8);
        let friend = Anywhere::start(SecretKey::generate(), Relays::N0, tx2).await.unwrap();
        home.set_friends([friend.id()]);
        // Give the home endpoint a moment to reach its relay and publish where it is.
        tokio::time::sleep(Duration::from_secs(5)).await;
        let conn = timeout(Duration::from_secs(60), friend.connect(home.id(), ALPN_LAND)).await.unwrap().unwrap();
        let got = timeout(WAIT, arrivals.recv()).await.unwrap().unwrap();
        assert_eq!(got.remote_id(), friend.id());
        println!("connected by key; paths: {:?}", conn.paths());
        friend.close().await;
        home.close().await;
    }
}
