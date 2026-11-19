// The taskbar (Settings › Taskbar): a pill along the bottom of the main screen in the island's own
// glass, with Start, your pinned and open apps, music and the timer, Wi-Fi, sound, the clock and
// the notification bell. The island (src/core/dock.ts) decides what it shows; this makes its
// window (always on top, never taking the focus), keeps it at the bottom of the work area (above
// Windows' taskbar while that one shows), sizes it to its content, moves it left and right as it
// is dragged, opens Windows' own panels for its buttons, and can set Windows' taskbar to hide.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors;

pub const LABEL: &str = "dock";
/// Gap between the dock and the bottom of the work area, logical px.
const GAP: f64 = 8.0;

/// Where the dock's centre sits across the screen, 0..1; negative: the middle.
static CENTRE: Mutex<f64> = Mutex::new(-1.0);
/// Which screen edge the dock sits along: bottom, left, right, top (Settings › Taskbar › Position).
static SIDE: AtomicU8 = AtomicU8::new(0);
/// Set while the dock on the top edge splits round the island: how far along the window (logical px
/// from its left) the screen's middle falls, so the island sits in the gap. Negative: not split.
static PIVOT: Mutex<f64> = Mutex::new(-1.0);
/// Island set Windows' taskbar to hide (and puts it back when Island quits).
static HID_WINDOWS_BAR: AtomicBool = AtomicBool::new(false);

/// The centre (0..1 across the work area) of a dock `pw` physical px wide whose left edge is at `x`.
pub fn centre_of(left: i32, width: i32, x: i32, pw: i32) -> f64 {
    if width <= 0 {
        return -1.0;
    }
    ((x + pw / 2 - left) as f64 / width as f64).clamp(0.0, 1.0)
}

/// The Apps card is open: the taskbar may take the keyboard (its search field).
static TYPING: AtomicBool = AtomicBool::new(false);

/// The extended style the dock needs: a tool window (never in Alt-Tab or Windows' taskbar;
/// WS_EX_APPWINDOW would put it in both) that a click doesn't activate, unless the Apps card is
/// open. The rest (click-through, topmost) is left as it is.
#[cfg(windows)]
fn wanted_ex(style: u32, typing: bool) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    let s = (style | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
    if typing {
        s & !WS_EX_NOACTIVATE.0
    } else {
        s | WS_EX_NOACTIVATE.0
    }
}

/// tao rebuilds the window's extended style from its own flags whenever it changes one (each
/// click-through switch), dropping the tool window and adding WS_EX_APPWINDOW: the taskbar showed in
/// Alt-Tab and a click on it took the focus. Every change passes through here and keeps the style
/// the dock needs (as overlay.rs does for the island).
#[cfg(windows)]
unsafe extern "system" fn keep_style(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, STYLESTRUCT, WM_STYLECHANGING};
    if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 && lparam.0 != 0 {
        let change = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
        change.styleNew = wanted_ex(change.styleNew, TYPING.load(Ordering::Relaxed));
    }
    unsafe { windows::Win32::UI::Shell::DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Puts `keep_style` on the window (on the thread that owns it, as subclassing requires), then
/// applies the style.
#[cfg(windows)]
fn guard_style(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let raw = h.0 as isize;
    let _ = win.app_handle().run_on_main_thread(move || unsafe {
        let hwnd = windows::Win32::Foundation::HWND(raw as *mut _);
        if !windows::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(keep_style), 1, 0).as_bool() {
            crate::log::line("dock: could not guard the window style");
        }
        apply_style(hwnd);
    });
}

#[cfg(windows)]
fn apply_style(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE};
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = wanted_ex(ex as u32, TYPING.load(Ordering::Relaxed)) as isize;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}

#[cfg(windows)]
fn style(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    apply_style(windows::Win32::Foundation::HWND(h.0));
}

#[cfg(not(windows))]
fn style(_win: &WebviewWindow) {}

/// The bar's margin under it inside the dock window, logical px (src/core/dock.ts: the window is the
/// bar plus 16 px and the headroom for risen icons, taller while a card is up; the bar sits 12 px above its bottom).
const BAR_BELOW: f64 = 12.0;
/// How long the dock takes to glide down to the screen's edge, or back up, ms.
const GLIDE_MS: f64 = 240.0;
/// The pointer gone from the raised dock this long, it goes back down, ms.
const LEAVE_MS: u128 = 350;

