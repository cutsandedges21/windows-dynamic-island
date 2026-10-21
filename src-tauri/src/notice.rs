// Workspaces' "Notice what I work on": what's in front, for the Workspaces activity
// (src/activities/notice.ts), and the file it remembers with (recent-work.json in Island's data
// folder, written atomically). Only the activity decides what's kept; nothing here leaves this
// computer. "Forget everything" deletes the file.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::workspaces::layout::{foreground_window, LiveWindow};

/// More than two months of spans ever take; stops a runaway write.
const MAX_BYTES: usize = 8 * 1024 * 1024;

fn file() -> PathBuf {
    crate::log::data_dir().join("recent-work.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    /// The app window in front; None for the desktop, a dialog, or one of Island's.
    pub window: Option<LiveWindow>,
    /// Since the last key press or mouse move, ms (time away isn't counted).
    pub idle_ms: u64,
}

#[cfg(windows)]
fn idle_ms() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return 0;
    }
    u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime))
}

#[cfg(not(windows))]
fn idle_ms() -> u64 {
    0
}

#[tauri::command]
pub fn notice_now() -> Now {
    Now { window: foreground_window(), idle_ms: idle_ms() }
}

#[tauri::command]
pub fn notice_load() -> Value {
    std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

/// Write beside the file and rename over it, so a crash never leaves half a file.
#[tauri::command]
pub fn notice_save(doc: Value) -> Result<(), String> {
    let path = file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(&doc).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("What Workspaces noticed is too big to save.".into());
    }
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// Deletes everything noticed.
#[tauri::command]
pub fn notice_forget() -> bool {
    match std::fs::remove_file(file()) {
        Ok(()) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}
