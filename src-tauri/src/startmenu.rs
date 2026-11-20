// Island's own Start menu (src/core/startmenu.ts): the taskbar's Start button, and the Windows key
// while Island's taskbar shows, open it instead of Windows' Start (Settings › Taskbar › Start opens).
//
// It is its own window ("start"), not part of the taskbar's: that window is exactly as long as the
// bar, which sits at a fixed place in it. The menu's window stands on the bar's inner edge (over it at
// the bottom, under it on the top, beside it on a side), so the menu slides out from behind the bar,
// clipped at the bar's edge, as the taskbar's own cards do. It is made once (hidden until wanted) and
// hidden again after each use, so it opens at once.
//
// Here too: what the menu needs from Windows that Island had no command for yet. The files Windows
// lists as recent, the signed-in user's name and picture, and a short allow-list of places, tools
// and power actions (Settings, File Explorer, Documents, Task Manager, Sleep, Restart, ...).

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "start";

/// The menu's own size, logical px (about Windows 11's Start).
const MENU_W: f64 = 640.0;
const MENU_H: f64 = 720.0;
/// Room round the menu inside its window, for its shadow, logical px.
const PAD: f64 = 28.0;
/// Between the bar and the menu, logical px.
const GAP: f64 = 10.0;
/// Kept clear of the work area's edges, logical px.
const MARGIN: f64 = 10.0;

/// The edge the taskbar sits along (as dock.rs's Side; the dock page says which).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bottom,
    Left,
    Right,
    Top,
}

impl Side {
    pub fn parse(s: &str) -> Side {
        match s {
            "left" => Side::Left,
            "right" => Side::Right,
            "top" => Side::Top,
            _ => Side::Bottom,
        }
    }
}

/// A rect in physical screen px: x, y, width, height.
pub type Area = (i32, i32, i32, i32);

/// Where the menu goes: its window (physical px), the menu inside it and the point it grows out of
/// (the Start button's middle on the window's bar side), both in the window's CSS px.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Placed {
    #[serde(skip)]
    pub window: Area,
    pub side: Side,
    pub menu: [f64; 4],
    pub origin: [f64; 2],
}

/// The menu's window on side `side` of a work area `work`, for a bar at `bar` whose Start button is at
/// `button` (all physical px), at `scale`. Along the bar the menu is centred on the bar's middle (Moss,
/// 11-19: the same place whatever the bar holds, Now playing or tray icons), kept inside the work area; across, it stands on the bar's inner edge with GAP between,
/// as tall (or wide) as there is room for, up to MENU_W x MENU_H.
pub fn place(side: Side, work: Area, bar: Area, button: Area, scale: f64) -> Placed {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (wx, wy, ww, wh) = (work.0 as f64, work.1 as f64, work.2 as f64, work.3 as f64);
    let (bx, by, bw, bh) = (bar.0 as f64, bar.1 as f64, bar.2 as f64, bar.3 as f64);
    let (cx, cy) = (button.0 as f64 + button.2 as f64 / 2.0, button.1 as f64 + button.3 as f64 / 2.0);
    // Along the bar, the menu's start kept inside the work area (physical px).
    let clamp_along = |want: f64, start: f64, len: f64, size: f64| want.min(start + len - MARGIN * s - size * s).max(start + MARGIN * s);
    let room = |v: f64| v.max(0.0);
    match side {
        Side::Bottom | Side::Top => {
            let mw = MENU_W.min(room(ww / s - 2.0 * MARGIN));
            let avail = if side == Side::Bottom { (by - wy) / s - GAP - MARGIN } else { (wy + wh - (by + bh)) / s - GAP - MARGIN };
            let mh = MENU_H.min(room(avail));
            let left = clamp_along(bx + (bw - mw * s) / 2.0, wx, ww, mw);
            let x = left - PAD * s;
            let (y, menu_y) = if side == Side::Bottom { (by - (mh + GAP + PAD) * s, PAD) } else { (by + bh, GAP) };
            let (w, h) = (mw + 2.0 * PAD, mh + PAD + GAP);
            let origin = [(cx - x) / s, if side == Side::Bottom { h } else { 0.0 }];
            Placed { window: (x.round() as i32, y.round() as i32, (w * s).round() as i32, (h * s).round() as i32), side, menu: [PAD, menu_y, mw, mh], origin }
        }
        Side::Left | Side::Right => {
            let mh = MENU_H.min(room(wh / s - 2.0 * MARGIN));
            let avail = if side == Side::Left { (wx + ww - (bx + bw)) / s - GAP - MARGIN } else { (bx - wx) / s - GAP - MARGIN };
            let mw = MENU_W.min(room(avail));
            let top = clamp_along(by + (bh - mh * s) / 2.0, wy, wh, mh);
            let y = top - PAD * s;
            let (x, menu_x) = if side == Side::Left { (bx + bw, GAP) } else { (bx - (mw + GAP + PAD) * s, PAD) };
            let (w, h) = (mw + PAD + GAP, mh + 2.0 * PAD);
            let origin = [if side == Side::Left { 0.0 } else { w }, (cy - y) / s];
            Placed { window: (x.round() as i32, y.round() as i32, (w * s).round() as i32, (h * s).round() as i32), side, menu: [menu_x, PAD, mw, mh], origin }
        }
    }
}

// ------------------------------------------------------------------ the Windows key

pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
/// Marks the keys Island sends itself, so the hook lets them through untouched.
pub const MARK: usize = 0x1514_4E53;

/// What the hook does with one key event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyDo {
    /// Let it through.
    Pass,
    /// Eat it: Windows never sees it.
    Eat,
    /// Eat it, then send Windows the eaten Windows key (this one) going down and this key after it: a
    /// shortcut (Win+E) after all.
    Replay(u32),
    /// The Windows key let go on its own: eat it and open Island's Start.
    Open,
}

/// Watches the Windows key go down and up. Island eats it as it goes down, so Windows never sees a lone
/// press and its own Start can't open (hiding only the key-up from Windows, as before, let Start through
/// now and then). Another key while it is held makes it a shortcut (Win+E, Win+D, Win+Shift+S): the
/// Windows key goes to Windows then, ahead of that key.
#[derive(Default, Debug)]
pub struct WinKey {
    held: Option<u32>,
    /// Island ate its key-down (Windows hasn't seen it).
    eaten: bool,
    combo: bool,
}

