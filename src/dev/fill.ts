// Browser preview only (open /?fill): realistic data for every activity, every
// activity switched on, and the island opened on its grid, so the whole Control
// Center can be checked by eye or by an automated screenshot.

import type { Island } from '../core/island';
import type { emitLocal as Emit, native as Native } from '../core/native';

const H = 3600e3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export async function fillPreview(island: Island, native: typeof Native, emit: typeof Emit): Promise<void> {
  const now = Date.now();
  const n = native as unknown as Record<string, unknown>;
  Object.assign(n, {
    powerState: async () => ({ hasBattery: true, percent: 72, ac: true, charging: true, saver: false, secondsLeft: 1500 }),
    audioState: async () => ({ volume: 0.42, muted: false, device: 'Speakers (Realtek(R) Audio)', deviceId: 'spk', micMuted: false, micDevice: 'Microphone' }),
    mediaState: async () => ({
      available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'Roman to Integer - LeetCode #13', artist: 'CodingNinja', album: 'LeetCode',
      status: 'playing', position: 120, duration: 300, updatedAt: Date.now(), canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: null,
    }),
    sysSample: async () => ({ cpu: 37, memUsed: 10.4e9, memTotal: 16e9, gpu: 22, top: { name: 'chrome.exe', cpu: 12 } }),
    netSample: async () => ({ rxBps: 2.1e6, txBps: 1.8e5, connected: true, internet: true, name: 'HomeWiFi', wifi: true, vpn: false }),
    ports: async () => [
      { port: 3000, pid: 11, process: 'node.exe', address: '127.0.0.1' },
      { port: 5173, pid: 12, process: 'node.exe', address: '127.0.0.1' },
    ],
    httpGet: async (url: string) => {
      if (url.includes('geocoding')) return { status: 200, body: JSON.stringify({ results: [{ name: 'Montreal', latitude: 45.5, longitude: -73.6, country: 'Canada' }] }) };
      if (url.includes('forecast')) {
        const t0 = new Date();
        t0.setMinutes(0, 0, 0);
        const time = [0, 1, 2, 3, 4].map((i) => new Date(t0.getTime() + i * H).toISOString().slice(0, 16));
        return {
          status: 200,
          body: JSON.stringify({
            current: { temperature_2m: 23.4, weather_code: 2, is_day: 1 },
            hourly: { time, precipitation_probability: [5, 10, 20, 40, 60], temperature_2m: [23, 22, 21, 19, 18], weather_code: [2, 3, 3, 61, 61], is_day: [1, 1, 1, 0, 0] },
            daily: { temperature_2m_max: [25], temperature_2m_min: [14] },
          }),
        };
      }
      if (url.includes('.ics')) {
        const ev = (h: number, title: string) => `BEGIN:VEVENT\r\nUID:${title}\r\nDTSTART:${icsTime(now + h * H)}\r\nDTEND:${icsTime(now + (h + 1) * H)}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\n`;
        return { status: 200, body: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev(2, 'Design review')}${ev(26, 'Physics lab')}${ev(50, 'Dentist')}${ev(-20, 'Study group')}END:VCALENDAR\r\n` };
      }
      return null;
    },
  });

  const s = JSON.parse(JSON.stringify(island.settings)) as typeof island.settings;
  for (const cfg of Object.values(s.activities.config)) cfg.enabled = true;
  s.activities.config.weather.options.city = 'Montreal';
  s.activities.config.calendar.options.ics = 'https://example.com/cal.ics';
  s.activities.config.system.options.always = true;
  s.activities.config.network.options.always = true;
  s.activities.config.battery.options.showCharging = true;
  await native.settingsSet(s, 'preview');
  await sleep(400);
  emit('power', await native.powerState());
  emit('audio', await native.audioState());
  emit('media', await native.mediaState());
  emit('privacy', { mic: ['Discord'], cam: [] });
  emit('clipboard', { seq: 7, kind: 'text', text: 'npm run release', files: [], excluded: false });
  await sleep(3000);
  (island as unknown as { open: boolean }).open = true;
  island.schedule();
}
