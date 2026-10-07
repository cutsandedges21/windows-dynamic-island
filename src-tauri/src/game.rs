// Games: which one is running, its frame rate, and the latency to its server.
//
// Which game: Steam writes the running app's id to HKCU\Software\Valve\Steam\
// RunningAppID; its name and folder come from the library's appmanifest, and
// the game process is the one running from that folder. Other stores are
// recognised by the folder the foreground program runs from.
//
// Frame rate is counted from present calls, the way PresentMon (MIT, Intel)
// does it: a private real-time ETW session with DXGI and D3D9 Present_Start per
// process, and DxgKrnl's present events for games that use neither. Windows
// lets only administrators and Performance Log Users start such a session, so
// the first time Island asks Windows (UAC) to add the user to that group; it
// takes effect at the next sign-in. RivaTuner's shared memory is read too when
// it runs. Nothing is injected into the game or attached to it.
//
// Ping: the game's busiest remote endpoint (Kernel-Network sends in the same
// session, else its TCP connections) gets an ICMP echo every 2 s. When the
// server ignores ICMP, the internet's latency (1.1.1.1) stands in, labelled so.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, HLOCAL, WIN32_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS};
use windows::Win32::Networking::WinSock::AF_INET;
use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows::Win32::Security::{LookupAccountSidW, PSID, SID_NAME_USE};
use windows::Win32::System::Diagnostics::Etw::{
    CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW, CONTROLTRACE_HANDLE, EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_RECORD,
    EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES, EVENT_TRACE_REAL_TIME_MODE, PROCESS_TRACE_MODE_EVENT_RECORD,
    PROCESS_TRACE_MODE_REAL_TIME, WNODE_FLAG_TRACED_GUID,
};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

const SESSION_NAME: &str = "Island-Frames";
const DXGI: GUID = GUID::from_u128(0xca11c036_0102_4a2d_a6ad_f03cfed5d3c9);
const D3D9: GUID = GUID::from_u128(0x783aca0a_790e_4d7f_8451_aa850511c6b9);
const DXGKRNL: GUID = GUID::from_u128(0x802ec45a_1e99_4b83_9920_87c98277ba9d);
const KERNEL_NETWORK: GUID = GUID::from_u128(0x7dd42a49_5329_4832_8dfd_43d979153a88);
/// Present_Start (DXGI 42, D3D9 1), DxgKrnl Present (184), Kernel-Network TCPv4 / UDPv4 send (10, 42).
const DXGI_PRESENT: u16 = 42;
const D3D9_PRESENT: u16 = 1;
const DXGKRNL_PRESENT: u16 = 184;
const TCP4_SEND: u16 = 10;
const UDP4_SEND: u16 = 42;
/// The internet stand-in when the game's server ignores ICMP.
const INTERNET: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);
/// Program folders of the stores Island recognises for games not run by Steam.
const GAME_FOLDERS: &[&str] = &[
    r"\steamapps\common\",
    r"\epic games\",
    r"\xboxgames\",
    r"\riot games\",
    r"\gog galaxy\games\",
    r"\gog games\",
    r"\ea games\",
    r"\origin games\",
    r"\ubisoft game launcher\games\",
    r"\rockstar games\",
    r"\battle.net\",
];

#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub name: String,
    pub app_id: Option<u32>,
    pub pid: u32,
    pub source: &'static str,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub game: Option<GameInfo>,
    pub fps: Option<f32>,
    /// "frames" (Island's own count) or "rivatuner".
    pub fps_source: Option<&'static str>,
    /// Windows refused the frame-timing session: the one-time setup is needed (or a sign-in after it).
    pub fps_needs_setup: bool,
    pub ping: Option<u32>,
    pub ping_target: Option<String>,
    /// "server" (the game's own) or "internet" (1.1.1.1).
    pub ping_kind: Option<&'static str>,
}

fn state() -> &'static Mutex<GameState> {
    static STATE: OnceLock<Mutex<GameState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(GameState::default()))
}

/// The game's process: the only one the ETW callback records.
static TARGET: AtomicU32 = AtomicU32::new(0);

#[derive(Default)]
struct Frames {
    /// Present_Start timestamps (QPC) from DXGI or D3D9.
    api: VecDeque<i64>,
    /// DxgKrnl present timestamps, used only when the game shows no API presents.
    kernel: VecDeque<i64>,
}

fn frames() -> &'static Mutex<Frames> {
    static FRAMES: OnceLock<Mutex<Frames>> = OnceLock::new();
    FRAMES.get_or_init(|| Mutex::new(Frames::default()))
}

