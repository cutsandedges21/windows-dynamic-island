// Battery, CPU, memory and GPU on a Mac, in the shapes system.rs gives on Windows: the battery from
// IOKit's power sources, CPU and memory from the Mach host statistics, the GPU from the graphics
// driver's own counters (what Activity Monitor shows), and per-app use from each process's task info.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::mac::cf::{self, CFTypeRef};
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
    seconds_to_full: Option<f64>,
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
    fn IOPSCopyPowerSourcesList(blob: CFTypeRef) -> CFTypeRef;
    fn IOPSGetPowerSourceDescription(blob: CFTypeRef, ps: CFTypeRef) -> CFTypeRef;
    fn IOPSGetProvidingPowerSourceType(blob: CFTypeRef) -> CFTypeRef;
    fn IOServiceMatching(name: *const i8) -> CFTypeRef;
    fn IOServiceGetMatchingServices(main_port: u32, matching: CFTypeRef, existing: *mut u32) -> i32;
    fn IOIteratorNext(iterator: u32) -> u32;
    fn IOObjectRelease(object: u32) -> i32;
    fn IORegistryEntryCreateCFProperty(entry: u32, key: CFTypeRef, allocator: CFTypeRef, options: u32) -> CFTypeRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
}

/// Low Power Mode (macOS 12+), through NSProcessInfo.
fn low_power_mode() -> bool {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        if info.is_null() {
            return false;
        }
        let responds: bool = msg_send![info, respondsToSelector: objc2::sel!(isLowPowerModeEnabled)];
        if !responds {
            return false;
        }
        let on: bool = msg_send![info, isLowPowerModeEnabled];
        on
    }
}

/// The battery (or none), from IOKit's power sources.
pub fn power() -> PowerState {
    let saver = low_power_mode();
    unsafe {
        let blob = IOPSCopyPowerSourcesInfo();
        if blob.is_null() {
            return PowerState { ac: true, saver, ..Default::default() };
        }
        let on_ac = cf::string(IOPSGetProvidingPowerSourceType(blob)).map(|s| s == "AC Power").unwrap_or(true);
        let list = IOPSCopyPowerSourcesList(blob);
        let mut state = PowerState { ac: on_ac, saver, ..Default::default() };
        if !list.is_null() {
            for i in 0..CFArrayGetCount(list) {
                let d = IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, i));
                let key = |k: &str| {
                    let s = cf::cfstr(k);
                    cf::get(d, s.0)
                };
                if cf::string(key("Type")).as_deref() != Some("InternalBattery") || cf::int(key("Is Present")) == Some(0) {
                    continue;
                }
                let current = cf::int(key("Current Capacity")).unwrap_or(0) as f64;
                let max = cf::int(key("Max Capacity")).unwrap_or(100).max(1) as f64;
                let charging = cf::int(key("Is Charging")) == Some(1);
                let on_ac = cf::string(key("Power Source State")).map(|s| s == "AC Power").unwrap_or(on_ac);
                // Minutes, -1 while macOS is still working it out.
                let to_empty = cf::int(key("Time to Empty")).filter(|m| *m > 0 && !on_ac);
                let to_full = cf::int(key("Time to Full Charge")).filter(|m| *m > 0 && charging);
                state = PowerState {
                    has_battery: true,
                    percent: Some((current / max * 100.0).round().clamp(0.0, 100.0)),
                    ac: on_ac,
                    charging,
                    saver,
                    seconds_left: to_empty.map(|m| m as f64 * 60.0),
                    seconds_to_full: to_full.map(|m| m as f64 * 60.0),
                };
                break;
            }
            cf::CFRelease(list);
        }
        cf::CFRelease(blob);
        state
    }
}

pub fn emit_power(app: &AppHandle) {
    let _ = app.emit_to(ISLAND, "power", power());
}