impl WinKey {
    /// One key event as the hook sees it. `others`: Ctrl, Shift or Alt is down right now.
    pub fn on_key(&mut self, vk: u32, up: bool, injected: bool, others: bool) -> KeyDo {
        // Keys sent by a program (Island's own, a macro tool) go through and never make or break a press.
        if injected {
            return KeyDo::Pass;
        }
        let win = vk == VK_LWIN || vk == VK_RWIN;
        if win && !up {
            return match self.held {
                // Held down, it repeats: still the same press.
                Some(k) if k == vk => {
                    if self.eaten && !self.combo {
                        KeyDo::Eat
                    } else {
                        KeyDo::Pass
                    }
                }
                // The other Windows key as well: a shortcut of sorts.
                Some(k) => self.shortcut(k),
                None => {
                    self.held = Some(vk);
                    // Ctrl, Shift or Alt already down (Ctrl+Win…): Windows' from the start.
                    self.eaten = !others;
                    self.combo = others;
                    if self.eaten {
                        KeyDo::Eat
                    } else {
                        KeyDo::Pass
                    }
                }
            };
        }
        if win {
            if self.held != Some(vk) {
                return KeyDo::Pass;
            }
            let (eaten, combo) = (self.eaten, self.combo);
            *self = WinKey::default();
            return match (eaten, combo) {
                // Windows never saw it go down, so it doesn't see it go up either.
                (true, false) if others => KeyDo::Eat,
                (true, false) => KeyDo::Open,
                _ => KeyDo::Pass,
            };
        }
        match self.held {
            Some(k) if !up => self.shortcut(k),
            _ => KeyDo::Pass,
        }
    }

    /// Another key while the Windows key `held` is down.
    fn shortcut(&mut self, held: u32) -> KeyDo {
        let replay = self.eaten && !self.combo;
        self.combo = true;
        if replay {
            KeyDo::Replay(held)
        } else {
            KeyDo::Pass
        }
    }
}

// ------------------------------------------------------------------ actions

/// A known folder the menu opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Folder {
    Documents,
    Downloads,
    Pictures,
    Music,
    Videos,
    Home,
}

/// What one of the menu's buttons does. Only these: the page can't make Island run anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Act {
    /// A Windows address (Settings pages).
    Url(&'static str),
    Folder(Folder),
    /// A program by name, as Run would start it; with `admin`, after Windows asks.
    Run(&'static str, bool),
    /// Windows' own shortcut: Win and this letter.
    WinKey(u16),
    Lock,
    SignOut,
    /// sleep, restart or shutdown (shell.rs power_command).
    Power(&'static str),
}

pub fn act_of(what: &str) -> Option<Act> {
    Some(match what {
        "settings" => Act::Url("ms-settings:"),
        "apps-settings" => Act::Url("ms-settings:appsfeatures"),
        "start-settings" => Act::Url("ms-settings:personalization-start"),
        "power-settings" => Act::Url("ms-settings:powersleep"),
        "system" => Act::Url("ms-settings:about"),
        "network" => Act::Url("ms-settings:network"),
        "accounts" => Act::Url("ms-settings:accounts"),
        "mobility" => Act::Run("mblctr.exe", false),
        "explorer" => Act::Run("explorer.exe", false),
        "taskmgr" => Act::Run("taskmgr.exe", false),
        "devmgmt" => Act::Run("devmgmt.msc", false),
        "diskmgmt" => Act::Run("diskmgmt.msc", false),
        "compmgmt" => Act::Run("compmgmt.msc", false),
        "eventvwr" => Act::Run("eventvwr.msc", false),
        "terminal" => Act::Run("wt.exe", false),
        "terminal-admin" => Act::Run("wt.exe", true),
        "documents" => Act::Folder(Folder::Documents),
        "downloads" => Act::Folder(Folder::Downloads),
        "pictures" => Act::Folder(Folder::Pictures),
        "music" => Act::Folder(Folder::Music),
        "videos" => Act::Folder(Folder::Videos),
        "home" => Act::Folder(Folder::Home),
        "run" => Act::WinKey(b'R' as u16),
        "desktop" => Act::WinKey(b'D' as u16),
        "search" => Act::WinKey(b'S' as u16),
        "lock" => Act::Lock,
        "signout" => Act::SignOut,
        "sleep" => Act::Power("sleep"),
        "restart" => Act::Power("restart"),
        "shutdown" => Act::Power("shutdown"),
        _ => return None,
    })
}

/// `text` for an address: letters, digits and -._~ as they are, everything else %XX (UTF-8).
pub fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// What "Search the web" and "Search your files" open for `query` (trimmed; none for nothing typed).
pub fn search_target(kind: &str, query: &str, home: &str) -> Option<String> {
    let q = query.trim();
    if q.is_empty() || q.len() > 500 || q.contains(['\r', '\n', '\0']) {
        return None;
    }
    match kind {
        "web" => Some(format!("https://www.google.com/search?q={}", url_encode(q))),
        // Explorer's search over the user's folders, as Start's "Search for files" does.
        "files" => Some(format!("search-ms:query={}&crumb=location:{}", url_encode(q), url_encode(home))),
        _ => None,
    }
}

/// A recent file as the menu lists it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    /// The file's name.
    pub name: String,
    /// Where it is.
    pub path: String,
    /// The shortcut Windows keeps for it in Recent (what opening it opens).
    pub lnk: String,
    /// When it was last opened, ms since 1970.
    pub at: f64,
}

/// The newest `limit` of `found` (shortcut, its file, when, whether that file is there and is a
/// file), newest first; shortcuts to folders, missing files and repeats left out.
pub fn newest_files(mut found: Vec<(String, String, f64, bool)>, limit: usize) -> Vec<RecentFile> {
    found.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (lnk, path, at, is_file) in found {
        if !is_file || path.is_empty() || !seen.insert(path.to_lowercase()) {
            continue;
        }
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        out.push(RecentFile { name, path, lnk, at });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// The signed-in user, for the menu's corner.
#[derive(Clone, Debug, Default, Serialize)]
pub struct StartUser {
    pub name: String,
    /// Their account picture as a data address; none: the menu draws their initial.
    pub picture: Option<String>,
}

// ------------------------------------------------------------------ the window

/// Open, as far as Island knows (the page may still be sliding it in or out).
static OPEN: AtomicBool = AtomicBool::new(false);
/// Counts opens and closes: a late step of an old one (a hide, a watcher) sees it changed and stops.
static GEN: AtomicU64 = AtomicU64::new(0);
/// The Start button and the bar in each taskbar's window (CSS px), and the bar's side (each dock page
/// says), by the taskbar's label.
type Anchor = ([f64; 4], [f64; 4], Side);
static ANCHOR: Mutex<std::collections::BTreeMap<String, Anchor>> = Mutex::new(std::collections::BTreeMap::new());

/// The taskbar Start opens over: the one on the screen the pointer is on (where Start or Search was
/// clicked, or where you are when the Windows key is pressed), else the main screen's.
#[cfg(windows)]
fn anchor_now(app: &AppHandle) -> Option<(windows::Win32::Foundation::HWND, Anchor)> {
    let anchors = ANCHOR.lock().unwrap().clone();
    let here = crate::monitors::at_cursor().map(|m| m.id);
    let mut main = None;
    for (label, a) in anchors {
        let Some(h) = crate::frame::hwnd_of(app, &label) else { continue };
        if here.is_some() && crate::monitors::of_window(h).map(|m| m.id) == here {
            return Some((h, a));
        }
        if label == crate::dock::LABEL {
            main = Some((h, a));
        }
    }
    main
}
/// What the page was last told to open with, for a page that loads after the open.
static LAST: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// When it last closed by itself (a click elsewhere, the keyboard going elsewhere).
static CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// Only one thread makes the window.
static BUILDING: Mutex<()> = Mutex::new(());

fn emit_state(app: &AppHandle, open: bool) {
    let _ = app.emit("start-state", open);
}

/// The window, made (hidden) if there is none yet. Never on the event loop's thread: making a window
/// there deadlocks WebView2.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    let _one = BUILDING.lock().unwrap();
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Island Start")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible(false)
        .inner_size(MENU_W + 2.0 * PAD, MENU_H + PAD + GAP)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build();
    match built {
        Ok(w) => {
            tool_window(&w);
            Some(w)
        }
        Err(e) => {
            crate::log::line(format!("start menu window failed: {e}"));
            None
        }
    }
}

/// Never in Alt+Tab or Windows' taskbar.
#[cfg(windows)]
fn tool_window(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let hwnd = HWND(h.0);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let want = (ex | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
        }
    }
}

#[cfg(not(windows))]
fn tool_window(_win: &WebviewWindow) {}

/// Where the menu goes now: by the taskbar's window and what its page said about the Start button.
#[cfg(windows)]
fn placement(app: &AppHandle) -> Option<Placed> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    if let Some((dock, (button, bar, side))) = anchor_now(app) {
        let mut r = RECT::default();
        if unsafe { GetWindowRect(dock, &mut r) }.is_ok() {
            let m = crate::monitors::of_window(dock)?;
            let s = match unsafe { GetDpiForWindow(dock) } {
                0 => m.scale,
                dpi => dpi as f64 / 96.0,
            };
            let at = |q: [f64; 4]| -> Area { (r.left + (q[0] * s).round() as i32, r.top + (q[1] * s).round() as i32, (q[2] * s).round() as i32, (q[3] * s).round() as i32) };
            let work = (m.work.x, m.work.y, m.work.width, m.work.height);
            return Some(place(side, work, at(bar), at(button), s));
        }
    }
    // No taskbar to stand on (yet): over the middle of the main screen's bottom.
    let m = crate::monitors::primary()?;
    let s = m.scale;
    let (w, h) = ((600.0 * s) as i32, (52.0 * s) as i32);
    let bar = (m.work.x + (m.work.width - w) / 2, m.work.y + m.work.height - h - (8.0 * s) as i32, w, h);
    let button = (bar.0, bar.1, h, h);
    Some(place(Side::Bottom, (m.work.x, m.work.y, m.work.width, m.work.height), bar, button, s))
}

