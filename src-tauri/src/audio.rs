// Sound: master volume, mute and the default output device (Core Audio), the
// microphone's mute, and which apps are using the mic or camera right now (the
// same registry records Windows' privacy indicator reads).

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eConsole, eRender, EDataFlow, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

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

fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn default_device(e: &IMMDeviceEnumerator, flow: EDataFlow) -> Option<IMMDevice> {
    unsafe { e.GetDefaultAudioEndpoint(flow, eConsole).ok() }
}

fn endpoint(dev: &IMMDevice) -> Option<IAudioEndpointVolume> {
    unsafe { dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok() }
}

fn device_name(dev: &IMMDevice) -> Option<String> {
    unsafe {
        let store = dev.OpenPropertyStore(STGM_READ).ok()?;
        let pv = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let s = pv.to_string();
        (!s.is_empty()).then_some(s)
    }
}

fn device_id(dev: &IMMDevice) -> Option<String> {
    unsafe {
        let p = dev.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

pub fn read() -> AudioState {
    let Ok(e) = enumerator() else { return AudioState::default() };
    let mut st = AudioState::default();
    if let Some(dev) = default_device(&e, eRender) {
        st.device = device_name(&dev);
        st.device_id = device_id(&dev);
        if let Some(ep) = endpoint(&dev) {
            unsafe {
                st.volume = ep.GetMasterVolumeLevelScalar().map(|v| v as f64).unwrap_or(0.0);
                st.muted = ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            }
        }
    }
    if let Some(mic) = default_device(&e, eCapture) {
        st.mic_device = device_name(&mic);
        st.mic_muted = endpoint(&mic).and_then(|ep| unsafe { ep.GetMute().ok() }).map(|b| b.as_bool());
    }
    st.volume = (st.volume * 1000.0).round() / 1000.0;
    st
}

/// Apps whose LastUsedTimeStop is 0: using the device right now.
fn in_use(kind: &str) -> Vec<String> {
    let base = format!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{kind}");
    let Ok(root) = windows_registry::CURRENT_USER.open(&base) else { return Vec::new() };
    let mut out = Vec::new();
    let mut check = |key: &windows_registry::Key, name: &str, packaged: bool| {
        let start = key.get_u64("LastUsedTimeStart").unwrap_or(0);
        let stop = key.get_u64("LastUsedTimeStop").unwrap_or(1);
        if start != 0 && stop == 0 {
            let label = if packaged {
                name.split('_').next().unwrap_or(name).rsplit('.').next().unwrap_or(name).to_string()
            } else {
                name.rsplit('#').next().unwrap_or(name).trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
            };
            if !label.is_empty() && !out.contains(&label) {
                out.push(label);
            }
        }
    };
    if let Ok(names) = root.keys() {
        for name in names {
            if name == "NonPackaged" {
                continue;
            }
            if let Ok(k) = root.open(&name) {
                check(&k, &name, true);
            }
        }
    }
    if let Ok(np) = root.open("NonPackaged") {
        if let Ok(names) = np.keys() {
            for name in names {
                if let Ok(k) = np.open(&name) {
                    check(&k, &name, false);
                }
            }
        }
    }
    out
}

pub fn privacy() -> PrivacyState {
    PrivacyState { mic: in_use("microphone"), cam: in_use("webcam") }
}

/// Polls volume (fast, cheap) and mic/camera use (slower) and emits on change.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        com();
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
    tauri::async_runtime::spawn_blocking(|| {
        com();
        read()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn audio_set(volume: Option<f64>, muted: Option<bool>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        com();
        let Ok(e) = enumerator() else { return false };
        let Some(ep) = default_device(&e, eRender).and_then(|d| endpoint(&d)) else { return false };
        unsafe {
            if let Some(v) = volume {
                if ep.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0) as f32, std::ptr::null()).is_err() {
                    return false;
                }
            }
            if let Some(m) = muted {
                if ep.SetMute(m, std::ptr::null()).is_err() {
                    return false;
                }
            }
        }
        true
    })
    .await
    .unwrap_or(false)
}

/// Mutes or unmutes the default microphone for every app at once.
#[tauri::command]
pub async fn mic_set_mute(muted: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        com();
        let Ok(e) = enumerator() else { return false };
        let Some(ep) = default_device(&e, eCapture).and_then(|d| endpoint(&d)) else { return false };
        unsafe { ep.SetMute(muted, std::ptr::null()).is_ok() }
    })
    .await
    .unwrap_or(false)
}
