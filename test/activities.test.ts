// Event activities against a fake native layer, fake timers and a fake context.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({
  native: h.native,
  on: async (event: string, cb: (p: unknown) => void) => {
    let set = h.bus.get(event);
    if (!set) h.bus.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
  emitLocal: () => {},
}));

import type { Activity, ActivityContext, RenderEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';
import { BatteryActivity } from '../src/activities/battery';
import { CalendarActivity } from '../src/activities/calendar';
import { CallsActivity } from '../src/activities/calls';
import { ClipboardActivity } from '../src/activities/clipboard';
import { DevicesActivity } from '../src/activities/devices';
import { DownloadsActivity } from '../src/activities/downloads';
import { ExternalActivity } from '../src/activities/external';
import { NetworkActivity } from '../src/activities/network';
import { QuickActivity } from '../src/activities/quick';
import { ScreenshotsActivity } from '../src/activities/screenshots';
import { ServersActivity } from '../src/activities/servers';
import { SoundActivity } from '../src/activities/sound';
import { SystemActivity } from '../src/activities/system';
import { WeatherActivity } from '../src/activities/weather';

const T0 = Date.parse('2026-09-30T12:00:00Z');

function resetNative() {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    powerState: vi.fn(async () => null),
    audioState: vi.fn(async () => null),
    audioSet: vi.fn(async () => true),
    micSetMute: vi.fn(async () => true),
    statMany: vi.fn(async (paths: string[]) => paths.map(() => null)),
    listFiles: vi.fn(async () => []),
    readBytes: vi.fn(async () => null),
    watch: vi.fn(async () => true),
    unwatch: vi.fn(async () => undefined),
    knownFolders: vi.fn(async () => ({ home: '', downloads: 'C:\\Users\\t\\Downloads', desktop: '', pictures: '', screenshots: [], appData: '', localAppData: '' })),
    sysSample: vi.fn(async () => null),
    netSample: vi.fn(async () => null),
    ports: vi.fn(async () => []),
    httpGet: vi.fn(async () => null),
    open: vi.fn(async () => true),
    reveal: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    lock: vi.fn(async () => undefined),
    snip: vi.fn(async () => undefined),
    clipboardCopyImage: vi.fn(async () => true),
    clipboardHistory: vi.fn(async () => undefined),
  });
}

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

type Calls = { surface: Array<{ key?: string; ms?: number; level?: string }>; update: number; alert: unknown[][]; close: number; notify: unknown[][]; log: unknown[][] };

async function boot<T extends Activity>(act: T, options: Record<string, unknown> = {}, tweak: (s: ReturnType<typeof defaultSettings>) => void = () => {}) {
  const settings = defaultSettings();
  tweak(settings);
  const calls: Calls = { surface: [], update: 0, alert: [], close: 0, notify: [], log: [] };
  const ctx: ActivityContext = {
    id: act.meta.id,
    config: () => settings.activities.config[act.meta.id],
    options: () => options as never,
    settings: () => settings,
    update: () => void calls.update++,
    surface: (o) => void calls.surface.push(o ?? {}),
    alert: (...a) => void calls.alert.push(a),
    open: () => {},
    close: () => void calls.close++,
    isOpen: () => false,
    isPrimary: () => true,
    notify: (...a) => void calls.notify.push(a),
    log: (...a) => void calls.log.push(a),
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls, options };
}

const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({
  level,
  width: 400,
  height: 40,
  now: Date.now(),
  open: false,
  hover: false,
  surfaced: null,
  interactive: true,
  vertical: false,
  ...over,
});

