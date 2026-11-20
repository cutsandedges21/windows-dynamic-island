// Quiet on a Mac. Quiet quiets Island itself here exactly as on Windows (the island stays small and
// holds its notifications), but macOS lets no app other than its own switch Focus or read it
// without an Apple-granted capability, so the system's Focus stays as the user set it, and Island
// says so once (island.ts shows the reason the first time).

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DndResult {
    pub ok: bool,
    pub active: Option<bool>,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn dnd_get() -> Option<bool> {
    None
}

#[tauri::command]
pub async fn dnd_set(on: bool) -> DndResult {
    DndResult {
        ok: false,
        active: None,
        reason: on.then(|| "Island holds its own alerts. macOS doesn't let apps switch Focus: turn it on in Control Center › Focus if you want the Mac quiet too.".to_string()),
    }
}