/// Packets the game sent per remote endpoint since the last pick.
fn peers() -> &'static Mutex<HashMap<(Ipv4Addr, u16), u32>> {
    static PEERS: OnceLock<Mutex<HashMap<(Ipv4Addr, u16), u32>>> = OnceLock::new();
    PEERS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ------------------------------------------------------------------ detection

fn steam_key() -> Option<windows_registry::Key> {
    windows_registry::CURRENT_USER.open(r"Software\Valve\Steam").ok()
}

fn steam_running_app() -> Option<u32> {
    let id = steam_key()?.get_u32("RunningAppID").ok()?;
    (id != 0).then_some(id)
}

/// `"key"   "value"` → value, with VDF's doubled backslashes undone.
fn vdf_value(line: &str, key: &str) -> Option<String> {
    let mut parts = line.split('"').filter(|s| !s.trim().is_empty());
    let k = parts.next()?;
    if !k.eq_ignore_ascii_case(key) {
        return None;
    }
    Some(parts.next()?.replace("\\\\", "\\"))
}

/// Every Steam library folder, the install folder first.
fn steam_libraries() -> Vec<PathBuf> {
    let Some(root) = steam_key().and_then(|k| k.get_string("SteamPath").ok()) else { return Vec::new() };
    let root = PathBuf::from(root.replace('/', "\\"));
    let mut libs = vec![root.clone()];
    if let Ok(text) = std::fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")) {
        for line in text.lines() {
            if let Some(path) = vdf_value(line, "path") {
                let p = PathBuf::from(path);
                if !libs.contains(&p) {
                    libs.push(p);
                }
            }
        }
    }
    libs
}

/// A Steam app's name and install folder, from its manifest in whichever library has it.
fn steam_app(id: u32) -> Option<(String, PathBuf)> {
    for lib in steam_libraries() {
        let steamapps = lib.join("steamapps");
        let Ok(text) = std::fs::read_to_string(steamapps.join(format!("appmanifest_{id}.acf"))) else { continue };
        let name = text.lines().find_map(|l| vdf_value(l, "name"));
        let dir = text.lines().find_map(|l| vdf_value(l, "installdir"));
        if let (Some(name), Some(dir)) = (name, dir) {
            return Some((name, steamapps.join("common").join(dir)));
        }
    }
    None
}

fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn inside(exe: &str, folder: &str) -> bool {
    let exe = exe.to_lowercase();
    let mut folder = folder.to_lowercase();
    if !folder.ends_with('\\') {
        folder.push('\\');
    }
    exe.starts_with(&folder)
}

/// The game's process: a windowed one from that folder (the foreground first), else any from it.
fn process_in(folder: &str) -> Option<u32> {
    let fg = crate::procs::window_pid(crate::procs::foreground());
    if fg != 0 && exe_path(fg).is_some_and(|e| inside(&e, folder)) {
        return Some(fg);
    }
    let windowed: HashSet<u32> = crate::procs::windows().into_iter().map(|w| w.pid).collect();
    let mut fallback = None;
    for row in crate::procs::snapshot(false) {
        if !row.2.ends_with(".exe") || row.2.contains("crash") || row.2.contains("anticheat") {
            continue;
        }
        if exe_path(row.0).is_some_and(|e| inside(&e, folder)) {
            if windowed.contains(&row.0) {
                return Some(row.0);
            }
            fallback.get_or_insert(row.0);
        }
    }
    fallback
}

fn alive(pid: u32) -> bool {
    exe_path(pid).is_some()
}

/// Steam's running game, else a foreground program from a store's games folder.
fn detect(current: Option<&GameInfo>) -> Option<GameInfo> {
    if let Some(app) = steam_running_app() {
        if let Some(cur) = current.filter(|c| c.app_id == Some(app) && alive(c.pid)) {
            return Some(cur.clone());
        }
        let (name, folder) = steam_app(app).unwrap_or_else(|| (format!("Steam app {app}"), PathBuf::new()));
        let pid = if folder.as_os_str().is_empty() { None } else { process_in(&folder.to_string_lossy()) };
        // Steam says it runs but no process yet (launching): report it without frames.
        return Some(GameInfo { name, app_id: Some(app), pid: pid.unwrap_or(0), source: "steam" });
    }
    if let Some(cur) = current.filter(|c| c.source == "store" && alive(c.pid)) {
        return Some(cur.clone());
    }
    let fg = crate::procs::foreground();
    let pid = crate::procs::window_pid(fg);
    let exe = exe_path(pid)?.to_lowercase();
    if !GAME_FOLDERS.iter().any(|f| exe.contains(f)) {
        return None;
    }
    let title = crate::procs::windows().into_iter().find(|w| w.pid == pid).map(|w| w.title).unwrap_or_default();
    let name = if title.trim().is_empty() {
        exe.rsplit('\\').next().unwrap_or("Game").trim_end_matches(".exe").to_string()
    } else {
        title
    };
    Some(GameInfo { name, app_id: None, pid, source: "store" })
}

