// Volume, mute and the microphone on a Mac, through Core Audio, in the shapes audio.rs gives on
// Windows; and whether the microphone or a camera is in use (Core Audio and Core Media IO say a
// device runs, not for whom: the app named is the call app running, else "An app").

use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::mac::cf::{self, CFTypeRef};
use crate::overlay::LABEL as ISLAND;

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    volume: f64,
    muted: bool,
    device: Option<String>,
    device_id: Option<String>,
    mic_muted: Option<bool>,
    mic_device: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
pub struct PrivacyState {
    mic: Vec<String>,
    cam: Vec<String>,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn four(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
}

const SYSTEM: u32 = 1; // kAudioObjectSystemObject (and kCMIOObjectSystemObject)
const GLOBAL: u32 = four(b"glob");
const OUTPUT: u32 = four(b"outp");
const INPUT: u32 = four(b"inpt");
const MAIN: u32 = 0;
const DEFAULT_OUT: u32 = four(b"dOut");
const DEFAULT_IN: u32 = four(b"dIn ");
const NAME: u32 = four(b"lnam");
const UID: u32 = four(b"uid ");
const MUTE: u32 = four(b"mute");
const VOLUME: u32 = four(b"volm");
const VIRTUAL_VOLUME: u32 = four(b"vmvc");
const RUNNING_SOMEWHERE: u32 = four(b"gone");
const CMIO_DEVICES: u32 = four(b"dev#");

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectHasProperty(id: u32, addr: *const Address) -> bool;
    fn AudioObjectIsPropertySettable(id: u32, addr: *const Address, settable: *mut u8) -> i32;
    fn AudioObjectGetPropertyData(id: u32, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
    fn AudioObjectSetPropertyData(id: u32, addr: *const Address, qsize: u32, qdata: *const c_void, size: u32, data: *const c_void) -> i32;
}

#[link(name = "CoreMediaIO", kind = "framework")]
extern "C" {
    fn CMIOObjectGetPropertyDataSize(id: u32, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32) -> i32;
    fn CMIOObjectGetPropertyData(id: u32, addr: *const Address, qsize: u32, qdata: *const c_void, size: u32, used: *mut u32, data: *mut c_void) -> i32;
}

fn get<T: Copy + Default>(id: u32, selector: u32, scope: u32, element: u32) -> Option<T> {
    let a = Address { selector, scope, element };
    unsafe {
        if !AudioObjectHasProperty(id, &a) {
            return None;
        }
        let mut v = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        (AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, (&mut v as *mut T).cast()) == 0).then_some(v)
    }
}

fn set<T: Copy>(id: u32, selector: u32, scope: u32, element: u32, value: T) -> bool {
    let a = Address { selector, scope, element };
    unsafe {
        let mut settable = 0u8;
        if !AudioObjectHasProperty(id, &a) || AudioObjectIsPropertySettable(id, &a, &mut settable) != 0 || settable == 0 {
            return false;
        }
        AudioObjectSetPropertyData(id, &a, 0, std::ptr::null(), std::mem::size_of::<T>() as u32, (&value as *const T).cast()) == 0
    }
}

fn text(id: u32, selector: u32) -> Option<String> {
    let a = Address { selector, scope: GLOBAL, element: MAIN };
    unsafe {
        let mut s: CFTypeRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFTypeRef>() as u32;
        if AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, (&mut s as *mut CFTypeRef).cast()) != 0 || s.is_null() {
            return None;
        }
        let out = cf::string(s);
        cf::CFRelease(s);
        out.filter(|t| !t.is_empty())
    }
}

fn default_device(which: u32) -> Option<u32> {
    get::<u32>(SYSTEM, which, GLOBAL, MAIN).filter(|d| *d != 0)
}

