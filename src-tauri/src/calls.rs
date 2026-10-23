// Turning the camera on or off in a call app, from the island.
//
// Windows has no camera switch an app must obey, so Island presses the call app's own
// shortcut: it brings the app's window forward, sends the keys, and puts the window that was in
// front back. Whether it worked shows by itself: the camera leaves (or joins) the apps
// Windows lists as using it (audio.rs › privacy).

// The helpers below only run on Windows; a Mac build still compiles them for the tests.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// A key in a shortcut: Ctrl, Shift, Alt or one letter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Key {
    Ctrl,
    Shift,
    Alt,
    Letter(u8),
}

/// A call app Island knows the camera shortcut of.
pub struct CallApp {
    pub name: &'static str,
    /// The names Windows' privacy list gives it (lowercase).
    labels: &'static [&'static str],
    /// Its process (lowercase).
    exes: &'static [&'static str],
    /// The call's window title holds this (a browser tab), when it must.
    title: Option<&'static str>,
    pub camera: &'static [Key],
}

const BROWSERS: &[&str] = &["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc"];
const BROWSER_EXES: &[&str] = &["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe"];

pub const APPS: &[CallApp] = &[
    CallApp { name: "Teams", labels: &["msteams", "teams"], exes: &["ms-teams.exe", "teams.exe"], title: None, camera: &[Key::Ctrl, Key::Shift, Key::Letter(b'O')] },
    CallApp { name: "Zoom", labels: &["zoom"], exes: &["zoom.exe"], title: None, camera: &[Key::Alt, Key::Letter(b'V')] },
    CallApp { name: "Google Meet", labels: BROWSERS, exes: BROWSER_EXES, title: Some("Meet"), camera: &[Key::Ctrl, Key::Letter(b'E')] },
];

/// The app for a name in Windows' privacy list.
pub fn app_for(label: &str) -> Option<&'static CallApp> {
    let l = label.trim().to_lowercase();
    APPS.iter().find(|a| a.labels.contains(&l.as_str()))
}

/// Which of a process's windows is the call: the app's own, and for a browser the Meet tab.
pub fn is_call_window(app: &CallApp, exe: &str, title: &str) -> bool {
    app.exes.contains(&exe.to_lowercase().as_str()) && !title.trim().is_empty() && app.title.is_none_or(|t| title.contains(t))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallControl {
    /// The name as the privacy list gave it.
    pub label: String,
    /// The app's name to show ("Teams", "Google Meet").
    pub app: String,
}

/// The apps in a call whose camera Island can switch, for the names Windows lists.
#[tauri::command]
pub fn call_controls(labels: Vec<String>) -> Vec<CallControl> {
    labels.into_iter().filter_map(|l| app_for(&l).map(|a| CallControl { app: a.name.into(), label: l })).collect()
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT};

    fn vk(k: Key) -> VIRTUAL_KEY {
        match k {
            Key::Ctrl => VK_CONTROL,
            Key::Shift => VK_SHIFT,
            Key::Alt => VK_MENU,
            Key::Letter(c) => VIRTUAL_KEY(c.to_ascii_uppercase() as u16),
        }
    }

    fn input(k: Key, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk(k), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// The call's window: the topmost window of the app's process that matches.
    fn find(app: &CallApp) -> Option<isize> {
        let exe_of: std::collections::HashMap<u32, String> = crate::procs::snapshot(false).into_iter().map(|p| (p.0, p.2)).collect();
        crate::procs::windows().into_iter().find(|w| exe_of.get(&w.pid).is_some_and(|exe| is_call_window(app, exe, &w.title))).map(|w| w.hwnd)
    }

    pub fn press(app: &CallApp, keys: &[Key]) -> Result<(), String> {
        let hwnd = find(app).ok_or_else(|| format!("Couldn't find the {} call window.", app.name))?;
        let before = crate::procs::foreground();
        if !crate::procs::activate(hwnd) {
            return Err(format!("Windows didn't let Island bring {} forward.", app.name));
        }
        let mut inputs: Vec<INPUT> = keys.iter().map(|k| input(*k, false)).collect();
        inputs.extend(keys.iter().rev().map(|k| input(*k, true)));
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
        // Let the app take the keys before the other window comes back.
        std::thread::sleep(std::time::Duration::from_millis(200));
        if before != 0 && before != hwnd {
            crate::procs::activate(before);
        }
        crate::log::line(format!("calls: camera shortcut sent to {}", app.name));
        Ok(())
    }
}

/// Switches the camera in the call app Windows listed under `label`.
#[tauri::command]
pub async fn call_camera(label: String) -> Result<(), String> {
    let app = app_for(&label).ok_or_else(|| "Island can't switch this app's camera.".to_string())?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || win::press(app, app.camera)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_are_known_by_the_names_windows_lists() {
        assert_eq!(app_for("MSTeams").map(|a| a.name), Some("Teams"));
        assert_eq!(app_for("Teams").map(|a| a.name), Some("Teams"));
        assert_eq!(app_for("Zoom").map(|a| a.name), Some("Zoom"));
        assert_eq!(app_for("msedge").map(|a| a.name), Some("Google Meet"));
        assert!(app_for("Discord").is_none());
        assert!(app_for("obs64").is_none());
    }

    #[test]
    fn a_browser_counts_only_with_the_meet_tab_in_front() {
        let meet = app_for("chrome").unwrap();
        assert!(is_call_window(meet, "chrome.exe", "Meet - abc-defg-hij - Google Chrome"));
        assert!(!is_call_window(meet, "chrome.exe", "YouTube - Google Chrome"));
        assert!(!is_call_window(meet, "zoom.exe", "Meet"));
        let teams = app_for("MSTeams").unwrap();
        assert!(is_call_window(teams, "ms-teams.exe", "Meeting with Alex | Microsoft Teams"));
        assert!(!is_call_window(teams, "MS-Teams.exe", " "));
    }

    #[test]
    fn controls_list_only_the_apps_with_a_camera_shortcut() {
        let c = call_controls(vec!["Discord".into(), "Zoom".into()]);
        assert_eq!(c, vec![CallControl { label: "Zoom".into(), app: "Zoom".into() }]);
    }

    #[test]
    fn shortcuts_are_the_apps_own() {
        assert_eq!(app_for("Zoom").unwrap().camera, &[Key::Alt, Key::Letter(b'V')]);
        assert_eq!(app_for("MSTeams").unwrap().camera, &[Key::Ctrl, Key::Shift, Key::Letter(b'O')]);
        assert_eq!(app_for("firefox").unwrap().camera, &[Key::Ctrl, Key::Letter(b'E')]);
    }
}