// ------------------------------------------------------------------ RivaTuner

/// RivaTuner Statistics Server's frame rate for `pid`, if it is running and drawing that game.
fn rivatuner_fps(pid: u32) -> Option<f32> {
    unsafe {
        let name: Vec<u16> = "RTSSSharedMemoryV2\0".encode_utf16().collect();
        let map = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())).ok()?;
        let view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
        let base = view.Value as *const u8;
        let result = (|| {
            if base.is_null() {
                return None;
            }
            let u32_at = |off: usize| -> u32 { std::ptr::read_unaligned(base.add(off) as *const u32) };
            // Header: signature 'RTSS', version, app entry size, app array offset, app array size.
            if u32_at(0) != 0x5254_5353 {
                return None;
            }
            let (entry_size, offset, count) = (u32_at(8) as usize, u32_at(12) as usize, u32_at(16) as usize);
            if entry_size < 284 || count > 4096 {
                return None;
            }
            for i in 0..count {
                let e = offset + i * entry_size;
                // Entry: process id, name[260], flags, time0, time1, frames.
                if u32_at(e) != pid {
                    continue;
                }
                let (t0, t1, frames) = (u32_at(e + 268), u32_at(e + 272), u32_at(e + 276));
                if t1 > t0 && frames > 0 {
                    return Some(1000.0 * frames as f32 / (t1 - t0) as f32);
                }
            }
            None
        })();
        if !base.is_null() {
            let _ = UnmapViewOfFile(view);
        }
        let _ = CloseHandle(map);
        result
    }
}

// ------------------------------------------------------------------ frame timing (ETW)

/// EVENT_TRACE_PROPERTIES followed by room for the session name, 8-byte aligned.
fn trace_properties() -> Vec<u64> {
    let base = std::mem::size_of::<EVENT_TRACE_PROPERTIES>();
    let bytes = base + 1024;
    let mut buf = vec![0u64; bytes.div_ceil(8)];
    let props = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
    unsafe {
        (*props).Wnode.BufferSize = (buf.len() * 8) as u32;
        (*props).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        // QPC timestamps on every event.
        (*props).Wnode.ClientContext = 1;
        (*props).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        (*props).FlushTimer = 1;
        (*props).BufferSize = 64;
        (*props).LoggerNameOffset = base as u32;
    }
    buf
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn stop_session() {
    let mut props = trace_properties();
    let name = wide(SESSION_NAME);
    unsafe {
        let _ = ControlTraceW(CONTROLTRACE_HANDLE::default(), PCWSTR(name.as_ptr()), props.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES, EVENT_TRACE_CONTROL_STOP);
    }
}

enum Start {
    Running,
    Denied,
    Failed(u32),
}

/// Starts the session with the present and network providers and a consumer thread.
fn start_session() -> Start {
    let name = wide(SESSION_NAME);
    let mut handle = CONTROLTRACE_HANDLE::default();
    let mut props = trace_properties();
    let mut err = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), props.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES) };
    if err == ERROR_ALREADY_EXISTS {
        // Left over from a crash: take it down and start clean.
        stop_session();
        props = trace_properties();
        err = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), props.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES) };
    }
    if err == ERROR_ACCESS_DENIED {
        return Start::Denied;
    }
    if err != WIN32_ERROR(0) {
        return Start::Failed(err.0);
    }
    // DXGI "Events", every D3D9 keyword, DxgKrnl "Present", Kernel-Network "IPv4".
    for (name, guid, keywords) in [("DXGI", DXGI, 0x2u64), ("D3D9", D3D9, u64::MAX), ("DxgKrnl", DXGKRNL, 0x800_0000), ("Kernel-Network", KERNEL_NETWORK, 0x10)] {
        let err = unsafe { EnableTraceEx2(handle, &guid, EVENT_CONTROL_CODE_ENABLE_PROVIDER.0, 4, keywords, 0, 0, None) };
        if err != WIN32_ERROR(0) {
            crate::log::line(format!("games: {name} provider not enabled ({})", err.0));
        }
    }
    std::thread::Builder::new()
        .name("island-frames".into())
        .spawn(|| unsafe {
            let mut name = wide(SESSION_NAME);
            let mut log = EVENT_TRACE_LOGFILEW { LoggerName: PWSTR(name.as_mut_ptr()), ..Default::default() };
            log.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
            log.Anonymous2.EventRecordCallback = Some(on_event);
            let trace = OpenTraceW(&mut log);
            if trace.Value == u64::MAX {
                crate::log::line("games: cannot open the frame session");
                return;
            }
            // Blocks until the session stops.
            let _ = ProcessTrace(&[trace], None, None);
            let _ = CloseTrace(trace);
        })
        .ok();
    Start::Running
}