#[cfg(windows)]
fn hwnd(win: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    win.hwnd().ok().map(|h| windows::Win32::Foundation::HWND(h.0))
}

/// Opens the menu over the taskbar's Start button and gives it the keyboard.
#[cfg(windows)]
fn open(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};
    if OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    emit_state(app, true);
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(win) = window(&app) else {
            OPEN.store(false, Ordering::SeqCst);
            emit_state(&app, false);
            return;
        };
        let Some(p) = placement(&app) else { return };
        if GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let Some(h) = hwnd(&win) else { return };
        let (x, y, w, hgt) = p.window;
        // Twice: moved onto a screen at another scale (a second screen at 100 % beside a main one at
        // 125 %), Windows rescales the window as it crosses, and the menu came out cut off with its
        // shadow's edge showing (Moss, 11-20). Placed again once it is there, its size holds.
        for _ in 0..2 {
            unsafe {
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), x, y, w.max(1), hgt.max(1), SWP_NOACTIVATE);
            }
        }
        let payload = serde_json::json!({ "side": p.side, "menu": p.menu, "origin": p.origin, "gen": gen });
        *LAST.lock().unwrap() = Some(payload.clone());
        // Shown first (the menu still down behind the bar), then told: the slide plays where it is seen.
        let _ = win.show();
        let _ = app.emit_to(LABEL, "start-open", payload);
        // The click on Start (or the Windows key) was Island's, so Windows lets it come forward.
        crate::procs::activate(h.0 as isize);
        let _ = win.set_focus();
        watch(app, gen, h.0 as isize);
    });
}

/// Slides the menu away (the page does, then says `start_hidden`); hidden for sure a moment later.
fn close(app: &AppHandle, by_itself: bool) {
    if !OPEN.swap(false, Ordering::SeqCst) {
        return;
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if by_itself {
        *CLOSED_AT.lock().unwrap() = Some(Instant::now());
    }
    emit_state(app, false);
    let _ = app.emit_to(LABEL, "start-close", gen);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(450));
        hide_if(&app, gen);
    });
}

fn hide_if(app: &AppHandle, gen: u64) {
    if GEN.load(Ordering::SeqCst) != gen || OPEN.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        }
    }
}

#[cfg(windows)]
fn toggle(app: &AppHandle) {
    if OPEN.load(Ordering::SeqCst) {
        close(app, false);
        return;
    }
    // The click that just closed it (on the taskbar, say) doesn't open it again straight away.
    if CLOSED_AT.lock().unwrap().is_some_and(|t| t.elapsed().as_millis() < 250) {
        return;
    }
    open(app);
}

#[cfg(not(windows))]
fn toggle(_app: &AppHandle) {}

/// While it is open: the keyboard going to another window, or a click anywhere outside it and the Start
/// button, closes it (also when it never got the keyboard, so its page heard no blur).
#[cfg(windows)]
fn watch(app: AppHandle, gen: u64, me: isize) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let started = Instant::now();
    let pressed = || unsafe { [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().any(|k| GetAsyncKeyState(k.0 as i32) as u16 & 0x8000 != 0) };
    let mut was_down = pressed();
    let mut had_focus = false;
    let mut retried = false;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(30));
        if GEN.load(Ordering::SeqCst) != gen || !OPEN.load(Ordering::SeqCst) {
            return;
        }
        let fg = crate::procs::foreground();
        if fg == me {
            had_focus = true;
        } else if had_focus && fg != 0 {
            close(&app, true);
            return;
        } else if !had_focus && !retried && started.elapsed().as_millis() > 200 {
            retried = true;
            crate::procs::activate(me);
        }
        let down = pressed();
        if down && !was_down {
            let mut p = POINT::default();
            if unsafe { GetCursorPos(&mut p) }.is_ok() && !inside(me, p.x, p.y) && !on_start_button(&app, p.x, p.y) {
                close(&app, true);
                return;
            }
        }
        was_down = down;
    }
}

