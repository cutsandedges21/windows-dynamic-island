// Reminders that fire even when Island isn't running. Every upcoming reminder
// (src/activities/reminders.ts) is also handed to Windows as a scheduled toast, which Windows
// shows at its time on its own: Island closed, crashed or its window asleep doesn't matter. The
// island sends the whole list each time it changes; this makes Windows' schedule match it (stale
// ones out, new or changed ones in) and says which ids Windows holds, so the island doesn't show
// a second notification for those. The toast stays on screen until dismissed (the reminder
// scenario). On a Mac nothing is scheduled and the island notifies by itself, as before.

use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Upcoming {
    pub id: String,
    pub title: String,
    pub body: String,
    /// Epoch ms.
    pub at: i64,
}

/// Island's scheduled reminders carry this group, so nothing else of the app's is touched.
const GROUP: &str = "island-reminders";

/// What can go in toast XML: the five entities escaped, control characters (but line breaks) dropped.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// The toast for one reminder: its title and note, on screen until dismissed, with Windows' reminder sound.
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast scenario=\"reminder\" launch=\"island-reminder\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions><action content=\"Dismiss\" arguments=\"dismiss\" activationType=\"system\"/></actions><audio src=\"ms-winsoundevent:Notification.Reminder\"/></toast>",
        escape(title),
        escape(body)
    )
}

/// What a reminder says and when, in 12 characters (Windows refuses a scheduled toast Id of 16):
/// a reminder changed since Windows got it no longer matches, and is replaced. FNV-1a, so it is the
/// same on every build.
pub fn fingerprint(u: &Upcoming) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let bytes = u.title.bytes().chain([0]).chain(u.body.bytes()).chain([0]).chain(u.at.to_le_bytes());
    for b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