unsafe extern "system" fn on_event(rec: *mut EVENT_RECORD) {
    let Some(rec) = (unsafe { rec.as_ref() }) else { return };
    let target = TARGET.load(Ordering::Relaxed);
    if target == 0 {
        return;
    }
    let h = &rec.EventHeader;
    let id = h.EventDescriptor.Id;
    let provider = h.ProviderId;
    if (provider == DXGI && id == DXGI_PRESENT) || (provider == D3D9 && id == D3D9_PRESENT) {
        if h.ProcessId == target {
            push(&mut frames().lock().unwrap().api, h.TimeStamp);
        }
    } else if provider == DXGKRNL && id == DXGKRNL_PRESENT {
        if h.ProcessId == target {
            push(&mut frames().lock().unwrap().kernel, h.TimeStamp);
        }
    } else if provider == KERNEL_NETWORK && (id == UDP4_SEND || id == TCP4_SEND) && rec.UserDataLength >= 20 && !rec.UserData.is_null() {
        // PID, size, daddr, saddr (IPv4), dport, sport (network order).
        let data = unsafe { std::slice::from_raw_parts(rec.UserData as *const u8, rec.UserDataLength as usize) };
        let pid = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if pid == target {
            let ip = Ipv4Addr::new(data[8], data[9], data[10], data[11]);
            let port = u16::from_be_bytes([data[16], data[17]]);
            if usable_peer(ip) {
                *peers().lock().unwrap().entry((ip, port)).or_insert(0) += 1;
            }
        }
    }
}

fn push(q: &mut VecDeque<i64>, ts: i64) {
    q.push_back(ts);
    while q.len() > 4000 {
        q.pop_front();
    }
}

fn usable_peer(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || ip.is_link_local())
}

fn qpc() -> (i64, i64) {
    let (mut now, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut now);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    (now, freq.max(1))
}

/// Presents per second over the last second of timestamps; None when the game drew nothing lately.
fn rate(q: &VecDeque<i64>, now: i64, freq: i64) -> Option<f32> {
    let last = *q.back()?;
    // Events reach us up to a second late (the session's flush timer).
    if now - last > freq * 5 / 2 {
        return None;
    }
    let window: Vec<i64> = q.iter().copied().filter(|&t| last - t <= freq).collect();
    if window.len() < 2 {
        return None;
    }
    let span = last - window[0];
    (span > 0).then(|| (window.len() - 1) as f32 * freq as f32 / span as f32)
}

fn session_fps() -> Option<f32> {
    let (now, freq) = qpc();
    let f = frames().lock().unwrap();
    rate(&f.api, now, freq).or_else(|| if f.api.is_empty() { rate(&f.kernel, now, freq) } else { None })
}

// ------------------------------------------------------------------ ping

/// The game's busiest remote endpoint since the last call (ETW), else one of its TCP peers.
fn server_of(pid: u32, have_session: bool) -> Option<Ipv4Addr> {
    if have_session {
        let mut map = peers().lock().unwrap();
        let best = map.iter().max_by_key(|(_, n)| **n).map(|((ip, _), _)| *ip);
        map.clear();
        if best.is_some() {
            return best;
        }
    }
    tcp_peer(pid)
}

fn tcp_peer(pid: u32) -> Option<Ipv4Addr> {
    unsafe {
        let mut size = 0u32;
        let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        if GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) != 0 {
            return None;
        }
        let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let rows = std::slice::from_raw_parts(table.table.as_ptr() as *const MIB_TCPROW_OWNER_PID, table.dwNumEntries as usize);
        // Game traffic rarely runs over the web ports; prefer anything else.
        let mut web = None;
        for row in rows.iter().filter(|r| r.dwOwningPid == pid && r.dwState == 5) {
            let ip = Ipv4Addr::from(u32::from_be(row.dwRemoteAddr));
            if !usable_peer(ip) {
                continue;
            }
            let port = u16::from_be((row.dwRemotePort & 0xffff) as u16);
            if port == 443 || port == 80 {
                web.get_or_insert(ip);
            } else {
                return Some(ip);
            }
        }
        web
    }
}

