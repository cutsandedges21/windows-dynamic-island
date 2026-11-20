// Processes and windows on a Mac: the kernel's process table (libproc) and Core Graphics' window
// list, in the same shapes procs.rs gives on Windows.
//
// A process's name is what Island's session code matches against: for anything inside an app
// bundle it is that app's bundle name ("visual studio code.app", "terminal.app"), the same for the
// app and all its helper processes; otherwise the program's own name ("claude", "node", "zsh").
// A window's handle is its Core Graphics window number. Window titles of other apps are only
// there when Island may record the screen; without them a window is matched by its app.

use std::ffi::CStr;

use serde::Serialize;

use crate::mac::cf;

#[derive(Serialize)]
pub struct ProcRow(pub u32, pub u32, pub String, pub Option<f64>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowRow {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
}

fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (got == size).then_some(info)
}

/// The executable's full path; None for processes of other users macOS keeps back.
pub fn exe_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

fn c_name(raw: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = raw.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).to_string()
}

/// Island's name for a process (see the top of this file).
pub fn name_from(path: Option<&str>, comm: &str) -> String {
    if let Some(p) = path {
        // An app's own program, or one of its helper apps (bundles inside its bundle): the app's
        // name. A plain tool an app carries in its Resources keeps its own.
        if let Some(app) = p.split('/').find(|part| part.ends_with(".app")) {
            let after = &p[p.find(&format!("{app}/")).map(|i| i + app.len()).unwrap_or(p.len())..];
            if after.starts_with("/Contents/MacOS/") || after.contains(".app/Contents/MacOS/") {
                return app.to_lowercase();
            }
        }
        let base = p.rsplit('/').next().unwrap_or_default();
        // Claude Code's own installer keeps each version as a file named after the version.
        if !base.is_empty() && base.chars().all(|c| c.is_ascii_digit() || c == '.') {
            if let Some(dir) = p.rsplit('/').nth(2) {
                return dir.to_lowercase();
            }
        }
        if !base.is_empty() {
            return base.to_lowercase();
        }
    }
    comm.trim().to_lowercase()
}

fn start_ms(info: &libc::proc_bsdinfo) -> Option<f64> {
    (info.pbi_start_tvsec > 0).then(|| info.pbi_start_tvsec as f64 * 1000.0 + (info.pbi_start_tvusec / 1000) as f64)
}

/// [pid, ppid, name, start ms] for every process.
pub fn snapshot() -> Vec<ProcRow> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let mut pids = vec![0 as libc::pid_t; count.max(0) as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(got.max(0) as usize);
    let mut rows = Vec::with_capacity(pids.len());
    for pid in pids {
        if pid <= 0 {
            continue;
        }
        let Some(info) = bsd_info(pid) else { continue };
        let comm = {
            let long = c_name(&info.pbi_name);
            if long.is_empty() {
                c_name(&info.pbi_comm)
            } else {
                long
            }
        };
        let path = exe_path(pid as u32);
        rows.push(ProcRow(pid as u32, info.pbi_ppid, name_from(path.as_deref(), &comm), start_ms(&info)));
    }
    rows
}

/// Normal windows on screen (layer 0), front first.
pub fn windows() -> Vec<WindowRow> {
    let me = std::process::id();
    cf::on_screen_windows()
        .into_iter()
        .filter(|w| w.layer == 0 && w.pid != me && w.bounds.2 > 40.0 && w.bounds.3 > 40.0)
        .map(|w| WindowRow { hwnd: w.id as isize, pid: w.pid, title: if w.title.is_empty() { w.owner } else { w.title } })
        .collect()
}

/// The app owning a window, or the nearest app above a helper process.
fn app_pid(mut pid: u32) -> Option<u32> {
    for _ in 0..8 {
        if pid <= 1 {
            return None;
        }
        if cf::is_app(pid) {
            return Some(pid);
        }
        pid = bsd_info(pid as i32)?.pbi_ppid;
    }
    None
}

