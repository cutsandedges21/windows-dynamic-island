// Claude Code's hook relay reaches Island over a Unix socket on a Mac (part 2).

use tauri::AppHandle;

#[derive(Default)]
pub struct Pending;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn hook_reply() -> bool {
    false
}