/** Every level and orientation renders valid, fittable, icon-only-when-vertical segments. */
function smoke(act: Activity, label: string): void {
  for (const level of ['compact', 'expanded', 'maximum'] as const) {
    for (const vertical of [false, true]) {
      const at = `${label} ${level}${vertical ? ' vertical' : ''}`;
      const segs = act.render(env(level, { vertical }));
      const keys = segs.map((s) => s.key);
      expect(new Set(keys).size, `${at}: unique keys ${keys}`).toBe(keys.length);
      for (const s of segs) {
        if (s.t === 'icon' || s.t === 'art') if (s.icon) expect(hasIcon(s.icon), `${at}: icon ${s.icon}`).toBe(true);
        if (s.t === 'chip' && s.icon) expect(hasIcon(s.icon), `${at}: chip icon ${s.icon}`).toBe(true);
        if (s.t === 'button') {
          expect(s.icon, `${at}: button ${s.key} needs an icon`).toBeTruthy();
          expect(hasIcon(s.icon!), `${at}: button icon ${s.icon}`).toBe(true);
          if (vertical) expect(s.label, `${at}: vertical button ${s.key} is icon-only`).toBeUndefined();
        }
      }
      if (vertical) fitVertical(segs, 200, 40);
      else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNative();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('battery', () => {
  const power = (over: Record<string, unknown> = {}) => ({ hasBattery: true, percent: 50, ac: false, charging: false, saver: false, secondsLeft: 7200, ...over });

  it('announces plugging, unplugging and each low crossing once', async () => {
    h.native.powerState = vi.fn(async () => power());
    const { act, calls } = await boot(new BatteryActivity(), { lowAt: 20, showCharging: false });
    expect(act.status().active).toBe(false);

    emit('power', power({ ac: true, charging: true, percent: 51 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'plug', ms: 3000 });
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });
    smoke(act, 'battery charging');
    await tick(3100);
    expect(act.status().active).toBe(false);

    emit('power', power({ percent: 30 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'unplug' });

    emit('power', power({ percent: 19 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'low-20' });
    expect(act.status().urgent).toEqual({ key: 'low-20', level: 'expanded' });
    smoke(act, 'battery low');
    const n = calls.surface.length;
    emit('power', power({ percent: 18 }));
    expect(calls.surface.length).toBe(n); // same crossing: no second warning

    emit('power', power({ percent: 9 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'low-10' });
    act.dismiss('low-10');
    expect(act.status().urgent ?? null).toBe(null);

    // Charge, unplug again below the line: a new discharge, a new warning.
    emit('power', power({ percent: 12, ac: true, charging: true }));
    emit('power', power({ percent: 15 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'low-20' });
  });

  it('is silent about a charge that is already low at startup, and warns when it falls further', async () => {
    h.native.powerState = vi.fn(async () => power({ percent: 15 }));
    const { act, calls } = await boot(new BatteryActivity(), { lowAt: 20 });
    expect(calls.surface).toEqual([]);
    emit('power', power({ percent: 9 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'low-10' });
    expect(act.status().active).toBe(true);
  });

  it('ignores machines without a battery and honours showCharging', async () => {
    h.native.powerState = vi.fn(async () => power({ hasBattery: false, percent: null }));
    const none = await boot(new BatteryActivity(), { lowAt: 20 });
    emit('power', power({ hasBattery: false, percent: null, ac: true }));
    expect(none.act.status().active).toBe(false);
    expect(none.act.render(env('expanded'))).toEqual([]);
    expect(none.calls.surface).toEqual([]);

    resetNative();
    h.native.powerState = vi.fn(async () => power({ ac: true, charging: true, percent: 60 }));
    const keep = await boot(new BatteryActivity(), { lowAt: 20, showCharging: true });
    expect(keep.act.status()).toMatchObject({ active: true, weight: 'background' });
    const segs = keep.act.render(env('maximum'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'bolt', tone: 'good' });
    expect(segs.find((s) => s.key === 'pct')).toMatchObject({ text: '60%' });
  });
});

describe('sound', () => {
  const audio = (over: Record<string, unknown> = {}) => ({ volume: 0.5, muted: false, device: 'Speakers (Realtek)', deviceId: 'a', micMuted: false, micDevice: 'Mic', ...over });

  it('skips startup, shows volume changes and device changes', async () => {
    h.native.audioState = vi.fn(async () => audio());
    const { act, calls } = await boot(new SoundActivity());
    emit('audio', audio()); // the startup event
    expect(calls.surface).toEqual([]);

    emit('audio', audio({ volume: 0.62 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'volume', ms: 1600 });
    expect(act.status().active).toBe(true);
    expect(act.render(env('expanded')).find((s) => s.t === 'text' && s.key === 'pct')).toMatchObject({ text: '62%' });
    smoke(act, 'sound volume');
    await tick(1700);
    expect(act.status().active).toBe(false);

    emit('audio', audio({ volume: 0.62, muted: true }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'volume' });
    expect(act.render(env('compact')).find((s) => s.t === 'icon')).toMatchObject({ icon: 'speaker-mute' });
    expect(act.render(env('maximum')).filter((s) => s.t === 'button').map((s) => s.key)).toEqual(['down', 'mute', 'up']);

    emit('audio', audio({ volume: 0.4, deviceId: 'b', device: 'AirPods Pro' }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'device', ms: 3500 });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.t === 'icon')).toMatchObject({ icon: 'headphones' });
    expect(segs.map((s) => (s.t === 'text' ? s.text : ''))).toContain('Connected');
    smoke(act, 'sound device');

    emit('audio', audio({ deviceId: 'c', device: 'Monitor speakers' }));
    expect(act.render(env('expanded')).find((s) => s.t === 'icon')).toMatchObject({ icon: 'speaker' });
  });

  it('buttons change the volume through the native layer', async () => {
    h.native.audioState = vi.fn(async () => audio({ volume: 0.5 }));
    const { act } = await boot(new SoundActivity());
    await act.action!('vol-up', null);
    expect(h.native.audioSet).toHaveBeenLastCalledWith(0.55, null);
    await act.action!('vol-down', null);
    expect(h.native.audioSet).toHaveBeenLastCalledWith(0.45, null);
    await act.action!('mute', null);
    expect(h.native.audioSet).toHaveBeenLastCalledWith(null, true);
  });
});

describe('downloads', () => {
  const DIR = 'C:\\Users\\t\\Downloads';
  const files = new Map<string, { size: number; dir: boolean }>();
  const set = (name: string, size: number) => files.set(`${DIR}\\${name}`.toLowerCase(), { size, dir: false });
  const drop = (name: string) => files.delete(`${DIR}\\${name}`.toLowerCase());
  const fs = (kind: string, ...names: string[]) => emit('fs-change', { id: 'downloads', kind, paths: names.map((n) => `${DIR}\\${n}`) });

  beforeEach(() => {
    files.clear();
    h.native.statMany = vi.fn(async (paths: string[]) => paths.map((p) => (files.get(p.toLowerCase()) ? { ...files.get(p.toLowerCase())!, mtimeMs: Date.now() } : null)));
  });

  it("follows Chrome's Unconfirmed download from first byte to Open and Show", async () => {
    const { act, calls } = await boot(new DownloadsActivity(), { folder: '' });
    expect(h.native.watch).toHaveBeenCalledWith('downloads', DIR);
    expect(act.status().active).toBe(false);

    set('Unconfirmed 123456.crdownload', 0);
    fs('create', 'Unconfirmed 123456.crdownload');
    await tick(0);
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });

    set('Unconfirmed 123456.crdownload', 4_000_000);
    await tick(1000);
    const segs = act.render(env('maximum'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'download', anim: 'bob' });
    expect(segs.find((s) => s.key === 'name')).toMatchObject({ text: 'Download' });
    expect(segs.find((s) => s.key === 'bar')).toMatchObject({ t: 'progress', value: null });
    expect(segs.find((s) => s.key === 'speed')).toMatchObject({ text: '3.8 MB/s' });
    expect(segs.find((s) => s.key === 'size')).toMatchObject({ text: '3.8 MB' });
    smoke(act, 'downloads progress');

    // Finished: Chrome renames the temp file to the real name.
    drop('Unconfirmed 123456.crdownload');
    set('report final.pdf', 4_000_000);
    fs('rename', 'Unconfirmed 123456.crdownload');
    fs('rename', 'report final.pdf');
    await tick(0);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'done:report final.pdf', ms: 6000 });
    expect(act.status().active).toBe(true);
    const done = act.render(env('expanded'));
    expect(done.map((s) => s.key)).toEqual(expect.arrayContaining(['name', 'open', 'show']));
    expect(done.find((s) => s.key === 'name')).toMatchObject({ text: 'report final.pdf' });
    smoke(act, 'downloads done');

    await act.action!('open', null);
    expect(h.native.open).toHaveBeenCalledWith(`${DIR}\\report final.pdf`);
    expect(act.status().active).toBe(false);
  });

  it('pairs a Firefox .part with the file of the same name and a tiny download that never polled', async () => {
    const { act, calls } = await boot(new DownloadsActivity());
    set('notes.txt.part', 10);
    fs('create', 'notes.txt.part');
    await tick(0);
    expect(act.render(env('expanded')).find((s) => s.key === 'name')).toMatchObject({ text: 'notes.txt' });
    drop('notes.txt.part');
    set('notes.txt', 10);
    fs('rename', 'notes.txt.part');
    fs('rename', 'notes.txt');
    await tick(0);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'done:notes.txt' });
    await tick(7000);

    // So fast the temp file is gone before anything looks at it.
    set('tiny.zip', 5);
    fs('create', 'tiny.zip.crdownload');
    fs('rename', 'tiny.zip');
    await tick(0);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'done:tiny.zip' });
  });

  it('a cancelled download and Office lock files are not completions', async () => {
    const { act, calls } = await boot(new DownloadsActivity());
    set('big.iso.crdownload', 100);
    fs('create', 'big.iso.crdownload');
    await tick(0);
    expect(act.status().active).toBe(true);
    drop('big.iso.crdownload');
    fs('remove', 'big.iso.crdownload');
    await tick(1500);
    expect(act.status().active).toBe(false);
    expect(calls.surface).toEqual([]);

    set('~$report.docx', 100);
    fs('create', '~$report.docx');
    await tick(0);
    expect(act.status().active).toBe(false);
  });

  it('does not stat on every write event of a busy download', async () => {
    const { act } = await boot(new DownloadsActivity());
    set('a.zip.crdownload', 1);
    fs('create', 'a.zip.crdownload');
    await tick(0);
    const calls = h.native.statMany.mock.calls.length;
    for (let i = 0; i < 200; i++) fs('modify', 'a.zip.crdownload');
    await tick(0);
    expect(h.native.statMany.mock.calls.length).toBe(calls);
    expect(act.status().active).toBe(true);
  });

  it('adopts downloads already running at startup and drops ones that stall for minutes', async () => {
    h.native.listFiles = vi.fn(async (_d: string, _r: boolean, ext: string) => (ext === '.crdownload' ? [{ name: 'old.iso.crdownload', path: `${DIR}\\old.iso.crdownload`, dir: false, size: 5, mtimeMs: Date.now() }] : []));
    set('old.iso.crdownload', 5);
    const { act } = await boot(new DownloadsActivity());
    expect(act.status().active).toBe(true);
    await tick(4 * 60000);
    expect(act.status().active).toBe(false); // never grew: abandoned
  });
});

