// The taskbar (Settings › Taskbar): a pill along the bottom of the main screen in the island's own
// glass, with Start, your pinned and open apps, music and the timer, Wi-Fi, sound, the clock and
// the notification bell. The island (src/core/dock.ts) decides what it shows; this makes its
// window (always on top, never taking the focus), keeps it at the bottom of the work area (above
// Windows' taskbar while that one shows), sizes it to its content, moves it left and right as it
// is dragged, opens Windows' own panels for its buttons, and can set Windows' taskbar to hide.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors;

pub const LABEL: &str = "dock";
/// Gap between the dock and the bottom of the work area, logical px.
const GAP: f64 = 8.0;

/// Where the dock's centre sits across the screen, 0..1; negative: the middle.
static CENTRE: Mutex<f64> = Mutex::new(-1.0);
/// Island set Windows' taskbar to hide (and puts it back when Island quits).
static HID_WINDOWS_BAR: AtomicBool = AtomicBool::new(false);

/// The dock's top-left corner (physical px) for a window `w` x `h` logical px on a screen whose
/// work area starts at `left`, is `width` wide and ends at `bottom`, its centre at `centre` (0..1,
/// negative: the middle). It never leaves the screen.
pub fn place(left: i32, width: i32, bottom: i32, scale: f64, w: f64, h: f64, centre: f64) -> (i32, i32) {
    let pw = (w * scale).round() as i32;
    let ph = ((h + GAP) * scale).round() as i32;
    let mid = if centre < 0.0 { left + width / 2 } else { left + (centre.min(1.0) * width as f64).round() as i32 };
    let x = (mid - pw / 2).clamp(left, (left + width - pw).max(left));
    (x, bottom - ph)
}

/// The centre (0..1 across the work area) of a dock `pw` physical px wide whose left edge is at `x`.
pub fn centre_of(left: i32, width: i32, x: i32, pw: i32) -> f64 {
    if width <= 0 {
        return -1.0;
    }
    ((x + pw / 2 - left) as f64 / width as f64).clamp(0.0, 1.0)
}

#[cfg(windows)]
fn style(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let hwnd = HWND(h.0);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let want = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
        }
    }
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

/// The dock window's top (physical px) while it waits at the bottom of a screen ending at `bottom`:
/// the bar's bottom on the screen's edge. `ph`: the window's height.
pub fn tucked_y(bottom: i32, ph: i32, scale: f64) -> i32 {
    bottom - ph + (BAR_BELOW * scale).round() as i32
}

