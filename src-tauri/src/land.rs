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

// ------------------------------------------------------------------ identity

/// This computer's Land key pair. The id other devices see is derived from the public key.
#[derive(Clone)]
pub struct Identity {
    private: Vec<u8>,
    pub public: Vec<u8>,
    pub id: String,
}

/// First 8 bytes of SHA-256 of a public key, in hex: short, and impossible to claim without the key.
pub fn device_id(public: &[u8]) -> String {
    Sha256::digest(public)[..8].iter().map(|b| format!("{b:02x}")).collect()
}

impl Identity {
    pub fn generate() -> Result<Self, String> {
        let kp = snow::Builder::new(noise_params()).generate_keypair().map_err(|e| e.to_string())?;
        Ok(Self::from_parts(kp.private, kp.public))
    }

    fn from_parts(private: Vec<u8>, public: Vec<u8>) -> Self {
        let id = device_id(&public);
        Self { private, public, id }
    }

    /// Made on first use and kept in Island's data folder (private key, then public key).
    pub fn load_or_create(file: &Path) -> Result<Self, String> {
        if let Ok(bytes) = std::fs::read(file) {
            if bytes.len() == 64 {
                return Ok(Self::from_parts(bytes[..32].to_vec(), bytes[32..].to_vec()));
            }
        }
        let me = Self::generate()?;
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut both = me.private.clone();
        both.extend_from_slice(&me.public);
        std::fs::write(file, both).map_err(|e| format!("cannot save the Land key: {e}"))?;
        Ok(me)
    }
}

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
    fn mask(&self) -> u32 {
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

// ------------------------------------------------------------------ files

/// A file to send: where it is, the name it arrives under ('/' between folders), its size.
#[derive(Clone, Debug)]
pub struct Item {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    /// Last changed (ms since 1970; 0 unknown): a resumed transfer goes on only if it is the same.
    pub mtime: u64,
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Files that are not worth sending when a whole folder goes.
fn junk(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), ".ds_store" | "thumbs.db" | "desktop.ini")
}

/// Every file under the dropped paths: a file is itself, a folder is every file in it (links
/// and junctions are not followed), named from the folder down. At most MAX_FILES.
pub fn collect(paths: &[PathBuf]) -> Result<Vec<Item>, String> {
    let mut out = Vec::new();
    for root in paths {
        let meta = std::fs::symlink_metadata(root).map_err(|_| format!("{} is gone.", display_name(root)))?;
        let top = display_name(root);
        if meta.is_file() {
            out.push(Item { path: root.clone(), name: top, size: meta.len(), mtime: mtime_ms(&meta) });
        } else if meta.is_dir() {
            let mut stack = vec![(root.clone(), top, 0usize)];
            while let Some((dir, rel, depth)) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for e in entries.flatten() {
                    let Ok(ft) = e.file_type() else { continue };
                    let name = e.file_name().to_string_lossy().to_string();
                    if ft.is_symlink() {
                        continue;
                    }
                    let child = format!("{rel}/{name}");
                    if ft.is_dir() {
                        if depth + 1 < MAX_DEPTH {
                            stack.push((e.path(), child, depth + 1));
                        }
                    } else if ft.is_file() && !junk(&name) {
                        let (size, mtime) = e.metadata().map(|m| (m.len(), mtime_ms(&m))).unwrap_or((0, 0));
                        out.push(Item { path: e.path(), name: child, size, mtime });
                    }
                }
                if out.len() > MAX_FILES {
                    return Err(format!("That is more than {MAX_FILES} files. Send a zip of them instead."));
                }
            }
        }
        if out.len() > MAX_FILES {
            return Err(format!("That is more than {MAX_FILES} files. Send a zip of them instead."));
        }
    }
    Ok(out)
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| p.to_string_lossy().to_string())
}

/// What the island shows for a dropped path before it is sent.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub dir: bool,
    /// Files in it (1 for a file); more than MAX_FILES means too many.
    pub files: usize,
    pub error: Option<String>,
}

pub fn stage(path: &str) -> Staged {
    let p = PathBuf::from(path);
    let name = display_name(&p);
    let dir = std::fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
    match collect(std::slice::from_ref(&p)) {
        Ok(items) => Staged { path: path.into(), name, size: items.iter().map(|i| i.size).sum(), dir, files: items.len(), error: None },
        Err(e) => Staged { path: path.into(), name, size: 0, dir, files: 0, error: Some(e) },
    }
}

/// One part of an incoming name, safe on Windows and macOS: no separators, no characters
/// Windows refuses, no trailing dots or spaces, no device names (CON, NUL, COM1…), no "..".
pub fn clean_component(s: &str) -> Option<String> {
    let t: String = s.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let t = t.trim_start().trim_end_matches([' ', '.']).to_string();
    if t.is_empty() {
        return None;
    }
    let stem = t.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    let t = if device { format!("_{t}") } else { t };
    Some(clip_name(&t, 150))
}

/// At most `max` characters, keeping a short extension.
fn clip_name(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    let keep = max.saturating_sub(ext.chars().count()).max(1);
    format!("{}{}", stem.chars().take(keep).collect::<String>(), ext)
}

/// ("photo", ".jpg"); a leading dot or a long tail is no extension.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 16 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// An incoming relative name as safe folder and file names (at least one).
pub fn clean_rel(name: &str) -> Vec<String> {
    let parts: Vec<String> = name.split(['/', '\\']).filter_map(clean_component).take(MAX_DEPTH).collect();
    if parts.is_empty() {
        vec!["file".into()]
    } else {
        parts
    }
}

/// "photo.jpg", "photo (1).jpg", "photo (2).jpg"… (a folder keeps dots in its name).
pub fn candidate(name: &str, n: usize, folder: bool) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = if folder { (name, "") } else { split_ext(name) };
    format!("{stem} ({n}){ext}")
}

/// A new folder under `parent`, never one that is already there.
fn reserve_dir(parent: &Path, name: &str) -> io::Result<PathBuf> {
    for n in 0..10_000 {
        let p = parent.join(candidate(name, n, true));
        match std::fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("no free folder name"))
}

/// Gives a finished temp file its name in `dir`, never replacing a file that is there: a
/// hard link fails when the name is taken (where links are not possible, a check, then a rename).
pub fn place(temp: &Path, dir: &Path, name: &str) -> io::Result<PathBuf> {
    for n in 0..10_000 {
        let p = dir.join(candidate(name, n, false));
        match std::fs::hard_link(temp, &p) {
            Ok(()) => {
                let _ = std::fs::remove_file(temp);
                return Ok(p);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                if p.exists() {
                    continue;
                }
                std::fs::rename(temp, &p)?;
                return Ok(p);
            }
        }
    }
    Err(io::Error::other("no free file name"))
}

/// A temp file for `name` in `dir` that nothing else is using.
async fn create_temp(dir: &Path, name: &str) -> io::Result<(PathBuf, tokio::fs::File)> {
    for n in 0..1000 {
        let p = if n == 0 { dir.join(format!("{name}.landing")) } else { dir.join(format!("{name}.{n}.landing")) };
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&p).await {
            Ok(f) => return Ok((p, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("no free temp name"))
}

/// Where an incoming file goes.
#[derive(Clone)]
struct Target {
    dir: PathBuf,
    name: String,
    size: u64,
    /// The folder it arrives in (a dropped folder), made for this transfer.
    root: Option<PathBuf>,
}

/// Folders for the accepted files: each dropped folder gets a new folder in Downloads
/// ("Photos", or "Photos (1)" when that exists), so nothing already there is touched.
fn prepare(downloads: &Path, files: &[OfferFile], litter: &mut Litter) -> io::Result<Vec<Target>> {
    std::fs::create_dir_all(downloads)?;
    let mut roots: HashMap<String, PathBuf> = HashMap::new();
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let parts = clean_rel(&f.name);
        if parts.len() == 1 {
            out.push(Target { dir: downloads.to_path_buf(), name: parts[0].clone(), size: f.size, root: None });
            continue;
        }
        let key = parts[0].to_lowercase();
        let root = match roots.get(&key) {
            Some(r) => r.clone(),
            None => {
                let r = reserve_dir(downloads, &parts[0])?;
                litter.roots.push(r.clone());
                roots.insert(key, r.clone());
                r
            }
        };
        let mut dir = root.clone();
        for p in &parts[1..parts.len() - 1] {
            dir.push(p);
        }
        std::fs::create_dir_all(&dir)?;
        out.push(Target { dir, name: parts[parts.len() - 1].clone(), size: f.size, root: Some(root) });
    }
    Ok(out)
}

/// Temp files and new folders of a transfer that did not finish: removed when it ends.
#[derive(Default)]
struct Litter {
    temps: Vec<PathBuf>,
    roots: Vec<PathBuf>,
    keep: bool,
}

impl Drop for Litter {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        for t in &self.temps {
            let _ = std::fs::remove_file(t);
        }
        for r in &self.roots {
            let _ = std::fs::remove_dir_all(r);
        }
    }
}

/// Bytes free for this user on the disk holding `dir` (its nearest existing parent).
fn free_space(dir: &Path) -> Option<u64> {
    let mut at = dir;
    while !at.exists() {
        at = at.parent()?;
    }
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = at.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let mut free = 0u64;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).ok()? };
        Some(free)
    }
    #[cfg(target_os = "macos")]
    {
        crate::mac::sys::disk_space(at).map(|(free, _)| free)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = at;
        None
    }
}

/// Marks a received file as coming from another computer, the way browsers mark downloads
/// and AirDrop marks what it receives: Windows then checks programs with SmartScreen and
/// Office opens documents in Protected View; a Mac checks it with Gatekeeper.
fn mark_from_network(path: &Path) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(stream, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let (Ok(p), Ok(name)) = (std::ffi::CString::new(path.as_os_str().as_bytes()), std::ffi::CString::new("com.apple.quarantine")) else { return };
        let value = format!("0081;{:x};Island;", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        unsafe { libc::setxattr(p.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = path;
}

/// The user's Downloads folder (where Windows has it, if it was moved).
pub fn downloads_dir() -> PathBuf {
    #[cfg(windows)]
    {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
        unsafe {
            if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Downloads, KNOWN_FOLDER_FLAG(0), None) {
                let s = p.to_string().unwrap_or_default();
                CoTaskMemFree(Some(p.0 as *const _));
                if !s.is_empty() {
                    return PathBuf::from(s);
                }
            }
        }
    }
    crate::claude::home().join("Downloads")
}

/// The name other devices see: Windows' device name, or the Mac's Computer Name.
pub fn computer_name() -> String {
    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::System::SystemInformation::{ComputerNamePhysicalDnsHostname, GetComputerNameExW};
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        if unsafe { GetComputerNameExW(ComputerNamePhysicalDnsHostname, Some(PWSTR(buf.as_mut_ptr())), &mut len) }.is_ok() {
            let s = String::from_utf16_lossy(&buf[..len as usize]);
            if !s.trim().is_empty() {
                return clean_name(&s);
            }
        }
        clean_name(&std::env::var("COMPUTERNAME").unwrap_or_default())
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if o.status.success() && !s.is_empty() {
                return clean_name(&s);
            }
        }
        clean_name(&crate::mac::sys::host_name())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        clean_name(&std::env::var("HOSTNAME").unwrap_or_default())
    }
}

// ------------------------------------------------------------------ the secure channel

/// Frames on the wire: a big-endian u16 length, then that many bytes.
async fn write_frame(w: &mut (impl AsyncWriteExt + Unpin), bytes: &[u8]) -> io::Result<()> {
    let len = u16::try_from(bytes.len()).map_err(|_| io::Error::other("frame too big"))?;
    let mut buf = Vec::with_capacity(bytes.len() + 2);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(bytes);
    w.write_all(&buf).await
}

async fn read_frame(r: &mut (impl AsyncReadExt + Unpin), buf: &mut Vec<u8>) -> io::Result<()> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len).await?;
    buf.resize(u16::from_be_bytes(len) as usize, 0);
    r.read_exact(buf).await?;
    Ok(())
}

/// Noise XX: -> e; <- e, ee, s, es; -> s, se. Both sides end up knowing each other's key.
async fn handshake(stream: &mut TcpStream, me: &Identity, initiator: bool) -> Result<snow::TransportState, String> {
    let e = |e: snow::Error| e.to_string();
    let b = snow::Builder::new(noise_params()).local_private_key(&me.private).map_err(e)?.prologue(PROLOGUE).map_err(e)?;
    let mut hs = if initiator { b.build_initiator() } else { b.build_responder() }.map_err(e)?;
    let mut buf = vec![0u8; NOISE_MAX];
    let mut msg = Vec::new();
    let steps = if initiator { [true, false, true] } else { [false, true, false] };
    for write in steps {
        if write {
            let n = hs.write_message(&[], &mut buf).map_err(e)?;
            write_frame(stream, &buf[..n]).await.map_err(|e| e.to_string())?;
        } else {
            read_frame(stream, &mut msg).await.map_err(|e| e.to_string())?;
            hs.read_message(&msg, &mut buf).map_err(e)?;
        }
    }
    hs.into_transport_mode().map_err(e)
}

