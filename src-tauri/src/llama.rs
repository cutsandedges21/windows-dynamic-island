// The bundled model runtime, for PCs without Ollama: llama.cpp's llama-server and the
// models the user picks (one is recommended for this PC's memory and graphics card),
// downloaded on demand into %LOCALAPPDATA%\Island\ai and checked against pinned SHA-256s.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::nowindow::NoWindow;

/// A download that sends nothing for this long has stalled.
const CHUNK_WAIT: Duration = Duration::from_secs(60);

/// A model Island can download, best first in TIERS.
#[derive(Debug, PartialEq)]
pub struct Tier {
    pub id: &'static str,
    /// What the user sees.
    pub name: &'static str,
    /// What it is like to use, in a few words.
    pub about: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// Bytes on disk, about what it takes in memory.
    pub size: u64,
    /// Extra llama-server options for this model.
    pub args: &'static [&'static str],
}

const GIB: u64 = 1 << 30;

/// The most of the PC's RAM a model may take, so the user's own apps keep the rest.
/// Moss's 32 GB PC ran its apps in about 10 GB; the 30B (18.6 GB) took it to 31 GB used.
const RAM_SHARE: f64 = 0.4;

pub const TIERS: [Tier; 4] = [
    Tier {
        id: "large",
        name: "Qwen3 30B",
        about: "The best answers. Slow to load the first time.",
        file: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
        sha256: "6c997b8af17debdfb01d890214400ccbab00db6acc0ba8da5de1cc906c4774d0",
        size: 18_560_000_000,
        args: &[],
    },
    Tier {
        id: "medium",
        name: "gpt-oss 20B",
        about: "Smart. Thinks for a moment before it answers.",
        file: "gpt-oss-20b-MXFP4.gguf",
        url: "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-MXFP4.gguf",
        sha256: "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
        size: 12_110_000_000,
        args: &["--chat-template-kwargs", r#"{"reasoning_effort":"low"}"#],
    },
    Tier {
        id: "small",
        name: "Qwen3 4B",
        about: "Quick, good everyday answers.",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        size: 2_500_000_000,
        args: &[],
    },
    // For 4 GB PCs, and for anyone who wants speed over depth. A thinking model: the
    // template switch turns that off, so it answers straight away like the 4B.
    Tier {
        id: "tiny",
        name: "Qwen3 1.7B",
        about: "The fastest and lightest. Fine for short, simple questions.",
        file: "Qwen3-1.7B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
        sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
        size: 1_107_409_472,
        args: &["--chat-template-kwargs", r#"{"enable_thinking":false}"#],
    },
];

/// A graphics card and its own memory.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gpu {
    pub name: String,
    pub vram: u64,
}

/// What a tier runs on.
#[derive(Debug, PartialEq, Clone)]
pub struct Plan {
    pub tier: &'static Tier,
    /// The whole model fits on this graphics card.
    pub gpu: Option<String>,
}

/// Where `tier` runs on this hardware: on the graphics card with the most memory of its own
/// that holds the model with a GiB to spare, else on the processor if the model takes at
/// most RAM_SHARE of the RAM. Integrated graphics share RAM and are slower than the
/// processor for this (measured: 12.6 vs 18.4 tok/s), so only cards with real memory of
/// their own count. None: too big for this PC.
fn placement(tier: &Tier, ram: u64, gpus: &[Gpu]) -> Option<Option<String>> {
    match gpus.iter().filter(|g| g.vram >= tier.size + GIB).max_by_key(|g| g.vram) {
        Some(card) => Some(Some(card.name.clone())),
        None => (ram as f64 * RAM_SHARE >= tier.size as f64).then_some(None),
    }
}

/// The best model this PC can run: the recommended one. None: under 4 GB, Local AI cannot run.
pub fn plan(ram: u64, gpus: &[Gpu]) -> Option<Plan> {
    TIERS.iter().find_map(|tier| placement(tier, ram, gpus).map(|gpu| Plan { tier, gpu }))
}

/// The memory a PC needs to run `tier` on its processor.
fn needs(tier: &Tier) -> u64 {
    (tier.size as f64 / RAM_SHARE).ceil() as u64
}

/// The model to download for `id`: that one, if this PC can run it. Empty: the recommended one.
fn wanted_from(id: &str, ram: u64, gpus: &[Gpu]) -> Result<&'static Tier, String> {
    let id = id.trim();
    if id.is_empty() {
        return plan(ram, gpus).map(|p| p.tier).ok_or_else(too_small);
    }
    let tier = TIERS.iter().find(|t| t.id == id).ok_or_else(|| format!("Island has no model called {id}."))?;
    placement(tier, ram, gpus).map(|_| tier).ok_or_else(|| too_big(tier))
}

/// The model to run for `id`: that one, if this PC can run it. Empty, or an id Island does
/// not know (such as the old "island"): the best one downloaded, which is the recommended
/// one when that is downloaded, else the recommended one (which then asks to be set up).
fn pick_from(id: &str, ram: u64, gpus: &[Gpu], downloaded: impl Fn(&Tier) -> bool) -> Result<Plan, String> {
    if let Some(tier) = TIERS.iter().find(|t| t.id == id.trim()) {
        return placement(tier, ram, gpus).map(|gpu| Plan { tier, gpu }).ok_or_else(|| too_big(tier));
    }
    let usable: Vec<Plan> = TIERS.iter().filter_map(|tier| placement(tier, ram, gpus).map(|gpu| Plan { tier, gpu })).collect();
    usable.iter().find(|p| downloaded(p.tier)).or(usable.first()).cloned().ok_or_else(too_small)
}