describe('screenshots', () => {
  const DIR = 'C:\\Users\\t\\Pictures\\Screenshots';
  const PNG = `${DIR}\\Screenshot (1).png`;

  beforeEach(() => {
    h.native.knownFolders = vi.fn(async () => ({ home: '', downloads: '', desktop: '', pictures: '', screenshots: [DIR, 'C:\\Users\\t\\OneDrive\\Pictures\\Screenshots'], appData: '', localAppData: '' }));
    h.native.statMany = vi.fn(async (paths: string[]) => paths.map(() => ({ size: 1234, mtimeMs: Date.now(), dir: false })));
    h.native.readBytes = vi.fn(async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  });

  it('watches every screenshots folder and shows a card with a thumbnail after the file settles', async () => {
    const { act, calls } = await boot(new ScreenshotsActivity(), { preview: true });
    expect(h.native.watch).toHaveBeenCalledWith('shots-0', DIR);
    expect(h.native.watch).toHaveBeenCalledWith('shots-1', 'C:\\Users\\t\\OneDrive\\Pictures\\Screenshots');

    emit('fs-change', { id: 'shots-0', kind: 'create', paths: [PNG] });
    emit('fs-change', { id: 'shots-0', kind: 'create', paths: [PNG] }); // duplicate report
    emit('fs-change', { id: 'shots-0', kind: 'modify', paths: [PNG] });
    emit('fs-change', { id: 'downloads', kind: 'create', paths: [PNG] }); // somebody else's folder
    expect(act.status().active).toBe(false);
    await tick(450);
    expect(h.native.readBytes).toHaveBeenCalledTimes(1);
    expect(h.native.readBytes).toHaveBeenCalledWith(PNG, 8_000_000);
    expect(calls.surface).toHaveLength(1);
    expect(calls.surface[0]).toMatchObject({ key: 'shot', ms: 7000 });

    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.t === 'art')).toMatchObject({ src: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(segs.filter((s) => s.t === 'button').map((s) => s.key)).toEqual(['copy', 'edit', 'open', 'show']);
    smoke(act, 'screenshots');

    await act.action!('copy', null);
    expect(h.native.clipboardCopyImage).toHaveBeenCalledWith(PNG);
    expect(act.render(env('expanded')).find((s) => s.key === 'label')).toMatchObject({ text: 'Copied', tone: 'good' });
    await tick(1600);
    expect(act.render(env('expanded')).find((s) => s.key === 'label')).toMatchObject({ text: 'Screenshot' });

    await act.action!('edit', null);
    expect(h.native.edit).toHaveBeenCalledWith(PNG);
    expect(act.status().active).toBe(false); // used
  });

  it('respects the preview options, skips non-images, and offers no Copy for JPEG', async () => {
    const off = await boot(new ScreenshotsActivity(), { preview: true }, (s) => (s.privacy.screenshotPreview = false));
    emit('fs-change', { id: 'shots-0', kind: 'create', paths: [PNG] });
    await tick(450);
    expect(h.native.readBytes).not.toHaveBeenCalled();
    expect(off.act.render(env('expanded')).find((s) => s.t === 'art')).toMatchObject({ src: null });

    resetNative();
    h.native.knownFolders = vi.fn(async () => ({ home: '', downloads: '', desktop: '', pictures: '', screenshots: [DIR], appData: '', localAppData: '' }));
    h.native.statMany = vi.fn(async (paths: string[]) => paths.map(() => ({ size: 10, mtimeMs: 0, dir: false })));
    const jpg = await boot(new ScreenshotsActivity(), { preview: false });
    emit('fs-change', { id: 'shots-0', kind: 'create', paths: [`${DIR}\\notes.txt`] });
    await tick(450);
    expect(jpg.calls.surface).toEqual([]);
    emit('fs-change', { id: 'shots-0', kind: 'create', paths: [`${DIR}\\shot.jpg`] });
    await tick(450);
    expect(h.native.readBytes).not.toHaveBeenCalled();
    expect(jpg.act.render(env('expanded')).filter((s) => s.t === 'button').map((s) => s.key)).toEqual(['edit', 'open', 'show']);
  });
});

describe('calls', () => {
  it('follows the privacy event and mutes the microphone', async () => {
    h.native.audioState = vi.fn(async () => ({ volume: 0.5, muted: false, device: null, deviceId: null, micMuted: false, micDevice: 'Mic' }));
    const { act, calls } = await boot(new CallsActivity());
    expect(act.status().active).toBe(false);
    emit('privacy', { mic: ['Zoom'], cam: [] });
    expect(calls.surface.at(-1)).toMatchObject({ key: 'start', ms: 3000 });
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });
    let segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'mic')).toMatchObject({ icon: 'mic', tone: 'bad' });
    expect(segs.find((s) => s.key === 'apps')).toMatchObject({ text: 'Zoom' });
    smoke(act, 'calls');

    await act.action!('mute', null);
    expect(h.native.micSetMute).toHaveBeenCalledWith(true);
    segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'mic')).toMatchObject({ icon: 'mic-off' });
    expect(segs.map((s) => (s.t === 'text' ? s.text : ''))).toContain('Muted');

    emit('privacy', { mic: ['Zoom'], cam: ['Zoom', 'Teams'] });
    expect(act.render(env('expanded')).find((s) => s.key === 'cam')).toMatchObject({ icon: 'video' });
    expect(act.render(env('expanded')).find((s) => s.key === 'apps')).toMatchObject({ text: 'Zoom, Teams' });
    smoke(act, 'calls both');

    emit('privacy', { mic: [], cam: [] });
    expect(act.status().active).toBe(false);
  });
});

