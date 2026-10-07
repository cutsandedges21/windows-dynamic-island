// Windows' Do Not Disturb, through the public focus-session API (Windows 11
// 22H2 and later): a focus session turns Do Not Disturb on (the user's Focus
// settings decide the details), ending it turns it off. Nothing undocumented.

use windows::UI::Shell::FocusSessionManager;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn manager() -> Option<FocusSessionManager> {
    // WinRT needs an apartment on this thread; a second call is harmless.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    if !FocusSessionManager::IsSupported().unwrap_or(false) {
        return None;
    }
    FocusSessionManager::GetDefault().ok()
}

/// Whether Windows' focus (Do Not Disturb) is on; None where Windows has no focus sessions.
#[tauri::command]
pub async fn dnd_get() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(|| manager()?.IsFocusActive().ok()).await.ok().flatten()
}

/// What happened when Island asked Windows to change Do Not Disturb.
#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DndResult {
    /// Windows did what was asked.
    pub ok: bool,
    /// Whether Do Not Disturb is on now (None when Windows will not say).
    pub active: Option<bool>,
    /// Why not, in words Island can show the user.
    pub reason: Option<String>,
}

/// Turns Windows' Do Not Disturb on or off. Some Windows builds keep the focus
/// API to themselves; then Island says so instead of pretending it worked.
#[tauri::command]
pub async fn dnd_set(on: bool) -> DndResult {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(m) = manager() else {
            return DndResult { ok: false, active: None, reason: Some("This version of Windows has no focus sessions.".into()) };
        };
        let result = if on { m.TryStartFocusSession().map(|_| ()) } else { m.DeactivateFocus() };
        let active = m.IsFocusActive().ok();
        match result {
            Ok(()) => DndResult { ok: true, active, reason: None },
            Err(err) => {
                crate::log::line(format!("windows focus {}: {err}", if on { "on" } else { "off" }));
                let reason = if err.message().contains("not available") {
                    "Windows keeps Do Not Disturb to itself on this PC, so only Island goes quiet."
                } else {
                    "Windows would not change Do Not Disturb, so only Island goes quiet."
                };
                DndResult { ok: false, active, reason: Some(reason.into()) }
            }
        }
    })
    .await
    .unwrap_or(DndResult { ok: false, active: None, reason: Some("Changing Do Not Disturb failed.".into()) })
}
