// Now playing, through Windows' Global System Media Transport Controls: the same
// source the volume flyout uses, so Spotify, browsers, Apple Music and local
// players all work without per-app integrations.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{HSTRING, PCWSTR};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationSelectionItemPattern, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
};
use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NONE};

use crate::overlay::LABEL as ISLAND;
use crate::procs::WindowRow;

/// The app playing media now (its friendly name), for the taskbar: a full-screen browser counts as a
/// video only while it plays something.
static PLAYING: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn playing_app() -> Option<String> {
    PLAYING.lock().unwrap().clone()
}

const FILETIME_UNIX_OFFSET_MS: i64 = 11_644_473_600_000;
const MAX_THUMB: u32 = 1_500_000;

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

fn friendly_app(aumid: &str) -> String {
    let lower = aumid.to_lowercase();
    let known = [
        ("spotify", "Spotify"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("zunemusic", "Media Player"),
        ("applemusic", "Apple Music"),
        ("vlc", "VLC"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("arc", "Arc"),
        ("youtube", "YouTube"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
    ];
    for (needle, name) in known {
        if lower.contains(needle) {
            return name.to_string();
        }
    }
    let base = aumid.split('!').next().unwrap_or(aumid);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.trim_end_matches(".exe");
    base.rsplit('.').next().unwrap_or(base).to_string()
}

struct ThumbCache {
    key: String,
    data: Option<String>,
}

fn ticks_to_secs(t: i64) -> f64 {
    t as f64 / 10_000_000.0
}

fn read(manager: &Manager, cache: &mut ThumbCache) -> windows::core::Result<MediaState> {
    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return Ok(MediaState { status: "none".into(), ..Default::default() }),
    };
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let playback = session.GetPlaybackInfo()?;
    let controls = playback.Controls()?;
    let timeline = session.GetTimelineProperties()?;
    let aumid = session.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
    let status = match playback.PlaybackStatus()? {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        Status::Closed => "closed",
        _ => "paused",
    };
    let start = timeline.StartTime().map(|t| t.Duration).unwrap_or(0);
    let end = timeline.EndTime().map(|t| t.Duration).unwrap_or(0);
    let pos = timeline.Position().map(|t| t.Duration).unwrap_or(0);
    let updated = timeline.LastUpdatedTime().map(|t| t.UniversalTime).unwrap_or(0);
    let duration = (end > start).then(|| ticks_to_secs(end - start));
    let position = duration.map(|_| ticks_to_secs(pos - start).max(0.0));
    let updated_at = if updated > 0 { (updated / 10_000 - FILETIME_UNIX_OFFSET_MS) as f64 } else { 0.0 };

    let key = format!("{aumid}|{title}|{artist}|{album}");
    if key != cache.key {
        cache.key = key;
        cache.data = props.Thumbnail().ok().and_then(|r| thumbnail(&r).ok()).flatten();
    }
    Ok(MediaState {
        available: !title.is_empty(),
        app: (!aumid.is_empty()).then(|| friendly_app(&aumid)),
        app_id: (!aumid.is_empty()).then_some(aumid),
        title,
        artist,
        album,
        status: status.into(),
        position,
        duration,
        updated_at,
        can_play: controls.IsPlayEnabled().unwrap_or(false),
        can_pause: controls.IsPauseEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
        can_prev: controls.IsPreviousEnabled().unwrap_or(false),
        thumbnail: cache.data.clone(),
    })
}

fn thumbnail(r: &windows::Storage::Streams::IRandomAccessStreamReference) -> windows::core::Result<Option<String>> {
    let stream = r.OpenReadAsync()?.get()?;
    let size = stream.Size()?;
    if size == 0 || size > MAX_THUMB as u64 {
        return Ok(None);
    }
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size as u32)?.get()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    let ct = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let ct = if ct.starts_with("image/") { ct } else { "image/jpeg".into() };
    Ok(Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf))))
}

fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Watches the current media session and emits `media` when anything changes.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        com();
        let manager = loop {
            match Manager::RequestAsync().and_then(|op| op.get()) {
                Ok(m) => break m,
                Err(err) => {
                    crate::log::line(format!("media controls unavailable: {err}"));
                    std::thread::sleep(Duration::from_secs(30));
                }
            }
        };
        let mut cache = ThumbCache { key: String::new(), data: None };
        let mut last = MediaState::default();
        loop {
            let state = read(&manager, &mut cache).unwrap_or_else(|_| MediaState { status: "none".into(), ..Default::default() });
            *PLAYING.lock().unwrap() = if state.status == "playing" { state.app.clone() } else { None };
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
    tauri::async_runtime::spawn_blocking(|| {
        com();
        let manager = Manager::RequestAsync().ok()?.get().ok()?;
        let mut cache = ThumbCache { key: String::new(), data: None };
        read(&manager, &mut cache).ok()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn media_control(action: String, value: Option<f64>) -> bool {
    tauri::async_runtime::spawn_blocking(move || -> windows::core::Result<bool> {
        com();
        let manager = Manager::RequestAsync()?.get()?;
        let s = manager.GetCurrentSession()?;
        let ok = match action.as_str() {
            "toggle" => s.TryTogglePlayPauseAsync()?.get()?,
            "play" => s.TryPlayAsync()?.get()?,
            "pause" => s.TryPauseAsync()?.get()?,
            "next" => s.TrySkipNextAsync()?.get()?,
            "prev" => s.TrySkipPreviousAsync()?.get()?,
            "seek" => s.TryChangePlaybackPositionAsync((value.unwrap_or(0.0) * 10_000_000.0) as i64)?.get()?,
            // Clicked again while what it brought forward is still in front: put things back instead.
            "focus" if undo_focus() => true,
            "focus" => {
                let props = s.TryGetMediaPropertiesAsync()?.get()?;
                let text = |h: windows::core::Result<HSTRING>| h.map(|h| h.to_string()).unwrap_or_default();
                let aumid = text(s.SourceAppUserModelId());
                let before = crate::procs::foreground();
                let mut back = Back { before, player: 0, minimized: false, tab: None };
                let ok = focus(&aumid, &text(props.Title()), &text(props.Artist()), &text(props.AlbumTitle()), &mut back);
                back.player = crate::procs::foreground();
                *BACK.lock().unwrap() = (ok && back.player != 0 && back.player != before).then_some(back);
                ok
            }
            _ => false,
        };
        Ok(ok)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or(false)
}

/// Browsers, whose media session is one of their tabs: (friendly_app name, process).
pub(crate) const BROWSERS: [(&str, &str); 6] =
    [("Chrome", "chrome.exe"), ("Edge", "msedge.exe"), ("Brave", "brave.exe"), ("Opera", "opera.exe"), ("Arc", "arc.exe"), ("Firefox", "firefox.exe")];

/// What bringing the song forward changed, for a second click to put back (Justin, 11-19: "make it back
/// to how it was before i clicked it"): the window that was in front, the one brought forward, whether
/// that one was minimized, and the browser tab it was showing before the song's.
struct Back {
    before: isize,
    player: isize,
    minimized: bool,
    tab: Option<String>,
}
static BACK: std::sync::Mutex<Option<Back>> = std::sync::Mutex::new(None);

/// The last `focus` undone, if what it brought forward is still in front: the tab it showed, minimized
/// again if it was, and the window that was in front back in front. False when there is nothing to undo.
fn undo_focus() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, ShowWindow, SW_MINIMIZE};
    let Some(b) = BACK.lock().unwrap().take() else { return false };
    if crate::procs::foreground() != b.player {
        return false;
    }
    if let Some(name) = &b.tab {
        reselect_tab(b.player, name);
    }
    if b.minimized {
        unsafe {
            let _ = ShowWindow(HWND(b.player as *mut _), SW_MINIMIZE);
        }
    }
    if b.before != 0 && unsafe { IsWindow(Some(HWND(b.before as *mut _))) }.as_bool() {
        crate::procs::activate(b.before);
    }
    true
}

/// Brings forward whatever is playing: the browser tab it's in, else the app's window
/// (found by its process, or for a Store app like Netflix, by activating it). Notes in `back` what
/// it changed.
fn focus(aumid: &str, title: &str, artist: &str, album: &str, back: &mut Back) -> bool {
    let bring = |hwnd: isize, back: &mut Back| {
        back.minimized = unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(HWND(hwnd as *mut _)) }.as_bool();
        crate::procs::activate(hwnd)
    };
    let app = friendly_app(aumid);
    let exes: HashMap<u32, String> = crate::procs::snapshot(false).into_iter().map(|r| (r.0, r.2.to_lowercase())).collect();
    let windows = crate::procs::windows();
    if let Some((_, exe)) = BROWSERS.iter().find(|(name, _)| *name == app) {
        let mine: Vec<&WindowRow> = windows.iter().filter(|w| exes.get(&w.pid).is_some_and(|e| e == exe)).collect();
        if let Some((hwnd, was)) = select_tab(&mine, title, artist, album) {
            back.tab = was;
            return bring(hwnd, back);
        }
        // No tab matched: the window showing it, else the frontmost one.
        let t = title.to_lowercase();
        let pick = mine.iter().find(|w| !t.is_empty() && w.title.to_lowercase().contains(&t)).or(mine.first());
        return pick.is_some_and(|w| bring(w.hwnd, back));
    }
    // "Spotify.exe", or Spotify from the Store (whose id only names its package).
    let exe = aumid.rsplit(['\\', '/']).next().unwrap_or(aumid).to_lowercase();
    let stem = app.to_lowercase();
    let own = windows.iter().find(|w| exes.get(&w.pid).is_some_and(|e| *e == exe || e.trim_end_matches(".exe") == stem));
    if let Some(w) = own {
        return bring(w.hwnd, back);
    }
    aumid.contains('!') && activate_package(aumid)
}

/// Switches to the browser tab that's playing and returns its window, with the name of the tab that
/// window was showing before (None: it was showing that one already). Tabs only show
/// their names to UI Automation, so the playing one is the one named after the title
/// (Chrome also adds "Audio playing" to it, which breaks ties and finds Netflix's
/// tabs, which are all just "Netflix").
fn select_tab(windows: &[&WindowRow], title: &str, artist: &str, album: &str) -> Option<(isize, Option<String>)> {
    unsafe {
        let a: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let is_tab = a.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)).ok()?;
        let mut best: Option<(u32, isize, IUIAutomationElement)> = None;
        for w in windows {
            let Ok(root) = a.ElementFromHandle(HWND(w.hwnd as *mut _)) else { continue };
            let Ok(tabs) = root.FindAll(TreeScope_Descendants, &is_tab) else { continue };
            for i in 0..tabs.Length().unwrap_or(0) {
                let Ok(tab) = tabs.GetElement(i) else { continue };
                let name = tab.CurrentName().map(|b| b.to_string()).unwrap_or_default();
                let score = tab_score(&name, title, artist, album);
                if score > 0 && best.as_ref().is_none_or(|b| score > b.0) {
                    best = Some((score, w.hwnd, tab));
                }
            }
        }
        let (_, hwnd, tab) = best?;
        let mut was = None;
        if let Ok(pick) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            if !pick.CurrentIsSelected().is_ok_and(|b| b.as_bool()) {
                was = shown_tab(&a, &is_tab, hwnd);
            }
            let _ = pick.Select();
        }
        Some((hwnd, was))
    }
}

