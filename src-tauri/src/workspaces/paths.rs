// The paths a workspace names: whether each is there and what it is, and showing one in
// Explorer (Finder). A path may use %VARIABLES% (or ~ for the home folder), be relative to
// the project folder, or be a bare program name the system finds on its own ("code", "wt":
// App Paths, then PATH). Only existence and kind are read, never contents.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathCheck {
    /// "file", "dir", "missing" or "invalid".
    pub state: &'static str,
    /// Where it was found, when that differs from what was typed.
    pub resolved: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
}

/// Quotes trimmed, %NAME% replaced by the variable (left alone when there is none), a
/// leading ~ by the home folder.
pub fn expand(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(t).trim();
    let mut out = String::with_capacity(t.len());
    let mut rest = t;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let name_end = after.find('%').filter(|&end| {
            end > 0 && after[..end].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')' | '-'))
        });
        match name_end {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    if out == "~" || out.starts_with("~/") || out.starts_with("~\\") {
        if let Some(home) = home_dir() {
            out = format!("{}{}", home.display(), &out[1..]);
        }
    }
    out
}

fn has_separator(p: &str) -> bool {
    p.contains('/') || p.contains('\\')
}

/// A program Windows starts by name: its App Paths entry, then PATH with PATHEXT.
#[cfg(windows)]
fn find_program(name: &str) -> Option<PathBuf> {
    let lower = name.to_ascii_lowercase();
    let mut keys = vec![name.to_string()];
    if !lower.ends_with(".exe") {
        keys.push(format!("{name}.exe"));
    }
    for root in [windows_registry::CURRENT_USER, windows_registry::LOCAL_MACHINE] {
        for k in &keys {
            let Ok(key) = root.open(format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{k}")) else { continue };
            if let Ok(v) = key.get_hstring("") {
                let p = PathBuf::from(expand(&v.to_string()));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    let has_ext = exts.iter().any(|e| lower.ends_with(e.as_str()));
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        if has_ext && dir.join(name).is_file() {
            return Some(dir.join(name));
        }
        for e in &exts {
            let candidate = dir.join(format!("{name}{e}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// A program a Mac starts by name: on PATH, or an app in /Applications.
#[cfg(not(windows))]
fn find_program(name: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if dir.join(name).is_file() {
            return Some(dir.join(name));
        }
    }
    let bundle = if name.ends_with(".app") { name.to_string() } else { format!("{name}.app") };
    [PathBuf::from("/Applications"), PathBuf::from("/System/Applications")]
        .into_iter()
        .map(|d| d.join(&bundle))
        .find(|p| p.is_dir())
}

/// Where a typed path points: expanded, joined to the project folder when relative, or found
/// by name. None when it can't be a path at all.
pub fn resolve(raw: &str, base: &str) -> Option<PathBuf> {
    let p = expand(raw);
    if p.is_empty() || p.contains('\0') || p.len() > 32_000 {
        return None;
    }
    let path = PathBuf::from(&p);
    if path.is_absolute() {
        return Some(path);
    }
    if !base.trim().is_empty() {
        let joined = PathBuf::from(expand(base)).join(&path);
        if has_separator(&p) || joined.exists() {
            return Some(joined);
        }
    }
    if !has_separator(&p) {
        if let Some(found) = find_program(&p) {
            return Some(found);
        }
    }
    Some(path)
}

pub fn check_one(raw: &str, base: &str) -> PathCheck {
    let Some(path) = resolve(raw, base) else { return PathCheck { state: "invalid", resolved: None } };
    let shown = path.display().to_string();
    let resolved = (shown != raw.trim()).then_some(shown);
    match std::fs::metadata(Path::new(&path)) {
        Ok(m) if m.is_dir() => PathCheck { state: "dir", resolved },
        Ok(_) => PathCheck { state: "file", resolved },
        Err(_) => PathCheck { state: "missing", resolved: None },
    }
}

/// For each path: is it there, a file or a folder. Relative paths are taken from `base`.
#[tauri::command]
pub fn ws_check(paths: Vec<String>, base: String) -> Vec<PathCheck> {
    paths.iter().take(500).map(|p| check_one(p, &base)).collect()
}

/// Shows a path a workspace names: a folder opens in Explorer (Finder on a Mac), a file is
/// shown selected in its folder. Nothing is run or opened with its app.
#[tauri::command]
pub fn ws_show(path: String, base: String) -> bool {
    let Some(p) = resolve(&path, &base) else { return false };
    let Ok(meta) = std::fs::metadata(&p) else { return false };
    let shown = p.display().to_string();
    #[cfg(windows)]
    let ok = if meta.is_dir() {
        crate::shell::shell_execute("open", &shown, None)
    } else {
        crate::shell::shell_execute("open", "explorer.exe", Some(&format!("/select,\"{}\"", shown.replace('"', ""))))
    };
    #[cfg(not(windows))]
    let ok = {
        let mut open = std::process::Command::new("/usr/bin/open");
        if !meta.is_dir() {
            open.arg("-R");
        }
        open.arg(&shown).status().is_ok_and(|s| s.success())
    };
    ok
}