/// How frames are protected, shared by the reading and the writing half: a Noise session over
/// TCP (computers nearby), or nothing more over QUIC (friends on other networks), which already
/// encrypts and proves the other side's key.
enum Wire {
    Noise(Mutex<snow::TransportState>),
    Plain,
}

impl Wire {
    fn new(state: snow::TransportState) -> Self {
        Wire::Noise(Mutex::new(state))
    }

    /// `plain` (a frame type, then its bytes), encrypted when it is Noise, and framed.
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        match self {
            Wire::Noise(state) => {
                let mut out = vec![0u8; plain.len() + NOISE_TAG + 2];
                let n = state.lock().unwrap().write_message(plain, &mut out[2..]).map_err(|e| e.to_string())?;
                out[..2].copy_from_slice(&(n as u16).to_be_bytes());
                out.truncate(n + 2);
                Ok(out)
            }
            Wire::Plain => {
                let len = u16::try_from(plain.len()).map_err(|_| "frame too big".to_string())?;
                let mut out = Vec::with_capacity(plain.len() + 2);
                out.extend_from_slice(&len.to_be_bytes());
                out.extend_from_slice(plain);
                Ok(out)
            }
        }
    }

    fn open(&self, msg: &[u8]) -> Result<(u8, Vec<u8>), String> {
        let mut out = match self {
            Wire::Noise(state) => {
                let mut out = vec![0u8; msg.len()];
                let n = state.lock().unwrap().read_message(msg, &mut out).map_err(|_| "a frame failed its check".to_string())?;
                out.truncate(n);
                out
            }
            Wire::Plain => msg.to_vec(),
        };
        if out.is_empty() {
            return Err("an empty frame".into());
        }
        let kind = out.remove(0);
        Ok((kind, out))
    }
}

enum Msg {
    Json(Value),
    Data(Vec<u8>),
}

/// One JSON message, split over frames when it is long (a long list of files).
async fn send_json(w: &mut (impl AsyncWrite + Unpin), wire: &Wire, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    let parts: Vec<&[u8]> = bytes.chunks(CHUNK).collect();
    for (i, part) in parts.iter().enumerate() {
        let mut plain = Vec::with_capacity(part.len() + 1);
        plain.push(if i + 1 == parts.len() { F_JSON } else { F_JSON_PART });
        plain.extend_from_slice(part);
        let frame = wire.seal(&plain)?;
        timeout(IO_TIMEOUT, w.write_all(&frame)).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The next message: file bytes, or a whole JSON message.
async fn recv(r: &mut (impl AsyncRead + Unpin), wire: &Wire) -> Result<Msg, String> {
    let mut frame = Vec::new();
    let mut json = Vec::new();
    loop {
        read_frame(r, &mut frame).await.map_err(|e| e.to_string())?;
        let (kind, body) = wire.open(&frame)?;
        match kind {
            F_DATA => return Ok(Msg::Data(body)),
            F_JSON_PART | F_JSON => {
                json.extend_from_slice(&body);
                if json.len() > MAX_JSON {
                    return Err("a message too long".into());
                }
                if kind == F_JSON {
                    return serde_json::from_slice(&json).map(Msg::Json).map_err(|e| e.to_string());
                }
            }
            _ => return Err("an unknown frame".into()),
        }
    }
}

async fn recv_for(r: &mut (impl AsyncRead + Unpin), wire: &Wire, limit: Duration) -> Result<Msg, String> {
    timeout(limit, recv(r, wire)).await.map_err(|_| "timed out".to_string())?
}

/// Resolves once `cancel` says stop (never, if its sender is gone).
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow() {
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

// ------------------------------------------------------------------ offers and transfers

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct OfferFile {
    pub name: String,
    pub size: u64,
    /// When the sender's file last changed (ms; 0 unknown).
    #[serde(default)]
    pub mtime: u64,
}

pub struct Offer {
    pub from: String,
    pub os: String,
    pub files: Vec<OfferFile>,
    pub total: u64,
    /// The sender's id for this transfer: the same when it comes back after a dropped connection.
    pub tid: Option<String>,
}

impl Offer {
    /// An offer as it arrived, checked: 1 to MAX_FILES files with names and sizes. The total is counted here.
    pub fn parse(v: &Value) -> Option<Offer> {
        if v.get("t")?.as_str()? != "offer" {
            return None;
        }
        let list = v.get("files")?.as_array()?;
        if list.is_empty() || list.len() > MAX_FILES {
            return None;
        }
        let mut files = Vec::with_capacity(list.len());
        let mut total: u64 = 0;
        for f in list {
            let name = f.get("name")?.as_str()?;
            let size = f.get("size")?.as_u64()?;
            if name.is_empty() || name.len() > 4096 {
                return None;
            }
            total = total.checked_add(size)?;
            let mtime = f.get("mtime").and_then(Value::as_u64).unwrap_or(0);
            files.push(OfferFile { name: name.to_string(), size, mtime });
        }
        let from = clean_name(v.get("from").and_then(Value::as_str).unwrap_or(""));
        let os = clean_os(v.get("os").and_then(Value::as_str).unwrap_or(""));
        let tid = v.get("tid").and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 80).map(String::from);
        Some(Offer { from, os, files, total, tid })
    }
}

/// One dropped item of a transfer: a file, or a folder with the files in it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Top {
    pub name: String,
    pub size: u64,
    pub files: usize,
    pub dir: bool,
}

/// The dropped items behind a list of files, in order ("Trip/a.jpg" and "Trip/b.jpg" are one folder).
pub fn tops(files: &[OfferFile]) -> Vec<Top> {
    let mut out: Vec<Top> = Vec::new();
    let mut at: HashMap<(bool, String), usize> = HashMap::new();
    for f in files {
        let parts = clean_rel(&f.name);
        let dir = parts.len() > 1;
        match at.get(&(dir, parts[0].to_lowercase())) {
            Some(&i) => {
                out[i].size += f.size;
                out[i].files += 1;
            }
            None => {
                at.insert((dir, parts[0].to_lowercase()), out.len());
                out.push(Top { name: parts[0].clone(), size: f.size, files: 1, dir });
            }
        }
    }
    out
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub os: String,
    /// A computer nearby's key for friends on other networks, when it announced one (signed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anywhere: Option<String>,
}

/// What the island hears about a transfer, on every change and as bytes move.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    /// "out" (sending) or "in" (receiving).
    pub dir: &'static str,
    pub peer: PeerInfo,
    /// waiting (out: connecting, then asking) | asking (in: waiting for this user) | sending | receiving | done | declined | failed | cancelled
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub count: usize,
    /// The dropped files and folders, the first LISTED of them, named as the receiver saves them.
    pub items: Vec<Top>,
    pub error: Option<String>,
    /// What arrived, as saved (a file, or the folder a dropped folder became).
    pub saved: Vec<String>,
    pub folder: Option<String>,
    /// When an ask runs out (epoch ms).
    pub expires: Option<u64>,
    /// How it goes: "lan" (a computer nearby), or for a friend "direct" or "relay" (it can change midway).
    pub via: Option<&'static str>,
}

impl Transfer {
    fn new(id: &str, dir: &'static str, peer: PeerInfo, files: &[OfferFile]) -> Self {
        Self {
            id: id.into(),
            dir,
            peer,
            state: "waiting",
            done: 0,
            total: files.iter().map(|f| f.size).sum(),
            count: files.len(),
            items: tops(files).into_iter().take(LISTED).collect(),
            error: None,
            saved: Vec::new(),
            folder: None,
            expires: None,
            via: None,
        }
    }
}

/// How a transfer ended early.
struct Fail {
    state: &'static str,
    error: String,
}

impl Fail {
    fn failed(error: impl Into<String>) -> Self {
        Self { state: "failed", error: error.into() }
    }
    fn declined(error: impl Into<String>) -> Self {
        Self { state: "declined", error: error.into() }
    }
    fn cancelled(error: impl Into<String>) -> Self {
        Self { state: "cancelled", error: error.into() }
    }
    /// The connection dropped after the files were accepted: worth trying again.
    fn lost(error: impl Into<String>) -> Self {
        Self { state: "lost", error: error.into() }
    }
    /// A friend's Island couldn't be reached at all: the send waits for it.
    fn away(error: impl Into<String>) -> Self {
        Self { state: "away", error: error.into() }
    }
}

/// A send waiting for a friend who is away, kept in `<data dir>/land-queue.json` until it goes.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Waiting {
    tid: String,
    friend: String,
    /// What was dropped, sent again from the disk when it goes.
    paths: Vec<String>,
    /// When the send began (ms).
    since: u64,
}

/// A friend as a transfer names them.
fn friend_info(f: &crate::anywhere::Friend) -> PeerInfo {
    PeerInfo { id: f.id.clone(), name: f.name.clone(), os: String::new(), anywhere: Some(f.id.clone()) }
}

/// How long a receiver turns away the comeback of a transfer its user cancelled while paused.
const RESUME_REFUSED: Duration = Duration::from_secs(3600);

/// A sender's transfer, as its comeback is recognised: who sends, and its id for the transfer.
fn resume_key(sender: &str, tid: &str) -> String {
    format!("{sender}/{tid}")
}

/// The files of an accepted transfer as they arrive: where each goes, and its temp file once begun.
struct Landing {
    targets: Vec<Target>,
    temps: Vec<PathBuf>,
    litter: Litter,
}

impl Landing {
    fn new(downloads: &Path, files: &[OfferFile]) -> io::Result<Landing> {
        let mut litter = Litter::default();
        let targets = prepare(downloads, files, &mut litter)?;
        Ok(Landing { targets, temps: Vec::new(), litter })
    }

    /// The bytes of each file already on disk (0 for one not begun).
    fn have(&self) -> Vec<u64> {
        self.targets.iter().enumerate().map(|(i, t)| self.temps.get(i).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len().min(t.size)).unwrap_or(0)).collect()
    }
}

/// An accepted transfer whose connection dropped: its pieces wait for the sender to come back.
struct Paused {
    files: Vec<OfferFile>,
    transfer: Transfer,
    landing: Landing,
    /// Which pause this is (a transfer can drop more than once).
    epoch: u64,
}

fn why_declined(why: &str, name: &str) -> String {
    match why {
        "busy" => format!("{name} is busy with other files. Try again in a moment."),
        "space" => format!("{name} doesn't have enough space for these files."),
        "timeout" => format!("{name} didn't answer."),
        _ => format!("{name} declined."),
    }
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
    /// Our own relay, when Land anywhere uses one (its address).
    pub relay: Option<String>,
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
    /// Tests: the next send loses its connection after this many bytes (0: never).
    #[cfg(test)]
    cut: AtomicU64,
}

