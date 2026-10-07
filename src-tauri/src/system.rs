// Power (battery, AC, saver) and load: CPU from GetSystemTimes deltas, memory
// from GlobalMemoryStatusEx, GPU from the "GPU Engine" performance counters,
// and the busiest process when asked (only on spikes, it costs a scan).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::{GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO};
use windows::Win32::System::Threading::{GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

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
}

pub fn power() -> PowerState {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return PowerState::default();
    }
    let no_battery = s.BatteryFlag & 128 != 0 || s.BatteryFlag == 255;
    PowerState {
        has_battery: !no_battery,
        percent: (s.BatteryLifePercent <= 100 && !no_battery).then_some(s.BatteryLifePercent as f64),
        ac: s.ACLineStatus == 1,
        charging: s.BatteryFlag & 8 != 0,
        saver: s.SystemStatusFlag == 1,
        seconds_left: (s.BatteryLifeTime != u32::MAX && s.ACLineStatus != 1).then_some(s.BatteryLifeTime as f64),
    }
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
    unsafe {
        if PdhCollectQueryData(g.query) != 0 {
            return None;
        }
        let mut size = 0u32;
        let mut count = 0u32;
        let _ = PdhGetFormattedCounterArrayW(g.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if size == 0 {
            return Some(0.0);
        }
        let mut buf = vec![0u8; size as usize];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(g.counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(items, count as usize);
        let total: f64 = slice.iter().map(|it| it.FmtValue.Anonymous.doubleValue).filter(|v| v.is_finite()).sum();
        Some(total.clamp(0.0, 100.0))
    }
}

fn cores() -> f64 {
    let mut si = SYSTEM_INFO::default();
    unsafe { GetSystemInfo(&mut si) };
    si.dwNumberOfProcessors.max(1) as f64
}

fn top_process(load: &mut Load) -> Option<TopProcess> {
    let rows = crate::procs::snapshot(false);
    let now = Instant::now();
    let mut times: HashMap<u32, u64> = HashMap::with_capacity(rows.len());
    for r in &rows {
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
