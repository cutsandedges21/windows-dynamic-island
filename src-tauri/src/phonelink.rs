// Your phone's notifications on the island. Windows' Phone Link mirrors a paired
// phone's notifications as Windows toasts (an iPhone over Bluetooth); this reads them
// through UserNotificationListener, which works for an unpackaged app as long as
// Settings › Privacy › Notifications lets apps read notifications. Only Phone Link's
// toasts leave this file, only to the island, and nothing is stored.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus as Access};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::overlay::LABEL as ISLAND;

/// Phone Link's app id starts with its package family (Microsoft.YourPhone_8wekyb3d8bbwe!App).
const PHONE_LINK: &str = "microsoft.yourphone_";
const POLL: Duration = Duration::from_secs(2);

/// The Phone activity is on: new notifications go to the island.
static WATCH: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneNote {
    id: u32,
    /// The phone app it came from ("Messages", "Instagram"), when Phone Link says.
    app: String,
    title: String,
    body: String,
}

fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Phone Link's toast lines: an iPhone's are app, sender, text; two lines are sender and text.
fn split(mut texts: Vec<String>) -> (String, String, String) {
    match texts.len() {
        0 => (String::new(), String::new(), String::new()),
        1 => (String::new(), texts.remove(0), String::new()),
        2 => {
            let body = texts.remove(1);
            (String::new(), texts.remove(0), body)
        }
        _ => {
            let app = texts.remove(0);
            let title = texts.remove(0);
            (app, title, texts.join("\n"))
        }
    }
}

/// The phone notification in one toast; None for anything that is not Phone Link's.
fn note(n: &UserNotification) -> Option<PhoneNote> {
    let aumid = n.AppInfo().ok()?.AppUserModelId().ok()?.to_string();
    if !aumid.to_lowercase().starts_with(PHONE_LINK) {
        return None;
    }
    let generic = KnownNotificationBindings::ToastGeneric().ok()?;
    let binding = n.Notification().ok()?.Visual().ok()?.GetBinding(&generic).ok()?;
    let texts: Vec<String> = binding.GetTextElements().ok()?.into_iter().filter_map(|t| t.Text().ok()).map(|s| s.to_string().trim().to_string()).collect();
    let (app, title, body) = split(texts);
    if title.is_empty() && body.is_empty() {
        return None;
    }
    Some(PhoneNote { id: n.Id().ok()?, app, title, body })
}

fn access() -> String {
    com();
    match UserNotificationListener::Current().and_then(|l| l.GetAccessStatus()) {
        Ok(Access::Allowed) => "allowed",
        Ok(Access::Denied) => "denied",
        Ok(_) => "unspecified",
        Err(_) => "unavailable",
    }
    .to_string()
}

fn run(app: AppHandle) {
    com();
    let listener = loop {
        match UserNotificationListener::Current() {
            Ok(l) => break l,
            Err(err) => {
                crate::log::line(format!("phone link: notification listener unavailable: {err}"));
                std::thread::sleep(Duration::from_secs(30));
            }
        }
    };
    // None until the first look after turning on: what is already there is old news.
    let mut seen: Option<HashSet<u32>> = None;
    let mut last_err = String::new();
    loop {
        std::thread::sleep(POLL);
        if !WATCH.load(Ordering::Relaxed) {
            seen = None;
            continue;
        }
        let list = match listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()) {
            Ok(list) => list,
            Err(err) => {
                let text = err.to_string();
                if text != last_err {
                    crate::log::line(format!("phone link: cannot read notifications: {text}"));
                    last_err = text;
                }
                continue;
            }
        };
        let mut now = HashSet::new();
        for n in list {
            let Ok(id) = n.Id() else { continue };
            now.insert(id);
            if seen.as_ref().is_some_and(|old| !old.contains(&id)) {
                if let Some(note) = note(&n) {
                    let _ = app.emit_to(ISLAND, "phone-note", note);
                }
            }
        }
        seen = Some(now);
    }
}

/// Turns watching on or off (the Phone activity starts and stops it) and says whether
/// Windows lets Island read notifications: allowed | denied | unspecified | unavailable.
#[tauri::command]
pub async fn phone_link_watch(app: AppHandle, on: bool) -> String {
    WATCH.store(on, Ordering::Relaxed);
    if on && !STARTED.swap(true, Ordering::SeqCst) {
        std::thread::spawn(move || run(app));
    }
    tauri::async_runtime::spawn_blocking(access).await.unwrap_or_else(|_| "unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::split;

    fn v(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn iphone_lines_are_app_sender_text() {
        assert_eq!(split(v(&["Messages", "Sam", "On my way"])), ("Messages".into(), "Sam".into(), "On my way".into()));
        assert_eq!(split(v(&["Sam", "On my way"])), (String::new(), "Sam".into(), "On my way".into()));
        assert_eq!(split(v(&["Hi"])), (String::new(), "Hi".into(), String::new()));
        assert_eq!(split(v(&["Mail", "Ana", "Line 1", "Line 2"])).2, "Line 1\nLine 2");
        assert_eq!(split(Vec::new()), (String::new(), String::new(), String::new()));
    }
}
