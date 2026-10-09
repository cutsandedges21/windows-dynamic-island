// The island window: a transparent, borderless, always-on-top, non-activating
// tool window that covers the work area of one monitor. The pill is drawn inside
// it, so every move (including Top → Right) is a spring animation in CSS, never
// an OS window move.
//
// Outside the pill the window must not eat the mouse. A poll thread reads the
// cursor every 16 ms and toggles click-through against the hit rects the island
// publishes; deciding in the same tick as the cursor read is what keeps clicks
// from being lost (an IPC round trip per move would be too slow).

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, POINT};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_RBUTTON};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::monitors::{self, MonitorInfo};

pub const LABEL: &str = "island";
/// Duplicate mode: click-through copies of the pill on the other chosen screens,
/// labelled `mirror-0`, `mirror-1`, … They draw what the island sends them.
pub const MIRROR_PREFIX: &str = "mirror-";
/// Margin around a hit rect that already takes the mouse, in CSS px, so the flag
/// is off by the time a moving cursor reaches a button.
const HIT_MARGIN: f64 = 6.0;

#[derive(Deserialize, Clone, Copy, Debug, Default)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub monitor: MonitorInfo,
    /// Work area in CSS px: the island's whole coordinate space.
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

pub struct Overlay {
    pub rects: Mutex<Vec<HitRect>>,
    ignoring: AtomicBool,
    pub visible: AtomicBool,
    /// Window that had focus before the island took it for an inline input.
    previous_fg: AtomicIsize,
    pub monitor_id: Mutex<String>,
    /// Monitor of each mirror window, by its number.
    mirrors: Mutex<Vec<String>>,
    /// Peek behind (a setting): tapping Ctrl over the pill lets clicks through it.
    peek_enabled: AtomicBool,
}

