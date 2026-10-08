// Focus (Do Not Disturb) on a Mac comes in part 4; Quiet still quiets Island itself.

#[tauri::command]
pub async fn dnd_get() -> Option<bool> {
    None
}

#[tauri::command]
pub async fn dnd_set() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