#[cfg(windows)]
fn inside(raw: isize, x: i32, y: i32) -> bool {
    crate::procs::window_rect(raw).is_some_and(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
}

/// The point is on the taskbar's Start button (its own click toggles the menu).
#[cfg(windows)]
fn on_start_button(app: &AppHandle, x: i32, y: i32) -> bool {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    let anchors = ANCHOR.lock().unwrap().clone();
    anchors.iter().any(|(label, (button, _, _))| {
        let Some(dock) = crate::frame::hwnd_of(app, label) else { return false };
        let Some(r) = crate::procs::window_rect(dock.0 as isize) else { return false };
        let s = match unsafe { GetDpiForWindow(dock) } {
            0 => 1.0,
            dpi => dpi as f64 / 96.0,
        };
        let (bx, by) = (r.left as f64 + button[0] * s, r.top as f64 + button[1] * s);
        let (x, y) = (x as f64, y as f64);
        x >= bx && x < bx + button[2] * s && y >= by && y < by + button[3] * s
    })
}

// ------------------------------------------------------------------ the keyboard hook

/// The Windows key opens Island's Start (Settings › Taskbar), while the taskbar shows.
static KEYS_ON: AtomicBool = AtomicBool::new(false);
/// The hook's thread (0: none).
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static HOOK_STATE: Mutex<WinKey> = Mutex::new(WinKey { held: None, eaten: false, combo: false });
static HOOK_APP: Mutex<Option<AppHandle>> = Mutex::new(None);
/// In the helper: the event that tells Island the Windows key was pressed on its own (0: the hook is
/// Island's own and opens Start itself).
static HELPER_SIGNAL: AtomicIsize = AtomicIsize::new(0);

/// Island.exe started with this and Island's process id is the Windows-key helper: a small process of
/// its own that only runs the hook. Windows doesn't call a keyboard hook in Island's own process while
/// one of Island's windows is in front (its Start menu, its taskbar), so the Windows key went to Windows'
/// Start from there (Moss, 11-19); a hook in another process hears it.
pub const HELPER_ARG: &str = "--win-key-hook";

/// The helper's Island, from its command line (`--win-key-hook <pid>`).
pub fn helper_parent(args: &[String]) -> Option<u32> {
    let at = args.iter().position(|a| a == HELPER_ARG)?;
    args.get(at + 1)?.parse().ok().filter(|pid| *pid != 0)
}

/// The event the helper sets for the Island with process id `pid`, at a lone Windows-key press.
fn signal_name(pid: u32) -> String {
    format!("Local\\IslandStartKey-{pid}")
}

#[cfg(windows)]
const WM_OPEN: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 0x51;
/// How often the hook is made again (ms), in case Windows dropped it.
#[cfg(windows)]
const REHOOK_MS: u32 = 5000;

#[cfg(windows)]
unsafe extern "system" fn key_hook(code: i32, wparam: windows::Win32::Foundation::WPARAM, lparam: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, PostThreadMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WM_KEYUP, WM_SYSKEYUP};
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let msg = wparam.0 as u32;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0 || k.dwExtraInfo == MARK;
        let others = unsafe { [VK_CONTROL, VK_SHIFT, VK_MENU].iter().any(|v| GetAsyncKeyState(v.0 as i32) as u16 & 0x8000 != 0) };
        // Off (Settings › Taskbar), the Windows key is all Windows'.
        if KEYS_ON.load(Ordering::SeqCst) {
            let what = HOOK_STATE.lock().map(|mut s| s.on_key(k.vkCode, up, injected, others)).unwrap_or(KeyDo::Pass);
            let thread = HOOK_THREAD.load(Ordering::SeqCst);
            match what {
                KeyDo::Pass => {}
                KeyDo::Eat => return LRESULT(1),
                KeyDo::Replay(win_vk) => {
                    replay(win_vk as u16, k);
                    return LRESULT(1);
                }
                KeyDo::Open => {
                    // Nothing goes to Windows: it never saw the key go down. (Sending it a masked key-up,
                    // as before, opened Windows' Start now and then.)
                    if thread != 0 {
                        let _ = unsafe { PostThreadMessageW(thread, WM_OPEN, WPARAM(0), LPARAM(0)) };
                    }
                    return LRESULT(1);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The Windows key Island ate going down, then the key that makes it a shortcut, as typed (the same
/// scan code, so Win+Shift+S and Win+. land as they would have).
#[cfg(windows)]
fn replay(win_vk: u16, k: &windows::Win32::UI::WindowsAndMessaging::KBDLLHOOKSTRUCT) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, VIRTUAL_KEY};
    use windows::Win32::UI::WindowsAndMessaging::LLKHF_EXTENDED;
    // Win+L locks in Windows itself; a program sending it doesn't, so Island locks.
    if k.vkCode == 0x4C {
        crate::shell::shell_lock();
        return;
    }
    let down = |vk: u16, scan: u16, ext: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: if ext { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: MARK } },
    };
    let ext = k.flags.0 & LLKHF_EXTENDED.0 != 0;
    let inputs = [down(win_vk, 0, true), down(k.vkCode as u16, k.scanCode as u16, ext)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// The hook and its message loop on this thread, until WM_QUIT (Island's own hook) or the helper's
/// end. False: Windows gave no hook.
#[cfg(windows)]
fn hook_loop() -> bool {
    use windows::Win32::Foundation::{HANDLE, HINSTANCE};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{GetCurrentThread, SetEvent, SetThreadInformation, SetThreadPriority, ThreadPowerThrottling, THREAD_POWER_THROTTLING_CURRENT_VERSION, THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE, THREAD_PRIORITY_TIME_CRITICAL};
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WM_TIMER};
    let who = if HELPER_SIGNAL.load(Ordering::SeqCst) != 0 { "helper" } else { "Island" };
    unsafe {
        // Windows waits only a moment for the hook, then skips it (and can drop it for good), and the
        // Windows key goes to its own Start. So this thread never waits behind other work and isn't slowed
        // down in the background (Windows' efficiency mode).
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        let fast = THREAD_POWER_THROTTLING_STATE { Version: THREAD_POWER_THROTTLING_CURRENT_VERSION, ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED, StateMask: 0 };
        let _ = SetThreadInformation(GetCurrentThread(), ThreadPowerThrottling, &fast as *const _ as *const _, std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32);
        let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        let Ok(mut h) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), module, 0) else {
            crate::log::line(format!("start menu: no keyboard hook in the {who} (the Windows key opens Windows' Start)"));
            return false;
        };
        crate::log::line(format!("start menu: the Windows key opens Island's Start (hook in the {who})"));
        let _ = SetTimer(None, 0, REHOOK_MS, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            match msg.message {
                // Hooked again (between presses): first in line again, and back should Windows have dropped it.
                WM_TIMER => {
                    let idle = HOOK_STATE.lock().map(|s| s.held.is_none()).unwrap_or(false);
                    if idle {
                        if let Ok(fresh) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), module, 0) {
                            let _ = UnhookWindowsHookEx(h);
                            h = fresh;
                        }
                    }
                }
                WM_OPEN => {
                    let signal = HELPER_SIGNAL.load(Ordering::SeqCst);
                    if signal != 0 {
                        let _ = SetEvent(HANDLE(signal as *mut _));
                    } else if let Some(app) = HOOK_APP.lock().unwrap().clone() {
                        // Off the hook's thread: opening may make the window, which takes a while.
                        std::thread::spawn(move || toggle(&app));
                    }
                }
                _ => {}
            }
        }
        let _ = UnhookWindowsHookEx(h);
    }
    if let Ok(mut s) = HOOK_STATE.lock() {
        *s = WinKey::default();
    }
    true
}