impl Overlay {
    pub fn new() -> Self {
        Self {
            rects: Mutex::new(Vec::new()),
            ignoring: AtomicBool::new(false),
            peek_enabled: AtomicBool::new(false),
            visible: AtomicBool::new(true),
            previous_fg: AtomicIsize::new(0),
            monitor_id: Mutex::new(String::new()),
            mirrors: Mutex::new(Vec::new()),
        }
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

#[cfg(windows)]
fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    (raw != 0).then(|| HWND(raw as *mut _))
}

#[cfg(windows)]
pub fn hwnd_raw(app: &AppHandle) -> isize {
    window(app).and_then(|w| hwnd_of(&w)).map(|h| h.0 as isize).unwrap_or(0)
}

/// A Mac window that cannot become key never takes the keyboard from the app in front.
#[cfg(target_os = "macos")]
fn set_activating(win: &WebviewWindow, activating: bool) {
    let _ = win.set_focusable(activating);
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab and the taskbar.
#[cfg(windows)]
fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut want = ex | WS_EX_TOOLWINDOW.0 as isize;
        if activating {
            want &= !(WS_EX_NOACTIVATE.0 as isize);
        } else {
            want |= WS_EX_NOACTIVATE.0 as isize;
        }
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    build(app, LABEL)
}

fn build(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Island")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 0));
    #[cfg(windows)]
    let win = win.drag_and_drop(false);
    // On a Mac: on every desktop, and the first click on the pill counts even while another app is in front.
    #[cfg(target_os = "macos")]
    let win = win.visible_on_all_workspaces(true).accept_first_mouse(true);
    let win = win.build()?;
    set_activating(&win, false);
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

/// Covers the work area of `monitor_id` (or the primary display) and returns the
/// island's coordinate space in CSS px.
pub fn place(app: &AppHandle, monitor_id: Option<&str>) -> Option<Placement> {
    let win = window(app)?;
    let m = monitor_id
        .and_then(monitors::find)
        .or_else(monitors::primary)?;
    if let Some(state) = app.try_state::<Arc<Overlay>>() {
        *state.monitor_id.lock().unwrap() = m.id.clone();
    }
    Some(cover(&win, m))
}

fn cover(win: &WebviewWindow, m: MonitorInfo) -> Placement {
    let w = m.work.clone();
    let pos = PhysicalPosition::new(w.x, w.y);
    let size = PhysicalSize::new(w.width.max(1) as u32, w.height.max(1) as u32);
    let _ = win.set_position(pos);
    let _ = win.set_size(size);
    // Crossing displays with different DPI rescales the window: assert again.
    let _ = win.set_position(pos);
    let _ = win.set_size(size);
    #[cfg(windows)]
    if let Some(h) = hwnd_of(win) {
        unsafe {
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    Placement { width: w.width as f64 / m.scale, height: w.height as f64 / m.scale, scale: m.scale, monitor: m }
}

fn mirror_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with(MIRROR_PREFIX)).map(|(_, w)| w).collect()
}

/// Places mirror `label` on its monitor; None once that monitor is gone.
fn place_mirror(app: &AppHandle, win: &WebviewWindow) -> Option<Placement> {
    let n: usize = win.label().strip_prefix(MIRROR_PREFIX)?.parse().ok()?;
    let id = app.try_state::<Arc<Overlay>>()?.mirrors.lock().unwrap().get(n).cloned()?;
    Some(cover(win, monitors::find(&id)?))
}

#[cfg(windows)]
fn cursor() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// (held now, pressed at any point since the last call). The second half is what
/// catches a click that began and ended between two polls; Windows keeps that bit
/// per caller, and this loop is the only one asking about the mouse buttons.
#[cfg(windows)]
fn button_state(vk: u16) -> (bool, bool) {
    let s = unsafe { GetAsyncKeyState(vk as i32) } as u16;
    (s & 0x8000 != 0, s & 0x0001 != 0)
}

#[cfg(windows)]
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"];

/// The foreground window covers its whole monitor (a game, a video, F11).
#[cfg(windows)]
fn fullscreen_on(fg: isize, own: isize) -> Option<String> {
    if fg == 0 || fg == own {
        return None;
    }
    let class = crate::procs::class_name(fg);
    if SHELL_CLASSES.contains(&class.as_str()) {
        return None;
    }
    let r = crate::procs::window_rect(fg)?;
    let m = monitors::of_window(HWND(fg as *mut _))?;
    let b = &m.bounds;
    let covers = r.left <= b.x && r.top <= b.y && r.right >= b.x + b.width && r.bottom >= b.y + b.height;
    covers.then_some(m.id)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PointerOutside {
    button: &'static str,
}

#[cfg(windows)]
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ForegroundInfo {
    monitor: String,
    fullscreen: Option<String>,
    pid: u32,
}

/// Pointer distance at which the loop starts running at full speed, and the two rates.
const NEAR_PX: f64 = 180.0;
const NEAR_POLL_MS: u64 = 16;
const FAR_POLL_MS: u64 = 100;
/// A peek ends once the pointer is this far from the island, in CSS px.
const PEEK_LEAVE_PX: f64 = 24.0;
/// Within NEAR_PX the bot's eyes follow the pointer: its position goes to the island at most this often.
const POINTER_EVERY: Duration = Duration::from_millis(50);

#[derive(Serialize, Clone)]
struct PointerAt {
    x: f64,
    y: f64,
}

/// Click-through, outside clicks, full-screen detection and the foreground
/// window's monitor, all from one loop: 16 ms near the island, 100 ms away from it.
pub fn spawn_poll(app: AppHandle, state: Arc<Overlay>) {
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut last_fg = Instant::now() - Duration::from_secs(5);
        #[cfg(windows)]
        let mut last_info: Option<ForegroundInfo> = None;
        let mut was_left = false;
        let mut was_right = false;
        let mut was_ctrl = false;
        // Peek behind: the island fades and lets the mouse through until the pointer leaves it.
        let mut peeking = false;
        // A pointer far from the island cannot reach it within a frame or two, so
        // the loop idles at 10 Hz out there and only runs hot near the island.
        let mut period = Duration::from_millis(FAR_POLL_MS);
        let mut geom: Option<(f64, f64, f64)> = None;
        let mut last_geom = Instant::now() - Duration::from_secs(5);
        // The last pointer position sent for the bot's eyes, and when.
        let mut last_pointer: Option<(f64, f64)> = None;
        let mut last_pointer_at = Instant::now() - Duration::from_secs(5);
        #[cfg(target_os = "macos")]
        let mut clicks = crate::mac::input::Clicks::new();
        loop {
            std::thread::sleep(period);
            let Some(win) = window(&app) else { continue };
            #[cfg(windows)]
            let own = hwnd_of(&win).map(|h| h.0 as isize).unwrap_or(0);

            #[cfg(windows)]
            if last_fg.elapsed() >= Duration::from_millis(400) {
                last_fg = Instant::now();
                let fg = crate::procs::foreground();
                if fg != 0 && fg != own {
                    let monitor = monitors::of_window(HWND(fg as *mut _)).map(|m| m.id).unwrap_or_default();
                    let info = ForegroundInfo { fullscreen: fullscreen_on(fg, own), monitor, pid: crate::procs::window_pid(fg) };
                    if last_info.as_ref() != Some(&info) {
                        let _ = app.emit_to(LABEL, "foreground", info.clone());
                        last_info = Some(info);
                    }
                }
            }

            if !state.visible.load(Ordering::Relaxed) {
                period = Duration::from_millis(FAR_POLL_MS);
                continue;
            }
            // Where the overlay sits only changes when displays do, so it is read
            // once a second rather than on every tick: asking the window costs far
            // more than the cursor test it feeds.
            if last_geom.elapsed() >= Duration::from_secs(1) || geom.is_none() {
                last_geom = Instant::now();
                geom = win.outer_position().ok().map(|o| (o.x as f64, o.y as f64, win.scale_factor().unwrap_or(1.0)));
            }
            let Some((ox, oy, scale)) = geom else { continue };
            let origin = (ox, oy);
            #[cfg(windows)]
            let pointer = cursor();
            #[cfg(target_os = "macos")]
            let pointer = win.cursor_position().ok().map(|p| (p.x, p.y));
            let Some((cx, cy)) = pointer else { continue };
            let x = (cx - origin.0) / scale;
            let y = (cy - origin.1) / scale;

            // How far the pointer is from the island, and whether it is on it.
            let mut gap = f64::MAX;
            let on_island = state.rects.lock().unwrap().iter().any(|r| {
                if r.w <= 0.0 {
                    return false;
                }
                let dx = (r.x - x).max(x - (r.x + r.w)).max(0.0);
                let dy = (r.y - y).max(y - (r.y + r.h)).max(0.0);
                gap = gap.min(dx.max(dy));
                x >= r.x - HIT_MARGIN && x <= r.x + r.w + HIT_MARGIN && y >= r.y - HIT_MARGIN && y <= r.y + r.h + HIT_MARGIN
            });
            period = Duration::from_millis(if gap <= NEAR_PX { NEAR_POLL_MS } else { FAR_POLL_MS });

            // Near the island the bot watches the pointer; once it leaves, one null says so.
            if gap <= NEAR_PX {
                let moved = last_pointer.is_none_or(|(px, py)| (px - x).abs() >= 1.0 || (py - y).abs() >= 1.0);
                if moved && last_pointer_at.elapsed() >= POINTER_EVERY {
                    last_pointer = Some((x, y));
                    last_pointer_at = Instant::now();
                    let _ = app.emit_to(LABEL, "pointer", Some(PointerAt { x, y }));
                }
            } else if last_pointer.take().is_some() {
                let _ = app.emit_to(LABEL, "pointer", None::<PointerAt>);
            }

            // Ctrl pressed with the pointer on the island starts a peek; a tap is
            // enough, so the click behind is a plain click, not a Ctrl+click.
            #[cfg(windows)]
            let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000 != 0;
            #[cfg(target_os = "macos")]
            let ctrl = crate::mac::input::control_down();
            let peek_on = state.peek_enabled.load(Ordering::Relaxed);
            if peek_on && !peeking && on_island && ctrl && !was_ctrl {
                peeking = true;
                let _ = app.emit_to(LABEL, "peek", true);
            } else if peeking && (!peek_on || gap > PEEK_LEAVE_PX) {
                peeking = false;
                let _ = app.emit_to(LABEL, "peek", false);
            }
            was_ctrl = ctrl;

            let accept = on_island && !peeking;
            if state.ignoring.load(Ordering::Relaxed) == accept {
                state.ignoring.store(!accept, Ordering::Relaxed);
                let _ = win.set_ignore_cursor_events(!accept);
            }

            // A press anywhere off the island (or through it, while peeking) closes an open island.
            #[cfg(windows)]
            let ((left, left_hit), (right, right_hit)) = (button_state(VK_LBUTTON.0), button_state(VK_RBUTTON.0));
            #[cfg(target_os = "macos")]
            let ((left, left_hit), (right, right_hit)) = clicks.poll();
            if !accept && (left_hit || right_hit || (left && !was_left) || (right && !was_right)) {
                let _ = app.emit_to(LABEL, "pointer-outside", PointerOutside { button: if left { "left" } else { "right" } });
            }
            was_left = left;
            was_right = right;
        }
    });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn island_place(app: AppHandle, monitor: Option<String>) -> Option<Placement> {
    place(&app, monitor.as_deref())
}

/// One click-through mirror per monitor in `monitors`; extra mirrors close. Windows
/// are built off the calling thread (building one on the event loop deadlocks WebView2).
#[tauri::command]
pub fn island_mirrors(app: AppHandle, state: tauri::State<'_, Arc<Overlay>>, monitors: Vec<String>) {
    *state.mirrors.lock().unwrap() = monitors.clone();
    let visible = state.visible.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        for win in mirror_windows(&app) {
            let keep = win.label().strip_prefix(MIRROR_PREFIX).and_then(|n| n.parse::<usize>().ok()).is_some_and(|n| n < monitors.len());
            if !keep {
                let _ = win.destroy();
            }
        }
        for n in 0..monitors.len() {
            let label = format!("{MIRROR_PREFIX}{n}");
            let win = match app.get_webview_window(&label) {
                Some(w) => w,
                None => match build(&app, &label) {
                    Ok(w) => w,
                    Err(e) => {
                        crate::log::line(&format!("mirror {label} failed: {e}"));
                        continue;
                    }
                },
            };
            if let Some(p) = place_mirror(&app, &win) {
                let _ = app.emit_to(label.as_str(), "mirror-placed", p);
            }
            let _ = if visible { win.show() } else { win.hide() };
            set_activating(&win, false);
        }
    });
}

