// The taskbar (Settings › Taskbar): a pill along the bottom of the main screen in the island's own
// glass, with Start, your pinned and open apps, music and the timer, Wi-Fi, sound, the clock and
// the notification bell. The island (src/core/dock.ts) decides what it shows; this makes its
// window (always on top, never taking the focus), keeps it at the bottom of the work area (above
// Windows' taskbar while that one shows), sizes it to its content, moves it left and right as it
// is dragged, opens Windows' own panels for its buttons, and can set Windows' taskbar to hide.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors;

pub const LABEL: &str = "dock";
/// Gap between the dock and the bottom of the work area, logical px.
const GAP: f64 = 8.0;

/// Where the dock's centre sits across the screen, 0..1; negative: the middle.
static CENTRE: Mutex<f64> = Mutex::new(-1.0);
/// Island set Windows' taskbar to hide (and puts it back when Island quits).
static HID_WINDOWS_BAR: AtomicBool = AtomicBool::new(false);

/// The dock's top-left corner (physical px) for a window `w` x `h` logical px on a screen whose
/// work area starts at `left`, is `width` wide and ends at `bottom`, its centre at `centre` (0..1,
/// negative: the middle). It never leaves the screen.
pub fn place(left: i32, width: i32, bottom: i32, scale: f64, w: f64, h: f64, centre: f64) -> (i32, i32) {
    let pw = (w * scale).round() as i32;
    let ph = ((h + GAP) * scale).round() as i32;
    let mid = if centre < 0.0 { left + width / 2 } else { left + (centre.min(1.0) * width as f64).round() as i32 };
    let x = (mid - pw / 2).clamp(left, (left + width - pw).max(left));
    (x, bottom - ph)
}

/// The centre (0..1 across the work area) of a dock `pw` physical px wide whose left edge is at `x`.
pub fn centre_of(left: i32, width: i32, x: i32, pw: i32) -> f64 {
    if width <= 0 {
        return -1.0;
    }
    ((x + pw / 2 - left) as f64 / width as f64).clamp(0.0, 1.0)
}

#[cfg(windows)]
fn style(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let hwnd = HWND(h.0);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let want = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
        }
    }
}

#[cfg(not(windows))]
fn style(_win: &WebviewWindow) {}

