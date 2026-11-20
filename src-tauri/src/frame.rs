// The screen border (Settings › Widgets › Screen border): a thin line round the whole main screen
// that joins the taskbar and the island, with the Websites and Shelf notches coming out of it and,
// when chosen, an activity's light running all the way round it. The island (src/core/frame.ts)
// decides what it shows; this makes its window: the size of the screen, see-through, always on top
// but just under the taskbar and the island (so they draw over the line where they meet it), never
// taking the focus, and taking clicks only on the notches. Under a full-screen game or video it goes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors;

pub const LABEL: &str = "frame";

/// Where the page draws something that takes clicks (logical px rects x, y, w, h): the notches.
static SOLID: Mutex<Vec<[f64; 4]>> = Mutex::new(Vec::new());
static WATCHING: AtomicBool = AtomicBool::new(false);

/// A tool window (never in Alt-Tab or the taskbar) that a click doesn't activate.
#[cfg(windows)]
fn wanted_ex(style: u32) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    ((style | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0) | WS_EX_NOACTIVATE.0
}

/// tao rebuilds the extended style on each click-through switch; this keeps the tool window (as dock.rs does).
#[cfg(windows)]
unsafe extern "system" fn keep_style(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, STYLESTRUCT, WM_STYLECHANGING};
    if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 && lparam.0 != 0 {
        let change = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
        change.styleNew = wanted_ex(change.styleNew);
    }
    unsafe { windows::Win32::UI::Shell::DefSubclassProc(hwnd, msg, wparam, lparam) }
}

#[cfg(windows)]
fn guard_style(win: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE};
    let Ok(h) = win.hwnd() else { return };
    let raw = h.0 as isize;
    let _ = win.app_handle().run_on_main_thread(move || unsafe {
        let hwnd = windows::Win32::Foundation::HWND(raw as *mut _);
        if !windows::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(keep_style), 1, 0).as_bool() {
            crate::log::line("frame: could not guard the window style");
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = wanted_ex(ex as u32) as isize;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    });
}

#[cfg(windows)]
pub(crate) fn hwnd_of(app: &AppHandle, label: &str) -> Option<windows::Win32::Foundation::HWND> {
    let win = app.get_webview_window(label)?;
    let h = win.hwnd().ok()?;
    Some(windows::Win32::Foundation::HWND(h.0))
}