fn bind_udp(port: u16) -> io::Result<UdpSocket> {
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
    let relay = opts.anywhere.as_ref().and_then(|s| match &s.relays {
        crate::anywhere::Relays::Mine(url) => Some(url.to_string()),
        _ => None,
    });
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
        relay,
        timing: Mutex::new(Timing::default()),
        paused: Mutex::new(HashMap::new()),
        refused_resume: Mutex::new(HashMap::new()),
        waiting: Mutex::new(waiting),
        queue_file,
        kicks: Mutex::new(HashMap::new()),
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

    // -------------------------------------------------------------- discovery

    /// One packet to every network this computer is on: the multicast group through each
    /// interface, each subnet's broadcast address, and the plain broadcast.
    async fn shout(&self, kind: &str) {
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

    async fn heard(&self, bytes: &[u8], from: SocketAddr) {
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

    fn expire(&self) {
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

    async fn listen_loop(self: Arc<Self>, udp: Arc<UdpSocket>) {
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
    async fn announce_loop(self: Arc<Self>) {
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

    async fn accept_loop(self: Arc<Self>, listener: TcpListener) {
        let mut stop = self.stop.subscribe();
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                r = listener.accept() => {
                    let Ok((sock, from)) = r else { continue };
                    let local = {
                        let nets = self.nets.lock().unwrap();
                        is_local(from.ip(), &nets)
                    };
                    if !local {
                        crate::log::line(format!("land: refused a connection from outside the local network ({})", from.ip()));
                        continue;
                    }
                    tokio::spawn(self.clone().receive(sock));
                }
            }
        }
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

    // -------------------------------------------------------------- sending

    /// Starts sending `paths` to a computer nearby or to a friend on another network (by id);
    /// progress arrives as land-transfer events.
    pub async fn send(self: &Arc<Self>, peer_id: &str, paths: Vec<PathBuf>) -> Result<String, String> {
        // A computer nearby by its id, or by its friend key: a friend who is nearby goes the fast way.
        let peer = {
            let peers = self.peers.lock().unwrap();
            peers.get(peer_id).or_else(|| peers.values().find(|p| p.info.anywhere.as_deref() == Some(peer_id))).cloned()
        };
        let friend = if peer.is_none() { self.far.as_ref().and_then(|f| f.friend(peer_id)) } else { None };
        let info = match (&peer, &friend) {
            (Some(p), _) => p.info.clone(),
            (None, Some(f)) => friend_info(f),
            (None, None) => return Err("That device is gone. Try again when it shows up.".to_string()),
        };
        let shown: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let items = tokio::task::spawn_blocking(move || collect(&paths)).await.map_err(|e| e.to_string())??;
        if items.is_empty() {
            return Err("Nothing to send: the folders are empty.".into());
        }
        let id = self.next_id("out");
        self.start_send(id.clone(), info, peer, friend, items, shown, now_ms());
        Ok(id)
    }

    /// Runs a send in the background: `tid` is its id, `paths` what was dropped (kept for a send
    /// that waits), `since` when it began (a waiting send gives up `queue_for` after that).
    #[allow(clippy::too_many_arguments)]
    fn start_send(self: &Arc<Self>, tid: String, info: PeerInfo, peer: Option<Peer>, friend: Option<crate::anywhere::Friend>, items: Vec<Item>, paths: Vec<String>, since: u64) {
        let (tx, rx) = watch::channel(false);
        self.cancels.lock().unwrap().insert(tid.clone(), tx);
        let run = self.clone();
        tokio::spawn(async move { run.run_send(tid, info, peer, friend, items, paths, since, rx).await });
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_send(self: Arc<Self>, tid: String, info: PeerInfo, peer: Option<Peer>, friend: Option<crate::anywhere::Friend>, items: Vec<Item>, paths: Vec<String>, since: u64, rx: watch::Receiver<bool>) {
        let offered: Vec<OfferFile> = items.iter().map(|i| OfferFile { name: i.name.clone(), size: i.size, mtime: i.mtime }).collect();
        let mut t = Transfer::new(&tid, "out", info.clone(), &offered);
        self.publish(&t);
        let who = short(&info.id).to_string();
        crate::log::line(format!("land: sending {} files ({} bytes) to {who}", t.count, t.total));
        // A connection that drops after the files were accepted: pause, and try again (2 s,
        // 4 s, ... up to `retry_max`) until `retry_for` has gone by. The receiver keeps what arrived.
        // A friend who can't be reached: the send waits (kept on disk) until they come online,
        // which their hello tells at once, or a try every `queue_retry` finds.
        let mut paused: Option<Instant> = None;
        let mut tries = 0u32;
        let result = loop {
            let attempt = match (&peer, &friend) {
                (Some(p), _) => {
                    // A computer nearby may be at a new address by now.
                    let p = self.peers.lock().unwrap().get(&p.info.id).cloned().unwrap_or_else(|| p.clone());
                    self.send_to(&p, &items, &offered, &mut t, rx.clone()).await
                }
                (_, Some(f)) => self.send_far(f, &items, &offered, &mut t, rx.clone()).await,
                (None, None) => Err(Fail::failed("That device is gone.")),
            };
            let timing = *self.timing.lock().unwrap();
            let mut stop = rx.clone();
            match attempt {
                Err(f) if f.state == "away" => {
                    let Some(fr) = &friend else { break Err(Fail::failed(f.error)) };
                    if now_ms().saturating_sub(since) >= timing.queue_for.as_millis() as u64 {
                        break Err(Fail::failed(format!("{} didn't come online, so Land stopped trying to send.", info.name)));
                    }
                    if t.state != "queued" {
                        t.state = "queued";
                        t.error = None;
                        crate::log::line(format!("land: {who} is away; the send waits"));
                        self.publish(&t);
                        self.keep_waiting(Waiting { tid: tid.clone(), friend: fr.id.clone(), paths: paths.clone(), since });
                    }
                    let hello = self.kick_for(&fr.id);
                    tokio::select! {
                        _ = cancelled(&mut stop) => break Err(Fail::cancelled("Cancelled.")),
                        _ = hello.notified() => {}
                        _ = tokio::time::sleep(timing.queue_retry) => {}
                    }
                }
                Err(f) if f.state == "lost" => {
                    let since = *paused.get_or_insert_with(Instant::now);
                    if since.elapsed() >= timing.retry_for {
                        break Err(Fail::failed(format!("{} didn't come back to finish, so Land stopped trying.", info.name)));
                    }
                    t.state = "paused";
                    t.error = Some(format!("Connection to {} lost. Trying again\u{2026}", info.name));
                    crate::log::line(format!("land: send to {who} paused at {} of {} bytes: {}", t.done, t.total, f.error));
                    self.publish(&t);
                    let wait = timing.retry_first.saturating_mul(2u32.saturating_pow(tries)).min(timing.retry_max);
                    tries += 1;
                    tokio::select! {
                        _ = cancelled(&mut stop) => break Err(Fail::cancelled("Cancelled.")),
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
                other => break other,
            }
        };
        self.cancels.lock().unwrap().remove(&tid);
        // Land turning off: a waiting send stays on disk for next time, and nothing is said.
        if *self.stop.borrow() && t.state == "queued" {
            return;
        }
        self.done_waiting(&tid);
        match result {
            Ok(()) => {
                t.state = "done";
                crate::log::line(format!("land: sent to {who} ({})", t.via.unwrap_or("?")));
            }
            Err(f) => {
                t.state = f.state;
                crate::log::line(format!("land: send to {who} {}: {}", f.state, f.error));
                t.error = Some(f.error);
            }
        }
        self.publish(&t);
    }

    /// Keeps a send that waits for a friend on disk, so it outlives Land turning off.
    fn keep_waiting(&self, w: Waiting) {
        let mut list = self.waiting.lock().unwrap();
        if !list.iter().any(|x| x.tid == w.tid) {
            list.push(w);
            self.save_waiting(&list);
        }
    }

    fn done_waiting(&self, tid: &str) {
        let mut list = self.waiting.lock().unwrap();
        let before = list.len();
        list.retain(|x| x.tid != tid);
        if list.len() != before {
            self.save_waiting(&list);
        }
    }

    fn save_waiting(&self, list: &[Waiting]) {
        let Some(file) = &self.queue_file else { return };
        let temp = file.with_extension("json.tmp");
        let saved = serde_json::to_vec_pretty(list).map_err(io::Error::other).and_then(|bytes| std::fs::write(&temp, bytes)).and_then(|_| std::fs::rename(&temp, file));
        if let Err(e) = saved {
            crate::log::line(format!("land: cannot save the waiting sends: {e}"));
        }
    }

    /// What wakes the sends waiting for a friend.
    fn kick_for(&self, friend: &str) -> Arc<tokio::sync::Notify> {
        self.kicks.lock().unwrap().entry(friend.to_string()).or_default().clone()
    }

    /// A friend's Island was heard from: sends waiting for it go now.
    fn kick(&self, friend: &str) {
        if let Some(n) = self.kicks.lock().unwrap().get(friend) {
            n.notify_waiters();
        }
    }

    /// The sends that waited for friends when Land last stopped: they wait again (or go).
    fn restore_waiting(self: &Arc<Self>) {
        let list = self.waiting.lock().unwrap().clone();
        let Some(far) = self.far.clone() else { return };
        for w in list {
            let Some(friend) = far.friend(&w.friend) else {
                // No longer a friend: nothing to send to.
                self.done_waiting(&w.tid);
                continue;
            };
            let run = self.clone();
            tokio::spawn(async move {
                let paths: Vec<PathBuf> = w.paths.iter().map(PathBuf::from).collect();
                let items = tokio::task::spawn_blocking(move || collect(&paths)).await.ok().and_then(|r| r.ok()).filter(|i| !i.is_empty());
                let info = friend_info(&friend);
                match items {
                    Some(items) => run.start_send(w.tid, info, None, Some(friend), items, w.paths, w.since),
                    None => {
                        run.done_waiting(&w.tid);
                        let mut t = Transfer::new(&w.tid, "out", info, &[]);
                        t.state = "failed";
                        t.error = Some("The files waiting to be sent are gone.".into());
                        run.publish(&t);
                    }
                }
            });
        }
    }

    async fn send_to(&self, peer: &Peer, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>) -> Result<(), Fail> {
        let name = peer.info.name.clone();
        let unreachable = || Fail::failed(format!("Couldn't reach {name}. Check that it's awake, on the same network, and that its firewall lets Island in."));
        let mut stream = tokio::select! {
            _ = cancelled(&mut cancel) => return Err(Fail::cancelled("Cancelled.")),
            r = timeout(CONNECT_TIMEOUT, TcpStream::connect(peer.addr)) => match r {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    // Nothing listens there any more (Island quit, Land turned off): it is gone.
                    if e.kind() == io::ErrorKind::ConnectionRefused && self.peers.lock().unwrap().remove(&peer.info.id).is_some() {
                        self.emit_peers();
                    }
                    return Err(unreachable());
                }
                Err(_) => return Err(unreachable()),
            },
        };
        let _ = stream.set_nodelay(true);
        let ts = timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &self.me, true))
            .await
            .map_err(|_| Fail::failed(format!("{name} didn't finish the secure connection.")))?
            .map_err(|_| Fail::failed(format!("Couldn't set up a secure connection with {name}.")))?;
        if ts.get_remote_static() != Some(&peer.key[..]) {
            return Err(Fail::failed(format!("{name} answered with a different key than it announced, so nothing was sent.")));
        }
        let wire = Arc::new(Wire::new(ts));
        let (rd, wr) = stream.into_split();
        t.via = Some("lan");
        self.exchange(rd, wr, wire, &name, items, offered, t, cancel, None).await
    }

    /// Sends to a friend on another network: dials their Island by key (direct when it can,
    /// through a relay when it can't), then the same exchange as nearby, over one QUIC stream.
    async fn send_far(&self, friend: &crate::anywhere::Friend, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>) -> Result<(), Fail> {
        let name = friend.name.clone();
        let far = self.far.clone().ok_or_else(|| Fail::failed("Turn on Friends on other networks first (Activities \u{203a} Land)."))?;
        let id: iroh::EndpointId = friend.id.parse().map_err(|_| Fail::failed(format!("{name}'s key is damaged. Remove them and add them again.")))?;
        let refused = || Fail::failed(format!("{name} isn't taking files from you. Ask them to add you again with your Land code."));
        let unreachable = || Fail::away(format!("Couldn't reach {name}. Their computer needs Island open, with Friends on other networks on."));
        let limit = self.timing.lock().unwrap().far_connect;
        let conn = tokio::select! {
            _ = cancelled(&mut cancel) => return Err(Fail::cancelled("Cancelled.")),
            r = timeout(limit, far.dial(id, crate::anywhere::ALPN_LAND)) => match r {
                Ok(Ok(c)) => c,
                // Turned away before the handshake was over on this side.
                Ok(Err(e)) if e.contains(&crate::anywhere::NOT_A_FRIEND.to_string()) => return Err(refused()),
                _ => return Err(unreachable()),
            },
        };
        t.via = Some(crate::anywhere::via(&conn));
        let result = match conn.open_bi().await {
            Ok((send, recv)) => self.exchange(recv, send, Arc::new(Wire::Plain), &name, items, offered, t, cancel, Some(&conn)).await,
            Err(_) => Err(Fail::failed(format!("The connection to {name} dropped."))),
        };
        let was_refused = crate::anywhere::refused(&conn);
        conn.close(VarInt::from_u32(0), b"done");
        match result {
            Err(_) if was_refused => Err(refused()),
            r => r,
        }
    }

    /// Offers the files, waits for the answer, sends them, and waits for "saved": the same over
    /// TCP + Noise (computers nearby) and over QUIC (friends; `conn` reports the path as it changes).
    #[allow(clippy::too_many_arguments)]
    async fn exchange<R, W>(&self, mut rd: R, mut wr: W, wire: Arc<Wire>, name: &str, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>, conn: Option<&Connection>) -> Result<(), Fail>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin,
    {
        let name = name.to_string();
        let lost = || Fail::failed(format!("The connection to {name} dropped."));
        // Trying again after a drop, or a friend back after waiting: waiting for the receiver once more.
        if t.state == "paused" || t.state == "queued" {
            t.state = "waiting";
            t.error = None;
            self.publish(t);
        }
        // `tid` stays the same on every try, so the receiver knows the transfer when it comes back.
        let offer = json!({ "t": "offer", "from": self.name(), "os": std::env::consts::OS, "files": offered, "tid": t.id });
        send_json(&mut wr, &wire, &offer).await.map_err(|_| lost())?;

        // The receiving user decides; the receiver gives up after ASK_FOR.
        let answer = tokio::select! {
            _ = cancelled(&mut cancel) => {
                let _ = send_json(&mut wr, &wire, &json!({ "t": "cancel" })).await;
                return Err(Fail::cancelled("Cancelled."));
            }
            r = recv_for(&mut rd, &wire, ASK_FOR + Duration::from_secs(15)) => r,
        };
        // "have": what the receiver already holds of each file, when this is a transfer coming back.
        let have: Vec<u64> = match answer {
            Ok(Msg::Json(v)) if v["t"] == "accept" => v["have"].as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0)).collect()).unwrap_or_default(),
            Ok(Msg::Json(v)) if v["t"] == "decline" && v["why"] == "cancelled" => return Err(Fail::cancelled(format!("{name} cancelled."))),
            Ok(Msg::Json(v)) if v["t"] == "decline" => return Err(Fail::declined(why_declined(v["why"].as_str().unwrap_or(""), &name))),
            Err(e) if e == "timed out" => return Err(Fail::declined(why_declined("timeout", &name))),
            _ => return Err(lost()),
        };
        let have: Vec<u64> = items.iter().enumerate().map(|(i, it)| have.get(i).copied().unwrap_or(0).min(it.size)).collect();
        // From here a dropped connection is worth trying again: the receiver keeps what arrived.
        let gone = || Fail::lost(format!("The connection to {name} dropped."));
        t.done = have.iter().sum();
        t.state = "sending";
        self.publish(t);

        // While the files go, a reader listens for the receiver (a cancel, or "saved" at the end).
        let (ctl_tx, mut ctl_rx) = mpsc::channel::<Result<Value, String>>(4);
        let reader_wire = wire.clone();
        let reader = tokio::spawn(async move {
            loop {
                let m = recv(&mut rd, &reader_wire).await;
                let end = !matches!(m, Ok(Msg::Json(_)));
                let msg = match m {
                    Ok(Msg::Json(v)) => Ok(v),
                    Ok(Msg::Data(_)) => Err("unexpected data".to_string()),
                    Err(e) => Err(e),
                };
                if ctl_tx.send(msg).await.is_err() || end {
                    break;
                }
            }
        });
        let _reader = AbortOnDrop(reader.abort_handle());
        let mut plain = vec![0u8; CHUNK + 1];
        plain[0] = F_DATA;
        let mut last = Instant::now();
        for (item, &skip) in items.iter().zip(&have) {
            let mut file = tokio::fs::File::open(&item.path).await.map_err(|_| Fail::failed(format!("Couldn't open {}.", item.name)))?;
            if skip > 0 {
                file.seek(io::SeekFrom::Start(skip)).await.map_err(|_| Fail::failed(format!("Couldn't read {}.", item.name)))?;
            }
            let mut file = tokio::io::BufReader::with_capacity(1 << 20, file);
            let mut left = item.size - skip;
            while left > 0 {
                if *cancel.borrow() {
                    let _ = send_json(&mut wr, &wire, &json!({ "t": "cancel" })).await;
                    return Err(Fail::cancelled("Cancelled."));
                }
                if let Ok(m) = ctl_rx.try_recv() {
                    return Err(match m {
                        Ok(v) if v["t"] == "cancel" => Fail::cancelled(format!("{name} cancelled.")),
                        Ok(v) if v["t"] == "error" => Fail::failed(format!("{name} couldn't save the files.")),
                        _ => gone(),
                    });
                }
                let want = (left as usize).min(CHUNK);
                let got = read_up_to(&mut file, &mut plain[1..1 + want]).await.map_err(|_| Fail::failed(format!("Couldn't read {}.", item.name)))?;
                if got < want {
                    let _ = send_json(&mut wr, &wire, &json!({ "t": "error" })).await;
                    return Err(Fail::failed(format!("{} changed while it was being sent.", item.name)));
                }
                let frame = wire.seal(&plain[..1 + want]).map_err(Fail::failed)?;
                timeout(IO_TIMEOUT, wr.write_all(&frame)).await.map_err(|_| gone())?.map_err(|_| gone())?;
                left -= want as u64;
                t.done += want as u64;
                #[cfg(test)]
                {
                    let cut = self.cut.load(Ordering::Relaxed);
                    if cut > 0 && t.done >= cut {
                        // As if the network dropped: the connection goes with this return.
                        self.cut.store(0, Ordering::Relaxed);
                        return Err(gone());
                    }
                }
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    if let Some(c) = conn {
                        t.via = Some(crate::anywhere::via(c));
                    }
                    self.publish(t);
                }
            }
        }
        send_json(&mut wr, &wire, &json!({ "t": "done" })).await.map_err(|_| gone())?;
        self.publish(t);
        // Done when the receiver says every file has its name.
        match timeout(Duration::from_secs(60), ctl_rx.recv()).await {
            Ok(Some(Ok(v))) if v["t"] == "saved" => Ok(()),
            Ok(Some(Ok(v))) if v["t"] == "cancel" => Err(Fail::cancelled(format!("{name} cancelled."))),
            Ok(Some(Ok(v))) if v["t"] == "error" => Err(Fail::failed(format!("{name} couldn't save the files."))),
            _ => Err(Fail::failed(format!("{name} didn't confirm the files arrived."))),
        }
    }

    // -------------------------------------------------------------- receiving

    async fn receive(self: Arc<Self>, mut stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let Ok(Ok(ts)) = timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &self.me, false)).await else { return };
        let sender = device_id(ts.get_remote_static().unwrap_or_default());
        let wire = Arc::new(Wire::new(ts));
        let (mut rd, mut wr) = stream.into_split();
        // The name it announced, if it did; else the one in its offer.
        let known = self.peers.lock().unwrap().get(&sender).map(|p| p.info.clone());
        self.receive_on(&mut rd, &mut wr, &wire, sender, known, None).await;
    }

    /// A friend's Island sends from another network: one QUIC stream, the same exchange as nearby.
    /// A connection that never opens a stream was only checking that this Island is online.
    async fn receive_far(self: Arc<Self>, conn: Connection) {
        let from = conn.remote_id().to_string();
        // Heard from: sends waiting for this friend go now.
        self.kick(&from);
        let Ok(Ok((mut send, mut recv))) = timeout(HANDSHAKE_TIMEOUT, conn.accept_bi()).await else { return };
        let known = self.far.as_ref().and_then(|f| f.friend(&from)).map(|f| PeerInfo { id: from.clone(), name: f.name, os: String::new(), anywhere: Some(from.clone()) });
        self.receive_on(&mut recv, &mut send, &Arc::new(Wire::Plain), from, known, Some(&conn)).await;
        // Let the last message ("saved", or a decline) arrive: the sender closes the connection.
        let _ = send.finish();
        let _ = timeout(Duration::from_secs(10), conn.closed()).await;
    }

    /// An offer arrives: carry on with one accepted before its connection dropped, or ask this
    /// user, then take the files. `known` is who the sender is when that is known (a computer
    /// that announced itself, a friend); else its offer names it.
    async fn receive_on<R, W>(self: &Arc<Self>, rd: &mut R, wr: &mut W, wire: &Arc<Wire>, sender: String, known: Option<PeerInfo>, conn: Option<&Connection>)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let Ok(Msg::Json(v)) = recv_for(rd, wire, Duration::from_secs(15)).await else { return };
        let Some(offer) = Offer::parse(&v) else {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "bad" })).await;
            return;
        };
        let peer = match known {
            Some(mut p) => {
                if p.os.is_empty() {
                    p.os = offer.os.clone();
                }
                p
            }
            None => PeerInfo { id: sender.clone(), name: offer.from.clone(), os: offer.os.clone(), anywhere: None },
        };
        let via = conn.map(crate::anywhere::via).unwrap_or("lan");
        let key = offer.tid.as_ref().map(|tid| resume_key(&sender, tid));

        // The same transfer, back after its connection dropped: no asking again.
        if let Some(key) = &key {
            if self.refused_resume.lock().unwrap().get(key).is_some_and(|at| at.elapsed() < RESUME_REFUSED) {
                let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "cancelled" })).await;
                return;
            }
            let back = self.paused.lock().unwrap().remove(key);
            if let Some(p) = back {
                if p.files == offer.files {
                    let have = p.landing.have();
                    let mut t = p.transfer;
                    if send_json(wr, wire, &json!({ "t": "accept", "have": have })).await.is_err() {
                        self.pause(key.clone(), p.files, t, p.landing);
                        return;
                    }
                    t.done = have.iter().sum();
                    t.via = Some(via);
                    crate::log::line(format!("land: {} is back, {} of {} bytes already here", short(&peer.id), t.done, t.total));
                    self.receive_files(rd, wr, wire, &offer, Some(key.clone()), t, p.landing, conn).await;
                    return;
                }
                // The files changed meanwhile: the old pieces go, and this is a new offer.
                let mut old = p.transfer;
                old.state = "failed";
                old.error = Some(format!("{} changed the files, so they come again as a new offer.", peer.name));
                self.publish(&old);
            }
        }

        let id = self.next_id("in");
        let mut t = Transfer::new(&id, "in", peer.clone(), &offer.files);
        t.via = Some(via);

        let quiet = self.declined.lock().unwrap().get(&sender).is_some_and(|t| t.elapsed() < DECLINE_QUIET);
        let busy = quiet || {
            let asks = self.asks.lock().unwrap();
            asks.len() >= MAX_ASKING || asks.values().any(|(from, _)| *from == sender)
        };
        if busy {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "busy" })).await;
            return;
        }
        if free_space(&self.downloads).is_some_and(|free| free < offer.total.saturating_add(SPARE_BYTES)) {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "space" })).await;
            t.state = "failed";
            t.error = Some(format!("{} tried to send you files, but Downloads doesn't have room for them.", peer.name));
            self.publish(&t);
            return;
        }

        let (tx, rx) = oneshot::channel();
        self.asks.lock().unwrap().insert(id.clone(), (sender.clone(), tx));
        t.state = "asking";
        t.expires = Some(now_ms() + ASK_FOR.as_millis() as u64);
        self.publish(&t);
        crate::log::line(format!("land: {} offers {} files ({} bytes)", short(&peer.id), t.count, t.total));
        enum Said {
            Yes,
            No,
            Late,
            Gone,
        }
        let said = tokio::select! {
            a = rx => if a.unwrap_or(false) { Said::Yes } else { Said::No },
            _ = tokio::time::sleep(ASK_FOR) => Said::Late,
            // The sender cancelled, or went away.
            _ = recv(rd, wire) => Said::Gone,
        };
        self.asks.lock().unwrap().remove(&id);
        t.expires = None;
        match said {
            Said::Yes => {}
            Said::No | Said::Late => {
                let why = if matches!(said, Said::Late) { "timeout" } else { "declined" };
                if why == "declined" {
                    let mut declined = self.declined.lock().unwrap();
                    declined.retain(|_, t| t.elapsed() < DECLINE_QUIET);
                    declined.insert(sender.clone(), Instant::now());
                }
                let _ = send_json(wr, wire, &json!({ "t": "decline", "why": why })).await;
                t.state = "declined";
                t.error = Some(if why == "timeout" { "Not answered in time.".into() } else { "Declined.".into() });
                self.publish(&t);
                crate::log::line(format!("land: offer from {} {why}", short(&peer.id)));
                return;
            }
            Said::Gone => {
                t.state = "cancelled";
                t.error = Some(format!("{} cancelled.", peer.name));
                self.publish(&t);
                return;
            }
        }
        if send_json(wr, wire, &json!({ "t": "accept" })).await.is_err() {
            t.state = "failed";
            t.error = Some(format!("The connection to {} dropped.", peer.name));
            self.publish(&t);
            return;
        }
        let landing = match Landing::new(&self.downloads, &offer.files) {
            Ok(l) => l,
            Err(e) => {
                let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                t.state = "failed";
                t.error = Some(format!("Couldn't write to Downloads: {e}"));
                self.publish(&t);
                return;
            }
        };
        self.receive_files(rd, wr, wire, &offer, key, t, landing, conn).await;
    }

    /// Takes the files of an accepted transfer. A dropped connection keeps the pieces for the
    /// sender to come back (when its offer can be matched again: `key`); anything else ends it.
    #[allow(clippy::too_many_arguments)]
    async fn receive_files<R, W>(self: &Arc<Self>, rd: &mut R, wr: &mut W, wire: &Arc<Wire>, offer: &Offer, key: Option<String>, mut t: Transfer, mut landing: Landing, conn: Option<&Connection>)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let id = t.id.clone();
        let who = short(&t.peer.id).to_string();
        let (ctx, crx) = watch::channel(false);
        self.cancels.lock().unwrap().insert(id.clone(), ctx);
        t.state = "receiving";
        t.error = None;
        self.publish(&t);
        let result = self.take_files(rd, wr, wire, &mut landing, &mut t, crx, conn).await;
        self.cancels.lock().unwrap().remove(&id);
        match (result, key) {
            (Ok(saved), _) => {
                t.state = "done";
                t.saved = saved.iter().map(|p| p.to_string_lossy().to_string()).collect();
                t.folder = Some(self.downloads.to_string_lossy().to_string());
                crate::log::line(format!("land: received {} files from {who} ({})", t.count, t.via.unwrap_or("?")));
            }
            (Err(f), Some(key)) if f.state == "lost" => {
                t.state = "paused";
                t.error = Some(format!("Connection lost. Continues when {} is back.", t.peer.name));
                crate::log::line(format!("land: receive from {who} paused at {} of {} bytes", t.done, t.total));
                self.publish(&t);
                self.pause(key, offer.files.clone(), t, landing);
                return;
            }
            (Err(f), _) => {
                t.state = if f.state == "lost" { "failed" } else { f.state };
                crate::log::line(format!("land: receive from {who} {}: {}", t.state, f.error));
                t.error = Some(f.error);
            }
        }
        self.publish(&t);
    }

    /// Keeps a dropped transfer's pieces for its sender to come back; after `pause_keep` they go.
    fn pause(self: &Arc<Self>, key: String, files: Vec<OfferFile>, transfer: Transfer, landing: Landing) {
        let epoch = self.seq.fetch_add(1, Ordering::Relaxed);
        let keep = self.timing.lock().unwrap().pause_keep;
        self.paused.lock().unwrap().insert(key.clone(), Paused { files, transfer, landing, epoch });
        let run = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(keep).await;
            let Some(run) = run.upgrade() else { return };
            let expired = {
                let mut paused = run.paused.lock().unwrap();
                if paused.get(&key).is_some_and(|p| p.epoch == epoch) {
                    paused.remove(&key)
                } else {
                    None
                }
            };
            if let Some(p) = expired {
                let mut t = p.transfer;
                t.state = "failed";
                t.error = Some(format!("{} didn't come back to finish, so the pieces were removed.", t.peer.name));
                crate::log::line(format!("land: dropped receive from {} expired", short(&t.peer.id)));
                run.publish(&t);
                // `p.landing` goes here, and its pieces with it.
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn take_files<R, W>(&self, rd: &mut R, wr: &mut W, wire: &Wire, landing: &mut Landing, t: &mut Transfer, mut cancel: watch::Receiver<bool>, conn: Option<&Connection>) -> Result<Vec<PathBuf>, Fail>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let name = t.peer.name.clone();
        // The connection dropped: what arrived stays, for the sender to come back.
        let gone = || Fail::lost(format!("The connection to {name} dropped."));
        let broken = || Fail::failed(format!("{name} sent something Land doesn't expect."));
        let disk = |e: io::Error| Fail::failed(format!("Couldn't write to Downloads: {e}"));
        let mut last = Instant::now();
        for i in 0..landing.targets.len() {
            let target = landing.targets[i].clone();
            let (file, mut left) = if let Some(temp) = landing.temps.get(i) {
                // Begun before the connection dropped: carry on from what is on disk.
                let had = std::fs::metadata(temp).map(|m| m.len()).unwrap_or(0).min(target.size);
                let mut f = tokio::fs::OpenOptions::new().write(true).open(temp).await.map_err(disk)?;
                f.set_len(had).await.map_err(disk)?;
                f.seek(io::SeekFrom::Start(had)).await.map_err(disk)?;
                (f, target.size - had)
            } else {
                let (temp, f) = match create_temp(&target.dir, &target.name).await {
                    Ok(x) => x,
                    Err(e) => {
                        let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                        return Err(disk(e));
                    }
                };
                landing.litter.temps.push(temp.clone());
                landing.temps.push(temp);
                (f, target.size)
            };
            let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);
            while left > 0 {
                let m = tokio::select! {
                    _ = cancelled(&mut cancel) => {
                        let _ = send_json(wr, wire, &json!({ "t": "cancel" })).await;
                        return Err(Fail::cancelled("Cancelled."));
                    }
                    m = recv_for(rd, wire, IO_TIMEOUT) => m,
                };
                match m {
                    Ok(Msg::Data(d)) if (d.len() as u64) <= left => {
                        if let Err(e) = out.write_all(&d).await {
                            let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                            return Err(disk(e));
                        }
                        left -= d.len() as u64;
                        t.done += d.len() as u64;
                        if last.elapsed() >= PROGRESS_EVERY {
                            last = Instant::now();
                            if let Some(c) = conn {
                                t.via = Some(crate::anywhere::via(c));
                            }
                            self.publish(t);
                        }
                    }
                    Ok(Msg::Json(v)) if v["t"] == "cancel" => return Err(Fail::cancelled(format!("{name} cancelled."))),
                    Ok(Msg::Json(v)) if v["t"] == "error" => return Err(Fail::failed(format!("{name} couldn't read one of the files."))),
                    Err(_) => {
                        // Every byte that arrived stays on disk for the resume.
                        let _ = out.flush().await;
                        return Err(gone());
                    }
                    _ => return Err(broken()),
                }
            }
            out.flush().await.map_err(disk)?;
        }
        match recv_for(rd, wire, IO_TIMEOUT).await {
            Ok(Msg::Json(v)) if v["t"] == "done" => {}
            Ok(Msg::Json(v)) if v["t"] == "cancel" => return Err(Fail::cancelled(format!("{name} cancelled."))),
            Err(_) => return Err(gone()),
            _ => return Err(broken()),
        }
        // Every byte is in: the files get their names, never over a file that is there.
        let mut saved: Vec<PathBuf> = Vec::new();
        for (target, temp) in landing.targets.iter().zip(&landing.temps) {
            let at = place(temp, &target.dir, &target.name).map_err(|e| Fail::failed(format!("Couldn't save {}: {e}", target.name)))?;
            mark_from_network(&at);
            let shown = target.root.clone().unwrap_or(at);
            if !saved.contains(&shown) {
                saved.push(shown);
            }
        }
        landing.litter.keep = true;
        let _ = send_json(wr, wire, &json!({ "t": "saved" })).await;
        Ok(saved)
    }
}

