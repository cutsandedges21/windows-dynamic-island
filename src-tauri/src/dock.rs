// The taskbar (Settings › Taskbar): a pill along the bottom of the main screen in the island's own
// glass, with Start, your pinned and open apps, music and the timer, Wi-Fi, sound, the clock and
// the notification bell. The island (src/core/dock.ts) decides what it shows; this makes its
// window (always on top, never taking the focus), keeps it at the bottom of the work area (above
// Windows' taskbar while that one shows), sizes it to its content, moves it left and right as it
// is dragged, opens Windows' own panels for its buttons, and can set Windows' taskbar to hide.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::monitors::{self, MonitorInfo};

/// The taskbar on the main screen. Every other screen has its own, labelled `dock-<its device>`
/// (`dock-DISPLAY2`): the same page, each drawn from the frames the island sends them all.
pub const LABEL: &str = "dock";
const PREFIX: &str = "dock-";
/// Gap between the dock and the bottom of the work area, logical px.
const GAP: f64 = 8.0;

/// A window label is one of the taskbars.
pub fn is_dock(label: &str) -> bool {
    label == LABEL || label.starts_with(PREFIX)
}

/// The taskbar windows there are now.
pub fn labels(app: &AppHandle) -> Vec<String> {
    let mut list: Vec<String> = app.webview_windows().into_keys().filter(|l| is_dock(l)).collect();
    list.sort();
    list
}

/// An event to every taskbar.
pub fn emit_all<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    for l in labels(app) {
        let _ = app.emit_to(l.as_str(), event, payload.clone());
    }
}

/// One screen's taskbar: what its window was told and where it is.
#[derive(Clone, Debug)]
struct Bar {
    /// The screen it is on (monitors.rs id).
    monitor: String,
    /// Where its centre sits along its edge, 0..1; negative: the middle.
    centre: f64,
    /// The size the page last asked for (logical px), to place it again when its mode changes.
    size: (f64, f64),
    /// The bar's part at the window's edge side (logical px): the bar, its margins and the room its icons
    /// rise into. The rest of the window is room for a card over the bar.
    bar_area: f64,
    /// Where the page draws something that takes clicks (logical px rects x, y, w, h in the window): the
    /// bar, the Apps card while it is up. Everywhere else a click goes through to what is under it.
    solid: Vec<[f64; 4]>,
    /// Set while the dock on the top edge splits round the island: how far along the window (logical px
    /// from its left) the screen's middle falls, so the island sits in the gap. Negative: not split.
    pivot: f64,
    /// A full-screen app is in front on its screen: it waits at the screen's edge, faint ...
    full: bool,
    /// ... and while the pointer is on it (or on its way up), it is raised to its usual place.
    up: bool,
}

impl Bar {
    fn new(monitor: String, centre: f64) -> Self {
        Bar { monitor, centre, size: (0.0, 0.0), bar_area: 0.0, solid: Vec::new(), pivot: -1.0, full: false, up: false }
    }
}

/// Every taskbar, by its window's label.
static BARS: Mutex<BTreeMap<String, Bar>> = Mutex::new(BTreeMap::new());
/// Where each screen's taskbar was dragged to (0..1 along its edge), by screen: Settings keeps them.
static CENTRES: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);
/// A taskbar on every screen (Settings › Taskbar › Show on), or on the main one only.
static ALL_SCREENS: AtomicBool = AtomicBool::new(true);

fn bar(label: &str) -> Option<Bar> {
    BARS.lock().unwrap().get(label).cloned()
}

fn with_bar<R>(label: &str, f: impl FnOnce(&mut Bar) -> R) -> Option<R> {
    BARS.lock().unwrap().get_mut(label).map(f)
}

/// The screen a taskbar is on (the main one for `dock` until told otherwise).
fn monitor_of(label: &str) -> Option<MonitorInfo> {
    match bar(label) {
        Some(b) => monitors::find(&b.monitor).or_else(|| if label == LABEL { monitors::primary() } else { None }),
        None if label == LABEL => monitors::primary(),
        None => None,
    }
}

/// The label for the taskbar on screen `id` (`\\.\DISPLAY2` → `dock-DISPLAY2`): labels take letters,
/// digits and `-`.
pub fn label_for(id: &str, primary: bool) -> String {
    if primary {
        return LABEL.to_string();
    }
    let tail: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("{PREFIX}{tail}")
}

/// Which taskbar goes on which screen: the main screen's first; the others only with `all`.
fn layout(screens: &[MonitorInfo], all: bool) -> Vec<(String, MonitorInfo)> {
    let main = screens.iter().position(|m| m.primary).unwrap_or(0);
    let mut out = Vec::new();
    for (i, m) in screens.iter().enumerate() {
        if i == main {
            out.insert(0, (LABEL.to_string(), m.clone()));
        } else if all {
            out.push((label_for(&m.id, false), m.clone()));
        }
    }
    out
}

/// Which screen edge the dock sits along: bottom, left, right, top (Settings › Taskbar › Position).
static SIDE: AtomicU8 = AtomicU8::new(0);
/// Island set Windows' taskbar to hide (and puts it back when Island quits).
static HID_WINDOWS_BAR: AtomicBool = AtomicBool::new(false);

/// The centre (0..1 across the work area) of a dock `pw` physical px wide whose left edge is at `x`.
pub fn centre_of(left: i32, width: i32, x: i32, pw: i32) -> f64 {
    if width <= 0 {
        return -1.0;
    }
    ((x + pw / 2 - left) as f64 / width as f64).clamp(0.0, 1.0)
}

/// The taskbar whose Apps card is open (its window handle; 0: none): it may take the keyboard (its search field).
#[cfg(windows)]
static TYPING: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Window `hwnd` is the taskbar with its Apps card open.
#[cfg(windows)]
fn typing(hwnd: isize) -> bool {
    hwnd != 0 && TYPING.load(Ordering::Relaxed) == hwnd
}

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
        change.styleNew = wanted_ex(change.styleNew, typing(hwnd.0 as isize));
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
        let want = wanted_ex(ex as u32, typing(hwnd.0 as isize)) as isize;
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

