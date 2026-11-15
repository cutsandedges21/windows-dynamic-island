// The Wi-Fi and Bluetooth hold menus on a Mac come later: the radios themselves aren't read yet
// (mac/radios.rs), so Control Center has no pills to hold.

#[tauri::command]
pub async fn wifi_networks() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn wifi_scan() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn wifi_join(_ssid: String) -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn bt_devices() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn bt_connect(_name: String, _connect: bool) -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
