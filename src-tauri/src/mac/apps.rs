// The Apps tile on a Mac: later (the Dock's apps and their icons).

use crate::workspaces::launch::InstalledApp;

#[tauri::command]
pub async fn apps_pinned() -> Vec<InstalledApp> {
    Vec::new()
}

#[tauri::command]
pub async fn apps_icons(_targets: Vec<String>, _px: u32) -> Vec<Option<String>> {
    Vec::new()
}
