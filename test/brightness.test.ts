// The brightness flyout against a fake native layer and context.

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

import { BrightnessActivity, FLASH_MS } from '../src/activities/brightness';
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
  const act = new BrightnessActivity();
  const ctx = {
    id: 'brightness',
    config: () => settings.activities.config.brightness,
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

const texts = (act: BrightnessActivity, e: RenderEnv) => act.render(e).flatMap((s) => (s.t === 'text' ? [s.text] : []));
const icon = (act: BrightnessActivity, e: RenderEnv) => act.render(e).find((s) => s.t === 'icon');

beforeEach(() => {
  vi.useFakeTimers();
  h.bus.clear();
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.native.brightnessGet = vi.fn(async () => 62);
});
afterEach(() => vi.useRealTimers());

describe('brightness', () => {
  it('takes the value at startup as the baseline, then flashes a change', async () => {
    const { act, surface } = await boot();
    expect(surface).toEqual([]);
    expect(act.status().active).toBe(false);
    expect(act.render(env('compact'))).toEqual([]);

    // Windows repeats the current value once at startup: still not news.
    emit('brightness', 62);
    expect(surface).toEqual([]);

    emit('brightness', 70);
    expect(surface.at(-1)).toEqual({ key: 'brightness', ms: FLASH_MS, level: 'expanded' });
    expect(FLASH_MS).toBe(1600);
    expect(act.status()).toMatchObject({ active: true, summary: 'Brightness 70%' });
    expect(icon(act, env('compact'))).toMatchObject({ icon: 'sun' });
    expect(texts(act, env('compact'))).toEqual(['70%']);
    expect(texts(act, env('expanded'))).toEqual(['70%']);
    expect(act.render(env('expanded')).find((s) => s.t === 'progress')).toMatchObject({ value: 0.7 });
    expect(act.pet(Date.now())?.moment).toMatchObject({ id: 'volume-up', key: 'brightness:level' });
    expect(act.render(env('expanded')).some((s) => s.t === 'button')).toBe(false);
    expect(act.render(env('maximum')).some((s) => s.t === 'button')).toBe(false);

    await vi.advanceTimersByTimeAsync(FLASH_MS);
    expect(act.status().active).toBe(false);
  });

  it('takes the first event as the baseline when it comes before the startup read', async () => {
    let release: (v: number | null) => void = () => {};
    h.native.brightnessGet = vi.fn(() => new Promise<number | null>((r) => (release = r)));
    const { act, surface } = await boot();
    emit('brightness', 40);
    expect(surface).toEqual([]);
    release(55);
    await vi.advanceTimersByTimeAsync(0);
    expect(act.tile(sheet)).toMatchObject({ body: { value: '40%' } });

    emit('brightness', 30);
    expect(surface.at(-1)).toMatchObject({ key: 'brightness' });
    expect(texts(act, env('compact'))).toEqual(['30%']);
    expect(icon(act, env('compact'))).toMatchObject({ icon: 'sun-low' });
    expect(act.pet(Date.now())?.moment).toMatchObject({ id: 'volume-down', key: 'brightness:level' });
  });

  it('shows a dimmer sun under 50% and a bigger step bounces the bot higher', async () => {
    const { act } = await boot();
    emit('brightness', 49);
    expect(icon(act, env('expanded'))).toMatchObject({ icon: 'sun-low' });
    emit('brightness', 50);
    expect(icon(act, env('expanded'))).toMatchObject({ icon: 'sun' });
    const small = act.pet(Date.now())?.moment?.strength ?? 0;
    emit('brightness', 100);
    expect(act.pet(Date.now())?.moment?.strength ?? 0).toBeGreaterThan(small);
  });

  it('has a tile only once a value is known, and it does nothing on tap', async () => {
    h.native.brightnessGet = vi.fn(async () => null);
    const { act, surface } = await boot();
    expect(act.tile(sheet)).toBeNull();
    emit('brightness', 62);
    expect(surface).toEqual([]);
    const t = act.tile(sheet);
    expect(t).toMatchObject({ key: 'brightness', body: { k: 'stat', icon: 'sun', label: 'Brightness', value: '62%', progress: 0.62 } });
    expect(t?.action).toBeUndefined();
  });

  it('renders valid segments at every size and on a side edge', async () => {
    const { act } = await boot();
    emit('brightness', 35);
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      for (const vertical of [false, true]) {
        const segs = act.render(env(level, { vertical }));
        expect(segs.length).toBeGreaterThan(0);
        for (const s of segs) if (s.t === 'icon') expect(hasIcon(s.icon)).toBe(true);
        expect(new Set(segs.map((s) => s.key)).size).toBe(segs.length);
        if (vertical) {
          expect(segs.map((s) => s.t)).toEqual(['icon', 'text']);
          fitVertical(segs, 200, 40);
        } else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
      }
    }
  });
});

describe('brightness edge cases', () => {
  it('ignores malformed values from Rust', async () => {
    const { act, surface } = await boot();
    for (const bad of [NaN, null, undefined, 'x', Infinity]) emit('brightness', bad);
    expect(surface).toEqual([]);
    expect(act.tile(sheet)).toMatchObject({ body: { value: '62%' } });
    emit('brightness', 70);
    expect(texts(act, env('compact'))).toEqual(['70%']);
  });

  it('keeps the startup value between 0 and 100', async () => {
    h.native.brightnessGet = vi.fn(async () => 150);
    const { act, surface } = await boot();
    expect(act.tile(sheet)).toMatchObject({ body: { value: '100%', progress: 1 } });
    emit('brightness', 100);
    expect(surface).toEqual([]);
  });

  it('a malformed startup read leaves the first event as the baseline', async () => {
    h.native.brightnessGet = vi.fn(async () => NaN);
    const { act, surface } = await boot();
    expect(act.tile(sheet)).toBeNull();
    emit('brightness', 40);
    expect(surface).toEqual([]);
  });

  it('stays quiet once stopped', async () => {
    const { act, surface } = await boot();
    act.stop();
    emit('brightness', 10);
    expect(surface).toEqual([]);
  });
});
