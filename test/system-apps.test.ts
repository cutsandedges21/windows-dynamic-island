// System Stats' hover card: clicking a bar lists the apps using the most of it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({
  native: h.native,
  on: async () => () => {},
  emitLocal: () => {},
}));

import type { ActivityContext } from '../src/core/activity';
import type { Block } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { SystemActivity } from '../src/activities/system';

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot(options: Record<string, unknown>) {
  const settings = defaultSettings();
  const act = new SystemActivity();
  const ctx: ActivityContext = {
    id: 'system',
    config: () => settings.activities.config.system,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: () => {},
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: () => {},
  };
  await act.start(ctx);
  await tick(0);
  return act;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-04T12:00:00Z'));
  for (const k of Object.keys(h.native)) delete h.native[k];
  Object.assign(h.native, {
    sysSample: vi.fn(async () => ({ cpu: 42, memUsed: 8e9, memTotal: 16e9, gpu: 12, top: null })),
    sysTop: vi.fn(async (kind: string) => [
      { name: 'Google Chrome', exe: 'chrome.exe', value: kind === 'mem' ? 4e9 : 23.4, count: 24 },
      { name: 'Code', exe: 'code.exe', value: kind === 'mem' ? 1e9 : 3.42, count: 1 },
    ]),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('system: what uses the most', () => {
  it('clicking a bar lists its apps under it, fresh while the card is open', async () => {
    const act = await boot({ always: true });
    await tick(1000);
    const card = () => act.sheet({ reason: 'hover', now: Date.now(), width: 300, vertical: false, interactive: true, surfaced: null })!;
    const keys = () => card().blocks.map((b) => b.key);
    const block = (key: string) => card().blocks.find((b) => b.key === key) as Block;

    const meters = card().blocks.flatMap((b) => (b.t === 'meter' ? [[b.action, b.arg]] : []));
    expect(meters).toEqual([['focus', 'cpu'], ['focus', 'mem'], ['focus', 'gpu']]);

    act.action('focus', 'mem');
    expect(keys()).toEqual(['head', 'cpu', 'mem', 'apps-mem', 'gpu']);
    expect(block('apps-mem')).toMatchObject({ t: 'text', text: 'Checking…' });
    await tick(0);
    expect(h.native.sysTop).toHaveBeenLastCalledWith('mem', 5);
    expect(block('apps-mem')).toMatchObject({
      t: 'rows',
      items: [
        { title: 'Google Chrome', tip: 'chrome.exe · 24 processes', bar: { value: 0.25, text: '3.7 GB' } },
        { title: 'Code', tip: 'code.exe', bar: { value: 1 / 16 } },
      ],
    });

    act.action('focus', 'cpu'); // another bar: its list instead
    await tick(0);
    expect(keys()).toEqual(['head', 'cpu', 'apps-cpu', 'mem', 'gpu']);
    expect(block('apps-cpu')).toMatchObject({ items: [{ bar: { text: '23%', value: 23.4 / 100 } }, { bar: { text: '3.4%' } }] });

    const asked = h.native.sysTop.mock.calls.length;
    card();
    await tick(2000); // refreshed while the card is shown
    expect(h.native.sysTop.mock.calls.length).toBeGreaterThan(asked);

    act.action('focus', 'cpu'); // the same bar again closes it
    expect(keys()).toEqual(['head', 'cpu', 'mem', 'gpu']);
  });

  it('closes the list and stops asking once the card is gone', async () => {
    const act = await boot({ always: true });
    await tick(1000);
    const card = () => act.sheet({ reason: 'hover', now: Date.now(), width: 300, vertical: false, interactive: true, surfaced: null })!;
    card();
    act.action('focus', 'gpu');
    await tick(6000); // no card asked for since
    const asked = h.native.sysTop.mock.calls.length;
    await tick(6000);
    expect(h.native.sysTop.mock.calls.length).toBe(asked);
    expect(card().blocks.map((b) => b.key)).toEqual(['head', 'cpu', 'mem', 'gpu']);
  });

  it('says so when no app uses the GPU, and ignores unknown bars', async () => {
    h.native.sysTop = vi.fn(async () => []);
    const act = await boot({ always: true });
    await tick(1000);
    const card = () => act.sheet({ reason: 'hover', now: Date.now(), width: 300, vertical: false, interactive: true, surfaced: null })!;
    act.action('focus', 'disk');
    expect(card().blocks.map((b) => b.key)).toEqual(['head', 'cpu', 'mem', 'gpu']);
    act.action('focus', 'gpu');
    await tick(0);
    expect(card().blocks.find((b) => b.key === 'apps-gpu')).toMatchObject({ t: 'text', text: 'No app is using the GPU' });
  });
});
