// Windows on screen, for saving a workspace's layout and putting it back. Listing reads each
// app window's program, title, class, rectangle, state (normal, maximized, minimized) and
// monitor; placing sets a window's restored rectangle and state in one call
// (SetWindowPlacement), then sets the size again if the window changed monitors with a
// different scale (a per-monitor-aware app resizes itself on the way). Which saved window is
// which live one, and where it goes on today's monitors, is decided in TypeScript
// (src/workspaces/layout.ts). Island's own windows, the desktop and taskbar, cloaked windows
// (other virtual desktops) and windows of programs Island may not look into are left alone.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveWindow {
    pub hwnd: isize,
    pub pid: u32,
    /// Full path of the program (for a Store app, the app's own process, not its frame host).
    pub exe: String,
    pub title: String,
    pub class_name: String,
    /// Its rectangle when not maximized or minimized, in screen pixels.
    pub rect: Rect,
    pub state: &'static str,
    /// The monitor it's on (GDI device name, like monitors_list's id).
    pub monitor: String,
    pub dpi: u32,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub hwnd: isize,
    /// Where it goes when not maximized or minimized, in screen pixels.
    pub rect: Rect,
    pub state: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub hwnd: isize,
    pub ok: bool,
    /// Why not, in words.
    pub why: Option<String>,
}

#[cfg(windows)]
mod win {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{MonitorFromRect, MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, GetClassNameW, GetWindow, GetWindowLongW, GetWindowPlacement, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible, IsZoomed, SetWindowPlacement,
        SetWindowPos, GWL_EXSTYLE, GW_OWNER, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, SW_SHOWMAXIMIZED, SW_SHOWMINNOACTIVE,
        SW_SHOWNOACTIVATE, WINDOWPLACEMENT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    use super::{LiveWindow, Place, Placed, Rect};

    /// Windows that are part of the desktop itself.
    const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"];