/// A mirror asks where it is when its page loads.
#[tauri::command]
pub fn mirror_hello(app: AppHandle, window: WebviewWindow) -> Option<Placement> {
    place_mirror(&app, &window)
}

#[tauri::command]
pub fn island_set_hit(state: tauri::State<'_, Arc<Overlay>>, rects: Vec<HitRect>) {
    *state.rects.lock().unwrap() = rects;
}

#[tauri::command]
pub fn island_set_peek(state: tauri::State<'_, Arc<Overlay>>, enabled: bool) {
    state.peek_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn island_show(app: AppHandle, state: tauri::State<'_, Arc<Overlay>>, visible: bool) {
    state.visible.store(visible, Ordering::Relaxed);
    for win in window(&app).into_iter().chain(mirror_windows(&app)) {
        if visible {
            let _ = win.show();
            set_activating(&win, false);
        } else {
            let _ = win.hide();
        }
    }
}

/// The island takes the keyboard while an inline input is open.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn island_set_focusable(app: AppHandle, focusable: bool) -> bool {
    let Some(win) = window(&app) else { return false };
    set_activating(&win, focusable);
    if focusable {
        win.set_focus().is_ok()
    } else {
        true
    }
}

/// The island takes the keyboard while an inline input is open, then hands it
/// back to whatever had it before.
#[cfg(windows)]
#[tauri::command]
pub fn island_set_focusable(app: AppHandle, state: tauri::State<'_, Arc<Overlay>>, focusable: bool) -> bool {
    let Some(win) = window(&app) else { return false };
    let own = hwnd_of(&win).map(|h| h.0 as isize).unwrap_or(0);
    if focusable {
        let fg = crate::procs::foreground();
        if fg != own && fg != 0 {
            state.previous_fg.store(fg, Ordering::Relaxed);
        }
        set_activating(&win, true);
        let ok = crate::procs::activate(own);
        let _ = win.set_focus();
        ok
    } else {
        set_activating(&win, false);
        let prev = state.previous_fg.swap(0, Ordering::Relaxed);
        if prev != 0 && crate::procs::foreground() == own {
            crate::procs::activate(prev);
        }
        true
    }
}
