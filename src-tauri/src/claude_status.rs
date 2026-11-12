// Claude Status, the native part: what the Claude Sessions widget read with
// Python and PowerShell (~/.claude/claude-status), so the activity works without
// it. Command lines of Claude Code's shells, the Claude notifications Windows
// keeps (the app posts one when a chat finishes, even minimized), and the
// Claude desktop app and Chrome through UI Automation: which conversations are
// open, the state their buttons show, and the app sidebar's status labels.
// The state logic around all this is TypeScript (src/activities/claude-status).

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use windows::core::{BOOL, BSTR, PCSTR, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, HWND, LPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationElementArray,
    IUIAutomationInvokePattern, IUIAutomationValuePattern, TreeScope_Children, TreeScope_Descendants, UIA_ButtonControlTypeId,
    UIA_ClassNamePropertyId, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_GroupControlTypeId, UIA_InvokePatternId,
    UIA_NamePropertyId, UIA_StatusBarControlTypeId, UIA_TextControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId};

// ------------------------------------------------------------------ command lines

#[link(name = "ntdll", kind = "raw-dylib")]
unsafe extern "system" {
    fn NtQueryInformationProcess(process: HANDLE, class: u32, info: *mut c_void, len: u32, ret: *mut u32) -> i32;
}

/// ProcessCommandLineInformation (Windows 8.1+): a UNICODE_STRING and its text.
const PROCESS_COMMAND_LINE: u32 = 60;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum: u16,
    buffer: *const u16,
}

fn command_line(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut size = 0u32;
        let _ = NtQueryInformationProcess(h, PROCESS_COMMAND_LINE, std::ptr::null_mut(), 0, &mut size);
        let mut out = None;
        if size > 0 && size < 1 << 20 {
            // u64 words keep the UNICODE_STRING at the start properly aligned.
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            if NtQueryInformationProcess(h, PROCESS_COMMAND_LINE, buf.as_mut_ptr().cast(), size, &mut size) == 0 {
                let us = &*(buf.as_ptr() as *const UnicodeString);
                if !us.buffer.is_null() {
                    out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(us.buffer, us.length as usize / 2)));
                }
            }
        }
        let _ = CloseHandle(h);
        out
    }
}

/// Command lines of these processes (None where it can't be read).
#[tauri::command]
pub async fn claude_status_cmdlines(pids: Vec<u32>) -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || pids.into_iter().take(64).map(command_line).collect()).await.unwrap_or_default()
}

// ------------------------------------------------------------------ notifications

const SQLITE_OK: i32 = 0;
const SQLITE_ROW: i32 = 100;
const SQLITE_OPEN_READONLY: i32 = 0x1;

type OpenFn = unsafe extern "system" fn(*const u8, *mut *mut c_void, i32, *const u8) -> i32;
type CloseFn = unsafe extern "system" fn(*mut c_void) -> i32;
type BusyFn = unsafe extern "system" fn(*mut c_void, i32) -> i32;
type PrepareFn = unsafe extern "system" fn(*mut c_void, *const u8, i32, *mut *mut c_void, *mut *const u8) -> i32;
type BindI64Fn = unsafe extern "system" fn(*mut c_void, i32, i64) -> i32;
type StepFn = unsafe extern "system" fn(*mut c_void) -> i32;
type ColI64Fn = unsafe extern "system" fn(*mut c_void, i32) -> i64;
type ColPtrFn = unsafe extern "system" fn(*mut c_void, i32) -> *const u8;
type ColBytesFn = unsafe extern "system" fn(*mut c_void, i32) -> i32;
type FinalizeFn = unsafe extern "system" fn(*mut c_void) -> i32;
/// What GetProcAddress hands back, before it is cast to the function it really is.
type Farproc = unsafe extern "system" fn() -> isize;

/// The SQLite that ships with Windows (winsqlite3.dll), loaded on first use so a
/// machine without it only loses this feature.
struct Sqlite {
    open: OpenFn,
    close: CloseFn,
    busy: BusyFn,
    prepare: PrepareFn,
    bind_i64: BindI64Fn,
    step: StepFn,
    col_i64: ColI64Fn,
    col_text: ColPtrFn,
    col_blob: ColPtrFn,
    col_bytes: ColBytesFn,
    finalize: FinalizeFn,
}

