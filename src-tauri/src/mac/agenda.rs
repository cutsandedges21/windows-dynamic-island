// The calendars on a Mac (iCloud, Google, Exchange… whatever Calendar has), through EventKit, in
// the shape agenda.rs gives on Windows. macOS asks the user once whether Island may read them.

use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send, sel};
use serde::Serialize;

use crate::msgwin::rust_string;

#[link(name = "EventKit", kind = "framework")]
extern "C" {}

const MAX_EVENTS: usize = 60;
const EVENTS: isize = 0; // EKEntityTypeEvent
const DAY_MS: i64 = 24 * 3600 * 1000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgendaEvent {
    pub id: String,
    pub title: String,
    pub location: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub link: String,
    pub calendar: String,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    pub ok: bool,
    pub reason: Option<String>,
    pub calendars: Vec<String>,
    pub events: Vec<AgendaEvent>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A meeting link in a location or notes: Teams, Zoom, Meet, Webex.
pub fn meeting_link(texts: &[&str]) -> String {
    for t in texts {
        for word in t.split(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '(' || c == ')') {
            let w = word.trim_end_matches(['.', ',', ';']);
            if w.starts_with("https://") && ["zoom.us/", "teams.microsoft.com/", "teams.live.com/", "meet.google.com/", "webex.com/"].iter().any(|h| w.contains(h)) {
                return w.to_string();
            }
        }
    }
    String::new()
}

/// EKAuthorizationStatus: 0 not asked yet, 1 restricted, 2 denied, 3 full access, 4 add-only.
fn status() -> isize {
    unsafe { msg_send![class!(EKEventStore), authorizationStatusForEntityType: EVENTS] }
}

/// Asks the user (the system's prompt) and waits for the answer.
fn ask(store: *mut AnyObject) -> bool {
    let (tx, rx) = mpsc::channel::<bool>();
    let block = RcBlock::new(move |granted: Bool, _err: *mut AnyObject| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        let full: bool = msg_send![store, respondsToSelector: sel!(requestFullAccessToEventsWithCompletion:)];
        if full {
            let _: () = msg_send![store, requestFullAccessToEventsWithCompletion: &*block];
        } else {
            let _: () = msg_send![store, requestAccessToEntityType: EVENTS, completion: &*block];
        }
    }
    rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
}

fn date(ms: i64) -> *mut AnyObject {
    unsafe { msg_send![class!(NSDate), dateWithTimeIntervalSince1970: ms as f64 / 1000.0] }
}

fn ms_of(d: *mut AnyObject) -> i64 {
    if d.is_null() {
        return 0;
    }
    let secs: f64 = unsafe { msg_send![d, timeIntervalSince1970] };
    (secs * 1000.0) as i64
}

fn read(back: u32, ahead: u32) -> Agenda {
    autoreleasepool(|_| unsafe {
        let store: *mut AnyObject = msg_send![class!(EKEventStore), new];
        if store.is_null() {
            return Agenda { reason: Some("This Mac's calendars couldn't be opened".into()), ..Default::default() };
        }
        let mut st = status();
        if st == 0 && ask(store) {
            st = 3;
        }
        if st != 3 {
            let _: () = msg_send![store, release];
            return Agenda { reason: Some("Island may not read your calendars: allow it under System Settings › Privacy & Security › Calendars".into()), ..Default::default() };
        }
        // A store made before access was given sees nothing: start again with a fresh one.
        let _: () = msg_send![store, release];
        let store: *mut AnyObject = msg_send![class!(EKEventStore), new];
        let now = now_ms();
        let from = date(now - back as i64 * DAY_MS);
        let to = date(now + ahead as i64 * DAY_MS);
        let predicate: *mut AnyObject = msg_send![store, predicateForEventsWithStartDate: from, endDate: to, calendars: std::ptr::null_mut::<AnyObject>()];
        let list: *mut AnyObject = msg_send![store, eventsMatchingPredicate: predicate];
        let mut events = Vec::new();
        let mut calendars: Vec<String> = Vec::new();
        let n: usize = if list.is_null() { 0 } else { msg_send![list, count] };
        for i in 0..n {
            let e: *mut AnyObject = msg_send![list, objectAtIndex: i];
            let title = rust_string(msg_send![e, title]).unwrap_or_default();
            let location = rust_string(msg_send![e, location]).unwrap_or_default();
            let notes = rust_string(msg_send![e, notes]).unwrap_or_default();
            let url: *mut AnyObject = msg_send![e, URL];
            let url = if url.is_null() { String::new() } else { rust_string(msg_send![url, absoluteString]).unwrap_or_default() };
            let cal: *mut AnyObject = msg_send![e, calendar];
            let calendar = if cal.is_null() { String::new() } else { rust_string(msg_send![cal, title]).unwrap_or_default() };
            if !calendar.is_empty() && !calendars.contains(&calendar) {
                calendars.push(calendar.clone());
            }
            let all_day: bool = msg_send![e, isAllDay];
            let id = rust_string(msg_send![e, eventIdentifier]).unwrap_or_default();
            let start = ms_of(msg_send![e, startDate]);
            let end = ms_of(msg_send![e, endDate]);
            let link = if url.starts_with("https://") { url.clone() } else { meeting_link(&[&location, &notes, &url]) };
            events.push(AgendaEvent { id: format!("{id}@{start}"), title, location, start, end, all_day, link, calendar });
        }
        let _: () = msg_send![store, release];
        // What is next first: past events only fill the week's strip.
        events.sort_by_key(|e| e.start);
        let first_next = events.iter().position(|e| e.end >= now).unwrap_or(events.len());
        let keep_from = first_next.saturating_sub(MAX_EVENTS / 2);
        let events: Vec<AgendaEvent> = events.into_iter().skip(keep_from).take(MAX_EVENTS).collect();
        let reason = (calendars.is_empty() && events.is_empty()).then(|| "No calendars are set up in this Mac's Calendar app".to_string());
        Agenda { ok: true, reason, calendars, events }
    })
}

#[tauri::command]
pub async fn agenda_read(back: u32, ahead: u32) -> Agenda {
    tauri::async_runtime::spawn_blocking(move || read(back.min(62), ahead.min(120))).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_links_are_found_in_notes() {
        assert_eq!(meeting_link(&["Room 4", "Join: https://us02web.zoom.us/j/123?pwd=x."]), "https://us02web.zoom.us/j/123?pwd=x");
        assert_eq!(meeting_link(&["<https://meet.google.com/abc-defg-hij>"]), "https://meet.google.com/abc-defg-hij");
        assert_eq!(meeting_link(&["https://example.com/party"]), "");
    }

    #[test]
    fn a_mac_without_access_says_why() {
        // The CI Mac never granted calendar access; reading must not hang there (status 0 would ask,
        // which a CI machine can't answer, so only look when it was decided already).
        if status() == 0 {
            return;
        }
        let a = read(1, 1);
        assert!(a.ok || a.reason.is_some());
    }
}
