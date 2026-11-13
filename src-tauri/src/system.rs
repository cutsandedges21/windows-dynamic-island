// Power (battery, AC, saver) and load: CPU from GetSystemTimes deltas, memory
// from GlobalMemoryStatusEx, GPU from the "GPU Engine" performance counters,
// and the busiest process when asked (only on spikes, it costs a scan). The
// apps using the most of one of them (sys_top) are read only while that list
// is open on the card.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::Power::{CallNtPowerInformation, GetSystemPowerStatus, SystemBatteryState, SYSTEM_BATTERY_STATE, SYSTEM_POWER_STATUS};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2};
use windows::Win32::System::SystemInformation::{GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO};
use windows::Win32::System::Threading::{GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::procs::ProcRow;

use crate::overlay::LABEL as ISLAND;

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    has_battery: bool,
    percent: Option<f64>,
    ac: bool,
    charging: bool,
    saver: bool,
    seconds_left: Option<f64>,
    /// While it charges: how long until it is full.
    seconds_to_full: Option<f64>,
}

pub fn power() -> PowerState {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return PowerState::default();
    }
    let no_battery = s.BatteryFlag & 128 != 0 || s.BatteryFlag == 255;
    let percent = (s.BatteryLifePercent <= 100 && !no_battery).then_some(s.BatteryLifePercent as f64);
    let charging = s.BatteryFlag & 8 != 0;
    PowerState {
        has_battery: !no_battery,
        percent,
        ac: s.ACLineStatus == 1,
        charging,
        saver: s.SystemStatusFlag == 1,
        seconds_left: (s.BatteryLifeTime != u32::MAX && s.ACLineStatus != 1).then_some(s.BatteryLifeTime as f64),
        seconds_to_full: if charging { seconds_to_full(percent) } else { forget_rate() },
    }
}

/// The charge rate, smoothed: it swings from one reading to the next.
static RATE: Mutex<Option<f64>> = Mutex::new(None);

fn forget_rate() -> Option<f64> {
    *RATE.lock().unwrap() = None;
    None
}

/// How long until the battery is full, from what Windows says comes in (mW) and what is
/// stored (mWh). Windows doesn't say how much a full battery holds today (only when it was
/// new), so the percentage gives it: a worn battery isn't counted as its new size.
fn seconds_to_full(percent: Option<f64>) -> Option<f64> {
    let mut b = SYSTEM_BATTERY_STATE::default();
    let size = std::mem::size_of::<SYSTEM_BATTERY_STATE>() as u32;
    let ok = unsafe { CallNtPowerInformation(SystemBatteryState, None, 0, Some(&mut b as *mut _ as *mut _), size) }.is_ok();
    // A negative rate is a discharge; 0x80000000 is "unknown".
    let fresh = b.Rate as i32 as f64;
    if !ok || !b.Charging || fresh <= 0.0 {
        return forget_rate();
    }
    let rate = {
        let mut r = RATE.lock().unwrap();
        let smooth = r.map_or(fresh, |old| old * 0.7 + fresh * 0.3);
        *r = Some(smooth);
        smooth
    };
    time_to_full(percent?, b.RemainingCapacity as f64, rate)
}

/// What is missing over the rate it comes in at, to the minute; None for what can't be right.
fn time_to_full(percent: f64, stored_mwh: f64, rate_mw: f64) -> Option<f64> {
    if !(1.0..100.0).contains(&percent) || stored_mwh <= 0.0 || rate_mw <= 0.0 {
        return None;
    }
    let missing = stored_mwh * (100.0 - percent) / percent;
    let secs = missing / rate_mw * 3600.0;
    (secs.is_finite() && (60.0..=24.0 * 3600.0).contains(&secs)).then(|| (secs / 60.0).round() * 60.0)
}

pub fn emit_power(app: &AppHandle) {
    let _ = app.emit_to(ISLAND, "power", power());
}