fn sqlite() -> Option<&'static Sqlite> {
    static LIB: OnceLock<Option<Sqlite>> = OnceLock::new();
    LIB.get_or_init(|| unsafe {
        let name: Vec<u16> = "winsqlite3.dll\0".encode_utf16().collect();
        let lib: HMODULE = LoadLibraryExW(PCWSTR(name.as_ptr()), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
        let f = |n: &[u8]| GetProcAddress(lib, PCSTR(n.as_ptr()));
        Some(Sqlite {
            open: std::mem::transmute::<Farproc, OpenFn>(f(b"sqlite3_open_v2\0")?),
            close: std::mem::transmute::<Farproc, CloseFn>(f(b"sqlite3_close\0")?),
            busy: std::mem::transmute::<Farproc, BusyFn>(f(b"sqlite3_busy_timeout\0")?),
            prepare: std::mem::transmute::<Farproc, PrepareFn>(f(b"sqlite3_prepare_v2\0")?),
            bind_i64: std::mem::transmute::<Farproc, BindI64Fn>(f(b"sqlite3_bind_int64\0")?),
            step: std::mem::transmute::<Farproc, StepFn>(f(b"sqlite3_step\0")?),
            col_i64: std::mem::transmute::<Farproc, ColI64Fn>(f(b"sqlite3_column_int64\0")?),
            col_text: std::mem::transmute::<Farproc, ColPtrFn>(f(b"sqlite3_column_text\0")?),
            col_blob: std::mem::transmute::<Farproc, ColPtrFn>(f(b"sqlite3_column_blob\0")?),
            col_bytes: std::mem::transmute::<Farproc, ColBytesFn>(f(b"sqlite3_column_bytes\0")?),
            finalize: std::mem::transmute::<Farproc, FinalizeFn>(f(b"sqlite3_finalize\0")?),
        })
    })
    .as_ref()
}

const FILETIME_UNIX_OFFSET_MS: f64 = 11_644_473_600_000.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeNotification {
    /// Unix ms.
    at: f64,
    /// "app": the Claude app; "chrome": "Claude responded" through Chrome;
    /// "titled": some other Chrome notification, which counts only if a chat has its title.
    source: &'static str,
    title: String,
    message: String,
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}

/// The <text> elements of a toast's XML, whitespace collapsed.
fn toast_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<text") {
        rest = &rest[i + 5..];
        // "<text>" or "<text ...>", not "<textBox" and the like.
        if !rest.starts_with('>') && !rest.starts_with(' ') {
            continue;
        }
        let Some(open) = rest.find('>') else { break };
        if rest[..open].ends_with('/') {
            rest = &rest[open + 1..];
            continue;
        }
        rest = &rest[open + 1..];
        let Some(close) = rest.find("</text>") else { break };
        out.push(unescape(&rest[..close].split_whitespace().collect::<Vec<_>>().join(" ")));
        rest = &rest[close + 7..];
    }
    out
}

