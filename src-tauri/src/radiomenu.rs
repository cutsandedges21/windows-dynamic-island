// What Control Center's Wi-Fi and Bluetooth hold menus list, and what their rows do (Justin's
// iPhone-style menus, src/activities/control-hub.ts). Wi-Fi: the networks in reach from the WLAN
// API (the list Windows' own Wi-Fi flyout shows), joining one Windows already has a profile for.
// Bluetooth: the paired devices with whether each is connected (their device nodes, the same
// property Settings › Bluetooth & devices shows), and connecting or disconnecting a paired stereo
// device (earbuds, a speaker) the way Settings' Connect button does: the Bluetooth audio driver's
// one-shot reconnect / disconnect property on its kernel-streaming filter (the call ToothTray
// uses). The Mac twin is mac/radiomenu.rs.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WifiNet {
    pub ssid: String,
    /// Needs a password (or some other sign-in).
    pub secure: bool,
    pub connected: bool,
    /// Windows has a profile for it: a tap joins it with no questions.
    pub known: bool,
    /// 0-100.
    pub signal: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    /// Its Bluetooth address, 12 lowercase hex digits: what a tap connects.
    pub id: String,
    pub name: String,
    pub connected: bool,
    /// A stereo audio device (earbuds, a speaker): Island can connect and disconnect it.
    pub audio: bool,
}

/// One row per network name: the connected one wins, then one Windows knows, then the strongest.
/// Hidden networks (no name) are left out. Sorted by name, ignoring case, as the iPhone lists them.
pub fn merge_networks(list: Vec<WifiNet>) -> Vec<WifiNet> {
    let mut out: Vec<WifiNet> = Vec::new();
    for n in list {
        if n.ssid.trim().is_empty() {
            continue;
        }
        match out.iter_mut().find(|o| o.ssid == n.ssid) {
            Some(o) => {
                let secure = o.secure || n.secure;
                let (connected, known, signal) = (o.connected || n.connected, o.known || n.known, o.signal.max(n.signal));
                *o = WifiNet { ssid: o.ssid.clone(), secure, connected, known, signal };
            }
            None => out.push(n),
        }
    }
    out.sort_by(|a, b| a.ssid.to_lowercase().cmp(&b.ssid.to_lowercase()).then(a.ssid.cmp(&b.ssid)));
    out
}

