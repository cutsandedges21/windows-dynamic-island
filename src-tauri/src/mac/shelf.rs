// Land's shelf on a Mac: each file's picture (a photo drawn small, else the Finder's icon for it).
// Dragging files out of the island isn't on a Mac yet: its tiles open and reveal them instead.

#[tauri::command]
pub async fn shelf_thumb(path: String, px: u32) -> Option<String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.exists() {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || crate::apps::thumbnail(&path, px)).await.ok().flatten()
}

#[tauri::command]
pub async fn shelf_drag(_paths: Vec<String>) -> Result<bool, String> {
    Err("Dragging out of the island isn't on a Mac yet: open the file or show it in the Finder.".into())
}
