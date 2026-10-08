// Self-update from the GitHub releases. A release is one Island.exe, so updating
// is: download the newer exe beside the running one, rename the running exe to
// Island.old.exe (Windows allows that), move the new one into its place, start
// it and quit. The new process waits for the old one to be gone before the
// single-instance check, or that check would send it straight back.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

const REPO: &str = "cutsandedges21/windows-dynamic-island";
const ASSET: &str = "Island.exe";
/// After start, so the check never competes with the island coming up.
const FIRST_CHECK: Duration = Duration::from_secs(90);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Flag passed to the new exe: `--after-update <old pid> <old version>`.
const AFTER_UPDATE: &str = "--after-update";

/// Settings › Startup › Update automatically. Off until the island says otherwise.
static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

/// "v0.2.0", "0.2.0-beta.1" → (0, 2, 0). Anything after '-' or '+' is ignored.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next().flatten().unwrap_or(0), parts.next().flatten().unwrap_or(0));
    Some(v)
}

/// The newest release (pre-releases count) that ships an Island.exe and is newer than `current`.
fn newest<'a>(releases: &'a [Release], current: (u64, u64, u64)) -> Option<(&'a Release, &'a Asset)> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| Some((r, parse_version(&r.tag_name)?, r.assets.iter().find(|a| a.name.eq_ignore_ascii_case(ASSET))?)))
        .filter(|(_, v, _)| *v > current)
        .max_by_key(|(_, v, _)| *v)
        .map(|(r, _, a)| (r, a))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_default()
    })
}

fn current_version(app: &AppHandle) -> (u64, u64, u64) {
    let v = &app.package_info().version;
    (v.major, v.minor, v.patch)
}

/// Checks once; when a newer exe is out, installs it and restarts into it.
async fn check(app: &AppHandle) -> Result<(), String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=20");
    let res = client().get(url).header("Accept", "application/vnd.github+json").send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("releases: HTTP {}", res.status()));
    }
    let releases: Vec<Release> = res.json().await.map_err(|e| e.to_string())?;
    let Some((release, asset)) = newest(&releases, current_version(app)) else { return Ok(()) };

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("exe has no folder")?.to_path_buf();
    let temp = dir.join("Island.update.tmp");
    crate::log::line(format!("update: downloading {} ({} bytes)", release.tag_name, asset.size));
    let bytes = client().get(&asset.browser_download_url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
    let bytes = bytes.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 != asset.size || !bytes.starts_with(b"MZ") {
        return Err(format!("update: download is not a whole exe ({} of {} bytes)", bytes.len(), asset.size));
    }
    std::fs::write(&temp, &bytes).map_err(|e| format!("update: cannot write beside the exe: {e}"))?;
    swap_in(&exe, &temp, &dir)?;

    let from = app.package_info().version.to_string();
    crate::log::line(format!("update: {from} -> {}, restarting", release.tag_name));
    std::process::Command::new(&exe)
        .args([AFTER_UPDATE, &std::process::id().to_string(), &from])
        .spawn()
        .map_err(|e| format!("update: installed but could not restart: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Running exe → Island.old.exe, the download → the running exe's own name.
fn swap_in(exe: &Path, temp: &Path, dir: &Path) -> Result<(), String> {
    let old = dir.join("Island.old.exe");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| {
        let _ = std::fs::remove_file(temp);
        format!("update: cannot move the running exe aside: {e}")
    })?;
    if let Err(e) = std::fs::rename(temp, exe) {
        let _ = std::fs::rename(&old, exe);
        let _ = std::fs::remove_file(temp);
        return Err(format!("update: cannot put the new exe in place: {e}"));
    }
    Ok(())
}

/// The background checker. Development builds never update themselves.
pub fn start(app: AppHandle) {
    // Mac updates come with part 5; the release asset is a Windows exe.
    if cfg!(debug_assertions) || cfg!(target_os = "macos") {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if ENABLED.load(Ordering::Relaxed) {
                if let Err(e) = check(&app).await {
                    crate::log::line(e);
                }
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Started by an update: wait (up to 15 s) for the old process to quit, so the
/// single-instance check finds nothing. Returns the version updated from.
pub fn after_update(args: &[String]) -> Option<String> {
    let at = args.iter().position(|a| a == AFTER_UPDATE)?;
    let pid: u32 = args.get(at + 1)?.parse().ok()?;
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                let _ = WaitForSingleObject(h, 15_000);
                let _ = CloseHandle(h);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
    Some(args.get(at + 2).cloned().unwrap_or_default())
}

/// Says so in the pill once the island is up (through the activity API).
pub fn announce(app: AppHandle, from: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        let to = app.package_info().version.to_string();
        crate::log::line(format!("update: now on {to} (was {from})"));
        let _ = app.emit_to(
            crate::overlay::LABEL,
            "external-activity",
            serde_json::json!({ "island": "activity", "id": "island-update", "title": "Island updated", "text": format!("Now on {to}"), "icon": "check", "tone": "good", "ms": 8000 }),
        );
    });
}

/// A download a crash left behind goes. Island.old.exe stays: it is the way back.
pub fn tidy() {
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        let _ = std::fs::remove_file(dir.join("Island.update.tmp"));
    }
}

#[tauri::command]
pub fn update_set(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, draft: bool, with_exe: bool) -> Release {
        let assets = if with_exe { vec![Asset { name: "Island.exe".into(), size: 1, browser_download_url: String::new() }] } else { vec![] };
        Release { tag_name: tag.into(), draft, assets }
    }

    #[test]
    fn versions_parse() {
        assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("1.10"), Some((1, 10, 0)));
        assert_eq!(parse_version("v0.3.1-beta.2"), Some((0, 3, 1)));
        assert_eq!(parse_version("nightly"), None);
    }

    #[test]
    fn picks_the_newest_release_with_an_exe() {
        let list = vec![rel("v0.1.0", false, true), rel("v0.4.0", true, true), rel("v0.3.0", false, false), rel("v0.2.0", false, true)];
        assert_eq!(newest(&list, (0, 1, 0)).map(|(r, _)| r.tag_name.as_str()), Some("v0.2.0"));
        assert!(newest(&list, (0, 2, 0)).is_none());
    }
}
