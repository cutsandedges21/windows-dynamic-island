// Keyboard shortcuts sent to another app on a Mac (a call's camera button): Core Graphics key
// events, which macOS lets an app send once the user allows it under Privacy & Security ›
// Accessibility. The first try asks (the system's own prompt).

use std::ffi::c_void;

const SHIFT: u64 = 1 << 17; // kCGEventFlagMaskShift
const CONTROL: u64 = 1 << 18; // kCGEventFlagMaskControl
const OPTION: u64 = 1 << 19; // kCGEventFlagMaskAlternate
const COMMAND: u64 = 1 << 20; // kCGEventFlagMaskCommand
const HID_TAP: u32 = 0; // kCGHIDEventTap

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryCreate(alloc: *const c_void, keys: *const *const c_void, values: *const *const c_void, n: isize, kcb: *const c_void, vcb: *const c_void) -> *const c_void;
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

/// Whether Island may send keys; asks the user (the system's prompt) when `ask` and it may not yet.
pub fn trusted(ask: bool) -> bool {
    unsafe {
        if !ask {
            return AXIsProcessTrustedWithOptions(std::ptr::null());
        }
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let opts = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, (&kCFTypeDictionaryKeyCallBacks as *const c_void).cast(), (&kCFTypeDictionaryValueCallBacks as *const c_void).cast());
        let ok = AXIsProcessTrustedWithOptions(opts);
        if !opts.is_null() {
            crate::mac::cf::CFRelease(opts);
        }
        ok
    }
}

/// The Mac key code of a letter (US layout positions, which is what shortcuts use).
pub fn letter_code(c: u8) -> Option<u16> {
    Some(match c.to_ascii_uppercase() {
        b'A' => 0x00, b'S' => 0x01, b'D' => 0x02, b'F' => 0x03, b'H' => 0x04, b'G' => 0x05, b'Z' => 0x06, b'X' => 0x07,
        b'C' => 0x08, b'V' => 0x09, b'B' => 0x0B, b'Q' => 0x0C, b'W' => 0x0D, b'E' => 0x0E, b'R' => 0x0F, b'Y' => 0x10,
        b'T' => 0x11, b'O' => 0x1F, b'U' => 0x20, b'I' => 0x22, b'P' => 0x23, b'L' => 0x25, b'J' => 0x26, b'K' => 0x28,
        b'N' => 0x2D, b'M' => 0x2E,
        _ => return None,
    })
}

pub struct Mods {
    pub command: bool,
    pub shift: bool,
    pub option: bool,
    pub control: bool,
}

/// Presses and lets go of a shortcut in the app in front.
pub fn press(mods: Mods, key: u16) -> Result<(), String> {
    if !trusted(true) {
        return Err("Allow Island under System Settings › Privacy & Security › Accessibility, then try again.".into());
    }
    let mut flags = 0u64;
    if mods.command {
        flags |= COMMAND;
    }
    if mods.shift {
        flags |= SHIFT;
    }
    if mods.option {
        flags |= OPTION;
    }
    if mods.control {
        flags |= CONTROL;
    }
    unsafe {
        for down in [true, false] {
            let e = CGEventCreateKeyboardEvent(std::ptr::null(), key, down);
            if e.is_null() {
                return Err("macOS didn't make the key event".into());
            }
            CGEventSetFlags(e, flags);
            CGEventPost(HID_TAP, e);
            crate::mac::cf::CFRelease(e);
        }
    }
    Ok(())
}

/// A call app's camera shortcut on a Mac (calls.rs has Windows'): its processes, and the keys.
fn camera_shortcut(app: &str) -> Option<(&'static [&'static str], Mods, u8)> {
    let cmd_shift = Mods { command: true, shift: true, option: false, control: false };
    let cmd = Mods { command: true, shift: false, option: false, control: false };
    Some(match app {
        "Teams" => (&["microsoft teams.app", "microsoft teams (work or school).app", "microsoft teams classic.app"][..], cmd_shift, b'O'),
        "Zoom" => (&["zoom.us.app"][..], cmd_shift, b'V'),
        "Google Meet" => (&["google chrome.app", "microsoft edge.app", "arc.app", "brave browser.app", "firefox.app", "safari.app"][..], cmd, b'E'),
        _ => return None,
    })
}

/// Switches the camera in a call: brings the call app forward, presses its camera shortcut, and puts
/// back the app that was in front.
pub fn call_camera(app: &str) -> Result<(), String> {
    let (names, mods, letter) = camera_shortcut(app).ok_or_else(|| "Island can't switch this app's camera.".to_string())?;
    let rows = crate::procs::snapshot();
    let pid = rows.iter().filter(|r| names.contains(&r.2.as_str())).map(|r| r.0).find(|p| crate::mac::cf::is_app(*p)).ok_or_else(|| format!("Couldn't find {app}."))?;
    let before = crate::mac::cf::frontmost_pid();
    if !crate::mac::cf::activate_pid(pid) {
        return Err(format!("macOS didn't let Island bring {app} forward."));
    }
    std::thread::sleep(std::time::Duration::from_millis(250));
    let sent = press(mods, letter_code(letter).unwrap_or(0));
    std::thread::sleep(std::time::Duration::from_millis(200));
    if before != 0 && before != pid {
        crate::mac::cf::activate_pid(before);
    }
    sent?;
    crate::log::line(format!("calls: camera shortcut sent to {app}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_letters_have_their_key_codes() {
        assert_eq!(letter_code(b'v'), Some(0x09));
        assert_eq!(letter_code(b'O'), Some(0x1F));
        assert_eq!(letter_code(b'E'), Some(0x0E));
        assert_eq!(letter_code(b'1'), None);
        assert!(camera_shortcut("Zoom").is_some_and(|(p, m, k)| p.contains(&"zoom.us.app") && m.command && m.shift && k == b'V'));
        assert!(camera_shortcut("Skype").is_none());
    }
}
