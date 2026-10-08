// Displays on a Mac, through Tauri's monitor API. Same shapes as monitors.rs on
// Windows. The work area is the screen's visible frame: below the menu bar, beside
// or above the Dock, so the pill's top edge sits just under the menu bar.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Monitor};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// lib.rs calls this in setup, before the island is placed.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
    pub portrait: bool,
    /// Where the Dock is ("hidden" when it auto-hides). The menu bar is not counted.
    pub taskbar: &'static str,
}

fn dock_edge(b: &Rect, w: &Rect) -> &'static str {
    if w.x > b.x {
        "left"
    } else if w.x + w.width < b.x + b.width {
        "right"
    } else if w.y + w.height < b.y + b.height {
        "bottom"
    } else {
        "hidden"
    }
}

fn info(m: &Monitor, primary: Option<&Monitor>) -> MonitorInfo {
    let (pos, size, wa) = (m.position(), m.size(), m.work_area());
    let bounds = Rect { x: pos.x, y: pos.y, width: size.width as i32, height: size.height as i32 };
    let work = Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width as i32, height: wa.size.height as i32 };
    let name = m.name().cloned().unwrap_or_else(|| "Display".to_string());
    MonitorInfo {
        id: format!("{name}@{},{}", pos.x, pos.y),
        primary: primary.is_some_and(|p| p.position() == pos && p.size() == size),
        taskbar: dock_edge(&bounds, &work),
        portrait: size.height > size.width,
        scale: m.scale_factor(),
        name,
        bounds,
        work,
    }
}

pub fn all() -> Vec<MonitorInfo> {
    let Some(app) = APP.get() else { return Vec::new() };
    let primary = app.primary_monitor().ok().flatten();
    app.available_monitors().unwrap_or_default().iter().map(|m| info(m, primary.as_ref())).collect()
}

pub fn primary() -> Option<MonitorInfo> {
    let all = all();
    all.iter().find(|m| m.primary).cloned().or_else(|| all.into_iter().next())
}

pub fn find(id: &str) -> Option<MonitorInfo> {
    all().into_iter().find(|m| m.id == id)
}

pub fn at_cursor() -> Option<MonitorInfo> {
    let app = APP.get()?;
    let p = app.cursor_position().ok()?;
    let m = app.monitor_from_point(p.x, p.y).ok().flatten()?;
    let primary = app.primary_monitor().ok().flatten();
    Some(info(&m, primary.as_ref()))
}

#[tauri::command]
pub fn monitors_list() -> Vec<MonitorInfo> {
    all()
}

#[tauri::command]
pub fn monitor_at_cursor() -> Option<MonitorInfo> {
    at_cursor()
}
