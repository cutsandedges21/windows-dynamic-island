// Music bars: taps what the speakers are playing (WASAPI loopback on the default
// output) and splits it into five bands, bass to treble, ~30 times a second. Runs
// only while the music activity asks for it; otherwise no audio client is open.
// The loopback is the whole system mix, so a notification sound moves the bars too.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

use crate::overlay::LABEL as ISLAND;

static WANTED: AtomicBool = AtomicBool::new(false);

const FRAME: Duration = Duration::from_millis(33);
/// The bars read the bands against the song's recent peak, this many dB deep.
const RANGE_DB: f32 = 30.0;
/// How fast that peak sinks, so a quiet song or passage still fills the bars.
const PEAK_FALL_DB_PER_SEC: f32 = 4.0;
/// Below this the band is silent, however low its peak has sunk.
const GATE_DB: f32 = -90.0;

/// One bar per band, low to high.
pub const BARS: usize = 5;
/// Bass and kick, low mids (warmth), mids (voice), high mids (presence), treble (cymbals, air):
/// the filter and its corner or centre in Hz.
const BANDS: [(Kind, f32); BARS] = [(Kind::Low, 120.0), (Kind::Band, 350.0), (Kind::Band, 1000.0), (Kind::Band, 3000.0), (Kind::High, 7000.0)];
/// Width of the three middle bands: wide enough that neighbours meet.
const BAND_Q: f32 = 0.8;
/// Lifts each band to read level with the bass. Pink noise (equal energy per octave, the usual
/// stand-in for a song's long-term spectrum) reads flat with ~6 dB on the upper four (the
/// `pink_noise_per_band` printout); songs fall away faster than pink at the top, hence a bit more there.
const TILT_DB: [f32; BARS] = [0.0, 6.5, 7.0, 8.0, 10.0];

/// RBJ biquad, direct form I.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

#[derive(Clone, Copy)]
enum Kind {
    Low,
    Band,
    High,
}

impl Biquad {
    fn new(kind: Kind, f0: f32, q: f32, rate: f32) -> Self {
        let w = 2.0 * std::f32::consts::PI * f0 / rate;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q);
        let (b0, b1, b2) = match kind {
            Kind::Low => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0),
            Kind::Band => (alpha, 0.0, -alpha),
            Kind::High => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0),
        };
        let a0 = 1.0 + alpha;
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2.0 * cos / a0, a2: (1.0 - alpha) / a0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// The bands of BANDS. Each is two biquads in a row, so a loud bass line does not spill
/// into the bars next to it.
struct Bands {
    filters: [[Biquad; 2]; BARS],
    sums: [f32; BARS],
    count: u32,
    peak: f32,
    shown: [f32; BARS],
}

impl Bands {
    fn new(rate: f32) -> Self {
        let filters = BANDS.map(|(kind, f0)| {
            let q = if matches!(kind, Kind::Band) { BAND_Q } else { std::f32::consts::FRAC_1_SQRT_2 };
            [Biquad::new(kind, f0, q, rate), Biquad::new(kind, f0, q, rate)]
        });
        Bands { filters, sums: [0.0; BARS], count: 0, peak: GATE_DB + RANGE_DB, shown: [0.0; BARS] }
    }

    fn push(&mut self, x: f32) {
        for ([a, b], s) in self.filters.iter_mut().zip(self.sums.iter_mut()) {
            let y = b.run(a.run(x));
            *s += y * y;
        }
        self.count += 1;
    }

    /// Closes the frame: 0..1 per band, fast up and slower down like a VU needle.
    fn frame(&mut self, secs: f32) -> [f32; BARS] {
        let n = self.count.max(1) as f32;
        let db: [f32; BARS] = std::array::from_fn(|i| 10.0 * (self.sums[i] / n + 1e-12).log10());
        let loudest = (0..BARS).map(|i| db[i] + TILT_DB[i]).fold(f32::MIN, f32::max);
        self.peak = (self.peak - PEAK_FALL_DB_PER_SEC * secs).max(loudest).max(GATE_DB + RANGE_DB);
        for i in 0..BARS {
            let target = if db[i] < GATE_DB { 0.0 } else { ((db[i] + TILT_DB[i] - (self.peak - RANGE_DB)) / RANGE_DB).clamp(0.0, 1.0) };
            let k = if target > self.shown[i] { 0.65 } else { 0.22 };
            self.shown[i] += (target - self.shown[i]) * k;
        }
        self.sums = [0.0; BARS];
        self.count = 0;
        self.shown
    }
}