/// Battery changes slowly; WM_POWERBROADCAST (msgwin) covers plug events at once.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = PowerState::default();
        loop {
            let p = power();
            if p != last {
                let _ = app.emit_to(ISLAND, "power", p.clone());
                last = p;
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

#[tauri::command]
pub fn power_state() -> PowerState {
    power()
}

// ------------------------------------------------------------------ energy saver

/// The WNF state that Settings › Energy saver publishes to switch Energy saver on or off (found in
/// SettingsHandlers_OneCore_BatterySaver.dll on build 26200, 2026-11-12: its toggle publishes a u32
/// here, 1 when it was off and 2 when it was on; it read 2 with Energy saver off). Windows has no
/// documented call for this; raising powercfg's ESBATTTHRESHOLD to 100 did not turn it on (2026-11-09).
/// Settings runs without admin rights and so does this.
const ENERGY_SAVER_OVERRIDE: u64 = 0x41C6_013D_A3BC_3075;

#[link(name = "ntdll", kind = "raw-dylib")]
extern "system" {
    fn RtlPublishWnfStateData(
        state_name: u64,
        type_id: *const std::ffi::c_void,
        buffer: *const std::ffi::c_void,
        length: u32,
        explicit_scope: *const std::ffi::c_void,
    ) -> i32;
}

/// What is published for on or off.
fn override_value(on: bool) -> u32 {
    if on {
        1
    } else {
        2
    }
}

/// Whether Windows did what was asked: `now` is Energy saver as Windows reports it after waiting.
fn saver_outcome(want: bool, now: bool, ac: bool) -> Result<bool, String> {
    if now == want {
        Ok(now)
    } else if want && ac {
        Err("Energy saver only turns on while unplugged".into())
    } else {
        Err(format!("Windows kept Energy saver {}", if now { "on" } else { "off" }))
    }
}

// Energy saver's "turns on at" battery level (powercfg ESBATTTHRESHOLD), AC and DC: at 100 it is on
// now, the way Settings' "Always" is; Island puts the user's own levels back to turn it off.
const SUB_ENERGYSAVER: windows::core::GUID = windows::core::GUID::from_u128(0xde830923_a562_41af_a086_e3a2c6bad2da);
const ESBATTTHRESHOLD: windows::core::GUID = windows::core::GUID::from_u128(0xe69653ca_cf7f_4f05_aa73_cb833fa90ad4);
/// Windows' own levels, if Island never saw the user's: off plugged in, 20% on battery.
const THRESHOLD_DEFAULT: (u32, u32) = (0, 20);

#[link(name = "powrprof", kind = "raw-dylib")]
extern "system" {
    fn PowerGetActiveScheme(root: isize, scheme: *mut *mut windows::core::GUID) -> u32;
    fn PowerReadACValueIndex(root: isize, scheme: *const windows::core::GUID, sub: *const windows::core::GUID, setting: *const windows::core::GUID, value: *mut u32) -> u32;
    fn PowerReadDCValueIndex(root: isize, scheme: *const windows::core::GUID, sub: *const windows::core::GUID, setting: *const windows::core::GUID, value: *mut u32) -> u32;
    fn PowerWriteACValueIndex(root: isize, scheme: *const windows::core::GUID, sub: *const windows::core::GUID, setting: *const windows::core::GUID, value: u32) -> u32;
    fn PowerWriteDCValueIndex(root: isize, scheme: *const windows::core::GUID, sub: *const windows::core::GUID, setting: *const windows::core::GUID, value: u32) -> u32;
    fn PowerSetActiveScheme(root: isize, scheme: *const windows::core::GUID) -> u32;
}

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    #[link_name = "LocalFree"]
    fn local_free(mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

/// Where the user's own levels wait while Island holds Energy saver on.
fn threshold_file() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("com.moss.island").join("energy-saver-levels.txt"))
}

/// "ac dc" as saved; None for anything else.
fn parse_levels(text: &str) -> Option<(u32, u32)> {
    let mut it = text.split_whitespace().map(|x| x.parse::<u32>().ok());
    match (it.next().flatten(), it.next().flatten(), it.next()) {
        (Some(ac), Some(dc), None) if ac <= 100 && dc <= 100 => Some((ac, dc)),
        _ => None,
    }
}

/// The levels to go back to: the saved ones, never 100 (that would leave it on).
fn levels_back(saved: Option<(u32, u32)>) -> (u32, u32) {
    match saved {
        Some((ac, dc)) if ac < 100 && dc < 100 => (ac, dc),
        _ => THRESHOLD_DEFAULT,
    }
}

/// Raises the levels to 100 (on) or puts the user's back (off), on the active power plan.
fn threshold_set(on: bool) -> Result<(), String> {
    unsafe {
        let mut p: *mut windows::core::GUID = std::ptr::null_mut();
        if PowerGetActiveScheme(0, &mut p) != 0 || p.is_null() {
            return Err("Windows didn't say which power plan is on".into());
        }
        let scheme = *p;
        local_free(p as *mut _);
        let (mut ac, mut dc) = (0u32, 0u32);
        PowerReadACValueIndex(0, &scheme, &SUB_ENERGYSAVER, &ESBATTTHRESHOLD, &mut ac);
        PowerReadDCValueIndex(0, &scheme, &SUB_ENERGYSAVER, &ESBATTTHRESHOLD, &mut dc);
        let file = threshold_file();
        let (new_ac, new_dc) = if on {
            if ac < 100 || dc < 100 {
                if let Some(f) = &file {
                    let _ = std::fs::create_dir_all(f.parent().unwrap());
                    let _ = std::fs::write(f, format!("{ac} {dc}"));
                }
            }
            (100, 100)
        } else {
            let saved = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| parse_levels(&t));
            // Only undo what Island did: levels the user set themselves (not 100) stay.
            if ac < 100 && dc < 100 {
                return Ok(());
            }
            levels_back(saved)
        };
        let a = PowerWriteACValueIndex(0, &scheme, &SUB_ENERGYSAVER, &ESBATTTHRESHOLD, new_ac);
        let d = PowerWriteDCValueIndex(0, &scheme, &SUB_ENERGYSAVER, &ESBATTTHRESHOLD, new_dc);
        let s = PowerSetActiveScheme(0, &scheme);
        crate::log::line(&format!("energy saver: levels {ac}/{dc} -> {new_ac}/{new_dc} (write {a}/{d}, apply {s})"));
        if a != 0 || d != 0 || s != 0 {
            return Err("Windows didn't let Island change Energy saver".into());
        }
        if !on {
            if let Some(f) = &file {
                let _ = std::fs::remove_file(f);
            }
        }
        Ok(())
    }
}