/// The size the page last asked for (logical px), to place the dock again when its mode changes.
static SIZE: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
/// The bar's part at the window's bottom (logical px): the bar, its margins and the room its icons
/// rise into. The rest of the window is room for a card over the bar.
static BAR_AREA: Mutex<f64> = Mutex::new(0.0);
/// Where the page draws something that takes clicks (logical px rects x, y, w, h in the window): the
/// bar, the Apps card while it is up. Everywhere else a click goes through to what is under it.
static SOLID: Mutex<Vec<[f64; 4]>> = Mutex::new(Vec::new());
/// The dock sits on the screen's bottom edge, over Windows' taskbar (Settings › Blend into the bottom).
static EDGE: AtomicBool = AtomicBool::new(false);
/// A full-screen app is in front: the dock waits at the screen's bottom edge, faint ...
static FULL: AtomicBool = AtomicBool::new(false);
/// ... and while the pointer is on it (or on its way up), it is raised to its usual place.
static UP: AtomicBool = AtomicBool::new(false);
/// Auto-hide (Settings › Taskbar): it waits at the edge as under a full-screen app, always.
static AUTO: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bottom,
    Left,
    Right,
    Top,
}

impl Side {
    fn from_u8(n: u8) -> Side {
        match n {
            1 => Side::Left,
            2 => Side::Right,
            3 => Side::Top,
            _ => Side::Bottom,
        }
    }
    fn parse(s: &str) -> Side {
        match s {
            "left" => Side::Left,
            "right" => Side::Right,
            "top" => Side::Top,
            _ => Side::Bottom,
        }
    }
    fn index(self) -> u8 {
        match self {
            Side::Bottom => 0,
            Side::Left => 1,
            Side::Right => 2,
            Side::Top => 3,
        }
    }
    /// Along the bottom or the top: the bar runs across the screen.
    pub fn across(self) -> bool {
        matches!(self, Side::Bottom | Side::Top)
    }
}

fn side() -> Side {
    Side::from_u8(SIDE.load(Ordering::SeqCst))
}

/// A screen's rect, physical px: (x, y, width, height).
pub type Area = (i32, i32, i32, i32);

/// Where the dock's window goes (physical x, y) on side `side` of a screen whose work area is `work`
/// and whole area `bounds`, at `pw` x `ph` physical px: its centre at `centre` along the edge (0..1,
/// negative: the middle), or with `pivot` (physical px along the window) at the edge's middle. `tucked`:
/// on the screen's very edge (Blend into the edge, or waiting there under a full-screen app), else
/// floating GAP inside the work area. The bar is BAR_BELOW inside the window's edge side.
#[allow(clippy::too_many_arguments)]
pub fn place_on(side: Side, work: Area, bounds: Area, scale: f64, pw: i32, ph: i32, centre: f64, pivot: Option<i32>, tucked: bool) -> (i32, i32) {
    let gap = (GAP * scale).round() as i32;
    let below = (BAR_BELOW * scale).round() as i32;
    let (start, len, along) = if side.across() { (work.0, work.2, pw) } else { (work.1, work.3, ph) };
    let a = match pivot {
        Some(p) => start + len / 2 - p,
        None => {
            let mid = if centre < 0.0 { start + len / 2 } else { start + (centre.min(1.0) * len as f64).round() as i32 };
            (mid - along / 2).clamp(start, (start + len - along).max(start))
        }
    };
    let b = match (side, tucked) {
        (Side::Bottom, false) => work.1 + work.3 - ph - gap,
        (Side::Bottom, true) => bounds.1 + bounds.3 - ph + below,
        (Side::Top, false) => work.1 + gap,
        (Side::Top, true) => bounds.1 - below,
        (Side::Left, false) => work.0 + gap,
        (Side::Left, true) => bounds.0 - below,
        (Side::Right, false) => work.0 + work.2 - pw - gap,
        (Side::Right, true) => bounds.0 + bounds.2 - pw + below,
    };
    if side.across() {
        (a, b)
    } else {
        (b, a)
    }
}

/// Where the dock's window goes (physical x, y, width, height) at `w` x `h` logical px, by its mode.
fn spot(w: f64, h: f64) -> Option<(i32, i32, i32, i32)> {
    spot_as(w, h, None)
}