/// A Mac has no message for plugging in that reaches Island without a run loop of its own, so the
/// battery is read every 2 s (cheap: a few dictionary reads), which catches a plug at once.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = PowerState::default();
        loop {
            let p = power();
            if p != last {
                let _ = app.emit_to(ISLAND, "power", p.clone());
                last = p;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[tauri::command]
pub fn power_state() -> PowerState {
    power()
}

/// Puts this Mac to sleep.
#[tauri::command]
pub fn power_sleep() -> bool {
    std::process::Command::new("/usr/bin/pmset").arg("sleepnow").status().map(|s| s.success()).unwrap_or(false)
}

/// Low Power Mode is switched in System Settings › Battery on a Mac; a program needs the user's
/// password for it.
#[tauri::command]
pub async fn power_saver_set(on: bool) -> Result<bool, String> {
    let _ = on;
    let _ = std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.Battery-Settings.extension").status();
    Err("Low Power Mode is switched in System Settings › Battery on a Mac".into())
}

// ------------------------------------------------------------------ CPU, memory, GPU

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

#[derive(Default)]
struct Load {
    /// (user + system + nice, idle) ticks of all cores at the last look.
    cpu: Option<(u64, u64)>,
    procs: HashMap<u32, u64>,
    procs_at: Option<Instant>,
}

static LOAD: Mutex<Option<Load>> = Mutex::new(None);

fn cpu_ticks() -> Option<(u64, u64)> {
    let mut info: libc::host_cpu_load_info = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
    #[allow(deprecated)]
    let host = unsafe { libc::mach_host_self() };
    let r = unsafe { libc::host_statistics(host, libc::HOST_CPU_LOAD_INFO, (&mut info as *mut libc::host_cpu_load_info).cast(), &mut count) };
    if r != 0 {
        return None;
    }
    let t = info.cpu_ticks;
    let busy = t[libc::CPU_STATE_USER as usize] as u64 + t[libc::CPU_STATE_SYSTEM as usize] as u64 + t[libc::CPU_STATE_NICE as usize] as u64;
    Some((busy, t[libc::CPU_STATE_IDLE as usize] as u64))
}

fn cpu_now(load: &mut Load) -> f64 {
    let Some(now) = cpu_ticks() else { return 0.0 };
    let pct = match load.cpu {
        Some((b0, i0)) => {
            let busy = now.0.saturating_sub(b0) as f64;
            let total = busy + now.1.saturating_sub(i0) as f64;
            if total > 0.0 { (busy / total * 100.0).clamp(0.0, 100.0) } else { 0.0 }
        }
        None => 0.0,
    };
    load.cpu = Some(now);
    pct
}

/// (used, total) RAM in bytes: what Activity Monitor calls Memory Used (app memory, wired and
/// compressed) over the RAM there is.
pub fn memory() -> (f64, f64) {
    let total = crate::mac::sys::total_memory() as f64;
    let mut vm: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    let mut count = libc::HOST_VM_INFO64_COUNT;
    #[allow(deprecated)]
    let host = unsafe { libc::mach_host_self() };
    let r = unsafe { libc::host_statistics64(host, libc::HOST_VM_INFO64, (&mut vm as *mut libc::vm_statistics64).cast(), &mut count) };
    if r != 0 {
        return (0.0, total);
    }
    #[allow(deprecated)]
    let page = unsafe { libc::vm_page_size } as f64;
    let app = (vm.internal_page_count as f64 - vm.purgeable_count as f64).max(0.0);
    let used = (app + vm.wire_count as f64 + vm.compressor_page_count as f64) * page;
    (used.min(total), total)
}

/// The GPU's busy share, from its driver's statistics (IOAccelerator "Device Utilization %").
pub fn gpu() -> Option<f64> {
    unsafe {
        let matching = IOServiceMatching(c"IOAccelerator".as_ptr());
        let mut iter = 0u32;
        if IOServiceGetMatchingServices(0, matching, &mut iter) != 0 {
            return None;
        }
        let key = cf::cfstr("PerformanceStatistics");
        let util = cf::cfstr("Device Utilization %");
        let mut best: Option<f64> = None;
        loop {
            let service = IOIteratorNext(iter);
            if service == 0 {
                break;
            }
            let stats = IORegistryEntryCreateCFProperty(service, key.0, std::ptr::null(), 0);
            if !stats.is_null() {
                if let Some(v) = cf::int(cf::get(stats, util.0)) {
                    best = Some(best.map_or(v as f64, |b: f64| b.max(v as f64)));
                }
                cf::CFRelease(stats);
            }
            IOObjectRelease(service);
        }
        IOObjectRelease(iter);
        best.map(|v| v.clamp(0.0, 100.0))
    }
}

/// CPU time used so far (user + system, ns) by a process we may read.
fn proc_time_ns(pid: u32) -> Option<u64> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size) };
    (got == size).then(|| to_ns(info.pti_total_user + info.pti_total_system))
}