/// Puts the windows on top in their order: the island, under it the taskbar, under that the border
/// (each drawn over the one below where they meet). With or without the border: the taskbar never
/// covers the island (on the top edge it runs on behind the pill, Moss: "it just covers the island").
#[cfg(windows)]
pub fn restack(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    let mut above = HWND_TOPMOST;
    unsafe {
        if let Some(island) = hwnd_of(app, crate::overlay::LABEL) {
            let _ = SetWindowPos(island, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
            above = island;
        }
        if let Some(dock) = hwnd_of(app, crate::dock::LABEL) {
            let _ = SetWindowPos(dock, Some(above), 0, 0, 0, 0, flags);
            above = dock;
        }
        if let Some(frame) = hwnd_of(app, LABEL) {
            let _ = SetWindowPos(frame, Some(above), 0, 0, 0, 0, flags);
        }
    }
}

#[cfg(not(windows))]
pub fn restack(_app: &AppHandle) {}

/// The window over the whole main screen (physical px), and the page told where the work area is
/// (logical px from the screen's corner), for the island, which lives in the work area.
fn cover(win: &WebviewWindow) {
    let Some(m) = monitors::primary() else { return };
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        if let Ok(h) = win.hwnd() {
            unsafe {
                let _ = SetWindowPos(HWND(h.0), None, m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height, SWP_NOACTIVATE | SWP_NOZORDER);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = win.set_position(tauri::PhysicalPosition::new(m.bounds.x, m.bounds.y));
        let _ = win.set_size(tauri::PhysicalSize::new(m.bounds.width.max(1) as u32, m.bounds.height.max(1) as u32));
    }
    let s = m.scale;
    let _ = win.app_handle().emit_to(
        LABEL,
        "frame-screen",
        serde_json::json!({
            "width": m.bounds.width as f64 / s,
            "height": m.bounds.height as f64 / s,
            "workX": (m.work.x - m.bounds.x) as f64 / s,
            "workY": (m.work.y - m.bounds.y) as f64 / s,
        }),
    );
}

/// Shows the border's window over the main screen, making it the first time, or closes it. Built off
/// the calling thread, as building a window on the event loop deadlocks WebView2.
#[tauri::command]
pub fn frame_show(app: AppHandle, on: bool) {
    std::thread::spawn(move || {
        if !on {
            if let Some(win) = app.get_webview_window(LABEL) {
                let _ = win.destroy();
            }
            return;
        }
        if let Some(win) = app.get_webview_window(LABEL) {
            cover(&win);
            return;
        }
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Island screen border")
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
            .inner_size(800.0, 600.0)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build();
        match built {
            Ok(win) => {
                let _ = win.set_ignore_cursor_events(true);
                cover(&win);
                let _ = win.show();
                #[cfg(windows)]
                guard_style(&win);
                restack(&app);
                watch(app.clone());
            }
            Err(e) => crate::log::line(format!("screen border failed: {e}")),
        }
    });
}

/// The page asks where the screen is again (it just loaded).
#[tauri::command]
pub fn frame_hello(window: WebviewWindow) {
    if window.label() == LABEL {
        cover(&window);
    }
}

/// Where the page draws something that takes clicks (logical px rects [x, y, w, h]): the notches.
#[tauri::command]
pub fn frame_solid(rects: Vec<Vec<f64>>) {
    let clean: Vec<[f64; 4]> = rects.iter().filter(|r| r.len() == 4 && r.iter().all(|n| n.is_finite())).map(|r| [r[0], r[1], r[2], r[3]]).take(8).collect();
    *SOLID.lock().unwrap() = clean;
}

/// Site icons fetched so far (host → data: URL). Failures aren't kept: offline now, maybe not later.
static ICONS: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

/// A host name we may put in a URL: letters, digits, dots and dashes only.
pub(crate) fn clean_host(host: &str) -> Option<String> {
    let h = host.trim().to_ascii_lowercase();
    let ok = !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') && !h.starts_with('.') && !h.starts_with('-');
    ok.then_some(h)
}

/// An image's type from its Content-Type, safe to put in a data: URL (none: not an image).
pub(crate) fn icon_mime(header: Option<&str>) -> Option<String> {
    let m = header.unwrap_or("image/png").split(';').next()?.trim().to_ascii_lowercase();
    let ok = m.starts_with("image/") && m.chars().all(|c| c.is_ascii_alphanumeric() || "/.+-".contains(c));
    ok.then_some(m)
}

/// A pinned site's icon as a data: URL, fetched here and not in the page: the webview wouldn't load
/// Google's icons in the border's window (Moss, 11-19: letters instead of pictures). None: no picture.
#[tauri::command]
pub async fn site_icon(host: String) -> Option<String> {
    use base64::Engine as _;
    let host = clean_host(&host)?;
    if let Some(hit) = ICONS.lock().unwrap().as_ref().and_then(|m| m.get(&host).cloned()) {
        return Some(hit);
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().ok()?;
    let res = client.get(format!("https://www.google.com/s2/favicons?domain={host}&sz=64")).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mime = icon_mime(res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()))?;
    let bytes = res.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return None;
    }
    let url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    ICONS.lock().unwrap().get_or_insert_with(Default::default).insert(host, url.clone());
    Some(url)
}

/// How near the screen's edge (logical px) the pointer brings an auto-hidden border up.
#[cfg(windows)]
const EDGE_NEAR: f64 = 36.0;

/// While the window exists: it takes clicks only on the notches (so the rest of the screen works as
/// if it weren't there), keeps its place in the stack under the taskbar and the island, follows the
/// main screen if it changes, and goes while a full-screen game or video is in front.
#[cfg(windows)]
fn watch(app: AppHandle) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut taking: Option<bool> = None;
        let mut tick = 0u32;
        let mut full = false;
        let mut bounds: Option<(i32, i32, i32, i32)> = None;
        // The pointer near the screen's edge (Auto-hide: the border and notches come up).
        let mut near: Option<bool> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Some(win) = app.get_webview_window(LABEL) else {
                WATCHING.store(false, Ordering::SeqCst);
                return;
            };
            let Ok(h) = win.hwnd() else { continue };
            let hwnd = HWND(h.0);
            tick = tick.wrapping_add(1);
            // WebView2 makes the windows under the pointer after the page's drop target was set (the
            // window starts hidden), so files dropped on the Shelf's notch met "not allowed": they get
            // the page's target, as the island's do (overlay.rs share_drop_target).
            if tick % 100 == 0 && !crate::overlay::without_drop_target(hwnd).is_empty() {
                let raw = hwnd.0 as isize;
                let _ = app.run_on_main_thread(move || {
                    let given = crate::overlay::share_drop_target(HWND(raw as *mut _));
                    if given > 0 {
                        crate::log::line(format!("frame: file drops: drop target shared with {given} WebView2 windows"));
                    }
                });
            }
            if tick % 15 == 0 {
                let now = crate::dock::full();
                if now != full {
                    full = now;
                    let _ = app.emit_to(LABEL, "frame-full", now);
                }
                if !full {
                    restack(&app);
                }
                let b = monitors::primary().map(|m| (m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height));
                if b != bounds {
                    bounds = b;
                    cover(&win);
                }
            }
            let held = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000 != 0) };
            if held && taking == Some(true) {
                continue;
            }
            let mut p = POINT::default();
            let mut r = RECT::default();
            if unsafe { GetCursorPos(&mut p) }.is_err() || unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
                continue;
            }
            let scale = match unsafe { GetDpiForWindow(hwnd) } {
                0 => 1.0,
                dpi => dpi as f64 / 96.0,
            };
            let (x, y) = ((p.x - r.left) as f64 / scale, (p.y - r.top) as f64 / scale);
            let (ww, wh) = ((r.right - r.left) as f64 / scale, (r.bottom - r.top) as f64 / scale);
            let close = x < EDGE_NEAR || y < EDGE_NEAR || x > ww - EDGE_NEAR || y > wh - EDGE_NEAR;
            if near != Some(close) {
                near = Some(close);
                let _ = app.emit_to(LABEL, "frame-near", close);
            }
            let on = !full && crate::dock::solid_at(&SOLID.lock().unwrap(), x, y);
            if taking != Some(on) {
                taking = Some(on);
                let _ = win.set_ignore_cursor_events(!on);
            }
        }
    });
}