/// As `spot`; `tucked` overrides whether it sits on the edge.
fn spot_as(w: f64, h: f64, tucked: Option<bool>) -> Option<(i32, i32, i32, i32)> {
    let m = monitors::primary()?;
    let centre = *CENTRE.lock().unwrap();
    let pivot = *PIVOT.lock().unwrap();
    let (pw, ph) = ((w.ceil() * m.scale).round() as i32, (h.ceil() * m.scale).round() as i32);
    let tucked = tucked.unwrap_or_else(|| EDGE.load(Ordering::SeqCst) || (FULL.load(Ordering::SeqCst) && !UP.load(Ordering::SeqCst)));
    let work = (m.work.x, m.work.y, m.work.width, m.work.height);
    let bounds = (m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height);
    let pivot = (pivot >= 0.0).then(|| (pivot * m.scale).round() as i32);
    let (x, y) = place_on(side(), work, bounds, m.scale, pw, ph, centre, pivot, tucked);
    Some((x, y, pw, ph))
}

/// Sizes the dock to `w` x `h` logical px and puts it where it belongs: just above the bottom of
/// the work area (above Windows' taskbar while that one shows), floating over the windows; with a
/// full-screen app in front, at the screen's bottom edge until the pointer comes to it.
fn put(win: &WebviewWindow, w: f64, h: f64) {
    *SIZE.lock().unwrap() = (w, h);
    let Some((x, y, pw, ph)) = spot(w, h) else { return };
    set_rect(win, x, y, pw, ph);
    tell(win);
}

/// The page hears whether the dock waits faint at the edge.
fn tell(win: &WebviewWindow) {
    let full = FULL.load(Ordering::SeqCst);
    let up = UP.load(Ordering::SeqCst);
    let _ = win.app_handle().emit_to(LABEL, "dock-full", serde_json::json!({ "full": full, "up": up }));
}

/// Moves and sizes the window in one step (two steps can show a frame with the new size in the old
/// place), topmost again (a full-screen game may have put itself above it) but under the island: on
/// the top edge the bar runs on behind the pill, and must never cover it.
#[cfg(windows)]
fn set_rect(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};
    let Ok(hw) = win.hwnd() else { return };
    let after = crate::frame::hwnd_of(win.app_handle(), crate::overlay::LABEL).unwrap_or(HWND_TOPMOST);
    unsafe {
        let _ = SetWindowPos(HWND(hw.0), Some(after), x, y, w, h, SWP_NOACTIVATE);
    }
}