/// One row per device name (Windows keeps a node per protocol, and old pairings of the same mouse):
/// connected wins, and audio sticks. Sorted by name, ignoring case, as the iPhone lists them.
pub fn merge_devices(list: Vec<BtDevice>) -> Vec<BtDevice> {
    let mut out: Vec<BtDevice> = Vec::new();
    for d in list {
        let name = d.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        match out.iter_mut().find(|o| o.name.to_lowercase() == name.to_lowercase()) {
            Some(o) => {
                // The node a tap should connect: the connected one, else one with stereo audio.
                if (d.connected, d.audio) > (o.connected, o.audio) {
                    o.id = d.id.clone();
                }
                o.connected |= d.connected;
                o.audio |= d.audio;
            }
            None => out.push(BtDevice { name, ..d }),
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    out
}

/// A paired device's node, `BTHENUM\DEV_D03E07E7FDD1\...` or `BTHLE\DEV_...`: its address in
/// lowercase. None for its services' nodes (`BTHENUM\{0000110b-...}_VID...`).
pub fn bt_address(instance: &str) -> Option<String> {
    let mut parts = instance.split('\\');
    let bus = parts.next()?;
    if !bus.eq_ignore_ascii_case("BTHENUM") && !bus.eq_ignore_ascii_case("BTHLE") {
        return None;
    }
    let dev = parts.next()?;
    let hex = dev.get(..4).filter(|p| p.eq_ignore_ascii_case("DEV_")).and(dev.get(4..))?;
    (hex.len() == 12 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_lowercase())
}

/// A Bluetooth audio filter's id (lowercase), `...#7&3025e752&0&d03e07e7fdd1_c00000000#...`: the
/// device's address.
pub fn filter_address(id: &str) -> Option<String> {
    let at = id.find("_c00000000")?;
    let hex = id.get(at.checked_sub(12)?..at)?;
    hex.chars().all(|c| c.is_ascii_hexdigit()).then(|| hex.to_string())
}

#[cfg(windows)]
mod wifi {
    use super::WifiNet;
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WiFi::{
        dot11_BSS_type_any, wlan_connection_mode_profile, WlanCloseHandle, WlanConnect, WlanEnumInterfaces, WlanFreeMemory, WlanGetAvailableNetworkList, WlanOpenHandle, WlanScan,
        DOT11_SSID, WLAN_AVAILABLE_NETWORK, WLAN_AVAILABLE_NETWORK_LIST, WLAN_CONNECTION_PARAMETERS, WLAN_INTERFACE_INFO_LIST,
    };

    const CONNECTED: u32 = 0x1;
    const HAS_PROFILE: u32 = 0x2;
    /// Windows refuses the list to apps without location access (Windows 11 24H2 and later).
    pub const ACCESS_DENIED: u32 = 5;

    struct Client(HANDLE);
    impl Drop for Client {
        fn drop(&mut self) {
            unsafe {
                WlanCloseHandle(self.0, None);
            }
        }
    }

    fn open() -> Result<Client, u32> {
        let mut ver = 0u32;
        let mut h = HANDLE::default();
        let r = unsafe { WlanOpenHandle(2, None, &mut ver, &mut h) };
        if r != 0 {
            return Err(r);
        }
        Ok(Client(h))
    }

    fn interfaces(c: &Client) -> Result<Vec<GUID>, u32> {
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        let r = unsafe { WlanEnumInterfaces(c.0, None, &mut list) };
        if r != 0 || list.is_null() {
            return Err(r);
        }
        let out = unsafe {
            let n = (*list).dwNumberOfItems as usize;
            let first = (*list).InterfaceInfo.as_ptr();
            (0..n).map(|i| (*first.add(i)).InterfaceGuid).collect()
        };
        unsafe { WlanFreeMemory(list as *const _) };
        Ok(out)
    }

    fn ssid_text(s: &DOT11_SSID) -> String {
        let len = (s.uSSIDLength as usize).min(32);
        String::from_utf8_lossy(&s.ucSSID[..len]).into_owned()
    }

    fn wide(s: &[u16]) -> String {
        String::from_utf16_lossy(&s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())])
    }

    /// The networks in reach on every Wi-Fi adapter (Windows' last scan), or the WLAN error.
    pub fn networks() -> Result<Vec<WifiNet>, u32> {
        let c = open()?;
        let mut out = Vec::new();
        for g in interfaces(&c)? {
            let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = std::ptr::null_mut();
            let r = unsafe { WlanGetAvailableNetworkList(c.0, &g, 0, None, &mut list) };
            if r != 0 || list.is_null() {
                if r == ACCESS_DENIED {
                    return Err(r);
                }
                continue;
            }
            unsafe {
                let n = (*list).dwNumberOfItems as usize;
                let first: *const WLAN_AVAILABLE_NETWORK = (*list).Network.as_ptr();
                for i in 0..n {
                    let a = &*first.add(i);
                    out.push(WifiNet {
                        ssid: ssid_text(&a.dot11Ssid),
                        secure: a.bSecurityEnabled.as_bool(),
                        connected: a.dwFlags & CONNECTED != 0,
                        known: a.dwFlags & HAS_PROFILE != 0,
                        signal: a.wlanSignalQuality.min(100),
                    });
                }
                WlanFreeMemory(list as *const _);
            }
        }
        Ok(out)
    }

    /// Asks every adapter for a fresh scan; the results come in over the next few seconds.
    pub fn scan() -> bool {
        let Ok(c) = open() else { return false };
        let Ok(list) = interfaces(&c) else { return false };
        list.iter().fold(false, |ok, g| ok | (unsafe { WlanScan(c.0, g, None, None, None) } == 0))
    }

    /// Joins `ssid` with the profile Windows keeps for it; false when there is none (or it failed).
    pub fn join(ssid: &str) -> bool {
        let Ok(c) = open() else { return false };
        let Ok(ifs) = interfaces(&c) else { return false };
        for g in ifs {
            let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = std::ptr::null_mut();
            if unsafe { WlanGetAvailableNetworkList(c.0, &g, 0, None, &mut list) } != 0 || list.is_null() {
                continue;
            }
            let mut done = false;
            unsafe {
                let n = (*list).dwNumberOfItems as usize;
                let first: *const WLAN_AVAILABLE_NETWORK = (*list).Network.as_ptr();
                for i in 0..n {
                    let a = &*first.add(i);
                    if a.dwFlags & HAS_PROFILE == 0 || ssid_text(&a.dot11Ssid) != ssid {
                        continue;
                    }
                    let profile: Vec<u16> = wide(&a.strProfileName).encode_utf16().chain([0]).collect();
                    let mut dot = a.dot11Ssid;
                    let params = WLAN_CONNECTION_PARAMETERS {
                        wlanConnectionMode: wlan_connection_mode_profile,
                        strProfile: PCWSTR(profile.as_ptr()),
                        pDot11Ssid: &mut dot,
                        pDesiredBssidList: std::ptr::null_mut(),
                        dot11BssType: dot11_BSS_type_any,
                        dwFlags: 0,
                    };
                    if WlanConnect(c.0, &g, &params, None) == 0 {
                        done = true;
                        break;
                    }
                }
                WlanFreeMemory(list as *const _);
            }
            if done {
                return true;
            }
        }
        false
    }
}

