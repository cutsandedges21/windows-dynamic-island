// Claude Status on a Mac: Claude Code's sessions from their transcripts and processes, with the
// command lines of their shells from the kernel. Windows' notification store and its UI Automation of
// the Claude app and Chrome have no Mac twin: their chats aren't listed on a Mac.

/// A process's command line from the kernel (KERN_PROCARGS2: the argument count, the program's
/// path, then the arguments), words joined by spaces; None for one Island may not read.
pub fn command_line(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size: libc::size_t = 0;
    unsafe {
        if libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) != 0 || size < 4 {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        buf.truncate(size);
        args_from(&buf)
    }
}

/// KERN_PROCARGS2's bytes as one line: argc, the exec path, padding, then argc arguments.
pub fn args_from(buf: &[u8]) -> Option<String> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?).max(0) as usize;
    let mut rest = &buf[4..];
    // The exec path and the zeros after it.
    let end = rest.iter().position(|b| *b == 0)?;
    rest = &rest[end..];
    let start = rest.iter().position(|b| *b != 0)?;
    rest = &rest[start..];
    let words: Vec<String> = rest.split(|b| *b == 0).take(argc).map(|w| String::from_utf8_lossy(w).to_string()).collect();
    (!words.is_empty()).then(|| words.join(" "))
}

/// Command lines of these processes (what Claude Status reads a chat's shells from).
#[tauri::command]
pub async fn claude_status_cmdlines(pids: Vec<u32>) -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || pids.into_iter().take(64).map(command_line).collect()).await.unwrap_or_default()
}

#[tauri::command]
pub async fn claude_status_notifications() -> Vec<()> {
    Vec::new()
}

#[tauri::command]
pub async fn claude_status_ui_scan() -> Option<()> {
    None
}

#[tauri::command]
pub async fn claude_status_open_chat() -> bool {
    false
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
    fn this_process_s_command_line_is_read() {
        let line = command_line(std::process::id()).expect("our own command line");
        assert!(!line.is_empty());
    }

    #[test]
    fn the_kernel_s_layout_is_read() {
        let mut buf = 2i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/bin/sh\0\0\0sh\0-c\0echo hi\0HOME=/x\0");
        assert_eq!(args_from(&buf).as_deref(), Some("sh -c"));
    }
}