/// The helper's whole life (Island.exe --win-key-hook <pid>, from `run` before anything else of Island):
/// the hook on its main thread until its Island ends. 1: it couldn't run.
#[cfg(windows)]
pub fn helper_main(island: u32) -> i32 {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{GetCurrentThreadId, OpenEventW, OpenProcess, WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE, PROCESS_SYNCHRONIZE};
    let Ok(parent) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, island) }) else { return 1 };
    let Ok(signal) = (unsafe { OpenEventW(EVENT_MODIFY_STATE, false, &HSTRING::from(signal_name(island))) }) else { return 1 };
    HELPER_SIGNAL.store(signal.0 as isize, Ordering::SeqCst);
    let parent = parent.0 as isize;
    // Island gone (closed, crashed, updating): the helper too, and its hook with it.
    std::thread::spawn(move || {
        unsafe { WaitForSingleObject(HANDLE(parent as *mut _), INFINITE) };
        std::process::exit(0);
    });
    KEYS_ON.store(true, Ordering::SeqCst);
    HOOK_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    if hook_loop() {
        0
    } else {
        1
    }
}

/// The helper Island started, while the Windows key is Island's.
#[cfg(windows)]
static HELPER: Mutex<Option<std::process::Child>> = Mutex::new(None);
/// When it was started (one that ends at once isn't started again and again).
#[cfg(windows)]
static HELPER_AT: Mutex<Option<Instant>> = Mutex::new(None);

#[cfg(windows)]
fn helper_running() -> bool {
    HELPER.lock().unwrap().as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
}

/// The helper, started unless it runs. False: it can't (Island's own hook then).
#[cfg(windows)]
fn start_helper() -> bool {
    use crate::nowindow::NoWindow;
    let mut slot = HELPER.lock().unwrap();
    if slot.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None))) {
        return true;
    }
    if slot.is_some() && HELPER_AT.lock().unwrap().is_some_and(|t| t.elapsed().as_secs() < 5) {
        crate::log::line("start menu: the Windows-key helper ended at once; Island's own hook instead");
        return false;
    }
    let Ok(exe) = std::env::current_exe() else { return false };
    match std::process::Command::new(exe).arg(HELPER_ARG).arg(std::process::id().to_string()).no_window().spawn() {
        Ok(child) => {
            *slot = Some(child);
            *HELPER_AT.lock().unwrap() = Some(Instant::now());
            true
        }
        Err(e) => {
            crate::log::line(format!("start menu: no Windows-key helper ({e}); Island's own hook instead"));
            false
        }
    }
}

#[cfg(windows)]
fn stop_helper() {
    if let Some(mut child) = HELPER.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Island's side of the helper: the event it sets and a thread that opens or closes Start on it (and
/// starts the helper again should it end while it is wanted). Made once; false if Windows gave no event.
#[cfg(windows)]
fn listen() -> bool {
    use std::sync::OnceLock;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    static EVENT: OnceLock<Option<isize>> = OnceLock::new();
    EVENT
        .get_or_init(|| {
            let ev = unsafe { CreateEventW(None, false, false, &HSTRING::from(signal_name(std::process::id()))) }.ok()?;
            let raw = ev.0 as isize;
            std::thread::spawn(move || loop {
                if unsafe { WaitForSingleObject(HANDLE(raw as *mut _), 2000) } == WAIT_OBJECT_0 {
                    if KEYS_ON.load(Ordering::SeqCst) {
                        if let Some(app) = HOOK_APP.lock().unwrap().clone() {
                            std::thread::spawn(move || toggle(&app));
                        }
                    }
                } else if KEYS_ON.load(Ordering::SeqCst) && HOOK_THREAD.load(Ordering::SeqCst) == 0 && !helper_running() {
                    crate::log::line("start menu: the Windows-key helper ended; starting it again");
                    if !start_helper() {
                        own_hook(true);
                    }
                }
            });
            Some(raw)
        })
        .is_some()
}

/// Island's own hook on a thread of its own, for when the helper can't run.
#[cfg(windows)]
fn own_hook(on: bool) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
    let running = HOOK_THREAD.load(Ordering::SeqCst);
    if !on {
        if running != 0 {
            HOOK_THREAD.store(0, Ordering::SeqCst);
            if running != u32::MAX {
                let _ = unsafe { PostThreadMessageW(running, WM_QUIT, WPARAM(0), LPARAM(0)) };
            }
        }
        return;
    }
    if running != 0 {
        return;
    }
    // Claimed before the thread runs, so a second call doesn't start another.
    HOOK_THREAD.store(u32::MAX, Ordering::SeqCst);
    std::thread::spawn(move || {
        let me = unsafe { GetCurrentThreadId() };
        if HOOK_THREAD.compare_exchange(u32::MAX, me, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return;
        }
        let hooked = hook_loop();
        let _ = HOOK_THREAD.compare_exchange(me, 0, Ordering::SeqCst, Ordering::SeqCst);
        if hooked {
            crate::log::line("start menu: the Windows key is Windows' again");
        }
    });
}

/// Starts or stops the hook: in the helper, or (when it can't run) on a thread of Island's own.
#[cfg(windows)]
fn hook(app: &AppHandle, on: bool) {
    *HOOK_APP.lock().unwrap() = Some(app.clone());
    KEYS_ON.store(on, Ordering::SeqCst);
    if !on {
        stop_helper();
        own_hook(false);
        return;
    }
    if listen() && start_helper() {
        own_hook(false);
    } else {
        own_hook(true);
    }
}

#[cfg(not(windows))]
fn hook(_app: &AppHandle, _on: bool) {}

// ------------------------------------------------------------------ Windows' bits

#[cfg(windows)]
mod win {
    use std::path::{Path, PathBuf};

