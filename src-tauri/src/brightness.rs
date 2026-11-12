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

/// The PowerShell that sets a laptop screen's brightness through WMI (what Quick Settings' slider
/// sets); external monitors don't take it.
pub fn set_script(percent: u32) -> String {
    format!(
        "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=0;Brightness={}}} | Out-Null",
        percent.min(100)
    )
}

/// Sets the screen's brightness (System Controls' slider); true when PowerShell ran it. Windows
/// then reports the new value like any other change ('brightness').
#[tauri::command]
pub async fn brightness_set(percent: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = set_script(percent);
        return tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        let _ = percent;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_sets_a_whole_percent_no_higher_than_100() {
        assert!(set_script(40).ends_with("@{Timeout=0;Brightness=40} | Out-Null"));
        assert!(set_script(250).contains("Brightness=100}"));
    }
}
