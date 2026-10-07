// Processes and windows, ported from Usage Clip's platform/win32.js: one
// Toolhelp snapshot (names, parents, start times), visible titled top-level
// windows, and window activation that survives Windows' foreground lock.

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, RECT};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, GetAsyncKeyState, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
    ShowWindow, ASFW_ANY, SW_RESTORE,
};

const FILETIME_UNIX_OFFSET_MS: i64 = 11_644_473_600_000;

#[derive(Serialize)]
pub struct ProcRow(pub u32, pub u32, pub String, pub Option<f64>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowRow {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Process creation time as epoch ms, or None when it cannot be read.
pub fn start_ms(pid: u32) -> Option<f64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let ticks = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
        if ticks == 0 {
            return None;
        }
        Some(((ticks / 10_000) as i64 - FILETIME_UNIX_OFFSET_MS) as f64)
    }
}

/// [pid, ppid, lowercased exe name, start ms] for every process.
pub fn snapshot(with_start: bool) -> Vec<ProcRow> {
    let mut rows = Vec::with_capacity(400);
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return rows };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                let name = wide_to_string(&entry.szExeFile).to_lowercase();
                let start = if with_start && pid > 4 { start_ms(pid) } else { None };
                rows.push(ProcRow(pid, entry.th32ParentProcessID, name, start));
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    rows
}

unsafe extern "system" fn collect_windows(hwnd: HWND, data: LPARAM) -> BOOL {
    let list = unsafe { &mut *(data.0 as *mut Vec<WindowRow>) };
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return true.into();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let got = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..got.max(0) as usize]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        list.push(WindowRow { hwnd: hwnd.0 as isize, pid, title });
    }
    true.into()
}

/// Visible, titled top-level windows, in Z order (front first).
pub fn windows() -> Vec<WindowRow> {
    let mut list: Vec<WindowRow> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_windows), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

fn key_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

/// True while the user physically holds Alt, Shift, Ctrl or Win.
pub fn modifiers_down() -> bool {
    [VK_MENU, VK_SHIFT, VK_CONTROL, VK_LWIN, VK_RWIN].iter().any(|vk| key_down(vk.0))
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

fn is_foreground(h: HWND) -> bool {
    unsafe { GetForegroundWindow() == h }
}

/// Restore and raise a window, verified by GetForegroundWindow. Windows'
/// foreground lock can refuse (or only flash the taskbar) when we are in the
/// background, so escalate: plain request, then attach to the foreground
/// thread's input queue, then a synthetic Alt tap (skipped while Alt is held).
pub fn activate(raw: isize) -> bool {
    let target = hwnd(raw);
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        let _ = SetForegroundWindow(target);
        if is_foreground(target) {
            return true;
        }

        let fg = GetForegroundWindow();
        let fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(target);
        let _ = SetForegroundWindow(target);
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        if is_foreground(target) {
            return true;
        }

        if !key_down(VK_MENU.0) {
            keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            let _ = SetForegroundWindow(target);
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        is_foreground(target)
    }
}

/// Let whichever process handles a deep link bring its own window forward.
pub fn allow_any_foreground() {
    unsafe {
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
}

pub fn class_name(raw: isize) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd(raw), &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

pub fn window_rect(raw: isize) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd(raw), &mut r).ok()? };
    Some(r)
}

pub fn window_pid(raw: isize) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd(raw), Some(&mut pid)) };
    pid
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn proc_snapshot() -> Vec<ProcRow> {
    tauri::async_runtime::spawn_blocking(|| snapshot(true)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn win_enum() -> Vec<WindowRow> {
    tauri::async_runtime::spawn_blocking(windows).await.unwrap_or_default()
}

#[tauri::command]
pub fn win_activate(hwnd: isize) -> bool {
    let ok = activate(hwnd);
    crate::log::line(format!("activate hwnd={hwnd} ok={ok}"));
    ok
}

#[tauri::command]
pub fn win_foreground() -> isize {
    foreground()
}

/// Process that owns the foreground window (0 when there is none).
#[tauri::command]
pub fn win_foreground_pid() -> u32 {
    match foreground() {
        0 => 0,
        fg => window_pid(fg),
    }
}

#[tauri::command]
pub fn input_modifiers_down() -> bool {
    modifiers_down()
}

#[tauri::command]
pub fn win_allow_foreground() {
    allow_any_foreground()
}