    use base64::Engine as _;
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::Win32::UI::Shell::{IShellLinkW, SHGetKnownFolderPath, ShellLink, KNOWN_FOLDER_FLAG};

    use super::{newest_files, Folder, RecentFile, StartUser};

    pub fn known(f: Folder) -> Option<PathBuf> {
        use windows::Win32::UI::Shell::{FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Profile, FOLDERID_Videos};
        let id = match f {
            Folder::Documents => &FOLDERID_Documents,
            Folder::Downloads => &FOLDERID_Downloads,
            Folder::Pictures => &FOLDERID_Pictures,
            Folder::Music => &FOLDERID_Music,
            Folder::Videos => &FOLDERID_Videos,
            Folder::Home => &FOLDERID_Profile,
        };
        known_id(id)
    }

    fn known_id(id: &windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            (!s.is_empty()).then(|| PathBuf::from(s))
        }
    }

    /// Windows' Recent folder: a shortcut for each file opened lately.
    pub fn recent_dir() -> Option<PathBuf> {
        known_id(&windows::Win32::UI::Shell::FOLDERID_Recent)
    }

    unsafe fn link_path(link: &IShellLinkW, lnk: &Path) -> Option<String> {
        unsafe {
            link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
            let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
            let path = String::from_utf16_lossy(&buf[..len]);
            (!path.is_empty()).then_some(path)
        }
    }

    /// The files Windows lists as opened lately, newest first.
    pub fn recent(limit: usize) -> Vec<RecentFile> {
        let Some(dir) = recent_dir() else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut lnks: Vec<(PathBuf, f64)> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")))
            .filter_map(|p| {
                let at = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64;
                Some((p, at))
            })
            .collect();
        lnks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        // Folders and gone files are left out, so look at a few more than wanted.
        lnks.truncate(limit * 4 + 8);
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
        let mut found = Vec::new();
        if let Ok(link) = unsafe { CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER) } {
            for (lnk, at) in lnks {
                let Some(path) = (unsafe { link_path(&link, &lnk) }) else { continue };
                let is_file = Path::new(&path).is_file();
                found.push((lnk.display().to_string(), path, at, is_file));
            }
        }
        if init {
            unsafe { CoUninitialize() };
        }
        newest_files(found, limit)
    }

    fn user_sid() -> Option<String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            if needed == 0 {
                let _ = CloseHandle(token);
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            let ok = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok();
            let _ = CloseHandle(token);
            if !ok {
                return None;
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
            let sid = text.to_string().ok();
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            sid
        }
    }

    /// The name Windows greets the user with (the sign-in screen's), and their account picture.
    pub fn user() -> StartUser {
        let sid = user_sid();
        let lm = windows_registry::LOCAL_MACHINE;
        let mut name = String::new();
        if let Ok(k) = lm.open(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI") {
            let last = k.get_string("LastLoggedOnUserSID").unwrap_or_default();
            if sid.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(&last)) {
                name = k.get_string("LastLoggedOnDisplayName").unwrap_or_default();
            }
        }
        if name.trim().is_empty() {
            name = std::env::var("USERNAME").unwrap_or_default();
        }
        let mut picture = None;
        if let Some(sid) = sid {
            if let Ok(k) = lm.open(format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\{sid}")) {
                for size in ["Image192", "Image208", "Image240", "Image96", "Image448", "Image424"] {
                    let Ok(path) = k.get_string(size) else { continue };
                    let Ok(bytes) = std::fs::read(&path) else { continue };
                    if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
                        continue;
                    }
                    let ct = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
                    picture = Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
                    break;
                }
            }
        }
        StartUser { name: name.trim().to_string(), picture }
    }
}

// ------------------------------------------------------------------ commands

/// The taskbar's page says where its Start button and the bar are (CSS px in its window) and its side.
#[tauri::command]
pub fn start_anchor(window: tauri::WebviewWindow, button: Vec<f64>, bar: Vec<f64>, side: String) {
    let four = |v: &[f64]| -> Option<[f64; 4]> { (v.len() == 4 && v.iter().all(|n| n.is_finite())).then(|| [v[0], v[1], v[2], v[3]]) };
    let (Some(b), Some(r)) = (four(&button), four(&bar)) else { return };
    if !crate::dock::is_dock(window.label()) {
        return;
    }
    let mut all = ANCHOR.lock().unwrap();
    // A closed taskbar's anchor goes with it.
    let open = crate::dock::labels(window.app_handle());
    all.retain(|l, _| open.contains(l));
    all.insert(window.label().to_string(), (b, r, Side::parse(&side)));
}

/// Opens the menu, or closes it when it is open (Start, the Windows key).
#[tauri::command]
pub fn start_toggle(app: AppHandle) {
    toggle(&app);
}

/// Opens or closes the menu.
#[tauri::command]
pub fn start_show(app: AppHandle, on: bool) {
    if on {
        #[cfg(windows)]
        open(&app);
    } else {
        close(&app, false);
    }
}

/// The page slid the menu away: its window hides now (unless it was opened again meanwhile).
#[tauri::command]
pub fn start_hidden(app: AppHandle, gen: u64) {
    hide_if(&app, gen);
}

/// The page loaded: it hears again what it opened with, if it is open.
#[tauri::command]
pub fn start_hello(app: AppHandle) {
    if !OPEN.load(Ordering::SeqCst) {
        return;
    }
    if let Some(p) = LAST.lock().unwrap().clone() {
        let _ = app.emit_to(LABEL, "start-open", p);
    }
}

/// Makes the menu's window ahead of time (hidden), so Start opens at once; off: takes it away.
#[tauri::command]
pub fn start_prepare(app: AppHandle, on: bool) {
    std::thread::spawn(move || {
        if on {
            let _ = window(&app);
        } else {
            OPEN.store(false, Ordering::SeqCst);
            GEN.fetch_add(1, Ordering::SeqCst);
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.destroy();
            }
        }
    });
}

/// The Windows key opens Island's Start (true) or Windows' (false).
#[tauri::command]
pub fn start_keys(app: AppHandle, on: bool) {
    hook(&app, on);
}

/// The files opened lately, newest first.
#[tauri::command]
pub async fn start_recent(limit: u32) -> Vec<RecentFile> {
    #[cfg(windows)]
    {
        let n = limit.clamp(1, 60) as usize;
        tauri::async_runtime::spawn_blocking(move || win::recent(n)).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = limit;
        Vec::new()
    }
}

/// The signed-in user's name and picture.
#[tauri::command]
pub async fn start_user() -> StartUser {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win::user).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        StartUser { name: std::env::var("USER").unwrap_or_default(), picture: None }
    }
}

/// One of the menu's places, tools or power actions (act_of's list only). The menu closes first.
#[tauri::command]
pub fn start_do(app: AppHandle, what: String) -> bool {
    let Some(act) = act_of(&what) else { return false };
    close(&app, false);
    #[cfg(windows)]
    {
        run(act)
    }
    #[cfg(not(windows))]
    {
        let _ = act;
        false
    }
}