describe('devices', () => {
  it('shows an arriving drive with Open, and a removed one briefly', async () => {
    const { act, calls } = await boot(new DevicesActivity());
    emit('device', { kind: 'volume', action: 'arrived', drive: 'E:', label: 'SANDISK', removable: true });
    expect(calls.surface.at(-1)).toMatchObject({ ms: 5000 });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'usb' });
    expect(segs.find((s) => s.key === 'label')).toMatchObject({ text: 'SANDISK' });
    expect(segs.find((s) => s.key === 'drive')).toMatchObject({ text: 'E:' });
    smoke(act, 'devices arrived');
    await act.action!('open', null);
    expect(h.native.open).toHaveBeenCalledWith('E:\\');

    emit('device', { kind: 'volume', action: 'removed', drive: 'E:', label: '', removable: false });
    expect(calls.surface.at(-1)).toMatchObject({ ms: 2500 });
    expect(act.render(env('expanded')).find((s) => s.key === 'icon')).toMatchObject({ icon: 'drive', tone: 'muted' });
    smoke(act, 'devices removed');
    await tick(2600);
    expect(act.status().active).toBe(false);

    emit('device', { kind: 'volume', action: 'arrived', drive: 'F:', label: '', removable: true });
    expect(act.render(env('expanded')).find((s) => s.key === 'label')).toMatchObject({ text: 'USB drive' });
  });
});