/// The dock sits on the screen's bottom edge, over Windows' taskbar (Settings › Blend into the bottom).
static EDGE: AtomicBool = AtomicBool::new(false);
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
fn spot(label: &str, w: f64, h: f64) -> Option<(i32, i32, i32, i32)> {
    spot_as(label, w, h, None)
}

/// As `spot`; `tucked` overrides whether it sits on the edge.
fn spot_as(label: &str, w: f64, h: f64, tucked: Option<bool>) -> Option<(i32, i32, i32, i32)> {
    let m = monitor_of(label)?;
    let b = bar(label).unwrap_or_else(|| Bar::new(m.id.clone(), -1.0));
    let (centre, pivot) = (b.centre, b.pivot);
    let (pw, ph) = ((w.ceil() * m.scale).round() as i32, (h.ceil() * m.scale).round() as i32);
    let tucked = tucked.unwrap_or_else(|| EDGE.load(Ordering::SeqCst) || (b.full && !b.up));
    // Against the work area as it is without the strip held for it (Keep windows clear), which it sits in.
    let work = work_without_room(label, (m.work.x, m.work.y, m.work.width, m.work.height));
    let bounds = (m.bounds.x, m.bounds.y, m.bounds.width, m.bounds.height);
    let pivot = (pivot >= 0.0).then(|| (pivot * m.scale).round() as i32);
    let (x, y) = place_on(side(), work, bounds, m.scale, pw, ph, centre, pivot, tucked);
    Some((x, y, pw, ph))
}

/// Sizes the dock to `w` x `h` logical px and puts it where it belongs: just above the bottom of
/// the work area (above Windows' taskbar while that one shows), floating over the windows; with a
/// full-screen app in front, at the screen's bottom edge until the pointer comes to it.
fn put(win: &WebviewWindow, w: f64, h: f64) {
    let label = win.label().to_string();
    with_bar(&label, |b| b.size = (w, h));
    hold_room(win, false);
    let Some((x, y, pw, ph)) = spot(&label, w, h) else { return };
    set_rect(win, x, y, pw, ph);
    tell(win);
}