/// Waits up to `ms` for Windows to report Energy saver as `on`; the last state seen.
fn saver_wait(on: bool, ms: u64) -> PowerState {
    let until = Instant::now() + Duration::from_millis(ms);
    loop {
        let p = power();
        if p.saver == on || Instant::now() >= until {
            return p;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn saver_set(on: bool) -> Result<bool, String> {
    let value = override_value(on);
    let status = unsafe {
        RtlPublishWnfStateData(ENERGY_SAVER_OVERRIDE, std::ptr::null(), &value as *const u32 as *const _, 4, std::ptr::null())
    };
    if status < 0 {
        crate::log::line(&format!("energy saver: publish failed 0x{:08X}", status as u32));
    }
    // Off: Island's raised levels go back either way, or Energy saver would come straight back on.
    if !on {
        threshold_set(false)?;
    }
    let p = saver_wait(on, 800);
    if p.saver == on {
        return Ok(on);
    }
    // The Settings signal didn't do it (2026-11-12 on build 26200: it didn't): the levels do.
    if on {
        threshold_set(true)?;
    }
    let p = saver_wait(on, 3000);
    saver_outcome(on, p.saver, p.ac)
}

/// Switches Energy saver; the state Windows reports afterwards, or why it didn't switch.
#[tauri::command]
pub async fn power_saver_set(on: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || saver_set(on)).await.map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ load

fn ft(f: FILETIME) -> u64 {
    ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
}

struct Gpu {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}
// PDH handles are plain process-wide handles; we only touch them under the mutex.
unsafe impl Send for Gpu {}

#[derive(Default)]
struct Load {
    cpu: Option<(u64, u64, u64)>,
    gpu: Option<Gpu>,
    gpu_failed: bool,
    /// The last GPU reading split per process (the counter's instances name their pid).
    gpu_pids: HashMap<u32, f64>,
    procs: HashMap<u32, u64>,
    procs_at: Option<Instant>,
}

static LOAD: Mutex<Option<Load>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcess {
    name: String,
    cpu: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysSample {
    cpu: f64,
    mem_used: f64,
    mem_total: f64,
    gpu: Option<f64>,
    top: Option<TopProcess>,
}

fn cpu_now(load: &mut Load) -> f64 {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
        return 0.0;
    }
    let now = (ft(idle), ft(kernel), ft(user));
    let pct = match load.cpu {
        Some((i0, k0, u0)) => {
            let di = now.0.saturating_sub(i0) as f64;
            let total = (now.1.saturating_sub(k0) + now.2.saturating_sub(u0)) as f64;
            if total > 0.0 { ((total - di) / total * 100.0).clamp(0.0, 100.0) } else { 0.0 }
        }
        None => 0.0,
    };
    load.cpu = Some(now);
    pct
}

fn gpu_now(load: &mut Load) -> Option<f64> {
    if load.gpu_failed {
        return None;
    }
    if load.gpu.is_none() {
        let mut query = PDH_HQUERY::default();
        let mut counter = PDH_HCOUNTER::default();
        let ok = unsafe {
            PdhOpenQueryW(None, 0, &mut query) == 0
                && PdhAddEnglishCounterW(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"), 0, &mut counter) == 0
        };
        if !ok {
            load.gpu_failed = true;
            return None;
        }
        unsafe {
            PdhCollectQueryData(query);
        }
        load.gpu = Some(Gpu { query, counter });
        return None;
    }
    let g = load.gpu.as_ref()?;
    if unsafe { PdhCollectQueryData(g.query) } != 0 {
        return None;
    }
    let items = counter_items(g.counter)?;
    // Instances read "pid_1234_luid_..._engtype_3D": the same numbers per process, for the list of what uses the most.
    let mut per: HashMap<u32, f64> = HashMap::new();
    for (name, v) in &items {
        if let Some(pid) = instance_pid(name) {
            *per.entry(pid).or_default() += v;
        }
    }
    load.gpu_pids = per;
    Some(items.iter().map(|(_, v)| v).sum::<f64>().clamp(0.0, 100.0))
}

/// Every instance of a wildcard counter: its name and value.
fn counter_items(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
    unsafe {
        let mut size = 0u32;
        let mut count = 0u32;
        let _ = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if size == 0 {
            return Some(Vec::new());
        }
        // u64s so the items (which hold pointers and doubles) are aligned.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(items, count as usize);
        Some(
            slice
                .iter()
                .filter_map(|it| {
                    let v = it.FmtValue.Anonymous.doubleValue;
                    v.is_finite().then(|| (it.szName.to_string().unwrap_or_default(), v))
                })
                .collect(),
        )
    }
}

fn instance_pid(name: &str) -> Option<u32> {
    name.strip_prefix("pid_")?.split('_').next()?.parse().ok()
}

fn cores() -> f64 {
    let mut si = SYSTEM_INFO::default();
    unsafe { GetSystemInfo(&mut si) };
    si.dwNumberOfProcessors.max(1) as f64
}

/// CPU time used so far (kernel + user, 100 ns ticks) by every process we may read.
fn proc_times(rows: &[ProcRow]) -> HashMap<u32, u64> {
    let mut times: HashMap<u32, u64> = HashMap::with_capacity(rows.len());
    for r in rows {
        let pid = r.0;
        if pid <= 4 {
            continue;
        }
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { continue };
            let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok() {
                times.insert(pid, ft(k) + ft(u));
            }
            let _ = CloseHandle(h);
        }
    }
    times
}

fn top_process(load: &mut Load) -> Option<TopProcess> {
    let rows = crate::procs::snapshot(false);
    let now = Instant::now();
    let times = proc_times(&rows);
    let prev = std::mem::replace(&mut load.procs, times);
    let elapsed = load.procs_at.replace(now).map(|t| now.duration_since(t).as_secs_f64())?;
    if elapsed <= 0.05 {
        return None;
    }
    let budget = elapsed * 10_000_000.0 * cores();
    let names: HashMap<u32, &str> = rows.iter().map(|r| (r.0, r.2.as_str())).collect();
    load.procs
        .iter()
        .filter_map(|(pid, t)| prev.get(pid).map(|p0| (*pid, t.saturating_sub(*p0) as f64 / budget * 100.0)))
        .filter(|(pid, _)| names.get(pid).map(|n| *n != "system idle process").unwrap_or(false))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(pid, cpu)| TopProcess { name: names.get(&pid).unwrap_or(&"?").trim_end_matches(".exe").to_string(), cpu: cpu.clamp(0.0, 100.0) })
}

#[tauri::command]
pub async fn sys_sample(with_top: bool) -> SysSample {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = LOAD.lock().unwrap();
        let load = guard.get_or_insert_with(Load::default);
        let cpu = cpu_now(load);
        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let _ = unsafe { GlobalMemoryStatusEx(&mut mem) };
        let gpu = gpu_now(load);
        let top = if with_top { top_process(load) } else { None };
        SysSample {
            cpu,
            mem_used: (mem.ullTotalPhys - mem.ullAvailPhys) as f64,
            mem_total: mem.ullTotalPhys as f64,
            gpu,
            top,
        }
    })
    .await
    .unwrap_or(SysSample { cpu: 0.0, mem_used: 0.0, mem_total: 0.0, gpu: None, top: None })
}

