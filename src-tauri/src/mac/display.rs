// The built-in screen's brightness on a Mac (the brightness flyout and Control Center's slider):
// read and set through DisplayServices, the framework the brightness keys and Control Center use.
// macOS sends no message for a change, so it is read once a second (a single call) and reported
// the way Windows reports it (brightness.rs). External screens don't take it, as on Windows.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::AppHandle;

type GetFn = unsafe extern "C" fn(u32, *mut f32) -> i32;
type SetFn = unsafe extern "C" fn(u32, f32) -> i32;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsBuiltin(display: u32) -> bool;
    fn CGGetOnlineDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
}

fn calls() -> Option<(GetFn, SetFn)> {
    static C: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    let (g, s) = (*C.get_or_init(|| unsafe {
        let lib = libc::dlopen(c"/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices".as_ptr(), libc::RTLD_LAZY);
        if lib.is_null() {
            return None;
        }
        let g = libc::dlsym(lib, c"DisplayServicesGetBrightness".as_ptr());
        let s = libc::dlsym(lib, c"DisplayServicesSetBrightness".as_ptr());
        (!g.is_null() && !s.is_null()).then_some((g as usize, s as usize))
    }))?;
    Some(unsafe { (std::mem::transmute::<*mut c_void, GetFn>(g as *mut c_void), std::mem::transmute::<*mut c_void, SetFn>(s as *mut c_void)) })
}

/// The Mac's own screen: the built-in one when it is on, else the main one.
fn screen() -> u32 {
    let mut ids = [0u32; 16];
    let mut n = 0u32;
    unsafe {
        if CGGetOnlineDisplayList(16, ids.as_mut_ptr(), &mut n) == 0 {
            if let Some(id) = ids[..n as usize].iter().find(|d| CGDisplayIsBuiltin(**d)) {
                return *id;
            }
        }
        CGMainDisplayID()
    }
}

/// 0–100, or None where the screen doesn't say (an external monitor, a Mac mini).
pub fn brightness() -> Option<u32> {
    let (get, _) = calls()?;
    let mut v: f32 = -1.0;
    let ok = unsafe { get(screen(), &mut v) } == 0;
    (ok && (0.0..=1.0).contains(&v)).then(|| (v * 100.0).round() as u32)
}

pub fn set_brightness(percent: u32) -> bool {
    let Some((_, set)) = calls() else { return false };
    unsafe { set(screen(), percent.min(100) as f32 / 100.0) == 0 }
}

/// Reports the brightness when it changes (the keys, Control Center, the light sensor).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if brightness().is_none() {
            crate::log::line("brightness: this Mac's screen doesn't report it");
            return;
        }
        loop {
            if let Some(p) = brightness() {
                crate::brightness::report(&app, p);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
