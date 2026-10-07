// Displays: bounds, work area (screen minus the taskbar, wherever it is), DPI and
// orientation for every monitor, straight from Win32 so nothing is assumed about
// where the taskbar sits.

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow,
    DISPLAY_DEVICEW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, MONITORINFOF_PRIMARY};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<RECT> for Rect {
    fn from(r: RECT) -> Self {
        Rect { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Stable for the session: the GDI device name, e.g. `\\.\DISPLAY1`.
    pub id: String,
    pub name: String,
    pub primary: bool,
    /// Physical pixels in virtual-screen coordinates.
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
    pub portrait: bool,
    /// Where the taskbar is, derived from bounds minus work area.
    pub taskbar: &'static str,
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn taskbar_edge(b: &Rect, w: &Rect) -> &'static str {
    if w.y > b.y {
        "top"
    } else if w.x > b.x {
        "left"
    } else if w.x + w.width < b.x + b.width {
        "right"
    } else if w.y + w.height < b.y + b.height {
        "bottom"
    } else {
        "hidden"
    }
}

fn friendly_name(device: &str) -> String {
    let wide: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
    let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
    let ok = unsafe { EnumDisplayDevicesW(windows::core::PCWSTR(wide.as_ptr()), 0, &mut dd, 0) };
    if ok.as_bool() {
        let s = wide_to_string(&dd.DeviceString);
        if !s.is_empty() {
            return s;
        }
    }
    device.trim_start_matches(r"\\.\").to_string()
}

pub fn info_for(hmon: HMONITOR) -> Option<MonitorInfo> {
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe { GetMonitorInfoW(hmon, &mut mi.monitorInfo as *mut MONITORINFO) };
    if !ok.as_bool() {
        return None;
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let id = wide_to_string(&mi.szDevice);
    let bounds = Rect::from(mi.monitorInfo.rcMonitor);
    let work = Rect::from(mi.monitorInfo.rcWork);
    Some(MonitorInfo {
        name: friendly_name(&id),
        primary: (mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        portrait: bounds.height > bounds.width,
        taskbar: taskbar_edge(&bounds, &work),
        scale: (dx.max(48) as f64) / 96.0,
        bounds,
        work,
        id,
    })
}

unsafe extern "system" fn collect(hmon: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let list = unsafe { &mut *(data.0 as *mut Vec<MonitorInfo>) };
    if let Some(info) = info_for(hmon) {
        list.push(info);
    }
    true.into()
}

pub fn all() -> Vec<MonitorInfo> {
    let mut list: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

pub fn at_cursor() -> Option<MonitorInfo> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    info_for(unsafe { MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST) })
}

pub fn of_window(hwnd: HWND) -> Option<MonitorInfo> {
    info_for(unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) })
}

pub fn find(id: &str) -> Option<MonitorInfo> {
    all().into_iter().find(|m| m.id == id)
}

pub fn primary() -> Option<MonitorInfo> {
    let list = all();
    list.iter().find(|m| m.primary).cloned().or_else(|| list.into_iter().next())
}

#[tauri::command]
pub fn monitors_list() -> Vec<MonitorInfo> {
    all()
}

#[tauri::command]
pub fn monitor_at_cursor() -> Option<MonitorInfo> {
    at_cursor()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, width: w, height: h }
    }

    #[test]
    fn taskbar_edge_follows_the_missing_strip() {
        let b = r(0, 0, 1920, 1080);
        assert_eq!(taskbar_edge(&b, &r(0, 0, 1920, 1032)), "bottom");
        assert_eq!(taskbar_edge(&b, &r(0, 48, 1920, 1032)), "top");
        assert_eq!(taskbar_edge(&b, &r(62, 0, 1858, 1080)), "left");
        assert_eq!(taskbar_edge(&b, &r(0, 0, 1858, 1080)), "right");
        assert_eq!(taskbar_edge(&b, &b), "hidden");
    }
}
