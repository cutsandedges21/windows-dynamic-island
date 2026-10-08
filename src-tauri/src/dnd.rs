// Windows' Do Not Disturb. The public focus-session API (FocusSessionManager) is a
// Limited Access Feature: it refuses apps Microsoft has not unlocked, Island included
// ("Feature com.microsoft.windows.focussessionmanager.1 is not available", 0x80070005).
// So Island flips the switch Windows' notification service (WpnUserService) keeps:
// the quiet-hours profile, through its COM class in QuietHours.dll. Undocumented, so
// the focus-session API stays as the fallback where that class is missing.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, HSTRING, PCWSTR, PWSTR};
use windows::UI::Shell::FocusSessionManager;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED};

/// The first two methods of QuietHours.dll's settings interface; Island needs no others.
#[interface("6bff4732-81ec-4ffb-ae67-b6c1bc29631f")]
unsafe trait IQuietHoursSettings: IUnknown {
    fn get_user_selected_profile(&self, profile: *mut PWSTR) -> HRESULT;
    fn put_user_selected_profile(&self, profile: PCWSTR) -> HRESULT;
}

const CLSID_QUIET_HOURS_SETTINGS: GUID = GUID::from_u128(0xf53321fa_34f8_4b7f_b9a3_361877cb94cf);
/// Do Not Disturb off. Any other profile (priority only, alarms only) is on.
const PROFILE_OFF: &str = "Microsoft.QuietHoursProfile.Unrestricted";
/// What the notification center's Do Not Disturb switch picks: priority notifications still show.
const PROFILE_ON: &str = "Microsoft.QuietHoursProfile.PriorityOnly";

fn com() {
    // COM needs an apartment on this thread; a second call is harmless.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn quiet_hours() -> Option<IQuietHoursSettings> {
    com();
    unsafe { CoCreateInstance(&CLSID_QUIET_HOURS_SETTINGS, None, CLSCTX_LOCAL_SERVER) }.ok()
}

fn profile_on(q: &IQuietHoursSettings) -> Option<bool> {
    let mut p = PWSTR::null();
    unsafe {
        q.get_user_selected_profile(&mut p).ok().ok()?;
        if p.is_null() {
            return None;
        }
        let id = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        id.map(|id| id != PROFILE_OFF)
    }
}

fn set_profile(q: &IQuietHoursSettings, on: bool) -> windows::core::Result<()> {
    let id = HSTRING::from(if on { PROFILE_ON } else { PROFILE_OFF });
    unsafe { q.put_user_selected_profile(PCWSTR(id.as_ptr())) }.ok()
}

fn manager() -> Option<FocusSessionManager> {
    com();
    if !FocusSessionManager::IsSupported().unwrap_or(false) {
        return None;
    }
    FocusSessionManager::GetDefault().ok()
}

/// Whether Windows' Do Not Disturb is on; None where Windows will not say.
#[tauri::command]
pub async fn dnd_get() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(|| quiet_hours().and_then(|q| profile_on(&q)).or_else(|| manager()?.IsFocusActive().ok()))
        .await
        .ok()
        .flatten()
}

/// What happened when Island asked Windows to change Do Not Disturb.
#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DndResult {
    /// Windows did what was asked.
    pub ok: bool,
    /// Whether Do Not Disturb is on now (None when Windows will not say).
    pub active: Option<bool>,
    /// Why not, in words Island can show the user.
    pub reason: Option<String>,
}

/// Windows finishes a profile change in the background, and a second change a few
/// milliseconds behind the first can lose to it (seen here: on-then-off at once left
/// Do Not Disturb on, two times in three; 100 ms apart, never).
const CHANGE_GAP: Duration = Duration::from_millis(400);
static LAST_CHANGE: Mutex<Option<Instant>> = Mutex::new(None);

/// Turns Windows' Do Not Disturb on or off. When neither the quiet-hours switch nor
/// the focus API will do it, Island says so instead of pretending it worked.
#[tauri::command]
pub async fn dnd_set(on: bool) -> DndResult {
    tauri::async_runtime::spawn_blocking(move || {
        // Held through the change, so changes go to Windows one at a time and spaced out.
        let mut last = LAST_CHANGE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(wait) = last.and_then(|at| CHANGE_GAP.checked_sub(at.elapsed())) {
            std::thread::sleep(wait);
        }
        *last = Some(Instant::now());
        if let Some(q) = quiet_hours() {
            match set_profile(&q, on) {
                Ok(()) => return DndResult { ok: true, active: profile_on(&q), reason: None },
                Err(err) => crate::log::line(format!("windows quiet hours {}: {err}", if on { "on" } else { "off" })),
            }
        }
        let Some(m) = manager() else {
            return DndResult { ok: false, active: None, reason: Some("This version of Windows has no focus sessions.".into()) };
        };
        let result = if on { m.TryStartFocusSession().map(|_| ()) } else { m.DeactivateFocus() };
        let active = m.IsFocusActive().ok();
        match result {
            Ok(()) => DndResult { ok: true, active, reason: None },
            Err(err) => {
                crate::log::line(format!("windows focus {}: {err}", if on { "on" } else { "off" }));
                let reason = if err.message().contains("not available") {
                    "Windows keeps Do Not Disturb to itself on this PC, so only Island goes quiet."
                } else {
                    "Windows would not change Do Not Disturb, so only Island goes quiet."
                };
                DndResult { ok: false, active, reason: Some(reason.into()) }
            }
        }
    })
    .await
    .unwrap_or(DndResult { ok: false, active: None, reason: Some("Changing Do Not Disturb failed.".into()) })
}

#[cfg(test)]
mod tests {
    use tauri::async_runtime::block_on as block;

    /// Flips this PC's Do Not Disturb and straight back, then checks where Windows settled
    /// (a read right after a change can still show the old profile).
    /// `cargo test --lib dnd:: -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn flips_this_pcs_do_not_disturb() {
        let was = block(super::dnd_get()).expect("Windows says whether Do Not Disturb is on");
        let flip = block(super::dnd_set(!was));
        let back = block(super::dnd_set(was));
        std::thread::sleep(std::time::Duration::from_secs(2));
        let end = block(super::dnd_get());
        println!("was={was} flip ok={} back ok={} end={end:?}", flip.ok, back.ok);
        assert!(flip.ok && back.ok);
        assert_eq!(end, Some(was));
    }
}
