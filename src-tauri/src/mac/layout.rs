// Workspaces' window layouts and Island's taskbar list on a Mac (workspaces/layout.rs has Windows'):
// the windows on screen from Core Graphics, their titles and minimized state from the Accessibility
// API when Island may use it, and moving / sizing / minimizing them through it. Rectangles are in
// the same pixels as monitors_list (Core Graphics' points times the screen's scale).

use crate::mac::ax::{self, Point, Size};
use crate::mac::cf;
use crate::monitors::MonitorInfo;
use crate::workspaces::layout::{LiveWindow, Place, Placed, Rect};

/// The screen a point (in points) is on, with its scale; the main one when none has it.
fn screen_at(x: f64, y: f64, screens: &[MonitorInfo]) -> Option<MonitorInfo> {
    let logical = |m: &MonitorInfo| {
        let s = m.scale.max(0.5);
        (m.bounds.x as f64 / s, m.bounds.y as f64 / s, m.bounds.width as f64 / s, m.bounds.height as f64 / s)
    };
    screens
        .iter()
        .find(|m| {
            let (l, t, w, h) = logical(m);
            x >= l && x < l + w && y >= t && y < t + h
        })
        .or_else(|| screens.iter().find(|m| m.primary))
        .or(screens.first())
        .cloned()
}

fn to_px(v: f64, scale: f64) -> i32 {
    (v * scale).round() as i32
}

/// The app behind a process: its bundle path, bundle id and name.
fn app_info(pid: u32) -> (String, String, String) {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    autoreleasepool(|_| unsafe {
        let app: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32];
        if app.is_null() {
            return (crate::procs::exe_path(pid).unwrap_or_default(), String::new(), String::new());
        }
        let url: *mut AnyObject = msg_send![app, bundleURL];
        let path = if url.is_null() { String::new() } else { crate::msgwin::rust_string(msg_send![url, path]).unwrap_or_default() };
        let id = crate::msgwin::rust_string(msg_send![app, bundleIdentifier]).unwrap_or_default();
        let name = crate::msgwin::rust_string(msg_send![app, localizedName]).unwrap_or_default();
        (if path.is_empty() { crate::procs::exe_path(pid).unwrap_or_default() } else { path }, id, name)
    })
}

/// Ordinary windows (layer 0, not tiny, not Island's), front first, the minimized ones of each app
/// after them when the Accessibility API may say which those are.
pub fn list() -> Vec<LiveWindow> {
    let me = std::process::id();
    let screens = crate::monitors::all();
    let shown: Vec<cf::CgWindow> = cf::on_screen_windows().into_iter().filter(|w| w.layer == 0 && w.pid != me && w.bounds.2 > 40.0 && w.bounds.3 > 40.0).collect();
    let mut out: Vec<LiveWindow> = Vec::new();
    let mut seen_apps: Vec<u32> = Vec::new();
    let mut extra: Vec<LiveWindow> = Vec::new();
    for w in &shown {
        let (exe, app_id, app_name) = app_info(w.pid);
        let mut title = w.title.clone();
        if !seen_apps.contains(&w.pid) {
            seen_apps.push(w.pid);
            // The app's minimized windows, and the titles macOS holds back from Core Graphics.
            for a in ax::windows_of(w.pid) {
                if a.minimized {
                    if let Some(s) = screen_at(a.position.x, a.position.y, &screens) {
                        extra.push(live(w.pid, a.id as isize, &exe, &app_id, &app_name, a.title.clone(), (a.position.x, a.position.y, a.size.w, a.size.h), "minimized", &s));
                    }
                }
            }
        }
        if title.is_empty() {
            title = ax::windows_of(w.pid).iter().find(|a| a.id == w.id).map(|a| a.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| w.owner.clone());
        }
        let Some(s) = screen_at(w.bounds.0 + w.bounds.2 / 2.0, w.bounds.1 + w.bounds.3 / 2.0, &screens) else { continue };
        let state = if fills(&s, w.bounds) { "maximized" } else { "normal" };
        out.push(live(w.pid, w.id as isize, &exe, &app_id, &app_name, title, w.bounds, state, &s));
    }
    out.extend(extra);
    out
}

/// A window covering its screen's free area (below the menu bar, beside the Dock) counts as maximized.
fn fills(s: &MonitorInfo, (x, y, w, h): (f64, f64, f64, f64)) -> bool {
    let k = s.scale.max(0.5);
    let (wx, wy, ww, wh) = (s.work.x as f64 / k, s.work.y as f64 / k, s.work.width as f64 / k, s.work.height as f64 / k);
    (x - wx).abs() < 4.0 && (y - wy).abs() < 4.0 && (w - ww).abs() < 8.0 && (h - wh).abs() < 8.0
}

