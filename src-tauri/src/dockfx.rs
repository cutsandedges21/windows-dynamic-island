// The taskbar's own window animations (src/core/dock.ts): a window flies out of its icon on the
// taskbar when it comes back from minimized, and into it when it is minimized or closed from there.
//
// Windows only asks Explorer (the "taskman" window) where an app's icon is, and won't let another
// app take that role, so its own minimize animation always heads for Windows' taskbar. Instead, a
// DWM thumbnail (a live image of the window) is drawn in a click-through overlay and moved between
// the window and the icon, while Windows' own animation is off for the moment the window changes
// state. Coming back, the window is restored at the edge of the screen and pushed off it first: a
// window shows its stretched title bar for one frame after a restore without animation, and that
// frame must not be seen; it moves into place, under its image, once it has drawn itself.
//
// Everything is in physical pixels; Island is per-monitor DPI aware.

use tauri::{AppHandle, Manager};

/// How long a flight takes, ms.
const FLY_MS: f64 = 320.0;
/// The image's opacity at the icon (0..255).
const AT_ICON: u8 = 120;

/// The icon's rect on screen: `css` (x, y, w, h in CSS px) inside taskbar `dock`'s window (the main
/// screen's when not told).
fn icon_rect(app: &AppHandle, css: [f64; 4], dock: Option<&str>) -> Option<(i32, i32, i32, i32)> {
    let label = dock.filter(|d| crate::dock::is_dock(d)).unwrap_or(crate::dock::LABEL);
    let win = app.get_webview_window(label)?;
    let at = win.inner_position().ok()?;
    let s = win.scale_factor().ok()?;
    let [x, y, w, h] = css;
    if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 {
        return None;
    }
    let l = at.x + (x * s).round() as i32;
    let t = at.y + (y * s).round() as i32;
    Some((l, t, l + (w * s).round() as i32, t + (h * s).round() as i32))
}

/// `r` shrunk to fit in `icon` with its shape kept, centred on it.
pub fn fit_in(r: (i32, i32, i32, i32), icon: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
    let (w, h) = ((r.2 - r.0).max(1) as f64, (r.3 - r.1).max(1) as f64);
    let size = ((icon.2 - icon.0).min(icon.3 - icon.1)).max(1) as f64;
    let s = size / w.max(h);
    let (cx, cy) = ((icon.0 + icon.2) as f64 / 2.0, (icon.1 + icon.3) as f64 / 2.0);
    let (hw, hh) = (w * s / 2.0, h * s / 2.0);
    ((cx - hw).round() as i32, (cy - hh).round() as i32, (cx + hw).round() as i32, (cy + hh).round() as i32)
}

/// Eased (cubic out) point `t` (0..1) of the way from `a` to `b`.
pub fn between(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32), t: f64) -> (i32, i32, i32, i32) {
    let e = 1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3);
    let f = |p: i32, q: i32| (p as f64 + (q - p) as f64 * e).round() as i32;
    (f(a.0, b.0), f(a.1, b.1), f(a.2, b.2), f(a.3, b.3))
}

/// The window comes back out of its icon (or just comes forward if it isn't minimized).
#[tauri::command]
pub fn dock_raise(app: AppHandle, hwnd: isize, icon: [f64; 4], dock: Option<String>) -> bool {
    imp::raise(icon_rect(&app, icon, dock.as_deref()), hwnd)
}

/// The window goes into its icon.
#[tauri::command]
pub fn dock_minimize(app: AppHandle, hwnd: isize, icon: [f64; 4], dock: Option<String>) {
    imp::minimize(icon_rect(&app, icon, dock.as_deref()), hwnd);
}

/// The app's windows close, the first one into its icon.
#[tauri::command]
pub fn dock_close(app: AppHandle, hwnds: Vec<isize>, icon: [f64; 4], dock: Option<String>) {
    imp::close(icon_rect(&app, icon, dock.as_deref()), hwnds);
}

