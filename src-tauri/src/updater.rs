// Self-update from the GitHub releases. A release is one Island.exe, so updating
// is: download the newer exe beside the running one, rename the running exe to
// Island.old.exe (Windows allows that, not overwriting it), move the new one into
// its place, start it and quit. The new process waits for the old one to be gone
// before the single-instance check, or that check would send it straight back,
// then deletes Island.old.exe: one exe is left, under its own name.
//
// Only a signed release is installed. Its notes carry `<!-- island-signature: <base64> -->`:
// an Ed25519 signature, by the key whose public half is UPDATE_KEY, over the version and the
// SHA-256 of the exe (scripts/sign-release.mjs makes it). Someone who gets into the GitHub
// account or swaps the asset still can't make Islands run their exe. Pre-releases are skipped:
// they are for people who download them on purpose.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use sha2::Digest;
use tauri::{AppHandle, Emitter};

const REPO: &str = "cutsandedges21/windows-dynamic-island";
const ASSET: &str = "Island.exe";
/// Where the running exe goes while its replacement moves in.
const OLD: &str = "Island.old.exe";
/// After start, so the check never competes with the island coming up.
const FIRST_CHECK: Duration = Duration::from_secs(90);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Flag passed to the new exe: `--after-update <old pid> <old version>`.
const AFTER_UPDATE: &str = "--after-update";

/// The public half of the release signing key (its private half never leaves Moss's PC).
const UPDATE_KEY: &str = "5da0eca13f185218ba00e673a955772d6e92e5285bbbfb52221e1932d05b6115";
/// Where the signature sits in a release's notes (an HTML comment, invisible on GitHub).
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
    /// The release notes, where the signature is.
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

/// The newest full release that ships an Island.exe and is newer than `current`.
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
    let version = release.tag_name.trim().trim_start_matches(['v', 'V']);
    let signature = signature_in(release.body.as_deref().unwrap_or("")).ok_or_else(|| format!("update: {} is not signed, so it was not installed", release.tag_name))?;
    if !signed_by(UPDATE_KEY, version, &bytes, &signature) {
        return Err(format!("update: {}'s signature does not match its exe, so it was not installed", release.tag_name));
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

/// The bytes a release signs: the version it installs and the exe's SHA-256, together, so an
/// old signed exe can't come back labelled as a newer version.
fn signed_message(version: &str, exe: &[u8]) -> Vec<u8> {
    let digest: String = sha2::Sha256::digest(exe).iter().map(|b| format!("{b:02x}")).collect();
    format!("island-update\n{version}\n{digest}").into_bytes()
}

/// The signature in a release's notes, if there is one.
fn signature_in(body: &str) -> Option<[u8; 64]> {
    use base64::Engine;
    let start = body.find(SIGNATURE_TAG)? + SIGNATURE_TAG.len();
    let rest = &body[start..];
    let text = rest[..rest.find("-->")?].trim();
    let bytes = base64::engine::general_purpose::STANDARD.decode(text).ok()?;
    <[u8; 64]>::try_from(bytes.as_slice()).ok()
}

/// Whether `signature` is `key_hex`'s over this version and exe.
fn signed_by(key_hex: &str, version: &str, exe: &[u8], signature: &[u8; 64]) -> bool {
    let Some(key) = data_encoding::HEXLOWER_PERMISSIVE.decode(key_hex.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok()) else { return false };
    let Ok(key) = iroh::PublicKey::from_bytes(&key) else { return false };
    key.verify(&signed_message(version, exe), &iroh::Signature::from_bytes(signature)).is_ok()
}

/// Running exe → Island.old.exe (the new process deletes it, see tidy), the
/// download → the running exe's own name.
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

/// What an update leaves goes: a download a crash cut short, and the exe it
/// replaced (Moss wants one exe). Right after an update the old process may still
/// be letting go of its file, so the delete keeps trying for 20 s; a copy that is
/// still running is never touched (Windows refuses), and the next start tries again.
pub fn tidy() {
    let Ok(exe) = std::env::current_exe() else { return };
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

    fn rel(tag: &str, draft: bool, with_exe: bool) -> Release {
        let assets = if with_exe { vec![Asset { name: "Island.exe".into(), size: 1, browser_download_url: String::new() }] } else { vec![] };
        Release { tag_name: tag.into(), draft, prerelease: false, body: None, assets }
    }

    /// A key like the real one, and the line sign-release.mjs would paste into the notes.
    fn signed_notes(key: &iroh::SecretKey, version: &str, exe: &[u8]) -> String {
        use base64::Engine;
        let sig = key.sign(&signed_message(version, exe));
        format!("What's new.\n\n<!-- island-signature: {} -->\n", base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()))
    }

    #[test]
    fn only_an_exe_signed_for_its_version_passes() {
        let key = iroh::SecretKey::generate();
        let public = data_encoding::HEXLOWER.encode(key.public().as_bytes());
        let exe = b"MZ the new island";
        let notes = signed_notes(&key, "0.3.0", exe);
        let sig = signature_in(&notes).expect("the signature is found in the notes");
        assert!(signed_by(&public, "0.3.0", exe, &sig));
        assert!(!signed_by(&public, "0.3.0", b"MZ something else", &sig), "another exe");
        assert!(!signed_by(&public, "9.9.9", exe, &sig), "an old exe relabelled as a newer version");
        let stranger = data_encoding::HEXLOWER.encode(iroh::SecretKey::generate().public().as_bytes());
        assert!(!signed_by(&stranger, "0.3.0", exe, &sig), "signed by someone else's key");
        assert!(signature_in("Notes without a signature").is_none());
        assert!(signature_in("<!-- island-signature: not base64 -->").is_none());
        assert!(!signed_by("nope", "0.3.0", exe, &sig));
    }

    #[test]
    fn the_message_matches_sign_release_mjs() {
        // scripts/sign-release.mjs signs "island-update", the version and the exe's SHA-256, a line each.
        let m = String::from_utf8(signed_message("0.3.0", b"abc")).unwrap();
        assert_eq!(m, "island-update\n0.3.0\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
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
    fn picks_the_newest_release_with_an_exe() {
        let list = vec![rel("v0.1.0", false, true), rel("v0.4.0", true, true), rel("v0.3.0", false, false), rel("v0.2.0", false, true)];
        assert_eq!(newest(&list, (0, 1, 0)).map(|(r, _)| r.tag_name.as_str()), Some("v0.2.0"));
        assert!(newest(&list, (0, 2, 0)).is_none());
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
}
