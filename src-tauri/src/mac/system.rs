// Battery, CPU and memory on a Mac come in part 4.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn power_state() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn sys_sample() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