fn read_notifications(after_ms: f64) -> Vec<ClaudeNotification> {
    let mut out = Vec::new();
    let Some(sql) = sqlite() else { return out };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return out };
    let db = std::path::PathBuf::from(local).join(r"Microsoft\Windows\Notifications\wpndatabase.db");
    let Ok(path) = std::ffi::CString::new(db.to_string_lossy().as_bytes()) else { return out };
    let after_ft = ((after_ms.max(0.0) + FILETIME_UNIX_OFFSET_MS) * 10_000.0) as i64;
    unsafe {
        let mut con: *mut c_void = std::ptr::null_mut();
        if (sql.open)(path.as_ptr().cast(), &mut con, SQLITE_OPEN_READONLY, std::ptr::null()) != SQLITE_OK {
            if !con.is_null() {
                (sql.close)(con);
            }
            return out;
        }
        (sql.busy)(con, 1000);
        let q = b"select n.ArrivalTime, h.PrimaryId, n.Payload from Notification n \
                  join NotificationHandler h on n.HandlerId = h.RecordId \
                  where n.ArrivalTime > ? order by n.ArrivalTime limit 200\0";
        let mut st: *mut c_void = std::ptr::null_mut();
        if (sql.prepare)(con, q.as_ptr(), -1, &mut st, std::ptr::null_mut()) == SQLITE_OK {
            (sql.bind_i64)(st, 1, after_ft);
            while (sql.step)(st) == SQLITE_ROW {
                let ft = (sql.col_i64)(st, 0);
                let handler = {
                    let p = (sql.col_text)(st, 1);
                    let n = (sql.col_bytes)(st, 1).max(0) as usize;
                    if p.is_null() { String::new() } else { String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned() }
                };
                let payload = {
                    let p = (sql.col_blob)(st, 2);
                    let n = (sql.col_bytes)(st, 2).max(0) as usize;
                    if p.is_null() { String::new() } else { String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned() }
                };
                let parts = toast_texts(&payload);
                let Some(title) = parts.first().cloned() else { continue };
                let message = parts.get(1).cloned().unwrap_or_default();
                let source = if handler.contains("AnthropicClaude") || handler.starts_with("Claude") {
                    "app"
                } else if handler == "Chrome" && title == "Claude responded" {
                    "chrome"
                } else if handler == "Chrome" {
                    // Newer app versions post through "Chrome" with the chat's title.
                    "titled"
                } else {
                    continue;
                };
                let title = if source == "chrome" { String::new() } else { title };
                out.push(ClaudeNotification { at: ft as f64 / 10_000.0 - FILETIME_UNIX_OFFSET_MS, source, title, message });
            }
            (sql.finalize)(st);
        }
        (sql.close)(con);
    }
    out
}

/// Claude notifications that arrived after `after_ms` (Unix ms), oldest first.
#[tauri::command]
pub async fn claude_status_notifications(after_ms: f64) -> Vec<ClaudeNotification> {
    tauri::async_runtime::spawn_blocking(move || read_notifications(after_ms)).await.unwrap_or_default()
}

// ------------------------------------------------------------------ UI Automation

/// Accessible names that show a conversation's state (found by recording the UI).
const INPUT_NAMES: &[&str] = &[
    "Allow once", "Always allow for this website", "Always allow", "Allow for this chat",
    // Claude's question picker.
    "Asking a question", "Next question", "Previous question",
];
const FAILED_NAMES: &[&str] = &["Try again"];
const RUNNING_NAMES: &[&str] = &["Stop response", "Claude is responding"];
const DONE_NAMES: &[&str] = &["Claude finished the response", "Send message"];

fn state_of(names: &[String]) -> &'static str {
    let any = |list: &[&str]| names.iter().any(|n| list.contains(&n.as_str()));
    if any(INPUT_NAMES) {
        "input"
    } else if any(FAILED_NAMES) {
        "failed"
    } else if any(RUNNING_NAMES) {
        "running"
    } else if any(DONE_NAMES) {
        "done"
    } else {
        "idle"
    }
}

/// One conversation seen this pass: an open one (a "<title> - Claude" document
/// in the app or Chrome) or a desktop-app sidebar row.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiChat {
    source: &'static str,
    hwnd: isize,
    title: String,
    /// Which of the sidebar rows with this title (0 for open ones).
    ord: u32,
    state: &'static str,
    open: bool,
    unread: bool,
    /// The chat's id from the page address; survives renames.
    chat: String,
    /// The app's "Step X of Y" for agentic runs.
    step: Option<u32>,
    steps: Option<u32>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiScan {
    chats: Vec<UiChat>,
    /// The app's sidebar is showing (else its other chats can't be seen).
    sidebar_open: bool,
    /// A Claude app window was found at all.
    app: bool,
}

struct Uia {
    a: IUIAutomation,
}

// UI Automation's objects are free-threaded once COM runs multithreaded; one
// thread at a time uses them through the mutex below.
unsafe impl Send for Uia {}