#[cfg(not(windows))]
fn set_rect(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    let _ = win.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// The dock's window glides from where it is to (`to_x`, `to_y`) (physical px), easing out, a frame at a time.
#[cfg(windows)]
fn glide(win: &WebviewWindow, to_x: i32, to_y: i32) {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    let (Ok(at), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    if at.y == to_y && at.x == to_x {
        return;
    }
    let start = std::time::Instant::now();
    loop {
        let t = (start.elapsed().as_secs_f64() * 1000.0 / GLIDE_MS).min(1.0);
        let e = 1.0 - (1.0 - t).powi(3);
        let y = at.y + ((to_y - at.y) as f64 * e).round() as i32;
        let x = at.x + ((to_x - at.x) as f64 * e).round() as i32;
        set_rect(win, x, y, size.width as i32, size.height as i32);
        if t >= 1.0 {
            return;
        }
        // The next frame (and a guard against a DWM that doesn't wait).
        unsafe {
            let _ = DwmFlush();
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// The foreground window covers its whole screen (a game, a video, F11).
#[cfg(windows)]
fn fullscreen_in_front(own: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    let fg = crate::procs::foreground();
    if fg == 0 || fg == own {
        return false;
    }
    let class = crate::procs::class_name(fg);
    if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow") {
        return false;
    }
    // A window with a title bar isn't full-screen, even when it fills the screen (maximized while
    // Windows' taskbar hides itself); F11, games and videos drop the title bar.
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_STYLE, WS_CAPTION};
        let style = unsafe { GetWindowLongPtrW(HWND(fg as *mut _), GWL_STYLE) } as u32;
        if style & WS_CAPTION.0 == WS_CAPTION.0 {
            return false;
        }
    }
    let (Some(r), Some(m)) = (crate::procs::window_rect(fg), monitors::of_window(HWND(fg as *mut _))) else { return false };
    let b = &m.bounds;
    let covers = r.left <= b.x && r.top <= b.y && r.right >= b.x + b.width && r.bottom >= b.y + b.height;
    covers && game_or_video(fg)
}

/// Video players: full screen, they're always a video.
#[cfg(windows)]
const VIDEO_PLAYERS: &[&str] = &[
    "vlc.exe", "mpc-hc.exe", "mpc-hc64.exe", "mpc-be.exe", "mpc-be64.exe", "mpv.exe", "potplayer.exe", "potplayer64.exe",
    "potplayermini.exe", "potplayermini64.exe", "wmplayer.exe", "microsoft.media.player.exe", "video.ui.exe", "kmplayer.exe",
    "kmplayer64x.exe", "gom.exe", "smplayer.exe", "kodi.exe", "plex.exe", "plex htpc.exe", "stremio.exe", "mpvnet.exe",
];

/// Windows' list of games it has seen (Game Bar's), lower-cased exe paths, read once a minute.
#[cfg(windows)]
fn known_games() -> Vec<String> {
    static CACHE: Mutex<Option<(std::time::Instant, Vec<String>)>> = Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    if let Some((at, list)) = c.as_ref() {
        if at.elapsed().as_secs() < 60 {
            return list.clone();
        }
    }
    let mut list = Vec::new();
    if let Ok(root) = windows_registry::CURRENT_USER.open(r"System\GameConfigStore\Children") {
        if let Ok(names) = root.keys() {
            for n in names {
                if let Ok(path) = root.open(&n).and_then(|k| k.get_string("MatchedExeFullPath")) {
                    if !path.is_empty() {
                        list.push(path.to_lowercase());
                    }
                }
            }
        }
    }
    *c = Some((std::time::Instant::now(), list.clone()));
    list
}

/// Only games and videos send the taskbar down: any other app full screen keeps it in sight.
#[cfg(windows)]
fn game_or_video(fg: isize) -> bool {
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    // A game in exclusive full screen.
    if unsafe { SHQueryUserNotificationState() }.is_ok_and(|q| q == QUNS_RUNNING_D3D_FULL_SCREEN) {
        return true;
    }
    let pid = crate::procs::window_pid(fg);
    if pid == 0 {
        return false;
    }
    if crate::game::game_state().game.is_some_and(|g| g.pid == pid) {
        return true;
    }
    let Some(exe) = crate::game::exe_path(pid).map(|e| e.to_lowercase()) else { return false };
    let game = known_games().contains(&exe);
    let playing = crate::media::playing_app();
    is_game_or_video(&exe, game, playing.as_deref())
}

/// `exe`: the full-screen window's program, lower case; `known_game`: Windows lists it as a game;
/// `playing`: the app playing media now (media.rs's friendly name).
#[cfg(windows)]
fn is_game_or_video(exe: &str, known_game: bool, playing: Option<&str>) -> bool {
    if known_game || crate::game::GAME_FOLDERS.iter().any(|f| exe.contains(f)) {
        return true;
    }
    let name = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    if VIDEO_PLAYERS.contains(&name) {
        return true;
    }
    let Some(playing) = playing else { return false };
    // A browser playing (a video full screen), not one in F11 with nothing playing.
    if let Some((app, _)) = crate::media::BROWSERS.iter().find(|(_, e)| *e == name) {
        return *app == playing;
    }
    // A Store app (Netflix, Disney+, Prime Video) full screen while something plays that isn't a browser or a music app.
    name == "applicationframehost.exe" && !crate::media::BROWSERS.iter().any(|(a, _)| *a == playing) && !matches!(playing, "Spotify" | "Apple Music" | "Media Player")
}

/// The pointer is on the dock or anywhere on its way out: across the dock, from its usual inner side to
/// the screen's edge (so a raised dock doesn't drop from under a pointer at the very edge).
#[cfg(windows)]
fn pointer_near() -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let (w, h) = *SIZE.lock().unwrap();
    let Some(m) = monitors::primary() else { return false };
    let Some((x, y, pw, ph)) = spot_as(w, h, Some(false)) else { return false };
    // The bar's part only, not the room for a card over it.
    let bar = *BAR_AREA.lock().unwrap();
    let mut p = POINT::default();
    if unsafe { GetCursorPos(&mut p) }.is_err() {
        return false;
    }
    let b = &m.bounds;
    let s = m.scale;
    match side() {
        Side::Bottom => {
            let top = if bar > 0.0 && bar < h { y + ((h - bar) * s).round() as i32 } else { y };
            p.x >= x && p.x < x + pw && p.y >= top && p.y <= b.y + b.height
        }
        Side::Top => {
            let bottom = if bar > 0.0 && bar < h { y + (bar * s).round() as i32 } else { y + ph };
            p.x >= x && p.x < x + pw && p.y >= b.y && p.y <= bottom
        }
        Side::Left => {
            let right = if bar > 0.0 && bar < w { x + (bar * s).round() as i32 } else { x + pw };
            p.y >= y && p.y < y + ph && p.x >= b.x && p.x <= right
        }
        Side::Right => {
            let left = if bar > 0.0 && bar < w { x + ((w - bar) * s).round() as i32 } else { x };
            p.y >= y && p.y < y + ph && p.x >= left && p.x <= b.x + b.width
        }
    }
}

static WATCHER: AtomicBool = AtomicBool::new(false);

/// While the dock exists: with a full-screen app in front it glides down to the screen's bottom
/// edge and goes faint; the pointer coming to it glides it back up, and it works as usual there.
fn watch_fullscreen(app: AppHandle) {
    if WATCHER.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut away: Option<std::time::Instant> = None;
        loop {
            let full = FULL.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(if full { 30 } else { 300 }));
            let Some(win) = app.get_webview_window(LABEL) else {
                WATCHER.store(false, Ordering::SeqCst);
                FULL.store(false, Ordering::SeqCst);
                UP.store(false, Ordering::SeqCst);
                return;
            };
            #[cfg(windows)]
            {
                let own = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                let now = AUTO.load(Ordering::SeqCst) || fullscreen_in_front(own);
                let up = UP.load(Ordering::SeqCst);
                let want_up = now && {
                    if pointer_near() {
                        away = None;
                        true
                    } else if up {
                        // A moment's grace before it goes back down.
                        let since = *away.get_or_insert_with(std::time::Instant::now);
                        since.elapsed().as_millis() < LEAVE_MS
                    } else {
                        false
                    }
                };
                if now != full || want_up != up {
                    FULL.store(now, Ordering::SeqCst);
                    UP.store(want_up, Ordering::SeqCst);
                    if !want_up {
                        away = None;
                    }
                    tell(&win);
                    let (w, h) = *SIZE.lock().unwrap();
                    if let Some((x, y, _, _)) = spot(w, h) {
                        glide(&win, x, y);
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = (&win, &mut away, full);
        }
    });
}

/// Shows the dock at `w` x `h` logical px with its centre at `centre` (0..1 across the screen,
/// negative: the middle), making its window the first time, or closes it. Built off the calling
/// thread, as building a window on the event loop deadlocks WebView2.
#[tauri::command]
pub fn dock_show(app: AppHandle, on: bool, w: f64, h: f64, centre: f64) {
    *CENTRE.lock().unwrap() = if centre.is_finite() { centre } else { -1.0 };
    std::thread::spawn(move || {
        if !on {
            if let Some(win) = app.get_webview_window(LABEL) {
                let _ = win.destroy();
            }
            return;
        }
        let (w, h) = (w.clamp(32.0, 2400.0), h.clamp(32.0, 2400.0));
        if let Some(win) = app.get_webview_window(LABEL) {
            put(&win, w, h);
            return;
        }
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Island taskbar")
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
            .inner_size(w, h)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build();
        match built {
            Ok(win) => {
                style(&win);
                put(&win, w, h);
                let _ = win.show();
                #[cfg(windows)]
                guard_style(&win);
                #[cfg(not(windows))]
                style(&win);
                watch_fullscreen(app.clone());
                watch_pointer(app.clone());
            }
            Err(e) => crate::log::line(format!("dock failed: {e}")),
        }
    });
}

/// The dock page measured its content: the window takes that size and stays in its place. `bar`: the
/// bar's part at the edge side (the rest is room for a card over it). `pivot`: on the top edge split
/// round the island, where the screen's middle falls along the window (logical px); else none.
#[tauri::command]
pub fn dock_fit(window: WebviewWindow, w: f64, h: f64, bar: Option<f64>, pivot: Option<f64>) {
    if window.label() != LABEL || !w.is_finite() || !h.is_finite() {
        return;
    }
    if let Some(b) = bar.filter(|b| b.is_finite() && *b > 0.0) {
        *BAR_AREA.lock().unwrap() = b;
    }
    *PIVOT.lock().unwrap() = pivot.filter(|p| p.is_finite() && *p >= 0.0).unwrap_or(-1.0);
    // Taller (or wider, on a side) while a card is up over the bar.
    put(&window, w.clamp(32.0, 2400.0), h.clamp(32.0, 2400.0));
}

/// Which edge the dock sits along: "bottom", "left", "right" or "top".
#[tauri::command]
pub fn dock_side(app: AppHandle, side: String) {
    let s = Side::parse(&side);
    if SIDE.swap(s.index(), Ordering::SeqCst) == s.index() {
        return;
    }
    // Its place along the old edge means nothing on the new one.
    *CENTRE.lock().unwrap() = -1.0;
    if let Some(win) = app.get_webview_window(LABEL) {
        let (w, h) = *SIZE.lock().unwrap();
        if w > 0.0 && h > 0.0 {
            put(&win, w, h);
        }
    }
}

/// The Apps card is open over the bar (`on`): the taskbar takes the keyboard (for its search field,
/// Esc, and so a click anywhere else closes the card). Closed: it never takes it again.
#[cfg(windows)]
#[tauri::command]
pub fn dock_typing(window: WebviewWindow, on: bool) {
    if window.label() != LABEL {
        return;
    }
    TYPING.store(on, Ordering::Relaxed);
    let Ok(h) = window.hwnd() else { return };
    let hwnd = windows::Win32::Foundation::HWND(h.0);
    apply_style(hwnd);
    if on {
        // The arrow was just clicked, so Windows lets this window come to the front.
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd) };
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dock_typing(_window: WebviewWindow, _on: bool) {}

/// Where the page draws something that takes clicks (logical px rects [x, y, w, h] in the window).
#[tauri::command]
pub fn dock_solid(rects: Vec<Vec<f64>>) {
    let clean: Vec<[f64; 4]> = rects.iter().filter(|r| r.len() == 4 && r.iter().all(|n| n.is_finite())).map(|r| [r[0], r[1], r[2], r[3]]).take(8).collect();
    *SOLID.lock().unwrap() = clean;
}

/// A full-screen game or video is in front and the taskbar waits faint at the edge (the screen
/// border goes meanwhile).
pub fn full() -> bool {
    FULL.load(Ordering::SeqCst) && !UP.load(Ordering::SeqCst)
}

/// On the screen's bottom edge (over Windows' taskbar), or floating above it as usual.
#[tauri::command]
pub fn dock_edge(app: AppHandle, on: bool) {
    if EDGE.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        let (w, h) = *SIZE.lock().unwrap();
        if w > 0.0 && h > 0.0 {
            put(&win, w, h);
        }
    }
}

