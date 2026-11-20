// Reminders on a Mac's own schedule: each upcoming reminder is handed to the Notification Center
// (NSUserNotificationCenter, what Island's other Mac notifications go through), which shows it at
// its time whether or not Island runs. Same contract as Windows' scheduled toasts (reminders.rs):
// the island's whole list in, Island's stale entries out, and the ids the Mac holds back.

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

use crate::msgwin::{nsstring, rust_string};
use crate::reminders::{fingerprint, Upcoming};

/// "island-reminders|<id>|<fingerprint>": the group, the reminder, and what it said (a changed
/// reminder is a new entry).
fn tag(group: &str, u: &Upcoming) -> String {
    format!("{group}|{}|{}", u.id, fingerprint(u))
}

fn id_of<'a>(group: &str, tag: &'a str) -> Option<&'a str> {
    let rest = tag.strip_prefix(group)?.strip_prefix('|')?;
    rest.split('|').next()
}

fn center() -> *mut AnyObject {
    unsafe { msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter] }
}

pub fn sync(group: &str, items: &[Upcoming]) -> Result<Vec<String>, String> {
    autoreleasepool(|_| unsafe {
        let c = center();
        if c.is_null() {
            return Err("the Notification Center isn't there for Island (no app bundle)".into());
        }
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let wanted: Vec<(String, &Upcoming)> = items.iter().filter(|u| u.at > now_ms + 1000).map(|u| (tag(group, u), u)).collect();
        // What the Mac holds of Island's now; anything not wanted any more goes.
        let scheduled: *mut AnyObject = msg_send![c, scheduledNotifications];
        let n: usize = if scheduled.is_null() { 0 } else { msg_send![scheduled, count] };
        let mut held: Vec<String> = Vec::new();
        for i in 0..n {
            let note: *mut AnyObject = msg_send![scheduled, objectAtIndex: i];
            let Some(t) = rust_string(msg_send![note, identifier]) else { continue };
            if id_of(group, &t).is_none() {
                continue;
            }
            if wanted.iter().any(|(w, _)| *w == t) {
                held.push(t);
            } else {
                let _: () = msg_send![c, removeScheduledNotification: note];
            }
        }
        for (t, u) in &wanted {
            if held.contains(t) {
                continue;
            }
            let note: *mut AnyObject = msg_send![class!(NSUserNotification), new];
            let _: () = msg_send![note, setTitle: nsstring(&u.title)];
            if !u.body.is_empty() {
                let _: () = msg_send![note, setInformativeText: nsstring(&u.body)];
            }
            let _: () = msg_send![note, setIdentifier: nsstring(t)];
            let when: *mut AnyObject = msg_send![class!(NSDate), dateWithTimeIntervalSince1970: u.at as f64 / 1000.0];
            let _: () = msg_send![note, setDeliveryDate: when];
            let sound = nsstring("NSUserNotificationDefaultSoundName");
            let _: () = msg_send![note, setSoundName: sound];
            let _: () = msg_send![c, scheduleNotification: note];
            let _: () = msg_send![note, release];
            held.push(t.clone());
        }
        Ok(held.iter().filter_map(|t| id_of(group, t).map(str::to_string)).collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_carry_the_reminder_id() {
        let u = Upcoming { id: "abc123".into(), title: "Lab".into(), body: String::new(), at: 1 };
        let t = tag("island-reminders", &u);
        assert!(t.starts_with("island-reminders|abc123|"));
        assert_eq!(id_of("island-reminders", &t), Some("abc123"));
        assert_eq!(id_of("island-reminders", "other|x|y"), None);
    }
}
