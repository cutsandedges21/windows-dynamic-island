// Bluetooth battery in the Devices activity, against a fake native layer and context.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), native: {} as Record<string, any>, list: [] as any[] }));

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

import { BT_FLASH_MS, BT_POLL_MS, BT_SETTLE_MS, DevicesActivity } from '../src/activities/devices';
import type { ActivityContext, RenderEnv, SheetEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};

const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheet = { interactive: true } as unknown as SheetEnv;

async function boot() {
  const settings = defaultSettings();
  const surface: Array<{ key?: string; ms?: number; level?: string }> = [];
  const act = new DevicesActivity();
  const ctx = {
    id: 'devices',
    config: () => settings.activities.config.devices,
    options: () => ({}),
    settings: () => settings,
    update: () => {},
    surface: (o?: { key?: string; ms?: number; level?: string }) => void surface.push(o ?? {}),
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: () => {},
  } as unknown as ActivityContext;
  await act.start(ctx);
  await vi.advanceTimersByTimeAsync(0);
  return { act, surface };
}

const texts = (act: DevicesActivity, e: RenderEnv) => act.render(e).flatMap((s) => (s.t === 'text' ? [s.text] : []));
const set = (...l: Array<[string, number, boolean]>) => (h.list = l.map(([name, percent, connected]) => ({ name, percent, connected })));

beforeEach(() => {
  vi.useFakeTimers();
  h.bus.clear();
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.list = [];
  h.native.btBatteries = vi.fn(async () => h.list);
});
afterEach(() => vi.useRealTimers());

describe('bluetooth battery', () => {
  it('flashes headphones the sound switches to, but not a phone that comes and goes', async () => {
    set(['Moss', 64, false], ['Crusher ANC 2', 60, false]);
    const { act, surface } = await boot();
    set(['Moss', 64, true], ['Crusher ANC 2', 60, false]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(surface).toEqual([]);
    expect(act.tile(sheet)?.body).toMatchObject({ icon: 'bluetooth' });

    set(['Moss', 64, true], ['Crusher ANC 2', 60, true]);
    emit('audio', { deviceId: 'a', volume: 0.5, muted: false, device: 'Speakers (Realtek)', micMuted: null, micDevice: null });
    emit('audio', { deviceId: 'b', volume: 0.5, muted: false, device: 'Headphones (Crusher ANC 2 Stereo)', micMuted: null, micDevice: null });
    await vi.advanceTimersByTimeAsync(BT_SETTLE_MS);
    expect(surface.map((x) => x.key)).toEqual(['bt:in:Crusher ANC 2']);
    expect(act.render(env('expanded')).find((x) => x.t === 'icon')).toMatchObject({ icon: 'headphones' });
  });

  it('flashes a device that connects, not the ones there at startup', async () => {
    set(['Mouse', 70, true]);
    const { act, surface } = await boot();
    expect(surface).toEqual([]);

    set(['Mouse', 70, true], ['AirPods Pro', 80, true]);
    emit('audio', { deviceId: 'a', volume: 0.5, muted: false, device: 'Speakers', micMuted: null, micDevice: null });
    emit('audio', { deviceId: 'b', volume: 0.5, muted: false, device: 'AirPods Pro', micMuted: null, micDevice: null });
    await vi.advanceTimersByTimeAsync(BT_SETTLE_MS);
    expect(surface.at(-1)).toMatchObject({ key: 'bt:in:AirPods Pro', ms: BT_FLASH_MS, level: 'expanded' });
    expect(act.status()).toMatchObject({ active: true, summary: 'AirPods Pro 80%' });
    expect(texts(act, env('expanded'))).toEqual(['AirPods Pro', '80%']);
    expect(act.render(env('compact')).find((s) => s.t === 'icon')).toMatchObject({ icon: 'headphones' });

    await vi.advanceTimersByTimeAsync(BT_FLASH_MS);
    expect(act.status().active).toBe(false);
  });

  it('warns once when low, again only after going above 30%', async () => {
    set(['AirPods Pro', 50, true]);
    const { act, surface } = await boot();
    set(['AirPods Pro', 20, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(surface.length).toBe(1);
    expect(surface[0]).toMatchObject({ key: 'bt:low:AirPods Pro' });
    expect(act.render(env('expanded')).find((s) => s.t === 'icon')).toMatchObject({ tone: 'warn' });

    set(['AirPods Pro', 15, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    set(['AirPods Pro', 25, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    set(['AirPods Pro', 10, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(surface.length).toBe(1);

    set(['AirPods Pro', 40, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    set(['AirPods Pro', 18, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(surface.length).toBe(2);
  });

  it('lists connected devices in the tile, and nothing for disconnected ones', async () => {
    set(['AirPods Pro', 80, true], ['Keyboard', 55, true], ['Old Headset', 30, false]);
    const { act, surface } = await boot();
    const tile = act.tile(sheet)!;
    expect(tile.body).toMatchObject({ k: 'list', label: 'Devices' });
    const rows = (tile.body as any).rows;
    expect(rows.map((r: any) => [r.title, r.badge, r.icon])).toEqual([
      ['AirPods Pro', '80%', 'headphones'],
      ['Keyboard', '55%', 'bluetooth'],
    ]);

    set(['Old Headset', 30, false]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(act.tile(sheet)).toBeNull();
    expect(surface).toEqual([]);
  });

  it('renders valid segments at every size and on a side edge', async () => {
    set(['AirPods Pro', 12, true]);
    const { act } = await boot();
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      for (const vertical of [false, true]) {
        const segs = act.render(env(level, { vertical }));
        expect(segs.length).toBeGreaterThan(0);
        for (const s of segs) if (s.t === 'icon') expect(hasIcon(s.icon)).toBe(true);
        expect(new Set(segs.map((s) => s.key)).size).toBe(segs.length);
        if (vertical) fitVertical(segs, 200, 40);
        else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
      }
    }
  });

  it('flashes a device that reconnects still low in the warning colour, without a second warning', async () => {
    set(['AirPods Pro', 15, true]);
    const { act, surface } = await boot();
    expect(surface.length).toBe(1);
    set(['AirPods Pro', 15, false]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    set(['AirPods Pro', 15, true]);
    await vi.advanceTimersByTimeAsync(BT_POLL_MS);
    expect(surface.length).toBe(2);
    expect(act.render(env('expanded')).find((s) => s.t === 'icon')).toMatchObject({ tone: 'warn' });
  });

  it('stays quiet on a failing native call, a same-device audio event and no device id', async () => {
    h.native.btBatteries = vi.fn(async () => {
      throw new Error('boom');
    });
    const { act, surface } = await boot();
    expect(act.tile(sheet)).toBeNull();
    h.native.btBatteries = vi.fn(async () => h.list);
    set(['AirPods Pro', 80, true]);
    emit('audio', { deviceId: 'a', volume: 0.5, muted: false, device: 'x', micMuted: null, micDevice: null });
    emit('audio', { deviceId: 'a', volume: 0.6, muted: false, device: 'x', micMuted: null, micDevice: null });
    emit('audio', { deviceId: null, volume: 0.6, muted: false, device: 'x', micMuted: null, micDevice: null });
    await vi.advanceTimersByTimeAsync(BT_SETTLE_MS);
    expect(h.native.btBatteries).not.toHaveBeenCalled();
    expect(surface).toEqual([]);
  });
});