/// Brings a window's app forward. A Mac raises a whole app; the window that comes up is the one
/// that app had in front.
pub fn activate(hwnd: isize) -> bool {
    let Some(w) = cf::window(hwnd as u32) else { return false };
    app_pid(w.pid).is_some_and(cf::activate_pid)
}

pub fn foreground_pid() -> u32 {
    cf::frontmost_pid()
}

/// The front window of the app in front: its window number, 0 when there is none.
pub fn foreground() -> isize {
    let pid = foreground_pid();
    if pid == 0 {
        return 0;
    }
    cf::on_screen_windows().into_iter().find(|w| w.pid == pid && w.layer == 0).map(|w| w.id as isize).unwrap_or(0)
}

/// The terminal device a process reads from ("/dev/ttys003"), for picking its Terminal tab.
pub fn tty_of(pid: u32) -> Option<String> {
    let info = bsd_info(pid as i32)?;
    let dev = info.e_tdev;
    if dev == 0 || dev == u32::MAX {
        return None;
    }
    let name = unsafe { libc::devname(dev as libc::dev_t, libc::S_IFCHR) };
    if name.is_null() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(name) }.to_string_lossy().to_string();
    (!s.is_empty() && s != "??").then(|| format!("/dev/{s}"))
}

/// The parent of a process; 0 when unknown.
pub fn parent_of(pid: u32) -> u32 {
    bsd_info(pid as i32).map(|i| i.pbi_ppid).unwrap_or(0)
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn proc_snapshot() -> Vec<ProcRow> {
    tauri::async_runtime::spawn_blocking(snapshot).await.unwrap_or_default()
}

#[tauri::command]
pub async fn win_enum() -> Vec<WindowRow> {
    tauri::async_runtime::spawn_blocking(windows).await.unwrap_or_default()
}

#[tauri::command]
pub fn win_activate(hwnd: isize) -> bool {
    let ok = activate(hwnd);
    crate::log::line(format!("activate window={hwnd} ok={ok}"));
    ok
}

#[tauri::command]
pub fn win_foreground() -> isize {
    foreground()
}

#[tauri::command]
pub fn win_foreground_pid() -> u32 {
    foreground_pid()
}

/// Shift, Control, Option or Command held down.
#[tauri::command]
pub fn input_modifiers_down() -> bool {
    crate::mac::input::modifiers_down()
}

/// Windows needs this before a deep link may bring its app forward; a Mac doesn't.
#[tauri::command]
pub fn win_allow_foreground() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processes_are_named_by_their_app() {
        let code = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)";
        assert_eq!(name_from(Some(code), "Code Helper (Plugin)"), "visual studio code.app");
        assert_eq!(name_from(Some("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), "Electron"), "visual studio code.app");
        assert_eq!(name_from(Some("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"), "Terminal"), "terminal.app");
        assert_eq!(name_from(Some("/bin/zsh"), "zsh"), "zsh");
        assert_eq!(name_from(Some("/Users/me/.local/share/claude/versions/2.1.300"), "2.1.300"), "claude");
        assert_eq!(name_from(Some("/opt/homebrew/bin/node"), "node"), "node");
        assert_eq!(name_from(None, "launchd"), "launchd");
        // A tool inside an app keeps its own name (Antigravity's agent).
        let ls = "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm";
        assert_eq!(name_from(Some(ls), "language_server_"), "language_server_macos_arm");
        assert_eq!(name_from(Some("/Applications/Antigravity.app/Contents/MacOS/Electron"), "Electron"), "antigravity.app");
    }

    #[test]
    fn this_process_is_in_the_table_with_its_parent() {
        let rows = snapshot();
        let me = rows.iter().find(|r| r.0 == std::process::id()).expect("this test's own process");
        assert_eq!(me.1, std::os::unix::process::parent_id());
        assert!(me.3.is_some_and(|ms| ms > 1.6e12), "a start time in ms since 1970");
        assert!(rows.len() > 20, "a Mac runs dozens of processes");
    }
}