/// The page hears whether the dock waits faint at the edge.
fn tell(win: &WebviewWindow) {
    let (full, up) = bar(win.label()).map(|b| (b.full, b.up)).unwrap_or((false, false));
    let _ = win.app_handle().emit_to(win.label(), "dock-full", serde_json::json!({ "full": full, "up": up }));
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

/// The foreground window covers its whole screen, screen `screen` (a game, a video, F11).
#[cfg(windows)]
fn fullscreen_in_front(own: isize, screen: &str) -> bool {
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
    if m.id != screen {
        return false;
    }
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
fn pointer_near(label: &str) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let Some(b) = bar(label) else { return false };
    let (w, h) = b.size;
    let Some(m) = monitor_of(label) else { return false };
    let Some((x, y, pw, ph)) = spot_as(label, w, h, Some(false)) else { return false };
    // The bar's part only, not the room for a card over it.
    let bar = b.bar_area;
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

/// The taskbars whose watcher threads run (watch_fullscreen, watch_pointer), by label.
static WATCHING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Marks a watcher of `kind` for `label` as running; false if one already is.
fn start_watch(kind: &str, label: &str) -> bool {
    WATCHING.lock().unwrap().get_or_insert_with(HashSet::new).insert(format!("{kind}:{label}"))
}

fn end_watch(kind: &str, label: &str) {
    if let Some(set) = WATCHING.lock().unwrap().as_mut() {
        set.remove(&format!("{kind}:{label}"));
    }
}

/// While taskbar `label` exists: with a full-screen app in front on its screen it glides down to the
/// screen's edge and goes faint; the pointer coming to it glides it back up, and it works as usual there.
fn watch_fullscreen(app: AppHandle, label: String) {
    if !start_watch("full", &label) {
        return;
    }
    std::thread::spawn(move || {
        let mut away: Option<std::time::Instant> = None;
        let mut room_check = std::time::Instant::now();
        loop {
            let full = bar(&label).is_some_and(|b| b.full);
            std::thread::sleep(std::time::Duration::from_millis(if full { 30 } else { 300 }));
            let (Some(win), Some(b)) = (app.get_webview_window(&label), bar(&label)) else {
                end_watch("full", &label);
                with_bar(&label, |b| {
                    b.full = false;
                    b.up = false;
                });
                return;
            };
            if room_check.elapsed().as_millis() >= 1000 {
                room_check = std::time::Instant::now();
                keep_room(&win);
            }
            #[cfg(windows)]
            {
                let own = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                let now = AUTO.load(Ordering::SeqCst) || fullscreen_in_front(own, &b.monitor);
                let up = b.up;
                let want_up = now && {
                    if pointer_near(&label) {
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
                if now != b.full || want_up != up {
                    with_bar(&label, |b| {
                        b.full = now;
                        b.up = want_up;
                    });
                    if !want_up {
                        away = None;
                    }
                    tell(&win);
                    let (w, h) = b.size;
                    if let Some((x, y, _, _)) = spot(&label, w, h) {
                        glide(&win, x, y);
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = (&win, &mut away, full, &b);
        }
    });
}

/// A taskbar and the screen it is on, for the island (src/core/dock.ts DockHost).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockScreen {
    pub label: String,
    pub monitor: String,
    pub primary: bool,
}

/// One sync of the taskbars' windows at a time.
static SYNCING: Mutex<()> = Mutex::new(());

/// Shows the taskbars at `w` x `h` logical px (until their pages measure themselves), one on the main
/// screen and, with `all`, one on every other (Settings › Taskbar › Show on), each with its centre
/// along its edge from `centres` (0..1 by screen id; none: the middle); or closes them all. Answers
/// which taskbar is on which screen. Their windows are made off the calling thread, as building a
/// window on the event loop deadlocks WebView2.
#[tauri::command]
pub fn dock_show(app: AppHandle, on: bool, w: f64, h: f64, centres: Option<HashMap<String, f64>>, all: Option<bool>) -> Vec<DockScreen> {
    if let Some(c) = centres {
        *CENTRES.lock().unwrap() = Some(c.into_iter().filter(|(_, v)| v.is_finite()).collect());
    }
    if let Some(a) = all {
        ALL_SCREENS.store(a, Ordering::SeqCst);
    }
    if !on {
        std::thread::spawn(move || {
            let _one = SYNCING.lock().unwrap();
            // No taskbar: Explorer's has the tray to itself again, and the windows the room it held.
            crate::trayhost::stop();
            let_go_room(&app);
            for l in labels(&app) {
                if let Some(win) = app.get_webview_window(&l) {
                    let _ = win.destroy();
                }
            }
            BARS.lock().unwrap().clear();
        });
        return Vec::new();
    }
    let plan = layout(&monitors::all(), ALL_SCREENS.load(Ordering::SeqCst));
    let screens = plan.iter().map(|(l, m)| DockScreen { label: l.clone(), monitor: m.id.clone(), primary: l == LABEL }).collect();
    let (w, h) = (w.clamp(32.0, 2400.0), h.clamp(32.0, 2400.0));
    std::thread::spawn(move || sync(&app, plan, w, h));
    screens
}

/// The screens changed (one added, taken away, the main one moved): every screen gets its taskbar
/// again, if they show.
pub fn screens_changed(app: &AppHandle) {
    if labels(app).is_empty() {
        return;
    }
    let plan = layout(&monitors::all(), ALL_SCREENS.load(Ordering::SeqCst));
    let same = {
        let bars = BARS.lock().unwrap();
        bars.len() == plan.len() && plan.iter().all(|(l, m)| bars.get(l).is_some_and(|b| b.monitor == m.id))
    };
    if same {
        return;
    }
    let (w, h) = bar(LABEL).map(|b| b.size).filter(|s| s.0 > 0.0).unwrap_or((640.0, 60.0));
    let app = app.clone();
    std::thread::spawn(move || sync(&app, plan, w, h));
}

/// Makes, moves or closes the taskbars' windows so there is one for each screen in `plan`.
fn sync(app: &AppHandle, plan: Vec<(String, MonitorInfo)>, w: f64, h: f64) {
    let _one = SYNCING.lock().unwrap();
    let keep: HashSet<&str> = plan.iter().map(|(l, _)| l.as_str()).collect();
    for l in labels(app) {
        if !keep.contains(l.as_str()) {
            let_go_room_of(&l);
            if let Some(win) = app.get_webview_window(&l) {
                let _ = win.destroy();
            }
            BARS.lock().unwrap().remove(&l);
        }
    }
    // A screen's new taskbar starts the size of the main one's (its page measures it again once it draws).
    let main_size = bar(LABEL).map(|b| b.size).filter(|s| s.0 > 0.0 && s.1 > 0.0);
    for (label, m) in plan {
        let centre = CENTRES.lock().unwrap().as_ref().and_then(|c| c.get(&m.id).copied()).unwrap_or(-1.0);
        let size = {
            let mut bars = BARS.lock().unwrap();
            let b = bars.entry(label.clone()).or_insert_with(|| Bar::new(m.id.clone(), centre));
            if b.monitor != m.id {
                b.monitor = m.id.clone();
                b.full = false;
                b.up = false;
            }
            b.centre = centre;
            b.size
        };
        let (bw, bh) = if size.0 > 0.0 && size.1 > 0.0 { size } else { main_size.unwrap_or((w, h)) };
        if let Some(win) = app.get_webview_window(&label) {
            put(&win, bw, bh);
            continue;
        }
        build(app, &label, bw, bh);
    }
}

/// Makes taskbar `label`'s window and starts watching it.
fn build(app: &AppHandle, label: &str, w: f64, h: f64) {
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
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
            watch_fullscreen(app.clone(), label.to_string());
            watch_pointer(app.clone(), label.to_string());
        }
        Err(e) => crate::log::line(format!("dock {label} failed: {e}")),
    }
}

/// The dock page measured its content: the window takes that size and stays in its place. `bar`: the
/// bar's part at the edge side (the rest is room for a card over it). `pivot`: on the top edge split
/// round the island, where the screen's middle falls along the window (logical px); else none.
#[tauri::command]
pub fn dock_fit(window: WebviewWindow, w: f64, h: f64, bar: Option<f64>, pivot: Option<f64>) {
    if !is_dock(window.label()) || !w.is_finite() || !h.is_finite() {
        return;
    }
    with_bar(window.label(), |b| {
        if let Some(a) = bar.filter(|a| a.is_finite() && *a > 0.0) {
            b.bar_area = a;
        }
        b.pivot = pivot.filter(|p| p.is_finite() && *p >= 0.0).unwrap_or(-1.0);
    });
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
    // Their places along the old edge mean nothing on the new one.
    for b in BARS.lock().unwrap().values_mut() {
        b.centre = -1.0;
    }
    *CENTRES.lock().unwrap() = None;
    // The strips held on the old edge go; put holds them on the new.
    let_go_room(&app);
    replace(&app);
}

/// The Apps card is open over the bar (`on`): the taskbar takes the keyboard (for its search field,
/// Esc, and so a click anywhere else closes the card). Closed: it never takes it again.
#[cfg(windows)]
#[tauri::command]
pub fn dock_typing(window: WebviewWindow, on: bool) {
    if !is_dock(window.label()) {
        return;
    }
    let Ok(h) = window.hwnd() else { return };
    let raw = h.0 as isize;
    if on {
        TYPING.store(raw, Ordering::Relaxed);
    } else {
        let _ = TYPING.compare_exchange(raw, 0, Ordering::Relaxed, Ordering::Relaxed);
    }
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
pub fn dock_solid(window: WebviewWindow, rects: Vec<Vec<f64>>) {
    let clean: Vec<[f64; 4]> = rects.iter().filter(|r| r.len() == 4 && r.iter().all(|n| n.is_finite())).map(|r| [r[0], r[1], r[2], r[3]]).take(8).collect();
    with_bar(window.label(), |b| b.solid = clean);
}

/// A full-screen game or video is in front on screen `monitor` and its taskbar waits faint at the edge
/// (the screen border there goes meanwhile).
pub fn full_on(monitor: &str) -> bool {
    BARS.lock().unwrap().values().any(|b| b.monitor == monitor && b.full && !b.up)
}

/// Which taskbar goes on which screen now (Settings › Taskbar › Show on): the borders go on the same ones.
pub fn plan() -> Vec<(String, MonitorInfo)> {
    layout(&monitors::all(), ALL_SCREENS.load(Ordering::SeqCst))
}

/// On the screen's bottom edge (over Windows' taskbar), or floating above it as usual.
#[tauri::command]
pub fn dock_edge(app: AppHandle, on: bool) {
    if EDGE.swap(on, Ordering::SeqCst) == on {
        return;
    }
    replace(&app);
}

/// Auto-hide on or off: the watcher tucks the dock at its edge until the pointer comes (watch_fullscreen).
#[tauri::command]
pub fn dock_auto(app: AppHandle, on: bool) {
    if AUTO.swap(on, Ordering::SeqCst) != on {
        // Auto-hiding, it holds no room for itself.
        replace(&app);
    }
}

/// Keep windows clear of it (Settings › Taskbar): the taskbar's strip of the screen is held for it as
/// Windows' own taskbar's is (an app bar), so maximized windows stop at it instead of going under it
/// (Justin, 11-20). Not while it auto-hides, as Windows' own doesn't.
static ROOM: AtomicBool = AtomicBool::new(false);
/// The strip held now: the side (Side::index), how deep (physical px; 0: none) and where (left, top,
/// right, bottom, physical px), as Windows gave it.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
struct Held {
    side: u8,
    deep: i32,
    rect: (i32, i32, i32, i32),
}
/// The strip held for each taskbar, by its label (none: nothing held).
static HELD: Mutex<BTreeMap<String, Held>> = Mutex::new(BTreeMap::new());

fn held(label: &str) -> Held {
    HELD.lock().unwrap().get(label).copied().unwrap_or_default()
}

fn set_held(label: &str, h: Held) {
    let mut all = HELD.lock().unwrap();
    if h.deep > 0 {
        all.insert(label.to_string(), h);
    } else {
        all.remove(label);
    }
}

/// The room its icons rise into over the bar, logical px (src/core/dock.ts HEADROOM), and the window's
/// margin round the bar (16): the bar's area less these is the bar's own thickness.
const RISE_ROOM: f64 = 20.0;

/// How deep a strip taskbar `label` wants held now, physical px (0: none): from the screen's edge to just
/// past the bar's inner side (GAP clear of it), or to the bar's inner side when it sits on the edge.
fn room_wanted(label: &str, scale: f64) -> i32 {
    if !ROOM.load(Ordering::SeqCst) || AUTO.load(Ordering::SeqCst) {
        return 0;
    }
    let bar = bar(label).map(|b| b.bar_area).unwrap_or(0.0);
    let thick = bar - 16.0 - RISE_ROOM;
    if thick <= 0.0 {
        return 0;
    }
    let deep = if EDGE.load(Ordering::SeqCst) { thick } else { GAP + BAR_BELOW + thick + GAP };
    (deep * scale).round() as i32
}

/// The work area as it would be without the strip held for taskbar `label`: out to the strip's outer
/// side (the screen's edge, or Windows' own taskbar showing there). The bar is placed against that, so
/// holding the strip doesn't move it.
fn work_without_room(label: &str, work: Area) -> Area {
    let h = held(label);
    if h.deep <= 0 || h.side != side().index() {
        return work;
    }
    widen_to(work, side(), h.rect)
}

/// `work` grown out on `side` to the outer side of `rect` (left, top, right, bottom).
pub fn widen_to(work: Area, side: Side, rect: (i32, i32, i32, i32)) -> Area {
    let (x, y, w, h) = work;
    match side {
        Side::Bottom => (x, y, w, (rect.3 - y).max(h)),
        Side::Top => (x, rect.1.min(y), w, y + h - rect.1.min(y)),
        Side::Left => (rect.0.min(x), y, x + w - rect.0.min(x), h),
        Side::Right => (x, y, (rect.2 - x).max(w), h),
    }
}

/// The window each taskbar's room is held for: a hidden one of its own, on a thread of its own, and a
/// new one each time the room is taken anew. Held for the taskbar's own window (WebView2's), or taken
/// again for the same window after being let go, Windows said yes and then worked the work area out
/// without it (Justin, 11-20: it worked once, then not); a window it hasn't seen before it keeps the room for.
#[cfg(windows)]
static ROOM_HW: Mutex<BTreeMap<String, (isize, u32)>> = Mutex::new(BTreeMap::new());

#[cfg(windows)]
fn room_window(label: &str) -> Option<isize> {
    if let Some(&(hw, _)) = ROOM_HW.lock().unwrap().get(label) {
        if hw != 0 {
            return Some(hw);
        }
    }
    fresh_room_window(label)
}

/// A new window for taskbar `label`'s room, its last one closed.
#[cfg(windows)]
fn fresh_room_window(label: &str) -> Option<isize> {
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DispatchMessageW, GetMessageW, PostMessageW, PostThreadMessageW, TranslateMessage, MSG, WM_CLOSE, WM_QUIT, WS_EX_TOOLWINDOW, WS_POPUP};
    let mut all = ROOM_HW.lock().unwrap();
    if let Some(cur) = all.remove(label) {
        unsafe {
            let _ = PostMessageW(Some(HWND(cur.0 as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            let _ = PostThreadMessageW(cur.1, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let hw = CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("Island taskbar room"), WS_POPUP, 0, 0, 1, 1, None, None, None, None).ok();
        let _ = tx.send(hw.map(|h| (h.0 as isize, GetCurrentThreadId())));
        if hw.is_none() {
            return;
        }
        // Its messages answered (Windows' news for app bars among them) until it is closed.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
    let made = rx.recv().ok().flatten()?;
    all.insert(label.to_string(), made);
    Some(made.0)
}

/// Holds (or lets go of, or moves) the strip for the taskbar, where Windows says it can go now (off
/// Windows' own taskbar, while that shows). `check`: also when nothing about the bar changed, in case
/// Windows moved the others or forgot it (below). Answers whether it held anew or moved.
#[cfg(windows)]
fn hold_room(win: &WebviewWindow, check: bool) -> bool {
    // Straight to Explorer, not through Island's own stand-in for its tray (trayhost.rs).
    crate::trayhost::explorer_first(|| hold_room_now(win.label(), check))
}

/// One taskbar's strip held at a time (each is a talk with Explorer in several steps).
#[cfg(windows)]
static HOLDING: Mutex<()> = Mutex::new(());

#[cfg(windows)]
fn hold_room_now(label: &str, check: bool) -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA};
    let _one = HOLDING.lock().unwrap();
    let Some(m) = monitor_of(label) else { return false };
    let want = room_wanted(label, m.scale);
    let s = side();
    let mut held = held(label);
    let data = |hw: isize| APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: HWND(hw as *mut _), uCallbackMessage: 0x8000 + 0x1A5, ..Default::default() };
    let let_go = |held: &mut Held| {
        if let Some(hw) = room_window(label) {
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut data(hw)) };
        }
        *held = Held::default();
        set_held(label, *held);
    };
    if want == 0 {
        if held.deep > 0 {
            let_go(&mut held);
        }
        return false;
    }
    if !check && held.deep == want && held.side == s.index() {
        return false;
    }
    if held.deep > 0 && held.side != s.index() {
        let_go(&mut held);
    }
    // Taken anew: for a window Windows hasn't seen.
    if held.deep == 0 {
        fresh_room_window(label);
    }
    let Some(hw) = room_window(label) else { return false };
    let mut d = data(hw);
    // Made an app bar (when it held none; on a check, answering 0 while it still is one).
    let made = unsafe { SHAppBarMessage(ABM_NEW, &mut d) } != 0;
    let b = &m.bounds;
    let (l, t, r, bt) = (b.x, b.y, b.x + b.width, b.y + b.height);
    let place = |d: &mut APPBARDATA| {
        d.uEdge = match s {
            Side::Bottom => ABE_BOTTOM,
            Side::Top => ABE_TOP,
            Side::Left => ABE_LEFT,
            Side::Right => ABE_RIGHT,
        };
        d.rc = match s {
            Side::Bottom => RECT { left: l, top: bt - want, right: r, bottom: bt },
            Side::Top => RECT { left: l, top: t, right: r, bottom: t + want },
            Side::Left => RECT { left: l, top: t, right: l + want, bottom: bt },
            Side::Right => RECT { left: r - want, top: t, right: r, bottom: bt },
        };
        // Windows moves it off another bar on that edge (its own taskbar, showing): then it is as deep from there.
        unsafe { SHAppBarMessage(ABM_QUERYPOS, d) };
        match s {
            Side::Bottom => d.rc.top = d.rc.bottom - want,
            Side::Top => d.rc.bottom = d.rc.top + want,
            Side::Left => d.rc.right = d.rc.left + want,
            Side::Right => d.rc.left = d.rc.right - want,
        }
    };
    place(&mut d);
    let rect = (d.rc.left, d.rc.top, d.rc.right, d.rc.bottom);
    let w = &m.work;
    let out = match s {
        Side::Bottom => w.y + w.height <= rect.1,
        Side::Top => w.y >= rect.3,
        Side::Left => w.x >= rect.2,
        Side::Right => w.x + w.width <= rect.0,
    };
    let now = Held { side: s.index(), deep: want, rect };
    if held == now {
        if out && !made {
            return false;
        }
        // At most once in a while for each taskbar (it may be something else putting the work area back).
        static LAST: Mutex<BTreeMap<String, std::time::Instant>> = Mutex::new(BTreeMap::new());
        let mut last = LAST.lock().unwrap();
        if !made && last.get(label).is_some_and(|t| t.elapsed().as_secs() < 30) {
            return false;
        }
        last.insert(label.to_string(), std::time::Instant::now());
        // Held there, yet Windows forgot it (it was made again) or works the work area out without it: a
        // new window takes it.
        crate::log::line(format!("dock {label}: Windows {} the taskbar's room; held again for a new window", if made { "forgot" } else { "left out" }));
        unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
        let Some(fresh) = fresh_room_window(label) else { return false };
        d = data(fresh);
        unsafe { SHAppBarMessage(ABM_NEW, &mut d) };
        place(&mut d);
    }
    unsafe { SHAppBarMessage(ABM_SETPOS, &mut d) };
    set_held(label, Held { side: s.index(), deep: want, rect: (d.rc.left, d.rc.top, d.rc.right, d.rc.bottom) });
    true
}

#[cfg(not(windows))]
fn hold_room(_win: &WebviewWindow, _check: bool) -> bool {
    false
}

/// Windows works the work area out again when its own taskbar changes (shown, hidden, on each start of
/// Island; a screen added; sleep) and expects every app bar to ask for its room again, where it now can
/// go (Justin, 11-20: it worked once, then not; with Windows' taskbar shown and hidden again, the room
/// stayed up where that taskbar had been). About once a second it asks; moved or forgotten, it holds it
/// again and the bar is put back against it.
fn keep_room(win: &WebviewWindow) {
    let label = win.label().to_string();
    {
        // What it wants and holds, in the log when that changes.
        static SEEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
        let h = held(&label);
        let m = monitor_of(&label);
        let want = room_wanted(&label, m.as_ref().map(|m| m.scale).unwrap_or(1.0));
        let work = m.map(|m| (m.work.y + m.work.height, m.bounds.y + m.bounds.height));
        let now = format!("room: on {} auto {} want {want} held {} at {:?}, work {:?}", ROOM.load(Ordering::SeqCst), AUTO.load(Ordering::SeqCst), h.deep, h.rect, work);
        let mut seen = SEEN.lock().unwrap();
        if seen.get(&label) != Some(&now) {
            crate::log::line(format!("dock {label}: {now}"));
            seen.insert(label.clone(), now);
        }
    }
    if held(&label).deep <= 0 {
        return;
    }
    if hold_room(win, true) {
        let (sw, sh) = bar(&label).map(|b| b.size).unwrap_or((0.0, 0.0));
        if sw > 0.0 && sh > 0.0 {
            put(win, sw, sh);
        }
    }
}

/// Lets go of every taskbar's strip (the taskbar is off, its side changed, or Island quits).
fn let_go_room(app: &AppHandle) {
    let _ = app;
    let all: Vec<String> = HELD.lock().unwrap().keys().cloned().collect();
    for l in all {
        let_go_room_of(&l);
    }
}

/// Lets go of taskbar `label`'s strip.
#[cfg(windows)]
fn let_go_room_of(label: &str) {
    crate::trayhost::explorer_first(|| {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_REMOVE, APPBARDATA};
        let _one = HOLDING.lock().unwrap();
        if held(label).deep == 0 {
            return;
        }
        if let Some(&(hw, _)) = ROOM_HW.lock().unwrap().get(label) {
            let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: HWND(hw as *mut _), ..Default::default() };
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
        }
        set_held(label, Held::default());
    })
}

#[cfg(not(windows))]
fn let_go_room_of(_label: &str) {}

/// Keep windows clear of the taskbar, on or off (Settings › Taskbar).
#[tauri::command]
pub fn dock_room(app: AppHandle, on: bool) {
    if ROOM.swap(on, Ordering::SeqCst) == on {
        return;
    }
    replace(&app);
}

/// Places every taskbar again as it is (its mode changed).
fn replace(app: &AppHandle) {
    for l in labels(app) {
        let Some(win) = app.get_webview_window(&l) else { continue };
        let (w, h) = bar(&l).map(|b| b.size).unwrap_or((0.0, 0.0));
        if w > 0.0 && h > 0.0 {
            put(&win, w, h);
        }
    }
}

/// `(x, y)` (logical px in the window) is on something the page drew that takes clicks.
pub fn solid_at(rects: &[[f64; 4]], x: f64, y: f64) -> bool {
    rects.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
}

/// The taskbars the pointer is on now (watch_pointer): the island's loop polls fast while there is one.
static HOT: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());

fn set_hot(label: &str, on: bool) {
    let mut hot = HOT.lock().unwrap();
    if on {
        hot.insert(label.to_string(), true);
    } else {
        hot.remove(label);
    }
    crate::overlay::DOCK_HOT.store(!hot.is_empty(), Ordering::Relaxed);
}

/// While taskbar `label` exists: its window takes clicks only on what the page drew there (the bar, a
/// card), so the room over the bar for a card never blocks the windows under it. Not while a button is
/// held (a drag keeps going wherever the pointer goes). On the bottom edge, it also stays over Windows'
/// taskbar, which puts itself on top when it slides up.
#[cfg(windows)]
fn watch_pointer(app: AppHandle, label: String) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
    if !start_watch("pointer", &label) {
        return;
    }
    std::thread::spawn(move || {
        let mut taking: Option<bool> = None;
        let mut tick = 0u32;
        // Ctrl tapped with the pointer on the bar: it fades and the mouse goes through it to what is
        // under it, as the island does, until the pointer leaves the bar (Justin, 11-19).
        let mut taps = crate::overlay::CTRL_TAPS.load(Ordering::SeqCst);
        let mut peeking = false;
        let mut was_held = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let (Some(win), Some(b)) = (app.get_webview_window(&label), bar(&label)) else {
                end_watch("pointer", &label);
                set_hot(&label, false);
                return;
            };
            let Ok(h) = win.hwnd() else { continue };
            let hwnd = HWND(h.0);
            tick = tick.wrapping_add(1);
            if EDGE.load(Ordering::SeqCst) && !b.full && tick % 15 == 0 {
                // Over Windows' taskbar (it puts itself on top when it slides up), under the island, over
                // the screen border (frame.rs restack).
                crate::frame::restack(&app);
            }
            let held = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000 != 0) };
            let pressed = held && !was_held;
            was_held = held;
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
            let over = solid_at(&b.solid, x, y);
            set_hot(&label, over);
            if pressed && !over {
                // A press off the bar and its cards: the page may close what stays up through an app's
                // own menu (the tray's hidden icons), which a lost focus can't tell.
                let _ = app.emit_to(label.as_str(), "dock-press-out", ());
            }
            let now_taps = crate::overlay::CTRL_TAPS.load(Ordering::SeqCst);
            if now_taps != taps {
                taps = now_taps;
                if over && !peeking && !typing(h.0 as isize) {
                    peeking = true;
                    let _ = app.emit_to(label.as_str(), "dock-peek", true);
                }
            }
            if peeking && !over {
                peeking = false;
                let _ = app.emit_to(label.as_str(), "dock-peek", false);
            }
            let on = over && !peeking;
            if taking != Some(on) {
                taking = Some(on);
                let _ = win.set_ignore_cursor_events(!on);
            }
        }
    });
}

