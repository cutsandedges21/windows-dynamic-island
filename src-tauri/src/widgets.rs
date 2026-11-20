// Desktop widgets: small borderless windows on the desktop, one per widget. The island
// (src/core/widgets.ts) owns what they show and where they are saved; this makes, sizes and
// places them, and keeps them on the desktop.
//
// On the desktop means: under your apps, above the wallpaper, and still there after Show desktop
// (Win+D, which brings the desktop in front of every window). Each widget window is owned by the
// desktop's icon view (SHELLDLL_DefView, under Progman or a WorkerW), and Windows always keeps an
// owned window just above its owner: the widgets ride along wherever the desktop goes, and stay
// under every app window. The icon view is only used when Explorer has already made it; without
// it (Explorer starting) a widget goes just above Progman and is attached on the next check.
//
// A widget window never takes the keyboard focus (WS_EX_NOACTIVATE) and is not in Alt-Tab or the
// taskbar (WS_EX_TOOLWINDOW).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors;

pub const PREFIX: &str = "widget-";
/// Gap to the screen's edge and between default places, in logical px.
const MARGIN: f64 = 24.0;

#[derive(Deserialize, Debug, Clone)]
pub struct Spec {
    pub id: String,
    /// Where its top-left corner is, in physical px on the desktop; negative: not placed yet.
    pub x: i32,
    pub y: i32,
    /// First size, logical px (the page corrects it to its content).
    pub w: f64,
    pub h: f64,
}

/// A widget's id is what follows the prefix in its window's label; labels are letters, digits and `-`.
pub fn label_of(id: &str) -> Option<String> {
    let ok = !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("{PREFIX}{id}"))
}

/// A rectangle as (x, y, width, height), physical px.
pub type Rect4 = (i32, i32, i32, i32);

fn overlaps(a: Rect4, b: Rect4) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

/// The first free spot for a widget `w` x `h` (physical px) in the work area `area`, down the
/// right side first, then column by column to the left; `gap` between widgets. Covering nothing
/// in `taken`, which it is added to. With no room anywhere: the top right corner.
pub fn free_place(taken: &mut Vec<Rect4>, area: Rect4, w: i32, h: i32, gap: i32) -> (i32, i32) {
    let (left, top, aw, ah) = area;
    let mut x = left + aw - w - gap;
    while x >= left {
        let mut y = top + gap;
        while y + h <= top + ah {
            let me = (x, y, w, h);
            match taken.iter().find(|t| overlaps(me, (t.0 - gap, t.1 - gap, t.2 + 2 * gap, t.3 + 2 * gap))) {
                Some(t) => y = t.1 + t.3 + gap,
                None => {
                    taken.push(me);
                    return (x, y);
                }
            }
        }
        x -= w + gap;
    }
    let at = (left + aw - w - gap, top + gap);
    taken.push((at.0, at.1, w, h));
    at
}

#[cfg(windows)]
mod desk {
    use windows::core::{w, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetWindowLongPtrW, IsWindow, SetWindowLongPtrW, SetWindowPos, GWLP_HWNDPARENT, GWL_EXSTYLE, HWND_BOTTOM, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn find(top: HWND, out: LPARAM) -> BOOL {
        unsafe {
            if let Ok(view) = FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), None) {
                if !view.is_invalid() {
                    *(out.0 as *mut isize) = view.0 as isize;
                    return false.into();
                }
            }
        }
        true.into()
    }

    /// The desktop's icon view, if Explorer has made it (it never is made here: forcing a WorkerW
    /// while Explorer starts can shuffle the desktop's icons).
    pub fn icon_view() -> Option<HWND> {
        let mut found: isize = 0;
        unsafe {
            let _ = EnumWindows(Some(find), LPARAM(&mut found as *mut isize as isize));
        }
        (found != 0).then_some(HWND(found as *mut _))
    }

    pub fn owner(hwnd: HWND) -> isize {
        unsafe { GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) }
    }

    /// Owned by the icon view, never taking the focus, out of Alt-Tab; at the bottom of the
    /// desktop band (Windows keeps an owned window above its owner). True when it is attached.
    pub fn attach(hwnd: HWND) -> bool {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let want = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
            }
            let view = icon_view();
            if let Some(v) = view {
                if owner(hwnd) != v.0 as isize {
                    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, v.0 as isize);
                }
            }
            let attached = view.is_some_and(|v| owner(hwnd) == v.0 as isize);
            // Without the icon view: just above Progman, where the wallpaper can't cover it.
            let after = if attached { HWND_BOTTOM } else { FindWindowW(w!("Progman"), None).unwrap_or(HWND_BOTTOM) };
            let _ = SetWindowPos(hwnd, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            attached
        }
    }

    /// Still owned by a live icon view (Explorer may have restarted).
    pub fn attached(hwnd: HWND) -> bool {
        let o = owner(hwnd);
        o != 0 && unsafe { IsWindow(Some(HWND(o as *mut _))) }.as_bool() && icon_view().is_some_and(|v| v.0 as isize == o)
    }
}

#[cfg(windows)]
fn hwnd(win: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    win.hwnd().ok().map(|h| windows::Win32::Foundation::HWND(h.0))
}

#[cfg(windows)]
fn attach(win: &WebviewWindow) {
    if let Some(h) = hwnd(win) {
        desk::attach(h);
    }
}

/// A Mac: just above the desktop's icons, under every app, on every Space (mac/window.rs).
#[cfg(target_os = "macos")]
fn attach(win: &WebviewWindow) {
    crate::mac::window::on_desktop(win);
}

#[cfg(not(any(windows, target_os = "macos")))]
fn attach(_win: &WebviewWindow) {}

fn widget_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with(PREFIX)).map(|(_, w)| w).collect()
}