/// The device's volume (0–1): the system's own "virtual main" volume where it has one (what the
/// menu bar's slider moves), else the main channel's, else the first two channels' average.
fn volume_of(dev: u32, scope: u32) -> Option<f64> {
    if let Some(v) = get::<f32>(dev, VIRTUAL_VOLUME, scope, MAIN) {
        return Some(v as f64);
    }
    if let Some(v) = get::<f32>(dev, VOLUME, scope, MAIN) {
        return Some(v as f64);
    }
    let l = get::<f32>(dev, VOLUME, scope, 1)?;
    let r = get::<f32>(dev, VOLUME, scope, 2).unwrap_or(l);
    Some(((l + r) / 2.0) as f64)
}

fn set_volume(dev: u32, scope: u32, v: f32) -> bool {
    set(dev, VIRTUAL_VOLUME, scope, MAIN, v) || set(dev, VOLUME, scope, MAIN, v) || {
        let l = set(dev, VOLUME, scope, 1, v);
        let r = set(dev, VOLUME, scope, 2, v);
        l || r
    }
}

pub fn read() -> AudioState {
    let mut st = AudioState::default();
    if let Some(dev) = default_device(DEFAULT_OUT) {
        st.device = text(dev, NAME);
        st.device_id = text(dev, UID);
        st.volume = volume_of(dev, OUTPUT).unwrap_or(0.0);
        st.muted = get::<u32>(dev, MUTE, OUTPUT, MAIN).is_some_and(|m| m != 0);
    }
    if let Some(mic) = default_device(DEFAULT_IN) {
        st.mic_device = text(mic, NAME);
        st.mic_muted = match get::<u32>(mic, MUTE, INPUT, MAIN) {
            Some(m) => Some(m != 0),
            None => volume_of(mic, INPUT).map(|v| v <= 0.0001),
        };
    }
    st.volume = (st.volume * 1000.0).round() / 1000.0;
    st
}

// ------------------------------------------------------------------ microphone and cameras in use

fn mic_running() -> bool {
    default_device(DEFAULT_IN).and_then(|d| get::<u32>(d, RUNNING_SOMEWHERE, GLOBAL, MAIN)).is_some_and(|r| r != 0)
}

fn camera_running() -> bool {
    let a = Address { selector: CMIO_DEVICES, scope: GLOBAL, element: MAIN };
    unsafe {
        let mut size = 0u32;
        if CMIOObjectGetPropertyDataSize(SYSTEM, &a, 0, std::ptr::null(), &mut size) != 0 || size == 0 {
            return false;
        }
        let mut devices = vec![0u32; size as usize / 4];
        let mut used = 0u32;
        if CMIOObjectGetPropertyData(SYSTEM, &a, 0, std::ptr::null(), size, &mut used, devices.as_mut_ptr().cast()) != 0 {
            return false;
        }
        devices.truncate(used as usize / 4);
        devices.into_iter().any(|d| {
            let q = Address { selector: RUNNING_SOMEWHERE, scope: GLOBAL, element: MAIN };
            let mut on = 0u32;
            let mut got = 0u32;
            CMIOObjectGetPropertyData(d, &q, 0, std::ptr::null(), 4, &mut got, (&mut on as *mut u32).cast()) == 0 && on != 0
        })
    }
}

/// Apps people call with, by their process name (mac/procs.rs), and how the island names them.
const CALL_APPS: &[(&str, &str)] = &[
    ("zoom.us.app", "Zoom"),
    ("microsoft teams.app", "Teams"),
    ("microsoft teams (work or school).app", "Teams"),
    ("microsoft teams classic.app", "Teams"),
    ("facetime.app", "FaceTime"),
    ("webex.app", "Webex"),
    ("slack.app", "Slack"),
    ("discord.app", "Discord"),
    ("skype.app", "Skype"),
    ("whatsapp.app", "WhatsApp"),
    ("google chrome.app", "Chrome"),
    ("safari.app", "Safari"),
    ("arc.app", "Arc"),
    ("microsoft edge.app", "Edge"),
    ("firefox.app", "Firefox"),
];