/// Where the dock's window goes (physical x, y, width, height) at `w` x `h` logical px, by its mode.
fn spot(w: f64, h: f64) -> Option<(i32, i32, i32, i32)> {
    let m = monitors::primary()?;
    let centre = *CENTRE.lock().unwrap();
    let (x, y) = place(m.work.x, m.work.width, m.work.y + m.work.height, m.scale, w, h, centre);
    let (pw, ph) = ((w.ceil() * m.scale).round() as i32, (h.ceil() * m.scale).round() as i32);
    let tucked = tucked_y(m.bounds.y + m.bounds.height, ph, m.scale);
    let y = if EDGE.load(Ordering::SeqCst) {
        tucked
    } else if FULL.load(Ordering::SeqCst) && !UP.load(Ordering::SeqCst) {
        tucked.max(y)
    } else {
        y
    };
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
/// place), topmost again (a full-screen game may have put itself above it).
#[cfg(windows)]
fn set_rect(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};
    let Ok(hw) = win.hwnd() else { return };
    unsafe {
        let _ = SetWindowPos(HWND(hw.0), Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
    }
}

#[cfg(not(windows))]
fn set_rect(win: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    let _ = win.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// The dock's window glides from where it is to `to_y` (physical px), easing out, a frame at a time.
#[cfg(windows)]
fn glide(win: &WebviewWindow, to_y: i32) {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    let (Ok(at), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    if at.y == to_y {
        return;
    }
    let start = std::time::Instant::now();
    loop {
        let t = (start.elapsed().as_secs_f64() * 1000.0 / GLIDE_MS).min(1.0);
        let e = 1.0 - (1.0 - t).powi(3);
        let y = at.y + ((to_y - at.y) as f64 * e).round() as i32;
        set_rect(win, at.x, y, size.width as i32, size.height as i32);
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

/// The pointer is on the dock or anywhere on its way up: across the dock, from its usual top to the
/// screen's bottom edge (so a raised dock doesn't drop from under a pointer at the very bottom).
#[cfg(windows)]
fn pointer_near() -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let (w, h) = *SIZE.lock().unwrap();
    let Some(m) = monitors::primary() else { return false };
    let centre = *CENTRE.lock().unwrap();
    let (x, y) = place(m.work.x, m.work.width, m.work.y + m.work.height, m.scale, w, h, centre);
    // The bar's part only, not the room for a card over it.
    let bar = *BAR_AREA.lock().unwrap();
    let y = if bar > 0.0 && bar < h { y + ((h - bar) * m.scale).round() as i32 } else { y };
    let pw = (w.ceil() * m.scale).round() as i32;
    let mut p = POINT::default();
    if unsafe { GetCursorPos(&mut p) }.is_err() {
        return false;
    }
    p.x >= x && p.x < x + pw && p.y >= y && p.y <= m.bounds.y + m.bounds.height
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
                let now = fullscreen_in_front(own);
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
                    if let Some((_, y, _, _)) = spot(w, h) {
                        glide(&win, y);
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
        let (w, h) = (w.clamp(120.0, 1800.0), h.clamp(32.0, 120.0));
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
                style(&win);
                watch_fullscreen(app.clone());
                watch_pointer(app.clone());
            }
            Err(e) => crate::log::line(format!("dock failed: {e}")),
        }
    });
}

/// The dock page measured its content: the window takes that size and stays in its place. `bar`: the
/// bar's part at the bottom (the rest is room for a card over it).
#[tauri::command]
pub fn dock_fit(window: WebviewWindow, w: f64, h: f64, bar: Option<f64>) {
    if window.label() != LABEL || !w.is_finite() || !h.is_finite() {
        return;
    }
    if let Some(b) = bar.filter(|b| b.is_finite() && *b > 0.0) {
        *BAR_AREA.lock().unwrap() = b;
    }
    // Taller while a card is up over the bar (the Apps card, when S/W reset).
    put(&window, w.clamp(120.0, 1800.0), h.clamp(32.0, 720.0));
}

/// The Apps card is open over the bar (`on`): the taskbar takes the keyboard (for its search field,
/// Esc, and so a click anywhere else closes the card). Closed: it never takes it again.
#[cfg(windows)]
#[tauri::command]
pub fn dock_typing(window: WebviewWindow, on: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};
    if window.label() != LABEL {
        return;
    }
    if !on {
        style(&window);
        return;
    }
    let Ok(h) = window.hwnd() else { return };
    unsafe {
        let hwnd = HWND(h.0);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_NOACTIVATE.0 != 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & !WS_EX_NOACTIVATE.0) as isize);
        }
        // The arrow was just clicked, so Windows lets this window come to the front.
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
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
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
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
                unsafe {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
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

/// Dragging the dock: its left edge to `x` (physical px), along the bottom only. `done`: the drag
/// ended, so its place is kept and the island told (`dock-moved`). `x` negative with `done`:
/// back to the middle (a double-click).
#[tauri::command]
pub fn dock_at(app: AppHandle, window: WebviewWindow, x: f64, done: bool) {
    if window.label() != LABEL {
        return;
    }
    let (Some(m), Ok(at), Ok(size)) = (monitors::primary(), window.outer_position(), window.outer_size()) else { return };
    let pw = size.width as i32;
    let (left, width) = (m.work.x, m.work.width);
    if done && x < 0.0 {
        *CENTRE.lock().unwrap() = -1.0;
    } else if x.is_finite() {
        let nx = (x.round() as i32).clamp(left, (left + width - pw).max(left));
        if nx != at.x {
            let _ = window.set_position(PhysicalPosition::new(nx, at.y));
        }
        if !done {
            return;
        }
        *CENTRE.lock().unwrap() = centre_of(left, width, nx, pw);
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

    use super::{centre_of, place};

    #[test]
    fn clicks_land_only_on_what_the_page_drew() {
        let rects = [[10.0, 480.0, 600.0, 82.0], [12.0, 100.0, 380.0, 370.0]];
        assert!(super::solid_at(&rects, 300.0, 520.0), "on the bar");
        assert!(super::solid_at(&rects, 100.0, 200.0), "on the card");
        assert!(!super::solid_at(&rects, 500.0, 200.0), "beside the card: through to the window under it");
        assert!(!super::solid_at(&[], 300.0, 520.0), "nothing drawn yet");
    }

    #[test]
    fn the_dock_sits_centred_just_above_the_bottom_of_the_work_area() {
        assert_eq!(place(0, 1920, 1032, 1.0, 600.0, 56.0, -1.0), (660, 1032 - 64));
        // A 125 % screen counts physical pixels.
        assert_eq!(place(0, 1920, 1020, 1.25, 600.0, 56.0, -1.0), (585, 1020 - 80));
    }

    #[test]
    fn waiting_at_the_edge_the_bar_sits_on_the_screens_bottom() {
        // An 82 px window at 125 %: 103 px tall, its bar 15 px above the window's bottom.
        assert_eq!(super::tucked_y(1080, 103, 1.25), 1080 - 103 + 15);
        assert_eq!(super::tucked_y(1080, 82, 1.0), 1080 - 82 + 12);
    }

    #[test]
    fn a_dragged_dock_keeps_its_place_and_never_leaves_the_screen() {
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 0.25), (180, 1016));
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 0.0), (0, 1016));
        assert_eq!(place(0, 1920, 1080, 1.0, 600.0, 56.0, 1.0), (1320, 1016));
        assert_eq!(centre_of(0, 1920, 180, 600), 0.25);
        assert_eq!(centre_of(0, 1920, -50, 600), 0.130_208_333_333_333_34);
    }
}
