// Processes and windows on a Mac come in part 2 (Claude Code needs them).

#[tauri::command]
pub async fn proc_snapshot() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn win_enum() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub fn win_activate() -> bool {
    false
}

#[tauri::command]
pub fn win_foreground() -> isize {
    0
}

#[tauri::command]
pub fn win_foreground_pid() -> u32 {
    0
}

#[tauri::command]
pub fn input_modifiers_down() -> bool {
    crate::mac::input::control_down()
}

#[tauri::command]
pub fn win_allow_foreground() {}
