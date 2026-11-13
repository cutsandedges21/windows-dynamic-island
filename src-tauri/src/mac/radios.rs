// Wi-Fi and Bluetooth radios on a Mac come later: System Controls' tile leaves their buttons out.

#[tauri::command]
pub async fn radios_state() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn radio_set(_kind: String, _on: bool) -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
