// Other apps' windows through the Accessibility API: their titles, where they are, moving and sizing
// them, minimizing, raising one. macOS lets an app do this once the user allows it under Privacy &
// Security › Accessibility (mac/keys.rs `trusted` asks). Windows are matched to Core Graphics'
// window numbers with the private `_AXUIElementGetWindow`, as every Mac window manager does.

use std::ffi::c_void;

use crate::mac::cf::{self, CFTypeRef};

type AxRef = *const c_void;

const AX_OK: i32 = 0;
const POINT: u32 = 1; // kAXValueCGPointType
const SIZE: u32 = 2; // kAXValueCGSizeType

#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AxRef;
    fn AXUIElementCopyAttributeValue(element: AxRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: AxRef, attribute: CFTypeRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(element: AxRef, action: CFTypeRef) -> i32;
    fn AXValueCreate(kind: u32, value: *const c_void) -> CFTypeRef;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn _AXUIElementGetWindow(element: AxRef, window: *mut u32) -> i32;
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
}

/// Whether Island may use other apps' windows (without asking).
pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// One app's window as the Accessibility API gives it (retained; released when dropped).
pub struct AxWindow {
    el: AxRef,
    pub id: u32,
    pub title: String,
    pub minimized: bool,
    pub position: Point,
    pub size: Size,
}

impl Drop for AxWindow {
    fn drop(&mut self) {
        if !self.el.is_null() {
            unsafe { cf::CFRelease(self.el) };
        }
    }
}

fn copy(el: AxRef, attr: &str) -> CFTypeRef {
    let key = cf::cfstr(attr);
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.0, &mut v) };
    if err == AX_OK {
        v
    } else {
        std::ptr::null()
    }
}

fn point_of(v: CFTypeRef) -> Point {
    let mut p = Point::default();
    if !v.is_null() {
        unsafe { AXValueGetValue(v, POINT, (&mut p as *mut Point).cast()) };
        unsafe { cf::CFRelease(v) };
    }
    p
}

fn size_of(v: CFTypeRef) -> Size {
    let mut s = Size::default();
    if !v.is_null() {
        unsafe { AXValueGetValue(v, SIZE, (&mut s as *mut Size).cast()) };
        unsafe { cf::CFRelease(v) };
    }
    s
}

fn owned_string(v: CFTypeRef) -> String {
    let s = cf::string(v).unwrap_or_default();
    if !v.is_null() {
        unsafe { cf::CFRelease(v) };
    }
    s
}

fn owned_bool(v: CFTypeRef) -> bool {
    let b = cf::int(v).unwrap_or(0) != 0;
    if !v.is_null() {
        unsafe { cf::CFRelease(v) };
    }
    b
}

/// The windows of an app (by its process), front first; empty when Island may not look.
pub fn windows_of(pid: u32) -> Vec<AxWindow> {
    if !trusted() {
        return Vec::new();
    }
    unsafe {
        let app = AXUIElementCreateApplication(pid as i32);
        if app.is_null() {
            return Vec::new();
        }
        let list = copy(app, "AXWindows");
        let mut out = Vec::new();
        if !list.is_null() {
            for i in 0..CFArrayGetCount(list) {
                let el = CFRetain(CFArrayGetValueAtIndex(list, i));
                let mut id = 0u32;
                let _ = _AXUIElementGetWindow(el, &mut id);
                out.push(AxWindow {
                    id,
                    title: owned_string(copy(el, "AXTitle")),
                    minimized: owned_bool(copy(el, "AXMinimized")),
                    position: point_of(copy(el, "AXPosition")),
                    size: size_of(copy(el, "AXSize")),
                    el,
                });
            }
            cf::CFRelease(list);
        }
        cf::CFRelease(app);
        out
    }
}

/// Moves and sizes a window (in points, from the top left of the main screen).
pub fn set_frame(w: &AxWindow, at: Point, size: Size) -> bool {
    unsafe {
        let (pk, sk) = (cf::cfstr("AXPosition"), cf::cfstr("AXSize"));
        let p = AXValueCreate(POINT, (&at as *const Point).cast());
        let s = AXValueCreate(SIZE, (&size as *const Size).cast());
        // Size, place, then size again: a window that can't grow past the screen's edge gets its
        // size once it is where it goes.
        let a = AXUIElementSetAttributeValue(w.el, sk.0, s);
        let b = AXUIElementSetAttributeValue(w.el, pk.0, p);
        let c = AXUIElementSetAttributeValue(w.el, sk.0, s);
        cf::CFRelease(p);
        cf::CFRelease(s);
        b == AX_OK && (a == AX_OK || c == AX_OK)
    }
}

pub fn set_minimized(w: &AxWindow, on: bool) -> bool {
    let key = cf::cfstr("AXMinimized");
    unsafe { AXUIElementSetAttributeValue(w.el, key.0, if on { kCFBooleanTrue } else { kCFBooleanFalse }) == AX_OK }
}

/// Presses a window's close button.
pub fn press_close(w: &AxWindow) -> bool {
    let button = copy(w.el, "AXCloseButton");
    if button.is_null() {
        return false;
    }
    let press = cf::cfstr("AXPress");
    let ok = unsafe { AXUIElementPerformAction(button, press.0) } == AX_OK;
    unsafe { cf::CFRelease(button) };
    ok
}

/// Brings one window to the front of its app (its app is brought forward by the caller).
pub fn raise(w: &AxWindow) -> bool {
    let action = cf::cfstr("AXRaise");
    let main = cf::cfstr("AXMain");
    unsafe {
        let _ = AXUIElementSetAttributeValue(w.el, main.0, kCFBooleanTrue);
        AXUIElementPerformAction(w.el, action.0) == AX_OK
    }
}
