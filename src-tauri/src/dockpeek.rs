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

/// Pointing at a window's picture brings that window in front, where it is, until the pointer leaves
/// (Justin, 11-20); `None` puts it back, unless `keep` (it was clicked, so it stays in front).
#[tauri::command]
pub fn dock_live_peek(window: WebviewWindow, hwnd: Option<isize>, keep: Option<bool>) -> bool {
    if window.label() != crate::dock::LABEL {
        return false;
    }
    imp::live(hwnd, keep == Some(true))
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

    /// The window brought forward: whether it was minimized, and the windows that were over it (nearest
    /// first; shown, not always-on-top), to put it back under when the pointer leaves its picture.
    struct Lifted {
        hwnd: isize,
        over: Vec<isize>,
        minimized: bool,
    }

    static LIVE: Mutex<Option<Lifted>> = Mutex::new(None);

    fn above(h: HWND) -> Vec<isize> {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GetWindowLongPtrW, IsWindowVisible, GWL_EXSTYLE, GW_HWNDPREV, WS_EX_TOPMOST};
        let mut out = Vec::new();
        let mut w = unsafe { GetWindow(h, GW_HWNDPREV) }.ok();
        let mut steps = 0;
        while let Some(x) = w {
            steps += 1;
            if steps > 2000 || out.len() >= 16 {
                break;
            }
            let ex = unsafe { GetWindowLongPtrW(x, GWL_EXSTYLE) } as u32;
            if ex & WS_EX_TOPMOST.0 == 0 && unsafe { IsWindowVisible(x) }.as_bool() {
                out.push(x.0 as isize);
            }
            w = unsafe { GetWindow(x, GW_HWNDPREV) }.ok();
        }
        out
    }

    /// Back where it was: under the window that was over it, or minimized again; `keep` (it was clicked)
    /// leaves it in front.
    fn put_back(l: Lifted, keep: bool) {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWMINNOACTIVE};
        let h = HWND(l.hwnd as *mut _);
        if keep || !unsafe { IsWindow(Some(h)) }.as_bool() {
            return;
        }
        if l.minimized {
            unsafe {
                let _ = ShowWindow(h, SW_SHOWMINNOACTIVE);
            }
            return;
        }
        if let Some(a) = l.over.iter().map(|&x| HWND(x as *mut _)).find(|&x| unsafe { IsWindow(Some(x)) }.as_bool()) {
            unsafe {
                let _ = SetWindowPos(h, Some(a), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    /// Brings `hwnd` in front of the other windows, where it is, without making it the active one (the
    /// others stay as they are, Justin 11-20: Windows' own peek hid them all); `None` puts it back.
    pub fn live(hwnd: Option<isize>, keep: bool) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
        let mut on = LIVE.lock().unwrap();
        let want = hwnd.filter(|&h| h != 0 && unsafe { IsWindow(Some(HWND(h as *mut _))) }.as_bool());
        if want.is_some() && on.as_ref().map(|l| l.hwnd) == want {
            return true;
        }
        if let Some(l) = on.take() {
            put_back(l, keep);
        }
        let Some(h) = want else { return true };
        let w = HWND(h as *mut _);
        let minimized = unsafe { IsIconic(w) }.as_bool();
        let over = if minimized { Vec::new() } else { above(w) };
        unsafe {
            if minimized {
                let _ = ShowWindow(w, SW_SHOWNOACTIVATE);
            }
            // HWND_TOP alone does nothing from a process that isn't in the foreground: always on top for a
            // moment, then not, leaves it at the top of the others.
            let _ = SetWindowPos(w, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            let _ = SetWindowPos(w, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        *on = Some(Lifted { hwnd: h, over, minimized });
        true
    }

    #[cfg(test)]
    mod live_tests {
        /// Brings the window whose title has PEEK in it forward for 2.5 s (cargo test --lib live_peek_now -- --ignored --nocapture).
        #[test]
        #[ignore]
        fn live_peek_now() {
            let want = std::env::var("PEEK").unwrap_or_default().to_lowercase();
            let w = crate::workspaces::layout::list_now().into_iter().find(|w| w.title.to_lowercase().contains(&want)).expect("no such window");
            println!("peek {} ({}) minimized {}", w.title, w.hwnd, unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(windows::Win32::Foundation::HWND(w.hwnd as *mut _)) }.as_bool());
            println!("on: {}", super::live(Some(w.hwnd as isize), false));
            std::thread::sleep(std::time::Duration::from_millis(2500));
            println!("off: {}", super::live(None, false));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Peek;
    pub fn show(_win: &tauri::WebviewWindow, _items: Vec<Peek>) {}
    pub fn live(_hwnd: Option<isize>, _keep: bool) -> bool {
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
