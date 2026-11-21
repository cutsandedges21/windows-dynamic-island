// Now playing, through Windows' Global System Media Transport Controls: the same
// source the volume flyout uses, so Spotify, browsers, Apple Music and local
// players all work without per-app integrations.

use std::collections::HashMap;
use std::time::{Duration, Instant};

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
    /// Between songs (a skip): this is the last song, kept on show till the next one has loaded; its
    /// colour fades out meanwhile (Moss, 11-20).
    between: bool,
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

/// The song's cover, read once per song, then again for a few seconds: a player tells Windows the new
/// title before its new cover (Spotify), and the one read at the change was often the last song's, kept
/// for the whole song (Moss, 11-20: "showing the previous album cover randomly").
struct ThumbCache {
    key: String,
    data: Option<String>,
    /// The last song's cover, to tell a cover that has not changed yet from a new one.
    prev: Option<String>,
    /// When the song changed.
    since: Option<Instant>,
}

/// One cover for the watcher and the slow poll (`media_state`): with a cache each, one could hold the
/// last song's cover while the other had the new one, and the island flipped between them.
static THUMBS: std::sync::Mutex<ThumbCache> = std::sync::Mutex::new(ThumbCache { key: String::new(), data: None, prev: None, since: None });

/// After a song changes its cover is read again for this long, and for up to SETTLE_MAX while it is
/// missing or still the last song's (a song from the same album keeps its cover once that is over).
const SETTLE: Duration = Duration::from_secs(5);
const SETTLE_MAX: Duration = Duration::from_secs(15);

/// Skipping a song, the player says for a moment that nothing plays (no session, no title, Changing or
/// Stopped), and the island and taskbar dropped Now playing till the next song came (Moss, 11-20: "i
/// dont want it to show no song at all. have it show the previous song until the next song loads in").
/// A gap this short keeps the last song on show, marked `between` (its colour fades to the pill's own,
/// then the next song's fades in). The next song has loaded once its cover has come too: while the
/// player still gives the last song's cover (or none), the last song stays, up to COVER_WAIT.
const GAP: Duration = Duration::from_secs(4);
const COVER_WAIT: Duration = Duration::from_millis(2500);

/// The last song that played, and since when the player has said there is none.
struct Hold {
    good: Option<MediaState>,
    gone: Option<Instant>,
}
static HOLD: std::sync::Mutex<Hold> = std::sync::Mutex::new(Hold { good: None, gone: None });

impl Hold {
    /// What to tell the island: `s`, or the last song (marked `between`) while the player is between
    /// songs, up to GAP, or while the new song's cover (`stale`) has not come yet, up to COVER_WAIT.
    fn settle(&mut self, s: MediaState, stale: bool, now: Instant) -> MediaState {
        let gap = !s.available || matches!(s.status.as_str(), "none" | "closed" | "changing" | "stopped");
        if !gap && !stale {
            self.good = Some(s.clone());
            self.gone = None;
            return s;
        }
        let since = *self.gone.get_or_insert(now);
        let wait = if gap { GAP } else { COVER_WAIT };
        match &self.good {
            Some(g) if g.title != s.title || gap || g.artist != s.artist => {
                if now.duration_since(since) < wait {
                    return MediaState { between: true, ..g.clone() };
                }
                if gap {
                    self.good = None;
                } else {
                    self.good = Some(s.clone());
                    self.gone = None;
                }
                s
            }
            _ => {
                // The same song (its cover read again), or nothing played before: as it is.
                if !gap {
                    self.good = Some(s.clone());
                    self.gone = None;
                } else {
                    self.good = None;
                }
                s
            }
        }
    }
}

impl ThumbCache {
    /// The song changed a moment ago and its cover is still the last song's, or missing.
    fn stale(&self) -> bool {
        self.since.is_some_and(|t| t.elapsed() < COVER_WAIT) && (self.data.is_none() || (self.prev.is_some() && self.data == self.prev))
    }
}