describe('external', () => {
  it('keeps items by id, merges updates, validates fields and expires', async () => {
    const { act, calls } = await boot(new ExternalActivity());
    emit('external-activity', { island: 'activity', id: 'build', title: 'Build', text: 'Compiling', icon: 'hourglass', progress: null, url: 'https://ci.example.com/1' });
    expect(calls.surface.at(-1)).toMatchObject({ key: 'ext:build', ms: 3500 });
    let segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'hourglass' });
    expect(segs.find((s) => s.key === 'bar')).toMatchObject({ value: null });
    expect(segs.find((s) => s.key === 'open')).toBeTruthy();
    smoke(act, 'external');

    const n = calls.surface.length;
    emit('external-activity', { id: 'build', progress: 0.5 }); // progress only: quiet
    expect(calls.surface.length).toBe(n);
    segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'bar')).toMatchObject({ value: 0.5 });
    expect(segs.find((s) => s.key === 'title')).toMatchObject({ text: 'Build' });
    expect(act.render(env('compact')).find((s) => s.key === 'pct')).toMatchObject({ text: '50%' });

    emit('external-activity', { id: 'build', text: 'Linking' });
    expect(calls.surface.length).toBe(n + 1);

    emit('external-activity', { id: 'x', title: 'Odd', icon: 'not-an-icon', tone: 'rainbow', url: 'javascript:alert(1)', progress: 7 });
    segs = act.render(env('maximum'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'stack' });
    expect(segs.find((s) => s.key === 'open')).toBeUndefined();
    expect(segs.find((s) => s.key === 'bar')).toMatchObject({ value: 1 });
    expect(segs.find((s) => s.key === 'more')).toMatchObject({ text: '+1' });
    emit('external-activity', { id: 'l', title: 'Local', url: 'http://localhost:3000/x' });
    expect(act.render(env('maximum')).find((s) => s.key === 'open')).toBeTruthy();
    emit('external-activity', { id: 'l2', title: 'Remote http', url: 'http://example.com' });
    expect(act.render(env('maximum')).find((s) => s.key === 'open')).toBeUndefined();

    emit('external-activity', { id: 'x', state: 'end' });
    emit('external-activity', { id: 'l', state: 'end' });
    emit('external-activity', { id: 'l2', state: 'end' });
    expect(act.render(env('expanded')).find((s) => s.key === 'title')).toMatchObject({ text: 'Build' });

    emit('external-activity', { id: 'blip', title: 'Blip', ms: 2000 });
    expect(act.render(env('expanded')).find((s) => s.key === 'title')).toMatchObject({ text: 'Blip' });
    await tick(2100);
    expect(act.render(env('expanded')).find((s) => s.key === 'title')).toMatchObject({ text: 'Build' });
    emit('external-activity', { id: 'build', state: 'end' });
    expect(act.status().active).toBe(false);
  });

  it('caps the list at ten, ignores junk and reports urgent items', async () => {
    const { act } = await boot(new ExternalActivity());
    for (let i = 0; i < 12; i++) emit('external-activity', { id: `i${i}`, title: `Item ${i}` });
    emit('external-activity', 'junk');
    emit('external-activity', { title: 'no id' });
    expect(act.render(env('maximum')).find((s) => s.key === 'more')).toMatchObject({ text: '+9' });
    expect(act.render(env('expanded')).find((s) => s.key === 'title')).toMatchObject({ text: 'Item 11' });
    expect(act.status().urgent ?? null).toBe(null);

    emit('external-activity', { id: 'fire', title: 'Server down', urgent: true });
    const u = act.status().urgent!;
    expect(u).toMatchObject({ level: 'expanded' });
    act.dismiss(u.key);
    expect(act.status().urgent ?? null).toBe(null);
    emit('external-activity', { id: 'fire', title: 'Server still down' }); // new news, urgent kept
    expect(act.status().urgent).toBeTruthy();
  });
});

describe('system', () => {
  const sample = (cpu: number, over: Record<string, unknown> = {}) => ({ cpu, memUsed: 8e9, memTotal: 16e9, gpu: 12, top: null, ...over });

  it('samples every 5 s, then every 2 s while hot, and calls a spike after 3 hot samples', async () => {
    let n = 0;
    const cpus = [10, 95, 96, 97, 97, 20];
    h.native.sysSample = vi.fn(async (withTop: boolean) => sample(cpus[Math.min(n++, cpus.length - 1)], withTop ? { top: { name: 'chrome', cpu: 61.2 } } : {}));
    const { act, calls } = await boot(new SystemActivity(), { always: false, cpuSpike: 90, memSpike: 92 });
    await tick(1000);
    expect(h.native.sysSample).toHaveBeenCalledTimes(1);
    expect(h.native.sysSample).toHaveBeenLastCalledWith(false);
    expect(act.status().active).toBe(false);

    await tick(4000); // 5 s after the first
    expect(h.native.sysSample).toHaveBeenCalledTimes(2); // 95: hot, streak 1
    await tick(2000);
    expect(h.native.sysSample).toHaveBeenCalledTimes(3);
    expect(h.native.sysSample).toHaveBeenLastCalledWith(true); // asks for the busiest process once hot
    expect(calls.surface).toEqual([]);
    await tick(2000); // third hot sample
    expect(calls.surface.at(-1)).toMatchObject({ key: 'cpu', ms: 6000 });
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'cpu', tone: 'bad' });
    expect(segs.find((s) => s.key === 'main')).toMatchObject({ text: 'CPU 97%' });
    expect(segs.find((s) => s.key === 'detail')).toMatchObject({ text: 'chrome 61%' });
    smoke(act, 'system spike');
    const spikes = calls.surface.length;
    await tick(2000);
    expect(calls.surface.length).toBe(spikes); // one nod per spike
  });

  it('always: persistent numbers, and a memory warning', async () => {
    h.native.sysSample = vi.fn(async () => sample(42, { memUsed: 15e9 }));
    const { act, calls } = await boot(new SystemActivity(), { always: true, cpuSpike: 90, memSpike: 92 });
    await tick(1000);
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' }); // 15/16 GB = 94%: warned
    expect(calls.surface.at(-1)).toMatchObject({ key: 'mem' });
    await tick(7000);
    expect(act.status()).toMatchObject({ active: true, weight: 'background' });
    expect(act.render(env('compact')).find((s) => s.t === 'text')).toMatchObject({ text: 'CPU 42%' });
    const expanded = act.render(env('expanded')).map((s) => (s.t === 'text' ? s.text : ''));
    expect(expanded).toEqual(expect.arrayContaining(['CPU 42%', 'RAM 14.0 GB', 'GPU 12%']));
    expect(act.render(env('maximum')).filter((s) => s.t === 'meter').map((s) => s.key)).toEqual(['cpu', 'mem', 'gpu']);
    smoke(act, 'system always');
  });
});

