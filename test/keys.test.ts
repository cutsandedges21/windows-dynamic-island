// Caps Lock and Num Lock flashes against a fake native layer and context.

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

import { FLASH_MS, KeysActivity } from '../src/activities/keys';
import type { ActivityContext, RenderEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};

const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });

async function boot(options: Record<string, unknown> = {}) {
  const settings = defaultSettings();
  const surface: Array<{ key?: string; ms?: number; level?: string }> = [];
  const act = new KeysActivity();
  const ctx = {
    id: 'keys',
    config: () => settings.activities.config.keys,
    options: () => options,
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

const texts = (act: KeysActivity, e: RenderEnv) => act.render(e).flatMap((s) => (s.t === 'text' ? [s.text] : []));

beforeEach(() => {
  vi.useFakeTimers();
  h.bus.clear();
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.native.lockKeys = vi.fn(async () => ({ caps: false, num: true }));
});
afterEach(() => vi.useRealTimers());

describe('lock keys', () => {
  it('flashes Caps Lock turning on and off, and not the state at startup', async () => {
    const { act, surface } = await boot();
    expect(surface).toEqual([]);
    expect(act.status().active).toBe(false);

    emit('lock-keys', { caps: true, num: true });
    expect(surface.at(-1)).toMatchObject({ key: 'caps', ms: FLASH_MS, level: 'expanded' });
    expect(act.status()).toMatchObject({ active: true, summary: 'Caps Lock on' });
    expect(act.render(env('compact')).find((s) => s.t === 'icon')).toMatchObject({ icon: 'capslock', tone: 'accent' });
    expect(texts(act, env('compact'))).toEqual(['Caps Lock on']);
    expect(texts(act, env('expanded'))).toEqual(['Caps Lock', 'On']);

    emit('lock-keys', { caps: false, num: true });
    expect(act.status()).toMatchObject({ summary: 'Caps Lock off' });
    expect(act.render(env('expanded')).find((s) => s.t === 'icon')).toMatchObject({ tone: 'muted' });

    await vi.advanceTimersByTimeAsync(FLASH_MS);
    expect(act.status().active).toBe(false);
  });

  it('flashes Num Lock, and each can be turned off', async () => {
    const { act, surface } = await boot({ caps: false });
    emit('lock-keys', { caps: true, num: true });
    expect(surface).toEqual([]);
    emit('lock-keys', { caps: true, num: false });
    expect(surface.at(-1)).toMatchObject({ key: 'num' });
    expect(texts(act, env('compact'))).toEqual(['Num Lock off']);

    const quiet = await boot({ num: false });
    emit('lock-keys', { caps: false, num: false });
    expect(quiet.surface).toEqual([]);
  });

  it('renders valid segments at every size and on a side edge', async () => {
    const { act } = await boot();
    emit('lock-keys', { caps: true, num: true });
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      for (const vertical of [false, true]) {
        const segs = act.render(env(level, { vertical }));
        for (const s of segs) if (s.t === 'icon') expect(hasIcon(s.icon)).toBe(true);
        expect(new Set(segs.map((s) => s.key)).size).toBe(segs.length);
        if (vertical) fitVertical(segs, 200, 40);
        else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
      }
    }
  });
});