#[cfg(windows)]
mod bt {
    use super::{bt_address, filter_address, BtDevice};
    use windows::core::{w, Interface, GUID, PWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW, SetupDiGetDevicePropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, HDEVINFO,
        SP_DEVINFO_DATA,
    };
    use windows::Win32::Devices::Properties::{DEVPKEY_Device_FriendlyName, DEVPKEY_NAME, DEVPROPTYPE};
    use windows::Win32::Foundation::DEVPROPKEY;
    use windows::Win32::Media::Audio::{eRender, IConnector, IDeviceTopology, IMMDevice, IMMDeviceEnumerator, IPart, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE, DEVICE_STATE_UNPLUGGED};
    use windows::Win32::Media::KernelStreaming::{IKsControl, KSIDENTIFIER, KSPROPERTY_TYPE_GET};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

    /// Whether the device is connected now (what Settings › Bluetooth & devices shows under its name).
    const CONNECTED: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x83da6326_97a6_4088_9453_a1923f573b29), pid: 15 };
    /// KSPROPSETID_BtAudio, with KSPROPERTY_ONESHOT_RECONNECT (0) and KSPROPERTY_ONESHOT_DISCONNECT (1).
    const BT_AUDIO: GUID = GUID::from_u128(0x7fa06c40_b8f6_4c7e_8556_e8c33a12e54d);
    /// The stereo (A2DP) driver's filters: the one earbuds or a speaker connect through.
    const A2DP: &str = "bthenum#{0000110b-0000-1000-8000-00805f9b34fb}";

    fn prop(set: HDEVINFO, info: &SP_DEVINFO_DATA, key: &DEVPROPKEY) -> Option<Vec<u8>> {
        let mut ty = DEVPROPTYPE::default();
        let mut buf = vec![0u8; 512];
        let mut need = 0u32;
        unsafe { SetupDiGetDevicePropertyW(set, info, key, &mut ty, Some(&mut buf), Some(&mut need as *mut u32), 0) }.ok()?;
        buf.truncate(need as usize);
        Some(buf)
    }

    fn text(b: &[u16]) -> String {
        String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
    }

    fn text8(b: &[u8]) -> String {
        let w: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        text(&w)
    }

    /// Every paired device Windows has a node for: its address, name and whether it's connected.
    fn paired() -> Vec<(String, String, bool)> {
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
                let mut id = [0u16; 260];
                if unsafe { SetupDiGetDeviceInstanceIdW(set, &info, Some(&mut id), None) }.is_err() {
                    continue;
                }
                // The device itself (BTHENUM\DEV_<address>\...), not one of its services.
                let Some(addr) = bt_address(&text(&id)) else { continue };
                let name = prop(set, &info, &DEVPKEY_Device_FriendlyName).or_else(|| prop(set, &info, &DEVPKEY_NAME)).map(|b| text8(&b)).unwrap_or_default();
                let connected = prop(set, &info, &CONNECTED).and_then(|b| b.first().copied()).is_some_and(|c| c != 0);
                out.push((addr, name, connected));
            }
            let _ = unsafe { SetupDiDestroyDeviceInfoList(set) };
        }
        out
    }

    /// Every Bluetooth stereo device's address with the driver filter that connects it.
    fn audio() -> Vec<(String, IKsControl)> {
        let mut out: Vec<(String, IKsControl)> = Vec::new();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
            let Ok(list) = e.EnumAudioEndpoints(eRender, DEVICE_STATE(DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0)) else { return out };
            for i in 0..list.GetCount().unwrap_or(0) {
                let Ok(dev) = list.Item(i) else { continue };
                let Some((addr, ks)) = filter(&e, &dev) else { continue };
                if !out.iter().any(|(a, _)| *a == addr) {
                    out.push((addr, ks));
                }
            }
        }
        out
    }

    /// The endpoint's driver filter, when it is a Bluetooth stereo one, with the device's address.
    unsafe fn filter(e: &IMMDeviceEnumerator, dev: &IMMDevice) -> Option<(String, IKsControl)> {
        let topo: IDeviceTopology = dev.Activate(CLSCTX_ALL, None).ok()?;
        let conn: IConnector = topo.GetConnector(0).ok()?;
        let other: IConnector = conn.GetConnectedTo().ok()?;
        let part: IPart = other.cast().ok()?;
        let owner: IDeviceTopology = part.GetTopologyObject().ok()?;
        let id: PWSTR = owner.GetDeviceId().ok()?;
        let id_text = id.to_string().unwrap_or_default().to_lowercase();
        let filter_dev = if id_text.contains(A2DP) { e.GetDevice(PWSTR(id.0)).ok() } else { None };
        CoTaskMemFree(Some(id.0 as *const _));
        let addr = filter_address(&id_text)?;
        let ks: IKsControl = filter_dev?.Activate(CLSCTX_ALL, None).ok()?;
        Some((addr, ks))
    }

    pub fn devices() -> Vec<BtDevice> {
        let audio = audio();
        paired().into_iter().map(|(addr, name, connected)| BtDevice { audio: audio.iter().any(|(a, _)| *a == addr), id: addr, name, connected }).collect()
    }

    /// Connects (or disconnects) the paired stereo device at `addr`; false when it isn't one.
    pub fn set(addr: &str, connect: bool) -> bool {
        let addr = addr.to_lowercase();
        let Some((_, ks)) = audio().into_iter().find(|(a, _)| *a == addr) else { return false };
        let mut prop = KSIDENTIFIER::default();
        prop.Anonymous.Anonymous.Set = BT_AUDIO;
        prop.Anonymous.Anonymous.Id = if connect { 0 } else { 1 };
        prop.Anonymous.Anonymous.Flags = KSPROPERTY_TYPE_GET;
        let mut got = 0u32;
        unsafe { ks.KsProperty(&prop, std::mem::size_of::<KSIDENTIFIER>() as u32, std::ptr::null_mut(), 0, &mut got) }.is_ok()
    }
}