#[cfg(not(windows))]
fn watch_pointer(_app: AppHandle, _label: String) {}

/// Dragging a taskbar: its start (left edge, or top edge on a side) to `x`, along its edge on its own
/// screen only. With `now` (where the page sees its start now, CSS px on the screen, as `x`) it moves by
/// the difference; without, `x` is physical px. `done`: the drag ended, so its place is kept and the
/// island told (`dock-moved`, with its screen: each screen's taskbar keeps its own place). `x` negative
/// with `done` and no `now`: back to the middle (a double-click).
#[tauri::command]
pub fn dock_at(app: AppHandle, window: WebviewWindow, x: f64, done: bool, now: Option<f64>) {
    let label = window.label().to_string();
    if !is_dock(&label) {
        return;
    }
    let (Some(m), Ok(at), Ok(size)) = (monitor_of(&label), window.outer_position(), window.outer_size()) else { return };
    let across = side().across();
    let (start, len, along, cur) = if across { (m.work.x, m.work.width, size.width as i32, at.x) } else { (m.work.y, m.work.height, size.height as i32, at.y) };
    let from = now.filter(|n| n.is_finite());
    if done && x < 0.0 && from.is_none() {
        with_bar(&label, |b| b.centre = -1.0);
    } else if x.is_finite() {
        let scale = window.scale_factor().unwrap_or(m.scale);
        let want = match from {
            Some(n0) => cur + ((x - n0) * scale).round() as i32,
            None => x.round() as i32,
        };
        let n = want.clamp(start, (start + len - along).max(start));
        if n != cur {
            let to = if across { PhysicalPosition::new(n, at.y) } else { PhysicalPosition::new(at.x, n) };
            let _ = window.set_position(to);
        }
        if !done {
            return;
        }
        let c = centre_of(start, len, n, along);
        with_bar(&label, |b| b.centre = c);
    }
    if let Ok(s) = window.inner_size() {
        let scale = window.scale_factor().unwrap_or(m.scale);
        put(&window, s.width as f64 / scale, s.height as f64 / scale);
    }
    let centre = bar(&label).map(|b| b.centre).unwrap_or(-1.0);
    CENTRES.lock().unwrap().get_or_insert_with(HashMap::new).insert(m.id.clone(), centre);
    let _ = app.emit_to(crate::overlay::LABEL, "dock-moved", serde_json::json!({ "centre": centre, "monitor": m.id, "primary": label == LABEL }));
}