/// Task times come in Mach ticks (nanoseconds on Intel, 1/24 µs steps on Apple chips).
fn to_ns(ticks: u64) -> u64 {
    static TIMEBASE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    let (numer, denom) = *TIMEBASE.get_or_init(|| {
        let mut tb = libc::mach_timebase_info { numer: 1, denom: 1 };
        #[allow(deprecated)]
        unsafe {
            libc::mach_timebase_info(&mut tb)
        };
        (tb.numer.max(1), tb.denom.max(1))
    });
    (ticks as u128 * numer as u128 / denom as u128) as u64
}

fn cores() -> f64 {
    std::thread::available_parallelism().map(|n| n.get() as f64).unwrap_or(1.0)
}

fn proc_times(rows: &[crate::procs::ProcRow]) -> HashMap<u32, u64> {
    rows.iter().filter(|r| r.0 > 0).filter_map(|r| proc_time_ns(r.0).map(|t| (r.0, t))).collect()
}

/// "visual studio code.app" -> "Visual Studio Code", "node" -> "Node".
pub fn plain_name(name: &str) -> String {
    name.trim_end_matches(".app")
        .split(' ')
        .map(|word| {
            let mut c = word.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn top_process(load: &mut Load) -> Option<TopProcess> {
    let rows = crate::procs::snapshot();
    let now = Instant::now();
    let times = proc_times(&rows);
    let prev = std::mem::replace(&mut load.procs, times);
    let elapsed = load.procs_at.replace(now).map(|t| now.duration_since(t).as_secs_f64())?;
    if elapsed <= 0.05 {
        return None;
    }
    let budget = elapsed * 1e9 * cores();
    let names: HashMap<u32, &str> = rows.iter().map(|r| (r.0, r.2.as_str())).collect();
    load.procs
        .iter()
        .filter_map(|(pid, t)| prev.get(pid).map(|p0| (*pid, t.saturating_sub(*p0) as f64 / budget * 100.0)))
        .filter(|(pid, _)| names.get(pid).is_some_and(|n| *n != "kernel_task"))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(pid, cpu)| TopProcess { name: plain_name(names.get(&pid).unwrap_or(&"?")), cpu: cpu.clamp(0.0, 100.0) })
}

#[tauri::command]
pub async fn sys_sample(with_top: bool) -> SysSample {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = LOAD.lock().unwrap();
        let load = guard.get_or_insert_with(Load::default);
        let cpu = cpu_now(load);
        let (mem_used, mem_total) = memory();
        let top = if with_top { top_process(load) } else { None };
        SysSample { cpu, mem_used, mem_total, gpu: gpu(), top }
    })
    .await
    .unwrap_or(SysSample { cpu: 0.0, mem_used: 0.0, mem_total: 0.0, gpu: None, top: None })
}

// ------------------------------------------------------------------ what uses the most

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUse {
    name: String,
    exe: String,
    value: f64,
    count: u32,
}

#[derive(Default)]
struct Top {
    cpu: HashMap<u32, u64>,
    cpu_at: Option<Instant>,
}

static TOP: Mutex<Option<Top>> = Mutex::new(None);

const CPU_STALE: Duration = Duration::from_secs(6);
const CPU_GAP: Duration = Duration::from_millis(500);