describe('weather', () => {
  const forecast = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ current: { temperature_2m: 18.4, weather_code: 3, is_day: 1, ...over }, hourly: { precipitation_probability: [10, 20] } });

  function serve(rain = [10, 20], code = 3) {
    h.native.httpGet = vi.fn(async (url: string) => {
      if (url.includes('geocoding-api')) return { status: 200, body: JSON.stringify({ results: [{ latitude: 45.5, longitude: -73.6, name: 'Montréal' }] }) };
      return { status: 200, body: JSON.stringify({ current: { temperature_2m: 18.4, weather_code: code, is_day: 1 }, hourly: { precipitation_probability: rain } }) };
    });
  }

  it('geocodes once, shows the conditions and refreshes every 15 minutes', async () => {
    serve();
    const { act } = await boot(new WeatherActivity(), { city: 'Montreal', units: 'celsius' });
    await tick(0);
    expect(act.status()).toMatchObject({ active: true, weight: 'background' });
    const urls = h.native.httpGet.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls[0]).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Montreal&count=1');
    expect(urls[1]).toBe('https://api.open-meteo.com/v1/forecast?latitude=45.5&longitude=-73.6&current=temperature_2m,weather_code,is_day&hourly=precipitation_probability,temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&forecast_hours=5&timezone=auto');
    expect(act.render(env('compact')).filter((s) => s.t === 'text')).toMatchObject([{ text: '18°' }]);
    const wide = act.render(env('expanded')).map((s) => (s.t === 'text' ? s.text : s.t === 'icon' ? s.icon : ''));
    expect(wide).toEqual(expect.arrayContaining(['cloud', '18°', 'Cloudy', 'Montréal']));
    smoke(act, 'weather');

    await tick(14 * 60000);
    expect(h.native.httpGet).toHaveBeenCalledTimes(2); // not yet
    await tick(60000);
    expect(h.native.httpGet).toHaveBeenCalledTimes(3); // forecast only: the place is remembered
    expect(h.native.httpGet.mock.calls[2][0]).toContain('/v1/forecast');
  });

  it('uses Fahrenheit, tells you about rain once an hour, and is quiet without a city or network', async () => {
    serve([70, 80]);
    const { act, calls } = await boot(new WeatherActivity(), { city: 'Montreal', units: 'fahrenheit' });
    await tick(0);
    expect(h.native.httpGet.mock.calls[1][0]).toContain('&temperature_unit=fahrenheit');
    expect(calls.surface).toHaveLength(1);
    expect(calls.surface[0]).toMatchObject({ key: 'rain' });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'rain' });
    expect(segs.find((s) => s.key === 'main')).toMatchObject({ text: 'Rain soon' });
    smoke(act, 'weather rain');
    await tick(15 * 60000);
    expect(calls.surface).toHaveLength(1); // same hour
    await tick(50 * 60000);
    expect(calls.surface.length).toBe(2);

    resetNative();
    const none = await boot(new WeatherActivity(), { city: '', units: 'celsius' });
    expect(none.act.status().active).toBe(false);
    expect(h.native.httpGet).not.toHaveBeenCalled();

    resetNative();
    const offline = await boot(new WeatherActivity(), { city: 'Montreal', units: 'celsius' }); // httpGet returns null
    await tick(0);
    expect(offline.act.status().active).toBe(false);
    expect(offline.act.render(env('expanded'))).toEqual([]);
    await tick(61000); // retry after a minute
    expect(h.native.httpGet.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not warn about rain that has already started', async () => {
    serve([90, 90], 63);
    const { calls } = await boot(new WeatherActivity(), { city: 'Montreal', units: 'celsius' });
    await tick(0);
    expect(calls.surface).toEqual([]);
  });
});