/// Whether to read the cover again, `since` the song changed: while it may still be the last one's.
fn reread(since: Duration, missing: bool, same_as_last: bool) -> bool {
    since < SETTLE || ((missing || same_as_last) && since < SETTLE_MAX)
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
    let cover = || props.Thumbnail().ok().and_then(|r| thumbnail(&r).ok()).flatten();
    if key != cache.key {
        cache.key = key;
        cache.prev = cache.data.take();
        cache.since = Some(Instant::now());
        cache.data = cover();
    } else if let Some(since) = cache.since {
        if reread(since.elapsed(), cache.data.is_none(), cache.data.is_some() && cache.data == cache.prev) {
            if let Some(fresh) = cover() {
                cache.data = Some(fresh);
            }
        } else {
            cache.since = None;
        }
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
        between: false,
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
        let mut last = MediaState::default();
        loop {
            let state = read(&manager, &mut THUMBS.lock().unwrap()).unwrap_or_else(|_| MediaState { status: "none".into(), ..Default::default() });
            let stale = THUMBS.lock().unwrap().stale();
            let state = HOLD.lock().unwrap().settle(state, stale, Instant::now());
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
        let mut cache = THUMBS.lock().ok()?;
        let state = read(&manager, &mut cache).ok()?;
        let stale = cache.stale();
        drop(cache);
        Some(HOLD.lock().ok()?.settle(state, stale, Instant::now()))
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
                let before = front_app();
                let mut back = Back { before, player: 0, minimized: false, tab: None };
                let ok = focus(&aumid, &text(props.Title()), &text(props.Artist()), &text(props.AlbumTitle()), &mut back);
                back.player = front_app();
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
    if front_app() != b.player {
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

/// The app window in front, past Island's own: a click on the island's art can bring the island
/// forward (Justin, 11-19: the second click on it should put things back too, as on the taskbar).
/// Else the frontmost visible window of another program that is not a tool window, minimized or cloaked.
fn front_app() -> isize {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, IsIconic, GWL_EXSTYLE, WS_EX_TOOLWINDOW};
    let me = std::process::id();
    let fg = crate::procs::foreground();
    if fg != 0 && crate::procs::window_pid(fg) != me {
        return fg;
    }
    crate::procs::windows()
        .into_iter()
        .find(|w| {
            let h = HWND(w.hwnd as *mut _);
            let mut cloaked = 0u32;
            unsafe {
                let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
                w.pid != me && cloaked == 0 && !IsIconic(h).as_bool() && GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 == 0
            }
        })
        .map_or(0, |w| w.hwnd)
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
    use super::{friendly_app, reread, tab_score, Hold, MediaState};
    use std::time::{Duration, Instant};

    #[test]
    fn a_skip_keeps_the_last_song_through_the_gap() {
        let song = |t: &str| MediaState { available: true, title: t.into(), status: "playing".into(), ..Default::default() };
        let none = MediaState { status: "none".into(), ..Default::default() };
        let mut h = Hold { good: None, gone: None };
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let a = h.settle(song("A"), false, t0);
        assert!(a.title == "A" && !a.between);
        // Between songs: still A, marked between (its colour fades out).
        let gap = h.settle(none.clone(), false, at(700));
        assert!(gap.title == "A" && gap.between && gap.available);
        let changing = MediaState { status: "changing".into(), ..song("") };
        assert_eq!(h.settle(changing, false, at(1400)).title, "A");
        // B's title has come but its cover is still A's: A stays till the cover comes.
        let early = h.settle(song("B"), true, at(1800));
        assert!(early.title == "A" && early.between);
        let b = h.settle(song("B"), false, at(2100));
        assert!(b.title == "B" && !b.between);
        // A cover that never changes (the same album) holds the new song back only so long.
        let c = h.settle(song("C"), true, at(3000));
        assert_eq!(c.title, "B");
        assert_eq!(h.settle(song("C"), true, at(6000)).title, "C");
        // Music really stopped: gone after the gap.
        assert_eq!(h.settle(none.clone(), false, at(7000)).title, "C");
        assert!(!h.settle(none.clone(), false, at(12000)).available);
        assert!(!h.settle(none, false, at(13000)).available);
    }

    #[test]
    fn a_new_songs_cover_is_read_again_until_it_has_changed() {
        let s = Duration::from_secs;
        // The first seconds: always, the player may not have its new cover yet.
        assert!(reread(s(1), false, false));
        // Later only while it is missing or still the last song's, and not for ever.
        assert!(!reread(s(6), false, false));
        assert!(reread(s(6), true, false));
        assert!(reread(s(6), false, true));
        assert!(!reread(s(16), false, true));
    }

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
