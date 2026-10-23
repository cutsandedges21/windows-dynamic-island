// Files on disk: what a dropped path holds, safe names for what arrives, and where it lands.

use super::*;

// ------------------------------------------------------------------ files

/// A file to send: where it is, the name it arrives under ('/' between folders), its size.
#[derive(Clone, Debug)]
pub struct Item {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    /// Last changed (ms since 1970; 0 unknown): a resumed transfer goes on only if it is the same.
    pub mtime: u64,
}

pub(super) fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Files that are not worth sending when a whole folder goes.
pub(super) fn junk(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), ".ds_store" | "thumbs.db" | "desktop.ini")
}

/// Every file under the dropped paths: a file is itself, a folder is every file in it (links
/// and junctions are not followed), named from the folder down. At most MAX_FILES.
pub fn collect(paths: &[PathBuf]) -> Result<Vec<Item>, String> {
    let mut out = Vec::new();
    for root in paths {
        let meta = std::fs::symlink_metadata(root).map_err(|_| format!("{} is gone.", display_name(root)))?;
        let top = display_name(root);
        if meta.is_file() {
            out.push(Item { path: root.clone(), name: top, size: meta.len(), mtime: mtime_ms(&meta) });
        } else if meta.is_dir() {
            let mut stack = vec![(root.clone(), top, 0usize)];
            while let Some((dir, rel, depth)) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for e in entries.flatten() {
                    let Ok(ft) = e.file_type() else { continue };
                    let name = e.file_name().to_string_lossy().to_string();
                    if ft.is_symlink() {
                        continue;
                    }
                    let child = format!("{rel}/{name}");
                    if ft.is_dir() {
                        if depth + 1 < MAX_DEPTH {
                            stack.push((e.path(), child, depth + 1));
                        }
                    } else if ft.is_file() && !junk(&name) {
                        let (size, mtime) = e.metadata().map(|m| (m.len(), mtime_ms(&m))).unwrap_or((0, 0));
                        out.push(Item { path: e.path(), name: child, size, mtime });
                    }
                }
                if out.len() > MAX_FILES {
                    return Err(format!("That is more than {MAX_FILES} files. Send a zip of them instead."));
                }
            }
        }
        if out.len() > MAX_FILES {
            return Err(format!("That is more than {MAX_FILES} files. Send a zip of them instead."));
        }
    }
    Ok(out)
}

pub(super) fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| p.to_string_lossy().to_string())
}

/// What the island shows for a dropped path before it is sent.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub dir: bool,
    /// Files in it (1 for a file); more than MAX_FILES means too many.
    pub files: usize,
    pub error: Option<String>,
}

pub fn stage(path: &str) -> Staged {
    let p = PathBuf::from(path);
    let name = display_name(&p);
    let dir = std::fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
    match collect(std::slice::from_ref(&p)) {
        Ok(items) => Staged { path: path.into(), name, size: items.iter().map(|i| i.size).sum(), dir, files: items.len(), error: None },
        Err(e) => Staged { path: path.into(), name, size: 0, dir, files: 0, error: Some(e) },
    }
}

/// One part of an incoming name, safe on Windows and macOS: no separators, no characters
/// Windows refuses, no trailing dots or spaces, no device names (CON, NUL, COM1…), no "..".
pub fn clean_component(s: &str) -> Option<String> {
    let t: String = s.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let t = t.trim_start().trim_end_matches([' ', '.']).to_string();
    if t.is_empty() {
        return None;
    }
    let stem = t.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    let t = if device { format!("_{t}") } else { t };
    Some(clip_name(&t, 150))
}

/// At most `max` characters, keeping a short extension.
pub(super) fn clip_name(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    let keep = max.saturating_sub(ext.chars().count()).max(1);
    format!("{}{}", stem.chars().take(keep).collect::<String>(), ext)
}

/// ("photo", ".jpg"); a leading dot or a long tail is no extension.
pub(super) fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 16 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// An incoming relative name as safe folder and file names (at least one).
pub fn clean_rel(name: &str) -> Vec<String> {
    let parts: Vec<String> = name.split(['/', '\\']).filter_map(clean_component).take(MAX_DEPTH).collect();
    if parts.is_empty() {
        vec!["file".into()]
    } else {
        parts
    }
}

/// "photo.jpg", "photo (1).jpg", "photo (2).jpg"… (a folder keeps dots in its name).
pub fn candidate(name: &str, n: usize, folder: bool) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = if folder { (name, "") } else { split_ext(name) };
    format!("{stem} ({n}){ext}")
}

/// A new folder under `parent`, never one that is already there.
pub(super) fn reserve_dir(parent: &Path, name: &str) -> io::Result<PathBuf> {
    for n in 0..10_000 {
        let p = parent.join(candidate(name, n, true));
        match std::fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("no free folder name"))
}

/// Gives a finished temp file its name in `dir`, never replacing a file that is there: a
/// hard link fails when the name is taken (where links are not possible, a check, then a rename).
pub fn place(temp: &Path, dir: &Path, name: &str) -> io::Result<PathBuf> {
    for n in 0..10_000 {
        let p = dir.join(candidate(name, n, false));
        match std::fs::hard_link(temp, &p) {
            Ok(()) => {
                let _ = std::fs::remove_file(temp);
                return Ok(p);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                if p.exists() {
                    continue;
                }
                std::fs::rename(temp, &p)?;
                return Ok(p);
            }
        }
    }
    Err(io::Error::other("no free file name"))
}