/// Auto-hide on or off: the watcher tucks the dock at its edge until the pointer comes (watch_fullscreen).
#[tauri::command]
pub fn dock_auto(on: bool) {
    AUTO.store(on, Ordering::SeqCst);
}

/// `(x, y)` (logical px in the window) is on something the page drew that takes clicks.
pub fn solid_at(rects: &[[f64; 4]], x: f64, y: f64) -> bool {
    rects.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
}

static POINTER_WATCH: AtomicBool = AtomicBool::new(false);

/// While the dock exists: the window takes clicks only on what the page drew there (the bar, a card),
/// so the room over the bar for a card never blocks the windows under it. Not while a button is held
/// (a drag keeps going wherever the pointer goes). On the bottom edge, it also stays over Windows'
/// taskbar, which puts itself on top when it slides up.
#[cfg(windows)]
fn watch_pointer(app: AppHandle) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
    if POINTER_WATCH.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut taking: Option<bool> = None;
        let mut tick = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Some(win) = app.get_webview_window(LABEL) else {
                POINTER_WATCH.store(false, Ordering::SeqCst);
                return;
            };
            let Ok(h) = win.hwnd() else { continue };
            let hwnd = HWND(h.0);
            tick = tick.wrapping_add(1);
            if EDGE.load(Ordering::SeqCst) && !FULL.load(Ordering::SeqCst) && tick % 15 == 0 {
                // Over Windows' taskbar (it puts itself on top when it slides up), under the island, over
                // the screen border (frame.rs restack).
                crate::frame::restack(&app);
            }
            let held = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000 != 0) };
            if held && taking == Some(true) {
                continue;
            }
            let mut p = POINT::default();
            let mut r = RECT::default();
            if unsafe { GetCursorPos(&mut p) }.is_err() || unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
                continue;
            }
            let scale = match unsafe { GetDpiForWindow(hwnd) } {
                0 => 1.0,
                dpi => dpi as f64 / 96.0,
            };
            let (x, y) = ((p.x - r.left) as f64 / scale, (p.y - r.top) as f64 / scale);
            let on = solid_at(&SOLID.lock().unwrap(), x, y);
            if taking != Some(on) {
                taking = Some(on);
                let _ = win.set_ignore_cursor_events(!on);
            }
        }
    });
}