#[cfg(windows)]
fn run(act: Act) -> bool {
    use crate::nowindow::NoWindow;
    match act {
        Act::Url(u) => crate::shell::shell_execute("open", u, None),
        Act::Folder(f) => win::known(f).is_some_and(|p| crate::shell::shell_execute("open", &p.display().to_string(), None)),
        Act::Run(program, admin) => {
            let verb = if admin { "runas" } else { "open" };
            crate::shell::shell_execute(verb, program, None) || (program == "wt.exe" && crate::shell::shell_execute(verb, "powershell.exe", None))
        }
        Act::WinKey(letter) => {
            use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY};
            let key = |vk: u16, up: bool| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: MARK } },
            };
            let win = VK_LWIN as u16;
            let inputs = [key(win, false), key(letter, false), key(letter, true), key(win, true)];
            unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
        }
        Act::Lock => {
            crate::shell::shell_lock();
            true
        }
        Act::SignOut => {
            crate::log::line("power: sign out");
            std::process::Command::new("shutdown.exe").arg("/l").no_window().spawn().is_ok()
        }
        Act::Power(kind) => crate::shell::shell_power(kind.to_string()).is_ok(),
    }
}

/// Search the web, or your files in Explorer, for what was typed.
#[tauri::command]
pub fn start_search(app: AppHandle, kind: String, query: String) -> bool {
    #[cfg(windows)]
    {
        let home = win::known(Folder::Home).map(|p| p.display().to_string()).unwrap_or_default();
        let Some(target) = search_target(&kind, &query, &home) else { return false };
        close(&app, false);
        crate::shell::shell_execute("open", &target, None)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, kind, query);
        false
    }
}

/// Opens a recent file through the shortcut Windows keeps for it (only shortcuts in Recent).
#[tauri::command]
pub fn start_open_recent(app: AppHandle, lnk: String) -> bool {
    #[cfg(windows)]
    {
        let p = std::path::Path::new(&lnk);
        let ok = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) && p.is_file() && win::recent_dir().is_some_and(|d| p.parent().is_some_and(|parent| parent.eq(d.as_path())));
        if !ok {
            return false;
        }
        close(&app, false);
        crate::shell::shell_execute("open", &lnk, None)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, lnk);
        false
    }
}

/// An app's program run as administrator (Windows asks first); only a program file that is there.
#[tauri::command]
pub fn start_admin(app: AppHandle, target: String) -> bool {
    #[cfg(windows)]
    {
        let p = std::path::Path::new(&target);
        if !p.is_absolute() || !p.is_file() || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return false;
        }
        close(&app, false);
        crate::shell::shell_execute("runas", &target, None)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, target);
        false
    }
}

/// Shows a program or a file selected in its folder.
#[tauri::command]
pub fn start_reveal(app: AppHandle, path: String) -> bool {
    #[cfg(windows)]
    {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() || !p.exists() {
            return false;
        }
        close(&app, false);
        crate::shell::shell_execute("open", "explorer.exe", Some(&format!("/select,\"{}\"", path.replace('"', ""))))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        false
    }
}

