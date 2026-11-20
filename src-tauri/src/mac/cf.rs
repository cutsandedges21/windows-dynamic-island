// Core Foundation, Core Graphics' window list, and a few Cocoa calls, for the Mac twins: the
// handful of C and Objective-C functions they need, declared here once.

use std::ffi::{c_void, CStr};

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

pub type CFTypeRef = *const c_void;
pub type CFIndex = isize;

const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
const SINT64: isize = 4; // kCFNumberSInt64Type
const FLOAT64: isize = 6; // kCFNumberFloat64Type

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: CFIndex) -> CFTypeRef;
    fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFNumberGetValue(number: CFTypeRef, kind: isize, out: *mut c_void) -> bool;
    fn CFStringGetLength(s: CFTypeRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut i8, size: CFIndex, encoding: u32) -> bool;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(b: CFTypeRef) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
    pub static kCGWindowNumber: CFTypeRef;
    pub static kCGWindowOwnerPID: CFTypeRef;
    pub static kCGWindowOwnerName: CFTypeRef;
    pub static kCGWindowName: CFTypeRef;
    pub static kCGWindowLayer: CFTypeRef;
    pub static kCGWindowBounds: CFTypeRef;
    pub static kCGWindowIsOnscreen: CFTypeRef;
}

/// A CFString as a Rust string; None for anything else.
pub fn string(v: CFTypeRef) -> Option<String> {
    if v.is_null() || unsafe { CFGetTypeID(v) != CFStringGetTypeID() } {
        return None;
    }
    unsafe {
        let len = CFStringGetLength(v);
        let cap = CFStringGetMaximumSizeForEncoding(len, UTF8) + 1;
        let mut buf = vec![0i8; cap.max(1) as usize];
        if !CFStringGetCString(v, buf.as_mut_ptr(), cap, UTF8) {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

/// A CFNumber (or CFBoolean) as an i64.
pub fn int(v: CFTypeRef) -> Option<i64> {
    if v.is_null() {
        return None;
    }
    unsafe {
        let t = CFGetTypeID(v);
        if t == CFBooleanGetTypeID() {
            return Some(CFBooleanGetValue(v) as i64);
        }
        if t != CFNumberGetTypeID() {
            return None;
        }
        let mut out: i64 = 0;
        CFNumberGetValue(v, SINT64, (&mut out as *mut i64).cast()).then_some(out)
    }
}

/// A CFNumber as an f64.
pub fn float(v: CFTypeRef) -> Option<f64> {
    if v.is_null() || unsafe { CFGetTypeID(v) != CFNumberGetTypeID() } {
        return None;
    }
    let mut out: f64 = 0.0;
    unsafe { CFNumberGetValue(v, FLOAT64, (&mut out as *mut f64).cast()) }.then_some(out)
}

pub fn get(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef {
    if dict.is_null() {
        return std::ptr::null();
    }
    unsafe { CFDictionaryGetValue(dict, key) }
}

/// One window from Core Graphics' list.
#[derive(Clone, Debug)]
pub struct CgWindow {
    pub id: u32,
    pub pid: u32,
    pub owner: String,
    /// Empty unless Island may record the screen (macOS keeps other apps' titles back otherwise).
    pub title: String,
    pub layer: i64,
    pub bounds: (f64, f64, f64, f64),
}

const ON_SCREEN_ONLY: u32 = 1 << 0; // kCGWindowListOptionOnScreenOnly
const INCLUDING_WINDOW: u32 = 1 << 3; // kCGWindowListOptionIncludingWindow
const EXCLUDE_DESKTOP: u32 = 1 << 4; // kCGWindowListExcludeDesktopElements

fn windows_with(option: u32, relative_to: u32) -> Vec<CgWindow> {
    let list = unsafe { CGWindowListCopyWindowInfo(option, relative_to) };
    if list.is_null() {
        return Vec::new();
    }
    let mut out = Vec::new();
    unsafe {
        for i in 0..CFArrayGetCount(list) {
            let d = CFArrayGetValueAtIndex(list, i);
            let b = get(d, kCGWindowBounds);
            let n = |k: &str| -> f64 {
                let key = cfstr(k);
                let v = float(get(b, key.0)).unwrap_or(0.0);
                v
            };
            out.push(CgWindow {
                id: int(get(d, kCGWindowNumber)).unwrap_or(0) as u32,
                pid: int(get(d, kCGWindowOwnerPID)).unwrap_or(0) as u32,
                owner: string(get(d, kCGWindowOwnerName)).unwrap_or_default(),
                title: string(get(d, kCGWindowName)).unwrap_or_default(),
                layer: int(get(d, kCGWindowLayer)).unwrap_or(0),
                bounds: (n("X"), n("Y"), n("Width"), n("Height")),
            });
        }
        CFRelease(list);
    }
    out
}

/// Windows on screen, front first, without the desktop's own.
pub fn on_screen_windows() -> Vec<CgWindow> {
    windows_with(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0)
}

/// One window by its number, on screen or not.
pub fn window(id: u32) -> Option<CgWindow> {
    windows_with(INCLUDING_WINDOW, id).into_iter().find(|w| w.id == id)
}

/// A CFString made from a Rust string, released when dropped.
pub struct CfStr(pub CFTypeRef);

impl Drop for CfStr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: CFIndex, encoding: u32, external: bool) -> CFTypeRef;
}

pub fn cfstr(s: &str) -> CfStr {
    CfStr(unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as CFIndex, UTF8, false) })
}

// ------------------------------------------------------------------ Cocoa

/// The app in front (its process), 0 when there is none.
pub fn frontmost_pid() -> u32 {
    unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws.is_null() {
            return 0;
        }
        let app: *mut AnyObject = msg_send![ws, frontmostApplication];
        if app.is_null() {
            return 0;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        pid.max(0) as u32
    }
}

/// Brings an app forward with all its windows, the way clicking it in the Dock does. False when no
/// app runs under that process (a helper process, or one that ended).
pub fn activate_pid(pid: u32) -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32];
        if app.is_null() {
            return false;
        }
        // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
        let ok: bool = msg_send![app, activateWithOptions: 3usize];
        ok
    }
}

/// The running app (bundle) a process belongs to, by walking up its parents: a helper process
/// (VS Code's "Code Helper (Plugin)") isn't an app the Dock knows, its main process is.
pub fn is_app(pid: u32) -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32];
        !app.is_null()
    }
}
