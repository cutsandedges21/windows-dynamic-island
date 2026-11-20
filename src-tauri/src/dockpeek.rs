//! The taskbar's window previews (from MacDock, Moss 2026-11-18): pointing at an app shows a live
//! picture of each of its windows over the bar. The page lays out the card and says where each picture
//! goes; DWM draws the windows' thumbnails straight into the dock's window there, live (a video keeps
//! playing in it). An empty list takes them all away.

use tauri::WebviewWindow;

/// One window's picture: window `hwnd`, fitted (its own shape kept) and centred in `rect`
/// ([x, y, w, h], CSS px in the dock's window).
#[derive(serde::Deserialize)]
pub struct Peek {
    hwnd: isize,
    rect: [f64; 4],
}

/// `w` x `h` (the source's size) fitted inside `r` (x, y, w, h), its shape kept, centred: left, top, right, bottom.
pub fn fit(r: (f64, f64, f64, f64), w: f64, h: f64) -> (i32, i32, i32, i32) {
    let k = if w > 0.0 && h > 0.0 { (r.2 / w).min(r.3 / h) } else { 1.0 };
    let (fw, fh) = if w > 0.0 && h > 0.0 { (w * k, h * k) } else { (r.2, r.3) };
    let x = r.0 + (r.2 - fw) / 2.0;
    let y = r.1 + (r.3 - fh) / 2.0;
    (x.round() as i32, y.round() as i32, (x + fw).round() as i32, (y + fh).round() as i32)
}

#[tauri::command]
pub fn dock_peek(window: WebviewWindow, items: Vec<Peek>) {
    if window.label() != crate::dock::LABEL {
        return;
    }
    imp::show(&window, items);
}

/// Pointing at a window's picture shows that window itself where it is, the others faded to glass, as
/// Windows' own taskbar does (Justin, 11-20); `None` puts them all back.
#[tauri::command]
pub fn dock_live_peek(window: WebviewWindow, hwnd: Option<isize>) -> bool {
    if window.label() != crate::dock::LABEL {
        return false;
    }
    imp::live(window.hwnd().ok().map(|h| h.0 as isize), hwnd)
}

#[cfg(windows)]
mod imp {
    use super::{fit, Peek};
    use std::sync::Mutex;
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmQueryThumbnailSourceSize, DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties, DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE};
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    /// The thumbnails drawn now.
    static THUMBS: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    pub fn show(win: &WebviewWindow, items: Vec<Peek>) {
        let Ok(dest) = win.hwnd() else { return };
        let scale = win.scale_factor().unwrap_or(1.0);
        let mut thumbs = THUMBS.lock().unwrap();
        for t in thumbs.drain(..) {
            unsafe {
                let _ = DwmUnregisterThumbnail(t);
            }
        }
        for p in items.into_iter().take(8) {
            let src = HWND(p.hwnd as *mut _);
            if !unsafe { IsWindow(Some(src)) }.as_bool() || !p.rect.iter().all(|n| n.is_finite()) {
                continue;
            }
            let Ok(t) = (unsafe { DwmRegisterThumbnail(HWND(dest.0), src) }) else { continue };
            let size = unsafe { DwmQueryThumbnailSourceSize(t) }.unwrap_or_default();
            let r = (p.rect[0] * scale, p.rect[1] * scale, p.rect[2] * scale, p.rect[3] * scale);
            let (left, top, right, bottom) = fit(r, size.cx as f64, size.cy as f64);
            let props = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: RECT { left, top, right, bottom },
                opacity: 255,
                fVisible: true.into(),
                fSourceClientAreaOnly: false.into(),
                ..Default::default()
            };
            unsafe {
                let _ = DwmUpdateThumbnailProperties(t, &props);
            }
            thumbs.push(t);
        }
    }

    /// dwmapi's DwmpActivateLivePreview (ordinal 113, not exported by name; what Explorer's taskbar
    /// calls): on or off, the window shown, the window kept over the glass (the dock), 1 = a taskbar
    /// window's peek, and a last argument Windows 10 added (0).
    type LivePreviewFn = unsafe extern "system" fn(u32, isize, isize, u32, usize) -> i32;
    type Farproc = unsafe extern "system" fn() -> isize;

    fn live_preview() -> Option<LivePreviewFn> {
        use std::sync::OnceLock;
        use windows::core::{PCSTR, PCWSTR};
        use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
        static F: OnceLock<Option<usize>> = OnceLock::new();
        let p = *F.get_or_init(|| unsafe {
            let name: Vec<u16> = "dwmapi.dll\0".encode_utf16().collect();
            let lib = LoadLibraryExW(PCWSTR(name.as_ptr()), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            GetProcAddress(lib, PCSTR(113usize as *const u8)).map(|f| f as usize)
        });
        p.map(|p| unsafe { std::mem::transmute::<Farproc, LivePreviewFn>(std::mem::transmute::<usize, Farproc>(p)) })
    }

    /// The peek's window now (0: none), so a second "off" does nothing.
    static LIVE: Mutex<isize> = Mutex::new(0);

    pub fn live(dock: Option<isize>, hwnd: Option<isize>) -> bool {
        let Some(f) = live_preview() else { return false };
        let mut on = LIVE.lock().unwrap();
        match hwnd {
            Some(h) if h != 0 && unsafe { IsWindow(Some(HWND(h as *mut _))) }.as_bool() => {
                if *on == h {
                    return true;
                }
                *on = h;
                unsafe { f(1, h, dock.unwrap_or(0), 1, 0) >= 0 }
            }
            _ => {
                if *on == 0 {
                    return true;
                }
                *on = 0;
                unsafe { f(0, 0, 0, 1, 0) >= 0 }
            }
        }
    }

    #[cfg(test)]
    mod live_tests {
        /// Peeks the window whose title has PEEK in it for 2 s (cargo test --lib live_peek_now -- --ignored --nocapture).
        #[test]
        #[ignore]
        fn live_peek_now() {
            let want = std::env::var("PEEK").unwrap_or_default().to_lowercase();
            let w = crate::workspaces::layout::list_now().into_iter().find(|w| w.title.to_lowercase().contains(&want)).expect("no such window");
            println!("peek {} ({})", w.title, w.hwnd);
            println!("on: {}", super::live(None, Some(w.hwnd as isize)));
            std::thread::sleep(std::time::Duration::from_millis(2500));
            println!("off: {}", super::live(None, None));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Peek;
    pub fn show(_win: &tauri::WebviewWindow, _items: Vec<Peek>) {}
    pub fn live(_dock: Option<isize>, _hwnd: Option<isize>) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::fit;

    #[test]
    fn a_wide_window_fills_the_width_centred_down() {
        assert_eq!(fit((0.0, 0.0, 200.0, 120.0), 1600.0, 900.0), (0, 4, 200, 116));
    }

    #[test]
    fn a_tall_window_fills_the_height_centred_across() {
        assert_eq!(fit((10.0, 10.0, 200.0, 100.0), 500.0, 1000.0), (85, 10, 135, 110));
    }

    #[test]
    fn no_size_fills_the_rect() {
        assert_eq!(fit((0.0, 0.0, 50.0, 40.0), 0.0, 0.0), (0, 0, 50, 40));
    }
}
