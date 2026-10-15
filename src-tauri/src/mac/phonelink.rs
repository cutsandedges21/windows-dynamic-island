// A phone's notifications reach the island through Windows' Phone Link; a Mac has no such bridge.

#[tauri::command]
pub async fn phone_link_access() -> String {
    "unavailable".into()
}

#[tauri::command]
pub async fn phone_link_watch(on: bool) -> String {
    let _ = on;
    "unavailable".into()
}