/// The model to download for `id` on this PC (see wanted_from).
pub fn wanted(id: &str) -> Result<&'static Tier, String> {
    let (ram, gpus) = hw();
    wanted_from(id, *ram, gpus)
}

/// Total RAM and the graphics cards Windows knows.
#[cfg(windows)]
pub fn hardware() -> (u64, Vec<Gpu>) {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    let ram = if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() { mem.ullTotalPhys } else { 0 };
    (ram, gpus())
}

/// Display adapters from the registry: the WMI figure stops at 4 GB, this one does not.
#[cfg(windows)]
fn gpus() -> Vec<Gpu> {
    const DISPLAY: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = windows_registry::LOCAL_MACHINE.open(DISPLAY) else { return Vec::new() };
    let Ok(names) = class.keys() else { return Vec::new() };
    names
        .filter(|n| n.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|n| {
            let key = class.open(&n).ok()?;
            let name = key.get_string("DriverDesc").ok()?;
            let vram = key.get_u64("HardwareInformation.qwMemorySize").or_else(|_| key.get_u32("HardwareInformation.MemorySize").map(u64::from)).unwrap_or(0);
            Some(Gpu { name, vram })
        })
        .collect()
}

/// RAM and graphics cards, read once: they do not change while Island runs.
fn hw() -> &'static (u64, Vec<Gpu>) {
    static HW: OnceLock<(u64, Vec<Gpu>)> = OnceLock::new();
    HW.get_or_init(hardware)
}

/// The processor's name as Windows shows it.
#[cfg(windows)]
pub fn cpu_name() -> String {
    windows_registry::LOCAL_MACHINE
        .open(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
        .and_then(|k| k.get_string("ProcessorNameString"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Island's own runtime is the Windows llama.cpp build; Macs use Ollama until a later part.
#[cfg(target_os = "macos")]
const MAC_RUNTIME: &str = "Island's own model runtime comes to the Mac later. Install Ollama from ollama.com and pick an Ollama model.";

#[cfg(target_os = "macos")]
pub fn hardware() -> (u64, Vec<Gpu>) {
    (crate::mac::sys::total_memory(), Vec::new())
}

#[cfg(target_os = "macos")]
pub fn cpu_name() -> String {
    crate::mac::sys::cpu_name()
}

#[cfg(target_os = "macos")]
fn disk_free(path: &Path) -> Option<u64> {
    let dir = path.ancestors().find(|p| p.is_dir())?;
    crate::mac::sys::disk_space(dir).map(|(free, _)| free)
}

#[cfg(target_os = "macos")]
fn extract(_zip: &Path, _dir: &Path) -> Result<(), String> {
    Err(MAC_RUNTIME.to_string())
}

/// Free bytes on the disk that holds `path` (or the nearest folder above it that exists).
#[cfg(windows)]
fn disk_free(path: &Path) -> Option<u64> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let dir = path.ancestors().find(|p| p.is_dir())?;
    let wide: Vec<u16> = dir.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free as *mut u64), None, None) }.ok()?;
    Some(free)
}

// ------------------------------------------------------------------ downloads

/// Downloads `url` to `dest`, carrying on from a `.part` left by an earlier try, and keeps
/// the file only if its SHA-256 is `sha256`. `progress(done, total)` follows the bytes.
async fn download(url: &str, sha256: &str, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let stopped = || "The download stopped. Next time it carries on where it left off.".to_string();
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("download");
    let part = dest.with_file_name(format!("{name}.part"));
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "Island could not make its AI folder.".to_string())?;
    }
    // What an earlier try already fetched counts towards the checksum.
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut f) = File::open(&part) {
        let mut buf = vec![0u8; 1 << 20];
        while let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    let mut request = client().get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = tokio::time::timeout(CHUNK_WAIT, request.send()).await.map_err(|_| stopped())?.map_err(|_| stopped())?;
    let status = response.status().as_u16();
    let mut file = match status {
        206 => Some(OpenOptions::new().append(true).open(&part).map_err(|_| stopped())?),
        200 => {
            // The server starts from the top: so do we.
            hasher = Sha256::new();
            have = 0;
            Some(File::create(&part).map_err(|_| stopped())?)
        }
        416 => None, // the part is already whole
        _ => return Err(format!("The download failed (error {status}).")),
    };
    if let Some(file) = file.as_mut() {
        let total = have + response.content_length().unwrap_or(0);
        progress(have, total);
        loop {
            let chunk = tokio::time::timeout(CHUNK_WAIT, response.chunk()).await.map_err(|_| stopped())?.map_err(|_| stopped())?;
            let Some(bytes) = chunk else { break };
            file.write_all(&bytes).map_err(|_| "The disk is full or Island cannot write to it.".to_string())?;
            hasher.update(&bytes);
            have += bytes.len() as u64;
            progress(have, total.max(have));
        }
        file.flush().map_err(|_| stopped())?;
    }
    drop(file);
    if format!("{:x}", hasher.finalize()) != sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("The download was damaged. Try again.".to_string());
    }
    std::fs::rename(&part, dest).map_err(|_| "Island could not finish the download.".to_string())
}

/// Unpacks a zip into `dir` with Windows' own tar.exe (bsdtar reads zips).
#[cfg(windows)]
fn extract(zip: &Path, dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::fs::create_dir_all(dir).map_err(|_| "Island could not make its AI folder.".to_string())?;
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let status = std::process::Command::new(root.join("System32").join("tar.exe"))
        .arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(dir)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "Windows could not unpack the model runtime.".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows could not unpack the model runtime.".to_string())
    }
}

// ------------------------------------------------------------------ this PC