/// One ICMP echo; the round trip in ms.
fn ping(ip: Ipv4Addr) -> Option<u32> {
    unsafe {
        let icmp = IcmpCreateFile().ok()?;
        let payload = [0x49u8; 32];
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 16];
        let n = IcmpSendEcho(
            icmp,
            u32::from_ne_bytes(ip.octets()),
            payload.as_ptr() as *const _,
            payload.len() as u16,
            None,
            reply.as_mut_ptr() as *mut _,
            reply.len() as u32,
            1000,
        );
        let _ = IcmpCloseHandle(icmp);
        if n == 0 {
            return None;
        }
        let r = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        (r.Status == 0).then_some(r.RoundTripTime)
    }
}

// ------------------------------------------------------------------ the watcher

pub fn start() {
    std::thread::Builder::new().name("island-games".into()).spawn(watch).ok();
}

fn watch() {
    let mut current: Option<GameInfo> = None;
    let mut session = false;
    let mut denied = false;
    let mut silent: HashSet<Ipv4Addr> = HashSet::new();
    let mut server: Option<Ipv4Addr> = None;
    let mut misses = 0u32;
    let mut last_ping = Instant::now() - Duration::from_secs(10);
    loop {
        let found = detect(current.as_ref());
        if found != current {
            match &found {
                Some(g) => crate::log::line(format!("games: {} ({}, pid {})", g.name, g.source, g.pid)),
                None => crate::log::line("games: none running"),
            }
            *frames().lock().unwrap() = Frames::default();
            peers().lock().unwrap().clear();
            silent.clear();
            server = None;
            current = found;
        }
        let pid = current.as_ref().map(|g| g.pid).unwrap_or(0);
        TARGET.store(pid, Ordering::Relaxed);

        // The session runs only while a game does.
        if pid != 0 && !session && !denied {
            match start_session() {
                Start::Running => {
                    session = true;
                    crate::log::line("games: frame timing on");
                }
                Start::Denied => {
                    denied = true;
                    crate::log::line("games: frame timing needs Performance Log Users");
                }
                Start::Failed(code) => {
                    denied = true;
                    crate::log::line(format!("games: frame session failed ({code})"));
                }
            }
        } else if current.is_none() && session {
            stop_session();
            session = false;
        }

        let (fps, source) = if pid == 0 {
            (None, None)
        } else if let Some(f) = rivatuner_fps(pid) {
            (Some(f), Some("rivatuner"))
        } else if session {
            (session_fps(), Some("frames"))
        } else {
            (None, None)
        };

        // Ping every 2 s while a game runs: its server, else the internet.
        let (mut ping_ms, mut target, mut kind) = {
            let s = state().lock().unwrap();
            (s.ping, s.ping_target.clone(), s.ping_kind)
        };
        if current.is_none() {
            (ping_ms, target, kind) = (None, None, None);
        } else if last_ping.elapsed() >= Duration::from_secs(2) {
            last_ping = Instant::now();
            if let Some(next) = server_of(pid, session).filter(|ip| !silent.contains(ip)) {
                if server != Some(next) {
                    server = Some(next);
                    misses = 0;
                }
            }
            let measured = server.and_then(|ip| ping(ip).map(|ms| (ms, ip)));
            match (measured, server) {
                (Some((ms, ip)), _) => {
                    misses = 0;
                    (ping_ms, target, kind) = (Some(ms), Some(ip.to_string()), Some("server"));
                }
                (None, Some(ip)) => {
                    misses += 1;
                    // Many game servers never answer ICMP: after three misses, stop asking that one.
                    if misses >= 3 {
                        silent.insert(ip);
                        server = None;
                    }
                    if kind != Some("server") || misses >= 3 {
                        (ping_ms, target, kind) = (ping(INTERNET), Some(INTERNET.to_string()), Some("internet"));
                    }
                }
                (None, None) => (ping_ms, target, kind) = (ping(INTERNET), Some(INTERNET.to_string()), Some("internet")),
            }
        }

        {
            let mut s = state().lock().unwrap();
            s.game = current.clone();
            s.fps = fps;
            s.fps_source = source;
            s.fps_needs_setup = pid != 0 && denied && source.is_none();
            s.ping = ping_ms;
            s.ping_target = target;
            s.ping_kind = kind;
        }
        std::thread::sleep(Duration::from_millis(if current.is_some() { 1000 } else { 3000 }));
    }
}