#[cfg(not(windows))]
fn watch_pointer(_app: AppHandle) {}

/// Dragging the dock: its start (left edge, or top edge on a side) to `x` (physical px), along its edge
/// only. `done`: the drag ended, so its place is kept and the island told (`dock-moved`). `x` negative
/// with `done`: back to the middle (a double-click).
#[tauri::command]
pub fn dock_at(app: AppHandle, window: WebviewWindow, x: f64, done: bool) {
    if window.label() != LABEL {
        return;
    }
    let (Some(m), Ok(at), Ok(size)) = (monitors::primary(), window.outer_position(), window.outer_size()) else { return };
    let across = side().across();
    let (start, len, along, now) = if across { (m.work.x, m.work.width, size.width as i32, at.x) } else { (m.work.y, m.work.height, size.height as i32, at.y) };
    if done && x < 0.0 {
        *CENTRE.lock().unwrap() = -1.0;
    } else if x.is_finite() {
        let n = (x.round() as i32).clamp(start, (start + len - along).max(start));
        if n != now {
            let to = if across { PhysicalPosition::new(n, at.y) } else { PhysicalPosition::new(at.x, n) };
            let _ = window.set_position(to);
        }
        if !done {
            return;
        }
        *CENTRE.lock().unwrap() = centre_of(start, len, n, along);
    }
    if let Ok(s) = window.inner_size() {
        let scale = window.scale_factor().unwrap_or(m.scale);
        put(&window, s.width as f64 / scale, s.height as f64 / scale);
    }
    let centre = *CENTRE.lock().unwrap();
    let _ = app.emit_to(crate::overlay::LABEL, "dock-moved", serde_json::json!({ "centre": centre }));
}

