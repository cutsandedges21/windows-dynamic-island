// Control Center's hold menus on a Mac: the Wi-Fi networks in reach (CoreWLAN) and the paired
// Bluetooth devices (mac/bluetooth.rs), in radiomenu.rs's shapes. From macOS 14 on, network names
// are only shown to apps the user lets use Location Services: then the list says so (`denied`).

use std::process::Command;

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::msg_send;
use serde::Serialize;

use super::msgwin::rust_string;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WifiNet {
    pub ssid: String,
    pub secure: bool,
    pub connected: bool,
    pub known: bool,
    pub signal: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub audio: bool,
}

#[derive(Serialize, Debug, Default)]
pub struct WifiList {
    pub networks: Vec<WifiNet>,
    pub denied: bool,
}

/// A signal's strength (dBm) as 0–100: -90 dBm and weaker is 0, -30 and stronger is 100.
pub fn signal(rssi: i64) -> u32 {
    (((rssi.clamp(-90, -30) + 90) as f64 / 60.0) * 100.0).round() as u32
}

/// The networks the Mac remembers (its preferred networks).
fn known_names(iface: *mut AnyObject) -> Vec<String> {
    unsafe {
        let config: *mut AnyObject = msg_send![iface, configuration];
        if config.is_null() {
            return Vec::new();
        }
        let profiles: *mut AnyObject = msg_send![config, networkProfiles];
        if profiles.is_null() {
            return Vec::new();
        }
        let n: usize = msg_send![profiles, count];
        (0..n)
            .filter_map(|i| {
                let profile: *mut AnyObject = msg_send![profiles, objectAtIndex: i];
                rust_string(msg_send![profile, ssid])
            })
            .collect()
    }
}

/// (networks, names held back): from the last scan the Mac kept, or a fresh one when `scan`.
fn networks(scan: bool) -> (Vec<WifiNet>, bool) {
    autoreleasepool(|_| unsafe {
        let iface = crate::radios::wifi_interface();
        if iface.is_null() {
            return (Vec::new(), false);
        }
        let set: *mut AnyObject = if scan {
            msg_send![iface, scanForNetworksWithName: std::ptr::null_mut::<AnyObject>(), error: std::ptr::null_mut::<*mut AnyObject>()]
        } else {
            msg_send![iface, cachedScanResults]
        };
        if set.is_null() {
            return (Vec::new(), false);
        }
        let all: *mut AnyObject = msg_send![set, allObjects];
        let n: usize = msg_send![all, count];
        let current = rust_string(msg_send![iface, ssid]);
        let known = known_names(iface);
        let mut hidden = 0usize;
        let mut list = Vec::new();
        for i in 0..n {
            let net: *mut AnyObject = msg_send![all, objectAtIndex: i];
            let Some(ssid) = rust_string(msg_send![net, ssid]).filter(|s| !s.is_empty()) else {
                hidden += 1;
                continue;
            };
            let rssi: isize = msg_send![net, rssiValue];
            // kCWSecurityNone = 0: an open network.
            let open: bool = msg_send![net, supportsSecurity: 0isize];
            list.push(WifiNet { connected: current.as_deref() == Some(ssid.as_str()), known: known.contains(&ssid), secure: !open, signal: signal(rssi as i64), ssid });
        }
        // Every network came back without a name: macOS keeps them back from Island.
        (list, n > 0 && hidden == n)
    })
}

/// One row per network name: the connected one wins, then one the Mac knows, then the strongest;
/// sorted by name, ignoring case (as radiomenu.rs does on Windows).
fn merge(list: Vec<WifiNet>) -> Vec<WifiNet> {
    let mut out: Vec<WifiNet> = Vec::new();
    for n in list {
        match out.iter_mut().find(|o| o.ssid == n.ssid) {
            Some(o) => {
                if (n.connected, n.known, n.signal) > (o.connected, o.known, o.signal) {
                    *o = n;
                }
            }
            None => out.push(n),
        }
    }
    out.sort_by_key(|n| n.ssid.to_lowercase());
    out
}

#[tauri::command]
pub async fn wifi_networks() -> WifiList {
    tauri::async_runtime::spawn_blocking(|| {
        let (list, denied) = networks(false);
        WifiList { networks: merge(list), denied }
    })
    .await
    .unwrap_or_default()
}

/// A fresh scan (the hold menu opening): it takes a few seconds, so it runs in the background and
/// the next read has its results.
#[tauri::command]
pub async fn wifi_scan() -> bool {
    std::thread::spawn(|| {
        let _ = networks(true);
    });
    true
}

/// Joins a network the Mac remembers (its password is in the Keychain); false when it doesn't know it.
#[tauri::command]
pub async fn wifi_join(ssid: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let (iface, known) = autoreleasepool(|_| {
            let i = crate::radios::wifi_interface();
            if i.is_null() {
                return (None, Vec::new());
            }
            (rust_string(unsafe { msg_send![i, interfaceName] }), known_names(i))
        });
        let Some(iface) = iface else { return false };
        if !known.contains(&ssid) {
            return false;
        }
        let ok = Command::new("/usr/sbin/networksetup").args(["-setairportnetwork", &iface, &ssid]).output().is_ok_and(|o| o.status.success() && o.stdout.is_empty());
        crate::log::line(format!("wifi join ok={ok}"));
        ok
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn bt_devices() -> Vec<BtDevice> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut list: Vec<BtDevice> = crate::mac::bluetooth::paired().into_iter().map(|p| BtDevice { id: p.address, name: p.name, connected: p.connected, audio: p.audio }).collect();
        list.sort_by_key(|d| d.name.to_lowercase());
        list.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name) && !a.connected);
        list
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn bt_connect(id: String, connect: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::mac::bluetooth::connect(&id, connect)).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_reads_as_a_share() {
        assert_eq!(signal(-30), 100);
        assert_eq!(signal(-20), 100);
        assert_eq!(signal(-90), 0);
        assert_eq!(signal(-60), 50);
    }
}
