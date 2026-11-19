// The notification area's icons (the "system tray": Island's own, OneDrive, Discord…) on Island's
// taskbar, so they can be reached while Windows' taskbar is hidden (Moss, 11-18).
//
// Apps put their icons there with Shell_NotifyIcon, which hands them to the first top-level window of
// class "Shell_TrayWnd" (normally Explorer's taskbar) as WM_COPYDATA. While Island's taskbar shows,
// a hidden window of that class sits just above Explorer's, reads what each app sends, and passes
// EVERY message on to Explorer's own taskbar unchanged, returning its answer: Explorer keeps its
// tray, appbars and everything else it is asked, exactly as without Island. This is how other
// taskbars (RetroBar, Cairo: ManagedShell's TrayService) read the tray. On start it asks running apps
// to send their icons again (the "TaskbarCreated" broadcast, as when Explorer restarts).
//
// A click on an icon goes to its app the way Explorer sends it: the app's own callback message.

use serde::Serialize;
use tauri::AppHandle;

/// One icon, for the taskbar.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TrayIcon {
    pub key: String,
    pub tip: String,
    /// PNG data address; None while the app gave none.
    pub icon: Option<String>,
}

/// The icons now (the app's order of adding them), hidden ones left out.
#[tauri::command]
pub fn tray_icons() -> Vec<TrayIcon> {
    imp::icons()
}

/// Island's taskbar started or stopped reading the tray.
#[tauri::command]
pub fn tray_host(app: AppHandle, on: bool) {
    if on {
        start(app);
    } else {
        stop();
    }
}

/// A click on icon `key`: `button` "left", "right" or "double"; (x, y) the icon's middle, physical px.
#[tauri::command]
pub fn tray_click(key: String, button: String, x: i32, y: i32) -> bool {
    imp::click(&key, &button, x, y)
}

pub fn start(app: AppHandle) {
    imp::start(app);
}

pub fn stop() {
    imp::stop();
}

/// Its key: the app's GUID for the icon when it gave one, else its window and number.
pub fn key_of(hwnd: u32, uid: u32, guid: Option<[u8; 16]>) -> String {
    match guid {
        Some(g) if g.iter().any(|b| *b != 0) => format!("g:{}", g.iter().map(|b| format!("{b:02x}")).collect::<String>()),
        _ => format!("{hwnd:x}:{uid}"),
    }
}

