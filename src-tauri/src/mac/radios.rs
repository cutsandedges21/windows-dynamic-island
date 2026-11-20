// The Wi-Fi and Bluetooth switches on a Mac (Control Center's tile, Quick Actions): Wi-Fi through
// CoreWLAN, Bluetooth through mac/bluetooth.rs. Same shapes as radios.rs on Windows.

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde::Serialize;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct RadiosState {
    pub wifi: Option<bool>,
    pub bluetooth: Option<bool>,
    pub network: Option<String>,
}

/// The Wi-Fi interface, or null on a Mac without one.
pub fn wifi_interface() -> *mut AnyObject {
    unsafe {
        let client: *mut AnyObject = msg_send![class!(CWWiFiClient), sharedWiFiClient];
        if client.is_null() {
            return std::ptr::null_mut();
        }
        msg_send![client, interface]
    }
}

pub fn read() -> RadiosState {
    autoreleasepool(|_| {
        let iface = wifi_interface();
        let wifi = (!iface.is_null()).then(|| unsafe { msg_send![iface, powerOn] });
        let (_, ssid) = crate::net::wifi();
        RadiosState { wifi, bluetooth: crate::mac::bluetooth::powered(), network: ssid }
    })
}

#[tauri::command]
pub async fn radios_state() -> RadiosState {
    tauri::async_runtime::spawn_blocking(read).await.unwrap_or_default()
}

/// Switches a radio ("wifi" or "bluetooth"); true when it is now as asked.
#[tauri::command]
pub async fn radio_set(kind: String, on: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || match kind.as_str() {
        "wifi" => autoreleasepool(|_| unsafe {
            let iface = wifi_interface();
            if iface.is_null() {
                return false;
            }
            let ok: bool = msg_send![iface, setPower: on, error: std::ptr::null_mut::<*mut AnyObject>()];
            ok
        }),
        "bluetooth" => crate::mac::bluetooth::set_powered(on),
        _ => false,
    })
    .await
    .unwrap_or(false)
}
