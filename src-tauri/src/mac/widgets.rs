// Desktop widgets on a Mac: later.

#[tauri::command]
pub fn widgets_sync(_specs: Vec<serde_json::Value>) {}

#[tauri::command]
pub fn widget_size(_w: f64, _h: f64) {}

#[tauri::command]
pub fn widget_moved() {}