enum Sample {
    F32,
    I16,
}

struct Capture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    sample: Sample,
    rate: f32,
    device: String,
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

fn default_id(e: &IMMDeviceEnumerator) -> Option<String> {
    unsafe {
        let dev = e.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let p = dev.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

fn open(e: &IMMDeviceEnumerator) -> Option<Capture> {
    unsafe {
        let dev = e.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let device = default_id(e)?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).ok()?;
        let fmt = client.GetMixFormat().ok()?;
        let wf: WAVEFORMATEX = *fmt;
        let tag = wf.wFormatTag;
        let bits = wf.wBitsPerSample;
        let float = match tag {
            3 => true,
            0xFFFE => {
                let ext = *(fmt as *const WAVEFORMATEXTENSIBLE);
                // Shared-mode mix formats are float32 in practice; the subformat says so too.
                ext.SubFormat.data1 == 3 || bits == 32
            }
            _ => false,
        };
        let sample = match (float, bits) {
            (true, 32) => Some(Sample::F32),
            (false, 16) => Some(Sample::I16),
            _ => None,
        };
        let ok = sample.is_some() && client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, fmt, None).is_ok();
        CoTaskMemFree(Some(fmt as *const _));
        if !ok {
            return None;
        }
        let capture: IAudioCaptureClient = client.GetService().ok()?;
        client.Start().ok()?;
        Some(Capture { client, capture, channels: wf.nChannels.max(1) as usize, sample: sample?, rate: wf.nSamplesPerSec as f32, device })
    }
}

/// Feeds everything waiting in the loopback buffer into the bands. Err when the device went away.
fn drain(c: &Capture, bands: &mut Bands) -> windows::core::Result<()> {
    unsafe {
        while c.capture.GetNextPacketSize()? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            c.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
            for f in 0..frames as usize {
                let mut mono = 0.0f32;
                if !silent {
                    for ch in 0..c.channels {
                        let i = f * c.channels + ch;
                        mono += match c.sample {
                            Sample::F32 => *(data as *const f32).add(i),
                            Sample::I16 => *(data as *const i16).add(i) as f32 / 32768.0,
                        };
                    }
                    mono /= c.channels as f32;
                }
                bands.push(mono);
            }
            c.capture.ReleaseBuffer(frames)?;
        }
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(e): windows::core::Result<IMMDeviceEnumerator> = (unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }) else { return };
        let mut cap: Option<(Capture, Bands)> = None;
        let mut checked = Instant::now();
        let mut last = [0.0f32; BARS];
        loop {
            if !WANTED.load(Ordering::Relaxed) {
                if cap.take().is_some() && last != [0.0; BARS] {
                    last = [0.0; BARS];
                    let _ = app.emit_to(ISLAND, "spectrum", last);
                }
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            // Follow the default output when it changes (headphones plugged in, etc.).
            if cap.is_some() && checked.elapsed() >= Duration::from_secs(2) {
                checked = Instant::now();
                if cap.as_ref().map(|(c, _)| Some(&c.device) != default_id(&e).as_ref()).unwrap_or(false) {
                    cap = None;
                }
            }
            if cap.is_none() {
                cap = open(&e).map(|c| {
                    let b = Bands::new(c.rate);
                    (c, b)
                });
                if cap.is_none() {
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            }
            std::thread::sleep(FRAME);
            let (c, bands) = cap.as_mut().unwrap();
            if drain(c, bands).is_err() {
                cap = None;
                continue;
            }
            let v = bands.frame(FRAME.as_secs_f32()).map(|x| (x * 100.0).round() / 100.0);
            if v != last {
                last = v;
                let _ = app.emit_to(ISLAND, "spectrum", v);
            }
        }
    });
}

