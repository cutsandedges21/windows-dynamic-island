// Finding Islands at the same place when its Wi-Fi keeps devices apart (school and café Wi-Fi
// often does: "client isolation"), so the UDP announcements never arrive.
//
// Islands behind the same router share its internet address. Each one with Land anywhere on
// learns that address (Cloudflare's trace page) and listens on an ntfy.sh topic named after a
// hash of it. Opening Land's card posts one "ask" (the same signed packet as on the network);
// each Island there answers with "here", at most once a minute. Posts are sent with
// `Cache: no`, so ntfy keeps no history. Found this way, a computer can only be added as a
// friend (its signed friend key); files still go only to friends, through Land anywhere.

use super::*;

/// How long a computer found this way stays listed after it last spoke.
pub(super) const PLACE_TTL: Duration = Duration::from_secs(10 * 60);
/// At most one ask, and one answer, per this long: ntfy.sh limits messages per internet address,
/// and everyone at the place shares one.
const PLACE_EVERY: Duration = Duration::from_secs(60);
/// The internet address is looked up again this often (a laptop moves between places).
const PLACE_RECHECK: Duration = Duration::from_secs(10 * 60);

const NTFY: &str = "https://ntfy.sh";
const TRACE: &str = "https://1.1.1.1/cdn-cgi/trace";

/// The topic for everyone behind one internet address. Hashed, so the address isn't in it.
pub fn place_topic(ip: Ipv4Addr) -> String {
    let h = Sha256::digest(format!("island-land-place/1|{ip}").as_bytes());
    let hex: String = h.iter().take(12).map(|b| format!("{b:02x}")).collect();
    format!("island-place-{hex}")
}

/// The `ip=` line of Cloudflare's trace page, when it is an IPv4 address.
pub fn trace_ip(body: &str) -> Option<Ipv4Addr> {
    body.lines().find_map(|l| l.strip_prefix("ip=")).and_then(|ip| ip.trim().parse().ok())
}

/// One line of ntfy's JSON stream: a message's text (keepalives and opens are not messages).
pub fn ntfy_message(line: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(line).ok()?;
    (v["event"] == "message").then(|| v["message"].as_str().map(str::to_string)).flatten()
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build().unwrap_or_default())
}

async fn public_ip() -> Option<Ipv4Addr> {
    let r = client().get(TRACE).timeout(Duration::from_secs(10)).send().await.ok()?;
    trace_ip(&r.text().await.ok()?)
}

async fn post(topic: &str, body: Vec<u8>) {
    let _ = client().post(format!("{NTFY}/{topic}")).header("Cache", "no").timeout(Duration::from_secs(10)).body(body).send().await;
}

/// A computer found at the same place: who it is and its friend key (always there).
#[derive(Clone, Debug)]
pub(super) struct PlacePeer {
    pub info: PeerInfo,
    pub seen: Instant,
}

/// Whether this is due, and if so, marks it done now.
fn due(slot: &Mutex<Option<Instant>>) -> bool {
    let mut s = slot.lock().unwrap();
    if s.is_some_and(|t| t.elapsed() < PLACE_EVERY) {
        return false;
    }
    *s = Some(Instant::now());
    true
}

impl Running {
    /// The computers found at this place, not counting ones also found on the network.
    pub fn place_peers(&self) -> Vec<PeerInfo> {
        let near: Vec<String> = self.peers.lock().unwrap().keys().cloned().collect();
        let mut list: Vec<PeerInfo> = self.place.lock().unwrap().values().filter(|p| p.seen.elapsed() < PLACE_TTL && !near.contains(&p.info.id)).map(|p| p.info.clone()).collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        list
    }

    /// Asks who is at this place (the card opening), at most once a minute.
    pub(super) fn place_ask(&self) {
        let Some(topic) = self.place_topic.lock().unwrap().clone() else { return };
        if !due(&self.place_asked) {
            return;
        }
        let body = self.hello("ask").encode();
        tokio::spawn(async move { post(&topic, body).await });
    }

    /// A packet off the place's topic: the same checks as on the network, and a friend key.
    pub(super) async fn heard_place(&self, bytes: &[u8], topic: &str) {
        let Some((h, _key)) = Hello::decode(bytes) else { return };
        if h.id == self.me.id || h.ak.is_none() {
            return;
        }
        if h.t == "bye" {
            self.place.lock().unwrap().remove(&h.id);
            return;
        }
        let info = PeerInfo { id: h.id.clone(), name: h.name.clone(), os: h.os.clone(), anywhere: h.ak.clone() };
        self.place.lock().unwrap().insert(h.id.clone(), PlacePeer { info, seen: Instant::now() });
        (self.emit)("land-place", json!(self.place_peers()));
        if h.t == "ask" && self.visible && due(&self.place_answered) {
            post(topic, self.hello("here").encode()).await;
        }
    }

    /// Learns the internet address, listens on its topic, asks once, and starts over when the
    /// address may have changed or the stream drops. Only with Land anywhere on.
    pub(super) async fn place_loop(self: Arc<Self>) {
        let mut stop = self.stop.subscribe();
        loop {
            let Some(ip) = (tokio::select! { _ = stop.changed() => return, ip = public_ip() => ip }) else {
                tokio::select! { _ = stop.changed() => return, _ = tokio::time::sleep(PLACE_EVERY) => continue }
            };
            let topic = place_topic(ip);
            let moved = self.place_topic.lock().unwrap().as_deref() != Some(topic.as_str());
            if moved {
                crate::log::line(format!("land: listening for Islands at this place ({})", &topic[..20]));
                self.place.lock().unwrap().clear();
                *self.place_topic.lock().unwrap() = Some(topic.clone());
                *self.place_asked.lock().unwrap() = None;
            }
            let until = Instant::now() + PLACE_RECHECK;
            let resp = tokio::select! { _ = stop.changed() => return, r = client().get(format!("{NTFY}/{topic}/json")).send() => r };
            let Ok(mut resp) = resp else {
                tokio::select! { _ = stop.changed() => return, _ = tokio::time::sleep(PLACE_EVERY) => continue }
            };
            if moved {
                self.place_ask();
            }
            let mut buf: Vec<u8> = Vec::new();
            loop {
                let chunk = tokio::select! {
                    _ = stop.changed() => return,
                    _ = tokio::time::sleep_until(until.into()) => break,
                    c = resp.chunk() => c,
                };
                let Ok(Some(bytes)) = chunk else { break };
                buf.extend_from_slice(&bytes);
                while let Some(at) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=at).collect();
                    if let Some(msg) = ntfy_message(&line) {
                        self.heard_place(msg.as_bytes(), &topic).await;
                    }
                }
                if buf.len() > 64 * 1024 {
                    buf.clear();
                }
            }
            // A dropped stream: wait a moment before connecting again.
            if Instant::now() < until {
                tokio::select! { _ = stop.changed() => return, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
            }
        }
    }
}
