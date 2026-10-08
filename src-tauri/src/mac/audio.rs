// Volume and microphone on a Mac come in part 3.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub async fn audio_state() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn audio_set() -> bool {
    false
}

#[tauri::command]
pub async fn mic_set_mute() -> bool {
    false
}
