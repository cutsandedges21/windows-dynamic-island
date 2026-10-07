// Settings persistence. The schema belongs to the TypeScript side; Rust only
// stores the JSON blob atomically and broadcasts every change to both windows.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct SettingsStore {
    pub value: Mutex<Value>,
}

fn file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| crate::log::data_dir())
        .join("settings.json")
}

pub fn load(app: &AppHandle) -> Value {
    let path = file(app);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
            serde_json::from_slice(text).unwrap_or(Value::Null)
        }
        Err(_) => Value::Null,
    }
}

/// Write beside the target and rename over it, so a crash never leaves half a file.
pub fn save(app: &AppHandle, value: &Value) -> Result<(), String> {
    let path = file(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

#[tauri::command]
pub fn settings_get(state: tauri::State<'_, SettingsStore>) -> Value {
    state.value.lock().unwrap().clone()
}

/// Replaces the stored settings and tells every window. `origin` lets a window
/// ignore the echo of its own write.
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    state: tauri::State<'_, SettingsStore>,
    value: Value,
    origin: Option<String>,
) -> Result<(), String> {
    *state.value.lock().unwrap() = value.clone();
    save(&app, &value)?;
    let _ = app.emit(
        "settings",
        serde_json::json!({ "value": value, "origin": origin.unwrap_or_default() }),
    );
    Ok(())
}
