// Bluetooth on a Mac: the radio's power (IOBluetooth's own preference calls, what the menu bar's
// switch uses), the paired devices and connecting them (IOBluetoothDevice), and their batteries
// (System Information's Bluetooth report, which lists AirPods' left, right and case).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde_json::Value;

use crate::msgwin::{nsstring, rust_string};

#[link(name = "IOBluetooth", kind = "framework")]
extern "C" {
    fn IOBluetoothPreferenceGetControllerPowerState() -> i32;
    fn IOBluetoothPreferenceSetControllerPowerState(state: i32);
}

/// Whether Bluetooth is on; None when this Mac has no Bluetooth.
pub fn powered() -> Option<bool> {
    if !has_controller() {
        return None;
    }
    Some(unsafe { IOBluetoothPreferenceGetControllerPowerState() } != 0)
}

pub fn set_powered(on: bool) -> bool {
    if !has_controller() {
        return false;
    }
    unsafe { IOBluetoothPreferenceSetControllerPowerState(on as i32) };
    // The radio takes a moment; say whether it got there.
    for _ in 0..20 {
        if powered() == Some(on) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn has_controller() -> bool {
    autoreleasepool(|_| unsafe {
        let c: *mut AnyObject = msg_send![class!(IOBluetoothHostController), defaultController];
        !c.is_null()
    })
}

/// A paired device as the hold menu lists it.
pub struct Paired {
    pub address: String,
    pub name: String,
    pub connected: bool,
    pub audio: bool,
}

/// "a1-b2-c3-d4-e5-f6" → "a1b2c3d4e5f6" (the Windows side's form: 12 lowercase hex digits).
pub fn plain_address(a: &str) -> String {
    a.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_lowercase()
}

/// 12 hex digits → "a1-b2-c3-d4-e5-f6", the form IOBluetooth takes.
fn dashed(id: &str) -> Option<String> {
    let hex = plain_address(id);
    (hex.len() == 12).then(|| hex.as_bytes().chunks(2).map(|p| String::from_utf8_lossy(p).to_string()).collect::<Vec<_>>().join("-"))
}

const AUDIO_MAJOR: u32 = 0x04; // kBluetoothDeviceClassMajorAudio

pub fn paired() -> Vec<Paired> {
    autoreleasepool(|_| unsafe {
        let list: *mut AnyObject = msg_send![class!(IOBluetoothDevice), pairedDevices];
        if list.is_null() {
            return Vec::new();
        }
        let n: usize = msg_send![list, count];
        (0..n)
            .filter_map(|i| {
                let d: *mut AnyObject = msg_send![list, objectAtIndex: i];
                if d.is_null() {
                    return None;
                }
                let name = rust_string(msg_send![d, name]).unwrap_or_default();
                let address = rust_string(msg_send![d, addressString]).map(|a| plain_address(&a)).unwrap_or_default();
                let connected: bool = msg_send![d, isConnected];
                let major: u32 = msg_send![d, deviceClassMajor];
                (!name.is_empty() && address.len() == 12).then_some(Paired { address, name, connected, audio: major == AUDIO_MAJOR })
            })
            .collect()
    })
}

/// Connects or disconnects a paired device by its address.
pub fn connect(id: &str, on: bool) -> bool {
    let Some(addr) = dashed(id) else { return false };
    autoreleasepool(|_| unsafe {
        let d: *mut AnyObject = msg_send![class!(IOBluetoothDevice), deviceWithAddressString: nsstring(&addr)];
        if d.is_null() {
            return false;
        }
        let r: i32 = if on { msg_send![d, openConnection] } else { msg_send![d, closeConnection] };
        r == 0
    })
}

// ------------------------------------------------------------------ batteries

/// (name, percent, connected) for each device the Bluetooth report gives a battery for.
pub fn parse_report(json: &str) -> Vec<(String, u8, bool)> {
    let pct = |v: Option<&Value>| v.and_then(Value::as_str).and_then(|s| s.trim_end_matches('%').trim().parse::<u8>().ok()).filter(|p| *p <= 100);
    let Ok(v) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut out = Vec::new();
    for section in v.get("SPBluetoothDataType").and_then(Value::as_array).into_iter().flatten() {
        for (key, connected) in [("device_connected", true), ("device_not_connected", false)] {
            for entry in section.get(key).and_then(Value::as_array).into_iter().flatten() {
                let Some(obj) = entry.as_object() else { continue };
                for (name, d) in obj {
                    let main = pct(d.get("device_batteryLevelMain")).or_else(|| pct(d.get("device_batteryLevel")));
                    // Earbuds: the lower bud is what runs out first.
                    let buds = [pct(d.get("device_batteryLevelLeft")), pct(d.get("device_batteryLevelRight"))].into_iter().flatten().min();
                    if let Some(p) = buds.or(main) {
                        out.push((name.clone(), p, connected));
                    }
                }
            }
        }
    }
    out
}

static CACHE: Mutex<Option<(Instant, Vec<(String, u8, bool)>)>> = Mutex::new(None);
static REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The batteries from the last report (read in the background: it takes a second or two), and a
/// fresh read started when that one is over 50 s old.
pub fn batteries() -> Vec<(String, u8, bool)> {
    let (fresh, list) = {
        let c = CACHE.lock().unwrap();
        match c.as_ref() {
            Some((at, l)) => (at.elapsed() < Duration::from_secs(50), l.clone()),
            None => (false, Vec::new()),
        }
    };
    if !fresh && !REFRESHING.swap(true, std::sync::atomic::Ordering::Relaxed) {
        std::thread::spawn(|| {
            let out = std::process::Command::new("/usr/sbin/system_profiler").args(["SPBluetoothDataType", "-json", "-detailLevel", "basic"]).output();
            let list = out.map(|o| parse_report(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default();
            *CACHE.lock().unwrap() = Some((Instant::now(), list));
            REFRESHING.store(false, std::sync::atomic::Ordering::Relaxed);
        });
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_gives_earbuds_and_mice() {
        let json = r#"{"SPBluetoothDataType":[{"device_connected":[{"Moss's AirPods Pro":{"device_address":"AA:BB","device_batteryLevelCase":"40%","device_batteryLevelLeft":"85%","device_batteryLevelRight":"90%"}}],"device_not_connected":[{"Magic Mouse":{"device_batteryLevelMain":"62%"}},{"Old Speaker":{"device_address":"x"}}]}]}"#;
        let list = parse_report(json);
        assert_eq!(list, vec![("Moss's AirPods Pro".to_string(), 85, true), ("Magic Mouse".to_string(), 62, false)]);
        assert!(parse_report("not json").is_empty());
    }

    #[test]
    fn addresses_are_written_both_ways() {
        assert_eq!(plain_address("A1-B2-C3-D4-E5-F6"), "a1b2c3d4e5f6");
        assert_eq!(dashed("a1b2c3d4e5f6").as_deref(), Some("a1-b2-c3-d4-e5-f6"));
        assert_eq!(dashed("123"), None);
    }
}
