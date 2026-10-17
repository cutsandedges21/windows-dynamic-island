// Self-update from the GitHub releases, on Windows and on a Mac. A release carries Island.exe
// and Island.dmg, the files people download.
//
// Windows: download the newer exe beside the running one, rename the running exe to
// Island.old.exe (Windows allows that, not overwriting it), move the new one into its place,
// start it and quit.
//
// Mac: download Island.dmg, open it privately (hdiutil, not shown in Finder), copy its
// Island.app next to the installed one, put the installed one aside as Island.old.app, move
// the new one into its place, open it and quit. Only an Island.app the user can replace
// updates: not one running from the disk image or from Downloads (macOS runs a read-only copy
// of an app that was never moved), and macOS may ask to let Island change apps (Privacy &
// Security › App Management); the island says so when it can't.
//
// Either way the new process waits for the old one to be gone before the single-instance
// check, or that check would send it straight back, and then deletes what was put aside: one
// Island is left, under its own name.
//
// Only a signed release is installed. Its notes carry `<!-- island-signature: <base64> -->`
// lines: Ed25519 signatures, by the key whose public half is UPDATE_KEY, over the version and
// the SHA-256 of a file (scripts/sign-release.mjs makes one per file). The downloaded file must
// match one of them. Someone who gets into the GitHub account or swaps an asset still can't
// make Islands run their build. Pre-releases are skipped: they are for people who download
// them on purpose.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use sha2::Digest;
use tauri::{AppHandle, Emitter};

const REPO: &str = "cutsandedges21/windows-dynamic-island";
/// The release file this platform installs.
#[cfg(not(target_os = "macos"))]
const ASSET: &str = "Island.exe";
#[cfg(target_os = "macos")]
const ASSET: &str = "Island.dmg";
/// Where the running exe goes while its replacement moves in (Windows).
const OLD: &str = "Island.old.exe";
/// Where the installed app goes while its replacement moves in (Mac), and where the new one waits.
#[cfg(target_os = "macos")]
const OLD_APP: &str = "Island.old.app";
#[cfg(target_os = "macos")]
const NEW_APP: &str = "Island.app.new";
/// After start, so the check never competes with the island coming up.
const FIRST_CHECK: Duration = Duration::from_secs(90);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Flag passed to the new Island: `--after-update <old pid> <old version>`.
const AFTER_UPDATE: &str = "--after-update";

/// The public half of the release signing key (its private half never leaves Moss's PC).
const UPDATE_KEY: &str = "5da0eca13f185218ba00e673a955772d6e92e5285bbbfb52221e1932d05b6115";
/// Where a signature sits in a release's notes (an HTML comment, invisible on GitHub).
const SIGNATURE_TAG: &str = "<!-- island-signature:";

/// Settings › Startup › Update automatically. Off until the island says otherwise.
static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    /// The release notes, where the signatures are.
    #[serde(default)]
    body: Option<String>,
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

/// The newest full release that ships this platform's file and is newer than `current`.
fn newest(releases: &[Release], current: (u64, u64, u64)) -> Option<(&Release, &Asset)> {
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease)
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

/// What a downloaded file must look like before anything else: a Windows exe starts "MZ", a
/// disk image ends with its "koly" trailer.
fn looks_whole(bytes: &[u8]) -> bool {
    if cfg!(target_os = "macos") {
        is_dmg(bytes)
    } else {
        bytes.starts_with(b"MZ")
    }
}

fn is_dmg(bytes: &[u8]) -> bool {
    bytes.len() >= 512 && &bytes[bytes.len() - 512..bytes.len() - 508] == b"koly"
}