/// The panels Windows opens from its own taskbar: Start (Win), Search (Win+S), Quick Settings (Win+A,
/// Wi-Fi and sound) and the notifications (Win+N).
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
        "search" => Some(VIRTUAL_KEY(0x53)),
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
pub fn quit(app: &AppHandle) {
    crate::trayhost::stop();
    let_go_room(app);
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

    use super::{centre_of, place_on, widen_to, Side};

    /// Holds a 100 px strip at the bottom from a window of its own for 1.5 s and prints the work area
    /// (cargo test --lib appbar_now -- --ignored --nocapture).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn appbar_now() {
        use windows::core::w;
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::Shell::{SHAppBarMessage, ABE_BOTTOM, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA};
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP};
        if std::env::var("AWARE").is_ok() {
            use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
            println!("aware {:?}", unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) });
        }
        let work = || crate::monitors::primary().map(|m| (m.work.y + m.work.height, m.bounds.y + m.bounds.height));
        if let Ok(h) = std::env::var("DOCKSET") {
            // The running Island's taskbar's window made an app bar from here: does Windows take it?
            let dock = windows::Win32::Foundation::HWND(h.parse::<isize>().unwrap() as *mut _);
            let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: dock, uCallbackMessage: 0x8000 + 0x1A5, ..Default::default() };
            println!("before {:?}", work());
            println!("new {}", unsafe { SHAppBarMessage(ABM_NEW, &mut d) });
            d.uEdge = ABE_BOTTOM;
            d.rc = RECT { left: 0, top: 1135, right: 1920, bottom: 1200 };
            println!("set {}", unsafe { SHAppBarMessage(ABM_SETPOS, &mut d) });
            for _ in 0..4 {
                println!("then {:?}", work());
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            return;
        }
        if let Ok(h) = std::env::var("DOCKDROP") {
            // Windows forgetting the running Island's taskbar: it holds its room again within a second or so.
            let dock = windows::Win32::Foundation::HWND(h.parse::<isize>().unwrap() as *mut _);
            let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: dock, ..Default::default() };
            println!("held {:?}", work());
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
            println!("dropped {:?}", work());
            for _ in 0..4 {
                std::thread::sleep(std::time::Duration::from_millis(600));
                println!("then {:?}", work());
            }
            return;
        }
        if std::env::var("DOCKNEW").is_ok() {
            // Is the running Island's taskbar one? ABM_NEW answers 0 for a window that already is.
            let dock = windows::Win32::Foundation::HWND(std::env::var("DOCKNEW").unwrap().parse::<isize>().unwrap() as *mut _);
            let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: dock, uCallbackMessage: 0x8000 + 0x1A5, ..Default::default() };
            let n = unsafe { SHAppBarMessage(ABM_NEW, &mut d) };
            println!("dock new -> {n} (0: it was one)");
            if n != 0 {
                unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
            }
            return;
        }
        // STYLED=x,y,w,h: a window like the dock's (on top, a tool window, not activating), shown there.
        let styled = std::env::var("STYLED").ok().map(|s| s.split(',').map(|n| n.parse::<i32>().unwrap()).collect::<Vec<_>>());
        let (ex, at) = match &styled {
            Some(v) => (WINDOW_EX_STYLE(0x0800_0088), (v[0], v[1], v[2], v[3])),
            None => (WINDOW_EX_STYLE(0), (0, 0, 10, 10)),
        };
        let hw = unsafe { CreateWindowExW(ex, w!("STATIC"), w!("appbar probe"), WS_POPUP, at.0, at.1, at.2, at.3, None, None, None, None) }.unwrap();
        if styled.is_some() {
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hw, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE);
            }
        }
        let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: hw, uCallbackMessage: 0x8000 + 0x1A6, ..Default::default() };
        if std::env::var("OTHER").is_ok() {
            // From a thread other than the window's.
            let h = hw.0 as isize;
            let t = std::thread::spawn(move || {
                let hw = windows::Win32::Foundation::HWND(h as *mut _);
                let mut d = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: hw, uCallbackMessage: 0x8000 + 0x1A6, ..Default::default() };
                let work = || crate::monitors::primary().map(|m| (m.work.y + m.work.height, m.bounds.y + m.bounds.height));
                println!("other: new {}", unsafe { SHAppBarMessage(ABM_NEW, &mut d) });
                d.uEdge = ABE_BOTTOM;
                d.rc = RECT { left: 0, top: 1135, right: 1920, bottom: 1200 };
                println!("other: set {}", unsafe { SHAppBarMessage(ABM_SETPOS, &mut d) });
                std::thread::sleep(std::time::Duration::from_millis(800));
                println!("other: work {:?}", work());
                unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
                println!("other: removed {:?}", work());
            });
            let _ = t.join();
            return;
        }
        println!("before {:?}", work());
        println!("new {}", unsafe { SHAppBarMessage(ABM_NEW, &mut d) });
        let (_, b) = work().unwrap();
        d.uEdge = ABE_BOTTOM;
        let r = crate::monitors::primary().unwrap().bounds;
        for round in 0..2 {
            if round > 0 {
                println!("new again {}", unsafe { SHAppBarMessage(ABM_NEW, &mut d) });
            }
            d.uEdge = ABE_BOTTOM;
            d.rc = RECT { left: r.x, top: b - 65, right: r.x + r.width, bottom: b };
            unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut d) };
            println!("query {:?}", (d.rc.left, d.rc.top, d.rc.right, d.rc.bottom));
            d.rc.top = d.rc.bottom - 65;
            println!("set {}", unsafe { SHAppBarMessage(ABM_SETPOS, &mut d) });
            println!("after set {:?}", work());
            let secs: u64 = std::env::var("LONG").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
            for i in 0..secs {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                println!("{} s on {:?}", i + 1, work());
            }
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
            println!("removed {:?}", work());
        }
        unsafe {
            let _ = DestroyWindow(hw);
        }
    }

    #[test]
    fn the_room_held_for_it_is_given_back_on_its_own_side() {
        let work = (0, 0, 1920, 1100);
        // Out to the strip's outer side: the screen's edge, or Windows' own taskbar's top while that shows.
        assert_eq!(widen_to(work, Side::Bottom, (0, 1100, 1920, 1200)), (0, 0, 1920, 1200));
        assert_eq!(widen_to((0, 0, 1920, 1052), Side::Bottom, (0, 1052, 1920, 1152)), (0, 0, 1920, 1152));
        assert_eq!(widen_to((0, 100, 1920, 1100), Side::Top, (0, 0, 1920, 100)), (0, 0, 1920, 1200));
        assert_eq!(widen_to((80, 0, 1840, 1200), Side::Left, (0, 0, 80, 1200)), (0, 0, 1920, 1200));
        assert_eq!(widen_to((0, 0, 1840, 1200), Side::Right, (1840, 0, 1920, 1200)), (0, 0, 1920, 1200));
        // Placed against the work area without it, the bar is where it was before the room was held.
        let bounds = (0, 0, 1920, 1200);
        let before = place_on(Side::Bottom, bounds, bounds, 1.0, 800, 120, -1.0, None, false);
        let held = (0, 0, 1920, 1200 - 96);
        assert_eq!(place_on(Side::Bottom, widen_to(held, Side::Bottom, (0, 1104, 1920, 1200)), bounds, 1.0, 800, 120, -1.0, None, false), before);
    }

    fn screen(id: &str, primary: bool, x: i32) -> crate::monitors::MonitorInfo {
        let r = crate::monitors::Rect { x, y: 0, width: 1920, height: 1080 };
        crate::monitors::MonitorInfo { id: id.into(), name: id.into(), primary, bounds: r.clone(), work: r, scale: 1.0, portrait: false, taskbar: "bottom" }
    }

    #[test]
    fn a_taskbar_on_every_screen_the_main_ones_first() {
        let screens = [screen(r"\.\DISPLAY2", false, -1920), screen(r"\.\DISPLAY1", true, 0), screen(r"\.\DISPLAY3", false, 1920)];
        let all: Vec<(String, String)> = super::layout(&screens, true).into_iter().map(|(l, m)| (l, m.id)).collect();
        assert_eq!(
            all,
            vec![
                ("dock".to_string(), r"\.\DISPLAY1".to_string()),
                ("dock-DISPLAY2".to_string(), r"\.\DISPLAY2".to_string()),
                ("dock-DISPLAY3".to_string(), r"\.\DISPLAY3".to_string()),
            ]
        );
        // The main screen only.
        let main: Vec<String> = super::layout(&screens, false).into_iter().map(|(l, _)| l).collect();
        assert_eq!(main, vec!["dock".to_string()]);
        // Labels take only letters, digits and dashes; every one is a taskbar's.
        assert_eq!(super::label_for(r"\.\DISPLAY12", false), "dock-DISPLAY12");
        assert!(super::is_dock("dock") && super::is_dock("dock-DISPLAY2") && !super::is_dock("dockpeek") && !super::is_dock("island"));
    }

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
