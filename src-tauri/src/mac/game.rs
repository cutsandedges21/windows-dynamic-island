// Game FPS and ping read Windows' ETW; there is no Mac version.

pub fn start() {}

#[tauri::command]
pub fn game_state() -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
pub async fn game_fps_setup() -> Result<(), String> {
    Err("Windows only".into())
}