static KEEPER: AtomicBool = AtomicBool::new(false);

/// One thread while any widget exists: every 3 s, a widget that lost its owner (Explorer
/// restarted, or it wasn't ready at start) is attached again. Attached ones are left alone, so
/// nothing flickers.
fn keep_attached(app: AppHandle) {
    if KEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let wins = widget_windows(&app);
        if wins.is_empty() {
            KEEPER.store(false, Ordering::SeqCst);
            return;
        }
        #[cfg(windows)]
        for w in &wins {
            if let Some(h) = hwnd(w) {
                if !desk::attached(h) {
                    desk::attach(h);
                }
            }
        }
    });
}

/// Makes the windows for `specs` and closes widgets no longer listed. Windows are built off the
/// calling thread (building one on the event loop deadlocks WebView2). A widget with no saved
/// place is put down the right side and its place reported to the island (`widget-moved`).
#[tauri::command]
pub fn widgets_sync(app: AppHandle, specs: Vec<Spec>) {
    std::thread::spawn(move || {
        let wanted: Vec<(String, Spec)> = specs.into_iter().filter_map(|s| label_of(&s.id).map(|l| (l, s))).collect();
        for win in widget_windows(&app) {
            if !wanted.iter().any(|(l, _)| l == win.label()) {
                let _ = win.destroy();
            }
        }
        let primary = monitors::primary();
        let (scale, area) = primary.as_ref().map(|m| (m.scale, (m.work.x, m.work.y, m.work.width, m.work.height))).unwrap_or((1.0, (0, 0, 1280, 720)));
        // Widgets already on the desktop, and saved places of those coming back, are taken.
        let mut taken: Vec<Rect4> = widget_windows(&app)
            .iter()
            .filter_map(|w| Some((w.outer_position().ok()?, w.outer_size().ok()?)))
            .map(|(p, s)| (p.x, p.y, s.width as i32, s.height as i32))
            .collect();
        for (_, s) in wanted.iter().filter(|(_, s)| s.x >= 0) {
            taken.push((s.x, s.y, (s.w * scale).round() as i32, (s.h * scale).round() as i32));
        }
        let gap = (MARGIN / 2.0 * scale).round() as i32;
        for (label, spec) in &wanted {
            if app.get_webview_window(label).is_some() {
                continue;
            }
            let at = if spec.x < 0 { free_place(&mut taken, area, (spec.w * scale).round() as i32, (spec.h * scale).round() as i32, gap) } else { (spec.x, spec.y) };
            let built = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
                .title("Island widget")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .always_on_top(false)
                .visible(false)
                .inner_size(spec.w.max(80.0), spec.h.max(40.0))
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .build();
            match built {
                Ok(win) => {
                    let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
                    attach(&win);
                    let _ = win.show();
                    attach(&win);
                    if spec.x < 0 {
                        let _ = app.emit_to(crate::overlay::LABEL, "widget-moved", serde_json::json!({ "id": spec.id, "x": at.0, "y": at.1 }));
                    }
                }
                Err(e) => crate::log::line(format!("widget {label} failed: {e}")),
            }
        }
        if !widget_windows(&app).is_empty() {
            keep_attached(app.clone());
        }
    });
}

/// A widget page fitted its content: its window is that size (logical px), pulled back onto its
/// screen if it grew past the right or bottom edge.
#[tauri::command]
pub fn widget_size(window: WebviewWindow, w: f64, h: f64) {
    if !window.label().starts_with(PREFIX) || !(20.0..=2000.0).contains(&w) || !(20.0..=2000.0).contains(&h) {
        return;
    }
    let _ = window.set_size(LogicalSize::new(w.ceil(), h.ceil()));
    if let (Ok(at), Ok(size), Ok(Some(m))) = (window.outer_position(), window.outer_size(), window.current_monitor()) {
        let (mx, my) = (m.position().x + m.size().width as i32, m.position().y + m.size().height as i32);
        let x = at.x.min(mx - size.width as i32 - 8).max(m.position().x);
        let y = at.y.min(my - size.height as i32 - 8).max(m.position().y);
        if (x, y) != (at.x, at.y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// A widget was dragged: where it is now goes to the island to be saved (physical px).
#[tauri::command]
pub fn widget_moved(app: AppHandle, window: WebviewWindow) {
    let Some(id) = window.label().strip_prefix(PREFIX) else { return };
    if let Ok(at) = window.outer_position() {
        let _ = app.emit_to(crate::overlay::LABEL, "widget-moved", serde_json::json!({ "id": id, "x": at.x, "y": at.y }));
    }
}

#[cfg(test)]
mod tests {
    use super::{free_place, label_of};

    #[test]
    fn a_new_widget_takes_a_free_spot() {
        let area = (0, 0, 1920, 1080);
        let mut taken = vec![];
        // The first goes to the top right corner.
        assert_eq!(free_place(&mut taken, area, 300, 180, 10), (1610, 10));
        // The next goes under it, never on it.
        assert_eq!(free_place(&mut taken, area, 300, 180, 10), (1610, 200));
        // One that was dragged elsewhere leaves its old spot free.
        let mut moved = vec![(1610, 200, 300, 180)];
        assert_eq!(free_place(&mut moved, area, 300, 180, 10), (1610, 10));
        // A full column: the next one to the left.
        let mut full = vec![(1610, 10, 300, 1060)];
        assert_eq!(free_place(&mut full, area, 300, 180, 10), (1300, 10));
    }

    #[test]
    fn labels_are_safe() {
        assert_eq!(label_of("w1-ab"), Some("widget-w1-ab".to_string()));
        assert_eq!(label_of(""), None);
        assert_eq!(label_of("../x"), None);
        assert_eq!(label_of(&"a".repeat(41)), None);
    }

}
