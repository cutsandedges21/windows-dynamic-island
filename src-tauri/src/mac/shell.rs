// Small OS actions on a Mac: open URLs (same allow-list as Windows) and files with
// `open`, reveal in Finder with `open -R`, HTTP GET. Lock, snip and the clipboard
// come in part 4.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

const SCHEMES: &[&str] = &[
    "https", "http", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf", "claude", "spotify", "msteams", "zoommtg", "zoomus", "mailto",
];

fn scheme_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty() && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !url.contains(['\r', '\n', '\0'])
}

fn open(args: &[&str]) -> bool {
    Command::new("/usr/bin/open").args(args).status().is_ok_and(|s| s.success())
}

fn open_url_checked(url: &str) -> bool {
    if !scheme_ok(url) {
        crate::log::line(format!("refused url scheme: {}", url.split(':').next().unwrap_or("")));
        return false;
    }
    let ok = open(&[url]);
    crate::log::line(format!("open url {} ok={ok}", url.split('?').next().unwrap_or("")));
    ok
}

#[tauri::command]
pub fn open_url(url: String) -> bool {
    open_url_checked(&url)
}

/// A path under the user's folders, or an allow-listed URL.
#[tauri::command]
pub fn shell_open(target: String) -> bool {
    if target.contains("://") || target.starts_with("mailto:") {
        return open_url_checked(&target);
    }
    let p = Path::new(&target);
    crate::fsx::allowed(p) && p.exists() && open(&[&target])
}

#[tauri::command]
pub fn shell_reveal(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.exists() && open(&["-R", &path])
}

#[tauri::command]
pub fn shell_edit_image(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.is_file() && open(&["-a", "Preview", &path])
}

#[tauri::command]
pub fn shell_lock() {}

#[tauri::command]
pub fn shell_snip() {}

#[tauri::command]
pub fn clipboard_set_text() -> bool {
    false
}

#[tauri::command]
pub fn clipboard_copy_image() -> bool {
    false
}

#[tauri::command]
pub fn clipboard_history() {}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// HTTPS GET for calendar feeds and weather; capped and time-limited.
#[tauri::command]
pub async fn http_get(url: String, max_bytes: Option<usize>) -> Option<HttpResponse> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.ok()?;
    let cap = max_bytes.unwrap_or(2 * 1024 * 1024).min(16 * 1024 * 1024);
    Some(HttpResponse { status, body: String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).to_string() })
}
