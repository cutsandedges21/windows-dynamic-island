// Screen brightness, for the brightness flyout. Windows says when the brightness of the screen
// it controls changes (a laptop's own screen: the keys, Quick Settings, the light sensor),
// through a power-setting notification to the message window (msgwin.rs). External monitors
// don't report it, and neither does a Mac yet.

use std::sync::atomic::{AtomicI32, Ordering};

use tauri::{AppHandle, Emitter};

/// The last brightness Windows reported, 0–100; -1 before the first report.
static LAST: AtomicI32 = AtomicI32::new(-1);

/// Windows' word on the brightness: the island hears it when it changed ('brightness').
#[cfg_attr(not(windows), allow(dead_code))]
pub fn report(app: &AppHandle, percent: u32) {
    let p = percent.min(100) as i32;
    if LAST.swap(p, Ordering::Relaxed) != p {
        let _ = app.emit_to(crate::overlay::LABEL, "brightness", p);
    }
}

/// The brightness now, or None where nothing reports it.
#[tauri::command]
pub fn brightness_get() -> Option<u32> {
    let p = LAST.load(Ordering::Relaxed);
    (p >= 0).then_some(p as u32)
}