describe('calendar', () => {
  const ics = (startIso: string, extra: string[] = []) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:m1', 'SUMMARY:Design review', `DTSTART:${startIso}`, `DTEND:${startIso.replace('T12', 'T13')}`, ...extra, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  it('turns webcal into https, finds the next event and the Join link, and goes urgent at the start', async () => {
    // now is 12:00:00Z; the meeting is at 12:10:00Z.
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: ics('20260930T121000Z', ['DESCRIPTION:Join: <https://teams.microsoft.com/l/meetup-join/abc123>.']) }));
    const { act, calls } = await boot(new CalendarActivity(), { source: 'ics', ics: 'webcal://calendar.example.com/me.ics', leadMinutes: 15 });
    await tick(0);
    expect(h.native.httpGet).toHaveBeenCalledWith('https://calendar.example.com/me.ics', 4_000_000);
    expect(act.status()).toMatchObject({ active: true, weight: 'background' });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'title')).toMatchObject({ text: 'Design review' });
    expect(segs.find((s) => s.key === 'when')).toMatchObject({ text: 'in 10m' });
    expect(segs.find((s) => s.key === 'join')).toMatchObject({ t: 'button', icon: 'video', label: 'Join' });
    expect(act.render(env('maximum')).find((s) => s.key === 'at')).toBeTruthy();
    smoke(act, 'calendar');
    await tick(1000);
    expect(calls.surface.at(-1)).toMatchObject({ key: expect.stringContaining('soon-') });

    await tick(6 * 60000);
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });
    await tick(4 * 60000 + 1000); // 12:10:01 - started
    expect(act.status().urgent).toMatchObject({ level: 'expanded' });
    expect(act.status().urgent!.key).toMatch(/^start-m1/);
    expect(calls.surface.at(-1)).toMatchObject({ ms: 60000 });
    expect(act.render(env('expanded')).find((s) => s.key === 'when')).toMatchObject({ text: 'now' });
    act.dismiss(act.status().urgent!.key);
    expect(act.status().urgent ?? null).toBe(null);

    await act.action!('join', null);
    expect(h.native.open).toHaveBeenCalledWith('https://teams.microsoft.com/l/meetup-join/abc123');
    expect(calls.close).toBe(1);

    await tick(6 * 60000);
    expect(act.status().active).toBe(false); // started more than five minutes ago
  });

  it('ignores events outside the lead time, all-day events and a bad feed', async () => {
    h.native.httpGet = vi.fn(async () => ({
      status: 200,
      body: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Later', 'DTSTART:20260930T150000Z', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260930', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
    }));
    const { act } = await boot(new CalendarActivity(), { source: 'ics', ics: 'https://x.test/c.ics', leadMinutes: 15 });
    await tick(0);
    expect(act.status().active).toBe(false);

    resetNative();
    h.native.httpGet = vi.fn(async () => ({ status: 404, body: 'nope' }));
    const bad = await boot(new CalendarActivity(), { source: 'ics', ics: 'https://x.test/c.ics', leadMinutes: 15 });
    await tick(0);
    expect(bad.act.status().active).toBe(false);
    await tick(60000);
    expect(h.native.httpGet).toHaveBeenCalledTimes(1); // backs off

    resetNative();
    const empty = await boot(new CalendarActivity(), { source: 'ics', ics: '', leadMinutes: 15 });
    await tick(0);
    expect(h.native.httpGet).not.toHaveBeenCalled();
    expect(empty.act.status().active).toBe(false);
  });

  it('finds Meet and Zoom links and rejects look-alike hosts', async () => {
    const link = async (loc: string) => {
      resetNative();
      h.native.httpGet = vi.fn(async () => ({ status: 200, body: ics('20260930T120500Z', [`LOCATION:${loc}`]) }));
      const { act } = await boot(new CalendarActivity(), { source: 'ics', ics: 'https://x.test/c.ics', leadMinutes: 15 });
      await tick(0);
      return act.render(env('expanded')).some((s) => s.key === 'join');
    };
    expect(await link('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(await link('https://us02web.zoom.us/j/123456789?pwd=x')).toBe(true);
    expect(await link('https://zoom.us.evil.example/j/1')).toBe(false);
    expect(await link('https://evil.example/zoom.us/j/1')).toBe(false);
    expect(await link('Conference room 4')).toBe(false);
  });
});

describe('clipboard', () => {
  it('shows what was copied, honours privacy and skips excluded copies', async () => {
    const { act, calls } = await boot(new ClipboardActivity());
    emit('clipboard', { seq: 1, kind: 'text', text: 'hello   world\nsecond line', files: [], excluded: false });
    expect(calls.surface.at(-1)).toMatchObject({ ms: 2500 });
    let segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'clipboard' });
    expect(segs.find((s) => s.key === 'preview')).toMatchObject({ text: 'hello world second line' });
    smoke(act, 'clipboard text');

    emit('clipboard', { seq: 2, kind: 'text', text: 'https://example.com/a?b=1', files: [], excluded: false });
    segs = act.render(env('maximum'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'link' });
    expect(segs.filter((s) => s.t === 'button').map((s) => s.key)).toEqual(['open', 'history']);
    await act.action!('open', null);
    expect(h.native.open).toHaveBeenCalledWith('https://example.com/a?b=1');
    await act.action!('history', null);
    expect(h.native.clipboardHistory).toHaveBeenCalled();

    emit('clipboard', { seq: 3, kind: 'text', text: 'x'.repeat(500), files: [], excluded: false });
    expect((act.render(env('expanded')).find((s) => s.key === 'preview') as { text: string }).text.length).toBe(60);

    const n = calls.surface.length;
    emit('clipboard', { seq: 4, kind: 'other', text: null, files: [], excluded: true });
    emit('clipboard', { seq: 5, kind: 'text', text: 'hunter2', files: [], excluded: true });
    expect(calls.surface.length).toBe(n);

    emit('clipboard', { seq: 6, kind: 'files', text: null, files: ['a', 'b', 'c'], excluded: false });
    expect(act.render(env('expanded')).find((s) => s.key === 'label')).toMatchObject({ text: 'Copied 3 files' });
    expect(act.render(env('expanded')).find((s) => s.key === 'icon')).toMatchObject({ icon: 'folder' });
    emit('clipboard', { seq: 7, kind: 'image', text: null, files: [], excluded: false });
    expect(act.render(env('expanded')).find((s) => s.key === 'label')).toMatchObject({ text: 'Copied image' });
    expect(act.render(env('expanded')).find((s) => s.key === 'icon')).toMatchObject({ icon: 'image' });
    smoke(act, 'clipboard image');
  });

  it('without the content permission shows only "Copied"', async () => {
    const { act } = await boot(new ClipboardActivity(), {}, (s) => (s.privacy.clipboardContent = false));
    emit('clipboard', { seq: 1, kind: 'text', text: 'https://secret.example/token', files: [], excluded: false });
    const segs = act.render(env('maximum'));
    expect(segs.map((s) => (s.t === 'text' ? s.text : ''))).toContain('Copied');
    expect(JSON.stringify(segs)).not.toContain('secret.example');
    expect(segs.find((s) => s.key === 'open')).toBeUndefined();
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'clipboard' });
    expect(act.status().summary).toBe('Copied');
  });
});

