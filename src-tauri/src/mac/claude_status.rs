// Claude Status's Windows sources (Claude Code's shell command lines, Windows'
// notification store, UI Automation for the Claude app and Chrome) have no Mac
// twin yet: the activity shows Claude Code sessions from the transcripts alone.

#[tauri::command]
pub async fn claude_status_cmdlines(pids: Vec<u32>) -> Vec<Option<String>> {
    pids.iter().map(|_| None).collect()
}

#[tauri::command]
pub async fn claude_status_notifications() -> Vec<()> {
    Vec::new()
}

#[tauri::command]
pub async fn claude_status_ui_scan() -> Option<()> {
    None
}

#[tauri::command]
pub async fn claude_status_open_chat() -> bool {
    false
}

/// The model router's kill switch: an empty `off` file next to its scripts, in Claude Code's
/// folder (auto_model.rs puts them there, and they look for it beside themselves).
fn router_off_file() -> Option<std::path::PathBuf> {
    Some(crate::claude::config_dir().join("model-router").join("off"))
}

/// Whether the model router is on (no `off` file).
#[tauri::command]
pub fn claude_router_get() -> bool {
    router_off_file().is_none_or(|p| !p.exists())
}

/// Turns the model router on or off for every session; returns the new state.
#[tauri::command]
pub fn claude_router_set(on: bool) -> bool {
    if let Some(p) = router_off_file() {
        if on {
            let _ = std::fs::remove_file(&p);
        } else {
            let _ = std::fs::write(&p, "");
        }
    }
    claude_router_get()
}
