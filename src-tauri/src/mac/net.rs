// The network on a Mac, in the shapes net.rs gives on Windows: bytes in and out of the real
// interfaces (the routing table's interface list), whether there is a way out (System
// Configuration's reachability), the Wi-Fi network's name (CoreWLAN), and the dev servers
// listening on this Mac (lsof, which every Mac has).

use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetSample {
    rx_bps: f64,
    tx_bps: f64,
    connected: bool,
    internet: bool,
    name: Option<String>,
    wifi: bool,
    vpn: bool,
}

static LAST: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

/// Interfaces that carry nothing of the user's own: loopback, Apple's peer-to-peer links, bridges,
/// the Mac's own tunnels and the like.
fn counted(name: &str) -> bool {
    !["lo", "gif", "stf", "awdl", "llw", "bridge", "ap", "anpi", "utun", "ipsec", "ppp", "XHC", "vmenet", "pktap"].iter().any(|p| name.starts_with(p))
}

/// A VPN's own interface (WireGuard, Tailscale, OpenVPN and the system's IKEv2 all show as one).
fn vpn_like(name: &str) -> bool {
    ["utun", "ipsec", "ppp", "tun", "tap"].iter().any(|p| name.starts_with(p))
}

/// (rx bytes, tx bytes) over the real interfaces, and the interfaces that are up with an IPv4 address.
fn counters() -> (u64, u64, Vec<String>) {
    let mut mib = [libc::CTL_NET, libc::PF_ROUTE, 0, 0, libc::NET_RT_IFLIST2, 0];
    let mut len: libc::size_t = 0;
    unsafe {
        if libc::sysctl(mib.as_mut_ptr(), 6, std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) != 0 || len == 0 {
            return (0, 0, Vec::new());
        }
        let mut buf = vec![0u8; len];
        if libc::sysctl(mib.as_mut_ptr(), 6, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) != 0 {
            return (0, 0, Vec::new());
        }
        buf.truncate(len);
        let (mut rx, mut tx) = (0u64, 0u64);
        let mut at = 0usize;
        while at + std::mem::size_of::<libc::if_msghdr2>() <= buf.len() {
            let hdr = std::ptr::read_unaligned(buf.as_ptr().add(at).cast::<libc::if_msghdr2>());
            if hdr.ifm_msglen == 0 {
                break;
            }
            if hdr.ifm_type as i32 == libc::RTM_IFINFO2 && hdr.ifm_flags & libc::IFF_UP != 0 {
                let mut name = [0 as libc::c_char; libc::IF_NAMESIZE];
                if !libc::if_indextoname(hdr.ifm_index as u32, name.as_mut_ptr()).is_null() {
                    let n = CStr::from_ptr(name.as_ptr()).to_string_lossy().to_string();
                    if counted(&n) {
                        rx += hdr.ifm_data.ifi_ibytes;
                        tx += hdr.ifm_data.ifi_obytes;
                    }
                }
            }
            at += hdr.ifm_msglen as usize;
        }
        (rx, tx, ipv4_up())
    }
}

/// Interfaces that are up and have an IPv4 address.
fn ipv4_up() -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut cur = list;
        while !cur.is_null() {
            let a = &*cur;
            if !a.ifa_addr.is_null() && (*a.ifa_addr).sa_family as i32 == libc::AF_INET && a.ifa_flags & libc::IFF_UP as u32 != 0 {
                let n = CStr::from_ptr(a.ifa_name).to_string_lossy().to_string();
                if !out.contains(&n) {
                    out.push(n);
                }
            }
            cur = a.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    out
}

#[link(name = "SystemConfiguration", kind = "framework")]
extern "C" {
    fn SCNetworkReachabilityCreateWithAddress(allocator: *const c_void, address: *const libc::sockaddr) -> *const c_void;
    fn SCNetworkReachabilityGetFlags(target: *const c_void, flags: *mut u32) -> bool;
}

const REACHABLE: u32 = 1 << 1; // kSCNetworkReachabilityFlagsReachable
const CONNECTION_REQUIRED: u32 = 1 << 2; // kSCNetworkReachabilityFlagsConnectionRequired

/// Whether there is a way out to the internet (a route the Mac would use), without sending anything.
fn reachable() -> bool {
    unsafe {
        let mut addr: libc::sockaddr_in = std::mem::zeroed();
        addr.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
        addr.sin_family = libc::AF_INET as u8;
        let target = SCNetworkReachabilityCreateWithAddress(std::ptr::null(), (&addr as *const libc::sockaddr_in).cast());
        if target.is_null() {
            return true;
        }
        let mut flags = 0u32;
        let ok = SCNetworkReachabilityGetFlags(target, &mut flags);
        crate::mac::cf::CFRelease(target);
        !ok || (flags & REACHABLE != 0 && flags & CONNECTION_REQUIRED == 0)
    }
}

#[link(name = "CoreWLAN", kind = "framework")]
extern "C" {}

