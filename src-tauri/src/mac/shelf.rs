// Land's shelf on a Mac: pictures and dragging out come later (the shelf shows plain icons).

#[tauri::command]
pub async fn shelf_thumb(_path: String, _px: u32) -> Option<String> {
    None
}

#[tauri::command]
pub async fn shelf_drag(_paths: Vec<String>) -> Result<bool, String> {
    Err("not on Mac yet".into())
}