/// Checks once; when a newer release is out, installs it and restarts into it.
async fn check(app: &AppHandle) -> Result<(), String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=20");
    let res = client().get(url).header("Accept", "application/vnd.github+json").send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("releases: HTTP {}", res.status()));
    }
    let releases: Vec<Release> = res.json().await.map_err(|e| e.to_string())?;
    let Some((release, asset)) = newest(&releases, current_version(app)) else { return Ok(()) };

    // A Mac app that can't be replaced isn't downloaded for nothing.
    #[cfg(target_os = "macos")]
    let installed = match bundle() {
        Ok(b) => b,
        Err(e) => {
            notice_once(app, &release.tag_name, "Island can't update itself here", "Move Island to Applications, then open it from there.");
            return Err(e);
        }
    };

    crate::log::line(format!("update: downloading {} {} ({} bytes)", release.tag_name, asset.name, asset.size));
    let bytes = client().get(&asset.browser_download_url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
    let bytes = bytes.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 != asset.size || !looks_whole(&bytes) {
        return Err(format!("update: the download is not a whole {} ({} of {} bytes)", asset.name, bytes.len(), asset.size));
    }
    let version = release.tag_name.trim().trim_start_matches(['v', 'V']);
    let signatures = signatures_in(release.body.as_deref().unwrap_or(""));
    if signatures.is_empty() {
        return Err(format!("update: {} is not signed, so it was not installed", release.tag_name));
    }
    if !signatures.iter().any(|sig| signed_by(UPDATE_KEY, version, &bytes, sig)) {
        return Err(format!("update: no signature of {} matches its {}, so it was not installed", release.tag_name, asset.name));
    }
    let from = app.package_info().version.to_string();

    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or("exe has no folder")?.to_path_buf();
        let temp = dir.join("Island.update.tmp");
        std::fs::write(&temp, &bytes).map_err(|e| format!("update: cannot write beside the exe: {e}"))?;
        swap_in(&exe, &temp, &dir)?;
        crate::log::line(format!("update: {from} -> {}, restarting", release.tag_name));
        std::process::Command::new(&exe)
            .args([AFTER_UPDATE, &std::process::id().to_string(), &from])
            .spawn()
            .map_err(|e| format!("update: installed but could not restart: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let dmg = std::env::temp_dir().join("Island-update.dmg");
        std::fs::write(&dmg, &bytes).map_err(|e| format!("update: cannot save the disk image: {e}"))?;
        let (image, target) = (dmg.clone(), installed.clone());
        let done = tokio::task::spawn_blocking(move || install_dmg(&image, &target)).await.map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&dmg);
        if let Err(e) = done {
            notice_once(app, &release.tag_name, "Island couldn't update itself", "If macOS asks, let Island change apps (Privacy & Security › App Management), or download the new Island.dmg.");
            return Err(e);
        }
        crate::log::line(format!("update: {from} -> {}, restarting", release.tag_name));
        std::process::Command::new("open")
            .arg("-n")
            .arg(&installed)
            .args(["--args", AFTER_UPDATE, &std::process::id().to_string(), &from])
            .spawn()
            .map_err(|e| format!("update: installed but could not restart: {e}"))?;
    }

    app.exit(0);
    Ok(())
}

/// The bytes a release signs: the version it installs and the file's SHA-256, together, so an
/// old signed file can't come back labelled as a newer version.
fn signed_message(version: &str, file: &[u8]) -> Vec<u8> {
    let digest: String = sha2::Sha256::digest(file).iter().map(|b| format!("{b:02x}")).collect();
    format!("island-update\n{version}\n{digest}").into_bytes()
}

/// Every signature in a release's notes (one per file).
fn signatures_in(body: &str) -> Vec<[u8; 64]> {
    use base64::Engine;
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find(SIGNATURE_TAG) {
        rest = &rest[at + SIGNATURE_TAG.len()..];
        let Some(end) = rest.find("-->") else { break };
        if let Some(sig) = base64::engine::general_purpose::STANDARD.decode(rest[..end].trim()).ok().and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok()) {
            out.push(sig);
        }
        rest = &rest[end..];
    }
    out
}

/// Whether `signature` is `key_hex`'s over this version and file.
fn signed_by(key_hex: &str, version: &str, file: &[u8], signature: &[u8; 64]) -> bool {
    let Some(key) = data_encoding::HEXLOWER_PERMISSIVE.decode(key_hex.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok()) else { return false };
    let Ok(key) = iroh::PublicKey::from_bytes(&key) else { return false };
    key.verify(&signed_message(version, file), &iroh::Signature::from_bytes(signature)).is_ok()
}

/// Running exe → Island.old.exe (the new process deletes it, see tidy), the
/// download → the running exe's own name.
#[cfg(windows)]
fn swap_in(exe: &Path, temp: &Path, dir: &Path) -> Result<(), String> {
    let old = dir.join(OLD);
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

// ------------------------------------------------------------------ Mac

/// The installed Island.app (from …/Island.app/Contents/MacOS/island), if it can be replaced.
#[cfg(target_os = "macos")]
fn bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    bundle_of(&exe)
}

