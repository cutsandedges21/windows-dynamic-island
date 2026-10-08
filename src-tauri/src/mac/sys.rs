// Facts about this Mac through sysctl and statfs: what Windows reads from the
// registry and Win32 in llama.rs, local.rs and hooks.rs.

use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn sysctl_bytes(name: &str) -> Option<Vec<u8>> {
    let name = CString::new(name).ok()?;
    let mut len: libc::size_t = 0;
    unsafe {
        if libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len];
        if libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        buf.truncate(len);
        Some(buf)
    }
}

fn sysctl_string(name: &str) -> Option<String> {
    let mut buf = sysctl_bytes(name)?;
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8(buf).ok()
}

pub fn total_memory() -> u64 {
    sysctl_bytes("hw.memsize").and_then(|b| b.try_into().ok()).map(u64::from_ne_bytes).unwrap_or(0)
}

pub fn cpu_name() -> String {
    sysctl_string("machdep.cpu.brand_string").map(|s| s.trim().to_string()).unwrap_or_default()
}

pub fn os_version() -> String {
    sysctl_string("kern.osproductversion").map(|v| format!("macOS {v}")).unwrap_or_else(|| "macOS".to_string())
}

pub fn uptime_secs() -> u64 {
    let Some(buf) = sysctl_bytes("kern.boottime") else { return 0 };
    if buf.len() < std::mem::size_of::<libc::timeval>() {
        return 0;
    }
    let boot = unsafe { std::ptr::read_unaligned(buf.as_ptr().cast::<libc::timeval>()) };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now.saturating_sub(boot.tv_sec.max(0) as u64)
}

/// (free bytes for this user, total bytes) of the volume holding `path`.
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = s.f_bsize as u64;
    Some((s.f_bavail * unit, s.f_blocks * unit))
}

pub fn host_name() -> String {
    let mut buf = [0 as libc::c_char; 256];
    if unsafe { libc::gethostname(buf.as_mut_ptr(), buf.len()) } != 0 {
        return String::new();
    }
    let name = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().to_string();
    name.trim_end_matches(".local").to_string()
}

/// Local time as yyyymmdd-hhmmss, for backup file names.
pub fn local_stamp() -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}
