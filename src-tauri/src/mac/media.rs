// Now playing on a Mac, in the shape media.rs gives on Windows. The Mac's own now-playing center
// (MediaRemote, what the menu bar's Now Playing shows) knows every player: Spotify, Music, a video
// in a browser. From macOS 15.4 on it only answers Apple's own programs, so when it says nothing,
// Spotify and Music are asked directly (AppleScript; macOS asks once whether Island may).

use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use block2::RcBlock;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::mac::cf::{self, CFTypeRef};
use crate::overlay::LABEL as ISLAND;

#[derive(Serialize, Clone, PartialEq, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    available: bool,
    app: Option<String>,
    app_id: Option<String>,
    title: String,
    artist: String,
    album: String,
    status: String,
    position: Option<f64>,
    duration: Option<f64>,
    updated_at: f64,
    can_play: bool,
    can_pause: bool,
    can_next: bool,
    can_prev: bool,
    thumbnail: Option<String>,
}

const MAX_THUMB: usize = 1_500_000;

// ------------------------------------------------------------------ MediaRemote

type InfoFn = unsafe extern "C" fn(*mut c_void, &block2::Block<dyn Fn(CFTypeRef)>);
type PidFn = unsafe extern "C" fn(*mut c_void, &block2::Block<dyn Fn(i32)>);
type CommandFn = unsafe extern "C" fn(u32, CFTypeRef) -> bool;
type SeekFn = unsafe extern "C" fn(f64);

struct Remote {
    info: InfoFn,
    pid: PidFn,
    command: CommandFn,
    seek: SeekFn,
}

unsafe impl Send for Remote {}
unsafe impl Sync for Remote {}

fn remote() -> Option<&'static Remote> {
    static R: OnceLock<Option<Remote>> = OnceLock::new();
    R.get_or_init(|| unsafe {
        let lib = libc::dlopen(c"/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote".as_ptr(), libc::RTLD_LAZY);
        if lib.is_null() {
            return None;
        }
        let sym = |name: &std::ffi::CStr| libc::dlsym(lib, name.as_ptr());
        let (i, p, c, s) = (
            sym(c"MRMediaRemoteGetNowPlayingInfo"),
            sym(c"MRMediaRemoteGetNowPlayingApplicationPID"),
            sym(c"MRMediaRemoteSendCommand"),
            sym(c"MRMediaRemoteSetElapsedTime"),
        );
        if i.is_null() || p.is_null() || c.is_null() || s.is_null() {
            return None;
        }
        Some(Remote { info: std::mem::transmute(i), pid: std::mem::transmute(p), command: std::mem::transmute(c), seek: std::mem::transmute(s) })
    })
    .as_ref()
}

extern "C" {
    fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataGetLength(data: CFTypeRef) -> isize;
    fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
    fn CFDateGetAbsoluteTime(date: CFTypeRef) -> f64;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFDataGetTypeID() -> usize;
    fn CFDateGetTypeID() -> usize;
}

/// Seconds from 1970 to 2001, when Core Foundation's clock starts.
const CF_EPOCH: f64 = 978_307_200.0;

/// What the now-playing center holds, copied out while it is valid.
#[derive(Default, Debug, Clone)]
struct Info {
    title: String,
    artist: String,
    album: String,
    duration: Option<f64>,
    elapsed: Option<f64>,
    rate: Option<f64>,
    timestamp_ms: Option<f64>,
    art: Option<(String, Vec<u8>)>,
}

fn read_info(dict: CFTypeRef) -> Info {
    let key = |k: &str| {
        let s = cf::cfstr(k);
        cf::get(dict, s.0)
    };
    let text = |k: &str| cf::string(key(k)).unwrap_or_default();
    let mut info = Info {
        title: text("kMRMediaRemoteNowPlayingInfoTitle"),
        artist: text("kMRMediaRemoteNowPlayingInfoArtist"),
        album: text("kMRMediaRemoteNowPlayingInfoAlbum"),
        duration: cf::float(key("kMRMediaRemoteNowPlayingInfoDuration")).filter(|d| *d > 0.0),
        elapsed: cf::float(key("kMRMediaRemoteNowPlayingInfoElapsedTime")),
        rate: cf::float(key("kMRMediaRemoteNowPlayingInfoPlaybackRate")),
        ..Default::default()
    };
    unsafe {
        let ts = key("kMRMediaRemoteNowPlayingInfoTimestamp");
        if !ts.is_null() && CFGetTypeID(ts) == CFDateGetTypeID() {
            info.timestamp_ms = Some((CFDateGetAbsoluteTime(ts) + CF_EPOCH) * 1000.0);
        }
        let data = key("kMRMediaRemoteNowPlayingInfoArtworkData");
        if !data.is_null() && CFGetTypeID(data) == CFDataGetTypeID() {
            let len = CFDataGetLength(data).max(0) as usize;
            if len > 0 && len <= MAX_THUMB {
                let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), len).to_vec();
                let mime = cf::string(key("kMRMediaRemoteNowPlayingInfoArtworkMIMEType")).filter(|m| m.starts_with("image/")).unwrap_or_else(|| sniff(&bytes).into());
                info.art = Some((mime, bytes));
            }
        }
    }
    info
}