/// Sizes the dock to `w` x `h` logical px and puts it where it belongs.
fn put(win: &WebviewWindow, w: f64, h: f64) {
    let Some(m) = monitors::primary() else { return };
    let _ = win.set_size(LogicalSize::new(w.ceil(), h.ceil()));
    let centre = *CENTRE.lock().unwrap();
    let (x, y) = place(m.work.x, m.work.width, m.work.y + m.work.height, m.scale, w, h, centre);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Shows the dock at `w` x `h` logical px with its centre at `centre` (0..1 across the screen,
/// negative: the middle), making its window the first time, or closes it. Built off the calling
/// thread, as building a window on the event loop deadlocks WebView2.
#[tauri::command]
pub fn dock_show(app: AppHandle, on: bool, w: f64, h: f64, centre: f64) {
    *CENTRE.lock().unwrap() = if centre.is_finite() { centre } else { -1.0 };
    std::thread::spawn(move || {
        if !on {
            if let Some(win) = app.get_webview_window(LABEL) {
                let _ = win.destroy();
            }
            return;
        }
        let (w, h) = (w.clamp(120.0, 1800.0), h.clamp(32.0, 120.0));
        if let Some(win) = app.get_webview_window(LABEL) {
            put(&win, w, h);
            return;
        }
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Island taskbar")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .visible(false)
            .inner_size(w, h)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build();
        match built {
            Ok(win) => {
                style(&win);
                put(&win, w, h);
                let _ = win.show();
                style(&win);
            }
            Err(e) => crate::log::line(format!("dock failed: {e}")),
        }
    });
}

/// The dock page measured its content: the window takes that size and stays in its place.
#[tauri::command]
pub fn dock_fit(window: WebviewWindow, w: f64, h: f64) {
    if window.label() != LABEL || !w.is_finite() || !h.is_finite() {
        return;
    }
    put(&window, w.clamp(120.0, 1800.0), h.clamp(32.0, 120.0));
}

/// Dragging the dock: its left edge to `x` (physical px), along the bottom only. `done`: the drag
/// ended, so its place is kept and the island told (`dock-moved`). `x` negative with `done`:
/// back to the middle (a double-click).
#[tauri::command]
pub fn dock_at(app: AppHandle, window: WebviewWindow, x: f64, done: bool) {
    if window.label() != LABEL {
        return;
    }
    let (Some(m), Ok(at), Ok(size)) = (monitors::primary(), window.outer_position(), window.outer_size()) else { return };
    let pw = size.width as i32;
    let (left, width) = (m.work.x, m.work.width);
    if done && x < 0.0 {
        *CENTRE.lock().unwrap() = -1.0;
    } else if x.is_finite() {
        let nx = (x.round() as i32).clamp(left, (left + width - pw).max(left));
        if nx != at.x {
            let _ = window.set_position(PhysicalPosition::new(nx, at.y));
        }
        if !done {
            return;
        }
        *CENTRE.lock().unwrap() = centre_of(left, width, nx, pw);
    }
    if let Ok(s) = window.inner_size() {
        let scale = window.scale_factor().unwrap_or(m.scale);
        put(&window, s.width as f64 / scale, s.height as f64 / scale);
    }
    let centre = *CENTRE.lock().unwrap();
    let _ = app.emit_to(crate::overlay::LABEL, "dock-moved", serde_json::json!({ "centre": centre }));
}

/// The panels Windows opens from its own taskbar: Start (Win), Quick Settings (Win+A, Wi-Fi and
/// sound) and the notifications (Win+N).
#[cfg(windows)]
#[tauri::command]
pub fn dock_panel(which: String) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN};
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
    };
    let letter = match which.as_str() {
        "start" => None,
        "quick" => Some(VIRTUAL_KEY(0x41)),
        "notifications" => Some(VIRTUAL_KEY(0x4E)),
        _ => return false,
    };
    let inputs: Vec<INPUT> = match letter {
        None => vec![key(VK_LWIN, false), key(VK_LWIN, true)],
        Some(k) => vec![key(VK_LWIN, false), key(k, false), key(k, true), key(VK_LWIN, true)],
    };
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dock_panel(_which: String) -> bool {
    false
}

#[cfg(windows)]
fn set_autohide(on: bool) -> bool {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA};
    unsafe {
        let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
        let state = SHAppBarMessage(ABM_GETSTATE, &mut d) as u32;
        let want = if on { state | ABS_AUTOHIDE } else { state & !ABS_AUTOHIDE };
        if want != state {
            d.lParam = LPARAM(want as isize);
            SHAppBarMessage(ABM_SETSTATE, &mut d);
        }
        (SHAppBarMessage(ABM_GETSTATE, &mut d) as u32) & ABS_AUTOHIDE != 0
    }
}

/// Sets Windows' own taskbar to hide itself (or show again), as Settings › Personalization ›
/// Taskbar › Automatically hide the taskbar does. The island only asks to show it again when it
/// (in this run or one before) was the one that hid it. Answers whether it hides now.
#[cfg(windows)]
#[tauri::command]
pub fn dock_autohide(on: bool) -> bool {
    HID_WINDOWS_BAR.store(on, Ordering::SeqCst);
    set_autohide(on)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dock_autohide(_on: bool) -> bool {
    false
}

/// Island is quitting: Windows' taskbar comes back if Island hid it.
pub fn quit() {
    #[cfg(windows)]
    if HID_WINDOWS_BAR.swap(false, Ordering::SeqCst) {
        set_autohide(false);
    }
}

#[cfg(test)]
mod tests {
    use super::{centre_of, place};

    #[test]
    fn the_dock_sits_centred_just_above_the_bottom_of_the_work_area() {
        assert_eq!(place(0, 1920, 1032, 1.0, 600.0, 56.0, -1.0), (660, 1032 - 64));
        // A 125 % screen counts physical pixels.
        assert_eq!(place(0, 1920, 1020, 1.25, 600.0, 56.0, -1.0), (585, 1020 - 80));
    }

    #[test]
    fn a_dragged_dock_keeps_its_place_and_never_leaves_the_screen() {
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 0.25), (180, 1016));
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 0.0), (0, 1016));
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 1.0), (1320, 1016));
        assert_eq!(centre_of(0, 1920, 180, 600), 0.25);
        assert_eq!(centre_of(0, 1920, -50, 600), 0.130_208_333_333_333_34);
    }
}