/// The Wi-Fi networks in reach. `denied`: Windows keeps the list from apps without location access.
#[derive(Serialize, Debug, Default)]
pub struct WifiList {
    pub networks: Vec<WifiNet>,
    pub denied: bool,
}

#[tauri::command]
pub async fn wifi_networks() -> WifiList {
    tauri::async_runtime::spawn_blocking(|| match wifi::networks() {
        Ok(list) => WifiList { networks: merge_networks(list), denied: false },
        Err(e) => WifiList { networks: Vec::new(), denied: e == wifi::ACCESS_DENIED },
    })
    .await
    .unwrap_or_default()
}

/// Asks Windows for a fresh Wi-Fi scan (the hold menu opening); results show on the next read.
#[tauri::command]
pub async fn wifi_scan() -> bool {
    tauri::async_runtime::spawn_blocking(wifi::scan).await.unwrap_or(false)
}

/// Joins a network Windows has a profile for; false when it has none.
#[tauri::command]
pub async fn wifi_join(ssid: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || wifi::join(&ssid)).await.unwrap_or(false)
}

/// The paired Bluetooth devices, one per name.
#[tauri::command]
pub async fn bt_devices() -> Vec<BtDevice> {
    tauri::async_runtime::spawn_blocking(|| merge_devices(bt::devices())).await.unwrap_or_default()
}