// ------------------------------------------------------------------ what uses the most

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUse {
    /// The app's own name (its file description, as Task Manager shows it), else its exe name.
    name: String,
    exe: String,
    /// Percent of the whole CPU or GPU, or bytes of RAM.
    value: f64,
    /// Processes added up under this app.
    count: u32,
}

#[derive(Default)]
struct Top {
    cpu: HashMap<u32, u64>,
    cpu_at: Option<Instant>,
    /// exe name -> app name, read once per exe.
    names: HashMap<String, String>,
}

static TOP: Mutex<Option<Top>> = Mutex::new(None);

/// A CPU reading older than this is too stale to compare with: take two readings a moment apart.
const CPU_STALE: Duration = Duration::from_secs(6);
const CPU_GAP: Duration = Duration::from_millis(500);

/// Each process's share of the whole CPU since the last look.
fn cpu_by_pid(top: &mut Top, rows: &[ProcRow]) -> HashMap<u32, f64> {
    if !top.cpu_at.is_some_and(|t| t.elapsed() < CPU_STALE) {
        top.cpu = proc_times(rows);
        top.cpu_at = Some(Instant::now());
        std::thread::sleep(CPU_GAP);
    }
    let now = Instant::now();
    let times = proc_times(rows);
    let elapsed = top.cpu_at.replace(now).map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0);
    let prev = std::mem::replace(&mut top.cpu, times);
    if elapsed <= 0.05 {
        return HashMap::new();
    }
    let budget = elapsed * 10_000_000.0 * cores();
    top.cpu
        .iter()
        .filter_map(|(pid, t)| prev.get(pid).map(|p0| (*pid, (t.saturating_sub(*p0) as f64 / budget * 100.0).clamp(0.0, 100.0))))
        .collect()
}

