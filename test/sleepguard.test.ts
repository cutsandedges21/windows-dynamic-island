// "Sleep this PC at 99%": which limit window is due, once per window, and the countdown in the
// island (Stay awake, Sleep now, tapped away). The native layer is faked.

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

import type { ActivityContext, SheetEnv } from '../src/core/activity';
import type { Block, SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { ClaudeActivity } from '../src/activities/claude';
import { markSlept, sleepDue, sleptFor, SLEEP_COUNTDOWN_MS } from '../src/activities/claude/sleepguard';
import type { UsageData } from '../src/activities/claude/usage';

const T0 = Date.parse('2026-10-31T15:00:00Z');
const data = (session: number, week: number): UsageData => ({ fiveHour: { pct: session, resetsAt: T0 + 3_600_000 }, sevenDay: { pct: week, resetsAt: T0 + 86_400_000 }, models: [] });

// The tests run without a browser: a small in-memory localStorage.
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), clear: () => memory.clear() });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, { isTauri: true, demo: false, claudeEnv: vi.fn(async () => null), powerSleep: vi.fn(async () => true), notify: vi.fn(async () => undefined) });
});
afterEach(() => vi.useRealTimers());

describe('which limit window is due', () => {
  it('a window at 99% or more is due once; under it, or already done, none is', () => {
    expect(sleepDue(data(98.9, 50), new Set())).toBeNull();
    expect(sleepDue(data(99, 50), new Set())).toMatchObject({ key: `session:${T0 + 3_600_000}`, label: '5-hour limit' });
    expect(sleepDue(data(40, 100), new Set())).toMatchObject({ label: 'weekly limit' });
    expect(sleepDue(data(99, 50), new Set([`session:${T0 + 3_600_000}`]))).toBeNull();
    expect(sleepDue(null, new Set())).toBeNull();
    // A window just reset (no reset time yet) isn't due.
    expect(sleepDue({ fiveHour: { pct: 100, resetsAt: null }, sevenDay: null, models: [] }, new Set())).toBeNull();
  });

  it('remembers the windows that had their turn across restarts', () => {
    markSlept('session:1');
    markSlept('week:2');
    expect([...sleptFor()].sort()).toEqual(['session:1', 'week:2']);
  });
});

async function boot(options: Record<string, unknown>) {
  const act = new ClaudeActivity();
  const settings = defaultSettings();
  const surfaced: string[] = [];
  const ctx: ActivityContext = {
    id: 'claude', config: () => settings.activities.config.claude, options: () => options as never, settings: () => settings,
    update: () => {}, surface: (o) => void surfaced.push(o?.key ?? ''), alert: () => {}, open: () => {}, close: () => {},
    isOpen: () => false, isPrimary: () => true, notify: () => {}, push: () => {}, log: () => {},
  };
  await act.start(ctx);
  return { act, surfaced };
}
const at99 = (act: ClaudeActivity) => {
  act.usageState = { data: data(99.2, 60), error: null, source: 'api', fetchedAt: T0 };
  (act as unknown as { checkSleep(): void }).checkSleep();
};
const env = (surfaced: string): SheetEnv => ({ reason: 'surfaced', now: Date.now(), width: 480, vertical: false, interactive: true, surfaced });
const head = (v: SheetView | null) => v?.blocks.find((b): b is Extract<Block, { t: 'head' }> => b.t === 'head');

describe('the countdown in the island', () => {
  it('off by default: nothing happens at 99%', async () => {
    const { act, surfaced } = await boot({});
    at99(act);
    await vi.advanceTimersByTimeAsync(SLEEP_COUNTDOWN_MS + 1000);
    expect(surfaced).toEqual([]);
    expect(h.native.powerSleep).not.toHaveBeenCalled();
  });

  it('on: counts down a minute, then sleeps the PC, once for that window', async () => {
    const { act, surfaced } = await boot({ sleepAt99: true });
    at99(act);
    expect(surfaced[0]).toMatch(/^sleep:session:/);
    expect(head(act.sheet!(env(surfaced[0])))?.title).toBe("Claude's 5-hour limit is at 99%");
    await vi.advanceTimersByTimeAsync(SLEEP_COUNTDOWN_MS - 1000);
    expect(h.native.powerSleep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.native.powerSleep).toHaveBeenCalledTimes(1);
    // Woken up, still at 99%: not again for this window.
    at99(act);
    await vi.advanceTimersByTimeAsync(SLEEP_COUNTDOWN_MS + 1000);
    expect(h.native.powerSleep).toHaveBeenCalledTimes(1);
  });

  it('Stay awake cancels it for that window; Sleep now does it at once', async () => {
    const { act } = await boot({ sleepAt99: true });
    at99(act);
    await act.action!('sleep-cancel', null);
    await vi.advanceTimersByTimeAsync(SLEEP_COUNTDOWN_MS + 1000);
    expect(h.native.powerSleep).not.toHaveBeenCalled();

    localStorage.clear();
    const two = await boot({ sleepAt99: true });
    at99(two.act);
    await two.act.action!('sleep-now', null);
    expect(h.native.powerSleep).toHaveBeenCalledTimes(1);
  });

  it('tapping the countdown away keeps the PC awake', async () => {
    const { act, surfaced } = await boot({ sleepAt99: true });
    at99(act);
    act.dismiss!(surfaced[0]);
    await vi.advanceTimersByTimeAsync(SLEEP_COUNTDOWN_MS + 1000);
    expect(h.native.powerSleep).not.toHaveBeenCalled();
  });
});
