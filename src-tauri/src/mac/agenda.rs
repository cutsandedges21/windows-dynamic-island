// Calendar accounts on a Mac come later; Calendar works from a calendar link now.

#[tauri::command]
pub async fn agenda_read() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
