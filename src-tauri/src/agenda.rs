// Your calendar, from the accounts Windows already syncs (Outlook, Microsoft
// 365, Google and iCloud added in Windows' own account settings): one read-only
// view of every calendar, through the public appointments API. Windows asks the
// user for calendar access the first time and keeps that answer in Settings ›
// Privacy › Calendar; nothing here reads an account's files or credentials.
//
// The island's calendar activity can still read an ICS link instead; this is the
// "all my calendars" source.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows::Foundation::{DateTime, TimeSpan};
use windows::ApplicationModel::Appointments::{AppointmentCalendar, AppointmentManager, AppointmentStore, AppointmentStoreAccessType, FindAppointmentsOptions};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// WinRT counts 100-nanosecond ticks from 1601-01-01; Unix time starts in 1970.
const TICKS_PER_MS: i64 = 10_000;
const EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;
/// A calendar can hold thousands of events; the island shows the next few.
const MAX_EVENTS: usize = 60;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgendaEvent {
    pub id: String,
    pub title: String,
    pub location: String,
    /// Epoch ms.
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    /// Teams, Meet, Zoom… whatever the invite carries.
    pub link: String,
    /// Which calendar it came from, for the card ("Work", "Family").
    pub calendar: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    pub ok: bool,
    /// Windows has no calendar accounts, or the user said no in Privacy settings.
    pub reason: Option<String>,
    pub calendars: Vec<String>,
    pub events: Vec<AgendaEvent>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn to_unix_ms(dt: DateTime) -> i64 {
    dt.UniversalTime / TICKS_PER_MS - EPOCH_OFFSET_MS
}

fn from_unix_ms(ms: i64) -> DateTime {
    DateTime { UniversalTime: (ms + EPOCH_OFFSET_MS) * TICKS_PER_MS }
}

fn store() -> Result<AppointmentStore, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    AppointmentManager::RequestStoreAsync(AppointmentStoreAccessType::AllCalendarsReadOnly)
        .map_err(|e| e.message())?
        .get()
        .map_err(|e| e.message())
}

fn calendar_names(store: &AppointmentStore) -> Vec<String> {
    let Ok(list) = store.FindAppointmentCalendarsAsync().and_then(|op| op.get()) else { return Vec::new() };
    let mut names = Vec::new();
    for cal in list {
        if let Ok(name) = AppointmentCalendar::DisplayName(&cal) {
            let name = name.to_string();
            if !name.is_empty() && !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// Everything in the next `days` days, soonest first.
#[tauri::command]
pub async fn agenda_read(back: u32, ahead: u32) -> Agenda {
    tauri::async_runtime::spawn_blocking(move || {
        let store = match store() {
            Ok(s) => s,
            Err(message) => return Agenda { ok: false, reason: Some(message), ..Default::default() },
        };
        let back = back.clamp(0, 14) as i64;
        let ahead = ahead.clamp(1, 60) as i64;
        // From the start of that day (or an hour ago), so a meeting that just started still shows.
        let start = now_ms() - (back * 86_400_000).max(3_600_000);
        let span = TimeSpan { Duration: ((back + ahead) * 86_400_000 + 3_600_000) * TICKS_PER_MS };
        let options = FindAppointmentsOptions::new().ok();
        let found = match options {
            Some(o) => store.FindAppointmentsAsyncWithOptions(from_unix_ms(start), span, &o).and_then(|op| op.get()),
            None => store.FindAppointmentsAsync(from_unix_ms(start), span).and_then(|op| op.get()),
        };
        let Ok(list) = found else {
            return Agenda { ok: false, reason: Some("Windows did not return any calendar".into()), calendars: calendar_names(&store), ..Default::default() };
        };
        let text = |v: windows::core::Result<windows::core::HSTRING>| v.map(|s| s.to_string()).unwrap_or_default();
        let mut events: Vec<AgendaEvent> = Vec::new();
        for a in list {
            let Ok(start_dt) = a.StartTime() else { continue };
            let start = to_unix_ms(start_dt);
            let minutes = a.Duration().map(|d| d.Duration / TICKS_PER_MS).unwrap_or(0);
            events.push(AgendaEvent {
                id: text(a.LocalId()),
                title: {
                    let subject = text(a.Subject());
                    if subject.is_empty() { "Busy".into() } else { subject }
                },
                location: text(a.Location()),
                start,
                end: start + minutes.max(0),
                all_day: a.AllDay().unwrap_or(false),
                link: text(a.OnlineMeetingLink()),
                calendar: a.CalendarId().map(|id| id.to_string()).unwrap_or_default(),
            });
        }
        events.sort_by_key(|e| e.start);
        events.truncate(MAX_EVENTS);
        let calendars = calendar_names(&store);
        Agenda {
            ok: true,
            reason: if calendars.is_empty() && events.is_empty() { Some("No calendar accounts are set up in Windows".into()) } else { None },
            calendars,
            events,
        }
    })
    .await
    .unwrap_or(Agenda { ok: false, reason: Some("Reading the calendar failed".into()), ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winrt_and_unix_time_agree() {
        // 2026-10-06T12:00:00Z
        let ms = 1_791_374_400_000i64;
        assert_eq!(to_unix_ms(from_unix_ms(ms)), ms);
        // The epoch itself: 1970 is 11644473600 s after 1601.
        assert_eq!(from_unix_ms(0).UniversalTime, EPOCH_OFFSET_MS * TICKS_PER_MS);
    }
}

#[cfg(test)]
mod probe {
    /// Dev probe: `cargo test -p island --lib probe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_this_pc_calendars() {
        let a = tauri::async_runtime::block_on(super::agenda_read(2, 14));
        println!("ok={} reason={:?} calendars={:?} events={}", a.ok, a.reason, a.calendars, a.events.len());
        for e in a.events.iter().take(5) {
            println!("  {} {} {}", e.start, e.title, e.calendar);
        }
    }
}
