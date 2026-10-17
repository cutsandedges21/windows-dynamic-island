// Finding each other on the local network: the announcement packet, this computer's networks,
// and the listening, asking and announcing loops.

use super::*;

// ------------------------------------------------------------------ discovery packets

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hello {
    pub land: u32,
    /// "here", "ask" or "bye".
    pub t: String,
    pub id: String,
    pub name: String,
    pub os: String,
    /// TCP port that takes files; 0 when this device does not receive.
    pub port: u16,
    pub key: String,
    /// Its key for friends on other networks (src/anywhere.rs), when that is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ak: Option<String>,
    /// That key's signature over `key`: both keys belong to one Island, so nobody can borrow a friend's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aks: Option<String>,
}

impl Hello {
    pub fn new(kind: &str, me: &Identity, name: &str, port: u16) -> Self {
        Self { land: 1, t: kind.into(), id: me.id.clone(), name: name.into(), os: std::env::consts::OS.into(), port, key: B64.encode(&me.public), ak: None, aks: None }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// A packet off the network, checked: Land version 1, a known kind, a 32-byte key and the
    /// id that key gives. Returns the packet (name and system cleaned) and the key.
    pub fn decode(bytes: &[u8]) -> Option<(Hello, Vec<u8>)> {
        if bytes.len() > 2048 {
            return None;
        }
        let h: Hello = serde_json::from_slice(bytes).ok()?;
        if h.land != 1 || !matches!(h.t.as_str(), "here" | "ask" | "bye") {
            return None;
        }
        let key = B64.decode(h.key.as_bytes()).ok()?;
        if key.len() != 32 || device_id(&key) != h.id {
            return None;
        }
        let name = clean_name(&h.name);
        let os = clean_os(&h.os);
        // A friend key counts only when it signed this packet's Land key.
        let ak = match (&h.ak, &h.aks) {
            (Some(ak), Some(aks)) if crate::anywhere::verify_claim(ak, aks, &key) => Some(ak.to_lowercase()),
            _ => None,
        };
        let aks = if ak.is_some() { h.aks.clone() } else { None };
        Some((Hello { name, os, ak, aks, ..h }, key))
    }
}

/// A device name as shown: no control characters, at most 64 characters.
pub fn clean_name(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(64).collect();
    if t.is_empty() {
        "Computer".into()
    } else {
        t
    }
}

pub(crate) fn clean_os(s: &str) -> String {
    match s {
        "windows" | "macos" | "linux" => s.into(),
        _ => "other".into(),
    }
}

// ------------------------------------------------------------------ networks

/// One of this computer's IPv4 networks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Net {
    pub ip: Ipv4Addr,
    pub prefix: u8,
}

impl Net {
    pub(super) fn mask(&self) -> u32 {
        match self.prefix {
            0 => 0,
            p => u32::MAX << (32 - u32::from(p.min(32))),
        }
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask() == u32::from(self.ip) & self.mask()
    }

    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.ip) | !self.mask())
    }
}

/// This computer's IPv4 networks, loopback left out.
pub fn networks() -> Vec<Net> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) if !v4.ip.is_loopback() && !v4.ip.is_unspecified() => Some(Net { ip: v4.ip, prefix: v4.prefixlen }),
            _ => None,
        })
        .collect()
}

/// On the same local network: this computer itself, or a private (or link-local) address on
/// one of this computer's subnets. A /31 or /32 (VPN tunnels) is no local network.
pub fn is_local(ip: IpAddr, nets: &[Net]) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return v6.is_loopback(),
        },
    };
    if v4.is_loopback() {
        return true;
    }
    (v4.is_private() || v4.is_link_local()) && nets.iter().any(|n| (8..=30).contains(&n.prefix) && n.contains(v4))
}

pub(super) fn bind_udp(port: u16) -> io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(unix)]
    let _ = s.set_reuse_port(true);
    s.set_broadcast(true)?;
    // Another Island on this computer (a test build) still hears this one.
    s.set_multicast_loop_v4(true)?;
    s.set_multicast_ttl_v4(1)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
    UdpSocket::from_std(s.into())
}

impl Running {
    // -------------------------------------------------------------- discovery