fn uia() -> &'static Mutex<Option<Uia>> {
    static U: OnceLock<Mutex<Option<Uia>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}

fn with_uia<T>(f: impl FnOnce(&IUIAutomation) -> windows::core::Result<T>) -> Option<T> {
    let mut guard = uia().lock().ok()?;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if guard.is_none() {
            let a: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            *guard = Some(Uia { a });
        }
    }
    let a = guard.as_ref()?.a.clone();
    f(&a).ok()
}

fn prop(a: &IUIAutomation, id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID, v: VARIANT) -> windows::core::Result<IUIAutomationCondition> {
    unsafe { a.CreatePropertyCondition(id, &v) }
}

fn control(a: &IUIAutomation, t: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID) -> windows::core::Result<IUIAutomationCondition> {
    prop(a, UIA_ControlTypePropertyId, VARIANT::from(t.0))
}

fn named(a: &IUIAutomation, name: &str) -> windows::core::Result<IUIAutomationCondition> {
    prop(a, UIA_NamePropertyId, VARIANT::from(BSTR::from(name)))
}

fn elements(arr: windows::core::Result<IUIAutomationElementArray>) -> Vec<IUIAutomationElement> {
    let Ok(arr) = arr else { return Vec::new() };
    let n = unsafe { arr.Length() }.unwrap_or(0);
    (0..n).filter_map(|i| unsafe { arr.GetElement(i) }.ok()).collect()
}

fn name_of(e: &IUIAutomationElement) -> String {
    unsafe { e.CurrentName() }.map(|b| b.to_string()).unwrap_or_default()
}

fn exe_names() -> std::collections::HashMap<u32, String> {
    crate::procs::snapshot(false).into_iter().map(|r| (r.0, r.2)).collect()
}

