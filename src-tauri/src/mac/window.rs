// Island's extra windows on a Mac (the taskbar, the screen border, desktop widgets): where they sit
// among the Mac's windows, that they stay on every desktop (Space), and where the pointer is over
// them, for their pointer watches in dock.rs and frame.rs (Windows does both with its own calls).

use objc2::runtime::AnyObject;
use objc2::msg_send;
use tauri::{Manager, WebviewWindow};

const ALL_SPACES: usize = 1 << 0; // NSWindowCollectionBehaviorCanJoinAllSpaces
const STATIONARY: usize = 1 << 4; // NSWindowCollectionBehaviorStationary (stays put in Mission Control)
const IGNORES_CYCLE: usize = 1 << 6; // NSWindowCollectionBehaviorIgnoresCycle (not in Cmd-`)
const FULL_SCREEN_AUX: usize = 1 << 8; // NSWindowCollectionBehaviorFullScreenAuxiliary

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}
const DESKTOP_ICON_LEVEL_KEY: i32 = 18; // kCGDesktopIconWindowLevelKey
const STATUS_LEVEL: isize = 25; // NSStatusWindowLevel: over apps, like the menu bar's extras

fn ns_window(win: &WebviewWindow) -> Option<usize> {
    win.ns_window().ok().filter(|p| !p.is_null()).map(|p| p as usize)
}

/// Runs `f` with the window's NSWindow on the main thread (AppKit wants it there).
fn with_window(win: &WebviewWindow, f: impl FnOnce(*mut AnyObject) + Send + 'static) {
    let Some(ptr) = ns_window(win) else { return };
    let _ = win.app_handle().run_on_main_thread(move || f(ptr as *mut AnyObject));
}

/// A desktop widget: just above the desktop's icons, under every app's windows, on every Space.
pub fn on_desktop(win: &WebviewWindow) {
    with_window(win, |w| unsafe {
        let level = CGWindowLevelForKey(DESKTOP_ICON_LEVEL_KEY) as isize + 1;
        let _: () = msg_send![w, setLevel: level];
        let _: () = msg_send![w, setCollectionBehavior: ALL_SPACES | STATIONARY | IGNORES_CYCLE];
    });
}

/// The taskbar and the screen border: over apps' windows (as the menu bar's extras are), on every
/// Space, beside full-screen apps too, never in Cmd-`.
pub fn over_apps(win: &WebviewWindow) {
    with_window(win, |w| unsafe {
        let _: () = msg_send![w, setLevel: STATUS_LEVEL];
        let _: () = msg_send![w, setCollectionBehavior: ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUX];
    });
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CgPoint;
}

/// The pointer, in points from the main screen's top-left corner (cheap, any thread).
pub fn pointer() -> Option<(f64, f64)> {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return None;
        }
        let p = CGEventGetLocation(e);
        crate::mac::cf::CFRelease(e);
        Some((p.x, p.y))
    }
}

/// A window's place, read now and then (Tauri asks the main thread for it): (left, top, width,
/// height) in points.
pub fn frame_of(win: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let at = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let k = win.scale_factor().ok().filter(|k| *k > 0.0).unwrap_or(1.0);
    Some((at.x as f64 / k, at.y as f64 / k, size.width as f64 / k, size.height as f64 / k))
}

/// Where the pointer is in a window whose frame is `frame`: logical px from its top-left corner.
pub fn pointer_in(frame: (f64, f64, f64, f64)) -> Option<(f64, f64)> {
    let (px, py) = pointer()?;
    Some((px - frame.0, py - frame.1))
}