/// A Mac: the border takes clicks only on its notches, and comes up near the screen's edge
/// (Auto-hide), as on Windows; over apps' windows and on every Space (mac/window.rs).
#[cfg(target_os = "macos")]
fn watch(app: AppHandle) {
    const EDGE_NEAR: f64 = 36.0;
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        crate::mac::window::over_apps(&win);
    }
    std::thread::spawn(move || {
        let mut taking: Option<bool> = None;
        let mut tick = 0u32;
        let mut frame: Option<(f64, f64, f64, f64)> = None;
        let mut bounds: Option<(i32, i32, i32, i32)> = None;
        let mut near: Option<bool> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Some(win) = app.get_webview_window(LABEL) else {
                WATCHING.store(false, Ordering::SeqCst);
                return;
            };
            if tick % 15 == 0 || frame.is_none() {
                let b = monitors::primary().map(|m| (m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height));
                if b != bounds {
                    bounds = b;
                    cover(&win);
                }
                frame = crate::mac::window::frame_of(&win);
            }
            tick = tick.wrapping_add(1);
            if crate::mac::input::buttons_held() && taking == Some(true) {
                continue;
            }
            let Some(f) = frame else { continue };
            let Some((x, y)) = crate::mac::window::pointer_in(f) else { continue };
            let close = x < EDGE_NEAR || y < EDGE_NEAR || x > f.2 - EDGE_NEAR || y > f.3 - EDGE_NEAR;
            if near != Some(close) {
                near = Some(close);
                let _ = app.emit_to(LABEL, "frame-near", close);
            }
            let on = crate::dock::solid_at(&SOLID.lock().unwrap(), x, y);
            if taking != Some(on) {
                taking = Some(on);
                let _ = win.set_ignore_cursor_events(!on);
            }
        }
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
fn watch(_app: AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{clean_host, icon_mime};

    #[test]
    fn only_plain_host_names_go_in_the_icon_url() {
        assert_eq!(clean_host(" GitHub.com "), Some("github.com".into()));
        assert_eq!(clean_host("www.youtube.com"), Some("www.youtube.com".into()));
        assert_eq!(clean_host(""), None);
        assert_eq!(clean_host("a.com&sz=1"), None);
        assert_eq!(clean_host("a.com/x"), None);
        assert_eq!(clean_host(".evil"), None);
    }

    #[test]
    fn only_image_types_make_a_data_url() {
        assert_eq!(icon_mime(Some("image/png")), Some("image/png".into()));
        assert_eq!(icon_mime(Some("image/svg+xml; charset=utf-8")), Some("image/svg+xml".into()));
        assert_eq!(icon_mime(None), Some("image/png".into()));
        assert_eq!(icon_mime(Some("text/html")), None);
        assert_eq!(icon_mime(Some("image/png\"onerror")), None);
    }
}