/// llama.cpp's Vulkan build: it also carries CPU builds from SSE4.2 to Zen 4, so one zip
/// runs on every x64 PC and uses a graphics card when the plan picked one.
const BUILD: &str = "b11450";
const RUNTIME_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11450/llama-b11450-bin-win-vulkan-x64.zip";
const RUNTIME_SHA256: &str = "8ce71f060c08cc8b89115eab0d63209d80537936706544d95c3b936fd0f63095";
const RUNTIME_SIZE: u64 = 33_400_000;
/// llama-server goes after this long unused, giving its memory back.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// Loading 18 GB from a slow disk can take minutes.
const LOAD_LIMIT: Duration = Duration::from_secs(300);

pub fn ai_dir() -> PathBuf {
    crate::log::data_dir().join("ai")
}
fn runtime_dir() -> PathBuf {
    ai_dir().join(format!("llama-{BUILD}"))
}
fn server_exe() -> PathBuf {
    runtime_dir().join("llama-server.exe")
}
fn model_file(tier: &Tier) -> PathBuf {
    ai_dir().join("models").join(tier.file)
}

/// An unfinished download of `tier`, which the next try carries on from.
fn part_file(tier: &Tier) -> PathBuf {
    ai_dir().join("models").join(format!("{}.part", tier.file))
}
fn part_size(tier: &Tier) -> u64 {
    std::fs::metadata(part_file(tier)).map(|m| m.len()).unwrap_or(0)
}

/// This PC's plan (the recommended model), worked out once.
pub fn this_pc() -> Option<&'static Plan> {
    static PLAN: OnceLock<Option<Plan>> = OnceLock::new();
    PLAN.get_or_init(|| {
        let (ram, gpus) = hw();
        plan(*ram, gpus)
    })
    .as_ref()
}

/// The bundled runtime as the activity sees it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bundled {
    /// The model recommended for this PC ("gpt-oss 20B"), or None when it has too little memory.
    pub model: Option<&'static str>,
    /// Its id.
    pub recommended: Option<&'static str>,
    /// Island can answer: the runtime and a model this PC can run are downloaded.
    pub installed: bool,
    /// The downloaded models this PC can run, best first.
    pub ready: Vec<Ready>,
    /// Bytes still to download for the recommended model.
    pub download: u64,
    pub gpu: Option<String>,
    pub setting_up: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Ready {
    pub id: &'static str,
    pub name: &'static str,
}

pub fn status() -> Bundled {
    let (ram, gpus) = hw();
    let runtime = server_exe().is_file();
    let ready: Vec<Ready> = TIERS
        .iter()
        .filter(|t| runtime && placement(t, *ram, gpus).is_some() && model_file(t).is_file())
        .map(|t| Ready { id: t.id, name: t.name })
        .collect();
    let setting_up = downloading_now().is_some();
    let Some(plan) = this_pc() else {
        return Bundled { model: None, recommended: None, installed: false, ready, download: 0, gpu: None, setting_up };
    };
    let download = if runtime { 0 } else { RUNTIME_SIZE } + if model_file(plan.tier).is_file() { 0 } else { plan.tier.size };
    Bundled { model: Some(plan.tier.name), recommended: Some(plan.tier.id), installed: !ready.is_empty(), ready, download, gpu: plan.gpu.clone(), setting_up }
}

/// What this PC has, for the model picker.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub cpu: String,
    pub threads: usize,
    /// Bytes of RAM.
    pub ram: u64,
    pub gpus: Vec<Gpu>,
    /// Free bytes on the disk the models go to, and its name ("C:").
    pub disk_free: u64,
    pub disk: String,
}

/// One model Island can download, as this PC sees it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub about: &'static str,
    /// Download size in bytes, about what it takes in memory.
    pub size: u64,
    /// The memory a PC needs to run it on its processor.
    pub needs: u64,
    pub downloaded: bool,
    /// Bytes an unfinished download already has.
    pub partial: u64,
    /// This PC can run it.
    pub fits: bool,
    /// The graphics card it runs on. None: the processor.
    pub gpu: Option<String>,
    pub recommended: bool,
}

/// The model picker's view: this PC, every model, and what is downloading.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    pub machine: Machine,
    pub models: Vec<ModelInfo>,
    /// llama-server is downloaded.
    pub runtime: bool,
    /// What the runtime adds to the first download.
    pub runtime_size: u64,
    /// The model being downloaded right now.
    pub downloading: Option<&'static str>,
}

/// Every tier as a PC with `ram` and `gpus` sees it; `on_disk` says (downloaded, partial bytes).
fn report(ram: u64, gpus: &[Gpu], on_disk: impl Fn(&Tier) -> (bool, u64)) -> Vec<ModelInfo> {
    let recommended = plan(ram, gpus).map(|p| p.tier.id);
    TIERS
        .iter()
        .map(|t| {
            let place = placement(t, ram, gpus);
            let (downloaded, partial) = on_disk(t);
            ModelInfo { id: t.id, name: t.name, about: t.about, size: t.size, needs: needs(t), downloaded, partial, fits: place.is_some(), gpu: place.flatten(), recommended: recommended == Some(t.id) }
        })
        .collect()
}

pub fn models() -> Models {
    let (ram, gpus) = hw();
    let dir = ai_dir();
    let disk = dir.to_string_lossy().chars().take(2).collect::<String>();
    Models {
        machine: Machine { cpu: cpu_name(), threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0), ram: *ram, gpus: gpus.clone(), disk_free: disk_free(&dir).unwrap_or(0), disk },
        models: report(*ram, gpus, |t| (model_file(t).is_file(), part_size(t))),
        runtime: server_exe().is_file(),
        runtime_size: RUNTIME_SIZE,
        downloading: downloading_now(),
    }
}

