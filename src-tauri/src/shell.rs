// Small OS actions: open URLs (allow-listed schemes) and files, reveal in
// Explorer, edit an image, lock, screen snip, Snipping Tool's capture keys, clipboard writes, Win+V,
// HTTP GET.

use std::path::Path;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_SHIFT,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const SCHEMES: &[&str] = &[
    "https", "http", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf", "claude", "ms-settings",
    "ms-screenclip", "ms-phone", "spotify", "msteams", "zoommtg", "zoomus", "mailto",
];

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn scheme_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty() && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !url.contains(['\r', '\n', '\0'])
}

pub(crate) fn shell_execute(verb: &str, file: &str, params: Option<&str>) -> bool {
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

/// Puts each (format, bytes) on the clipboard together, replacing what was there.
unsafe fn set_clipboard_all(items: &[(u32, &[u8])]) -> bool {
    unsafe {
        let mut mems = Vec::with_capacity(items.len());
        for (format, bytes) in items {
            let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { break };
            let ptr = GlobalLock(mem) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(Some(mem));
                break;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(mem);
            mems.push((*format, mem));
        }
        let free = |mems: &[(u32, HGLOBAL)]| {
            for (_, m) in mems {
                let _ = GlobalFree(Some(*m));
            }
        };
        if mems.len() != items.len() {
            free(&mems);
            return false;
        }
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(Some(HWND::default())).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            free(&mems);
            return false;
        }
        let _ = EmptyClipboard();
        let mut ok = true;
        for (format, mem) in &mems {
            // Once set, the clipboard owns the memory; only a refused one is freed here.
            if SetClipboardData(*format, Some(HANDLE(mem.0))).is_err() {
                ok = false;
                let _ = GlobalFree(Some(*mem));
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

unsafe fn set_clipboard(format: u32, bytes: &[u8]) -> bool {
    unsafe { set_clipboard_all(&[(format, bytes)]) }
}

#[tauri::command]
pub fn clipboard_set_text(text: String) -> bool {
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() * 2 + 2);
    for u in text.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    unsafe { set_clipboard(CF_UNICODETEXT.0 as u32, &bytes) }
}

/// RGBA pixels (top row first) → a CF_DIB: BITMAPINFOHEADER, 32-bit BGRA, BI_RGB, bottom-up.
pub(crate) fn rgba_to_dib(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
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
        for px in rgba[y * w * 4..(y + 1) * w * 4].chunks_exact(4) {
            dib.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    dib
}

/// A PNG file's pixels as RGBA (width, height, pixels).
fn png_rgba(bytes: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        _ => return None,
    };
    let mut out = Vec::with_capacity(w * h * 4);
    for px in buf[..w * h * channels].chunks_exact(channels) {
        out.extend_from_slice(&match channels {
            4 => [px[0], px[1], px[2], px[3]],
            3 => [px[0], px[1], px[2], 255],
            2 => [px[0], px[0], px[0], px[1]],
            _ => [px[0], px[0], px[0], 255],
        });
    }
    Some((w, h, out))
}

/// Any picture Windows can read (JPEG, HEIC with its extension, GIF, BMP, TIFF, WebP…) as RGBA,
/// turned upright the way the phone took it.
fn wic_rgba(bytes: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode, ExifOrientationMode};
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    let run = || -> windows::core::Result<(usize, usize, Vec<u8>)> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let (w, h) = (decoder.OrientedPixelWidth()? as usize, decoder.OrientedPixelHeight()? as usize);
        let pixels = decoder
            .GetPixelDataTransformedAsync(
                BitmapPixelFormat::Rgba8,
                BitmapAlphaMode::Straight,
                &BitmapTransform::new()?,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::ColorManageToSRgb,
            )?
            .get()?
            .DetachPixelData()?;
        Ok((w, h, pixels.to_vec()))
    };
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    let (w, h, px) = run().ok()?;
    (px.len() == w * h * 4 && w > 0 && h > 0).then_some((w, h, px))
}

/// RGBA → PNG bytes, for the clipboard's "PNG" format (apps that read it keep transparency).
fn rgba_to_png(w: usize, h: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// A picture file → the clipboard as CF_DIB and "PNG", ready to paste into Discord, Word, Paint…
/// PNGs are read here; other pictures (a phone's JPEG or HEIC) by Windows' own decoders.
pub fn copy_image_file(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else { return false };
    let is_png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    let Some((w, h, rgba)) = (if is_png { png_rgba(&bytes) } else { wic_rgba(&bytes) }) else { return false };
    let dib = rgba_to_dib(w, h, &rgba);
    let png = if is_png { Some(bytes) } else { rgba_to_png(w, h, &rgba) };
    let png_format = unsafe { RegisterClipboardFormatW(windows::core::w!("PNG")) };
    match png {
        Some(png) if png_format != 0 => unsafe { set_clipboard_all(&[(CF_DIB.0 as u32, &dib), (png_format, &png)]) },
        _ => unsafe { set_clipboard(CF_DIB.0 as u32, &dib) },
    }
}

/// Picture file → the clipboard (CF_DIB, plus "PNG").
#[tauri::command]
pub fn clipboard_copy_image(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && copy_image_file(p)
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

/// Opens Windows 11's sound output picker in Quick Settings (Win+Ctrl+V), like the music
/// player's output button on an iPhone.
#[tauri::command]
pub fn sound_output() {
    let v = VIRTUAL_KEY(0x56);
    let inputs = [key(VK_LWIN, false), key(VK_CONTROL, false), key(v, false), key(v, true), key(VK_CONTROL, true), key(VK_LWIN, true)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// The letter that goes with Win+Shift for Snipping Tool's overlay: S drags out a screenshot, R a screen
/// recording (Microsoft's own shortcuts, "Use Snipping Tool to capture screenshots"). Its
/// `ms-screenclip://capture/image|video` links answer only packaged (MSIX) apps, which Island is not,
/// and the bare `ms-screenclip:` that shell_snip opens is retired.
fn capture_key(video: bool) -> VIRTUAL_KEY {
    VIRTUAL_KEY(if video { 0x52 } else { 0x53 })
}

/// Opens Snipping Tool's overlay to drag an area: a screenshot, or with `video` a screen recording
/// (the desktop too). True when Windows took all six key presses.
#[tauri::command]
pub fn screen_capture(video: bool) -> bool {
    let k = capture_key(video);
    let inputs = [key(VK_LWIN, false), key(VK_SHIFT, false), key(k, false), key(k, true), key(VK_SHIFT, true), key(VK_LWIN, true)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    crate::log::line(format!("screen capture video={video} sent={sent}"));
    sent as usize == inputs.len()
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
    let cap = max_bytes.unwrap_or(2 * 1024 * 1024).min(16 * 1024 * 1024);
    let (status, body) = crate::web::get_capped(&url, cap).await?;
    Some(HttpResponse { status, body: String::from_utf8_lossy(&body).to_string() })
}

#[cfg(test)]
mod tests {
    use super::{capture_key, rgba_to_dib, scheme_ok};

    #[test]
    fn a_dib_is_bgra_and_bottom_up() {
        // 1×2: a red pixel on top, a half-clear blue one under it.
        let dib = rgba_to_dib(1, 2, &[255, 0, 0, 255, 0, 0, 255, 128]);
        assert_eq!(dib.len(), 40 + 8);
        assert_eq!(&dib[0..4], &40u32.to_le_bytes());
        assert_eq!(&dib[4..8], &1i32.to_le_bytes());
        assert_eq!(&dib[8..12], &2i32.to_le_bytes());
        assert_eq!(&dib[14..16], &32u16.to_le_bytes());
        assert_eq!(&dib[16..20], &0u32.to_le_bytes());
        assert_eq!(&dib[20..24], &8u32.to_le_bytes());
        assert_eq!(&dib[40..44], &[255, 0, 0, 128], "the bottom row comes first, as BGRA");
        assert_eq!(&dib[44..48], &[0, 0, 255, 255]);
    }

    #[test]
    fn only_known_schemes_open() {
        assert!(scheme_ok("https://example.com"));
        assert!(scheme_ok("cursor://anthropic.claude-code/open?session=abc"));
        assert!(scheme_ok("claude://claude.ai/chat/x"));
        assert!(scheme_ok("ms-phone://"));
        assert!(!scheme_ok("file:///C:/Windows/System32/calc.exe"));
        assert!(!scheme_ok("javascript:alert(1)"));
        assert!(!scheme_ok("https://a\nb"));
        assert!(!scheme_ok("nocolon"));
    }

    #[test]
    fn a_screenshot_is_win_shift_s_and_a_recording_win_shift_r() {
        assert_eq!(capture_key(false).0, b'S' as u16);
        assert_eq!(capture_key(true).0, b'R' as u16);
    }
}