/// Reads until `buf` is full or the file ends; the count read.
async fn read_up_to(r: &mut (impl AsyncReadExt + Unpin), buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        let n = r.read(&mut buf[got..]).await?;
        if n == 0 {
            break;
        }
        got += n;
    }
    Ok(got)
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
    /// Why the relay setting was not used (n0's relays are, instead).
    relay_error: Option<String>,
}

fn info(run: &Running, fresh: bool, relay_error: Option<String>) -> LandInfo {
    let friends = run.far().map(|f| f.friends()).unwrap_or_default();
    LandInfo { id: run.id().into(), name: run.name(), visible: run.visible, peers: run.peers(), fresh, friends, relay_error }
}

/// Turns Land on (or updates its name, its visibility, and whether friends on other networks
/// can reach it). Idempotent.
#[tauri::command]
pub async fn land_start(app: tauri::AppHandle, state: tauri::State<'_, LandState>, name: Option<String>, visible: bool, anywhere: Option<bool>, relay: Option<String>) -> Result<LandInfo, String> {
    use tauri::Emitter;
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(computer_name);
    let anywhere = anywhere.unwrap_or(false);
    // Our own relay when the setting holds a good address; a bad one falls back to n0's, and says so.
    let (relay, relay_error) = match relay.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(text) => match crate::anywhere::relay_url(text) {
            Ok(url) => (Some(url), None),
            Err(e) => (None, Some(e)),
        },
        None => (None, None),
    };
    let relay_text = relay.as_ref().map(|u| u.to_string());
    let mut slot = state.run.lock().await;
    if let Some(run) = slot.as_ref() {
        if run.visible == visible && run.anywhere == anywhere && (!anywhere || run.relay == relay_text) {
            run.rename(&name).await;
            return Ok(info(run, false, relay_error));
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
        let relays = relay.map(crate::anywhere::Relays::Mine).unwrap_or(crate::anywhere::Relays::N0);
        Some(crate::anywhere::Setup { key, relays, book: crate::anywhere::book_file() })
    } else {
        None
    };
    let run = start(me, Options { name, visible, downloads: downloads_dir(), discovery: DISCOVERY_PORT, anywhere: setup }, emit).await?;
    let info = info(&run, fresh, relay_error);
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

#[tauri::command]
pub async fn land_send(state: tauri::State<'_, LandState>, peer: String, paths: Vec<String>) -> Result<String, String> {
    let run = running(&state).await?;
    run.send(&peer, paths.into_iter().map(PathBuf::from).collect()).await
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

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("island-land-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hello_round_trips_and_rejects_forgeries() {
        let me = Identity::generate().unwrap();
        let h = Hello::new("here", &me, "Moss's PC", 5000);
        let (back, key) = Hello::decode(&h.encode()).unwrap();
        assert_eq!(back.id, me.id);
        assert_eq!(back.name, "Moss's PC");
        assert_eq!(key, me.public);
        // An id that is not the key's.
        let other = Identity::generate().unwrap();
        let forged = Hello { id: other.id.clone(), ..h.clone() };
        assert!(Hello::decode(&forged.encode()).is_none());
        // Another app, another version, another kind, junk.
        assert!(Hello::decode(&Hello { land: 2, ..h.clone() }.encode()).is_none());
        assert!(Hello::decode(&Hello { t: "hi".into(), ..h.clone() }.encode()).is_none());
        assert!(Hello::decode(b"{\"land\":1}").is_none());
        assert!(Hello::decode(&[b'x'; 3000]).is_none());
        // Names and systems are cleaned.
        let odd = Hello { name: "  \u{7}Lab\nPC  ".into(), os: "plan9".into(), ..h };
        let (clean, _) = Hello::decode(&odd.encode()).unwrap();
        assert_eq!(clean.name, "LabPC");
        assert_eq!(clean.os, "other");
    }

    #[test]
    fn device_ids_are_short_and_stable() {
        let me = Identity::generate().unwrap();
        assert_eq!(me.id.len(), 16);
        assert_eq!(device_id(&me.public), me.id);
        let dir = temp_dir("key");
        let file = dir.join("land.key");
        let a = Identity::load_or_create(&file).unwrap();
        let b = Identity::load_or_create(&file).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.private, b.private);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_local_network_counts() {
        let nets = [Net { ip: Ipv4Addr::new(192, 168, 1, 20), prefix: 24 }, Net { ip: Ipv4Addr::new(100, 101, 102, 103), prefix: 32 }];
        assert!(is_local("192.168.1.77".parse().unwrap(), &nets));
        assert!(is_local("127.0.0.1".parse().unwrap(), &nets));
        assert!(is_local("::ffff:192.168.1.5".parse().unwrap(), &nets));
        assert!(!is_local("192.168.2.77".parse().unwrap(), &nets), "another subnet");
        assert!(!is_local("8.8.8.8".parse().unwrap(), &nets), "the internet");
        assert!(!is_local("100.101.102.104".parse().unwrap(), &nets), "a VPN's /32 is no local network");
        assert!(!is_local("fe80::1".parse().unwrap(), &nets));
        let n = Net { ip: Ipv4Addr::new(10, 0, 5, 9), prefix: 16 };
        assert_eq!(n.broadcast(), Ipv4Addr::new(10, 0, 255, 255));
        assert!(n.contains(Ipv4Addr::new(10, 0, 200, 1)));
    }

    #[test]
    fn incoming_names_cannot_escape_or_break_windows() {
        assert_eq!(clean_rel("../../etc/passwd"), vec!["etc", "passwd"]);
        assert_eq!(clean_rel("..\\..\\Windows\\win.ini"), vec!["Windows", "win.ini"]);
        assert_eq!(clean_rel("/abs/path.txt"), vec!["abs", "path.txt"]);
        assert_eq!(clean_rel("C:\\x\\y.txt"), vec!["C_", "x", "y.txt"]);
        assert_eq!(clean_rel("a<b>c?.txt"), vec!["a_b_c_.txt"]);
        assert_eq!(clean_rel("con.txt"), vec!["_con.txt"]);
        assert_eq!(clean_rel("COM1"), vec!["_COM1"]);
        assert_eq!(clean_rel("notes. . "), vec!["notes"]);
        assert_eq!(clean_rel("..."), vec!["file"]);
        assert_eq!(clean_rel(""), vec!["file"]);
        let long = format!("{}.jpeg", "x".repeat(400));
        let c = clean_rel(&long);
        assert_eq!(c[0].chars().count(), 150);
        assert!(c[0].ends_with(".jpeg"));
        assert_eq!(clean_rel(&"a/".repeat(100)).len(), MAX_DEPTH);
    }

    #[test]
    fn names_get_a_number_instead_of_replacing() {
        assert_eq!(candidate("photo.jpg", 0, false), "photo.jpg");
        assert_eq!(candidate("photo.jpg", 2, false), "photo (2).jpg");
        assert_eq!(candidate(".bashrc", 1, false), ".bashrc (1)");
        assert_eq!(candidate("my.folder", 1, true), "my.folder (1)");
        let dir = temp_dir("place");
        std::fs::write(dir.join("a.txt"), "old").unwrap();
        let temp = dir.join("a.txt.landing");
        std::fs::write(&temp, "new").unwrap();
        let at = place(&temp, &dir, "a.txt").unwrap();
        assert_eq!(at, dir.join("a (1).txt"));
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(&at).unwrap(), "new");
        assert!(!temp.exists());
        assert_eq!(reserve_dir(&dir, "Photos").unwrap(), dir.join("Photos"));
        assert_eq!(reserve_dir(&dir, "Photos").unwrap(), dir.join("Photos (1)"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn files_group_into_what_was_dropped() {
        let files = |names: &[(&str, u64)]| names.iter().map(|(n, s)| OfferFile { name: n.to_string(), size: *s, mtime: 0 }).collect::<Vec<_>>();
        let t = tops(&files(&[("Trip/a.jpg", 3), ("notes.txt", 1), ("trip/b/c.jpg", 4), ("../Trip", 9)]));
        assert_eq!(
            t,
            vec![
                Top { name: "Trip".into(), size: 7, files: 2, dir: true },
                Top { name: "notes.txt".into(), size: 1, files: 1, dir: false },
                Top { name: "Trip".into(), size: 9, files: 1, dir: false },
            ]
        );
        let many: Vec<OfferFile> = (0..50).map(|i| OfferFile { name: format!("f{i}"), size: 1, mtime: 0 }).collect();
        let tr = Transfer::new("x", "in", PeerInfo { id: "p".into(), name: "P".into(), os: "macos".into(), anywhere: None }, &many);
        assert_eq!((tr.count, tr.total, tr.items.len()), (50, 50, LISTED));
    }

    #[test]
    fn offers_are_checked() {
        let ok = json!({ "t": "offer", "from": "Lab\u{1}PC", "os": "macos", "files": [{ "name": "a.txt", "size": 3 }, { "name": "b/c.txt", "size": 4 }] });
        let o = Offer::parse(&ok).unwrap();
        assert_eq!(o.total, 7);
        assert_eq!(o.from, "LabPC");
        assert_eq!(o.files.len(), 2);
        assert!(Offer::parse(&json!({ "t": "offer", "files": [] })).is_none());
        assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "", "size": 1 }] })).is_none());
        assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "a", "size": -1 }] })).is_none());
        assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "a", "size": u64::MAX }, { "name": "b", "size": 1 }] })).is_none(), "an overflowing total");
        assert!(Offer::parse(&json!({ "t": "accept" })).is_none());
    }

    #[test]
    fn folders_are_walked_without_links_or_junk() {
        let dir = temp_dir("walk");
        let top = dir.join("Trip");
        std::fs::create_dir_all(top.join("day 1")).unwrap();
        std::fs::write(top.join("day 1").join("beach.jpg"), b"12345").unwrap();
        std::fs::write(top.join("notes.txt"), b"hi").unwrap();
        std::fs::write(top.join(".DS_Store"), b"junk").unwrap();
        std::fs::write(dir.join("solo.pdf"), b"pdf!").unwrap();
        let mut items = collect(&[top.clone(), dir.join("solo.pdf")]).unwrap();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["Trip/day 1/beach.jpg", "Trip/notes.txt", "solo.pdf"]);
        assert_eq!(items.iter().map(|i| i.size).sum::<u64>(), 11);
        let s = stage(&top.to_string_lossy());
        assert!(s.dir);
        assert_eq!((s.files, s.size), (2, 7));
        assert!(stage(&dir.join("missing").to_string_lossy()).error.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---------------------------------------------------------------- end to end, over loopback

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    fn recorder() -> (Emit, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (Arc::new(move |e: &str, v: Value| sink.lock().unwrap().push((e.to_string(), v))), events)
    }

    fn last_state(events: &Events, dir: &str) -> Option<Value> {
        events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["dir"] == dir).map(|(_, v)| v.clone())
    }

    async fn wait_for(events: &Events, dir: &str, state: &str) -> Value {
        for _ in 0..400 {
            if let Some(v) = last_state(events, dir) {
                if v["state"] == state {
                    return v;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("no {dir} transfer reached {state}: {:?}", last_state(events, dir));
    }

    async fn wait_id(events: &Events, id: &str, state: &str) -> Value {
        for _ in 0..400 {
            let last = events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
            if let Some(v) = last.filter(|v| v["state"] == state) {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("transfer {id} never reached {state}");
    }

    /// Land anywhere without relays, its friends kept in `dir`.
    fn far_setup(dir: &Path) -> Option<crate::anywhere::Setup> {
        Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::Off, book: dir.join("land-friends.json") })
    }

    #[tokio::test]
    async fn land_asks_friends_under_its_current_name() {
        let (ea, _) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Moss".into(), visible: false, downloads: temp_dir("far-a"), discovery: 0, anywhere: far_setup(&temp_dir("far-a-book")) }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Alex".into(), visible: false, downloads: temp_dir("far-b"), discovery: 0, anywhere: far_setup(&temp_dir("far-b-book")) }, eb).await.unwrap();
        a.rename("Moss's laptop").await;
        let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
        let asking = tokio::spawn({
            let (fa, to) = (fa.clone(), fb.addr());
            async move { fa.ask(to).await }
        });
        let mut ask = None;
        for _ in 0..400 {
            ask = b_events.lock().unwrap().iter().find(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").map(|(_, v)| v.clone());
            if ask.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let ask = ask.expect("the request reached Alex's island");
        assert_eq!(ask["from"]["name"], "Moss's laptop");
        assert!(fb.answer(ask["id"].as_str().unwrap(), crate::anywhere::Reply::Add));
        assert_eq!(asking.await.unwrap().unwrap().name, "Alex");
        a.shutdown().await;
        b.shutdown().await;
    }

    // ------------------------------------------------------------ resume after a drop

    /// Whether an event with this transfer id and state was ever published.
    async fn wait_seen(events: &Events, id: &str, state: &str) {
        for _ in 0..400 {
            if events.lock().unwrap().iter().any(|(e, v)| e == "land-transfer" && v["id"] == id && v["state"] == state) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("transfer {id} was never {state}");
    }

    /// Retries come fast in tests.
    fn quick(run: &Running) {
        run.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(400), retry_for: Duration::from_secs(20), pause_keep: Duration::from_secs(20), ..Timing::default() });
    }

    fn landing_files(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let path = e.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.to_string_lossy().ends_with(".landing") {
                    found.push(path);
                }
            }
        }
        found
    }

    fn asks(events: &Events) -> usize {
        events.lock().unwrap().iter().filter(|(e, v)| e == "land-transfer" && v["state"] == "asking").count()
    }

    /// A megabyte where every byte's place shows (a resume that skips or repeats one fails).
    fn megabyte() -> Vec<u8> {
        (0..1_000_000u32).map(|i| (i % 251) as u8).collect()
    }

    async fn resumes(p: Pair, to: String) {
        quick(&p.a);
        quick(&p.b);
        let data = megabyte();
        std::fs::write(p.source.join("big.bin"), &data).unwrap();
        p.a.cut_after(300_000);
        let id = p.a.send(&to, vec![p.source.join("big.bin")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        let in_id = ask["id"].as_str().unwrap().to_string();
        p.b.answer(&in_id, true);
        wait_seen(&p.b_events, &in_id, "paused").await;
        wait_seen(&p.a_events, &id, "paused").await;
        wait_id(&p.a_events, &id, "done").await;
        wait_id(&p.b_events, &in_id, "done").await;
        assert_eq!(std::fs::read(p.downloads.join("big.bin")).unwrap(), data);
        assert_eq!(asks(&p.b_events), 1, "the second offer was the same transfer, already accepted");
        assert!(landing_files(&p.downloads).is_empty());
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_dropped_transfer_picks_up_where_it_left_off() {
        let p = pair("resume").await;
        let to = p.b.me.id.clone();
        resumes(p, to).await;
    }

    #[tokio::test]
    async fn a_dropped_transfer_to_a_friend_picks_up_where_it_left_off() {
        let p = far_pair("resume-far").await;
        let to = p.b.far().unwrap().id().to_string();
        resumes(p, to).await;
    }

    #[tokio::test]
    async fn cancelling_a_paused_transfer_stops_the_retries_and_its_files() {
        let p = pair("resume-cancel").await;
        quick(&p.b);
        p.a.set_timing(Timing { retry_first: Duration::from_millis(800), retry_max: Duration::from_secs(2), retry_for: Duration::from_secs(20), pause_keep: Duration::from_secs(20), ..Timing::default() });
        std::fs::write(p.source.join("big.bin"), megabyte()).unwrap();
        p.a.cut_after(300_000);
        let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        let in_id = ask["id"].as_str().unwrap().to_string();
        p.b.answer(&in_id, true);
        wait_seen(&p.b_events, &in_id, "paused").await;
        assert!(p.b.cancel(&in_id));
        wait_id(&p.b_events, &in_id, "cancelled").await;
        let t = wait_id(&p.a_events, &id, "cancelled").await;
        assert_eq!(t["error"], "Receiver cancelled.");
        assert!(landing_files(&p.downloads).is_empty());
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_paused_transfer_nobody_resumes_is_cleaned_up() {
        let p = pair("resume-expire").await;
        // The sender gives up at once; the receiver keeps the pieces a moment.
        p.a.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(50), retry_for: Duration::ZERO, pause_keep: Duration::from_secs(20), ..Timing::default() });
        p.b.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(50), retry_for: Duration::ZERO, pause_keep: Duration::from_millis(300), ..Timing::default() });
        std::fs::write(p.source.join("big.bin"), megabyte()).unwrap();
        p.a.cut_after(300_000);
        let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        let in_id = ask["id"].as_str().unwrap().to_string();
        p.b.answer(&in_id, true);
        let t = wait_id(&p.a_events, &id, "failed").await;
        assert!(t["error"].as_str().unwrap().contains("didn't come back"), "{t}");
        let t = wait_id(&p.b_events, &in_id, "failed").await;
        assert!(t["error"].as_str().unwrap().contains("didn't come back"), "{t}");
        assert!(landing_files(&p.downloads).is_empty());
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    // ------------------------------------------------------------ friends who are away

    /// A Land with Land anywhere on, its friends and waiting sends in `dir`: start it again with
    /// the same key and dir to restart that Island.
    async fn far_land(name: &str, key: &iroh::SecretKey, dir: &Path, events: Emit) -> Arc<Running> {
        let anywhere = Some(crate::anywhere::Setup { key: key.clone(), relays: crate::anywhere::Relays::Off, book: dir.join("land-friends.json") });
        start(Identity::generate().unwrap(), Options { name: name.into(), visible: false, downloads: dir.join("Downloads"), discovery: 0, anywhere }, events).await.unwrap()
    }

    /// Dialling someone away fails fast, the regular try is far off (so only a hello can be what
    /// sends), and a starting Island says hello at once.
    fn waits(run: &Running) {
        run.set_timing(Timing { far_connect: Duration::from_millis(500), queue_retry: Duration::from_secs(60), hello_after: Duration::from_millis(50), ..Timing::default() });
    }

    struct Away {
        root: PathBuf,
        ka: iroh::SecretKey,
        kb: iroh::SecretKey,
        a: Arc<Running>,
        a_events: Events,
        id: String,
    }

    /// `a` sends a note to its friend `b`, whose Island is off: the send waits.
    async fn send_to_someone_away(tag: &str) -> Away {
        let root = temp_dir(tag);
        let (ka, kb) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
        let (ea, a_events) = recorder();
        let a = far_land("Sender", &ka, &root.join("a"), ea).await;
        waits(&a);
        a.far().unwrap().add_known(&kb.public().to_string(), "Receiver");
        // b's friends already include a, for when b starts.
        let mut book = crate::anywhere::Book::default();
        book.add(&ka.public().to_string(), "Sender");
        book.save(&root.join("b").join("land-friends.json")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("note.txt"), b"for when you're back").unwrap();
        let id = a.send(&kb.public().to_string(), vec![root.join("src").join("note.txt")]).await.unwrap();
        wait_seen(&a_events, &id, "queued").await;
        Away { root, ka, kb, a, a_events, id }
    }

    /// `b` starts; each learns where the other is (in real life the relays' lookup does that).
    async fn comes_back(w: &Away, a: &Arc<Running>) -> (Arc<Running>, Events) {
        let (eb, b_events) = recorder();
        let b = far_land("Receiver", &w.kb, &w.root.join("b"), eb).await;
        b.far().unwrap().remember(a.far().unwrap().addr());
        waits(&b);
        a.far().unwrap().remember(b.far().unwrap().addr());
        (b, b_events)
    }

    #[tokio::test]
    async fn a_send_to_a_friend_who_is_away_waits_and_goes_when_they_are_back() {
        let w = send_to_someone_away("away").await;
        let (b, b_events) = comes_back(&w, &w.a).await;
        // b's hello wakes the waiting send at once; the regular try is a minute away.
        let ask = wait_for(&b_events, "in", "asking").await;
        assert_eq!(ask["peer"]["name"], "Sender");
        b.answer(ask["id"].as_str().unwrap(), true);
        wait_id(&w.a_events, &w.id, "done").await;
        assert_eq!(std::fs::read(w.root.join("b").join("Downloads").join("note.txt")).unwrap(), b"for when you're back");
        assert!(!std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap_or_default().contains(&w.id), "no longer waiting");
        w.a.shutdown().await;
        b.shutdown().await;
    }

    #[tokio::test]
    async fn a_waiting_send_can_be_cancelled_and_is_forgotten() {
        let w = send_to_someone_away("away-cancel").await;
        assert!(std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap().contains(&w.id));
        assert!(w.a.cancel(&w.id));
        wait_id(&w.a_events, &w.id, "cancelled").await;
        assert!(!std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap_or_default().contains(&w.id));
        w.a.shutdown().await;
    }

    #[tokio::test]
    async fn a_waiting_send_outlives_a_restart() {
        let w = send_to_someone_away("away-restart").await;
        w.a.shutdown().await;
        // The sender's Island starts again: the send is still waiting, under the same id.
        let (ea2, a2_events) = recorder();
        let a2 = far_land("Sender", &w.ka, &w.root.join("a"), ea2).await;
        waits(&a2);
        wait_seen(&a2_events, &w.id, "queued").await;
        let (b, b_events) = comes_back(&w, &a2).await;
        let ask = wait_for(&b_events, "in", "asking").await;
        b.answer(ask["id"].as_str().unwrap(), true);
        wait_id(&a2_events, &w.id, "done").await;
        assert_eq!(std::fs::read(w.root.join("b").join("Downloads").join("note.txt")).unwrap(), b"for when you're back");
        a2.shutdown().await;
        b.shutdown().await;
    }

    #[tokio::test]
    async fn a_send_nobody_comes_back_for_gives_up() {
        let root = temp_dir("away-expire");
        let kb = iroh::SecretKey::generate();
        let (ea, a_events) = recorder();
        let a = far_land("Sender", &iroh::SecretKey::generate(), &root.join("a"), ea).await;
        a.set_timing(Timing { far_connect: Duration::from_millis(300), queue_retry: Duration::from_millis(100), queue_for: Duration::from_millis(600), ..Timing::default() });
        a.far().unwrap().add_known(&kb.public().to_string(), "Receiver");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("x.txt"), b"x").unwrap();
        let id = a.send(&kb.public().to_string(), vec![root.join("src").join("x.txt")]).await.unwrap();
        let t = wait_id(&a_events, &id, "failed").await;
        assert!(t["error"].as_str().unwrap().contains("didn't come online"), "{t}");
        assert!(!std::fs::read_to_string(root.join("a").join("land-queue.json")).unwrap_or_default().contains(&id));
        a.shutdown().await;
    }

    /// Two Lands with Land anywhere on, not friends yet: `a` sends, `b` receives (taking files
    /// from computers nearby only when `b_visible`). No relays, so `a` is told where `b` is.
    async fn far_lands(tag: &str, b_visible: bool) -> Pair {
        let root = temp_dir(tag);
        let downloads = root.join("Downloads");
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let (ea, a_events) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: far_setup(&root.join("a")) }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: b_visible, downloads: downloads.clone(), discovery: 0, anywhere: far_setup(&root.join("b")) }, eb).await.unwrap();
        a.far().unwrap().remember(b.far().unwrap().addr());
        Pair { a, b, a_events, b_events, downloads, source }
    }

    /// Two Lands that are friends on other networks (`b` doesn't take files from computers nearby,
    /// which friends don't need).
    async fn far_pair(tag: &str) -> Pair {
        let p = far_lands(tag, false).await;
        let (fa, fb) = (p.a.far().unwrap(), p.b.far().unwrap());
        fa.add_known(&fb.id().to_string(), "Receiver");
        fb.add_known(&fa.id().to_string(), "Sender");
        p
    }

    /// `b` as `a` would know it after hearing its announcement on the network.
    fn heard_of(p: &Pair) {
        let ak = p.b.far().map(|f| f.id().to_string());
        p.a.add_peer(PeerInfo { id: p.b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: ak }, SocketAddr::from((Ipv4Addr::LOCALHOST, p.b.port)), p.b.me.public.clone());
    }

    #[tokio::test]
    async fn the_friend_key_in_an_announcement_is_signed_and_a_borrowed_one_is_dropped() {
        let p = far_lands("hello-ak", true).await;
        let far_id = p.b.far().unwrap().id().to_string();
        let (h, _) = Hello::decode(&p.b.hello("here").encode()).unwrap();
        assert_eq!(h.ak.as_deref(), Some(far_id.as_str()));
        // Someone else's Land key with that friend key and signature: the claim goes, the packet stays.
        let thief = Identity::generate().unwrap();
        let mut stolen = Hello::new("here", &thief, "Thief", 4000);
        stolen.ak = h.ak.clone();
        stolen.aks = h.aks.clone();
        let (got, _) = Hello::decode(&stolen.encode()).unwrap();
        assert_eq!(got.name, "Thief");
        assert_eq!(got.ak, None);
        // Without Land anywhere, no friend key at all (older Islands see the packet they know).
        let plain = String::from_utf8(Hello::new("here", &thief, "Plain", 4000).encode()).unwrap();
        assert!(!plain.contains("\"ak\""), "{plain}");
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_computer_nearby_that_announces_a_friend_key_is_marked_with_it() {
        let p = far_lands("heard-ak", true).await;
        // An address on one of this computer's networks (none: nothing to check here).
        let Some(ip) = p.a.nets.lock().unwrap().first().map(|n| n.ip) else { return };
        p.a.heard(&p.b.hello("here").encode(), SocketAddr::from((ip, 50_000))).await;
        let peers = p.a.peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].anywhere, Some(p.b.far().unwrap().id().to_string()));
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_friend_nearby_gets_files_over_the_network_nearby() {
        let p = far_lands("near-friend", true).await;
        let (fa, fb) = (p.a.far().unwrap(), p.b.far().unwrap());
        fa.add_known(&fb.id().to_string(), "Receiver");
        fb.add_known(&fa.id().to_string(), "Sender");
        heard_of(&p);
        std::fs::write(p.source.join("n.txt"), b"near").unwrap();
        // Sent to the friend's key, it goes the fast way: TCP on this network.
        let id = p.a.send(&fb.id().to_string(), vec![p.source.join("n.txt")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        p.b.answer(ask["id"].as_str().unwrap(), true);
        let done = wait_id(&p.a_events, &id, "done").await;
        assert_eq!(done["via"], "lan");
        assert_eq!(std::fs::read(p.downloads.join("n.txt")).unwrap(), b"near");
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_computer_nearby_can_be_asked_to_be_friends_without_a_code() {
        let p = far_lands("befriend", true).await;
        heard_of(&p);
        let asking = tokio::spawn({
            let (a, id) = (p.a.clone(), p.b.me.id.clone());
            async move { a.befriend(&id).await }
        });
        let mut ask = None;
        for _ in 0..400 {
            ask = p.b_events.lock().unwrap().iter().find(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").map(|(_, v)| v.clone());
            if ask.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let ask = ask.expect("the computer nearby was asked");
        assert!(p.b.far().unwrap().answer(ask["id"].as_str().unwrap(), crate::anywhere::Reply::Add));
        assert_eq!(asking.await.unwrap().unwrap().name, "Receiver");
        // One that announced no friend key can't be asked.
        assert!(p.a.befriend("0000000000000000").await.is_err());
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn files_reach_a_friend_on_another_network_after_consent() {
        let p = far_pair("far-send").await;
        std::fs::write(p.source.join("note.txt"), b"hello from far away").unwrap();
        std::fs::create_dir_all(p.source.join("Trip")).unwrap();
        std::fs::write(p.source.join("Trip").join("day1.txt"), vec![7u8; 300_000]).unwrap();
        let friend = p.b.far().unwrap().id().to_string();
        let id = p.a.send(&friend, vec![p.source.join("note.txt"), p.source.join("Trip")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        assert_eq!(ask["peer"]["name"], "Sender");
        assert_eq!(ask["peer"]["id"], p.a.far().unwrap().id().to_string());
        assert!(p.b.answer(ask["id"].as_str().unwrap(), true));
        let done = wait_id(&p.a_events, &id, "done").await;
        assert_eq!(done["via"], "direct");
        wait_for(&p.b_events, "in", "done").await;
        assert_eq!(std::fs::read(p.downloads.join("note.txt")).unwrap(), b"hello from far away");
        assert_eq!(std::fs::read(p.downloads.join("Trip").join("day1.txt")).unwrap().len(), 300_000);
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_friend_on_another_network_can_decline() {
        let p = far_pair("far-decline").await;
        std::fs::write(p.source.join("x.txt"), b"x").unwrap();
        let friend = p.b.far().unwrap().id().to_string();
        let id = p.a.send(&friend, vec![p.source.join("x.txt")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        p.b.answer(ask["id"].as_str().unwrap(), false);
        let t = wait_id(&p.a_events, &id, "declined").await;
        assert_eq!(t["error"], "Receiver declined.");
        assert!(!p.downloads.join("x.txt").exists());
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn someone_who_removed_you_does_not_get_your_files() {
        let p = far_pair("far-removed").await;
        std::fs::write(p.source.join("x.txt"), b"x").unwrap();
        p.b.far().unwrap().remove(&p.a.far().unwrap().id().to_string());
        let friend = p.b.far().unwrap().id().to_string();
        let id = p.a.send(&friend, vec![p.source.join("x.txt")]).await.unwrap();
        let t = wait_id(&p.a_events, &id, "failed").await;
        assert!(t["error"].as_str().unwrap().contains("isn't taking files from you"), "{t}");
        assert!(last_state(&p.b_events, "in").is_none(), "nothing reached the other island");
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    /// Two Lands that know each other only by key send 2 MB through n0's real lookup and relays,
    /// first the normal way (direct when it can), then relay only:
    /// `cargo test --lib land::tests::files_reach_a_friend_through_n0 -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn files_reach_a_friend_through_n0() {
        for relays in [crate::anywhere::Relays::N0, crate::anywhere::Relays::N0RelayOnly] {
            let root = temp_dir("n0-send");
            let (downloads, source) = (root.join("Downloads"), root.join("source"));
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("two-mb.bin"), vec![42u8; 2_000_000]).unwrap();
            let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: relays.clone(), book: root.join(dir).join("land-friends.json") });
            let (ea, a_events) = recorder();
            let (eb, b_events) = recorder();
            let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
            let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
            let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
            fa.add_known(&fb.id().to_string(), "Receiver");
            fb.add_known(&fa.id().to_string(), "Sender");
            // Time to reach a home relay and publish where it is.
            tokio::time::sleep(Duration::from_secs(4)).await;
            let started = Instant::now();
            let id = a.send(&fb.id().to_string(), vec![source.join("two-mb.bin")]).await.unwrap();
            let ask = wait_for(&b_events, "in", "asking").await;
            b.answer(ask["id"].as_str().unwrap(), true);
            let mut done = None;
            for _ in 0..1200 {
                let last = a_events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
                if let Some(v) = last.filter(|v| v["state"] != "waiting" && v["state"] != "sending") {
                    done = Some(v);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let done = done.expect("the send ended within 2 minutes");
            println!("{relays:?}: {} via {} in {:.1} s", done["state"], done["via"], started.elapsed().as_secs_f64());
            assert_eq!(done["state"], "done", "{done}");
            assert_eq!(std::fs::read(downloads.join("two-mb.bin")).unwrap().len(), 2_000_000);
            a.shutdown().await;
            b.shutdown().await;
        }
    }

    /// Two friends whose only way to each other is a relay we run (here, one on this computer):
    /// they meet through it and the files go through it.
    #[tokio::test(flavor = "multi_thread")]
    async fn friends_meet_and_send_through_our_own_relay() {
        let (map, url, _server) = crate::anywhere::tests::local_relay().await;
        let root = temp_dir("own-relay");
        let (downloads, source) = (root.join("Downloads"), root.join("source"));
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("via-relay.txt"), vec![9u8; 500_000]).unwrap();
        let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::Local(map.clone()), book: root.join(dir).join("land-friends.json") });
        let (ea, a_events) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
        let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
        fa.add_known(&fb.id().to_string(), "Receiver");
        fb.add_known(&fa.id().to_string(), "Sender");
        // All `a` knows is which relay `b` uses.
        fa.remember(iroh::EndpointAddr::new(fb.id()).with_relay_url(url.clone()));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let id = a.send(&fb.id().to_string(), vec![source.join("via-relay.txt")]).await.unwrap();
        let ask = wait_for(&b_events, "in", "asking").await;
        b.answer(ask["id"].as_str().unwrap(), true);
        let done = wait_id(&a_events, &id, "done").await;
        assert_eq!(done["via"], "relay");
        assert_eq!(std::fs::read(downloads.join("via-relay.txt")).unwrap().len(), 500_000);
        a.shutdown().await;
        b.shutdown().await;
    }

    /// How fast bytes go through a relay, timed from the first byte to "saved" (no setup):
    /// `cargo test --lib land::tests::relay_speed -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn relay_speed() {
        let mb: usize = std::env::var("RELAY_TEST_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        let root = temp_dir("relay-speed");
        let (downloads, source) = (root.join("Downloads"), root.join("source"));
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("big.bin"), vec![7u8; mb * 1_000_000]).unwrap();
        let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::N0RelayOnly, book: root.join(dir).join("land-friends.json") });
        let (ea, a_events) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
        let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
        fa.add_known(&fb.id().to_string(), "Receiver");
        fb.add_known(&fa.id().to_string(), "Sender");
        tokio::time::sleep(Duration::from_secs(4)).await;
        let id = a.send(&fb.id().to_string(), vec![source.join("big.bin")]).await.unwrap();
        let ask = wait_for(&b_events, "in", "asking").await;
        b.answer(ask["id"].as_str().unwrap(), true);
        wait_id(&a_events, &id, "sending").await;
        let started = Instant::now();
        let mut end = None;
        for _ in 0..6000 {
            let last = a_events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
            if let Some(v) = last.filter(|v| v["state"] != "sending") {
                end = Some(v);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let secs = started.elapsed().as_secs_f64();
        let end = end.expect("the send ended within 10 minutes");
        println!("{mb} MB through n0's relay: {} in {secs:.1} s = {:.2} MB/s", end["state"], mb as f64 / secs);
        a.shutdown().await;
        b.shutdown().await;
    }

    #[tokio::test]
    async fn friends_online_are_the_ones_that_answer() {
        let p = far_pair("far-online").await;
        let fa = p.a.far().unwrap();
        // A friend whose Island is nowhere to be found.
        fa.add_known(&iroh::SecretKey::generate().public().to_string(), "Away");
        let online = fa.online().await;
        assert_eq!(online, vec![p.b.far().unwrap().id().to_string()]);
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    struct Pair {
        a: Arc<Running>,
        b: Arc<Running>,
        a_events: Events,
        b_events: Events,
        downloads: PathBuf,
        source: PathBuf,
    }

    /// Two devices in one process: `a` sends, `b` receives into its own Downloads.
    async fn pair(tag: &str) -> Pair {
        let root = temp_dir(tag);
        let downloads = root.join("Downloads");
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let (ea, a_events) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: None }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: true, downloads: downloads.clone(), discovery: 0, anywhere: None }, eb).await.unwrap();
        a.add_peer(PeerInfo { id: b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, b.port)), b.me.public.clone());
        Pair { a, b, a_events, b_events, downloads, source }
    }

    #[tokio::test]
    async fn files_and_folders_arrive_whole_after_consent() {
        let p = pair("e2e").await;
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(p.source.join("big.bin"), &big).unwrap();
        std::fs::create_dir_all(p.source.join("Album").join("inner")).unwrap();
        std::fs::write(p.source.join("Album").join("inner").join("x.txt"), b"inner").unwrap();
        std::fs::write(p.source.join("Album").join("empty.txt"), b"").unwrap();
        // Already in Downloads: must survive untouched.
        std::fs::create_dir_all(&p.downloads).unwrap();
        std::fs::write(p.downloads.join("big.bin"), b"keep me").unwrap();

        let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin"), p.source.join("Album")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        assert_eq!(ask["count"], 3);
        assert_eq!(ask["total"], 200_005);
        assert_eq!(ask["peer"]["name"], "Sender");
        assert!(ask["expires"].as_u64().unwrap() > now_ms());
        // Nothing written before the answer.
        assert_eq!(std::fs::read_dir(&p.downloads).unwrap().count(), 1);
        assert_eq!(wait_for(&p.a_events, "out", "waiting").await["id"], id);

        assert!(p.b.answer(ask["id"].as_str().unwrap(), true));
        let done = wait_for(&p.b_events, "in", "done").await;
        wait_for(&p.a_events, "out", "done").await;
        assert_eq!(done["done"], 200_005);
        assert_eq!(std::fs::read(p.downloads.join("big (1).bin")).unwrap(), big);
        assert_eq!(std::fs::read(p.downloads.join("big.bin")).unwrap(), b"keep me");
        assert_eq!(std::fs::read(p.downloads.join("Album").join("inner").join("x.txt")).unwrap(), b"inner");
        assert_eq!(std::fs::read(p.downloads.join("Album").join("empty.txt")).unwrap(), b"");
        let saved: Vec<String> = done["saved"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
        assert_eq!(saved, vec![p.downloads.join("big (1).bin").to_string_lossy().to_string(), p.downloads.join("Album").to_string_lossy().to_string()]);
        // Marked as coming from another computer, like a browser download.
        #[cfg(windows)]
        {
            let mut zone = p.downloads.join("big (1).bin").into_os_string();
            zone.push(":Zone.Identifier");
            assert!(std::fs::read_to_string(zone).unwrap().contains("ZoneId=3"));
        }
        // No temp files left behind.
        let leftovers = std::fs::read_dir(&p.downloads).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".landing")).count();
        assert_eq!(leftovers, 0);
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_declined_offer_writes_nothing() {
        let p = pair("decline").await;
        std::fs::write(p.source.join("secret.txt"), b"no").unwrap();
        p.a.send(&p.b.me.id, vec![p.source.join("secret.txt")]).await.unwrap();
        let ask = wait_for(&p.b_events, "in", "asking").await;
        assert!(p.b.answer(ask["id"].as_str().unwrap(), false));
        let out = wait_for(&p.a_events, "out", "declined").await;
        assert_eq!(out["error"], "Receiver declined.");
        wait_for(&p.b_events, "in", "declined").await;
        assert!(!p.downloads.exists() || std::fs::read_dir(&p.downloads).unwrap().count() == 0);
        // Asking again at once is turned away without bothering the user.
        let asks = p.b_events.lock().unwrap().iter().filter(|(_, v)| v["state"] == "asking").count();
        let id = p.a.send(&p.b.me.id, vec![p.source.join("secret.txt")]).await.unwrap();
        let again = wait_id(&p.a_events, &id, "declined").await;
        assert_eq!(again["error"], "Receiver is busy with other files. Try again in a moment.");
        assert_eq!(p.b_events.lock().unwrap().iter().filter(|(_, v)| v["state"] == "asking").count(), asks);
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn the_sender_can_cancel_while_asking() {
        let p = pair("cancel").await;
        std::fs::write(p.source.join("a.txt"), b"a").unwrap();
        let id = p.a.send(&p.b.me.id, vec![p.source.join("a.txt")]).await.unwrap();
        wait_for(&p.b_events, "in", "asking").await;
        assert!(p.a.cancel(&id));
        wait_for(&p.a_events, "out", "cancelled").await;
        let theirs = wait_for(&p.b_events, "in", "cancelled").await;
        assert_eq!(theirs["error"], "Sender cancelled.");
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    #[tokio::test]
    async fn a_key_that_does_not_match_the_announcement_stops_the_send() {
        let p = pair("impostor").await;
        std::fs::write(p.source.join("a.txt"), b"a").unwrap();
        // The device announced some other key than the one that answers.
        let stranger = Identity::generate().unwrap();
        p.a.add_peer(PeerInfo { id: p.b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, p.b.port)), stranger.public.clone());
        p.a.send(&p.b.me.id, vec![p.source.join("a.txt")]).await.unwrap();
        let out = wait_for(&p.a_events, "out", "failed").await;
        assert!(out["error"].as_str().unwrap().contains("different key"));
        assert!(last_state(&p.b_events, "in").is_none(), "the receiver never got an offer");
        p.a.shutdown().await;
        p.b.shutdown().await;
    }

    /// Two devices find each other over this computer's real network (multicast and broadcast
    /// loop back to it). Needs a network, so it runs by hand: `cargo test --lib land -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn devices_find_each_other_on_the_network() {
        let port = 47900 + (std::process::id() % 90) as u16;
        let (ea, a_events) = recorder();
        let (eb, _) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Finder".into(), visible: true, downloads: temp_dir("find-a"), discovery: port, anywhere: None }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Found".into(), visible: true, downloads: temp_dir("find-b"), discovery: port, anywhere: None }, eb).await.unwrap();
        let mut seen = false;
        for _ in 0..40 {
            a.scan().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            if a.peers().iter().any(|p| p.id == b.me.id && p.name == "Found") {
                seen = true;
                break;
            }
        }
        assert!(seen, "a never heard b: {:?}", a_events.lock().unwrap());
        // b leaving says so at once.
        b.shutdown().await;
        for _ in 0..40 {
            if a.peers().iter().all(|p| p.id != b.me.id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(a.peers().iter().all(|p| p.id != b.me.id), "b's bye was not heard");
        a.shutdown().await;
    }

    /// Offers a small text file to the Island running on this computer, as another computer
    /// would, so its card can be seen and answered on the real island:
    /// `cargo test --lib land::tests::offer_the_island -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn offer_the_island_running_here_a_file() {
        let udp = bind_udp(0).unwrap();
        let me = Identity::generate().unwrap();
        udp.send_to(&Hello::new("ask", &me, "Land test", 0).encode(), (Ipv4Addr::LOCALHOST, DISCOVERY_PORT)).await.unwrap();
        let mut buf = vec![0u8; 4096];
        let (n, from) = timeout(Duration::from_secs(3), udp.recv_from(&mut buf)).await.expect("no Island answered on this computer").unwrap();
        let (h, key) = Hello::decode(&buf[..n]).expect("an Island hello");
        println!("found {} ({}), taking files on port {}", h.name, h.id, h.port);
        let (emit, events) = recorder();
        let run = start(me, Options { name: "Land test".into(), visible: false, downloads: temp_dir("probe"), discovery: 0, anywhere: None }, emit).await.unwrap();
        run.add_peer(PeerInfo { id: h.id.clone(), name: h.name.clone(), os: h.os.clone(), anywhere: None }, SocketAddr::new(from.ip(), h.port), key);
        let file = temp_dir("probe-src").join("Land test.txt");
        std::fs::write(&file, "Sent by Land's test, from this computer.").unwrap();
        let id = run.send(&h.id, vec![file]).await.unwrap();
        println!("offered: answer it on the island (it waits 2 minutes)");
        for _ in 0..600 {
            let last = events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id.as_str()).map(|(_, v)| v.clone());
            if let Some(v) = last.filter(|v| !matches!(v["state"].as_str(), Some("waiting") | Some("sending"))) {
                println!("{} {}", v["state"], v["error"]);
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        run.shutdown().await;
    }

    #[tokio::test]
    async fn nobody_listening_is_a_clear_failure() {
        let (e, events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "A".into(), visible: false, downloads: temp_dir("none"), discovery: 0, anywhere: None }, e).await.unwrap();
        let ghost = Identity::generate().unwrap();
        let port = {
            let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        a.add_peer(PeerInfo { id: ghost.id.clone(), name: "Ghost".into(), os: "macos".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, port)), ghost.public.clone());
        let file = temp_dir("none-src").join("x.txt");
        std::fs::write(&file, b"x").unwrap();
        a.send(&ghost.id, vec![file]).await.unwrap();
        let out = wait_for(&events, "out", "failed").await;
        assert!(out["error"].as_str().unwrap().starts_with("Couldn't reach Ghost"));
        assert!(a.send("nobody", vec![]).await.is_err());
        a.shutdown().await;
    }
}