/// How far a download has got, for the "local-setup" event.
#[derive(Serialize, Clone, Debug)]
pub struct Progress {
    /// "runtime" or "model".
    pub stage: &'static str,
    /// The model being set up.
    pub model: &'static str,
    pub done: u64,
    pub total: u64,
}

/// The model being downloaded, if any: one download at a time.
fn downloading() -> &'static Mutex<Option<&'static str>> {
    static NOW: OnceLock<Mutex<Option<&'static str>>> = OnceLock::new();
    NOW.get_or_init(Default::default)
}

pub fn downloading_now() -> Option<&'static str> {
    *downloading().lock().unwrap()
}

/// The right to download, held for as long as a download runs. Dropping it (the download
/// finished, failed or was cancelled by dropping its future) lets the next one start.
pub struct Slot(&'static str);

impl Drop for Slot {
    fn drop(&mut self) {
        let mut now = downloading().lock().unwrap();
        if *now == Some(self.0) {
            *now = None;
        }
    }
}

/// Claims the download slot for `tier`, or says what is downloading already.
pub fn claim(tier: &'static Tier) -> Result<Slot, String> {
    let mut now = downloading().lock().unwrap();
    if let Some(id) = *now {
        let name = TIERS.iter().find(|t| t.id == id).map_or(id, |t| t.name);
        return Err(format!("{name} is downloading. Wait for it, or cancel it, first."));
    }
    *now = Some(tier.id);
    Ok(Slot(tier.id))
}

/// Room to spare on the disk after a download.
const SPARE: u64 = 500_000_000;

/// Bytes `tier` still needs on disk: the rest of its model, and the runtime (zip and
/// unpacked) if that is missing too.
fn missing_bytes(tier: &Tier) -> u64 {
    let runtime = if server_exe().is_file() { 0 } else { RUNTIME_SIZE * 4 };
    let model = if model_file(tier).is_file() { 0 } else { tier.size.saturating_sub(part_size(tier)) };
    runtime + model
}

/// Downloads what `tier` is missing: the runtime, then the model. `slot` is held throughout.
#[cfg_attr(target_os = "macos", allow(unreachable_code, unused_variables, unused_mut))]
pub async fn setup(tier: &'static Tier, slot: Slot, mut report: impl FnMut(Progress)) -> Result<(), String> {
    // Nothing to download on a Mac: the runtime here is the Windows build.
    #[cfg(target_os = "macos")]
    return Err(MAC_RUNTIME.to_string());
    let need = missing_bytes(tier);
    if need > 0 {
        if let Some(free) = disk_free(&ai_dir()).filter(|free| *free < need + SPARE) {
            return Err(format!("Not enough free space: {} needs {:.1} GB, the disk has {:.1} GB free.", tier.name, (need + SPARE) as f64 / 1e9, free as f64 / 1e9));
        }
    }
    install_runtime(tier, &mut report).await?;
    let model = model_file(tier);
    if !model.is_file() {
        download(tier.url, tier.sha256, &model, |done, total| report(Progress { stage: "model", model: tier.id, done, total })).await?;
    }
    drop(slot);
    Ok(())
}

async fn install_runtime(tier: &Tier, report: &mut impl FnMut(Progress)) -> Result<(), String> {
    if server_exe().is_file() {
        return Ok(());
    }
    let zip = ai_dir().join(format!("llama-{BUILD}.zip"));
    download(RUNTIME_URL, RUNTIME_SHA256, &zip, |done, total| report(Progress { stage: "runtime", model: tier.id, done, total })).await?;
    extract(&zip, &runtime_dir())?;
    let _ = std::fs::remove_file(&zip);
    if server_exe().is_file() {
        Ok(())
    } else {
        Err("The model runtime download did not contain llama-server.".to_string())
    }
}

/// Deletes one model and any unfinished download of it, or with None everything Local AI
/// downloaded. A server running what goes is stopped first.
pub async fn remove(id: Option<&str>) -> Result<(), String> {
    let busy = downloading_now();
    let Some(id) = id.map(str::trim).filter(|id| !id.is_empty()) else {
        if busy.is_some() {
            return Err("Cancel the download first.".to_string());
        }
        stop().await;
        return match std::fs::remove_dir_all(ai_dir()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err("Island could not delete its AI folder.".to_string()),
            _ => Ok(()),
        };
    };
    let tier = TIERS.iter().find(|t| t.id == id).ok_or_else(|| format!("Island has no model called {id}."))?;
    if busy == Some(tier.id) {
        return Err("Cancel the download first.".to_string());
    }
    stop_if(tier.id).await;
    for path in [model_file(tier), part_file(tier)] {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Island could not delete {}. Is it open in another app?", tier.name));
            }
        }
    }
    Ok(())
}

fn too_small() -> String {
    "This PC has less than 4 GB of memory, too little for Local AI.".to_string()
}

fn too_big(tier: &Tier) -> String {
    format!("{} is too big for this PC. Pick a smaller model in Activities › Local AI.", tier.name)
}

// ------------------------------------------------------------------ the server

struct Running {
    child: std::process::Child,
    port: u16,
    last: std::time::Instant,
    /// The model it has loaded.
    tier: &'static str,
}

fn server() -> &'static tokio::sync::Mutex<Option<Running>> {
    static SERVER: OnceLock<tokio::sync::Mutex<Option<Running>>> = OnceLock::new();
    SERVER.get_or_init(Default::default)
}

/// One job for every server Island starts: closing it (Island exiting) ends them all.
fn job() -> Option<&'static Job> {
    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    JOB.get_or_init(|| Job::new().ok()).as_ref()
}