/// RAM a process holds for itself (private working set: Task Manager's Memory column).
fn private_bytes(pid: u32) -> Option<f64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut c = PROCESS_MEMORY_COUNTERS_EX2 { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32, ..Default::default() };
        let ok = GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb).is_ok();
        let _ = CloseHandle(h);
        ok.then_some(c.PrivateWorkingSetSize as f64)
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The FileDescription in an exe's version info ("Google Chrome" for chrome.exe).
fn file_description(path: &str) -> Option<String> {
    unsafe {
        let p = wide(path);
        let size = GetFileVersionInfoSizeW(PCWSTR(p.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(p.as_ptr()), None, size, buf.as_mut_ptr() as *mut _).ok()?;
        let block = buf.as_ptr() as *const std::ffi::c_void;
        let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // The languages the file says it has, then the usual English ones.
        let mut langs: Vec<String> = Vec::new();
        if VerQueryValueW(block, w!("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool() && !ptr.is_null() {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            langs.extend(pairs.as_chunks::<2>().0.iter().map(|p| format!("{:04x}{:04x}", p[0], p[1])));
        }
        langs.extend(["040904b0", "040904e4", "000004b0"].map(String::from));
        for lang in langs {
            let key = wide(&format!("\\StringFileInfo\\{lang}\\FileDescription"));
            if VerQueryValueW(block, PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() && len > 1 {
                let text = std::slice::from_raw_parts(ptr as *const u16, len as usize);
                let end = text.iter().position(|c| *c == 0).unwrap_or(text.len());
                let name = String::from_utf16_lossy(&text[..end]).trim().to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }
}

/// "chrome.exe" -> "Chrome", "memory compression" -> "Memory Compression".
fn plain_name(exe: &str) -> String {
    exe.trim_end_matches(".exe")
        .split(' ')
        .map(|word| {
            let mut c = word.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn app_name(top: &mut Top, pid: u32, exe: &str) -> String {
    if let Some(n) = top.names.get(exe) {
        return n.clone();
    }
    // A process we may not look into keeps its exe name (and may be read next time).
    let Some(path) = crate::game::exe_path(pid) else { return plain_name(exe) };
    let name = file_description(&path).unwrap_or_else(|| plain_name(exe));
    top.names.insert(exe.to_string(), name.clone());
    name
}

/// Adds processes up per exe (Chrome's many processes are one app), biggest first.
fn by_app(top: &mut Top, rows: &[ProcRow], per_pid: HashMap<u32, f64>, limit: usize) -> Vec<AppUse> {
    let exe: HashMap<u32, &str> = rows.iter().map(|r| (r.0, r.2.as_str())).collect();
    // exe -> (total, processes, one of its pids)
    let mut apps: HashMap<&str, (f64, u32, u32)> = HashMap::new();
    for (pid, v) in per_pid {
        let Some(name) = exe.get(&pid) else { continue };
        let e = apps.entry(*name).or_insert((0.0, 0, pid));
        e.0 += v;
        e.1 += 1;
    }
    let mut list: Vec<(&str, (f64, u32, u32))> = apps.into_iter().filter(|(_, a)| a.0 > 0.0).collect();
    list.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0));
    list.truncate(limit);
    list.into_iter()
        .map(|(exe, (value, count, pid))| AppUse { name: app_name(top, pid, exe), exe: exe.to_string(), value, count })
        .collect()
}

/// The apps using the most CPU, RAM ("mem") or GPU right now.
#[tauri::command]
pub async fn sys_top(kind: String, limit: usize) -> Vec<AppUse> {
    tauri::async_runtime::spawn_blocking(move || {
        let rows = crate::procs::snapshot(false);
        let mut guard = TOP.lock().unwrap();
        let top = guard.get_or_insert_with(Top::default);
        let per_pid: HashMap<u32, f64> = match kind.as_str() {
            "cpu" => cpu_by_pid(top, &rows),
            "mem" => rows.iter().filter(|r| r.0 > 4).filter_map(|r| private_bytes(r.0).map(|b| (r.0, b))).collect(),
            // sys_sample keeps the GPU counter going; its last reading is the freshest there is.
            "gpu" => LOAD.lock().unwrap().as_ref().map(|l| l.gpu_pids.clone()).unwrap_or_default(),
            _ => HashMap::new(),
        };
        by_app(top, &rows, per_pid, limit)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{by_app, instance_pid, override_value, plain_name, saver_outcome, time_to_full, Top};
    use crate::procs::ProcRow;
    use std::collections::HashMap;

    #[test]
    fn energy_saver_is_published_as_settings_does_it() {
        assert_eq!(override_value(true), 1);
        assert_eq!(override_value(false), 2);
    }

    #[test]
    fn energy_saver_says_why_it_did_not_switch() {
        assert_eq!(saver_outcome(true, true, true), Ok(true));
        assert_eq!(saver_outcome(false, false, false), Ok(false));
        assert_eq!(saver_outcome(true, false, true), Err("Energy saver only turns on while unplugged".into()));
        assert_eq!(saver_outcome(true, false, false), Err("Windows kept Energy saver off".into()));
        assert_eq!(saver_outcome(false, true, false), Err("Windows kept Energy saver on".into()));
    }

    /// Really switches Energy saver on this PC and back: run by hand only.
    #[test]
    #[ignore]
    fn switches_energy_saver_for_real() {
        let was = super::power().saver;
        assert_eq!(super::saver_set(!was), Ok(!was));
        assert_eq!(super::saver_set(was), Ok(was));
    }

    #[test]
    fn full_in_is_what_is_missing_over_the_rate() {
        // Half full with 25 Wh stored (so 50 Wh when full), 25 W coming in: an hour.
        assert_eq!(time_to_full(50.0, 25_000.0, 25_000.0), Some(3600.0));
        // To the minute.
        assert_eq!(time_to_full(80.0, 40_000.0, 21_000.0), Some(1740.0));
        // Full, empty readings, no charge coming in, or a day and more: nothing to say.
        assert_eq!(time_to_full(100.0, 50_000.0, 20_000.0), None);
        assert_eq!(time_to_full(0.0, 0.0, 20_000.0), None);
        assert_eq!(time_to_full(50.0, 25_000.0, 0.0), None);
        assert_eq!(time_to_full(1.0, 500.0, 1.0), None);
    }

    #[test]
    fn gpu_counter_instances_name_their_process() {
        assert_eq!(instance_pid("pid_1234_luid_0x00000000_0x0000D1E8_phys_0_eng_0_engtype_3D"), Some(1234));
        assert_eq!(instance_pid("_Total"), None);
        assert_eq!(instance_pid("pid_x_luid"), None);
    }

    #[test]
    fn an_exe_without_a_description_reads_as_words() {
        assert_eq!(plain_name("chrome.exe"), "Chrome");
        assert_eq!(plain_name("memory compression"), "Memory Compression");
    }

    #[test]
    fn processes_add_up_per_app_biggest_first() {
        // Pids that can't exist, so the names come from the exe (nothing to look into).
        let rows = vec![
            ProcRow(4_000_001, 0, "chrome.exe".into(), None),
            ProcRow(4_000_002, 0, "chrome.exe".into(), None),
            ProcRow(4_000_003, 0, "code.exe".into(), None),
            ProcRow(4_000_004, 0, "idle.exe".into(), None),
        ];
        let per_pid: HashMap<u32, f64> = [(4_000_001, 10.0), (4_000_002, 5.0), (4_000_003, 12.0), (4_000_004, 0.0), (4_000_099, 50.0)].into();
        let mut top = Top::default();
        let list = by_app(&mut top, &rows, per_pid.clone(), 5);
        let got: Vec<(&str, &str, f64, u32)> = list.iter().map(|a| (a.name.as_str(), a.exe.as_str(), a.value, a.count)).collect();
        // A pid no longer in the snapshot and an app using nothing are left out.
        assert_eq!(got, vec![("Chrome", "chrome.exe", 15.0, 2), ("Code", "code.exe", 12.0, 1)]);
        assert_eq!(by_app(&mut top, &rows, per_pid, 1).len(), 1);
    }
}

#[cfg(test)]
mod energy_saver_levels {
    use super::*;

    #[test]
    fn the_users_levels_come_back_never_100() {
        assert_eq!(parse_levels("0 20"), Some((0, 20)));
        assert_eq!(parse_levels(" 5 30
"), Some((5, 30)));
        assert_eq!(parse_levels("0"), None);
        assert_eq!(parse_levels("0 20 1"), None);
        assert_eq!(parse_levels("0 101"), None);
        assert_eq!(levels_back(Some((0, 30))), (0, 30));
        assert_eq!(levels_back(Some((100, 100))), THRESHOLD_DEFAULT);
        assert_eq!(levels_back(None), (0, 20));
    }
}
