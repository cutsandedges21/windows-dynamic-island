//! The Win32 the relay needs: who we are, who is on the other end of the pipe
//! (from Coucou, MIT), and typing into another process's console.
//!
//! Named pipes live in a machine-wide namespace, so the pipe name carries our SID
//! and, once connected, we check the server process really belongs to us.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, WriteConsoleInputW, INPUT_RECORD, INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD,
    KEY_EVENT_RECORD_0,
};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe { token_sid(GetCurrentProcess()) }
}

/// True when the process serving `handle` runs as the same user we do. A failure
/// to answer is treated as "not ours".
pub fn pipe_server_is_same_user(handle: HANDLE) -> bool {
    let Some(mine) = current_user_sid() else { return false };
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeServerProcessId(handle, &mut pid).is_err() || pid == 0 {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let theirs = token_sid(process);
        let _ = CloseHandle(process);
        theirs.as_deref() == Some(mine.as_str())
    }
}

unsafe fn token_sid(process: HANDLE) -> Option<String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()? };
    let mut needed = 0u32;
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
    if needed == 0 {
        let _ = unsafe { CloseHandle(token) };
        return None;
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = unsafe { GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok() };
    let _ = unsafe { CloseHandle(token) };
    if !ok {
        return None;
    }
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let mut text = PWSTR::null();
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text).ok()? };
    let sid = unsafe { text.to_string().ok() };
    let _ = unsafe { LocalFree(Some(HLOCAL(text.0 as *mut _))) };
    sid
}

/// Parent of this relay: the shell Claude Code spawned it through.
pub fn parent_pid() -> u32 {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let me = GetCurrentProcessId();
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return 0 };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = 0;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == me {
                    found = e.th32ParentProcessID;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

fn key(unit: u16, vk: u16, scan: u16, down: bool) -> INPUT_RECORD {
    INPUT_RECORD {
        EventType: KEY_EVENT as u16,
        Event: INPUT_RECORD_0 {
            KeyEvent: KEY_EVENT_RECORD {
                bKeyDown: down.into(),
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: scan,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: unit },
                dwControlKeyState: 0,
            },
        },
    }
}

/// Types `text` and then Enter into the console `pid` is attached to, the way a
/// user typing in that terminal would. The text goes first and Enter a moment
/// later, so a fast burst is not read as a paste that swallows the Enter.
pub fn inject(pid: u32, text: &str) -> Result<(), String> {
    if pid == 0 || text.is_empty() {
        return Err("nothing to type".into());
    }
    unsafe {
        let _ = FreeConsole();
        AttachConsole(pid).map_err(|e| format!("attach to console of {pid}: {e}"))?;
        let name: Vec<u16> = "CONIN$\0".encode_utf16().collect();
        let handle = CreateFileW(
            PCWSTR(name.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        );
        let handle = match handle {
            Ok(h) => h,
            Err(e) => {
                let _ = FreeConsole();
                return Err(format!("open console input: {e}"));
            }
        };
        let mut records = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            records.push(key(unit, 0, 0, true));
            records.push(key(unit, 0, 0, false));
        }
        let mut written = 0u32;
        let typed = WriteConsoleInputW(handle, &records, &mut written);
        std::thread::sleep(std::time::Duration::from_millis(180));
        let enter = [key(13, 0x0D, 0x1C, true), key(13, 0x0D, 0x1C, false)];
        let entered = WriteConsoleInputW(handle, &enter, &mut written);
        let _ = CloseHandle(handle);
        let _ = FreeConsole();
        typed.map_err(|e| format!("type: {e}"))?;
        entered.map_err(|e| format!("enter: {e}"))?;
    }
    Ok(())
}