#[cfg(windows)]
mod imp {
    use super::{between, fit_in, AT_ICON, FLY_MS};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};
    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{
        DwmFlush, DwmGetWindowAttribute, DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties, DWMWA_EXTENDED_FRAME_BOUNDS, DWM_THUMBNAIL_PROPERTIES,
        DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION, DWM_TNP_VISIBLE,
    };
    use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetSystemMetrics, GetWindowPlacement, GetWindowRect, IsIconic, IsWindow, IsWindowVisible, PostMessageW, RegisterClassW, SetLayeredWindowAttributes,
        SetWindowPlacement, SetWindowPos, ShowWindow, SystemParametersInfoW, ANIMATIONINFO, LWA_COLORKEY, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SPI_GETANIMATION, SPI_SETANIMATION, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_MINIMIZE, SW_RESTORE, SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS, WM_CLOSE, WNDCLASSW, WPF_RESTORETOMAXIMIZED, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    type Rect = (i32, i32, i32, i32);

    /// One flight at a time; a click during one does its plain action.
    static BUSY: AtomicBool = AtomicBool::new(false);

    fn h(raw: isize) -> HWND {
        HWND(raw as *mut _)
    }

    fn rect(r: RECT) -> Rect {
        (r.left, r.top, r.right, r.bottom)
    }

    fn window_rect(w: HWND) -> Option<Rect> {
        let mut r = RECT::default();
        unsafe { GetWindowRect(w, &mut r).ok()? };
        Some(rect(r))
    }

    /// The part of the window you see (its rect less the invisible resize borders): what its
    /// thumbnail shows.
    fn visible_rect(w: HWND) -> Option<Rect> {
        let mut r = RECT::default();
        unsafe { DwmGetWindowAttribute(w, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).ok()? };
        Some(rect(r))
    }

    /// Windows' "Animate windows when minimizing and maximizing", off while it lives.
    struct NoAnimation(bool);

    impl NoAnimation {
        fn new() -> Self {
            let mut a = ANIMATIONINFO { cbSize: std::mem::size_of::<ANIMATIONINFO>() as u32, iMinAnimate: 0 };
            let on = unsafe { SystemParametersInfoW(SPI_GETANIMATION, a.cbSize, Some(&mut a as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok() } && a.iMinAnimate != 0;
            if on {
                set_animation(false);
            }
            NoAnimation(on)
        }
    }

    impl Drop for NoAnimation {
        fn drop(&mut self) {
            if self.0 {
                set_animation(true);
            }
        }
    }

    fn set_animation(on: bool) {
        let mut a = ANIMATIONINFO { cbSize: std::mem::size_of::<ANIMATIONINFO>() as u32, iMinAnimate: on as i32 };
        // Not saved (no SPIF_UPDATEINIFILE): only this session's value, and put back at once.
        unsafe {
            let _ = SystemParametersInfoW(SPI_SETANIMATION, a.cbSize, Some(&mut a as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> windows::Win32::Foundation::LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// A click-through, invisible window over every screen, and a thumbnail of `src` in it.
    struct Stage {
        win: HWND,
        thumb: isize,
        origin: (i32, i32),
    }

    impl Stage {
        fn new(src: HWND) -> Option<Self> {
            static CLASS: OnceLock<bool> = OnceLock::new();
            unsafe {
                let instance = GetModuleHandleW(None).ok()?;
                let ok = *CLASS.get_or_init(|| {
                    let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: w!("IslandDockFx"), hbrBackground: CreateSolidBrush(COLORREF(0)), ..Default::default() };
                    RegisterClassW(&wc) != 0
                });
                if !ok {
                    return None;
                }
                let (x, y) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
                let (cx, cy) = (GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
                let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                let win = CreateWindowExW(ex, w!("IslandDockFx"), w!("Island animation"), WS_POPUP, x, y, cx, cy, None, None, Some(instance.into()), None).ok()?;
                // Black is see-through: only the thumbnail shows.
                let _ = SetLayeredWindowAttributes(win, COLORREF(0), 0, LWA_COLORKEY);
                let Ok(thumb) = DwmRegisterThumbnail(win, src) else {
                    let _ = DestroyWindow(win);
                    return None;
                };
                let _ = ShowWindow(win, SW_SHOWNOACTIVATE);
                Some(Stage { win, thumb, origin: (x, y) })
            }
        }

        /// Draws the image at `r` (screen px) with `opacity`, and waits for the screen to show it.
        fn put(&self, r: Rect, opacity: u8) {
            let (ox, oy) = self.origin;
            let p = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_OPACITY | DWM_TNP_VISIBLE,
                rcDestination: RECT { left: r.0 - ox, top: r.1 - oy, right: r.2 - ox, bottom: r.3 - oy },
                opacity,
                fVisible: true.into(),
                ..Default::default()
            };
            unsafe {
                let _ = DwmUpdateThumbnailProperties(self.thumb, &p);
                let _ = DwmFlush();
            }
        }

        fn hide(&self) {
            let p = DWM_THUMBNAIL_PROPERTIES { dwFlags: DWM_TNP_VISIBLE, fVisible: false.into(), ..Default::default() };
            unsafe {
                let _ = DwmUpdateThumbnailProperties(self.thumb, &p);
                let _ = DwmFlush();
            }
        }

        /// Moves the image from `a` to `b`, its opacity from `o0` to `o1`.
        fn fly(&self, a: Rect, b: Rect, o0: u8, o1: u8) {
            let start = Instant::now();
            loop {
                let t = (start.elapsed().as_secs_f64() * 1000.0 / FLY_MS).min(1.0);
                let e = 1.0 - (1.0 - t).powi(3);
                self.put(between(a, b, t), (o0 as f64 + (o1 as f64 - o0 as f64) * e).round() as u8);
                if t >= 1.0 {
                    return;
                }
                // DwmFlush waits for the next frame; this only guards against a DWM that doesn't.
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    impl Drop for Stage {
        fn drop(&mut self) {
            unsafe {
                let _ = DwmUnregisterThumbnail(self.thumb);
                let _ = DestroyWindow(self.win);
            }
        }
    }

    /// Runs `f` on its own thread (it owns the stage window) unless a flight is under way, in
    /// which case `plain` runs instead.
    fn flight(f: impl FnOnce() + Send + 'static, plain: impl FnOnce() + Send + 'static) {
        if BUSY.swap(true, Ordering::SeqCst) {
            plain();
            return;
        }
        std::thread::spawn(move || {
            f();
            BUSY.store(false, Ordering::SeqCst);
        });
    }

    fn work_area_of(r: Rect) -> Option<Rect> {
        unsafe {
            let m = MonitorFromRect(&RECT { left: r.0, top: r.1, right: r.2, bottom: r.3 }, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            GetMonitorInfoW(m, &mut mi).as_bool().then(|| rect(mi.rcWork))
        }
    }

    /// Island may move this window. An app running as administrator (Task Manager) refuses Island's
    /// SetWindowPos, ShowWindow and WM_CLOSE (Windows' UIPI): its window can't fly, minimize or close
    /// from here, only come forward (procs::activate restores it with SwitchToThisWindow).
    fn controllable(w: HWND) -> bool {
        use windows::Win32::Foundation::E_ACCESSDENIED;
        use windows::Win32::UI::WindowsAndMessaging::{SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING};
        let still = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING;
        match unsafe { SetWindowPos(w, None, 0, 0, 0, 0, still) } {
            Err(e) => e.code() != E_ACCESSDENIED,
            Ok(()) => true,
        }
    }

    pub fn raise(icon: Option<Rect>, raw: isize) -> bool {
        let w = h(raw);
        let minimized = unsafe { IsIconic(w).as_bool() };
        let Some(icon) = icon.filter(|_| minimized && controllable(w)) else { return crate::procs::activate(raw) };
        flight(move || restore_from(h(raw), raw, icon), move || {
            crate::procs::activate(raw);
        });
        true
    }

    /// Restore out of `icon`: off-screen first, then the image flies to where the window goes,
    /// and the window moves in under it.
    fn restore_from(w: HWND, raw: isize, icon: Rect) {
        let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
        if unsafe { GetWindowPlacement(w, &mut wp) }.is_err() {
            crate::procs::activate(raw);
            return;
        }
        let normal = rect(wp.rcNormalPosition);
        let maximized = wp.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0;
        let (vx, vy) = unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN)) };
        let (vw, vh) = unsafe { (GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)) };
        let (nw, nh) = (normal.2 - normal.0, normal.3 - normal.1);
        {
            let _quiet = NoAnimation::new();
            // Windows pulls a window back on screen when its place is fully off every screen:
            // restore it with 4 px showing in the corner, then push it off (SetWindowPos doesn't).
            let edge = WINDOWPLACEMENT {
                length: wp.length,
                flags: WINDOWPLACEMENT_FLAGS(0),
                showCmd: SW_SHOWNOACTIVATE.0 as u32,
                ptMinPosition: wp.ptMinPosition,
                ptMaxPosition: wp.ptMaxPosition,
                rcNormalPosition: RECT { left: vx + vw - 4, top: vy + vh - 4, right: vx + vw - 4 + nw, bottom: vy + vh - 4 + nh },
            };
            unsafe {
                let _ = SetWindowPlacement(w, &edge);
                let _ = SetWindowPos(w, None, vx + vw + 200, vy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
        // The invisible resize borders, to land the image on what you see.
        let (Some(wr), Some(vr)) = (window_rect(w), visible_rect(w)) else {
            put_back(w, &wp, normal, maximized);
            crate::procs::activate(raw);
            return;
        };
        let inset = (vr.0 - wr.0, vr.1 - wr.1, vr.2 - wr.2, vr.3 - wr.3);
        // Where it lands: its normal place, or the whole work area when it was maximized (laid out
        // at that size off-screen, so becoming maximized again changes nothing you see).
        let (dest, vis) = match maximized.then(|| work_area_of(normal)).flatten() {
            Some(work) => {
                let d = (work.0 - inset.0, work.1 - inset.1, work.2 - inset.2, work.3 - inset.3);
                unsafe {
                    let _ = SetWindowPos(w, None, vx + vw + 200, vy, d.2 - d.0, d.3 - d.1, SWP_NOZORDER | SWP_NOACTIVATE);
                }
                (d, work)
            }
            None => (normal, (normal.0 + inset.0, normal.1 + inset.1, normal.2 + inset.2, normal.3 + inset.3)),
        };
        // In front already, so its image has the active title bar.
        crate::procs::activate(raw);
        let Some(stage) = Stage::new(w) else {
            put_back(w, &wp, normal, maximized);
            return;
        };
        // A few frames for it to draw itself at its new size.
        for _ in 0..3 {
            unsafe {
                let _ = DwmFlush();
            }
        }
        stage.fly(fit_in(vis, icon), vis, AT_ICON, 255);
        unsafe {
            let _ = SetWindowPos(w, None, dest.0, dest.1, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
        if maximized {
            put_back(w, &wp, normal, true);
        }
        unsafe {
            let _ = DwmFlush();
            let _ = DwmFlush();
        }
        stage.hide();
    }

    /// The window as Windows knew it: its normal place kept, maximized again if it was.
    fn put_back(w: HWND, wp: &WINDOWPLACEMENT, normal: Rect, maximized: bool) {
        let _quiet = NoAnimation::new();
        let back = WINDOWPLACEMENT {
            length: wp.length,
            flags: WINDOWPLACEMENT_FLAGS(0),
            showCmd: if maximized { SW_SHOWMAXIMIZED.0 as u32 } else { SW_SHOWNOACTIVATE.0 as u32 },
            ptMinPosition: wp.ptMinPosition,
            ptMaxPosition: POINT { x: -1, y: -1 },
            rcNormalPosition: RECT { left: normal.0, top: normal.1, right: normal.2, bottom: normal.3 },
        };
        unsafe {
            let _ = SetWindowPlacement(w, &back);
        }
    }

    pub fn minimize(icon: Option<Rect>, raw: isize) {
        let w = h(raw);
        if !controllable(w) {
            return;
        }
        let Some(icon) = icon else {
            unsafe {
                let _ = ShowWindow(w, SW_MINIMIZE);
            }
            return;
        };
        flight(
            move || {
                minimize_into(h(raw), icon);
            },
            move || unsafe {
                let _ = ShowWindow(h(raw), SW_MINIMIZE);
            },
        );
    }

    /// Minimize into `icon`: the image covers the window, the window minimizes under it without
    /// Windows' animation, and the image flies into the icon.
    fn minimize_into(w: HWND, icon: Rect) -> bool {
        let Some(vis) = visible_rect(w) else {
            unsafe {
                let _ = ShowWindow(w, SW_MINIMIZE);
            }
            return false;
        };
        let stage = Stage::new(w);
        if let Some(s) = &stage {
            s.put(vis, 255);
        }
        {
            let _quiet = NoAnimation::new();
            unsafe {
                let _ = ShowWindow(w, SW_MINIMIZE);
            }
        }
        if let Some(s) = &stage {
            s.fly(vis, fit_in(vis, icon), 255, AT_ICON);
            s.hide();
        }
        true
    }

    pub fn close(icon: Option<Rect>, hwnds: Vec<isize>) {
        let first = hwnds.first().copied();
        let ask = move |hwnds: &[isize]| {
            for &raw in hwnds {
                unsafe {
                    let _ = PostMessageW(Some(h(raw)), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
        };
        let (Some(icon), Some(first)) = (icon.filter(|_| first.is_some_and(|f| controllable(h(f)))), first) else {
            ask(&hwnds);
            return;
        };
        let all = hwnds.clone();
        flight(
            move || {
                let w = h(first);
                let animated = unsafe { !IsIconic(w).as_bool() } && minimize_into(w, icon);
                ask(&all);
                if animated {
                    // Still there after a moment (it asks to save first): back where it was, so
                    // its question can be seen. Not one that hid itself (Notion, Discord, Spotify
                    // close to the tray): shown again, it came back as a blank white window
                    // over the whole screen (Moss, 11-19: "glitch when closing windows").
                    std::thread::sleep(Duration::from_millis(700));
                    unsafe {
                        if IsWindow(Some(w)).as_bool() && IsWindowVisible(w).as_bool() && IsIconic(w).as_bool() {
                            let _ = ShowWindow(w, SW_RESTORE);
                        }
                    }
                }
            },
            move || ask(&hwnds),
        );
    }
}

#[cfg(not(windows))]
mod imp {
    type Rect = (i32, i32, i32, i32);
    pub fn raise(_icon: Option<Rect>, _raw: isize) -> bool {
        false
    }
    pub fn minimize(_icon: Option<Rect>, _raw: isize) {}
    pub fn close(_icon: Option<Rect>, _hwnds: Vec<isize>) {}
}

#[cfg(test)]
mod tests {
    use super::{between, fit_in};

    #[test]
    fn a_window_fits_its_icon_with_its_shape_kept() {
        // 1000 x 500 into a 50 px icon at (100, 100): 50 x 25, centred.
        assert_eq!(fit_in((0, 0, 1000, 500), (100, 100, 150, 150)), (100, 113, 150, 138));
        assert_eq!(fit_in((0, 0, 400, 800), (0, 0, 40, 40)), (10, 0, 30, 40));
    }

    #[test]
    fn a_flight_eases_out_from_one_rect_to_the_other() {
        let (a, b) = ((0, 0, 100, 100), (100, 100, 200, 200));
        assert_eq!(between(a, b, 0.0), a);
        assert_eq!(between(a, b, 1.0), b);
        // Cubic out: 87.5 % of the way at half time.
        assert_eq!(between(a, b, 0.5), (88, 88, 188, 188));
    }
}
