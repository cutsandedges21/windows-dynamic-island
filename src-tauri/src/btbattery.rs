//! Battery of paired Bluetooth devices (earbuds, headphones), the number Settings > Bluetooth & devices shows.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtBattery {
    pub name: String,
    pub percent: u8,
    pub connected: bool,
}

/// "Crusher ANC 2 Hands-Free AG" -> "Crusher ANC 2": one device shows up as a node per profile.
#[cfg_attr(not(windows), allow(dead_code))]
fn clean(name: &str) -> String {
    let mut n = name.trim();
    for tail in [" Hands-Free AG", " Hands-Free HF", " Hands-Free", " Stereo", " Avrcp Transport"] {
        if let Some(s) = n.strip_suffix(tail) {
            n = s.trim_end();
            break;
        }
    }
    n.to_string()
}

/// One entry per name: a connected node wins, then the higher reading.
#[cfg_attr(not(windows), allow(dead_code))]
fn dedupe(list: Vec<BtBattery>) -> Vec<BtBattery> {
    let mut out: Vec<BtBattery> = Vec::new();
    for b in list {
        let b = BtBattery { name: clean(&b.name), ..b };
        if b.name.is_empty() || b.percent > 100 {
            continue;
        }
        match out.iter_mut().find(|o| o.name.eq_ignore_ascii_case(&b.name)) {
            Some(o) => {
                if (b.connected, b.percent) > (o.connected, o.percent) {
                    *o = b;
                }
            }
            None => out.push(b),
        }
    }
    out
}

#[tauri::command]
pub fn bt_batteries() -> Vec<BtBattery> {
    #[cfg(windows)]
    {
        dedupe(win::read())
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
mod win {
    use super::BtBattery;
    use windows::core::{w, GUID};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDevicePropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, HDEVINFO,
        SP_DEVINFO_DATA,
    };
    use windows::Win32::Devices::Properties::{DEVPKEY_Device_FriendlyName, DEVPKEY_NAME, DEVPROPTYPE};
    use windows::Win32::Foundation::DEVPROPKEY;

    const BATTERY: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5), pid: 2 };
    const CONNECTED: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x83da6326_97a6_4088_9453_a1923f573b29), pid: 15 };

    fn prop(set: HDEVINFO, info: &SP_DEVINFO_DATA, key: &DEVPROPKEY) -> Option<Vec<u8>> {
        let mut ty = DEVPROPTYPE::default();
        let mut buf = vec![0u8; 512];
        let mut need = 0u32;
        unsafe { SetupDiGetDevicePropertyW(set, info, key, &mut ty, Some(&mut buf), Some(&mut need as *mut u32), 0) }.ok()?;
        buf.truncate(need as usize);
        Some(buf)
    }

    fn text(b: &[u8]) -> String {
        let w: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
        String::from_utf16_lossy(&w)
    }

    pub fn read() -> Vec<BtBattery> {
        let mut out = Vec::new();
        for en in [w!("BTHENUM"), w!("BTHLE")] {
            let Ok(set) = (unsafe { SetupDiGetClassDevsW(None, en, None, DIGCF_ALLCLASSES | DIGCF_PRESENT) }) else { continue };
            let mut i = 0;
            loop {
                let mut info = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
                if unsafe { SetupDiEnumDeviceInfo(set, i, &mut info) }.is_err() {
                    break;
                }
                i += 1;
                let Some(percent) = prop(set, &info, &BATTERY).and_then(|b| b.first().copied()) else { continue };
                let name = prop(set, &info, &DEVPKEY_Device_FriendlyName).or_else(|| prop(set, &info, &DEVPKEY_NAME)).map(|b| text(&b)).unwrap_or_default();
                let connected = prop(set, &info, &CONNECTED).and_then(|b| b.first().copied()).is_some_and(|c| c != 0);
                out.push(BtBattery { name, percent, connected });
            }
            let _ = unsafe { SetupDiDestroyDeviceInfoList(set) };
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(name: &str, percent: u8, connected: bool) -> BtBattery {
        BtBattery { name: name.into(), percent, connected }
    }

    #[test]
    fn cleans_profile_names() {
        assert_eq!(clean("Crusher ANC 2 Hands-Free AG"), "Crusher ANC 2");
        assert_eq!(clean("Moss Hands-Free HF"), "Moss");
        assert_eq!(clean("AirPods Pro"), "AirPods Pro");
    }

    #[test]
    fn dedupe_keeps_connected_then_higher() {
        let out = dedupe(vec![b("AirPods Pro Hands-Free AG", 70, false), b("AirPods Pro", 80, true), b("Mouse", 50, false), b("Mouse", 40, false), b("", 9, true), b("Bad", 200, true)]);
        assert_eq!(out, vec![b("AirPods Pro", 80, true), b("Mouse", 50, false)]);
    }

    #[test]
    #[ignore]
    fn prints_this_pc() {
        let t = std::time::Instant::now();
        let list = bt_batteries();
        println!("{list:?} in {:?}", t.elapsed());
    }
}