/// The name of the tab a browser window is showing.
unsafe fn shown_tab(a: &IUIAutomation, is_tab: &IUIAutomationCondition, hwnd: isize) -> Option<String> {
    let tabs = a.ElementFromHandle(HWND(hwnd as *mut _)).ok()?.FindAll(TreeScope_Descendants, is_tab).ok()?;
    for i in 0..tabs.Length().unwrap_or(0) {
        let Ok(tab) = tabs.GetElement(i) else { continue };
        let Ok(p) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) else { continue };
        if p.CurrentIsSelected().is_ok_and(|b| b.as_bool()) {
            return tab.CurrentName().ok().map(|b| b.to_string());
        }
    }
    None
}

/// Shows the tab named `name` in a browser window again.
fn reselect_tab(hwnd: isize, name: &str) {
    unsafe {
        let Ok(a) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return };
        let Ok(is_tab) = a.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)) else { return };
        let Ok(tabs) = a.ElementFromHandle(HWND(hwnd as *mut _)).and_then(|r| r.FindAll(TreeScope_Descendants, &is_tab)) else { return };
        for i in 0..tabs.Length().unwrap_or(0) {
            let Ok(tab) = tabs.GetElement(i) else { continue };
            if tab.CurrentName().is_ok_and(|n| n.to_string() == name) {
                if let Ok(p) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                    let _ = p.Select();
                }
                return;
            }
        }
    }
}

fn tab_score(name: &str, title: &str, artist: &str, album: &str) -> u32 {
    let name = name.to_lowercase();
    let has = |s: &str| s.chars().count() > 2 && name.contains(&s.to_lowercase());
    let mut score = 0;
    if has(title) {
        score += 4;
    }
    if name.contains("audio playing") || name.contains("playing audio") {
        score += 2;
    }
    if score > 0 && (has(artist) || has(album)) {
        score += 1;
    }
    score
}

fn activate_package(aumid: &str) -> bool {
    crate::procs::allow_any_foreground();
    unsafe {
        let Ok(m) = CoCreateInstance::<_, IApplicationActivationManager>(&ApplicationActivationManager, None, CLSCTX_ALL) else {
            return false;
        };
        m.ActivateApplication(&HSTRING::from(aumid), PCWSTR::null(), AO_NONE).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{friendly_app, tab_score};

    #[test]
    fn the_playing_tab_scores_highest() {
        let crave = "Occupation Double Panamá | Saison 10 Épisode 42 | Crave - Memory usage - 141 MB";
        assert!(tab_score(crave, "Occupation Double Panamá", "", "Jeudi") >= 4);
        assert_eq!(tab_score("Fahrenheit 451 - Google Search", "Occupation Double Panamá", "", ""), 0);
        assert!(tab_score("Netflix - Audio playing", "Wednesday", "", "") > tab_score("Netflix", "Wednesday", "", ""));
    }

    #[test]
    fn app_ids_get_readable_names() {
        assert_eq!(friendly_app("Spotify.exe"), "Spotify");
        assert_eq!(friendly_app("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(friendly_app("MSEdge"), "Edge");
        assert_eq!(friendly_app("SomeVendor.CoolPlayer_abc!App"), "CoolPlayer");
    }
}