/// The port of a llama-server running the model `id` (see pick_from), started if need be.
pub async fn ensure(id: &str) -> Result<u16, String> {
    let (ram, gpus) = hw();
    ensure_plan(&pick_from(id, *ram, gpus, |t| model_file(t).is_file())?).await
}

#[cfg_attr(target_os = "macos", allow(unreachable_code, unused_variables, unused_mut))]
async fn ensure_plan(plan: &Plan) -> Result<u16, String> {
    #[cfg(target_os = "macos")]
    return Err(MAC_RUNTIME.to_string());
    let (exe, model) = (server_exe(), model_file(plan.tier));
    if !exe.is_file() || !model.is_file() {
        return Err(format!("{} is not downloaded yet. Get it in Activities › Local AI.", plan.tier.name));
    }
    let mut slot = server().lock().await;
    if let Some(running) = slot.as_mut() {
        if running.tier == plan.tier.id && matches!(running.child.try_wait(), Ok(None)) {
            running.last = std::time::Instant::now();
            return Ok(running.port);
        }
        // Another model (the user switched), or it died: start again, once the old one has
        // let go of its memory, so two models never sit in RAM together.
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    *slot = None;
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|_| "No free port for the model runtime.".to_string())?;
    let log = File::create(ai_dir().join("server.log")).ok();
    let mut command = std::process::Command::new(&exe);
    command.args(server_args(&model, port, plan.gpu.is_some(), plan.tier)).current_dir(runtime_dir()).stdin(std::process::Stdio::null()).no_window();
    match log.as_ref().and_then(|f| Some((f.try_clone().ok()?, f.try_clone().ok()?))) {
        Some((out, err)) => command.stdout(out).stderr(err),
        None => command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()),
    };
    let mut child = command.spawn().map_err(|_| "Windows would not start the model runtime.".to_string())?;
    if let Some(job) = job() {
        let _ = job.adopt(&child);
    }
    let started = std::time::Instant::now();
    if let Err(why) = wait_ready(port, LOAD_LIMIT, || matches!(child.try_wait(), Ok(None))).await {
        let _ = child.kill();
        crate::log::line("llama: failed to start".to_string());
        return Err(why);
    }
    crate::log::line(format!("llama: {} ready in {:.1}s{}", plan.tier.id, started.elapsed().as_secs_f32(), if plan.gpu.is_some() { " on the GPU" } else { "" }));
    *slot = Some(Running { child, port, last: std::time::Instant::now(), tier: plan.tier.id });
    start_reaper();
    Ok(port)
}

/// Marks the server as just used, so it is not stopped mid-conversation.
pub async fn touch() {
    if let Some(running) = server().lock().await.as_mut() {
        running.last = std::time::Instant::now();
    }
}

pub async fn stop() {
    if let Some(running) = server().lock().await.take() {
        end(running);
    }
}

/// Stops the server if it has the model `id` loaded (that model is being deleted).
async fn stop_if(id: &str) {
    let mut slot = server().lock().await;
    if slot.as_ref().is_some_and(|r| r.tier == id) {
        if let Some(running) = slot.take() {
            end(running);
        }
    }
}

/// Kills the server and waits for it to be gone: until then Windows keeps its model file
/// open, and deleting that file right after would fail.
fn end(mut running: Running) {
    let _ = running.child.kill();
    let _ = running.child.wait();
}

fn start_reaper() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut slot = server().lock().await;
            if slot.as_ref().is_some_and(|r| r.last.elapsed() > IDLE) {
                if let Some(mut running) = slot.take() {
                    let _ = running.child.kill();
                    crate::log::line("llama: stopped after 5 idle minutes".to_string());
                }
            }
        }
    });
}

/// Starting options for llama-server. Qwen3 Instruct models answer straight away; gpt-oss
/// always reasons first, so it is told to keep that short.
fn server_args(model: &Path, port: u16, gpu: bool, tier: &Tier) -> Vec<String> {
    let mut args: Vec<String> = ["-m", &model.display().to_string(), "--host", "127.0.0.1", "--port", &port.to_string(), "-c", "8192", "--jinja", "--no-webui", "-ngl", if gpu { "99" } else { "0" }]
        .iter()
        .map(|s| s.to_string())
        .collect();
    // One copy of the weights: repacking them for faster CPU maths doubled gpt-oss-20b's
    // memory (20.5 GB against 10.1 GB) for 20% more speed. Memory is what laptops lack.
    args.push("--no-repack".to_string());
    if !gpu {
        // Hide every GPU: the Vulkan build would otherwise still put its working memory on
        // an integrated one, which fails for big models.
        args.extend(["-dev".to_string(), "none".to_string()]);
    }
    args.extend(tier.args.iter().map(|s| s.to_string()));
    args
}

/// A Windows job that kills everything in it when Island goes, even if Island crashes.
#[cfg(windows)]
struct Job(windows::Win32::Foundation::HANDLE);

// The handle is only passed to thread-safe Win32 calls.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

/// No runtime starts on a Mac yet (see MAC_RUNTIME), so there is nothing to hold.
#[cfg(target_os = "macos")]
struct Job;

#[cfg(target_os = "macos")]
impl Job {
    fn new() -> Result<Job, String> {
        Ok(Job)
    }

    fn adopt(&self, _child: &std::process::Child) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
impl Job {
    fn new() -> Result<Job, String> {
        use windows::Win32::System::JobObjects::{CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        let failed = |_| "Windows would not set up the model runtime.".to_string();
        unsafe {
            let handle = CreateJobObjectW(None, windows::core::PCWSTR::null()).map_err(failed)?;
            let job = Job(handle);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const std::ffi::c_void, size).map_err(failed)?;
            Ok(job)
        }
    }