/// A reminder id that can be a toast's Tag (64 characters at most); the island's are 12.
fn usable_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The app id Island's notifications carry: the plugin's own choice (the identifier, or
/// PowerShell's while running from a Cargo build folder), so both kinds look the same.
fn app_id(identifier: &str) -> String {
    const POWERSHELL: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let from_build = dir.is_some_and(|d| d.ends_with(std::path::Path::new("target").join("debug")) || d.ends_with(std::path::Path::new("target").join("release")));
    if from_build { POWERSHELL.to_string() } else { identifier.to_string() }
}

/// Makes Windows' scheduled reminders exactly `items`; the ids Windows holds afterwards.
#[tauri::command]
pub async fn reminders_schedule(app: tauri::AppHandle, items: Vec<Upcoming>) -> Vec<String> {
    let id = app_id(&app.config().identifier);
    tauri::async_runtime::spawn_blocking(move || match imp::sync(&id, GROUP, &items) {
        Ok(held) => held,
        Err(e) => {
            crate::log::line(format!("reminders: Windows schedule failed: {e}"));
            Vec::new()
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(windows)]
mod imp {
    use super::{fingerprint, toast_xml, usable_id, Upcoming};
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::DateTime;
    use windows::UI::Notifications::{ScheduledToastNotification, ToastNotificationManager, ToastNotifier};
    use windows::Win32::System::Com::CoIncrementMTAUsage;

    /// WinRT counts 100-nanosecond ticks from 1601-01-01; Unix time starts in 1970.
    const TICKS_PER_MS: i64 = 10_000;
    const EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;
    /// Windows won't schedule a toast for a moment already gone; one this close is left to the island.
    const LEAD_MS: i64 = 2_000;

    fn now_ms() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// Keeps COM's shared apartment for the rest of the run. These calls come on short-lived worker
    /// threads; were the apartment to end with one of them, the factories the windows crate caches
    /// would point at nothing and the next call would crash Island.
    fn keep_apartment() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| unsafe {
            let _ = CoIncrementMTAUsage();
        });
    }

    pub fn sync(app_id: &str, group: &str, items: &[Upcoming]) -> Result<Vec<String>, String> {
        keep_apartment();
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).map_err(|e| e.message())?;
        let soon = now_ms() + LEAD_MS;
        let want: HashMap<&str, (&Upcoming, String)> = items.iter().filter(|u| usable_id(&u.id)).map(|u| (u.id.as_str(), (u, fingerprint(u)))).collect();
        let mut held: Vec<String> = Vec::new();
        for st in notifier.GetScheduledToastNotifications().map_err(|e| e.message())? {
            if st.Group().map(|g| g.to_string()).unwrap_or_default() != group {
                continue;
            }
            let tag = st.Tag().map(|t| t.to_string()).unwrap_or_default();
            let fp = st.Id().map(|t| t.to_string()).unwrap_or_default();
            match want.get(tag.as_str()) {
                Some((_, want_fp)) if *want_fp == fp && !held.contains(&tag) => held.push(tag),
                _ => {
                    // One firing right now is left to fire: pulling it could lose it.
                    let firing = st.DeliveryTime().map(|d| d.UniversalTime / TICKS_PER_MS - EPOCH_OFFSET_MS <= soon).unwrap_or(false);
                    if !firing {
                        let _ = notifier.RemoveFromSchedule(&st);
                    }
                }
            }
        }
        for (tag, (u, fp)) in &want {
            // Already there, or too late for Windows: the island shows those itself.
            if held.iter().any(|h| h == tag) || u.at <= soon {
                continue;
            }
            match add(&notifier, group, u, fp) {
                Ok(()) => held.push((*tag).to_string()),
                Err(e) => crate::log::line(format!("reminders: Windows would not schedule {tag}: {}", e.message())),
            }
        }
        Ok(held)
    }

    fn add(notifier: &ToastNotifier, group: &str, u: &Upcoming, fp: &str) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(&u.title, &u.body)))?;
        let when = DateTime { UniversalTime: (u.at + EPOCH_OFFSET_MS) * TICKS_PER_MS };
        let toast = ScheduledToastNotification::CreateScheduledToastNotification(&doc, when)?;
        toast.SetId(&HSTRING::from(fp))?;
        toast.SetTag(&HSTRING::from(u.id.as_str()))?;
        toast.SetGroup(&HSTRING::from(group))?;
        notifier.AddToSchedule(&toast)
    }

    /// Tags of `group`'s notifications Windows has shown (and keeps in the notification center).
    #[cfg(test)]
    pub fn shown(app_id: &str, group: &str) -> Result<Vec<String>, String> {
        keep_apartment();
        let history = ToastNotificationManager::History().map_err(|e| e.message())?;
        let mut out = Vec::new();
        for t in history.GetHistoryWithId(&HSTRING::from(app_id)).map_err(|e| e.message())? {
            if t.Group().map(|g| g.to_string()).unwrap_or_default() == group {
                out.push(t.Tag().map(|x| x.to_string()).unwrap_or_default());
            }
        }
        Ok(out)
    }

    /// Takes a shown notification off the screen and out of the notification center.
    #[cfg(test)]
    pub fn unshow(app_id: &str, group: &str, tag: &str) {
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(group), &HSTRING::from(app_id));
        }
    }

    /// What Windows holds in `group`: (tag, delivery time in epoch ms).
    #[cfg(test)]
    pub fn held(app_id: &str, group: &str) -> Result<Vec<(String, i64)>, String> {
        keep_apartment();
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).map_err(|e| e.message())?;
        let mut out = Vec::new();
        for st in notifier.GetScheduledToastNotifications().map_err(|e| e.message())? {
            if st.Group().map(|g| g.to_string()).unwrap_or_default() == group {
                let at = st.DeliveryTime().map(|d| d.UniversalTime / TICKS_PER_MS - EPOCH_OFFSET_MS).unwrap_or(0);
                out.push((st.Tag().map(|t| t.to_string()).unwrap_or_default(), at));
            }
        }
        Ok(out)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Upcoming;

    pub fn sync(_app_id: &str, _group: &str, _items: &[Upcoming]) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(id: &str, title: &str, at: i64) -> Upcoming {
        Upcoming { id: id.into(), title: title.into(), body: "Reminder · 3:00 PM".into(), at }
    }

    #[test]
    fn toast_text_is_escaped() {
        let xml = toast_xml("Tom & Jerry <3 \"quotes\" 'here'", "line one\nline two\u{7}");
        assert!(xml.contains("Tom &amp; Jerry &lt;3 &quot;quotes&quot; &apos;here&apos;"));
        assert!(xml.contains("line one\nline two</text>"));
        assert!(xml.contains("scenario=\"reminder\""));
        assert!(xml.contains("activationType=\"system\""));
    }

    #[test]
    fn fingerprint_is_short_and_follows_what_changed() {
        let a = up("abc", "Call mom", 1_800_000_000_000);
        let fp = fingerprint(&a);
        assert_eq!(fp.len(), 12);
        assert_eq!(fp, fingerprint(&a.clone()));
        assert_ne!(fp, fingerprint(&up("abc", "Call dad", 1_800_000_000_000)));
        assert_ne!(fp, fingerprint(&up("abc", "Call mom", 1_800_000_060_000)));
    }

    #[test]
    fn only_tag_sized_ids_are_scheduled() {
        assert!(usable_id("mgx1abcd1234"));
        assert!(!usable_id(""));
        assert!(!usable_id(&"a".repeat(65)));
        assert!(!usable_id("has space"));
    }

    /// Asks the real Windows to schedule two reminders in a test group, change one, drop one, and
    /// clean up, without ever touching Island's own reminders. Run with --ignored.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn windows_schedules_and_replaces() {
        let app = app_id("com.moss.island");
        let group = "island-reminders-test";
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let a = up("testa", "Test reminder A", now + 3_600_000);
        let b = up("testb", "Test reminder B", now + 7_200_000);
        let held = imp::sync(&app, group, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(held.len(), 2, "{held:?}");
        let mut on = imp::held(&app, group).unwrap();
        on.sort();
        assert_eq!(on, vec![("testa".to_string(), a.at), ("testb".to_string(), b.at)]);
        // A moved, B gone.
        let a2 = Upcoming { at: now + 5_400_000, ..a };
        let held = imp::sync(&app, group, std::slice::from_ref(&a2)).unwrap();
        assert_eq!(held, vec!["testa".to_string()]);
        assert_eq!(imp::held(&app, group).unwrap(), vec![("testa".to_string(), a2.at)]);
        imp::sync(&app, group, &[]).unwrap();
        assert!(imp::held(&app, group).unwrap().is_empty());
    }

    /// The real proof: a reminder handed to Windows 3 s ahead is shown by Windows at its time, with
    /// nothing of Island's running it (it pops up for a moment, then is taken away). Run with --ignored.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn windows_shows_it_on_time() {
        let app = app_id("com.moss.island");
        let group = "island-reminders-test";
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let a = Upcoming { id: "testshow".into(), title: "Island test reminder".into(), body: "Checking that Windows shows reminders on time.".into(), at: now + 3_000 };
        assert_eq!(imp::sync(&app, group, &[a]).unwrap(), vec!["testshow".to_string()]);
        assert!(imp::shown(&app, group).unwrap().is_empty());
        std::thread::sleep(std::time::Duration::from_secs(10));
        let shown = imp::shown(&app, group).unwrap();
        imp::unshow(&app, group, "testshow");
        assert_eq!(shown, vec!["testshow".to_string()]);
        assert!(imp::held(&app, group).unwrap().is_empty());
    }
}
