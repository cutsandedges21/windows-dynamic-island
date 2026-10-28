// Crashes: what happened goes to island.log before the process ends, and Island starts again.
//
// A release build aborts on a panic (`panic = "abort"`), which used to end Island with no
// trace. The panic hook, and on Windows a filter for crashes in native code, writes a `crash:`
// line, leaves `last-crash.txt` for the next start (which says so on the pill), and starts a
// new Island that waits for this one to be gone (`--after-crash <pid>`). Not when Island had
// run less than a minute, or less than ten minutes after starting from a crash, so a crash that
// keeps coming can't loop. Windows' own RegisterApplicationRestart was tried first (2026-10-27):
// Windows 11 never restarted a test program, after a panic or after an access violation.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const AFTER_CRASH: &str = "--after-crash";
const MIN_UP: Duration = Duration::from_secs(60);
const MIN_UP_AGAIN: Duration = Duration::from_secs(600);

/// When this run started, and whether a crash started it.
static STARTED: OnceLock<(Instant, bool)> = OnceLock::new();

/// First thing at startup, before any thread.
pub fn install(args: &[String]) {
    let _ = STARTED.set((Instant::now(), args.iter().any(|a| a == AFTER_CRASH)));
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let text = format!("panic in thread {}{at}: {}", thread.name().unwrap_or("unnamed"), panic_message(info.payload()));
        // A debug build unwinds, and a panic there may be caught (a tokio task): it ends nothing.
        crashed(&text, cfg!(panic = "abort"));
        default(info);
    }));
    #[cfg(windows)]
    native::install();
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    let text = payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned());
    text.unwrap_or_else(|| "(no message)".into())
}

/// Whether a crash after `up` should start Island again.
fn restarts(up: Duration, from_crash: bool) -> bool {
    up >= if from_crash { MIN_UP_AGAIN } else { MIN_UP }
}

fn marker() -> PathBuf {
    crate::log::data_dir().join("last-crash.txt")
}

/// The crash line; when the process is about to end, the marker and the new Island too.
fn crashed(text: &str, fatal: bool) {
    crate::log::line_now(&format!("crash: {text}"));
    if !fatal || cfg!(test) {
        return;
    }
    let _ = std::fs::write(marker(), text);
    let Some(&(at, from_crash)) = STARTED.get() else { return };
    if !restarts(at.elapsed(), from_crash) {
        crate::log::line_now("crash: not restarting (it crashed too soon after starting)");
        return;
    }
    let started = std::env::current_exe().and_then(|exe| std::process::Command::new(exe).args([AFTER_CRASH, &std::process::id().to_string()]).spawn());
    if let Err(e) = started {
        crate::log::line_now(&format!("crash: could not restart ({e})"));
    }
}

/// What the last run crashed with, once: the marker is gone after this.
pub fn take_last() -> Option<String> {
    take_marker(&marker())
}

fn take_marker(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let _ = std::fs::remove_file(file);
    Some(text.trim().to_string())
}

/// Started by a crash: waits (up to a minute; Windows may still be writing its crash report)
/// for the crashed process to be gone, so the single-instance check finds nothing.
pub fn after_crash(args: &[String]) -> bool {
    let Some(at) = args.iter().position(|a| a == AFTER_CRASH) else { return false };
    let Some(pid) = args.get(at + 1).and_then(|p| p.parse::<u32>().ok()) else { return true };
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                let _ = WaitForSingleObject(h, 60_000);
                let _ = CloseHandle(h);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let until = Instant::now() + Duration::from_secs(60);
        // kill(pid, 0) sends nothing: it only says whether the process is still there.
        while unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = pid;
    true
}

/// Crashes in native code (an access violation in a Windows call, say) skip Rust's panic hook.
/// The filter logs them and restarts Island, then lets Windows go on as before.
#[cfg(windows)]
mod native {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::Diagnostics::Debug::{SetUnhandledExceptionFilter, EXCEPTION_POINTERS};
    use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT};

    pub fn install() {
        unsafe {
            SetUnhandledExceptionFilter(Some(filter));
        }
    }

    unsafe extern "system" fn filter(info: *const EXCEPTION_POINTERS) -> i32 {
        let text = match unsafe { info.as_ref().and_then(|p| p.ExceptionRecord.as_ref()) } {
            Some(rec) => format!("exception 0x{:08X} at {}", rec.ExceptionCode.0 as u32, place(rec.ExceptionAddress as usize)),
            None => "exception".to_string(),
        };
        super::crashed(&text, true);
        0 // EXCEPTION_CONTINUE_SEARCH
    }

    /// "island.exe+0x1A2B3C": the module the address is in, and how far into it.
    fn place(addr: usize) -> String {
        let mut module = HMODULE::default();
        let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
        if unsafe { GetModuleHandleExW(flags, PCWSTR(addr as *const u16), &mut module) }.is_err() {
            return format!("0x{addr:X}");
        }
        let mut buf = [0u16; 260];
        let n = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
        let full = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        let name = full.rsplit(['\\', '/']).next().unwrap_or("?");
        format!("{name}+0x{:X}", addr.wrapping_sub(module.0 as usize))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    #[test]
    fn panic_messages_read_both_kinds_of_payload() {
        assert_eq!(super::panic_message(&"static text"), "static text");
        assert_eq!(super::panic_message(&String::from("formatted 7")), "formatted 7");
        assert_eq!(super::panic_message(&42_u8), "(no message)");
    }

    #[test]
    fn a_crash_restarts_island_only_after_it_has_run_a_while() {
        assert!(!super::restarts(Duration::from_secs(20), false));
        assert!(super::restarts(Duration::from_secs(61), false));
        // Started by a crash: ten minutes, or a crash that comes back every minute would loop.
        assert!(!super::restarts(Duration::from_secs(300), true));
        assert!(super::restarts(Duration::from_secs(601), true));
    }

    #[test]
    fn the_crash_marker_is_read_once() {
        let file = std::env::temp_dir().join(format!("island-crash-test-{}.txt", std::process::id()));
        std::fs::write(&file, "panic in thread main at src/x.rs:1: boom\n").unwrap();
        assert_eq!(super::take_marker(&file).as_deref(), Some("panic in thread main at src/x.rs:1: boom"));
        assert_eq!(super::take_marker(&file), None);
    }

    #[test]
    fn a_restarted_island_knows_it_and_waits_for_nothing_when_the_old_one_is_gone() {
        assert!(!super::after_crash(&["Island.exe".into()]));
        // A pid that can't exist: the wait ends at once.
        assert!(super::after_crash(&["Island.exe".into(), "--after-crash".into(), "4294967290".into()]));
        assert!(super::after_crash(&["Island.exe".into(), "--after-crash".into()]));
    }
}
