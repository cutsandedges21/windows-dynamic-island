// Now playing on a Mac comes in part 3.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub async fn media_state() -> Option<()> {
    None
}

/// Every action, the album art's `focus` (bring the app playing forward) too, comes with now playing.
#[tauri::command]
pub async fn media_control() -> bool {
    false
}
