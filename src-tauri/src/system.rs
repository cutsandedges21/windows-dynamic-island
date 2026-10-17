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
use windows::Win32::System::Power::{CallNtPowerInformation, GetSystemPowerStatus, SystemBatteryState, SYSTEM_BATTERY_STATE, SYSTEM_POWER_STATUS};
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

#[cfg(test)]
mod tests {
    use super::time_to_full;

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
}