    fn adopt(&self, child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe { AssignProcessToJobObject(self.0, windows::Win32::Foundation::HANDLE(child.as_raw_handle())) }.map_err(|_| "Windows would not set up the model runtime.".to_string())
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Waits until llama-server on `port` has loaded its model (GET /health answers 200).
async fn wait_ready(port: u16, limit: Duration, mut alive: impl FnMut() -> bool) -> Result<(), String> {
    let until = std::time::Instant::now() + limit;
    let url = format!("http://127.0.0.1:{port}/health");
    loop {
        if !alive() {
            return Err(r"The model runtime stopped while loading. Its log is in %LOCALAPPDATA%\Island\ai\server.log.".to_string());
        }
        if let Ok(reply) = local_client().get(&url).timeout(Duration::from_secs(2)).send().await {
            if reply.status().is_success() {
                return Ok(());
            }
        }
        if std::time::Instant::now() >= until {
            return Err("The model took too long to load.".to_string());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// For this PC's own server: a system proxy must never see these requests.
fn local_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().no_proxy().build().unwrap_or_default())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("island-llama-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Serves `body` once, honouring a Range header when `ranges` is on. Sends the Range it saw back through the handle.
    async fn serve(body: Vec<u8>, ranges: bool) -> (String, tokio::task::JoinHandle<Option<u64>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut buf = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = sock.read(&mut buf).await.unwrap();
                head.extend_from_slice(&buf[..n]);
            }
            let text = String::from_utf8_lossy(&head).to_lowercase();
            let from = text.lines().find_map(|l| l.strip_prefix("range: bytes=")).and_then(|r| r.trim_end_matches('-').parse::<u64>().ok());
            let start = if ranges { from.unwrap_or(0) as usize } else { 0 };
            let status = if ranges && from.is_some() { "206 Partial Content" } else { "200 OK" };
            let rest = &body[start..];
            let reply = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", rest.len());
            sock.write_all(reply.as_bytes()).await.unwrap();
            sock.write_all(rest).await.unwrap();
            let _ = sock.shutdown().await;
            from
        });
        (format!("http://{addr}/model.gguf"), task)
    }

    fn payload() -> Vec<u8> {
        (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect()
    }

    #[tokio::test]
    async fn a_download_is_kept_when_its_checksum_matches() {
        let (dir, body) = (temp_dir("ok"), payload());
        let (url, _) = serve(body.clone(), true).await;
        let dest = dir.join("model.gguf");
        let mut last = (0, 0);
        download(&url, &hex(&body), &dest, |done, total| last = (done, total)).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(last, (body.len() as u64, body.len() as u64));
        assert!(!dir.join("model.gguf.part").exists());
    }

    #[tokio::test]
    async fn a_damaged_download_is_thrown_away() {
        let dir = temp_dir("bad");
        let (url, _) = serve(payload(), true).await;
        let dest = dir.join("model.gguf");
        assert!(download(&url, &"0".repeat(64), &dest, |_, _| {}).await.is_err());
        assert!(!dest.exists() && !dir.join("model.gguf.part").exists());
    }

    #[tokio::test]
    async fn a_download_carries_on_where_it_stopped() {
        let (dir, body) = (temp_dir("resume"), payload());
        std::fs::write(dir.join("model.gguf.part"), &body[..300_000]).unwrap();
        let (url, seen) = serve(body.clone(), true).await;
        let dest = dir.join("model.gguf");
        download(&url, &hex(&body), &dest, |_, _| {}).await.unwrap();
        assert_eq!(seen.await.unwrap(), Some(300_000));
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    #[tokio::test]
    async fn a_server_that_cannot_resume_starts_over() {
        let (dir, body) = (temp_dir("restart"), payload());
        std::fs::write(dir.join("model.gguf.part"), b"stale bytes from another file").unwrap();
        let (url, _) = serve(body.clone(), false).await;
        let dest = dir.join("model.gguf");
        download(&url, &hex(&body), &dest, |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    #[test]
    fn the_server_listens_on_this_pc_only_and_uses_the_gpu_when_picked() {
        let model = Path::new(r"C:\ai\m.gguf");
        let args = server_args(model, 41234, false, &TIERS[2]);
        let joined = args.join(" ");
        assert!(joined.contains(r"-m C:\ai\m.gguf") && joined.contains("--host 127.0.0.1") && joined.contains("--port 41234"), "{joined}");
        assert!(joined.contains("-ngl 0") && joined.contains("--jinja"), "{joined}");
        assert!(server_args(model, 1, true, &TIERS[2]).join(" ").contains("-ngl 99"));
        // The Vulkan build would still put its working memory on an integrated GPU, which
        // fails for big models (seen: ErrorOutOfDeviceMemory with the 30B on Intel UHD).
        assert!(joined.contains("-dev none"), "{joined}");
        assert!(!server_args(model, 1, true, &TIERS[2]).join(" ").contains("-dev none"));
        // Without it llama.cpp keeps a second, repacked copy of the weights: gpt-oss-20b took
        // 20.5 GB instead of 10.1 GB on Moss's PC.
        for tier in &TIERS {
            assert!(server_args(model, 1, false, tier).contains(&"--no-repack".to_string()), "{}", tier.id);
        }
        assert!(server_args(model, 1, false, &TIERS[1]).join(" ").contains("reasoning_effort"), "gpt-oss keeps its reasoning short");
        assert!(server_args(model, 1, false, &TIERS[3]).join(" ").contains(r#"{"enable_thinking":false}"#), "Qwen3 1.7B answers without thinking first");
    }

    #[test]
    fn every_model_is_listed_with_where_it_runs() {
        let on_disk = |t: &Tier| (t.id == "small", if t.id == "tiny" { 400_000_000 } else { 0 });
        let list = report(ram(32), &[gpu("Intel(R) UHD Graphics", 1)], on_disk);
        assert_eq!(list.iter().map(|m| m.id).collect::<Vec<_>>(), ["large", "medium", "small", "tiny"]);
        let by = |id: &str| list.iter().find(|m| m.id == id).unwrap();
        assert!(!by("large").fits && by("medium").fits && by("small").fits && by("tiny").fits);
        assert_eq!(list.iter().filter(|m| m.recommended).map(|m| m.id).collect::<Vec<_>>(), ["medium"]);
        assert!(by("small").downloaded && !by("medium").downloaded);
        assert_eq!(by("tiny").partial, 400_000_000);
        assert!(list.iter().all(|m| m.gpu.is_none()), "integrated graphics never run a model");
        // A 32 GB PC runs what needs at most 32 GB; the 30B needs more.
        assert!(by("medium").needs <= ram(32) && by("large").needs > ram(32));
        let gamer = report(ram(16), &[gpu("NVIDIA GeForce RTX 4070", 12)], |_| (false, 0));
        let on_card = gamer.iter().find(|m| m.id == "small").unwrap();
        assert_eq!(on_card.gpu.as_deref(), Some("NVIDIA GeForce RTX 4070"));
        assert!(gamer.iter().find(|m| m.id == "small").unwrap().recommended, "12 GB of VRAM cannot hold gpt-oss with room to spare");
    }

    #[test]
    fn a_chosen_model_runs_if_this_pc_can_take_it() {
        let none = |_: &Tier| false;
        assert_eq!(pick_from("small", ram(32), &[], none).unwrap().tier.id, "small");
        assert!(pick_from("large", ram(32), &[], none).unwrap_err().contains("too big"));
        // Nothing named: the recommended model if it is downloaded, else the best one that is.
        assert_eq!(pick_from("", ram(32), &[], |t| t.id == "medium" || t.id == "small").unwrap().tier.id, "medium");
        assert_eq!(pick_from("", ram(32), &[], |t| t.id == "small" || t.id == "tiny").unwrap().tier.id, "small");
        assert_eq!(pick_from("", ram(32), &[], none).unwrap().tier.id, "medium");
        // The old activity sent "island"; it still means "whatever is best here".
        assert_eq!(pick_from("island", ram(32), &[], |t| t.id == "tiny").unwrap().tier.id, "tiny");
        // Too big to pick, even when its file is on disk.
        assert_eq!(pick_from("", ram(32), &[], |t| t.id == "large").unwrap().tier.id, "medium");
        assert!(pick_from("", ram(2), &[], none).is_err());
    }

    #[test]
    fn downloads_are_for_models_this_pc_can_run() {
        assert_eq!(wanted_from("", ram(32), &[]).unwrap().id, "medium");
        assert_eq!(wanted_from(" tiny ", ram(32), &[]).unwrap().id, "tiny");
        assert!(wanted_from("large", ram(32), &[]).unwrap_err().contains("Qwen3 30B is too big"));
        assert!(wanted_from("huge", ram(32), &[]).unwrap_err().contains("no model called huge"));
        assert!(wanted_from("", ram(2), &[]).unwrap_err().contains("4 GB"));
    }

    #[test]
    fn one_download_at_a_time() {
        let slot = claim(&TIERS[3]).unwrap();
        assert_eq!(downloading_now(), Some("tiny"));
        assert!(claim(&TIERS[2]).err().unwrap().contains("Qwen3 1.7B is downloading"));
        drop(slot);
        assert_eq!(downloading_now(), None);
        let again = claim(&TIERS[2]).unwrap();
        assert_eq!(downloading_now(), Some("small"));
        drop(again);
    }

    #[test]
    fn the_job_ends_its_processes_when_it_closes() {
        let job = Job::new().unwrap();
        let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        job.adopt(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let started = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(started.elapsed() < Duration::from_secs(3), "still running after the job closed");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Answers /health with 503 `loading` times, then 200, one connection each.
    async fn health(loading: usize) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for i in 0..=loading {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let status = if i < loading { "503 Service Unavailable" } else { "200 OK" };
                let _ = sock.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}").as_bytes()).await;
            }
        });
        port
    }

    #[tokio::test]
    async fn ready_once_the_model_has_loaded() {
        let port = health(3).await;
        wait_ready(port, Duration::from_secs(10), || true).await.unwrap();
    }

    #[tokio::test]
    async fn a_server_that_dies_while_loading_is_reported() {
        let port = health(1000).await;
        let started = std::time::Instant::now();
        assert!(wait_ready(port, Duration::from_secs(10), || false).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// The real thing, small tier: downloads the runtime from GitHub, starts it and asks.
    /// Needs the small model in the AI folder. `cargo test --lib llama:: -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_runtime_answers() {
        install_runtime(&TIERS[2], &mut |p: Progress| if p.done == p.total { println!("{} {} bytes", p.stage, p.total) }).await.unwrap();
        let plan = Plan { tier: &TIERS[2], gpu: None };
        let started = std::time::Instant::now();
        let port = ensure_plan(&plan).await.unwrap();
        println!("ready on {port} in {:?}", started.elapsed());
        let body = serde_json::json!({ "messages": [{ "role": "user", "content": "In one short sentence: what is the capital of Canada?" }], "max_tokens": 40 });
        let started = std::time::Instant::now();
        let reply: serde_json::Value = local_client().post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body).send().await.unwrap().json().await.unwrap();
        let text = reply["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
        println!("{:?}: {text}", started.elapsed());
        assert!(text.to_lowercase().contains("ottawa"), "{reply}");
        assert_eq!(ensure_plan(&plan).await.unwrap(), port, "a running server is reused");
        stop().await;
    }

    /// The tiny tier for real: downloads it (1.1 GB, checked), starts it, and checks that it
    /// answers without a thinking step, and how fast. Then a switch to the small model
    /// restarts the server. `cargo test --lib llama::tests::real_tiny -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_tiny_answers_without_thinking() {
        let tiny = &TIERS[3];
        let started = std::time::Instant::now();
        setup(tiny, claim(tiny).unwrap(), |p: Progress| if p.done == p.total { println!("{} {} bytes", p.stage, p.total) }).await.unwrap();
        println!("set up in {:?}", started.elapsed());
        let plan = Plan { tier: tiny, gpu: None };
        let port = ensure_plan(&plan).await.unwrap();
        for question in ["In one short sentence: what is the capital of Canada?", "What is 17 times 3? Answer with just the number."] {
            let body = serde_json::json!({ "messages": [{ "role": "user", "content": question }], "max_tokens": 200 });
            let asked = std::time::Instant::now();
            let reply: serde_json::Value = local_client().post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body).send().await.unwrap().json().await.unwrap();
            let secs = asked.elapsed().as_secs_f64();
            let message = &reply["choices"][0]["message"];
            let text = message["content"].as_str().unwrap_or("");
            let thought = message["reasoning_content"].as_str().unwrap_or("");
            let tokens = reply["usage"]["completion_tokens"].as_f64().unwrap_or(0.0);
            println!("{secs:.1}s, {tokens} tokens ({:.1} tok/s), thinking {} chars: {text:?}", tokens / secs, thought.len());
            assert!(!text.is_empty() && !text.contains("<think>") && thought.trim().is_empty(), "{reply}");
        }
        let small = Plan { tier: &TIERS[2], gpu: None };
        ensure_plan(&small).await.unwrap();
        assert_eq!(server().lock().await.as_ref().map(|r| r.tier), Some("small"), "switching models restarts the server");
        stop().await;
    }

    #[test]
    fn a_zip_unpacks_with_windows_tar() {
        let dir = temp_dir("zip");
        std::fs::write(dir.join("llama-server.exe"), b"not really").unwrap();
        let zip = dir.join("server.zip");
        let made = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("Compress-Archive -Path '{}' -DestinationPath '{}'", dir.join("llama-server.exe").display(), zip.display())])
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("out");
        extract(&zip, &out).unwrap();
        assert_eq!(std::fs::read(out.join("llama-server.exe")).unwrap(), b"not really");
    }

    fn gpu(name: &str, vram_gib: u64) -> Gpu {
        Gpu { name: name.to_string(), vram: vram_gib * GIB }
    }

    /// What Windows reports for a "16 GB" PC: a little under, since some is reserved.
    fn ram(nominal_gb: u64) -> u64 {
        nominal_gb * GIB - GIB * 3 / 10
    }

    #[test]
    fn the_model_leaves_most_of_the_memory_to_everything_else() {
        // Seen on Moss's 32 GB PC: the 30B (18.6 GB) took it to 31 GB used.
        assert_eq!(plan(ram(64), &[]).map(|p| p.tier.id), Some("large"));
        assert_eq!(plan(ram(48), &[]).map(|p| p.tier.id), Some("large"));
        assert_eq!(plan(ram(32), &[]).map(|p| p.tier.id), Some("medium"));
        assert_eq!(plan(ram(16), &[]).map(|p| p.tier.id), Some("small"));
        assert_eq!(plan(ram(8), &[]).map(|p| p.tier.id), Some("small"));
        assert_eq!(plan(ram(4), &[]).map(|p| p.tier.id), Some("tiny"));
        assert_eq!(plan(ram(2), &[]), None);
        for tier in &TIERS {
            let needs = (tier.size as f64 / RAM_SHARE / GIB as f64).ceil() as u64;
            assert!(plan(needs * GIB, &[]).is_some(), "{} at {needs} GiB", tier.id);
        }
    }

    #[test]
    fn integrated_graphics_are_ignored() {
        let p = plan(ram(32), &[gpu("Intel(R) UHD Graphics", 1)]).unwrap();
        assert_eq!((p.tier.id, p.gpu), ("medium", None));
    }

    #[test]
    fn a_card_that_holds_the_model_runs_it() {
        let p = plan(ram(16), &[gpu("NVIDIA GeForce RTX 4060", 8), gpu("NVIDIA GeForce RTX 3090", 24)]).unwrap();
        assert_eq!((p.tier.id, p.gpu.as_deref()), ("large", Some("NVIDIA GeForce RTX 3090")));
        let p = plan(ram(8), &[gpu("NVIDIA GeForce RTX 4060", 8)]).unwrap();
        assert_eq!((p.tier.id, p.gpu.as_deref()), ("small", Some("NVIDIA GeForce RTX 4060")));
    }

    #[test]
    fn a_big_card_helps_even_with_little_ram() {
        let p = plan(ram(8), &[gpu("AMD Radeon RX 7900 XTX", 24)]).unwrap();
        assert_eq!(p.tier.id, "large");
    }

    #[test]
    fn this_pc_reports_its_memory() {
        let (ram, gpus) = hardware();
        assert!(ram > 4 * GIB, "{ram}");
        assert!(gpus.iter().all(|g| !g.name.is_empty()), "{gpus:?}");
    }
}
