// Small OS actions: open URLs (allow-listed schemes) and files, reveal in
// Explorer, edit an image, lock, screen snip, clipboard writes, Win+V, HTTP GET.

use std::path::Path;

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const SCHEMES: &[&str] = &[
    "https", "http", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf", "claude", "ms-settings",
    "ms-screenclip", "spotify", "msteams", "zoommtg", "zoomus", "mailto",
];

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn scheme_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty() && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !url.contains(['\r', '\n', '\0'])
}

fn shell_execute(verb: &str, file: &str, params: Option<&str>) -> bool {
    crate::procs::allow_any_foreground();
    let verb_w = wide(verb);
    let file_w = wide(file);
    let params_w = params.map(wide);
    let r = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb_w.as_ptr()),
            PCWSTR(file_w.as_ptr()),
            params_w.as_ref().map(|p| PCWSTR(p.as_ptr())).unwrap_or(PCWSTR::null()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    r.0 as isize > 32
}

pub fn open_url_checked(url: &str) -> bool {
    if !scheme_ok(url) {
        crate::log::line(format!("refused url scheme: {}", url.split(':').next().unwrap_or("")));
        return false;
    }
    let ok = shell_execute("open", url, None);
    crate::log::line(format!("open url {} ok={ok}", url.split('?').next().unwrap_or("")));
    ok
}

#[tauri::command]
pub fn open_url(url: String) -> bool {
    open_url_checked(&url)
}

/// A path under the user's folders, or an allow-listed URL.
#[tauri::command]
pub fn shell_open(target: String) -> bool {
    if target.contains("://") || target.starts_with("ms-settings:") || target.starts_with("ms-screenclip:") || target.starts_with("mailto:") {
        return open_url_checked(&target);
    }
    let p = Path::new(&target);
    if !crate::fsx::allowed(p) || !p.exists() {
        return false;
    }
    shell_execute("open", &target, None)
}

#[tauri::command]
pub fn shell_reveal(path: String) -> bool {
    let p = Path::new(&path);
    if !crate::fsx::allowed(p) || !p.exists() {
        return false;
    }
    shell_execute("open", "explorer.exe", Some(&format!("/select,\"{}\"", path.replace('"', ""))))
}

#[tauri::command]
pub fn shell_edit_image(path: String) -> bool {
    let p = Path::new(&path);
    if !crate::fsx::allowed(p) || !p.is_file() {
        return false;
    }
    shell_execute("open", "mspaint.exe", Some(&format!("\"{}\"", path.replace('"', ""))))
}

#[tauri::command]
pub fn shell_lock() {
    unsafe {
        let _ = LockWorkStation();
    }
}

#[tauri::command]
pub fn shell_snip() {
    let _ = shell_execute("open", "ms-screenclip:", None);
}

// ------------------------------------------------------------------ clipboard

unsafe fn set_clipboard(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { return false };
        let ptr = GlobalLock(mem) as *mut u8;
        if ptr.is_null() {
            let _ = GlobalFree(Some(mem));
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        let _ = GlobalUnlock(mem);
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(Some(HWND::default())).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            let _ = GlobalFree(Some(mem));
            return false;
        }
        let _ = EmptyClipboard();
        let ok = SetClipboardData(format, Some(HANDLE(mem.0))).is_ok();
        let _ = CloseClipboard();
        if !ok {
            let _ = GlobalFree(Some(HGLOBAL(mem.0)));
        }
        ok
    }
}

#[tauri::command]
pub fn clipboard_set_text(text: String) -> bool {
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() * 2 + 2);
    for u in text.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    unsafe { set_clipboard(CF_UNICODETEXT.0 as u32, &bytes) }
}

/// PNG file → CF_DIB (32-bit BGRA, bottom-up) on the clipboard.
#[tauri::command]
pub fn clipboard_copy_image(path: String) -> bool {
    let p = Path::new(&path);
    if !crate::fsx::allowed(p) {
        return false;
    }
    let Ok(file) = std::fs::File::open(p) else { return false };
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let Ok(mut reader) = decoder.read_info() else { return false };
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let Ok(info) = reader.next_frame(&mut buf) else { return false };
    let (w, h) = (info.width as usize, info.height as usize);
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        _ => return false,
    };
    let mut dib = Vec::with_capacity(40 + w * h * 4);
    dib.extend_from_slice(&40u32.to_le_bytes());
    dib.extend_from_slice(&(w as i32).to_le_bytes());
    dib.extend_from_slice(&(h as i32).to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    dib.extend_from_slice(&((w * h * 4) as u32).to_le_bytes());
    dib.extend_from_slice(&[0u8; 16]);
    for y in (0..h).rev() {
        for x in 0..w {
            let i = (y * w + x) * channels;
            let (r, g, b, a) = match channels {
                4 => (buf[i], buf[i + 1], buf[i + 2], buf[i + 3]),
                3 => (buf[i], buf[i + 1], buf[i + 2], 255),
                2 => (buf[i], buf[i], buf[i], buf[i + 1]),
                _ => (buf[i], buf[i], buf[i], 255),
            };
            dib.extend_from_slice(&[b, g, r, a]);
        }
    }
    unsafe { set_clipboard(CF_DIB.0 as u32, &dib) }
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Opens Windows' clipboard history (Win+V).
#[tauri::command]
pub fn clipboard_history() {
    let v = VIRTUAL_KEY(0x56);
    let inputs = [key(VK_LWIN, false), key(v, false), key(v, true), key(VK_LWIN, true)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

// ------------------------------------------------------------------ http

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// HTTPS GET for calendar feeds and weather; capped and time-limited.
#[tauri::command]
pub async fn http_get(url: String, max_bytes: Option<usize>) -> Option<HttpResponse> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.ok()?;
    let cap = max_bytes.unwrap_or(2 * 1024 * 1024).min(16 * 1024 * 1024);
    let slice = &bytes[..bytes.len().min(cap)];
    Some(HttpResponse { status, body: String::from_utf8_lossy(slice).to_string() })
}

#[allow(dead_code)]
fn _unused() -> PCWSTR {
    w!("")
}

#[cfg(test)]
mod tests {
    use super::scheme_ok;

    #[test]
    fn only_known_schemes_open() {
        assert!(scheme_ok("https://example.com"));
        assert!(scheme_ok("cursor://anthropic.claude-code/open?session=abc"));
        assert!(scheme_ok("claude://claude.ai/chat/x"));
        assert!(!scheme_ok("file:///C:/Windows/System32/calc.exe"));
        assert!(!scheme_ok("javascript:alert(1)"));
        assert!(!scheme_ok("https://a\nb"));
        assert!(!scheme_ok("nocolon"));
    }
}
