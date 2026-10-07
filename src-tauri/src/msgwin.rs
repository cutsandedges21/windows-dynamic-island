// One hidden top-level window that receives the broadcasts Windows only sends to
// windows: clipboard changes, drives arriving or leaving, power-status changes,
// and display / work-area changes (taskbar moved, resolution, scaling).
// Message-only windows miss broadcasts, so this one is a real (never shown) popup.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_BITMAP, CF_DIB, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId, RegisterClassW, TranslateMessage,
    DEV_BROADCAST_HDR, DEV_BROADCAST_VOLUME, MSG, WINDOW_EX_STYLE, WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::overlay::LABEL as ISLAND;

static APP: OnceLock<AppHandle> = OnceLock::new();

const WM_CLIPBOARDUPDATE: u32 = 0x031D;
const WM_DEVICECHANGE: u32 = 0x0219;
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_DISPLAYCHANGE: u32 = 0x007E;
const WM_SETTINGCHANGE: u32 = 0x001A;
const SPI_SETWORKAREA: usize = 0x002F;
const DBT_DEVICEARRIVAL: usize = 0x8000;
const DBT_DEVICEREMOVECOMPLETE: usize = 0x8004;
const DBT_DEVTYP_VOLUME: u32 = 2;
const DRIVE_REMOVABLE: u32 = 2;
const MAX_TEXT: usize = 2000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClipboardEvent {
    seq: u32,
    kind: &'static str,
    text: Option<String>,
    files: Vec<String>,
    excluded: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeviceEvent {
    kind: &'static str,
    action: &'static str,
    drive: String,
    label: String,
    removable: bool,
}

fn wide_str(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

unsafe fn read_text() -> Option<String> {
    unsafe {
        let h = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
        let g = HGLOBAL(h.0);
        let ptr = GlobalLock(g) as *const u16;
        if ptr.is_null() {
            return None;
        }
        let max = (GlobalSize(g) / 2).min(MAX_TEXT * 2);
        let slice = std::slice::from_raw_parts(ptr, max);
        let text = wide_str(slice);
        let _ = GlobalUnlock(g);
        Some(text.chars().take(MAX_TEXT).collect())
    }
}

unsafe fn read_files() -> Vec<String> {
    unsafe {
        let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) else { return Vec::new() };
        let drop = HDROP(h.0);
        let count = DragQueryFileW(drop, 0xFFFF_FFFF, None);
        let mut out = Vec::new();
        for i in 0..count.min(20) {
            let mut buf = [0u16; 520];
            let n = DragQueryFileW(drop, i, Some(&mut buf));
            out.push(String::from_utf16_lossy(&buf[..n as usize]));
        }
        out
    }
}

/// Password managers mark secrets with these formats; we never show those.
unsafe fn excluded() -> bool {
    unsafe {
        let skip = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        if skip != 0 && IsClipboardFormatAvailable(skip).is_ok() {
            return true;
        }
        let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
        if history != 0 && IsClipboardFormatAvailable(history).is_ok() {
            if let Ok(h) = GetClipboardData(history) {
                let g = HGLOBAL(h.0);
                let ptr = GlobalLock(g) as *const u32;
                let deny = !ptr.is_null() && *ptr == 0;
                let _ = GlobalUnlock(g);
                if deny {
                    return true;
                }
            }
        }
        false
    }
}

fn on_clipboard(hwnd: HWND) {
    let Some(app) = APP.get() else { return };
    unsafe {
        // Our own writes (Copy buttons) are not news.
        if let Ok(owner) = GetClipboardOwner() {
            let mut pid = 0u32;
            GetWindowThreadProcessId(owner, Some(&mut pid));
            if pid == std::process::id() {
                return;
            }
        }
        let mut opened = false;
        for _ in 0..6 {
            if OpenClipboard(Some(hwnd)).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            return;
        }
        let ex = excluded();
        let (kind, text, files) = if ex {
            ("other", None, Vec::new())
        } else if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
            ("files", None, read_files())
        } else if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() {
            ("text", read_text(), Vec::new())
        } else if IsClipboardFormatAvailable(CF_DIB.0 as u32).is_ok() || IsClipboardFormatAvailable(CF_BITMAP.0 as u32).is_ok() {
            ("image", None, Vec::new())
        } else {
            ("other", None, Vec::new())
        };
        let _ = CloseClipboard();
        let _ = app.emit_to(ISLAND, "clipboard", ClipboardEvent { seq: GetClipboardSequenceNumber(), kind, text, files, excluded: ex });
    }
}

fn on_device(wparam: usize, lparam: isize) {
    let Some(app) = APP.get() else { return };
    if wparam != DBT_DEVICEARRIVAL && wparam != DBT_DEVICEREMOVECOMPLETE || lparam == 0 {
        return;
    }
    unsafe {
        let hdr = &*(lparam as *const DEV_BROADCAST_HDR);
        if hdr.dbch_devicetype.0 != DBT_DEVTYP_VOLUME {
            return;
        }
        let vol = &*(lparam as *const DEV_BROADCAST_VOLUME);
        for i in 0..26u32 {
            if vol.dbcv_unitmask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
            let mut name = [0u16; 261];
            let arrived = wparam == DBT_DEVICEARRIVAL;
            let label = if arrived && GetVolumeInformationW(PCWSTR(root.as_ptr()), Some(&mut name), None, None, None, None).is_ok() {
                wide_str(&name)
            } else {
                String::new()
            };
            let removable = arrived && GetDriveTypeW(PCWSTR(root.as_ptr())) == DRIVE_REMOVABLE;
            let _ = app.emit_to(
                ISLAND,
                "device",
                DeviceEvent { kind: "volume", action: if arrived { "arrived" } else { "removed" }, drive: format!("{letter}:"), label, removable },
            );
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => on_clipboard(hwnd),
        WM_DEVICECHANGE => on_device(wparam.0, lparam.0),
        WM_POWERBROADCAST => {
            if let Some(app) = APP.get() {
                crate::system::emit_power(app);
            }
        }
        WM_DISPLAYCHANGE => {
            if let Some(app) = APP.get() {
                let _ = app.emit_to(ISLAND, "displays-changed", ());
            }
        }
        WM_SETTINGCHANGE if wparam.0 == SPI_SETWORKAREA => {
            if let Some(app) = APP.get() {
                let _ = app.emit_to(ISLAND, "displays-changed", ());
            }
        }
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        let instance = HINSTANCE(module.0);
        let class = w!("IslandMessageWindow");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance, lpszClassName: class, ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            crate::log::line("message window: RegisterClassW failed");
            return;
        }
        let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0), class, w!("Island messages"), WS_POPUP, 0, 0, 0, 0, None, None, Some(instance), None) else {
            crate::log::line("message window: CreateWindowExW failed");
            return;
        };
        if AddClipboardFormatListener(hwnd).is_err() {
            crate::log::line("clipboard listener unavailable");
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[allow(dead_code)]
fn _handle(h: HANDLE) -> HANDLE {
    h
}