/// (Wi-Fi interface name, network name) from CoreWLAN. The name stays None where macOS keeps it
/// back (from macOS 14 on, only apps the user let use Location Services see it).
pub fn wifi() -> (Option<String>, Option<String>) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    fn text(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let p: *const libc::c_char = unsafe { msg_send![s, UTF8String] };
        (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().to_string()).filter(|t| !t.is_empty())
    }
    unsafe {
        let client: *mut AnyObject = msg_send![class!(CWWiFiClient), sharedWiFiClient];
        if client.is_null() {
            return (None, None);
        }
        let iface: *mut AnyObject = msg_send![client, interface];
        if iface.is_null() {
            return (None, None);
        }
        let on: bool = msg_send![iface, powerOn];
        if !on {
            return (None, None);
        }
        let name: *mut AnyObject = msg_send![iface, interfaceName];
        let ssid: *mut AnyObject = msg_send![iface, ssid];
        (text(name), text(ssid))
    }
}

#[tauri::command]
pub async fn net_sample() -> NetSample {
    tauri::async_runtime::spawn_blocking(|| {
        let (rx, tx, up) = counters();
        let now = Instant::now();
        let (rx_bps, tx_bps) = {
            let mut last = LAST.lock().unwrap();
            let r = match *last {
                Some((t0, rx0, tx0)) => {
                    let dt = now.duration_since(t0).as_secs_f64().max(0.001);
                    (rx.saturating_sub(rx0) as f64 / dt, tx.saturating_sub(tx0) as f64 / dt)
                }
                None => (0.0, 0.0),
            };
            *last = Some((now, rx, tx));
            r
        };
        let (wifi_if, ssid) = wifi();
        let wifi = wifi_if.as_ref().is_some_and(|w| up.contains(w));
        let connected = up.iter().any(|n| counted(n));
        let vpn = up.iter().any(|n| vpn_like(n));
        NetSample { rx_bps, tx_bps, connected, internet: connected && reachable(), name: if wifi { ssid } else { None }, wifi, vpn }
    })
    .await
    .unwrap_or(NetSample { rx_bps: 0.0, tx_bps: 0.0, connected: true, internet: true, name: None, wifi: false, vpn: false })
}

// ------------------------------------------------------------------ listeners

#[derive(Serialize, Debug, PartialEq)]
pub struct PortRow {
    port: u16,
    pid: u32,
    process: String,
    address: String,
}

/// lsof's field output (-F pcn): a `p` line per process, then `c` (its command) and an `n` line per
/// listening socket ("*:3000", "127.0.0.1:5173", "[::1]:8080").
fn parse_lsof(out: &str, names: &HashMap<u32, String>) -> Vec<PortRow> {
    let mut rows: Vec<PortRow> = Vec::new();
    let (mut pid, mut command) = (0u32, String::new());
    for line in out.lines() {
        let (tag, value) = line.split_at(line.len().min(1));
        match tag {
            "p" => {
                pid = value.parse().unwrap_or(0);
                command.clear();
            }
            "c" => command = value.to_string(),
            "n" => {
                let Some((host, port)) = value.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let address = match host.trim_start_matches('[').trim_end_matches(']') {
                    "*" => "0.0.0.0".to_string(),
                    h => h.to_string(),
                };
                if rows.iter().any(|r| r.port == port && r.pid == pid) {
                    continue;
                }
                let process = names.get(&pid).cloned().unwrap_or_else(|| command.to_lowercase());
                rows.push(PortRow { port, pid, process, address });
            }
            _ => {}
        }
    }
    rows.sort_by_key(|p| p.port);
    rows
}

#[tauri::command]
pub async fn ports_listening() -> Vec<PortRow> {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(out) = std::process::Command::new("/usr/sbin/lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).output() else {
            return Vec::new();
        };
        let names: HashMap<u32, String> = crate::procs::snapshot().into_iter().map(|r| (r.0, r.2)).collect();
        parse_lsof(&String::from_utf8_lossy(&out.stdout), &names)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_lines_become_listeners() {
        let out = "p501\ncnode\nf23\nn*:3000\nf24\nn[::1]:3000\np777\ncPython\nf3\nn127.0.0.1:8000\n";
        let names: HashMap<u32, String> = [(501, "node".to_string())].into_iter().collect();
        let rows = parse_lsof(out, &names);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], PortRow { port: 3000, pid: 501, process: "node".into(), address: "0.0.0.0".into() });
        assert_eq!(rows[1], PortRow { port: 8000, pid: 777, process: "python".into(), address: "127.0.0.1".into() });
    }

    #[test]
    fn the_mac_s_own_interfaces_are_left_out() {
        assert!(counted("en0") && counted("en1"));
        assert!(!counted("lo0") && !counted("awdl0") && !counted("utun3") && !counted("bridge0"));
        assert!(vpn_like("utun4") && !vpn_like("en0"));
    }

    #[test]
    fn a_listener_started_here_is_found() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let rows = rt.block_on(ports_listening());
        assert!(rows.iter().any(|r| r.port == port && r.pid == std::process::id()), "{port} not in {rows:?}");
        let (rx, tx, _) = counters();
        assert!(rx > 0 || tx > 0, "a CI Mac has traffic");
    }
}