unsafe extern "system" fn collect_app_windows(hwnd: HWND, data: LPARAM) -> BOOL {
    let (pids, out) = unsafe { &mut *(data.0 as *mut (std::collections::HashSet<u32>, Vec<HWND>)) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pids.contains(&pid) {
        let mut cls = [0u16; 64];
        let mut title = [0u16; 64];
        let cn = unsafe { GetClassNameW(hwnd, &mut cls) }.max(0) as usize;
        let tn = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
        if String::from_utf16_lossy(&cls[..cn]) == "Chrome_WidgetWin_1" && String::from_utf16_lossy(&title[..tn]) == "Claude" {
            out.push(hwnd);
        }
    }
    true.into()
}

/// The Claude app's main windows, also when it is closed to the tray (hidden,
/// so missing from UI Automation's window list but readable by handle).
fn app_windows(names: &std::collections::HashMap<u32, String>) -> Vec<HWND> {
    let pids = names.iter().filter(|(_, n)| n.as_str() == "claude.exe").map(|(p, _)| *p).collect();
    let mut data: (std::collections::HashSet<u32>, Vec<HWND>) = (pids, Vec::new());
    unsafe {
        let _ = EnumWindows(Some(collect_app_windows), LPARAM(&mut data as *mut _ as isize));
    }
    data.1
}

/// "/chat/<uuid>" in a page address.
fn chat_id(url: &str) -> String {
    let Some(i) = url.find("/chat/") else { return String::new() };
    let id: String = url[i + 6..].chars().take(36).collect();
    if crate::claude::is_uuid(&id) { id.to_lowercase() } else { String::new() }
}

/// "Step 3 of 7" → (3, 7).
fn step_of(text: &str) -> Option<(u32, u32)> {
    let rest = text.strip_prefix("Step ")?;
    let (a, b) = rest.split_once(" of ")?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

fn scan(a: &IUIAutomation) -> windows::core::Result<UiScan> {
    let mut out = UiScan::default();
    let names = exe_names();
    let doc_cond = control(a, UIA_DocumentControlTypeId)?;
    let all: Vec<&str> = INPUT_NAMES.iter().chain(FAILED_NAMES).chain(RUNNING_NAMES).chain(DONE_NAMES).copied().collect();
    let signal_conds: Vec<Option<IUIAutomationCondition>> = all.iter().map(|n| named(a, n).ok()).collect();
    let signal_cond = unsafe { a.CreateOrConditionFromNativeArray(&signal_conds)? };
    let status_cond = control(a, UIA_StatusBarControlTypeId)?;
    let text_cond = control(a, UIA_TextControlTypeId)?;
    let show_sidebar = unsafe { a.CreateAndCondition(&control(a, UIA_ButtonControlTypeId)?, &named(a, "Show sidebar")?)? };
    let sidebar = unsafe { a.CreateAndCondition(&control(a, UIA_GroupControlTypeId)?, &named(a, "Sidebar")?)? };
    let walker = unsafe { a.RawViewWalker()? };

    let root = unsafe { a.GetRootElement()? };
    let class_cond = prop(a, UIA_ClassNamePropertyId, VARIANT::from(BSTR::from("Chrome_WidgetWin_1")))?;
    let mut windows = elements(unsafe { root.FindAll(TreeScope_Children, &class_cond) });
    let listed: std::collections::HashSet<isize> =
        windows.iter().filter_map(|w| unsafe { w.CurrentNativeWindowHandle() }.ok()).map(|h| h.0 as isize).collect();
    for h in app_windows(&names) {
        if !listed.contains(&(h.0 as isize)) {
            if let Ok(e) = unsafe { a.ElementFromHandle(h) } {
                windows.push(e);
            }
        }
    }

    for w in windows {
        let pid = unsafe { w.CurrentProcessId() }.unwrap_or(0) as u32;
        let source = match names.get(&pid).map(String::as_str) {
            Some("claude.exe") => "app",
            Some("chrome.exe") => "chrome",
            _ => continue,
        };
        if source == "app" {
            out.app = true;
        }
        let hwnd = unsafe { w.CurrentNativeWindowHandle() }.map(|h| h.0 as isize).unwrap_or(0);
        let first = out.chats.len();
        for d in elements(unsafe { w.FindAll(TreeScope_Descendants, &doc_cond) }) {
            let doc_name = name_of(&d);
            let Some(title) = doc_name.strip_suffix(" - Claude").filter(|t| !t.is_empty()) else { continue };
            let url = unsafe { d.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
                .and_then(|p| unsafe { p.CurrentValue() })
                .map(|b| b.to_string())
                .unwrap_or_default();
            let signals: Vec<String> = elements(unsafe { d.FindAll(TreeScope_Descendants, &signal_cond) }).iter().map(name_of).collect();
            out.chats.push(UiChat {
                source, hwnd, title: title.to_string(), ord: 0, state: state_of(&signals), open: true, unread: false,
                chat: chat_id(&url), step: None, steps: None,
            });
        }
        if source != "app" {
            continue;
        }
        // Agentic runs show "Step X of Y" in the open chat's header.
        if out.chats[first..].iter().any(|c| c.state == "running") {
            if let Some((step, steps)) = elements(unsafe { w.FindAll(TreeScope_Descendants, &text_cond) }).iter().find_map(|t| step_of(&name_of(t))) {
                for c in out.chats[first..].iter_mut().filter(|c| c.state == "running") {
                    c.step = Some(step);
                    c.steps = Some(steps);
                }
            }
        }
        if unsafe { w.FindFirst(TreeScope_Descendants, &show_sidebar) }.is_err() {
            out.sidebar_open = true;
        }
        // Sidebar rows carry a status label for every chat, even ones not open:
        // [Button title] [StatusBar status] [Group options]. Only the sidebar's own:
        // the Scheduled page lists tasks and their runs with the same labels.
        let scope = unsafe { w.FindFirst(TreeScope_Descendants, &sidebar) }.unwrap_or(w.clone());
        let mut ordinals: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for b in elements(unsafe { scope.FindAll(TreeScope_Descendants, &status_cond) }) {
            let label = name_of(&b);
            let state = match label.as_str() {
                "Running" => "running",
                "Awaiting input" => "input",
                "Unread response" => "done",
                _ => continue,
            };
            let Ok(parent) = (unsafe { walker.GetParentElement(&b) }) else { continue };
            let Ok(btn) = (unsafe { walker.GetFirstChildElement(&parent) }) else { continue };
            let title = name_of(&btn);
            if title.is_empty() {
                continue;
            }
            let ord = ordinals.entry(title.clone()).or_insert(0);
            out.chats.push(UiChat {
                source, hwnd, title, ord: *ord, state, open: false, unread: label == "Unread response", chat: String::new(), step: None, steps: None,
            });
            *ord += 1;
        }
    }
    Ok(out)
}

/// Every Claude conversation the app and Chrome show right now.
#[tauri::command]
pub async fn claude_status_ui_scan() -> UiScan {
    tauri::async_runtime::spawn_blocking(|| with_uia(scan).unwrap_or_default()).await.unwrap_or_default()
}

fn open_chat(a: &IUIAutomation, title: &str, ord: u32) -> windows::core::Result<bool> {
    let names = exe_names();
    let cond = unsafe { a.CreateAndCondition(&control(a, UIA_ButtonControlTypeId)?, &named(a, title)?)? };
    for h in app_windows(&names) {
        let Ok(w) = (unsafe { a.ElementFromHandle(h) }) else { continue };
        let buttons = elements(unsafe { w.FindAll(TreeScope_Descendants, &cond) });
        let Some(btn) = buttons.get((ord as usize).min(buttons.len().saturating_sub(1))) else { continue };
        let invoke = unsafe { btn.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)? };
        unsafe { invoke.Invoke()? };
        return Ok(true);
    }
    Ok(false)
}

/// Opens a conversation in the Claude app by pressing its sidebar row.
#[tauri::command]
pub async fn claude_status_open_chat(title: String, ord: u32) -> bool {
    tauri::async_runtime::spawn_blocking(move || with_uia(|a| open_chat(a, &title, ord)).unwrap_or(false)).await.unwrap_or(false)
}

/// The model router's kill switch: an empty `off` file next to its scripts, in Claude Code's
/// folder (auto_model.rs puts them there, and they look for it beside themselves).
fn router_off_file() -> Option<std::path::PathBuf> {
    Some(crate::claude::config_dir().join("model-router").join("off"))
}

/// Whether the model router is on (no `off` file).
#[tauri::command]
pub fn claude_router_get() -> bool {
    router_off_file().is_none_or(|p| !p.exists())
}

/// Turns the model router on or off for every session; returns the new state.
#[tauri::command]
pub fn claude_router_set(on: bool) -> bool {
    if let Some(p) = router_off_file() {
        if on {
            let _ = std::fs::remove_file(&p);
        } else {
            let _ = std::fs::write(&p, "");
        }
    }
    claude_router_get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_texts_are_read_in_order() {
        let xml = r#"<toast><visual><binding template="ToastGeneric"><text hint-maxLines="1">Fix   the
            build</text><text>Claude needs your input &amp; more</text><text/><image src="x"/></binding></visual></toast>"#;
        assert_eq!(toast_texts(xml), vec!["Fix the build".to_string(), "Claude needs your input & more".to_string()]);
    }

    #[test]
    fn states_follow_the_widget_order() {
        let s = |v: &[&str]| state_of(&v.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        assert_eq!(s(&["Send message", "Allow once"]), "input");
        assert_eq!(s(&["Send message", "Try again"]), "failed");
        assert_eq!(s(&["Stop response"]), "running");
        assert_eq!(s(&["Send message"]), "done");
        assert_eq!(s(&[]), "idle");
    }

    #[test]
    fn chat_ids_and_steps_parse() {
        assert_eq!(chat_id("https://claude.ai/chat/0A1B2C3D-0000-4000-8000-123456789ABC?x=1"), "0a1b2c3d-0000-4000-8000-123456789abc");
        assert_eq!(chat_id("https://claude.ai/new"), "");
        assert_eq!(step_of("Step 3 of 7"), Some((3, 7)));
        assert_eq!(step_of("Step three"), None);
    }
}
