// Reminders: reading "what and when" from one line, and a reminder's life: set, due (the island
// and a notification), snoozed, done, kept across a restart.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', () => ({ native: { demo: false, isTauri: true }, on: async () => () => {}, emitLocal: () => {} }));

import type { ActivityContext, RenderEnv, SheetEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';
import type { Block, SheetView } from '../src/core/sheet';
import { parseReminder, RemindersActivity, whenText, type Reminder } from '../src/activities/reminders';

// Tuesday 21 October 2026, 2:00 PM local time.
const NOW = new Date(2026, 9, 21, 14, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0).getTime();
const MIN = 60_000;

const ok = (s: string) => {
  const r = parseReminder(s, NOW);
  if ('error' in r) throw new Error(`${s}: ${r.error}`);
  return r;
};

describe('reading a reminder', () => {
  it('in so long', () => {
    expect(ok('stretch in 20m')).toEqual({ text: 'Stretch', at: NOW + 20 * MIN });
    expect(ok('check the oven in 1h30')).toEqual({ text: 'Check the oven', at: NOW + 90 * MIN });
    expect(ok('in 2 hours call back')).toEqual({ text: 'Call back', at: NOW + 120 * MIN });
    expect(ok('tea in 90 seconds').at).toBe(NOW + 90_000);
  });

  it('at a time of day, tomorrow when it has passed', () => {
    expect(ok('submit the lab at 3pm')).toEqual({ text: 'Submit the lab', at: at(21, 15) });
    expect(ok('remind me to email Ms. Roy at 4:30 pm')).toEqual({ text: 'Email Ms. Roy', at: at(21, 16, 30) });
    expect(ok('meeting 15:45').at).toBe(at(21, 15, 45));
    expect(ok('alarm at 9').at).toBe(at(22, 9));
    expect(ok('lunch at 12pm').at).toBe(at(22, 12));
    expect(ok('night owl at 12am').at).toBe(at(22, 0));
  });

  it('tomorrow, with or without a time', () => {
    expect(ok('call mom tomorrow 9am')).toEqual({ text: 'Call mom', at: at(22, 9) });
    expect(ok('tomorrow at 3pm bring the charger')).toEqual({ text: 'Bring the charger', at: at(22, 15) });
    expect(ok('bring the charger tomorrow')).toEqual({ text: 'Bring the charger', at: at(22, 9) });
  });

  it('numbers that are not times stay in the text', () => {
    expect(ok('buy 2 apples at 5pm')).toEqual({ text: 'Buy 2 apples', at: at(21, 17) });
  });

  it('no time, or nothing but a time', () => {
    expect(parseReminder('buy milk', NOW)).toHaveProperty('error');
    expect(parseReminder('at 25:00', NOW)).toHaveProperty('error');
    expect(ok('in 5 min')).toEqual({ text: 'Reminder', at: NOW + 5 * MIN });
  });

  it('says when like a clock', () => {
    expect(whenText(at(21, 15), NOW)).toMatch(/3:00/);
    expect(whenText(at(22, 9), NOW)).toMatch(/^Tomorrow /);
    expect(whenText(at(24, 9), NOW)).not.toMatch(/Tomorrow|Oct/);
    expect(whenText(at(30, 9), NOW)).toMatch(/Oct/);
  });
});

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheetEnv = (reason: SheetEnv['reason']): SheetEnv => ({ reason, now: Date.now(), width: 420, vertical: false, interactive: true, surfaced: null });
const block = <T extends Block['t']>(view: SheetView | null, t: T, key?: string) => view?.blocks.find((b) => b.t === t && (!key || b.key === key)) as Extract<Block, { t: T }> | undefined;

async function boot(saved: Record<string, unknown> = {}) {
  const settings = defaultSettings();
  const options: Record<string, unknown> = { ...saved };
  const calls = { notify: [] as unknown[][], openCard: 0 };
  const act = new RemindersActivity();
  const ctx: ActivityContext = {
    id: 'reminders',
    config: () => settings.activities.config.reminders,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: () => {},
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: (...a) => void calls.notify.push(a),
    log: () => {},
    setOptions: (patch) => Object.assign(options, patch),
    openCard: () => void calls.openCard++,
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls, options };
}

function smoke(act: RemindersActivity, label: string): void {
  for (const level of ['compact', 'expanded', 'maximum'] as const) {
    for (const vertical of [false, true]) {
      const segs = act.render(env(level, { vertical }));
      for (const s of segs) {
        if (s.t === 'icon') expect(hasIcon(s.icon), `${label}: icon ${s.icon}`).toBe(true);
        if (s.t === 'button') {
          expect(hasIcon(s.icon!), `${label}: button icon`).toBe(true);
          if (vertical) expect(s.label).toBeUndefined();
        }
      }
      if (vertical) fitVertical(segs, 200, 40);
      else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('reminders', () => {
  it('a typed reminder is kept, shown in the tile, and takes the island when due', async () => {
    const { act, calls, options } = await boot();
    expect(act.status().active).toBe(false);
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: 'None' });
    act.action('add', 'stretch in 20m');
    expect((options.items as Reminder[])[0]).toMatchObject({ text: 'Stretch', at: NOW + 20 * MIN });
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: 'Stretch' });
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'rows', 'list')!.items[0]).toMatchObject({ title: 'Stretch' });

    await tick(20 * MIN + 1000);
    expect(act.status()).toMatchObject({ active: true, urgent: { key: expect.stringMatching(/^rem-/) }, summary: 'Stretch' });
    expect(calls.notify).toEqual([['Reminder', 'Stretch']]);
    const segs = act.render(env('expanded'));
    expect(segs.map((s) => s.key)).toEqual(['icon', 'text', 'snooze', 'done']);
    smoke(act, 'due');
    expect(block(act.sheet(sheetEnv('urgent')), 'buttons', 'act')!.items.map((b) => b.key)).toEqual(['hour', 'snooze', 'done']);
  });

  it('snooze brings it back in 10 minutes (or an hour); Done removes it', async () => {
    const { act, calls } = await boot();
    act.action('add', 'tea in 1 min');
    await tick(MIN + 1000);
    const id = (act.render(env('expanded')).find((s) => s.key === 'done') as { arg: string }).arg;
    act.action('snooze', id);
    expect(act.status().active).toBe(false);
    await tick(9 * MIN);
    expect(act.status().active).toBe(false);
    await tick(MIN + 1000);
    expect(act.status().active).toBe(true);
    expect(calls.notify).toHaveLength(2);
    act.action('snooze', [id, 60 * MIN]);
    await tick(30 * MIN);
    expect(act.status().active).toBe(false);
    act.action('done', id);
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: 'None' });
  });

  it('tapped away, it stops holding the island but stays listed until Done', async () => {
    const { act } = await boot();
    act.action('add', 'water plants in 1m');
    await tick(MIN + 1000);
    const key = act.status().urgent!.key;
    act.dismiss(key);
    expect(act.status().active).toBe(false);
    const row = block(act.sheet(sheetEnv('open')), 'rows', 'list')!.items[0];
    expect(row).toMatchObject({ title: 'Water plants', tone: 'warn' });
    expect(row.button).toMatchObject({ action: 'done' });
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: '1 due' });
  });

  it('one that came due while Island was closed shows at start, saying when it was due', async () => {
    const { act, calls } = await boot({ items: [{ id: 'a', text: 'Submit the lab', at: NOW - 30 * MIN }, { id: 'b', text: 'Later', at: NOW + HOUR() }, { junk: true }] });
    expect(act.status()).toMatchObject({ active: true, summary: 'Submit the lab' });
    expect(calls.notify[0][1]).toMatch(/^Submit the lab \(was due /);
    expect(block(act.sheet(sheetEnv('urgent')), 'head')!.sub).toMatch(/^Was due /);
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'list')!.items).toHaveLength(2);
  });

  it('a line without a time says how to write one, and adds nothing', async () => {
    const { act, options } = await boot();
    act.action('add', 'buy milk');
    expect(block(act.sheet(sheetEnv('open')), 'text', 'note')!.text).toMatch(/in 20 min/);
    expect(options.items).toBeUndefined();
    act.action('add', 'buy milk at 6pm');
    expect(block(act.sheet(sheetEnv('open')), 'text', 'note')).toBeUndefined();
  });

  it('the tile opens its card', async () => {
    const { act, calls } = await boot();
    expect(act.tile(sheetEnv('open'))!.action).toBe('card');
    act.action('card', undefined);
    expect(calls.openCard).toBe(1);
  });
});

function HOUR(): number {
  return 60 * MIN;
}
