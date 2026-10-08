// Now playing on a Mac comes in part 3.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub async fn media_state() -> Option<()> {
    None
}

#[tauri::command]
pub async fn media_control() -> bool {
    false
}
