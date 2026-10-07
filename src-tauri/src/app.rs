// App-level plumbing: the tray (built from a menu model the island sends), global
// hotkeys, the Activities/Settings window, toasts, autostart and quitting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::Color;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::overlay::LABEL as ISLAND;

const TRAY_ID: &str = "island-tray";
pub const APP_LABEL: &str = "app";

// ------------------------------------------------------------------ tray

#[derive(Deserialize, Debug)]
pub struct MenuSpec {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    separator: Option<bool>,
    items: Option<Vec<MenuSpec>>,
}

fn tray_image(alert: bool) -> Option<tauri::image::Image<'static>> {
    let bytes: &'static [u8] = if alert { include_bytes!("../icons/tray-alert.png") } else { include_bytes!("../icons/tray.png") };
    tauri::image::Image::from_bytes(bytes).ok()
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[&MenuItem::with_id(app, "island:app:activities", "Activities…", true, None::<&str>)?, &MenuItem::with_id(app, "island:quit", "Quit Island", true, None::<&str>)?])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Island")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id == "island:quit" {
                app.exit(0);
                return;
            }
            let _ = app.emit_to(ISLAND, "tray-menu", serde_json::json!({ "id": id }));
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                open_app(tray.app_handle(), None);
            }
        });
    if let Some(img) = tray_image(false) {
        builder = builder.icon(img);
    }
    builder.build(app)?;
    Ok(())
}

fn build_items(app: &AppHandle, specs: &[MenuSpec]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for s in specs {
        if s.separator.unwrap_or(false) {
            out.push(Box::new(PredefinedMenuItem::separator(app)?));
            continue;
        }
        let label = s.label.clone().unwrap_or_default();
        let enabled = s.enabled.unwrap_or(true);
        if let Some(children) = &s.items {
            let kids = build_items(app, children)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|b| b.as_ref()).collect();
            out.push(Box::new(Submenu::with_items(app, label, enabled, &refs)?));
        } else if let Some(checked) = s.checked {
            out.push(Box::new(CheckMenuItem::with_id(app, s.id.clone().unwrap_or_default(), label, enabled, checked, None::<&str>)?));
        } else {
            let enabled = enabled && s.id.is_some();
            out.push(Box::new(MenuItem::with_id(app, s.id.clone().unwrap_or_default(), label, enabled, None::<&str>)?));
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn tray_update(app: AppHandle, tooltip: String, alert: bool, menu: Vec<MenuSpec>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    let _ = tray.set_tooltip(Some(tooltip.chars().take(127).collect::<String>()));
    if let Some(img) = tray_image(alert) {
        let _ = tray.set_icon(Some(img));
    }
    let items = build_items(&app, &menu).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let built = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;
    tray.set_menu(Some(built)).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ hotkeys

#[derive(Default)]
pub struct Hotkeys(pub Mutex<HashMap<u32, String>>);

#[derive(Deserialize)]
pub struct HotkeySpec {
    id: String,
    accel: String,
}

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let id = app.state::<Hotkeys>().0.lock().unwrap().get(&shortcut.id()).cloned();
    if let Some(id) = id {
        crate::log::line(format!("hotkey {id}"));
        let _ = app.emit_to(ISLAND, "hotkey", serde_json::json!({ "id": id }));
    }
}

/// Replaces every registration; returns the ids another app already holds.
#[tauri::command]
pub fn hotkeys_set(app: AppHandle, state: tauri::State<'_, Hotkeys>, keys: Vec<HotkeySpec>) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = state.0.lock().unwrap();
    map.clear();
    let mut failed = Vec::new();
    for k in keys {
        match k.accel.parse::<Shortcut>() {
            Ok(sc) => {
                if gs.register(sc).is_ok() {
                    map.insert(sc.id(), k.id);
                } else {
                    failed.push(k.id);
                }
            }
            Err(_) => failed.push(k.id),
        }
    }
    failed
}

// ------------------------------------------------------------------ app window

/// A build is under way: further requests wait for it instead of starting another.
static OPENING: AtomicBool = AtomicBool::new(false);

pub fn open_app(app: &AppHandle, page: Option<String>) {
    if let Some(w) = app.get_webview_window(APP_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(p) = page {
            let _ = w.emit("navigate", p);
        }
        return;
    }
    if OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // WebView2 deadlocks when a window is built on the thread running the event
    // loop (sync commands, tray, hotkey and single-instance handlers all run
    // there): the frame appears but its page never loads. Build it elsewhere.
    std::thread::spawn(move || {
        let page = serde_json::to_string(&page.unwrap_or_default()).unwrap_or_else(|_| "\"\"".into());
        let built = WebviewWindowBuilder::new(&app, APP_LABEL, WebviewUrl::App("app.html".into()))
            .title("Island")
            .inner_size(1040.0, 740.0)
            .min_inner_size(820.0, 560.0)
            // The native title bar always works, even if the page were to fail.
            .theme(Some(tauri::Theme::Dark))
            .transparent(true)
            .center()
            .background_color(Color(0, 0, 0, 0))
            .effects(EffectsBuilder::new().effect(Effect::Mica).build())
            .initialization_script(&format!("window.__ISLAND_PAGE__ = {page};"))
            .build();
        OPENING.store(false, Ordering::SeqCst);
        match built {
            Ok(w) => {
                let _ = w.set_focus();
                crate::log::line("app window opened");
            }
            Err(err) => crate::log::line(format!("app window failed: {err}")),
        }
    });
}

#[tauri::command]
pub fn app_open(app: AppHandle, page: Option<String>) {
    open_app(&app, page);
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> bool {
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    r.is_ok()
}