fn sniff(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// Asks the now-playing center (it answers on a queue of its own) and waits a moment.
fn now_playing() -> Option<(Info, i32)> {
    let r = remote()?;
    unsafe {
        let queue = dispatch_get_global_queue(0, 0);
        let (tx, rx) = mpsc::channel::<Info>();
        let block = RcBlock::new(move |dict: CFTypeRef| {
            let _ = tx.send(if dict.is_null() { Info::default() } else { read_info(dict) });
        });
        (r.info)(queue, &block);
        let info = rx.recv_timeout(Duration::from_millis(800)).ok()?;
        let (ptx, prx) = mpsc::channel::<i32>();
        let pblock = RcBlock::new(move |pid: i32| {
            let _ = ptx.send(pid);
        });
        (r.pid)(queue, &pblock);
        let pid = prx.recv_timeout(Duration::from_millis(500)).unwrap_or(0);
        Some((info, pid))
    }
}

/// The app behind a process: its name and bundle id ("Spotify", "com.spotify.client").
fn app_of(pid: i32) -> (Option<String>, Option<String>) {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    if pid <= 0 {
        return (None, None);
    }
    autoreleasepool(|_| unsafe {
        let app: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return (None, None);
        }
        let name: *mut AnyObject = msg_send![app, localizedName];
        let id: *mut AnyObject = msg_send![app, bundleIdentifier];
        (crate::msgwin::rust_string(name), crate::msgwin::rust_string(id))
    })
}

// ------------------------------------------------------------------ Spotify and Music, asked directly

const PLAYERS: &[(&str, &str, &str)] = &[("Spotify", "spotify.app", "com.spotify.client"), ("Music", "music.app", "com.apple.Music")];

const ASK_PLAYER: &str = r#"on run argv
set p to item 1 of argv
if application p is not running then return ""
tell application p
  set s to player state as string
  if s is "stopped" then return "stopped"
  set t to current track
  set d to duration of t
  if p is "Spotify" then set d to d / 1000
  return s & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & d & linefeed & (player position)
end tell
end run"#;

/// A player's state from its own answer: "playing\ntitle\nartist\nalbum\nduration\nposition".
fn parse_player(out: &str) -> Option<(String, Info)> {
    let mut l = out.lines();
    let status = l.next()?.trim().to_string();
    if status != "playing" && status != "paused" {
        return None;
    }
    let num = |s: Option<&str>| s.and_then(|v| v.trim().replace(',', ".").parse::<f64>().ok());
    let (title, artist, album) = (l.next()?.to_string(), l.next().unwrap_or_default().to_string(), l.next().unwrap_or_default().to_string());
    let duration = num(l.next()).filter(|d| *d > 0.0);
    let elapsed = num(l.next());
    Some((status, Info { title, artist, album, duration, elapsed, ..Default::default() }))
}

fn players_running() -> Vec<&'static (&'static str, &'static str, &'static str)> {
    let rows = crate::procs::snapshot();
    PLAYERS.iter().filter(|(_, proc_name, _)| rows.iter().any(|r| r.2 == *proc_name)).collect()
}

fn ask_players() -> Option<MediaState> {
    let mut best: Option<MediaState> = None;
    for (name, _, id) in players_running() {
        let Some(out) = crate::mac::osa::run(ASK_PLAYER, &[name], Duration::from_secs(3)) else { continue };
        let Some((status, info)) = parse_player(&out) else { continue };
        let state = state_from(&info, &status, Some(name.to_string()), Some(id.to_string()), now_ms());
        if status == "playing" || best.is_none() {
            best = Some(state);
        }
        if status == "playing" {
            break;
        }
    }
    best
}

/// Which player answered last when MediaRemote didn't: the controls go to it.
static DIRECT: Mutex<Option<&'static str>> = Mutex::new(None);

