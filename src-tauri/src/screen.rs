// Whether this PC can be reached with Chrome Remote Desktop, for the phone app's Screen button
// (design: docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md). Its host runs
// as the Windows service `chromoting`, which "Set up remote access" at
// remotedesktop.google.com/access installs. "ready": running; "off": installed but stopped;
// "missing": not installed; null: unknown (a Mac isn't looked at yet).

/// Chrome Remote Desktop's host service.
#[cfg(windows)]
const SERVICE: &str = "chromoting";

/// What the Service Control Manager says about a service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Service {
    Running,
    Stopped,
    Missing,
    Unknown,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn word(s: Service) -> Option<&'static str> {
    match s {
        Service::Running => Some("ready"),
        Service::Stopped => Some("off"),
        Service::Missing => Some("missing"),
        Service::Unknown => None,
    }
}

#[cfg(windows)]
fn query(name: &str) -> Service {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SERVICE_DOES_NOT_EXIST;
    use windows::Win32::System::Services::{CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS};
    unsafe {
        let Ok(scm) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else { return Service::Unknown };
        let state = match OpenServiceW(scm, &HSTRING::from(name), SERVICE_QUERY_STATUS) {
            Ok(svc) => {
                let mut status = SERVICE_STATUS::default();
                let state = match QueryServiceStatus(svc, &mut status) {
                    Ok(()) if status.dwCurrentState == SERVICE_RUNNING => Service::Running,
                    Ok(()) => Service::Stopped,
                    Err(_) => Service::Unknown,
                };
                let _ = CloseServiceHandle(svc);
                state
            }
            Err(e) if e.code() == ERROR_SERVICE_DOES_NOT_EXIST.to_hresult() => Service::Missing,
            Err(_) => Service::Unknown,
        };
        let _ = CloseServiceHandle(scm);
        state
    }
}

/// "ready", "off", "missing", or null when Island can't tell (always on a Mac).
#[tauri::command]
pub async fn screen_state() -> Option<String> {
    #[cfg(windows)]
    {
        let state = tauri::async_runtime::spawn_blocking(|| query(SERVICE)).await.unwrap_or(Service::Unknown);
        word(state).map(str::to_string)
    }
    #[cfg(not(windows))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_are_words_the_phone_knows() {
        assert_eq!(word(Service::Running), Some("ready"));
        assert_eq!(word(Service::Stopped), Some("off"));
        assert_eq!(word(Service::Missing), Some("missing"));
        assert_eq!(word(Service::Unknown), None);
    }

    #[cfg(windows)]
    #[test]
    fn the_service_manager_is_read() {
        // The event log always runs on Windows; this name never exists.
        assert_eq!(query("EventLog"), Service::Running);
        assert_eq!(query("island-no-such-service"), Service::Missing);
        // Whatever this PC has, it is one of the answers (Moss's: ready).
        let crd = query(SERVICE);
        eprintln!("chromoting: {crd:?} -> {:?}", word(crd));
        assert_ne!(crd, Service::Unknown);
    }
}
