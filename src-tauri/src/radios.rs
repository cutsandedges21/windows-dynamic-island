// The Wi-Fi and Bluetooth radios, for System Controls' Control Center tile: whether each is on,
// the Wi-Fi network it is connected to, and switching a radio on or off, through WinRT's
// Windows.Devices.Radios (the same switches as Quick Settings). A computer without one of the
// radios says null for it, and the tile leaves its button out. The Mac twin is mac/radios.rs.

use serde::Serialize;
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Networking::Connectivity::NetworkInformation;

/// Each radio: on, off, or null when the computer has none (or Windows would not say).
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct RadiosState {
    pub wifi: Option<bool>,
    pub bluetooth: Option<bool>,
    /// The Wi-Fi network the computer is on (its profile name), when it is on one.
    pub network: Option<String>,
}

/// A radio's state as the tile shows it: Disabled (switched off in hardware or Airplane mode) is off.
pub fn radio_on(state: RadioState) -> Option<bool> {
    match state {
        RadioState::On => Some(true),
        RadioState::Off | RadioState::Disabled => Some(false),
        _ => None,
    }
}

/// The tile's names for the radios.
pub fn kind_of(name: &str) -> Option<RadioKind> {
    match name {
        "wifi" => Some(RadioKind::WiFi),
        "bluetooth" => Some(RadioKind::Bluetooth),
        _ => None,
    }
}

fn radios() -> windows::core::Result<Vec<Radio>> {
    let list = Radio::GetRadiosAsync()?.get()?;
    let mut out = Vec::new();
    for i in 0..list.Size()? {
        out.push(list.GetAt(i)?);
    }
    Ok(out)
}

/// The first radio of a kind; a radio Windows lists as on wins over one listed off.
fn find(all: &[Radio], kind: RadioKind) -> Option<bool> {
    let mut seen = None;
    for r in all {
        if r.Kind().ok() != Some(kind) {
            continue;
        }
        match r.State().ok().and_then(radio_on) {
            Some(true) => return Some(true),
            Some(false) => seen = Some(false),
            None => {}
        }
    }
    seen
}

fn network() -> Option<String> {
    let profile = NetworkInformation::GetInternetConnectionProfile().ok()?;
    if !profile.IsWlanConnectionProfile().unwrap_or(false) {
        return None;
    }
    let name = profile.ProfileName().ok()?.to_string_lossy();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn read() -> RadiosState {
    let all = radios().unwrap_or_default();
    let wifi = find(&all, RadioKind::WiFi);
    RadiosState { wifi, bluetooth: find(&all, RadioKind::Bluetooth), network: if wifi == Some(true) { network() } else { None } }
}

fn set(kind: RadioKind, on: bool) -> windows::core::Result<bool> {
    if Radio::RequestAccessAsync()?.get()? != RadioAccessStatus::Allowed {
        return Ok(false);
    }
    let mut done = false;
    for r in radios()? {
        if r.Kind()? == kind {
            let want = if on { RadioState::On } else { RadioState::Off };
            done |= r.SetStateAsync(want)?.get()? == RadioAccessStatus::Allowed;
        }
    }
    Ok(done)
}

/// Wi-Fi and Bluetooth now (WinRT calls block, so off the main thread).
#[tauri::command]
pub async fn radios_state() -> RadiosState {
    tauri::async_runtime::spawn_blocking(read).await.unwrap_or_default()
}

/// Switches a radio ('wifi' or 'bluetooth'); true when Windows did it.
#[tauri::command]
pub async fn radio_set(kind: String, on: bool) -> bool {
    let Some(kind) = kind_of(&kind) else { return false };
    tauri::async_runtime::spawn_blocking(move || set(kind, on).unwrap_or(false)).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_reads_as_off_and_unknown_as_nothing() {
        assert_eq!(radio_on(RadioState::On), Some(true));
        assert_eq!(radio_on(RadioState::Off), Some(false));
        assert_eq!(radio_on(RadioState::Disabled), Some(false));
        assert_eq!(radio_on(RadioState::Unknown), None);
    }

    #[test]
    fn only_the_two_radio_names_switch_anything() {
        assert_eq!(kind_of("wifi"), Some(RadioKind::WiFi));
        assert_eq!(kind_of("bluetooth"), Some(RadioKind::Bluetooth));
        assert_eq!(kind_of("fm"), None);
        assert_eq!(kind_of(""), None);
    }

    /// Reads this computer's radios (never switches them). Run by hand: cargo test -- --ignored radios
    #[test]
    #[ignore]
    fn reads_the_radios_here() {
        println!("{:?}", read());
    }
}