/// Connects or disconnects a paired Bluetooth stereo device by address; false when Windows can't from here.
#[tauri::command]
pub async fn bt_connect(id: String, connect: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || bt::set(&id, connect)).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(ssid: &str, connected: bool, known: bool, signal: u32) -> WifiNet {
        WifiNet { ssid: ssid.into(), secure: true, connected, known, signal }
    }

    #[test]
    fn one_row_per_network_sorted_by_name() {
        let out = merge_networks(vec![net("zwift", false, true, 60), net("", false, false, 99), net("DIRECT-8A-HP", false, false, 40), net("zwift", true, false, 80), net("cafe", false, false, 20)]);
        assert_eq!(out, vec![net("cafe", false, false, 20), net("DIRECT-8A-HP", false, false, 40), net("zwift", true, true, 80)]);
    }

    #[test]
    fn one_row_per_device_connected_and_audio_stick() {
        let d = |id: &str, name: &str, connected: bool, audio: bool| BtDevice { id: id.into(), name: name.into(), connected, audio };
        let out = merge_devices(vec![d("a1", "TECH1 RAGE", false, false), d("b", "justin’s airpods pro 2", false, true), d("a2", "TECH1 RAGE", false, true), d("c", " ", true, true), d("e", "JBL Go 4", false, true)]);
        assert_eq!(out, vec![d("e", "JBL Go 4", false, true), d("b", "justin’s airpods pro 2", false, true), d("a2", "TECH1 RAGE", false, true)]);
        let out = merge_devices(vec![d("m1", "Mouse", false, false), d("m2", "Mouse", true, false), d("m3", "mouse", false, false)]);
        assert_eq!(out, vec![d("m2", "Mouse", true, false)]);
    }

    #[test]
    fn addresses_from_device_nodes_and_audio_filters() {
        assert_eq!(bt_address(r"BTHENUM\DEV_D03E07E7FDD1\7&3025E752&0&BLUETOOTHDEVICE_D03E07E7FDD1").as_deref(), Some("d03e07e7fdd1"));
        assert_eq!(bt_address(r"BTHLE\DEV_EB801668EF50\7&11A2727C&0&EB801668EF50").as_deref(), Some("eb801668ef50"));
        assert_eq!(bt_address(r"BTHENUM\{0000110b-0000-1000-8000-00805f9b34fb}_VID&0001004c_PID&2024\7&3025e752&0&D03E07E7FDD1_C00000000"), None);
        assert_eq!(bt_address(r"USB\DEV_D03E07E7FDD1\x"), None);
        let id = r"{2}.\\?\bthenum#{0000110b-0000-1000-8000-00805f9b34fb}_vid&0001004c_pid&2024#7&3025e752&0&d03e07e7fdd1_c00000000#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\src";
        assert_eq!(filter_address(id).as_deref(), Some("d03e07e7fdd1"));
        assert_eq!(filter_address(r"{2}.\\?\bthhfenum#bthhfpaudio#8&9fc5915&1&97#{6994ad04}\wave"), None);
    }

    /// Lists this computer's networks and devices (never joins or connects). Run by hand:
    /// cargo test -- --ignored radiomenu --nocapture
    #[test]
    #[ignore]
    fn reads_the_menus_here() {
        let t = std::time::Instant::now();
        println!("wifi {:?} in {:?}", wifi::networks().map(merge_networks), t.elapsed());
        let t = std::time::Instant::now();
        println!("bt {:?} in {:?}", merge_devices(bt::devices()), t.elapsed());
    }
}