/// Who likely uses a device that runs: the call app that runs (front first), else "An app".
fn users() -> Vec<String> {
    let front = crate::procs::foreground_pid();
    let rows = crate::procs::snapshot();
    let front_name = rows.iter().find(|r| r.0 == front).map(|r| r.2.clone()).unwrap_or_default();
    let mut found: Vec<String> = Vec::new();
    if let Some((_, label)) = CALL_APPS.iter().find(|(n, _)| *n == front_name) {
        found.push(label.to_string());
    }
    for (name, label) in CALL_APPS.iter().take(10) {
        if found.is_empty() && rows.iter().any(|r| r.2 == *name) {
            found.push(label.to_string());
        }
    }
    if found.is_empty() {
        found.push("An app".into());
    }
    found
}

pub fn privacy() -> PrivacyState {
    let (mic, cam) = (mic_running(), camera_running());
    if !mic && !cam {
        return PrivacyState::default();
    }
    let who = users();
    PrivacyState { mic: if mic { who.clone() } else { Vec::new() }, cam: if cam { who } else { Vec::new() } }
}

/// Polls the volume (fast, cheap) and mic/camera use (slower) and emits on change.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = AudioState::default();
        let mut last_privacy = PrivacyState::default();
        let mut privacy_at = Instant::now() - Duration::from_secs(10);
        loop {
            let st = read();
            if st != last {
                let _ = app.emit_to(ISLAND, "audio", st.clone());
                last = st;
            }
            if privacy_at.elapsed() >= Duration::from_secs(2) {
                privacy_at = Instant::now();
                let p = privacy();
                if p != last_privacy {
                    let _ = app.emit_to(ISLAND, "privacy", p.clone());
                    last_privacy = p;
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });
}

#[tauri::command]
pub async fn audio_state() -> AudioState {
    tauri::async_runtime::spawn_blocking(read).await.unwrap_or_default()
}

#[tauri::command]
pub async fn audio_set(volume: Option<f64>, muted: Option<bool>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dev) = default_device(DEFAULT_OUT) else { return false };
        if let Some(v) = volume {
            if !set_volume(dev, OUTPUT, v.clamp(0.0, 1.0) as f32) {
                return false;
            }
        }
        if let Some(m) = muted {
            if !set(dev, MUTE, OUTPUT, MAIN, m as u32) {
                return false;
            }
        }
        true
    })
    .await
    .unwrap_or(false)
}

/// The input level the microphone had before Island turned it down (for a mic with no mute of its own).
static MIC_LEVEL: Mutex<Option<f32>> = Mutex::new(None);

/// Mutes or unmutes the default microphone for every app at once: its mute where it has one, else
/// its input level at 0 (and back to what it was).
#[tauri::command]
pub async fn mic_set_mute(muted: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(mic) = default_device(DEFAULT_IN) else { return false };
        if set(mic, MUTE, INPUT, MAIN, muted as u32) {
            return true;
        }
        let mut saved = MIC_LEVEL.lock().unwrap();
        if muted {
            let now = volume_of(mic, INPUT).unwrap_or(0.75) as f32;
            if now > 0.0001 {
                *saved = Some(now);
            }
            set_volume(mic, INPUT, 0.0)
        } else {
            set_volume(mic, INPUT, saved.take().unwrap_or(0.75))
        }
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_char_codes_match_core_audio() {
        assert_eq!(four(b"dOut"), 0x644F_7574);
        assert_eq!(four(b"glob"), 0x676C_6F62);
    }

    #[test]
    fn reading_never_fails() {
        // A CI Mac may have no sound device at all: the state is still whole.
        let st = read();
        assert!((0.0..=1.0).contains(&st.volume), "{st:?}");
        let p = privacy();
        assert!(p.mic.iter().chain(p.cam.iter()).all(|n| !n.is_empty()));
    }
}