#[cfg(target_os = "macos")]
fn bundle_of(exe: &Path) -> Result<PathBuf, String> {
    let app = exe.parent().and_then(Path::parent).and_then(Path::parent).ok_or("update: Island isn't in an app bundle")?.to_path_buf();
    if app.extension().and_then(|e| e.to_str()) != Some("app") {
        return Err("update: Island isn't in an app bundle".into());
    }
    let s = app.to_string_lossy();
    // From the disk image, or never moved out of Downloads (macOS then runs a read-only copy).
    if s.starts_with("/Volumes/") || s.contains("/AppTranslocation/") {
        return Err("update: Island runs from the disk image or where it was downloaded; it updates once it is in Applications".into());
    }
    Ok(app)
}

/// Puts the Island.app inside `dmg` where `app` is. The installed one waits as Island.old.app
/// (the next start deletes it); if anything fails, it stays where it was.
#[cfg(target_os = "macos")]
fn install_dmg(dmg: &Path, app: &Path) -> Result<(), String> {
    use std::process::Command;
    let mount = std::env::temp_dir().join(format!("island-update-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&mount);
    // hdiutil now and then answers "Resource busy"; a second try a moment later gets through.
    let attached = (0..3).any(|i| {
        if i > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        Command::new("hdiutil")
            .args(["attach", "-nobrowse", "-noautoopen", "-readonly", "-quiet", "-mountpoint"])
            .arg(&mount)
            .arg(dmg)
            .status()
            .is_ok_and(|s| s.success())
    });
    if !attached {
        let _ = std::fs::remove_dir(&mount);
        return Err("update: cannot open the disk image".into());
    }
    let result = replace_app(&mount.join("Island.app"), app);
    let _ = Command::new("hdiutil").args(["detach", "-quiet", "-force"]).arg(&mount).status();
    let _ = std::fs::remove_dir(&mount);
    result
}

/// Copies `src` (the Island.app in the open disk image) next to `app`, then swaps the two.
#[cfg(target_os = "macos")]
fn replace_app(src: &Path, app: &Path) -> Result<(), String> {
    let parent = app.parent().ok_or("update: the app has no folder")?;
    if !src.join("Contents").join("MacOS").is_dir() {
        return Err("update: the disk image has no Island.app".into());
    }
    // Copied next to the installed app first (same disk), so the swap is two renames.
    let staged = parent.join(NEW_APP);
    let _ = std::fs::remove_dir_all(&staged);
    let copied = std::process::Command::new("ditto").arg(src).arg(&staged).status().map_err(|e| format!("update: cannot copy the new Island: {e}"))?;
    if !copied.success() {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("update: cannot copy the new Island into {}", parent.display()));
    }
    let old = parent.join(OLD_APP);
    let _ = std::fs::remove_dir_all(&old);
    if let Err(e) = std::fs::rename(app, &old) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("update: cannot move the installed Island aside: {e}"));
    }
    if let Err(e) = std::fs::rename(&staged, app) {
        let _ = std::fs::rename(&old, app);
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("update: cannot put the new Island in place: {e}"));
    }
    Ok(())
}

/// Tells the user once per release why the Mac didn't update (the log has the details).
#[cfg(target_os = "macos")]
fn notice_once(app: &AppHandle, tag: &str, title: &str, text: &str) {
    static TOLD: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let mut told = TOLD.lock().unwrap();
    if told.as_deref() == Some(tag) {
        return;
    }
    *told = Some(tag.to_string());
    let _ = app.emit_to(
        crate::overlay::LABEL,
        "external-activity",
        serde_json::json!({ "island": "activity", "id": "island-update", "title": title, "text": text, "icon": "alert", "tone": "warn", "ms": 12000 }),
    );
}

// ------------------------------------------------------------------ both

