//! island-hook on a Mac: Island listens on a Unix socket in its own folder (only this user can
//! reach it), and the process tree comes from the kernel's process table. Same names as win.rs,
//! so main.rs calls either one the same way.

use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Must match Island's `socket_path()` in src-tauri/src/mac/pipe.rs exactly.
pub fn socket_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library").join("Application Support").join("Island").join("hook.sock")
}

/// Island's socket, or None at once when Island isn't running (nothing listens). Only a busy
/// socket (its queue full) is tried again, until `timeout`.
pub fn connect(timeout: Duration) -> Option<UnixStream> {
    let path = socket_path();
    let deadline = Instant::now() + timeout;
    loop {
        match UnixStream::connect(&path) {
            // Somebody else's server gets nothing from us.
            Ok(stream) => return same_user(&stream).then_some(stream),
            Err(err) => {
                let busy = matches!(err.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EINTR));
                if !busy || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

fn same_user(stream: &UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
    let ok = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0;
    ok && uid == unsafe { libc::getuid() }
}

/// The parent of `pid`, from the kernel; 0 when unknown.
fn parent_of(pid: u32) -> u32 {
    if pid == 0 {
        return 0;
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    if got == size {
        info.pbi_ppid
    } else {
        0
    }
}

/// (parent, grandparent) of this relay; 0 when unknown. A hook's grandparent is the AI itself
/// when a shell runs the hook (Claude Code: island-hook ← sh ← claude).
pub fn parents() -> (u32, u32) {
    let parent = std::os::unix::process::parent_id();
    (parent, parent_of(parent))
}

/// Typing into another program's terminal isn't something a Mac lets one process do to another:
/// Island types into Terminal and iTerm itself (src-tauri/src/mac/claude.rs).
pub fn inject(_pid: u32, _text: &str) -> Result<(), String> {
    Err("island-hook can't type into a terminal on a Mac; Island does it through the terminal app".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_in_islands_folder() {
        let p = socket_path();
        assert!(p.ends_with("Library/Application Support/Island/hook.sock"), "{}", p.display());
        // A Unix socket's path has room for 104 bytes on a Mac.
        assert!(p.as_os_str().len() < 104);
    }

    #[test]
    fn parents_come_from_the_process_table() {
        let (parent, _) = parents();
        assert_eq!(parent, std::os::unix::process::parent_id());
        assert_eq!(parent_of(std::process::id()), parent);
    }

    #[test]
    fn nobody_listening_means_no_connection_at_once() {
        let start = Instant::now();
        // HOME points somewhere without Island's socket.
        let dir = std::env::temp_dir().join(format!("island-hook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", &dir);
        assert!(connect(Duration::from_millis(300)).is_none());
        match old {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        assert!(start.elapsed() < Duration::from_millis(250));
    }
}