/// What Explorer sends an app's callback for a click, by the version the app asked for:
/// version 4 gets (MAKEWPARAM(x, y), MAKELPARAM(msg, id)), older ones (id, msg).
pub fn callback_params(version: u32, uid: u32, msg: u32, x: i32, y: i32) -> (usize, isize) {
    if version >= 4 {
        let wp = ((x as u32 & 0xffff) | ((y as u32 & 0xffff) << 16)) as usize;
        let lp = ((msg & 0xffff) | ((uid & 0xffff) << 16)) as isize;
        (wp, lp)
    } else {
        (uid as usize, msg as isize)
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowExW, GetIconInfo, GetMessageW,
        GetWindowRect, GetWindowThreadProcessId, IsWindow, PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SendMessageTimeoutW,
        SendNotifyMessageW, SetTimer, SetWindowPos, TranslateMessage, HICON, HWND_BROADCAST, HWND_TOPMOST, ICONINFO, MSG, SMTO_ABORTIFHUNG,
        SWP_NOACTIVATE, WM_CLOSE, WM_COMMAND, WM_COPYDATA, WM_DESTROY, WM_TIMER, WM_USER, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    use super::{callback_params, key_of, TrayIcon};

    const NIM_ADD: u32 = 0;
    const NIM_MODIFY: u32 = 1;
    const NIM_DELETE: u32 = 2;
    const NIM_SETVERSION: u32 = 4;
    const NIF_MESSAGE: u32 = 0x1;
    const NIF_ICON: u32 = 0x2;
    const NIF_TIP: u32 = 0x4;
    const NIF_STATE: u32 = 0x8;
    const NIF_GUID: u32 = 0x20;
    const NIS_HIDDEN: u32 = 0x1;
    const SIGNATURE: u32 = 0x3475_3423;
    const NIN_SELECT: u32 = WM_USER;
    const WM_CONTEXTMENU: u32 = 0x007B;
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_LBUTTONDBLCLK: u32 = 0x0203;
    const WM_RBUTTONDOWN: u32 = 0x0204;
    const WM_RBUTTONUP: u32 = 0x0205;

    /// NOTIFYICONDATA as Shell_NotifyIcon sends it: handles as 32 bits whatever the app's bitness.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Nid32 {
        cb_size: u32,
        hwnd: u32,
        uid: u32,
        flags: u32,
        callback: u32,
        hicon: u32,
        tip: [u16; 128],
        state: u32,
        state_mask: u32,
        info: [u16; 256],
        version: u32,
        info_title: [u16; 64],
        info_flags: u32,
        guid: [u8; 16],
        balloon_icon: u32,
    }

    struct Item {
        key: String,
        hwnd: u32,
        uid: u32,
        callback: u32,
        version: u32,
        tip: String,
        icon: Option<String>,
        hidden: bool,
    }

    static ITEMS: Mutex<Vec<Item>> = Mutex::new(Vec::new());
    /// Tells the taskbar (set by `start`; kept apart so the window's own code needs no app).
    type Notify = Box<dyn Fn(Vec<TrayIcon>) + Send + Sync>;
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    static OURS: AtomicIsize = AtomicIsize::new(0);
    static LAST_SENT: Mutex<Option<Instant>> = Mutex::new(None);

    fn wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    pub fn icons() -> Vec<TrayIcon> {
        ITEMS.lock().unwrap().iter().filter(|i| !i.hidden && i.icon.is_some()).map(|i| TrayIcon { key: i.key.clone(), tip: i.tip.clone(), icon: i.icon.clone() }).collect()
    }

    /// The taskbar hears the icons, at most every 150 ms (an animated icon changes often).
    fn changed() {
        let Some(notify) = NOTIFY.get() else { return };
        {
            let mut last = LAST_SENT.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < Duration::from_millis(150)) {
                // A later change sends the newest list; make sure one comes.
                drop(last);
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(160));
                    if let Some(n) = NOTIFY.get() {
                        n(icons());
                    }
                });
                return;
            }
            *last = Some(Instant::now());
        }
        notify(icons());
    }

    /// An icon handle as a PNG data address (its colours and alpha; the mask where it has no alpha).
    unsafe fn icon_png(h: HICON) -> Option<String> {
        unsafe {
            let mut info = ICONINFO::default();
            GetIconInfo(h, &mut info).ok()?;
            let color = info.hbmColor;
            let mask = info.hbmMask;
            let out = (|| {
                if color.is_invalid() {
                    return None;
                }
                let mut bm = BITMAP::default();
                if GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
                    return None;
                }
                let (w, hgt) = (bm.bmWidth, bm.bmHeight);
                if w <= 0 || hgt <= 0 || w > 256 || hgt > 256 {
                    return None;
                }
                let dc = CreateCompatibleDC(None);
                let mut bi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -hgt,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut px = vec![0u8; (w * hgt * 4) as usize];
                let got = GetDIBits(dc, color, 0, hgt as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
                let mut mbits = vec![0u8; (w * hgt * 4) as usize];
                let gotm = if mask.is_invalid() { 0 } else { GetDIBits(dc, mask, 0, hgt as u32, Some(mbits.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS) };
                let _ = DeleteDC(dc);
                if got == 0 {
                    return None;
                }
                let any_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
                let mut rgba = vec![0u8; px.len()];
                for (i, p) in px.chunks_exact(4).enumerate() {
                    let o = i * 4;
                    rgba[o] = p[2];
                    rgba[o + 1] = p[1];
                    rgba[o + 2] = p[0];
                    rgba[o + 3] = if any_alpha {
                        p[3]
                    } else if gotm != 0 && mbits[o] != 0 {
                        0
                    } else {
                        255
                    };
                }
                crate::shelf::png_data_url(w as u32, hgt as u32, &rgba)
            })();
            if !color.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            if !mask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(mask.0));
            }
            out
        }
    }

    /// What an app sent with Shell_NotifyIcon.
    unsafe fn on_tray(cds: &COPYDATASTRUCT) {
        let len = cds.cbData as usize;
        if cds.lpData.is_null() || len < 8 + 24 {
            return;
        }
        unsafe {
            let base = cds.lpData as *const u8;
            let sig = std::ptr::read_unaligned(base as *const u32);
            if sig != SIGNATURE {
                return;
            }
            let message = std::ptr::read_unaligned(base.add(4) as *const u32);
            // Only as much of the struct as the app sent (older apps send a shorter one).
            let mut nid: Nid32 = std::mem::zeroed();
            let n = (len - 8).min(std::mem::size_of::<Nid32>());
            std::ptr::copy_nonoverlapping(base.add(8), &mut nid as *mut Nid32 as *mut u8, n);
            let guid = (nid.flags & NIF_GUID != 0 && n >= std::mem::offset_of!(Nid32, guid) + 16).then_some(nid.guid);
            let key = key_of(nid.hwnd, nid.uid, guid);
            let mut items = ITEMS.lock().unwrap();
            let at = items.iter().position(|i| i.key == key);
            match message {
                NIM_DELETE => {
                    if let Some(i) = at {
                        items.remove(i);
                    }
                }
                NIM_ADD | NIM_MODIFY | NIM_SETVERSION => {
                    let i = match at {
                        Some(i) => i,
                        None if message == NIM_ADD => {
                            items.push(Item { key: key.clone(), hwnd: nid.hwnd, uid: nid.uid, callback: 0, version: 0, tip: String::new(), icon: None, hidden: false });
                            items.len() - 1
                        }
                        None => return,
                    };
                    let it = &mut items[i];
                    if message == NIM_SETVERSION {
                        it.version = nid.version;
                    } else {
                        it.hwnd = nid.hwnd;
                        it.uid = nid.uid;
                        if nid.flags & NIF_MESSAGE != 0 {
                            it.callback = nid.callback;
                        }
                        if nid.flags & NIF_TIP != 0 {
                            it.tip = wide(&nid.tip);
                        }
                        if nid.flags & NIF_STATE != 0 && nid.state_mask & NIS_HIDDEN != 0 {
                            it.hidden = nid.state & NIS_HIDDEN != 0;
                        }
                        if nid.flags & NIF_ICON != 0 && nid.hicon != 0 {
                            if let Some(png) = icon_png(HICON(nid.hicon as isize as *mut _)) {
                                it.icon = Some(png);
                            }
                        }
                    }
                }
                _ => return,
            }
        }
        changed();
    }

    /// Explorer's own taskbar window (not ours).
    fn explorer_tray() -> Option<HWND> {
        let ours = OURS.load(Ordering::SeqCst);
        let mut after: Option<HWND> = None;
        for _ in 0..8 {
            let h = unsafe { FindWindowExW(None, after, w!("Shell_TrayWnd"), None) }.ok()?;
            if h.0.is_null() {
                return None;
            }
            if h.0 as isize != ours {
                return Some(h);
            }
            after = Some(h);
        }
        None
    }

    /// Passes a message on to Explorer's taskbar and returns its answer.
    fn forward(msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        let to = explorer_tray()?;
        let mut res = 0usize;
        let ok = unsafe { SendMessageTimeoutW(to, msg, wp, lp, SMTO_ABORTIFHUNG, 3000, Some(&mut res)) };
        (ok.0 != 0).then_some(LRESULT(res as isize))
    }

    /// Above Explorer's taskbar, so apps find this window first; over it, never shown.
    fn keep_on_top(hwnd: HWND) {
        unsafe {
            let mut r = Default::default();
            let (x, y, cx, cy) = match explorer_tray() {
                Some(ex) if GetWindowRect(ex, &mut r).is_ok() => {
                    let r: windows::Win32::Foundation::RECT = r;
                    (r.left, r.top, r.right - r.left, r.bottom - r.top)
                }
                _ => (0, 0, 0, 0),
            };
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, cx, cy, SWP_NOACTIVATE);
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_COPYDATA => {
                    let tray = lp.0 != 0 && {
                        let cds = &*(lp.0 as *const COPYDATASTRUCT);
                        if cds.dwData == 1 {
                            on_tray(cds);
                            true
                        } else {
                            false
                        }
                    };
                    // Explorer answers; a tray message it can't take still counts as done.
                    forward(msg, wp, lp).unwrap_or(LRESULT(if tray { 1 } else { 0 }))
                }
                WM_TIMER => {
                    keep_on_top(hwnd);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                WM_CLOSE => {
                    let _ = DestroyWindow(hwnd);
                    LRESULT(0)
                }
                m if m >= WM_USER || m == WM_COMMAND => forward(msg, wp, lp).unwrap_or_else(|| DefWindowProcW(hwnd, msg, wp, lp)),
                _ => DefWindowProcW(hwnd, msg, wp, lp),
            }
        }
    }

    pub fn start(app: AppHandle) {
        let _ = NOTIFY.set(Box::new(move |list| {
            let _ = app.emit_to(crate::dock::LABEL, "tray-icons", list);
        }));
        host();
    }

    /// The hidden window and its message loop, on their own thread (once).
    pub fn host() {
        if OURS.load(Ordering::SeqCst) != 0 {
            return;
        }
        // Marks it as starting, so a second call does nothing.
        OURS.store(-1, Ordering::SeqCst);
        std::thread::spawn(|| unsafe {
            let Ok(instance) = GetModuleHandleW(None) else {
                OURS.store(0, Ordering::SeqCst);
                return;
            };
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: w!("Shell_TrayWnd"), ..Default::default() };
            // Registered once per process; a second start reuses it.
            let _ = RegisterClassW(&wc);
            let Ok(hwnd) = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, w!("Shell_TrayWnd"), w!(""), WS_POPUP, 0, 0, 0, 0, None, None, Some(instance.into()), None) else {
                crate::log::line("tray: window failed");
                OURS.store(0, Ordering::SeqCst);
                return;
            };
            OURS.store(hwnd.0 as isize, Ordering::SeqCst);
            keep_on_top(hwnd);
            let _ = SetTimer(Some(hwnd), 1, 1000, None);
            // Running apps send their icons again (as when Explorer restarts).
            let created = RegisterWindowMessageW(w!("TaskbarCreated"));
            if created != 0 {
                let _ = SendNotifyMessageW(HWND_BROADCAST, created, WPARAM(0), LPARAM(0));
            }
            crate::log::line("tray: reading the notification area");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            OURS.store(0, Ordering::SeqCst);
            ITEMS.lock().unwrap().clear();
            crate::log::line("tray: stopped");
        });
    }

    pub fn stop() {
        let h = OURS.load(Ordering::SeqCst);
        if h > 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn click(key: &str, button: &str, x: i32, y: i32) -> bool {
        let (hwnd, uid, cb, version) = {
            let items = ITEMS.lock().unwrap();
            let Some(i) = items.iter().find(|i| i.key == key) else { return false };
            (i.hwnd, i.uid, i.callback, i.version)
        };
        if cb == 0 {
            return false;
        }
        let owner = HWND(hwnd as isize as *mut _);
        unsafe {
            if !IsWindow(Some(owner)).as_bool() {
                return false;
            }
            // Its menu or window may come to the front.
            let mut pid = 0u32;
            GetWindowThreadProcessId(owner, Some(&mut pid));
            if pid != 0 {
                let _ = AllowSetForegroundWindow(pid);
            }
            let send = |m: u32| {
                let (wp, lp) = callback_params(version, uid, m, x, y);
                let _ = PostMessageW(Some(owner), cb, WPARAM(wp), LPARAM(lp));
            };
            match button {
                "right" => {
                    send(WM_RBUTTONDOWN);
                    send(WM_RBUTTONUP);
                    if version >= 4 {
                        send(WM_CONTEXTMENU);
                    }
                }
                "double" => {
                    send(WM_LBUTTONDBLCLK);
                    send(WM_LBUTTONUP);
                }
                _ => {
                    send(WM_LBUTTONDOWN);
                    send(WM_LBUTTONUP);
                    if version >= 4 {
                        send(NIN_SELECT);
                    }
                }
            }
        }
        true
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    use super::TrayIcon;

    pub fn icons() -> Vec<TrayIcon> {
        Vec::new()
    }
    pub fn start(_app: AppHandle) {}
    pub fn stop() {}
    pub fn click(_key: &str, _button: &str, _x: i32, _y: i32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{callback_params, key_of};

    #[test]
    fn an_icon_is_known_by_its_guid_or_its_window_and_number() {
        assert_eq!(key_of(0x1a2b, 7, None), "1a2b:7");
        assert_eq!(key_of(0x1a2b, 7, Some([0; 16])), "1a2b:7");
        let mut g = [0u8; 16];
        g[0] = 0xab;
        assert!(key_of(1, 1, Some(g)).starts_with("g:ab00"));
    }

    /// Reads this PC's tray for a few seconds (cargo test --lib tray_now -- --ignored --nocapture).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn tray_now() {
        super::imp::host();
        std::thread::sleep(std::time::Duration::from_secs(4));
        for i in super::imp::icons() {
            println!("{} | {} | icon {} chars", i.key, i.tip.lines().collect::<Vec<_>>().join(" / "), i.icon.map(|s| s.len()).unwrap_or(0));
        }
        super::imp::stop();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    #[test]
    fn clicks_reach_the_app_as_its_version_expects() {
        // Version 4: where (x, y), and the message with the icon's id.
        assert_eq!(callback_params(4, 3, 0x0202, 100, 200), ((100 | (200 << 16)) as usize, (0x0202 | (3 << 16)) as isize));
        // Older: the id, then the message.
        assert_eq!(callback_params(0, 3, 0x0202, 100, 200), (3, 0x0202));
    }
}