    /// One packet to every network this computer is on: the multicast group through each
    /// interface, each subnet's broadcast address, and the plain broadcast.
    pub(super) async fn shout(&self, kind: &str) {
        let Some(udp) = &self.udp else { return };
        let _one_at_a_time = self.shouting.lock().await;
        let bytes = self.hello(kind).encode();
        let nets = self.nets.lock().unwrap().clone();
        for n in &nets {
            if socket2::SockRef::from(udp.as_ref()).set_multicast_if_v4(&n.ip).is_ok() {
                let _ = udp.send_to(&bytes, (GROUP, self.discovery)).await;
            }
            if n.prefix < 31 {
                let _ = udp.send_to(&bytes, (n.broadcast(), self.discovery)).await;
            }
        }
        let _ = udp.send_to(&bytes, (Ipv4Addr::BROADCAST, self.discovery)).await;
    }

    /// Asks every device nearby to say who it is (the Land card opening).
    pub async fn scan(&self) {
        self.expire();
        self.shout("ask").await;
    }

    pub(super) async fn heard(&self, bytes: &[u8], from: SocketAddr) {
        let Some((h, key)) = Hello::decode(bytes) else { return };
        if h.id == self.me.id {
            return;
        }
        let local = {
            let nets = self.nets.lock().unwrap();
            is_local(from.ip(), &nets)
        };
        if !local {
            return;
        }
        if h.t == "bye" {
            if self.peers.lock().unwrap().remove(&h.id).is_some() {
                self.emit_peers();
            }
            return;
        }
        let changed = {
            let mut peers = self.peers.lock().unwrap();
            if h.port == 0 {
                peers.remove(&h.id).is_some()
            } else {
                let info = PeerInfo { id: h.id.clone(), name: h.name.clone(), os: h.os.clone(), anywhere: h.ak.clone() };
                let addr = SocketAddr::new(from.ip(), h.port);
                let same = peers.get(&h.id).is_some_and(|p| p.info == info && p.addr == addr && p.key == key);
                peers.insert(h.id.clone(), Peer { info, addr, key, seen: Instant::now() });
                !same
            }
        };
        if changed {
            self.emit_peers();
        }
        // An ask gets an answer straight back, at most every 2 s per asker.
        if h.t == "ask" && self.visible {
            let due = {
                let mut replied = self.replied.lock().unwrap();
                let due = replied.get(&from.ip()).is_none_or(|t| t.elapsed() >= Duration::from_secs(2));
                if due {
                    replied.insert(from.ip(), Instant::now());
                }
                replied.retain(|_, t| t.elapsed() < Duration::from_secs(60));
                due
            };
            if let (true, Some(udp)) = (due, &self.udp) {
                let _ = udp.send_to(&self.hello("here").encode(), from).await;
            }
        }
    }

    pub(super) fn expire(&self) {
        let gone = {
            let mut peers = self.peers.lock().unwrap();
            let before = peers.len();
            peers.retain(|_, p| p.seen.elapsed() < PEER_TTL);
            before != peers.len()
        };
        if gone {
            self.emit_peers();
        }
    }

    pub(super) async fn listen_loop(self: Arc<Self>, udp: Arc<UdpSocket>) {
        let mut stop = self.stop.subscribe();
        let mut buf = vec![0u8; 4096];
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                r = udp.recv_from(&mut buf) => match r {
                    Ok((n, from)) => self.heard(&buf[..n], from).await,
                    // Windows reports an unreachable port from an earlier send here; carry on.
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                },
            }
        }
    }

    /// Joins the group on every interface, announces, forgets devices gone quiet. An ask first,
    /// so everyone nearby answers at once.
    pub(super) async fn announce_loop(self: Arc<Self>) {
        let mut stop = self.stop.subscribe();
        let mut first = true;
        loop {
            let nets = networks();
            // Joined again every time: Wi-Fi that drops and comes back loses the membership.
            // Joining twice only returns an error.
            if let Some(udp) = &self.udp {
                for n in &nets {
                    let _ = udp.join_multicast_v4(GROUP, n.ip);
                }
            }
            *self.nets.lock().unwrap() = nets;
            if first {
                self.shout("ask").await;
                first = false;
            } else if self.visible {
                self.shout("here").await;
            }
            self.expire();
            tokio::select! {
                _ = stop.changed() => break,
                _ = tokio::time::sleep(ANNOUNCE_EVERY) => {}
            }
        }
    }
}
