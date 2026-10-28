// Caps Lock and Num Lock: a thread reads both every 100 ms and says when one turns on or off
// (`lock-keys`, {caps, num}), so the pill can flash it. The lock keys' state is the same for
// every program (it drives the keyboard's lights), so a thread that never gets keyboard input
// can read it; a read costs microseconds. A Mac has no Num Lock: `num` stays false there.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Locks {
    pub caps: bool,
    pub num: bool,
}

#[cfg(windows)]
fn read() -> Locks {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CAPITAL, VK_NUMLOCK};
    // The low bit is the toggle: on or off.
    unsafe { Locks { caps: GetKeyState(VK_CAPITAL.0 as i32) & 1 != 0, num: GetKeyState(VK_NUMLOCK.0 as i32) & 1 != 0 } }
}

#[cfg(target_os = "macos")]
fn read() -> Locks {
    Locks { caps: crate::mac::input::caps_lock_on(), num: false }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn read() -> Locks {
    Locks { caps: false, num: false }
}

#[tauri::command]
pub fn lock_keys() -> Locks {
    read()
}

pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("lock-keys".into()).spawn(move || {
        let mut last = read();
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let now = read();
            if now != last {
                last = now;
                let _ = app.emit("lock-keys", now);
            }
        }
    });
    if let Err(e) = spawned {
        crate::log::line(format!("lock keys: no thread ({e})"));
    }
}
