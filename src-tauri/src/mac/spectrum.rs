// The music bars follow the speakers on a Mac in part 3; until then they bounce.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn spectrum_watch() {}