#[tauri::command]
pub fn game_state() -> GameState {
    state().lock().unwrap().clone()
}

// ------------------------------------------------------------------ one-time setup

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReply {
    pub ok: bool,
    pub message: String,
}

/// "Performance Log Users" in this Windows' language (well-known SID S-1-5-32-559).
fn perf_log_users() -> Option<String> {
    unsafe {
        let mut sid = PSID::default();
        let text = wide("S-1-5-32-559");
        ConvertStringSidToSidW(PCWSTR(text.as_ptr()), &mut sid).ok()?;
        let mut name = [0u16; 256];
        let mut domain = [0u16; 256];
        let (mut nlen, mut dlen) = (name.len() as u32, domain.len() as u32);
        let mut use_ = SID_NAME_USE::default();
        let ok = LookupAccountSidW(PCWSTR::null(), sid, Some(PWSTR(name.as_mut_ptr())), &mut nlen, Some(PWSTR(domain.as_mut_ptr())), &mut dlen, &mut use_).is_ok();
        let _ = LocalFree(Some(HLOCAL(sid.0)));
        ok.then(|| String::from_utf16_lossy(&name[..nlen as usize]))
    }
}

/// Asks Windows (UAC) to add the user to Performance Log Users, so Island can
/// count frames without running as administrator. Takes effect at next sign-in.
#[tauri::command]
pub async fn game_fps_setup() -> SetupReply {
    tauri::async_runtime::spawn_blocking(|| {
        let group = perf_log_users().unwrap_or_else(|| "Performance Log Users".into());
        let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default());
        let params = wide(&format!("localgroup \"{group}\" \"{user}\" /add"));
        let (verb, file) = (wide("runas"), wide("net.exe"));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            if ShellExecuteExW(&mut info).is_err() {
                return SetupReply { ok: false, message: "Windows did not allow it (the prompt was cancelled).".into() };
            }
            let _ = WaitForSingleObject(info.hProcess, 60_000);
            let mut code = 1u32;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            crate::log::line(format!("games: Performance Log Users setup exited {code}"));
            // net exits 2 when the account is already a member: that is fine too.
            if code == 0 || code == 2 {
                SetupReply { ok: true, message: "Done. Sign out of Windows and back in, then FPS shows up in games.".into() }
            } else {
                SetupReply { ok: false, message: format!("Windows said no (code {code}).") }
            }
        }
    })
    .await
    .unwrap_or(SetupReply { ok: false, message: "Something went wrong.".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vdf_lines_give_their_values() {
        assert_eq!(vdf_value("\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"", "path").as_deref(), Some("D:\\SteamLibrary"));
        assert_eq!(vdf_value("\t\"name\"\t\t\"Counter-Strike 2\"", "name").as_deref(), Some("Counter-Strike 2"));
        assert_eq!(vdf_value("\t\"installdir\"\t\t\"x\"", "name"), None);
        assert_eq!(vdf_value("}", "name"), None);
    }

    #[test]
    fn frame_rate_comes_from_the_last_second_of_presents() {
        let freq = 10_000_000i64;
        let mut q = VecDeque::new();
        // 144 presents spread evenly over one second.
        for i in 0..=144 {
            q.push_back(i * freq / 144);
        }
        let fps = rate(&q, freq, freq).unwrap();
        assert!((fps - 144.0).abs() < 0.5, "{fps}");
        // Nothing for three seconds: the game is not drawing.
        assert!(rate(&q, freq * 4, freq).is_none());
    }

    #[test]
    fn only_real_peers_count() {
        assert!(usable_peer(Ipv4Addr::new(155, 133, 248, 34)));
        assert!(!usable_peer(Ipv4Addr::LOCALHOST));
        assert!(!usable_peer(Ipv4Addr::new(224, 0, 0, 251)));
    }

    #[test]
    fn folders_match_on_whole_names() {
        assert!(inside(r"D:\SteamLibrary\steamapps\common\Hades\Hades.exe", r"D:\SteamLibrary\steamapps\common\Hades"));
        assert!(!inside(r"D:\SteamLibrary\steamapps\common\Hades II\x.exe", r"D:\SteamLibrary\steamapps\common\Hades"));
    }
}