// ------------------------------------------------------------------ the state

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn state_from(info: &Info, status: &str, app: Option<String>, app_id: Option<String>, updated_at: f64) -> MediaState {
    let thumbnail = info.art.as_ref().map(|(mime, bytes)| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    MediaState {
        available: !info.title.is_empty(),
        app,
        app_id,
        title: info.title.clone(),
        artist: info.artist.clone(),
        album: info.album.clone(),
        status: status.into(),
        position: info.duration.map(|_| info.elapsed.unwrap_or(0.0).max(0.0)),
        duration: info.duration,
        updated_at,
        can_play: true,
        can_pause: true,
        can_next: true,
        can_prev: true,
        thumbnail,
    }
}

/// The artwork is the same picture until the song changes: kept, so it isn't sent anew each read.
struct ArtCache {
    key: String,
    art: Option<(String, Vec<u8>)>,
}

pub fn read() -> MediaState {
    static ART: Mutex<Option<ArtCache>> = Mutex::new(None);
    if let Some((mut info, pid)) = now_playing().filter(|(i, _)| !i.title.is_empty()) {
        *DIRECT.lock().unwrap() = None;
        let (app, app_id) = app_of(pid);
        let key = format!("{}|{}|{}|{}", app_id.as_deref().unwrap_or(""), info.title, info.artist, info.album);
        {
            let mut cache = ART.lock().unwrap();
            match cache.as_mut() {
                Some(c) if c.key == key && info.art.is_none() => info.art = c.art.clone(),
                _ => *cache = Some(ArtCache { key, art: info.art.clone() }),
            }
        }
        let playing = info.rate.unwrap_or(0.0) > 0.0;
        let updated = info.timestamp_ms.unwrap_or_else(now_ms);
        return state_from(&info, if playing { "playing" } else { "paused" }, app, app_id, updated);
    }
    if let Some(state) = ask_players() {
        *DIRECT.lock().unwrap() = PLAYERS.iter().find(|p| Some(p.2) == state.app_id.as_deref()).map(|p| p.0);
        return state;
    }
    MediaState { status: "none".into(), ..Default::default() }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = MediaState::default();
        loop {
            let state = read();
            if state != last {
                let _ = app.emit_to(ISLAND, "media", state.clone());
                last = state;
            }
            std::thread::sleep(Duration::from_millis(700));
        }
    });
}

#[tauri::command]
pub async fn media_state() -> Option<MediaState> {
    tauri::async_runtime::spawn_blocking(read).await.ok().filter(|s| s.available)
}

const PLAYER_DO: &str = r#"on run argv
set p to item 1 of argv
set what to item 2 of argv
tell application p
  if what is "toggle" then playpause
  if what is "play" then play
  if what is "pause" then pause
  if what is "next" then next track
  if what is "prev" then previous track
  if what is "seek" then set player position to ((item 3 of argv) as real)
end tell
return "ok"
end run"#;

/// MediaRemote's commands: play 0, pause 1, toggle 2, next 4, previous 5.
fn command_code(action: &str) -> Option<u32> {
    match action {
        "play" => Some(0),
        "pause" => Some(1),
        "toggle" => Some(2),
        "next" => Some(4),
        "prev" => Some(5),
        _ => None,
    }
}

#[tauri::command]
pub async fn media_control(action: String, value: Option<f64>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        if action == "focus" {
            // Bring the player forward.
            let pid = now_playing().map(|(_, p)| p).unwrap_or(0);
            if pid > 0 {
                return crate::mac::cf::activate_pid(pid as u32);
            }
            let direct = *DIRECT.lock().unwrap();
            return direct.is_some_and(|p| std::process::Command::new("/usr/bin/open").args(["-a", p]).status().is_ok_and(|s| s.success()));
        }
        if let Some(player) = *DIRECT.lock().unwrap() {
            let v = format!("{}", value.unwrap_or(0.0));
            return crate::mac::osa::run(PLAYER_DO, &[player, &action, &v], Duration::from_secs(3)).is_some();
        }
        let Some(r) = remote() else { return false };
        if action == "seek" {
            unsafe { (r.seek)(value.unwrap_or(0.0).max(0.0)) };
            return true;
        }
        command_code(&action).is_some_and(|c| unsafe { (r.command)(c, std::ptr::null()) })
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_player_s_answer_reads_as_a_song() {
        let (status, info) = parse_player("playing\nSo What\nMiles Davis\nKind of Blue\n562.5\n12.25").unwrap();
        assert_eq!(status, "playing");
        assert_eq!((info.title.as_str(), info.artist.as_str(), info.album.as_str()), ("So What", "Miles Davis", "Kind of Blue"));
        assert_eq!((info.duration, info.elapsed), (Some(562.5), Some(12.25)));
        // A French Mac writes decimals with a comma.
        assert_eq!(parse_player("paused\nA\nB\nC\n200,5\n1,5").unwrap().1.duration, Some(200.5));
        assert!(parse_player("stopped").is_none());
        assert!(parse_player("").is_none());
    }

    #[test]
    fn commands_map_to_media_remote() {
        assert_eq!(command_code("toggle"), Some(2));
        assert_eq!(command_code("next"), Some(4));
        assert_eq!(command_code("rm"), None);
    }

    #[test]
    fn reading_now_playing_never_hangs() {
        let started = std::time::Instant::now();
        let st = read();
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(st.available || st.status == "none");
    }
}
