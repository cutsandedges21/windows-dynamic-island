// Network: throughput over physical adapters (deltas of the interface counters),
// connectivity and the network's name from the Network List Manager, VPN
// adapters, and TCP listeners for the local-servers activity.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetExtendedTcpTable, GetIfTable2, MIB_IF_TABLE2, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::Networking::NetworkListManager::{
    INetwork, INetworkListManager, NetworkListManager, NLM_CONNECTIVITY_DISCONNECTED, NLM_CONNECTIVITY_IPV4_INTERNET,
    NLM_CONNECTIVITY_IPV6_INTERNET, NLM_ENUM_NETWORK_CONNECTED,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_TYPE_IEEE80211: u32 = 71;
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_PROP_VIRTUAL: u32 = 53;
const IF_TYPE_TUNNEL: u32 = 131;

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

fn wide_str(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// (rx bytes, tx bytes, wifi up, vpn up) summed over real adapters.
fn counters() -> (u64, u64, bool, bool) {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    unsafe {
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return (0, 0, false, false);
        }
        let t = &*table;
        let rows = std::slice::from_raw_parts(t.Table.as_ptr(), t.NumEntries as usize);
        let (mut rx, mut tx, mut wifi, mut vpn) = (0u64, 0u64, false, false);
        for r in rows {
            let up = r.OperStatus.0 == 1;
            if !up || r.Type == IF_TYPE_SOFTWARE_LOOPBACK {
                continue;
            }
            let bits = r.InterfaceAndOperStatusFlags._bitfield;
            let hardware = bits & 0x1 != 0;
            let filter = bits & 0x2 != 0;
            let desc = wide_str(&r.Description).to_lowercase();
            let is_vpn = matches!(r.Type, IF_TYPE_PPP | IF_TYPE_PROP_VIRTUAL | IF_TYPE_TUNNEL)
                && ["vpn", "wireguard", "tap-", "tun", "openvpn", "nordlynx", "proton", "tailscale", "zerotier"].iter().any(|k| desc.contains(k));
            if is_vpn {
                vpn = true;
            }
            if hardware && !filter {
                rx += r.InOctets;
                tx += r.OutOctets;
                if r.Type == IF_TYPE_IEEE80211 {
                    wifi = true;
                }
            }
        }
        FreeMibTable(table as *const _);
        (rx, tx, wifi, vpn)
    }
}

fn connectivity() -> (bool, bool, Option<String>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(nlm) = CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL) else { return (true, true, None) };
        let flags = nlm.GetConnectivity().map(|c| c.0).unwrap_or(0);
        let connected = flags != NLM_CONNECTIVITY_DISCONNECTED.0;
        let internet = flags & (NLM_CONNECTIVITY_IPV4_INTERNET.0 | NLM_CONNECTIVITY_IPV6_INTERNET.0) != 0;
        let mut name = None;
        if let Ok(list) = nlm.GetNetworks(NLM_ENUM_NETWORK_CONNECTED) {
            let mut slot: [Option<INetwork>; 1] = [None];
            let mut fetched = 0u32;
            if list.Next(&mut slot, Some(&mut fetched)).is_ok() && fetched == 1 {
                if let Some(net) = &slot[0] {
                    name = net.GetName().ok().map(|b| b.to_string()).filter(|s| !s.is_empty());
                }
            }
        }
        (connected, internet, name)
    }
}

#[tauri::command]
pub async fn net_sample() -> NetSample {
    tauri::async_runtime::spawn_blocking(|| {
        let (rx, tx, wifi, vpn) = counters();
        let now = Instant::now();
        let mut last = LAST.lock().unwrap();
        let (rx_bps, tx_bps) = match *last {
            Some((t0, rx0, tx0)) => {
                let dt = now.duration_since(t0).as_secs_f64().max(0.001);
                (rx.saturating_sub(rx0) as f64 / dt, tx.saturating_sub(tx0) as f64 / dt)
            }
            None => (0.0, 0.0),
        };
        *last = Some((now, rx, tx));
        let (connected, internet, name) = connectivity();
        NetSample { rx_bps, tx_bps, connected, internet, name, wifi, vpn }
    })
    .await
    .unwrap_or(NetSample { rx_bps: 0.0, tx_bps: 0.0, connected: true, internet: true, name: None, wifi: false, vpn: false })
}

// ------------------------------------------------------------------ listeners

#[derive(Serialize)]
pub struct PortRow {
    port: u16,
    pid: u32,
    process: String,
    address: String,
}

fn table(family: u32) -> Vec<u8> {
    let mut size = 0u32;
    unsafe {
        let _ = GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if size == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u8; size as usize + 1024];
        size = buf.len() as u32;
        if GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0 {
            return Vec::new();
        }
        buf
    }
}

#[tauri::command]
pub async fn ports_listening() -> Vec<PortRow> {
    tauri::async_runtime::spawn_blocking(|| {
        let names: HashMap<u32, String> = crate::procs::snapshot(false).into_iter().map(|r| (r.0, r.2)).collect();
        let mut out: Vec<PortRow> = Vec::new();
        let v4 = table(AF_INET.0 as u32);
        if v4.len() >= 4 {
            unsafe {
                let t = &*(v4.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                for r in std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) {
                    let port = u16::from_be((r.dwLocalPort & 0xffff) as u16);
                    let a = r.dwLocalAddr.to_le_bytes();
                    out.push(PortRow { port, pid: r.dwOwningPid, process: names.get(&r.dwOwningPid).cloned().unwrap_or_default(), address: format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3]) });
                }
            }
        }
        let v6 = table(AF_INET6.0 as u32);
        if v6.len() >= 4 {
            unsafe {
                let t = &*(v6.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                for r in std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) {
                    let port = u16::from_be((r.dwLocalPort & 0xffff) as u16);
                    let loopback = r.ucLocalAddr[..15].iter().all(|b| *b == 0) && r.ucLocalAddr[15] == 1;
                    if out.iter().any(|p| p.port == port && p.pid == r.dwOwningPid) {
                        continue;
                    }
                    out.push(PortRow { port, pid: r.dwOwningPid, process: names.get(&r.dwOwningPid).cloned().unwrap_or_default(), address: if loopback { "::1".into() } else { "::".into() } });
                }
            }
        }
        out.sort_by_key(|p| p.port);
        out
    })
    .await
    .unwrap_or_default()
}