    fn text(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let got = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..got.max(0) as usize])
        }
    }

    fn class(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn cloaked(hwnd: HWND) -> bool {
        let mut v: u32 = 0;
        unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut v as *mut u32 as *mut _, 4) }.is_ok() && v != 0
    }

    fn rect_of(r: RECT) -> Rect {
        Rect { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
    }

    /// "Workspace" coordinates (GetWindowPlacement's) start at the primary monitor's work area.
    fn primary_work_origin() -> (i32, i32) {
        crate::monitors::primary().map(|m| (m.work.x - m.bounds.x, m.work.y - m.bounds.y)).unwrap_or((0, 0))
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    /// A Store app's frame belongs to ApplicationFrameHost; the app is its CoreWindow child.
    fn app_pid(hwnd: HWND, class_name: &str) -> u32 {
        let pid = pid_of(hwnd);
        if class_name != "ApplicationFrameWindow" {
            return pid;
        }
        let core_class: Vec<u16> = "Windows.UI.Core.CoreWindow\0".encode_utf16().collect();
        match unsafe { FindWindowExW(Some(hwnd), None, windows::core::PCWSTR(core_class.as_ptr()), windows::core::PCWSTR::null()) } {
            Ok(child) if !child.0.is_null() => pid_of(child),
            _ => pid,
        }
    }

    fn monitor_id(hmon: windows::Win32::Graphics::Gdi::HMONITOR) -> String {
        crate::monitors::info_for(hmon).map(|m| m.id).unwrap_or_default()
    }

    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<LiveWindow>) };
        if let Some(w) = describe(hwnd) {
            list.push(w);
        }
        true.into()
    }

    /// An app window worth saving: on screen (or minimized), titled, not owned, not a tool window,
    /// not Island's, not the desktop's, not on another virtual desktop.
    fn describe(hwnd: HWND) -> Option<LiveWindow> {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || cloaked(hwnd) {
                return None;
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.0.is_null());
            if (ex & WS_EX_APPWINDOW.0 == 0) && (owned || ex & WS_EX_TOOLWINDOW.0 != 0) {
                return None;
            }
            let title = text(hwnd);
            let class_name = class(hwnd);
            if title.trim().is_empty() || SHELL_CLASSES.contains(&class_name.as_str()) {
                return None;
            }
            let pid = app_pid(hwnd, &class_name);
            if pid == std::process::id() {
                return None;
            }
            let exe = super::super::launch::program_path(pid)?;
            let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            GetWindowPlacement(hwnd, &mut wp).ok()?;
            let state = if IsIconic(hwnd).as_bool() {
                "minimized"
            } else if IsZoomed(hwnd).as_bool() {
                "maximized"
            } else {
                "normal"
            };
            let rect = if state == "normal" {
                let mut r = RECT::default();
                GetWindowRect(hwnd, &mut r).ok()?;
                rect_of(r)
            } else {
                let (ox, oy) = primary_work_origin();
                let mut r = rect_of(wp.rcNormalPosition);
                r.x += ox;
                r.y += oy;
                r
            };
            // A window being made or torn down can have no size yet: nothing to save or place.
            if rect.width <= 0 || rect.height <= 0 {
                return None;
            }
            let hmon = if state == "minimized" {
                let r = RECT { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
                MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST)
            } else {
                MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
            };
            Some(LiveWindow {
                hwnd: hwnd.0 as isize,
                pid,
                exe,
                title,
                class_name,
                rect,
                state,
                monitor: monitor_id(hmon),
                dpi: GetDpiForWindow(hwnd),
            })
        }
    }

    /// The app window in front, if the window in front is one (not the desktop, a tool window
    /// or one of Island's).
    pub fn foreground() -> Option<LiveWindow> {
        let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        describe(hwnd)
    }

    pub fn list() -> Vec<LiveWindow> {
        let mut out: Vec<LiveWindow> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    fn dpi_at(rect: &Rect) -> u32 {
        let r = RECT { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
        let hmon = unsafe { MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST) };
        crate::monitors::info_for(hmon).map(|m| (m.scale * 96.0).round() as u32).unwrap_or(96)
    }

    pub fn place_one(p: &Place) -> Placed {
        let hwnd = HWND(p.hwnd as *mut _);
        let fail = |why: &str| Placed { hwnd: p.hwnd, ok: false, why: Some(why.to_string()) };
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return fail("That window closed.");
            }
            if IsHungAppWindow(hwnd).as_bool() {
                return fail("It isn't responding.");
            }
            let (ox, oy) = primary_work_origin();
            let r = &p.rect;
            let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            if GetWindowPlacement(hwnd, &mut wp).is_err() {
                return fail("Windows wouldn't say where it is.");
            }
            let before_dpi = GetDpiForWindow(hwnd);
            wp.flags = Default::default();
            wp.showCmd = match p.state.as_str() {
                "maximized" => SW_SHOWMAXIMIZED.0 as u32,
                "minimized" => SW_SHOWMINNOACTIVE.0 as u32,
                _ => SW_SHOWNOACTIVATE.0 as u32,
            };
            wp.rcNormalPosition = RECT { left: r.x - ox, top: r.y - oy, right: r.x - ox + r.width, bottom: r.y - oy + r.height };
            if SetWindowPlacement(hwnd, &wp).is_err() {
                // Windows keeps a program from moving the windows of one running as administrator.
                return fail("Windows wouldn't let Island move it (it may be running as administrator).");
            }
            // Crossing to a monitor with another scale, the app may have resized itself: set it again.
            if p.state == "normal" && before_dpi != dpi_at(r) {
                let _ = SetWindowPos(hwnd, None, r.x, r.y, r.width, r.height, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);
            }
        }
        Placed { hwnd: p.hwnd, ok: true, why: None }
    }

}

#[cfg(all(test, windows))]
pub fn list_now() -> Vec<LiveWindow> {
    win::list()
}
#[cfg(all(test, windows))]
pub fn place_now(p: &Place) -> Placed {
    win::place_one(p)
}

/// The app window in front (for noticing what you work on); None on a Mac for now.
pub fn foreground_window() -> Option<LiveWindow> {
    #[cfg(windows)]
    {
        win::foreground()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The app windows on screen now, front first.
#[tauri::command]
pub async fn ws_windows() -> Result<Vec<LiveWindow>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win::list).await.map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Window layouts come to the Mac later.".into())
    }
}

/// Moves each window to its rectangle and state; one result per window.
#[tauri::command]
pub async fn ws_place(places: Vec<Place>) -> Result<Vec<Placed>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || places.iter().take(200).map(win::place_one).collect()).await.map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = places;
        Err("Window layouts come to the Mac later.".into())
    }
}