fn cpu_by_pid(top: &mut Top, rows: &[crate::procs::ProcRow]) -> HashMap<u32, f64> {
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
    let budget = elapsed * 1e9 * cores();
    top.cpu
        .iter()
        .filter_map(|(pid, t)| prev.get(pid).map(|p0| (*pid, (t.saturating_sub(*p0) as f64 / budget * 100.0).clamp(0.0, 100.0))))
        .collect()
}

/// The memory a process counts for (Activity Monitor's Memory column: its physical footprint).
fn footprint(pid: u32) -> Option<f64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast::<*mut c_void>()) };
    (r == 0).then_some(info.ri_phys_footprint as f64)
}

/// Adds processes up per app (an app's helpers carry its name), biggest first.
fn by_app(rows: &[crate::procs::ProcRow], per_pid: HashMap<u32, f64>, limit: usize) -> Vec<AppUse> {
    let name: HashMap<u32, &str> = rows.iter().map(|r| (r.0, r.2.as_str())).collect();
    let mut apps: HashMap<&str, (f64, u32)> = HashMap::new();
    for (pid, v) in per_pid {
        let Some(n) = name.get(&pid) else { continue };
        if *n == "kernel_task" {
            continue;
        }
        let e = apps.entry(*n).or_insert((0.0, 0));
        e.0 += v;
        e.1 += 1;
    }
    let mut list: Vec<(&str, (f64, u32))> = apps.into_iter().filter(|(_, a)| a.0 > 0.0).collect();
    list.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0));
    list.truncate(limit);
    list.into_iter().map(|(exe, (value, count))| AppUse { name: plain_name(exe), exe: exe.to_string(), value, count }).collect()
}

/// The apps using the most CPU or RAM ("mem") right now. A Mac doesn't say which app uses the GPU.
#[tauri::command]
pub async fn sys_top(kind: String, limit: usize) -> Vec<AppUse> {
    tauri::async_runtime::spawn_blocking(move || {
        let rows = crate::procs::snapshot();
        let per_pid: HashMap<u32, f64> = match kind.as_str() {
            "cpu" => {
                let mut guard = TOP.lock().unwrap();
                let top = guard.get_or_insert_with(Top::default);
                cpu_by_pid(top, &rows)
            }
            "mem" => rows.iter().filter(|r| r.0 > 0).filter_map(|r| footprint(r.0).map(|b| (r.0, b))).collect(),
            _ => HashMap::new(),
        };
        by_app(&rows, per_pid, limit)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_read_like_the_app() {
        assert_eq!(plain_name("visual studio code.app"), "Visual Studio Code");
        assert_eq!(plain_name("node"), "Node");
    }

    #[test]
    fn this_mac_reports_cpu_and_memory() {
        let (used, total) = memory();
        assert!(total > 1e9 && used > 0.0 && used <= total, "{used} of {total}");
        let mut load = Load::default();
        let _ = cpu_now(&mut load);
        std::thread::sleep(Duration::from_millis(300));
        let pct = cpu_now(&mut load);
        assert!((0.0..=100.0).contains(&pct));
        // The battery: a desktop Mac (or a CI machine) has none, which must read as plugged in.
        let p = power();
        assert!(p.has_battery || p.ac, "{p:?}");
    }

    #[test]
    fn processes_add_up_per_app() {
        let rows = vec![
            crate::procs::ProcRow(10, 1, "google chrome.app".into(), None),
            crate::procs::ProcRow(11, 10, "google chrome.app".into(), None),
            crate::procs::ProcRow(12, 1, "node".into(), None),
        ];
        let per: HashMap<u32, f64> = [(10, 5.0), (11, 7.0), (12, 3.0)].into_iter().collect();
        let list = by_app(&rows, per, 5);
        assert_eq!(list[0].name, "Google Chrome");
        assert_eq!(list[0].value, 12.0);
        assert_eq!(list[0].count, 2);
        assert_eq!(list[1].name, "Node");
    }

    #[test]
    fn this_process_has_cpu_time_and_memory() {
        assert!(proc_time_ns(std::process::id()).is_some());
        assert!(footprint(std::process::id()).is_some_and(|b| b > 0.0));
    }
}