/// The background checker. Development builds never update themselves.
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) || !cfg!(any(windows, target_os = "macos")) {
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
    #[cfg(target_os = "macos")]
    {
        let until = std::time::Instant::now() + Duration::from_secs(15);
        // kill(pid, 0) sends nothing: it only says whether the process is still there.
        while unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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

/// What an update leaves goes: a download a crash cut short, and the exe (or app) it
/// replaced (Moss wants one Island). Right after an update the old process may still be
/// letting go of its files, so the delete keeps trying for 20 s; a copy that is still
/// running is never touched, and the next start tries again.
pub fn tidy() {
    let Ok(exe) = std::env::current_exe() else { return };
    #[cfg(target_os = "macos")]
    {
        let _ = std::fs::remove_file(std::env::temp_dir().join("Island-update.dmg"));
        if let Ok(app) = bundle_of(&exe) {
            std::thread::spawn(move || tidy_app(&app));
        }
    }
    let Some(dir) = exe.parent().map(PathBuf::from) else { return };
    let _ = std::fs::remove_file(dir.join("Island.update.tmp"));
    let name = exe.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    if !dir.join(OLD).exists() || name.eq_ignore_ascii_case(OLD) {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..40 {
            if remove_old(&dir, &name) {
                crate::log::line(format!("update: removed {OLD}"));
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

/// The Island.old.app (and a half-copied Island.app.new) beside the installed app go, unless
/// the running Island is one of them.
#[cfg(target_os = "macos")]
fn tidy_app(app: &Path) {
    let Some(parent) = app.parent() else { return };
    if app.file_name().and_then(|n| n.to_str()) != Some("Island.app") {
        return;
    }
    let _ = std::fs::remove_dir_all(parent.join(NEW_APP));
    let old = parent.join(OLD_APP);
    for _ in 0..40 {
        if !old.exists() {
            return;
        }
        if std::fs::remove_dir_all(&old).is_ok() {
            crate::log::line(format!("update: removed {OLD_APP}"));
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Deletes `dir`'s Island.old.exe unless that is the running exe (`exe_name`). True once it is gone.
fn remove_old(dir: &Path, exe_name: &str) -> bool {
    if exe_name.eq_ignore_ascii_case(OLD) {
        return false;
    }
    std::fs::remove_file(dir.join(OLD)).is_ok()
}

#[tauri::command]
pub fn update_set(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, draft: bool, with_file: bool) -> Release {
        let assets = if with_file { vec![Asset { name: ASSET.into(), size: 1, browser_download_url: String::new() }] } else { vec![] };
        Release { tag_name: tag.into(), draft, prerelease: false, body: None, assets }
    }

    /// The line sign-release.mjs would paste into the notes for `file`, with a key like the real one.
    fn signature_line(key: &iroh::SecretKey, version: &str, file: &[u8]) -> String {
        use base64::Engine;
        let sig = key.sign(&signed_message(version, file));
        format!("<!-- island-signature: {} -->", base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()))
    }

    #[test]
    fn only_a_file_signed_for_its_version_passes() {
        let key = iroh::SecretKey::generate();
        let public = data_encoding::HEXLOWER.encode(key.public().as_bytes());
        let exe = b"MZ the new island";
        let dmg = b"the new island for a Mac";
        // One line per file, as the release notes carry them.
        let notes = format!("What's new.\n\n{}\n{}\n", signature_line(&key, "0.3.0", exe), signature_line(&key, "0.3.0", dmg));
        let sigs = signatures_in(&notes);
        assert_eq!(sigs.len(), 2);
        let ok = |file: &[u8], version: &str, key: &str| sigs.iter().any(|s| signed_by(key, version, file, s));
        assert!(ok(exe, "0.3.0", &public));
        assert!(ok(dmg, "0.3.0", &public));
        assert!(!ok(b"MZ something else", "0.3.0", &public), "another file");
        assert!(!ok(exe, "9.9.9", &public), "an old file relabelled as a newer version");
        let stranger = data_encoding::HEXLOWER.encode(iroh::SecretKey::generate().public().as_bytes());
        assert!(!ok(exe, "0.3.0", &stranger), "signed by someone else's key");
        assert!(signatures_in("Notes without a signature").is_empty());
        assert!(signatures_in("<!-- island-signature: not base64 -->").is_empty());
        assert!(!ok(exe, "0.3.0", "nope"));
    }

    #[test]
    fn the_message_matches_sign_release_mjs() {
        // scripts/sign-release.mjs signs "island-update", the version and the file's SHA-256, a line each.
        let m = String::from_utf8(signed_message("0.3.0", b"abc")).unwrap();
        assert_eq!(m, "island-update\n0.3.0\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn a_download_must_look_whole() {
        let mut dmg = vec![0u8; 2048];
        dmg[1536..1540].copy_from_slice(b"koly");
        assert!(is_dmg(&dmg));
        assert!(!is_dmg(b"koly"));
        assert!(!is_dmg(&[0u8; 2048]));
        assert_eq!(looks_whole(b"MZ an exe"), !cfg!(target_os = "macos"));
        assert_eq!(looks_whole(&dmg), cfg!(target_os = "macos"));
    }

    #[test]
    fn pre_releases_are_skipped() {
        let mut pre = rel("v0.5.0", false, true);
        pre.prerelease = true;
        let list = vec![rel("v0.2.0", false, true), pre];
        assert_eq!(newest(&list, (0, 1, 0)).map(|(r, _)| r.tag_name.as_str()), Some("v0.2.0"));
    }

    #[test]
    fn versions_parse() {
        assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("1.10"), Some((1, 10, 0)));
        assert_eq!(parse_version("v0.3.1-beta.2"), Some((0, 3, 1)));
        assert_eq!(parse_version("nightly"), None);
    }

    #[test]
    fn picks_the_newest_release_with_this_platforms_file() {
        let list = vec![rel("v0.1.0", false, true), rel("v0.4.0", true, true), rel("v0.3.0", false, false), rel("v0.2.0", false, true)];
        assert_eq!(newest(&list, (0, 1, 0)).map(|(r, _)| r.tag_name.as_str()), Some("v0.2.0"));
        assert!(newest(&list, (0, 2, 0)).is_none());
        // A release with only the other platform's file is not this platform's update.
        let other = if ASSET == "Island.exe" { "Island.dmg" } else { "Island.exe" };
        let mut only_other = rel("v0.9.0", false, false);
        only_other.assets.push(Asset { name: other.into(), size: 1, browser_download_url: String::new() });
        assert!(newest(&[only_other], (0, 1, 0)).is_none());
    }

    #[test]
    fn the_replaced_exe_goes_but_never_the_running_one() {
        let dir = std::env::temp_dir().join(format!("island-tidy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(OLD), b"MZ").unwrap();
        assert!(!remove_old(&dir, "island.old.exe"), "the running exe is never deleted");
        assert!(dir.join(OLD).exists());
        assert!(remove_old(&dir, "Island.exe"));
        assert!(!dir.join(OLD).exists());
        assert!(!remove_old(&dir, "Island.exe"), "nothing left to delete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    fn fake_app(dir: &Path, marker: &str) {
        std::fs::create_dir_all(dir.join("Contents").join("MacOS")).unwrap();
        std::fs::write(dir.join("Contents").join("MacOS").join("island"), format!("#!/bin/sh\necho {marker}\n")).unwrap();
        std::fs::write(dir.join("Contents").join("marker.txt"), marker).unwrap();
    }

    /// The whole Mac install, for real: a disk image made with hdiutil holds a new Island.app;
    /// installing puts it where the old one was, keeps the old one aside, and tidy removes that.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_disk_image_replaces_the_installed_app() {
        let root = std::env::temp_dir().join(format!("island-mac-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let apps = root.join("Applications");
        let installed = apps.join("Island.app");
        fake_app(&installed, "old");
        let src = root.join("image");
        fake_app(&src.join("Island.app"), "new");
        let dmg = root.join("Island.dmg");
        // hdiutil create now and then fails with "Resource busy" on a busy Mac; a retry gets through.
        let made = (0..4).any(|_| {
            let ok = std::process::Command::new("hdiutil").args(["create", "-quiet", "-ov", "-fs", "HFS+", "-format", "UDZO", "-volname", "Island", "-srcfolder"]).arg(&src).arg(&dmg).status().is_ok_and(|s| s.success());
            if !ok {
                std::thread::sleep(Duration::from_secs(2));
            }
            ok
        });
        assert!(made, "hdiutil create");
        assert!(is_dmg(&std::fs::read(&dmg).unwrap()));

        install_dmg(&dmg, &installed).unwrap();
        assert_eq!(std::fs::read_to_string(installed.join("Contents").join("marker.txt")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(apps.join(OLD_APP).join("Contents").join("marker.txt")).unwrap(), "old");
        assert!(!apps.join(NEW_APP).exists());

        tidy_app(&installed);
        assert!(!apps.join(OLD_APP).exists(), "the replaced app goes");
        assert!(installed.exists());

        // An app run from the disk image or from Downloads is not replaced.
        assert!(bundle_of(Path::new("/Volumes/Island/Island.app/Contents/MacOS/island")).is_err());
        assert!(bundle_of(Path::new("/private/var/folders/x/AppTranslocation/1/d/Island.app/Contents/MacOS/island")).is_err());
        assert_eq!(bundle_of(Path::new("/Applications/Island.app/Contents/MacOS/island")).unwrap(), PathBuf::from("/Applications/Island.app"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
