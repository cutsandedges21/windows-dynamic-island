// Network readings on a Mac come in part 4.

#[tauri::command]
pub async fn net_sample() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn ports_listening() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