/// The music activity turns the bars' audio tap on while something is playing.
#[tauri::command]
pub fn spectrum_watch(on: bool) {
    WANTED.store(on, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// Feeds `secs` of `signal` (one sample per call) through fresh bands; the levels at the end.
    fn settle(secs: f32, mut signal: impl FnMut(f32) -> f32) -> [f32; BARS] {
        let mut b = Bands::new(RATE);
        let per = (RATE * FRAME.as_secs_f32()) as usize;
        let mut out = [0.0; BARS];
        for f in 0..(secs / FRAME.as_secs_f32()) as usize {
            for i in 0..per {
                b.push(signal((f * per + i) as f32 / RATE));
            }
            out = b.frame(FRAME.as_secs_f32());
        }
        out
    }

    fn tone(hz: f32) -> [f32; BARS] {
        settle(1.0, |t| 0.5 * (2.0 * std::f32::consts::PI * hz * t).sin())
    }

    #[test]
    fn each_tone_tops_its_own_bar() {
        for (bar, hz) in [(0, 60.0), (1, 350.0), (2, 1000.0), (3, 3000.0), (4, 10_000.0)] {
            let v = tone(hz);
            assert!(v[bar] > 0.9, "{hz} Hz should fill bar {bar}: {v:?}");
            for (i, x) in v.iter().enumerate() {
                if i != bar {
                    assert!(*x < v[bar] - 0.25, "{hz} Hz spills into bar {i}: {v:?}");
                }
                if i.abs_diff(bar) >= 2 {
                    assert!(*x < 0.35, "{hz} Hz reaches bar {i}, two away: {v:?}");
                }
            }
        }
    }

    #[test]
    fn silence_is_zero() {
        let mut b = Bands::new(RATE);
        for _ in 0..1600 {
            b.push(0.0);
        }
        assert_eq!(b.frame(0.033), [0.0; BARS]);
    }

    /// Pink noise (equal energy per octave): what each band reads before any tilt, in dB.
    #[test]
    #[ignore = "calibration printout"]
    fn pink_noise_per_band() {
        let mut seed = 0x2545_f491_u32;
        let mut white = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f32 / u32::MAX as f32 * 2.0 - 1.0
        };
        // Paul Kellet's pink filter.
        let mut k = [0.0f32; 7];
        let mut b = Bands::new(RATE);
        let n = (RATE * 20.0) as usize;
        for _ in 0..n {
            let w = white();
            k[0] = 0.99886 * k[0] + w * 0.055_517_9;
            k[1] = 0.99332 * k[1] + w * 0.075_075_9;
            k[2] = 0.969 * k[2] + w * 0.153_852;
            k[3] = 0.8665 * k[3] + w * 0.310_485_6;
            k[4] = 0.55 * k[4] + w * 0.532_952_2;
            k[5] = -0.7616 * k[5] - w * 0.016_898;
            let pink = (k[0] + k[1] + k[2] + k[3] + k[4] + k[5] + k[6] + w * 0.5362) * 0.11;
            k[6] = w * 0.115_926;
            b.push(pink);
        }
        let db: Vec<f32> = b.sums.iter().map(|s| 10.0 * (s / n as f32).log10()).collect();
        println!("pink dB per band: {db:?}");
        println!("flat tilt would be: {:?}", db.iter().map(|d| db[0] - d).collect::<Vec<_>>());
    }

    #[test]
    #[ignore = "needs a real output device"]
    fn loopback_opens() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let e: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.unwrap();
        let c = open(&e).expect("loopback did not open");
        let mut b = Bands::new(c.rate);
        for _ in 0..120 {
            std::thread::sleep(FRAME);
            drain(&c, &mut b).unwrap();
            println!("{:?}", b.frame(FRAME.as_secs_f32()).map(|x| (x * 100.0).round() / 100.0));
        }
        println!("{} ch @ {} Hz", c.channels, c.rate);
    }
}