/// The panels Windows opens from its own taskbar: Start (Win), Quick Settings (Win+A, Wi-Fi and
/// sound) and the notifications (Win+N).
#[cfg(windows)]
#[tauri::command]
pub fn dock_panel(which: String) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN};
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
    };
    let letter = match which.as_str() {
        "start" => None,
        "quick" => Some(VIRTUAL_KEY(0x41)),
        "notifications" => Some(VIRTUAL_KEY(0x4E)),
        _ => return false,
    };
    let inputs: Vec<INPUT> = match letter {
        None => vec![key(VK_LWIN, false), key(VK_LWIN, true)],
        Some(k) => vec![key(VK_LWIN, false), key(k, false), key(k, true), key(VK_LWIN, true)],
    };
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dock_panel(_which: String) -> bool {
    false
}

#[cfg(windows)]
fn set_autohide(on: bool) -> bool {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA};
    unsafe {
        let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, ..Default::default() };
        let state = SHAppBarMessage(ABM_GETSTATE, &mut d) as u32;
        let want = if on { state | ABS_AUTOHIDE } else { state & !ABS_AUTOHIDE };
        if want != state {
            d.lParam = LPARAM(want as isize);
            SHAppBarMessage(ABM_SETSTATE, &mut d);
        }
        (SHAppBarMessage(ABM_GETSTATE, &mut d) as u32) & ABS_AUTOHIDE != 0
    }
}