/// Island is quitting or the taskbar went: the Windows key is Windows' again.
pub fn quit(app: &AppHandle) {
    hook(app, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Area = (0, 0, 1920, 1032);

    #[test]
    fn at_the_bottom_the_menu_stands_on_the_bar_centred_on_it() {
        // A bar 600 wide in the middle, 52 tall, 8 over the work area's end; Start at its left.
        let bar = (660, 1032 - 8 - 52, 600, 52);
        let button = (672, 978, 40, 40);
        let p = place(Side::Bottom, WORK, bar, button, 1.0);
        let (x, y, w, h) = p.window;
        // The window's bottom edge is the bar's top edge: the menu slides out from behind the bar.
        assert_eq!(y + h, bar.1);
        // The menu's middle is the bar's middle.
        assert_eq!(x as f64 + p.menu[0] + p.menu[2] / 2.0, 960.0);
        assert_eq!(p.menu[2], MENU_W);
        assert_eq!(p.menu[3], MENU_H);
        assert_eq!(w as f64, MENU_W + 2.0 * PAD);
        // It grows out of the Start button's middle, on the window's bottom edge.
        assert_eq!(p.origin, [692.0 - x as f64, h as f64]);
    }

    #[test]
    fn a_short_screen_gets_a_shorter_menu_and_an_edge_bar_a_menu_inside_the_screen() {
        let work = (0, 0, 1366, 728);
        // Short and at the left end: centred, the menu would start off the screen.
        let bar = (0, 728 - 52, 400, 52);
        let p = place(Side::Bottom, work, bar, (12, 682, 40, 40), 1.0);
        assert_eq!(p.menu[3], 728.0 - 52.0 - GAP - MARGIN);
        // Never off the screen's left edge.
        assert_eq!(p.window.0 as f64 + p.menu[0], MARGIN);
    }

    #[test]
    fn near_the_right_end_the_menu_stays_on_the_screen() {
        let bar = (1500, 972, 400, 52);
        let p = place(Side::Bottom, WORK, bar, (1512, 978, 40, 40), 1.0);
        assert_eq!(p.window.0 as f64 + p.menu[0] + p.menu[2], 1920.0 - MARGIN);
    }

    #[test]
    fn on_top_and_on_the_sides_it_comes_out_the_other_way() {
        let top = place(Side::Top, WORK, (660, 8, 600, 52), (672, 14, 40, 40), 1.0);
        assert_eq!(top.window.1, 60);
        assert_eq!(top.menu[1], GAP);
        assert_eq!(top.origin[1], 0.0);
        let left = place(Side::Left, WORK, (8, 200, 52, 600), (14, 212, 40, 40), 1.0);
        assert_eq!(left.window.0, 60);
        assert_eq!(left.menu[0], GAP);
        assert_eq!(left.window.1 as f64 + left.menu[1] + left.menu[3] / 2.0, 500.0);
        let right = place(Side::Right, WORK, (1860, 200, 52, 600), (1866, 212, 40, 40), 1.0);
        assert_eq!(right.window.0 + right.window.2, 1860);
        assert_eq!(right.origin[0], right.window.2 as f64);
    }

    #[test]
    fn a_125_percent_screen_counts_physical_pixels() {
        let work = (0, 0, 1920, 1020);
        let bar = (585, 1020 - 10 - 65, 750, 65);
        let p = place(Side::Bottom, work, bar, (600, 950, 50, 50), 1.25);
        assert_eq!(p.window.1 + p.window.3, bar.1);
        assert_eq!(p.window.2, ((MENU_W + 2.0 * PAD) * 1.25).round() as i32);
        assert_eq!(p.menu[2], MENU_W);
        // Centred on the bar in physical px: its middle at 585 + 750 / 2.
        let mid = p.window.0 as f64 + (p.menu[0] + p.menu[2] / 2.0) * 1.25;
        assert!((mid - 960.0).abs() < 1.0, "{mid}");
    }

    #[test]
    fn a_longer_bar_round_the_same_middle_keeps_the_menu_where_it_was() {
        // Now playing or tray icons make the bar longer on both sides of its middle.
        let short = place(Side::Bottom, WORK, (760, 972, 400, 52), (772, 978, 40, 40), 1.0);
        let long = place(Side::Bottom, WORK, (560, 972, 800, 52), (572, 978, 40, 40), 1.0);
        assert_eq!(short.window, long.window);
    }

    #[test]
    fn the_windows_key_alone_is_start_and_with_another_key_a_shortcut() {
        use KeyDo::*;
        let mut k = WinKey::default();
        // Windows never sees a lone press, down, held or up.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat, "held, it repeats");
        assert_eq!(k.on_key(VK_LWIN, true, false, false), Open, "a lone press opens Start");
        // Win+E: Windows gets the Windows key back ahead of E, then the rest as typed.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(0x45, false, false, false), Replay(VK_LWIN));
        assert_eq!(k.on_key(0x45, false, false, false), Pass, "E held repeats");
        assert_eq!(k.on_key(0x45, true, false, false), Pass);
        assert_eq!(k.on_key(0x44, false, false, false), Pass, "Win+E then D: Windows has the key already");
        assert_eq!(k.on_key(VK_LWIN, true, false, false), Pass, "Win+E stays Windows'");
        // The next lone press works again, with either Windows key.
        assert_eq!(k.on_key(VK_RWIN, false, false, false), Eat);
        assert_eq!(k.on_key(VK_RWIN, true, false, false), Open);
        // Ctrl down first: Windows' from the start.
        assert_eq!(k.on_key(VK_LWIN, false, false, true), Pass);
        assert_eq!(k.on_key(VK_LWIN, true, false, true), Pass);
        // Win, then Shift and S: the Windows key goes back ahead of Shift.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(0xA0, false, false, false), Replay(VK_LWIN));
        assert_eq!(k.on_key(0x53, false, false, true), Pass);
        assert_eq!(k.on_key(VK_LWIN, true, false, true), Pass);
        // Shift pressed and let go mid-press with nothing else: still a press Windows never saw.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(VK_LWIN, true, false, true), Eat, "not Start, and no key-up Windows didn't see go down");
        // Both Windows keys: the first goes back to Windows.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(VK_RWIN, false, false, false), Replay(VK_LWIN));
        assert_eq!(k.on_key(VK_RWIN, true, false, false), Pass);
        assert_eq!(k.on_key(VK_LWIN, true, false, false), Pass);
        // Keys a program sends (Island's own replays among them) always go through.
        assert_eq!(k.on_key(VK_LWIN, false, true, false), Pass);
        assert_eq!(k.on_key(VK_LWIN, true, true, false), Pass);
        // A key let go while Win is down (pressed before it) is no shortcut; one pressed is.
        assert_eq!(k.on_key(VK_LWIN, false, false, false), Eat);
        assert_eq!(k.on_key(0x41, true, false, false), Pass);
        assert_eq!(k.on_key(VK_LWIN, true, false, false), Open);
    }

    #[test]
    fn the_helper_knows_its_island_from_its_command_line() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(helper_parent(&args(&["Island.exe", HELPER_ARG, "4242"])), Some(4242));
        assert_eq!(helper_parent(&args(&["Island.exe"])), None, "Island itself");
        assert_eq!(helper_parent(&args(&["Island.exe", HELPER_ARG])), None);
        assert_eq!(helper_parent(&args(&["Island.exe", HELPER_ARG, "x"])), None);
        assert_eq!(helper_parent(&args(&["Island.exe", HELPER_ARG, "0"])), None);
        // Each Island its own signal, in the signed-in user's session.
        assert_eq!(signal_name(4242), "Local\\IslandStartKey-4242");
        assert_ne!(signal_name(1), signal_name(2));
    }

    #[test]
    fn only_known_actions_run() {
        assert_eq!(act_of("settings"), Some(Act::Url("ms-settings:")));
        assert_eq!(act_of("downloads"), Some(Act::Folder(Folder::Downloads)));
        assert_eq!(act_of("taskmgr"), Some(Act::Run("taskmgr.exe", false)));
        assert_eq!(act_of("terminal-admin"), Some(Act::Run("wt.exe", true)));
        assert_eq!(act_of("run"), Some(Act::WinKey(b'R' as u16)));
        assert_eq!(act_of("signout"), Some(Act::SignOut));
        assert_eq!(act_of("shutdown"), Some(Act::Power("shutdown")));
        for bad in ["", "cmd.exe", "format", "C:\\Windows\\System32\\calc.exe", "settings "] {
            assert_eq!(act_of(bad), None, "{bad}");
        }
        // Every power action is one shell.rs knows (it never forces programs closed).
        #[cfg(windows)]
        for kind in ["sleep", "restart", "shutdown"] {
            assert!(crate::shell::power_command(kind).is_some());
        }
    }

    #[test]
    fn searches_are_encoded_and_empty_ones_go_nowhere() {
        assert_eq!(url_encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(search_target("web", "  rust lang ", "").as_deref(), Some("https://www.google.com/search?q=rust%20lang"));
        assert_eq!(search_target("files", "budget", r"C:\Users\x").as_deref(), Some("search-ms:query=budget&crumb=location:C%3A%5CUsers%5Cx"));
        assert_eq!(search_target("web", "   ", ""), None);
        assert_eq!(search_target("web", "a\nb", ""), None);
        assert_eq!(search_target("cmd", "dir", ""), None);
    }

    #[test]
    fn recent_files_are_the_newest_files_once_each() {
        let f = |lnk: &str, path: &str, at: f64, file: bool| (lnk.to_string(), path.to_string(), at, file);
        let out = newest_files(
            vec![
                f("a.lnk", r"C:\docs\a.txt", 10.0, true),
                f("b.lnk", r"C:\docs\b.pdf", 30.0, true),
                f("dir.lnk", r"C:\docs", 40.0, false),
                f("b2.lnk", r"C:\DOCS\B.PDF", 20.0, true),
                f("gone.lnk", "", 50.0, false),
            ],
            5,
        );
        assert_eq!(out.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["b.pdf", "a.txt"]);
        assert_eq!(out[0].lnk, "b.lnk");
        assert_eq!(newest_files(vec![f("a.lnk", r"C:\a", 1.0, true), f("b.lnk", r"C:\b", 2.0, true)], 1).len(), 1);
    }
}
