// Device, power and clipboard broadcasts on a Mac come in part 4.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

/// What the clipboard holds for Land's Cmd+V: text (files come later on a Mac).
#[derive(serde::Serialize, Default)]
pub struct Pasted {
    files: Vec<String>,
    text: Option<String>,
}

#[tauri::command]
pub fn clipboard_paste() -> Pasted {
    let text = std::process::Command::new("pbpaste")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).chars().take(20_001).collect::<String>())
        .filter(|t| !t.trim().is_empty());
    Pasted { files: Vec::new(), text }
}