#[allow(clippy::too_many_arguments)]
fn live(pid: u32, hwnd: isize, exe: &str, app_id: &str, app_name: &str, title: String, (x, y, w, h): (f64, f64, f64, f64), state: &'static str, s: &MonitorInfo) -> LiveWindow {
    let k = s.scale.max(0.5);
    LiveWindow {
        hwnd,
        pid,
        exe: exe.to_string(),
        title,
        class_name: String::new(),
        rect: Rect { x: to_px(x, k), y: to_px(y, k), width: to_px(w, k), height: to_px(h, k) },
        state,
        monitor: s.id.clone(),
        dpi: (k * 96.0).round() as u32,
        app_id: app_id.to_string(),
        app_name: app_name.to_string(),
        link: String::new(),
        own: false,
    }
}

/// The app window in front (for noticing what you work on).
pub fn foreground() -> Option<LiveWindow> {
    let pid = crate::procs::foreground_pid();
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    list().into_iter().find(|w| w.pid == pid)
}

/// Puts one window where it goes. Needs Accessibility (asked for once).
pub fn place_one(p: &Place) -> Placed {
    let fail = |why: &str| Placed { hwnd: p.hwnd, ok: false, why: Some(why.to_string()) };
    if !crate::mac::keys::trusted(true) {
        return fail("Allow Island under System Settings › Privacy & Security › Accessibility to put windows back.");
    }
    let Some(cg) = cf::window(p.hwnd as u32) else { return fail("That window closed.") };
    let Some(w) = ax::windows_of(cg.pid).into_iter().find(|a| a.id as isize == p.hwnd) else { return fail("macOS wouldn't say where that window is.") };
    if p.state == "minimized" {
        return if ax::set_minimized(&w, true) { Placed { hwnd: p.hwnd, ok: true, why: None } } else { fail("It wouldn't minimize.") };
    }
    if w.minimized {
        ax::set_minimized(&w, false);
    }
    let screens = crate::monitors::all();
    // The target's screen, from its centre in pixels.
    let (cx, cy) = (p.rect.x + p.rect.width / 2, p.rect.y + p.rect.height / 2);
    let s = screens
        .iter()
        .find(|m| cx >= m.bounds.x && cx < m.bounds.x + m.bounds.width && cy >= m.bounds.y && cy < m.bounds.y + m.bounds.height)
        .or_else(|| screens.iter().find(|m| m.primary))
        .cloned();
    let k = s.as_ref().map(|m| m.scale.max(0.5)).unwrap_or(1.0);
    let (at, size) = if p.state == "maximized" {
        let Some(m) = s.as_ref() else { return fail("No screen for it.") };
        (Point { x: m.work.x as f64 / k, y: m.work.y as f64 / k }, Size { w: m.work.width as f64 / k, h: m.work.height as f64 / k })
    } else {
        (Point { x: p.rect.x as f64 / k, y: p.rect.y as f64 / k }, Size { w: p.rect.width as f64 / k, h: p.rect.height as f64 / k })
    };
    if ax::set_frame(&w, at, size) {
        Placed { hwnd: p.hwnd, ok: true, why: None }
    } else {
        fail("It wouldn't move (some windows can't be moved, like full-screen ones).")
    }
}

/// Minimizes one window into the Dock.
pub fn minimize(hwnd: isize) -> bool {
    if !crate::mac::keys::trusted(true) {
        return false;
    }
    let Some(cg) = cf::window(hwnd as u32) else { return false };
    ax::windows_of(cg.pid).into_iter().find(|a| a.id as isize == hwnd).is_some_and(|a| ax::set_minimized(&a, true))
}

/// Closes one window, as its red button does (the app may ask to save first).
pub fn close(hwnd: isize) -> bool {
    if !crate::mac::keys::trusted(true) {
        return false;
    }
    let Some(cg) = cf::window(hwnd as u32) else { return false };
    ax::windows_of(cg.pid).into_iter().find(|a| a.id as isize == hwnd).is_some_and(|a| ax::press_close(&a))
}

/// Brings one window forward: its app, then that window in it.
pub fn raise(hwnd: isize) -> bool {
    let Some(cg) = cf::window(hwnd as u32) else { return false };
    let raised = ax::windows_of(cg.pid).into_iter().find(|a| a.id as isize == hwnd).is_some_and(|a| ax::raise(&a));
    cf::activate_pid(cg.pid) || raised
}
