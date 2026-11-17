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

/// The line the long-lived PowerShell runs for one value: the brightness set through the WMI object
/// it fetched once (`$m`), then "ok" so the worker knows it is done.
pub fn worker_line(percent: u32) -> String {
    format!("$m | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=0;Brightness={}}} | Out-Null; 'ok'\n", percent.min(100))
}

/// The value waiting to be set; a newer one replaces it (dragging: only the latest matters).
#[cfg(windows)]
static PENDING: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);
#[cfg(windows)]
static WAKE: std::sync::Condvar = std::sync::Condvar::new();
#[cfg(windows)]
static WORKER: std::sync::Once = std::sync::Once::new();

/// Sets values one after another through one PowerShell kept open (about 15 ms a value, where a new
/// PowerShell each time took about 400 and piled up behind a drag: Justin, "laggy" sliding). A
/// newer value waiting replaces an older one. If that PowerShell goes away it is started again; if
/// it can't be, each value gets a PowerShell of its own as before.
#[cfg(windows)]
fn worker() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let start = || -> Option<(std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>)> {
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        let mut out = BufReader::new(child.stdout.take()?);
        stdin.write_all(b"$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods; 'ok'\n").ok()?;
        let mut line = String::new();
        while out.read_line(&mut line).ok()? > 0 {
            if line.trim() == "ok" {
                return Some((child, stdin, out));
            }
            line.clear();
        }
        None
    };
    let mut ps = None;
    loop {
        let percent = {
            let mut p = PENDING.lock().unwrap();
            while p.is_none() {
                p = WAKE.wait(p).unwrap();
            }
            p.take().unwrap()
        };
        if ps.is_none() {
            ps = start();
        }
        let done = ps.as_mut().is_some_and(|(_, stdin, out)| {
            if stdin.write_all(worker_line(percent).as_bytes()).is_err() || stdin.flush().is_err() {
                return false;
            }
            let mut line = String::new();
            loop {
                line.clear();
                match out.read_line(&mut line) {
                    Ok(0) | Err(_) => return false,
                    Ok(_) if line.trim() == "ok" => return true,
                    Ok(_) => {}
                }
            }
        });
        if !done {
            if let Some((mut child, _, _)) = ps.take() {
                let _ = child.kill();
            }
            let _ = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &set_script(percent)])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
}

/// Sets the screen's brightness (System Controls' slider): handed to the worker, which sets the
/// latest value asked for. Windows then reports the new value like any other change ('brightness').
#[tauri::command]
pub async fn brightness_set(percent: u32) -> bool {
    #[cfg(windows)]
    {
        WORKER.call_once(|| {
            let _ = std::thread::Builder::new().name("brightness".into()).spawn(worker);
        });
        *PENDING.lock().unwrap() = Some(percent.min(100));
        WAKE.notify_one();
        return true;
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

    #[test]
    fn the_worker_sets_through_its_one_wmi_object_and_says_when_done() {
        assert_eq!(worker_line(55), "$m | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=0;Brightness=55} | Out-Null; 'ok'\n");
        assert!(worker_line(400).contains("Brightness=100}"));
    }
}