/// Sets Windows' own taskbar to hide itself (or show again), as Settings › Personalization ›
/// Taskbar › Automatically hide the taskbar does. The island only asks to show it again when it
/// (in this run or one before) was the one that hid it. Answers whether it hides now.
#[cfg(windows)]
#[tauri::command]
pub fn dock_autohide(on: bool) -> bool {
    HID_WINDOWS_BAR.store(on, Ordering::SeqCst);
    set_autohide(on)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dock_autohide(_on: bool) -> bool {
    false
}

/// Island is quitting: Windows' taskbar comes back if Island hid it.
pub fn quit(_app: &AppHandle) {
    #[cfg(windows)]
    if HID_WINDOWS_BAR.swap(false, Ordering::SeqCst) {
        set_autohide(false);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn only_games_and_videos_count_as_full_screen() {
        use super::is_game_or_video as gv;
        // Games: from a store's folder, or one Windows lists.
        assert!(gv(r"d:\steamlibrary\steamapps\common\hades\hades.exe", false, None));
        assert!(gv(r"c:\games\minecraft\javaw.exe", true, None));
        // Video players, playing or not.
        assert!(gv(r"c:\program files\videolan\vlc\vlc.exe", false, None));
        // A browser: a video only while it plays something.
        assert!(gv(r"c:\program files\google\chrome\application\chrome.exe", false, Some("Chrome")));
        assert!(!gv(r"c:\program files\google\chrome\application\chrome.exe", false, None));
        assert!(!gv(r"c:\program files\google\chrome\application\chrome.exe", false, Some("Spotify")));
        // Store video apps while something plays, not music.
        assert!(gv(r"c:\windows\system32\applicationframehost.exe", false, Some("Netflix")));
        assert!(!gv(r"c:\windows\system32\applicationframehost.exe", false, Some("Spotify")));
        // Everything else Moss uses full screen keeps the taskbar.
        assert!(!gv(r"c:\users\x\appdata\local\programs\microsoft vs code\code.exe", false, Some("Spotify")));
        assert!(!gv(r"c:\program files\windowsapps\notion.exe", false, None));
    }

    use super::{centre_of, place_on, Side};

    const WORK: super::Area = (0, 0, 1920, 1032);
    const SCREEN: super::Area = (0, 0, 1920, 1080);

    #[test]
    fn the_dock_sits_centred_just_inside_the_work_area_on_its_side() {
        // A 600 x 64 window at the bottom, 8 px over the work area's end.
        assert_eq!(place_on(Side::Bottom, WORK, SCREEN, 1.0, 600, 64, -1.0, None, false), (660, 1032 - 64 - 8));
        // A 125 % screen counts physical pixels.
        assert_eq!(place_on(Side::Bottom, (0, 0, 1920, 1020), SCREEN, 1.25, 750, 80, -1.0, None, false), (585, 1020 - 80 - 10));
        assert_eq!(place_on(Side::Top, WORK, SCREEN, 1.0, 600, 64, -1.0, None, false), (660, 8));
        // On a side the window stands upright, centred down the work area.
        assert_eq!(place_on(Side::Left, WORK, SCREEN, 1.0, 64, 600, -1.0, None, false), (8, 216));
        assert_eq!(place_on(Side::Right, WORK, SCREEN, 1.0, 64, 600, -1.0, None, false), (1920 - 64 - 8, 216));
    }

    #[test]
    fn on_the_edge_the_bar_sits_on_the_screens_edge() {
        // The bar is 12 px inside the window's edge side; the window reaches past the screen by that.
        assert_eq!(place_on(Side::Bottom, WORK, SCREEN, 1.0, 600, 82, -1.0, None, true).1, 1080 - 82 + 12);
        assert_eq!(place_on(Side::Bottom, WORK, SCREEN, 1.25, 600, 103, -1.0, None, true).1, 1080 - 103 + 15);
        assert_eq!(place_on(Side::Top, WORK, SCREEN, 1.0, 600, 82, -1.0, None, true).1, -12);
        assert_eq!(place_on(Side::Left, WORK, SCREEN, 1.0, 82, 600, -1.0, None, true).0, -12);
        assert_eq!(place_on(Side::Right, WORK, SCREEN, 1.0, 82, 600, -1.0, None, true).0, 1920 - 82 + 12);
    }

    #[test]
    fn split_round_the_island_its_gap_sits_on_the_screens_middle() {
        assert_eq!(place_on(Side::Top, WORK, SCREEN, 1.0, 1200, 82, 0.3, Some(500), true).0, 960 - 500);
    }

    #[test]
    fn a_dragged_dock_keeps_its_place_and_never_leaves_the_screen() {
        let at = |c: f64| place_on(Side::Bottom, SCREEN, SCREEN, 1.0, 600, 56, c, None, false).0;
        assert_eq!(at(0.25), 180);
        assert_eq!(at(0.0), 0);
        assert_eq!(at(1.0), 1320);
        assert_eq!(place_on(Side::Left, SCREEN, SCREEN, 1.0, 56, 600, 0.0, None, false).1, 0);
        assert_eq!(centre_of(0, 1920, 180, 600), 0.25);
        assert_eq!(centre_of(0, 1920, -50, 600), 0.130_208_333_333_333_34);
    }
}
