// Small OS actions on a Mac: open URLs (same allow-list as Windows) and files with `open`, reveal
// in Finder with `open -R`, lock the screen, sleep / restart / shut down, the screenshot toolbar,
// the clipboard (text and pictures), the Sound settings, HTTP GET.

use std::path::Path;
use std::process::Command;

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde::Serialize;

use super::msgwin::{nsstring, wrote_clipboard};

const SCHEMES: &[&str] = &[
    "https", "http", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf", "claude", "spotify", "msteams", "zoommtg", "zoomus", "mailto",
    // System Settings' own panes (the Mac's answer to ms-settings: links).
    "x-apple.systempreferences",
];

fn scheme_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty() && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !url.contains(['\r', '\n', '\0'])
}

fn open(args: &[&str]) -> bool {
    Command::new("/usr/bin/open").args(args).status().is_ok_and(|s| s.success())
}

fn open_url_checked(url: &str) -> bool {
    if !scheme_ok(url) {
        crate::log::line(format!("refused url scheme: {}", url.split(':').next().unwrap_or("")));
        return false;
    }
    let ok = open(&[url]);
    crate::log::line(format!("open url {} ok={ok}", url.split('?').next().unwrap_or("")));
    ok
}

#[tauri::command]
pub fn open_url(url: String) -> bool {
    open_url_checked(&url)
}

/// A path under the user's folders (or a drive under /Volumes), or an allow-listed URL.
#[tauri::command]
pub fn shell_open(target: String) -> bool {
    if target.contains("://") || target.starts_with("mailto:") || target.starts_with("x-apple.systempreferences:") {
        return open_url_checked(&target);
    }
    let p = Path::new(&target);
    (crate::fsx::allowed(p) || p.starts_with("/Volumes")) && p.exists() && open(&[&target])
}

#[tauri::command]
pub fn shell_reveal(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.exists() && open(&["-R", &path])
}

#[tauri::command]
pub fn shell_edit_image(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.is_file() && open(&["-a", "Preview", &path])
}

/// Locks the screen at once, like Control-Command-Q (the login framework's own call, which every
/// macOS since 10.13 has); a Mac without it gets its screen put to sleep, which locks it too.
#[tauri::command]
pub fn shell_lock() {
    type Lock = unsafe extern "C" fn() -> i32;
    let path = c"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login";
    unsafe {
        let lib = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
        if !lib.is_null() {
            let sym = libc::dlsym(lib, c"SACLockScreenImmediate".as_ptr());
            if !sym.is_null() {
                let lock: Lock = std::mem::transmute(sym);
                lock();
                crate::log::line("lock: screen locked");
                return;
            }
        }
    }
    let _ = Command::new("/usr/bin/pmset").arg("displaysleepnow").status();
    crate::log::line("lock: screen put to sleep");
}

/// What to run for each power action, through the system's own events (the same as the Apple
/// menu's Restart… and Shut Down…, without their 60 s question). macOS asks once whether Island
/// may control System Events.
pub fn power_script(kind: &str) -> Option<&'static str> {
    match kind {
        "restart" => Some("tell application \"System Events\" to restart"),
        "shutdown" => Some("tell application \"System Events\" to shut down"),
        _ => None,
    }
}

/// Sleep, restart or shut down this Mac (a paired phone's More menu asks for it, after a confirm there).
#[tauri::command]
pub fn shell_power(kind: String) -> Result<(), String> {
    crate::log::line(format!("power: {kind}"));
    if kind == "sleep" {
        std::thread::spawn(|| {
            let _ = Command::new("/usr/bin/pmset").arg("sleepnow").status();
        });
        return Ok(());
    }
    let script = power_script(&kind).ok_or(format!("Unknown power action: {kind}"))?;
    let ok = Command::new("/usr/bin/osascript").args(["-e", script]).status().is_ok_and(|s| s.success());
    if ok {
        Ok(())
    } else {
        Err("macOS didn't let Island do that (System Settings › Privacy & Security › Automation › Island › System Events)".into())
    }
}

/// Xbox Game Bar's shortcuts: Windows only.
#[tauri::command]
pub fn game_bar(_action: String) -> bool {
    false
}

#[tauri::command]
pub fn shell_sleep() {
    let _ = Command::new("/usr/bin/pmset").arg("sleepnow").status();
}

/// The screenshot toolbar (what Shift-Command-5 shows): a region, a window or the whole screen.
#[tauri::command]
pub fn shell_snip() {
    let _ = open(&["-a", "Screenshot"]);
}

/// The same toolbar for a picture or a recording: a Mac picks between them there.
#[tauri::command]
pub fn screen_capture(video: bool) -> bool {
    let _ = video;
    open(&["-a", "Screenshot"])
}

/// Puts text on the clipboard (Copy buttons).
#[tauri::command]
pub fn clipboard_set_text(text: String) -> bool {
    autoreleasepool(|_| unsafe {
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return false;
        }
        let _: isize = msg_send![pb, clearContents];
        let ok: bool = msg_send![pb, setString: nsstring(&text), forType: nsstring("public.utf8-plain-text")];
        wrote_clipboard();
        ok
    })
}

/// A picture file onto the clipboard, as a picture (a screenshot's Copy, a phone's photo).
pub fn copy_image_file(path: &Path) -> bool {
    autoreleasepool(|_| unsafe {
        let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![alloc, initWithContentsOfFile: nsstring(&path.to_string_lossy())];
        if image.is_null() {
            return false;
        }
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pb, clearContents];
        let list: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: image];
        let ok: bool = msg_send![pb, writeObjects: list];
        let _: () = msg_send![image, release];
        wrote_clipboard();
        ok
    })
}

#[tauri::command]
pub fn clipboard_copy_image(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && copy_image_file(p)
}

/// A Mac has no clipboard history of its own to open: Island's Clipboard card is it.
#[tauri::command]
pub fn clipboard_history() {}

/// The music player's output button: the Sound settings, where the output is picked.
#[tauri::command]
pub fn sound_output() {
    let _ = open(&["x-apple.systempreferences:com.apple.preference.sound"]);
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// HTTPS GET for calendar feeds and weather; capped and time-limited.
#[tauri::command]
pub async fn http_get(url: String, max_bytes: Option<usize>) -> Option<HttpResponse> {
    let cap = max_bytes.unwrap_or(2 * 1024 * 1024).min(16 * 1024 * 1024);
    let (status, body) = crate::web::get_capped(&url, cap).await?;
    Some(HttpResponse { status, body: String::from_utf8_lossy(&body).to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_power_actions_run() {
        assert!(power_script("restart").is_some_and(|s| s.contains("restart")));
        assert!(power_script("shutdown").is_some_and(|s| s.contains("shut down")));
        assert!(power_script("rm -rf").is_none());
        assert!(scheme_ok("x-apple.systempreferences:com.apple.preference.sound"));
        assert!(!scheme_ok("file:///etc/passwd"));
    }

    #[test]
    fn text_goes_on_the_clipboard_and_comes_back() {
        assert!(clipboard_set_text("island clipboard test ✓".into()));
        let back = Command::new("/usr/bin/pbpaste").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&back.stdout), "island clipboard test ✓");
    }
}