/// A temp file for `name` in `dir` that nothing else is using.
pub(crate) async fn create_temp(dir: &Path, name: &str) -> io::Result<(PathBuf, tokio::fs::File)> {
    for n in 0..1000 {
        let p = if n == 0 { dir.join(format!("{name}.landing")) } else { dir.join(format!("{name}.{n}.landing")) };
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&p).await {
            Ok(f) => return Ok((p, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("no free temp name"))
}

/// Where an incoming file goes.
#[derive(Clone)]
pub(super) struct Target {
    pub(super) dir: PathBuf,
    pub(super) name: String,
    pub(super) size: u64,
    /// The folder it arrives in (a dropped folder), made for this transfer.
    pub(super) root: Option<PathBuf>,
}

/// Folders for the accepted files: each dropped folder gets a new folder in Downloads
/// ("Photos", or "Photos (1)" when that exists), so nothing already there is touched.
pub(super) fn prepare(downloads: &Path, files: &[OfferFile], litter: &mut Litter) -> io::Result<Vec<Target>> {
    std::fs::create_dir_all(downloads)?;
    let mut roots: HashMap<String, PathBuf> = HashMap::new();
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let parts = clean_rel(&f.name);
        if parts.len() == 1 {
            out.push(Target { dir: downloads.to_path_buf(), name: parts[0].clone(), size: f.size, root: None });
            continue;
        }
        let key = parts[0].to_lowercase();
        let root = match roots.get(&key) {
            Some(r) => r.clone(),
            None => {
                let r = reserve_dir(downloads, &parts[0])?;
                litter.roots.push(r.clone());
                roots.insert(key, r.clone());
                r
            }
        };
        let mut dir = root.clone();
        for p in &parts[1..parts.len() - 1] {
            dir.push(p);
        }
        std::fs::create_dir_all(&dir)?;
        out.push(Target { dir, name: parts[parts.len() - 1].clone(), size: f.size, root: Some(root) });
    }
    Ok(out)
}

/// Temp files and new folders of a transfer that did not finish: removed when it ends.
#[derive(Default)]
pub(super) struct Litter {
    pub(super) temps: Vec<PathBuf>,
    pub(super) roots: Vec<PathBuf>,
    pub(super) keep: bool,
}

impl Drop for Litter {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        for t in &self.temps {
            let _ = std::fs::remove_file(t);
        }
        for r in &self.roots {
            let _ = std::fs::remove_dir_all(r);
        }
    }
}

/// Bytes free for this user on the disk holding `dir` (its nearest existing parent).
pub(crate) fn free_space(dir: &Path) -> Option<u64> {
    let mut at = dir;
    while !at.exists() {
        at = at.parent()?;
    }
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = at.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let mut free = 0u64;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).ok()? };
        Some(free)
    }
    #[cfg(target_os = "macos")]
    {
        crate::mac::sys::disk_space(at).map(|(free, _)| free)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = at;
        None
    }
}

/// Marks a received file as coming from another computer, the way browsers mark downloads
/// and AirDrop marks what it receives: Windows then checks programs with SmartScreen and
/// Office opens documents in Protected View; a Mac checks it with Gatekeeper.
pub(crate) fn mark_from_network(path: &Path) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(stream, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let (Ok(p), Ok(name)) = (std::ffi::CString::new(path.as_os_str().as_bytes()), std::ffi::CString::new("com.apple.quarantine")) else { return };
        let value = format!("0081;{:x};Island;", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        unsafe { libc::setxattr(p.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = path;
}

/// The user's Downloads folder (where Windows has it, if it was moved).
pub fn downloads_dir() -> PathBuf {
    #[cfg(windows)]
    {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
        unsafe {
            if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Downloads, KNOWN_FOLDER_FLAG(0), None) {
                let s = p.to_string().unwrap_or_default();
                CoTaskMemFree(Some(p.0 as *const _));
                if !s.is_empty() {
                    return PathBuf::from(s);
                }
            }
        }
    }
    crate::claude::home().join("Downloads")
}

/// The name other devices see: Windows' device name, or the Mac's Computer Name.
pub fn computer_name() -> String {
    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::System::SystemInformation::{ComputerNamePhysicalDnsHostname, GetComputerNameExW};
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        if unsafe { GetComputerNameExW(ComputerNamePhysicalDnsHostname, Some(PWSTR(buf.as_mut_ptr())), &mut len) }.is_ok() {
            let s = String::from_utf16_lossy(&buf[..len as usize]);
            if !s.trim().is_empty() {
                return clean_name(&s);
            }
        }
        clean_name(&std::env::var("COMPUTERNAME").unwrap_or_default())
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if o.status.success() && !s.is_empty() {
                return clean_name(&s);
            }
        }
        clean_name(&crate::mac::sys::host_name())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        clean_name(&std::env::var("HOSTNAME").unwrap_or_default())
    }
}