describe('network', () => {
  const net = (over: Record<string, unknown> = {}) => ({ rxBps: 1_200_000, txBps: 80_000, connected: true, internet: true, name: 'Home Wi-Fi', wifi: true, vpn: false, ...over });

  it('reports drops, reconnects and VPN changes, but not the first sample', async () => {
    let next: ReturnType<typeof net> = net();
    h.native.netSample = vi.fn(async () => next);
    const { act, calls } = await boot(new NetworkActivity(), { always: false });
    await tick(0);
    expect(calls.surface).toEqual([]);
    expect(act.status().active).toBe(false);

    next = net({ connected: false, internet: false, rxBps: 0, txBps: 0 });
    await tick(3000); // one bad sample is not enough
    expect(calls.surface).toEqual([]);
    await tick(3000);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'offline' });
    expect(act.status()).toMatchObject({ active: true, weight: 'foreground' });
    expect(act.render(env('expanded')).find((s) => s.key === 'icon')).toMatchObject({ icon: 'wifi-off', tone: 'bad' });
    smoke(act, 'network offline');
    await tick(20000);
    expect(act.status().active).toBe(true); // stays active while offline

    next = net();
    await tick(3000);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'online', ms: 3500 });
    const back = act.render(env('expanded'));
    expect(back.find((s) => s.key === 'icon')).toMatchObject({ icon: 'wifi' });
    expect(back.find((s) => s.key === 'main')).toMatchObject({ text: 'Back online' });
    expect(back.find((s) => s.key === 'name')).toMatchObject({ text: 'Home Wi-Fi' });
    smoke(act, 'network online');
    await tick(4000);
    expect(act.status().active).toBe(false);

    next = net({ vpn: true });
    await tick(3000);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'vpn-on', ms: 3000 });
    expect(act.render(env('expanded')).find((s) => s.key === 'icon')).toMatchObject({ icon: 'shield' });
    next = net({ vpn: false });
    await tick(3000);
    expect(calls.surface.at(-1)).toMatchObject({ key: 'vpn-off' });
  });

  it('always shows the speed', async () => {
    h.native.netSample = vi.fn(async () => net());
    const { act } = await boot(new NetworkActivity(), { always: true });
    await tick(0);
    expect(act.status()).toMatchObject({ active: true, weight: 'background' });
    const texts = act.render(env('expanded')).map((s) => (s.t === 'text' ? s.text : ''));
    expect(texts).toEqual(expect.arrayContaining(['↓ 1.1 MB/s', '↑ 78.1 KB/s']));
    expect(act.render(env('compact')).filter((s) => s.t === 'text')).toHaveLength(1);
    smoke(act, 'network always');
  });
});

describe('servers', () => {
  const row = (port: number, process: string) => ({ port, pid: port, process, address: '127.0.0.1' });

  it('ignores what was running, announces new dev servers and opens them', async () => {
    let rows = [row(5173, 'node.exe'), row(5173, 'node.exe'), row(80, 'node.exe'), row(8080, 'chrome.exe'), row(3306, 'mysqld.exe')];
    h.native.ports = vi.fn(async () => rows);
    const { act, calls } = await boot(new ServersActivity());
    await tick(0);
    expect(calls.surface).toEqual([]);
    expect(act.status()).toMatchObject({ active: true, weight: 'background' });
    expect(act.render(env('expanded')).find((s) => s.key === 'port')).toMatchObject({ text: 'localhost:5173' });

    rows = [...rows, row(8000, 'python.exe'), row(3000, 'bun.exe')];
    await tick(5000);
    expect(calls.surface).toHaveLength(1);
    expect(calls.surface[0]).toMatchObject({ ms: 4000 });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'open')).toMatchObject({ t: 'button', action: 'open' });
    smoke(act, 'servers');
    const chips = act.render(env('maximum')).filter((s) => s.t === 'chip');
    expect(chips.map((c) => (c.t === 'chip' ? c.label : ''))).toEqual(expect.arrayContaining([':5173 node', ':8000 python', ':3000 bun']));
    expect(chips).toHaveLength(3);

    await act.action!('open', 8000);
    expect(h.native.open).toHaveBeenCalledWith('http://localhost:8000');
    await act.action!('open', 'evil');
    await act.action!('open', 80);
    expect(h.native.open).toHaveBeenCalledTimes(1);

    rows = [];
    await tick(5000);
    expect(act.status().active).toBe(false);
  });
});

describe('quick', () => {
  it('never claims the island but offers icon-only actions on the home view', async () => {
    h.native.audioState = vi.fn(async () => ({ volume: 0.5, muted: false, device: null, deviceId: null, micMuted: null, micDevice: null }));
    const { act, calls } = await boot(new QuickActivity());
    expect(act.status()).toEqual({ active: false });
    expect(act.render(env('expanded'))).toEqual([]);
    const home = act.home!(env('maximum'));
    expect(home.map((s) => s.key)).toEqual(['mute', 'snip', 'lock', 'wifi', 'bluetooth', 'focus']);
    for (const s of home) {
      expect(s).toMatchObject({ t: 'button', style: 'ghost' });
      expect((s as { icon?: string }).icon && hasIcon((s as { icon: string }).icon)).toBe(true);
      expect((s as { label?: string }).label).toBeUndefined();
      expect((s as { tip?: string }).tip).toBeTruthy();
    }
    await act.action!('mute', null);
    expect(h.native.audioSet).toHaveBeenLastCalledWith(null, true);
    await act.action!('snip', null);
    expect(h.native.snip).toHaveBeenCalled();
    await act.action!('bluetooth', null);
    expect(h.native.open).toHaveBeenLastCalledWith('ms-settings:bluetooth');
    await act.action!('wifi', null);
    expect(h.native.open).toHaveBeenLastCalledWith('ms-settings:network-wifi');
    await act.action!('focus', null);
    expect(h.native.open).toHaveBeenLastCalledWith('ms-settings:quiethours');
    await act.action!('lock', null);
    expect(h.native.lock).toHaveBeenCalled();
    expect(calls.close).toBe(5); // all but mute close the island

    emit('audio', { volume: 0.5, muted: true, device: null, deviceId: null, micMuted: null, micDevice: null });
    expect(act.home!(env('maximum'))[0]).toMatchObject({ icon: 'speaker-mute', tip: 'Unmute sound' });
  });
});
