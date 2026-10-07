// Now playing, through Windows' Global System Media Transport Controls: the same
// source the volume flyout uses, so Spotify, browsers, Apple Music and local
// players all work without per-app integrations.

use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::overlay::LABEL as ISLAND;

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
            _ => false,
        };
        Ok(ok)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::friendly_app;

    #[test]
    fn app_ids_get_readable_names() {
        assert_eq!(friendly_app("Spotify.exe"), "Spotify");
        assert_eq!(friendly_app("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(friendly_app("MSEdge"), "Edge");
        assert_eq!(friendly_app("SomeVendor.CoolPlayer_abc!App"), "CoolPlayer");
    }
}
