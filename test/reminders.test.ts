// Reminders and notes: reading "what and when" from one line, a reminder's life (set, handed to
// Windows, due on the island, snoozed, done, kept across a restart), notes and their editor, and
// what the bot does with "remind me…" and "note: …".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: { demo: false, isTauri: true } as Record<string, any> }));
vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import type { ActivityContext, RenderEnv, SheetEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';
import type { Block, SheetView } from '../src/core/sheet';
import { bodyOf, botAsk, dueText, parseReminder, RemindersActivity, titleOf, whenText, type Reminder } from '../src/activities/reminders';

// Wednesday 21 October 2026, 2:00 PM local time.
const NOW = new Date(2026, 9, 21, 14, 0, 0).getTime();
const at = (d: number, h: number, m = 0, month = 9, year = 2026) => new Date(year, month, d, h, m, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const ok = (s: string, now = NOW) => {
  const r = parseReminder(s, now);
  if ('error' in r) throw new Error(`${s}: ${r.error}`);
  return r;
};

describe('reading a reminder', () => {
  it('in so long', () => {
    expect(ok('stretch in 20m')).toEqual({ text: 'Stretch', at: NOW + 20 * MIN });
    expect(ok('check the oven in 1h30')).toEqual({ text: 'Check the oven', at: NOW + 90 * MIN });
    expect(ok('in 2 hours call back')).toEqual({ text: 'Call back', at: NOW + 120 * MIN });
    expect(ok('tea in 90 seconds').at).toBe(NOW + 90_000);
    expect(ok('move the car in an hour')).toEqual({ text: 'Move the car', at: NOW + HOUR });
    expect(ok('pizza in half an hour').at).toBe(NOW + 30 * MIN);
    expect(ok('in 2 hours and 15 minutes leave').at).toBe(NOW + 135 * MIN);
    expect(ok('water the plants in 3 days').at).toBe(NOW + 72 * HOUR);
    expect(ok('renew the pass in 2 weeks').at).toBe(NOW + 14 * 24 * HOUR);
  });

  it('in some days, at a time', () => {
    expect(ok('dentist in 2 days at 3pm')).toEqual({ text: 'Dentist', at: at(23, 15) });
  });

  it('at a time of day, tomorrow when it has passed', () => {
    expect(ok('submit the lab at 3pm')).toEqual({ text: 'Submit the lab', at: at(21, 15) });
    expect(ok('remind me to email Ms. Roy at 4:30 pm')).toEqual({ text: 'Email Ms. Roy', at: at(21, 16, 30) });
    expect(ok('meeting 15:45').at).toBe(at(21, 15, 45));
    expect(ok('meeting 15h30').at).toBe(at(21, 15, 30));
    expect(ok('lunch at 12pm').at).toBe(at(22, 12));
    expect(ok('night owl at 12am').at).toBe(at(22, 0));
    expect(ok('lunch at noon').at).toBe(at(22, 12));
    expect(ok('lock up at midnight').at).toBe(at(22, 0));
  });

  it('a bare hour: 1 to 6 in the afternoon, 7 to 11 whichever comes first', () => {
    expect(ok('call mom at 5').at).toBe(at(21, 17));
    expect(ok('call mom at 3', at(21, 16)).at).toBe(at(22, 15));
    expect(ok('alarm at 9').at).toBe(at(21, 21));
    expect(ok('alarm at 9', at(21, 8)).at).toBe(at(21, 9));
    expect(ok('alarm at 9', at(21, 22)).at).toBe(at(22, 9));
    expect(ok('alarm at 9:30').at).toBe(at(21, 21, 30));
    expect(ok('call mom tomorrow at 5').at).toBe(at(22, 17));
    expect(ok('gym tomorrow at 9').at).toBe(at(22, 9));
    expect(ok('read tomorrow morning at 6').at).toBe(at(22, 6));
    expect(ok('movie tonight at 9').at).toBe(at(21, 21));
  });

  it('parts of the day', () => {
    expect(ok('take out the trash tonight')).toEqual({ text: 'Take out the trash', at: at(21, 20) });
    expect(ok('stretch tomorrow morning')).toEqual({ text: 'Stretch', at: at(22, 9) });
    expect(ok('call grandma tomorrow evening').at).toBe(at(22, 18));
    expect(ok('groceries this evening').at).toBe(at(21, 18));
  });

  it('tomorrow and later days, with or without a time', () => {
    expect(ok('call mom tomorrow 9am')).toEqual({ text: 'Call mom', at: at(22, 9) });
    expect(ok('tomorrow at 3pm bring the charger')).toEqual({ text: 'Bring the charger', at: at(22, 15) });
    expect(ok('bring the charger tomorrow')).toEqual({ text: 'Bring the charger', at: at(22, 9) });
    expect(ok('bring the charger tmrw')).toEqual({ text: 'Bring the charger', at: at(22, 9) });
    expect(ok('pay rent the day after tomorrow').at).toBe(at(23, 9));
    expect(ok('review notes next week').at).toBe(at(28, 9));
  });

  it('days of the week', () => {
    expect(ok('dentist friday 3pm')).toEqual({ text: 'Dentist', at: at(23, 15) });
    expect(ok('dentist fri 3pm')).toEqual({ text: 'Dentist', at: at(23, 15) });
    expect(ok('soccer on monday').at).toBe(at(26, 9));
    expect(ok('club wednesday 5pm').at).toBe(at(21, 17));
    expect(ok('club wednesday 9am').at).toBe(at(28, 9));
    expect(ok('club next wednesday').at).toBe(at(28, 9));
    // "sat" alone is a word, not Saturday.
    expect(ok('sat down with Ana at 3pm')).toEqual({ text: 'Sat down with Ana', at: at(21, 15) });
  });

  it('dates', () => {
    expect(ok('essay due oct 30')).toEqual({ text: 'Essay due', at: at(30, 9) });
    expect(ok('exam on 30 oct at 5pm').at).toBe(at(30, 17));
    expect(ok('exam on the 30th of october').at).toBe(at(30, 9));
    expect(ok('renew passport jan 5').at).toBe(at(5, 9, 0, 0, 2027));
    expect(ok('birthday oct 20').at).toBe(at(20, 9, 0, 9, 2027));
    expect(parseReminder('party feb 30', NOW)).toHaveProperty('error');
  });

  it('keeps the words around the time as the reminder', () => {
    expect(ok('remind me to call mom tomorrow at 5').text).toBe('Call mom');
    expect(ok('set a reminder for friday at 3pm to submit the essay').text).toBe('Submit the essay');
    expect(ok('remind me that the lab is due tomorrow').text).toBe('The lab is due');
    expect(ok('remind me about the meeting in 10 min').text).toBe('The meeting');
    expect(ok('buy 2 apples at 5pm')).toEqual({ text: 'Buy 2 apples', at: at(21, 17) });
    expect(ok('room 204 at 3pm').text).toBe('Room 204');
  });

  it('says when it repeats, setting it once', () => {
    expect(ok('take meds every day at 9pm')).toEqual({ text: 'Take meds every day', at: at(21, 21), repeats: true });
  });

  it('crosses the end of daylight saving time on the clock', () => {
    // Clocks go back on Sunday 1 November 2026.
    expect(ok('call mom tomorrow 9am', at(31, 14)).at).toBe(new Date(2026, 10, 1, 9).getTime());
  });

  it('no time, or nothing but a time', () => {
    expect(parseReminder('buy milk', NOW)).toHaveProperty('error');
    expect(parseReminder('buy milk today', NOW)).toHaveProperty('error');
    expect(parseReminder('remind me', NOW)).toHaveProperty('error');
    expect(parseReminder('at 25:00', NOW)).toHaveProperty('error');
    expect(ok('in 5 min')).toEqual({ text: 'Reminder', at: NOW + 5 * MIN });
  });

  it('says when like a clock, and in a sentence', () => {
    expect(whenText(at(21, 15), NOW)).toBe('3:00 PM');
    expect(whenText(at(22, 9), NOW)).toBe('Tomorrow 9:00 AM');
    expect(whenText(at(24, 9), NOW)).toBe('Sat 9:00 AM');
    expect(whenText(at(30, 9), NOW)).toBe('Oct 30 9:00 AM');
    expect(dueText(NOW + 20 * MIN, NOW)).toBe('in 20 min (2:20 PM)');
    expect(dueText(at(21, 17), NOW)).toBe('today at 5:00 PM');
    expect(dueText(at(22, 9), NOW)).toBe('tomorrow at 9:00 AM');
    expect(dueText(at(23, 15), NOW)).toBe('Friday at 3:00 PM');
    expect(dueText(at(30, 9), NOW)).toBe('Oct 30 at 9:00 AM');
  });

  it('a title and a note from the lines', () => {
    expect(titleOf('\n Essay outline \n- intro\n- body')).toBe('Essay outline');
    expect(bodyOf('\n Essay outline \n- intro\n- body')).toBe('- intro\n- body');
    expect(bodyOf('One line')).toBe('');
  });
});

describe('what the bot is asked', () => {
  it('reminders', () => {
    expect(botAsk('remind me tomorrow 9am to call mom')).toEqual({ kind: 'remind', what: 'tomorrow 9am to call mom' });
    expect(botAsk('Can you remind me to stretch in 20 min?')).toEqual({ kind: 'remind', what: 'to stretch in 20 min?' });
    expect(botAsk('please set a reminder for friday 3pm: dentist')).toEqual({ kind: 'remind', what: 'for friday 3pm: dentist' });
    expect(botAsk('Reminder: dentist friday 3pm')).toEqual({ kind: 'remind', what: 'dentist friday 3pm' });
  });

  it('notes', () => {
    expect(botAsk('note: locker 1234')).toEqual({ kind: 'note', what: 'locker 1234' });
    expect(botAsk('take a note that the wifi password is abc')).toEqual({ kind: 'note', what: 'the wifi password is abc' });
    expect(botAsk('write this down: buy milk')).toEqual({ kind: 'note', what: 'buy milk' });
    expect(botAsk('remember that my locker is 1234')).toEqual({ kind: 'remember', what: 'my locker is 1234' });
  });

  it('lists', () => {
    expect(botAsk('what are my reminders?')).toEqual({ kind: 'reminders' });
    expect(botAsk('show my reminders')).toEqual({ kind: 'reminders' });
    expect(botAsk('any reminders')).toEqual({ kind: 'reminders' });
    expect(botAsk('show me my notes')).toEqual({ kind: 'notes' });
  });

  it('leaves everything else to the model', () => {
    expect(botAsk('what is a reminder?')).toBeNull();
    expect(botAsk('how do I remember formulas better')).toBeNull();
    expect(botAsk('capital of Canada?')).toBeNull();
    expect(botAsk('write a poem about notes')).toBeNull();
  });
});

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheetEnv = (reason: SheetEnv['reason']): SheetEnv => ({ reason, now: Date.now(), width: 420, vertical: false, interactive: true, surfaced: null });
const block = <T extends Block['t']>(view: SheetView | null, t: T, key?: string) => view?.blocks.find((b) => b.t === t && (!key || b.key === key)) as Extract<Block, { t: T }> | undefined;
const items = (options: Record<string, unknown>) => (options.items ?? []) as Reminder[];

/** What Windows holds, as the fake native layer was last told. */
let windows: Array<{ id: string; title: string; body: string; at: number }> = [];

async function boot(saved: Record<string, unknown> = {}, over: { windowsTakes?: boolean } = {}) {
  const settings = defaultSettings();
  const options: Record<string, unknown> = { ...saved };
  const calls = { notify: [] as unknown[][], push: [] as unknown[][], openCard: 0 };
  windows = [];
  h.native.remindersSchedule = async (list: typeof windows) => {
    windows = list;
    return over.windowsTakes === false ? [] : list.map((x) => x.id);
  };
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
    push: (...a) => void calls.push.push(a),
    log: () => {},
    setOptions: (patch) => Object.assign(options, patch),
    openCard: () => void calls.openCard++,
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls, options, settings };
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

/** Every icon a card shows exists. */
function iconsExist(view: SheetView | null): void {
  for (const b of view?.blocks ?? []) {
    if (b.t === 'head' && b.icon) expect(hasIcon(b.icon), `head icon ${b.icon}`).toBe(true);
    const buttons = b.t === 'buttons' ? b.items : b.t === 'head' ? (b.buttons ?? []) : [];
    for (const x of buttons) if (x.icon) expect(hasIcon(x.icon), `button icon ${x.icon}`).toBe(true);
    if (b.t === 'rows') for (const r of b.items) if (r.icon) expect(hasIcon(r.icon), `row icon ${r.icon}`).toBe(true);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('reminders', () => {
  it('a typed reminder is kept, handed to Windows, shown in the tile, and takes the island when due', async () => {
    const { act, calls, options } = await boot();
    expect(act.status().active).toBe(false);
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: 'None' });
    act.action('add', 'stretch in 20m');
    expect(items(options)[0]).toMatchObject({ text: 'Stretch', at: NOW + 20 * MIN });
    await tick(0);
    expect(windows).toEqual([{ id: items(options)[0].id, title: 'Stretch', body: 'Reminder · 2:20 PM', at: NOW + 20 * MIN }]);
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: 'Stretch' });
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'rows', 'list')!.items[0]).toMatchObject({ title: 'Stretch' });
    iconsExist(card);

    await tick(20 * MIN + 1000);
    expect(act.status()).toMatchObject({ active: true, urgent: { key: expect.stringMatching(/^rem-/) }, summary: 'Stretch' });
    // Windows showed it itself: Island only tells the phones.
    expect(calls.notify).toEqual([]);
    expect(calls.push).toEqual([['Stretch', 'Reminder', { tag: 'bell', priority: 4 }]]);
    expect(windows).toEqual([]);
    const segs = act.render(env('expanded'));
    expect(segs.map((s) => s.key)).toEqual(['icon', 'text', 'snooze', 'done']);
    smoke(act, 'due');
    const due = act.sheet(sheetEnv('urgent'));
    expect(block(due, 'buttons', 'act')!.items.map((b) => b.key)).toEqual(['hour', 'snooze', 'done']);
    iconsExist(due);
  });

  it('notifies by itself when Windows could not take it, or Island saw it late', async () => {
    const { act, calls } = await boot({}, { windowsTakes: false });
    act.action('add', 'tea in 1 min');
    await tick(MIN + 1000);
    expect(calls.notify).toEqual([['Tea', 'Reminder']]);
    const late = await boot({ items: [{ id: 'a', text: 'Submit the lab', at: NOW - 30 * MIN }] });
    expect(late.calls.notify[0][0]).toBe('Submit the lab');
    expect(late.calls.notify[0][1]).toMatch(/^Was due /);
  });

  it('gives Windows nothing while Windows notifications are off', async () => {
    const { act, settings } = await boot();
    settings.general.notifications = false;
    act.action('add', 'stretch in 20m');
    await tick(1000);
    expect(windows).toEqual([]);
  });

  it('snooze brings it back in 10 minutes (or an hour); Done removes it', async () => {
    const { act, calls, options } = await boot({}, { windowsTakes: false });
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
    expect(items(options)).toEqual([]);
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
    const { act } = await boot({ items: [{ id: 'a', text: 'Submit the lab', at: NOW - 30 * MIN }, { id: 'b', text: 'Later', at: NOW + HOUR }, { junk: true }, { id: 'c', text: 'Stray' }] });
    expect(act.status()).toMatchObject({ active: true, summary: 'Submit the lab' });
    expect(block(act.sheet(sheetEnv('urgent')), 'head')!.sub).toMatch(/^Was due /);
    // The junk and a timeless non-note go; the two reminders stay.
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'list')!.items).toHaveLength(2);
  });

  it('a due reminder shows its note', async () => {
    const { act } = await boot({ items: [{ id: 'a', text: 'Submit the lab\nRoom 204, bring the USB key', at: NOW + MIN }] });
    await tick(MIN + 1000);
    expect(act.render(env('expanded')).find((s) => s.key === 'text')).toMatchObject({ text: 'Submit the lab' });
    const due = act.sheet(sheetEnv('urgent'));
    expect(block(due, 'head')!.title).toBe('Submit the lab');
    expect(block(due, 'text', 'note')!.text).toBe('Room 204, bring the USB key');
  });

  it('a line without a time becomes a note, and says so', async () => {
    const { act, options } = await boot();
    act.action('add', 'buy milk');
    expect(items(options)).toEqual([expect.objectContaining({ text: 'Buy milk', note: true })]);
    expect(items(options)[0].at).toBeUndefined();
    expect(block(act.sheet(sheetEnv('open')), 'text', 'notice')!.text).toMatch(/Notes/);
    act.action('add', 'buy milk at 6pm');
    expect(block(act.sheet(sheetEnv('open')), 'text', 'notice')).toBeUndefined();
    expect(items(options)).toHaveLength(2);
  });

  it('the tile, and the right-click menu, open the card on Reminders', async () => {
    const { act, calls } = await boot();
    expect(act.tile(sheetEnv('open'))!.action).toBe('card');
    act.action('tab', 'notes');
    act.action('card', undefined);
    expect(calls.openCard).toBe(1);
    expect(block(act.sheet(sheetEnv('open')), 'input', 'add')).toBeDefined();
  });
});

describe('notes', () => {
  it('are written in the Notes tab, newest first, and stay until deleted', async () => {
    const { act, options } = await boot();
    act.action('tab', 'notes');
    act.action('note-add', 'Locker code 1234');
    await tick(5 * MIN);
    act.action('note-add', 'Physics: ch. 4, problems 1-10');
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'buttons', 'tabs')!.items.map((b) => [b.key, b.style])).toEqual([['reminders', 'ghost'], ['notes', 'secondary']]);
    const rows = block(card, 'rows', 'list')!.items;
    expect(rows.map((r) => r.title)).toEqual(['Physics: ch. 4, problems 1-10', 'Locker code 1234']);
    expect(rows[1].detail).toBe('5m ago');
    iconsExist(card);
    // Notes never take the island and don't go to Windows.
    await tick(HOUR);
    expect(act.status().active).toBe(false);
    expect(windows).toEqual([]);
    act.action('delete', rows[0].arg);
    expect(items(options).map((n) => n.text)).toEqual(['Locker code 1234']);
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: '1 note' });
  });

  it('open in an editor that saves as you type, can get a time, and keeps the note after Done', async () => {
    const { act, options } = await boot();
    act.action('note-add', 'Essay outline');
    const id = items(options)[0].id;
    act.action('open', id);
    let ed = act.sheet(sheetEnv('open'))!;
    const box = block(ed, 'input', `text-${id}`)!;
    expect(box).toMatchObject({ lines: 6, value: 'Essay outline', change: `text:${id}` });
    iconsExist(ed);
    act.action(`text:${id}`, 'Essay outline\n- intro\n- body');
    expect(items(options)[0].text).toBe('Essay outline\n- intro\n- body');

    act.action('when', [id, 'in 1 hour']);
    expect(items(options)[0].at).toBe(NOW + HOUR);
    ed = act.sheet(sheetEnv('open'))!;
    expect(block(ed, 'head')!.sub).toBe('Reminds you today at 3:00 PM');
    await tick(0);
    expect(windows.map((w) => [w.title, w.body])).toEqual([['Essay outline', '- intro\n- body']]);

    act.action('close-editor', null);
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'list')!.items[0]).toMatchObject({ title: 'Essay outline', detail: expect.stringMatching(/has a note/) });
    await tick(HOUR + 1000);
    expect(act.status()).toMatchObject({ active: true, summary: 'Essay outline' });
    act.action('done', id);
    expect(items(options)).toEqual([expect.objectContaining({ id, note: true, text: 'Essay outline\n- intro\n- body' })]);
    expect(items(options)[0].at).toBeUndefined();
    expect(act.status().active).toBe(false);
  });

  it('a typed time in the editor that makes no sense says so', async () => {
    const { act, options } = await boot();
    act.action('note-add', 'Call the bank');
    const id = items(options)[0].id;
    act.action('open', id);
    act.action(`when:${id}`, 'whenever');
    expect(block(act.sheet(sheetEnv('open')), 'text', 'notice')!.text).toMatch(/Add when/);
    act.action(`when:${id}`, 'fri 3pm');
    expect(items(options)[0].at).toBe(at(23, 15));
  });

  it('an emptied note goes when the editor closes; a reminder can be kept in Notes', async () => {
    const { act, options } = await boot();
    act.action('note-add', 'Scratch');
    const id = items(options)[0].id;
    act.action('open', id);
    act.action(`text:${id}`, '   ');
    act.action('close-editor', null);
    expect(items(options)).toEqual([]);
    act.action('add', 'call mom tomorrow 9am');
    const rid = items(options)[0].id;
    act.action('open', rid);
    expect(block(act.sheet(sheetEnv('open')), 'buttons', 'end')!.items.map((b) => b.key)).toEqual(['delete', 'keep', 'done']);
    act.action('keep', rid);
    act.action('unremind', rid);
    expect(items(options)).toEqual([expect.objectContaining({ id: rid, note: true, text: 'Call mom' })]);
  });

  it('reminders saved by the old version still load', async () => {
    const { act } = await boot({ items: [{ id: 'old1', text: 'Old reminder', at: NOW + HOUR, due: false }] });
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'list')!.items[0]).toMatchObject({ title: 'Old reminder' });
  });

  it('when turned off, Windows is told to drop them', async () => {
    const { act } = await boot();
    act.action('add', 'stretch in 20m');
    await tick(0);
    expect(windows).toHaveLength(1);
    act.stop();
    await tick(0);
    expect(windows).toEqual([]);
  });
});

describe('the bot', () => {
  it('sets a reminder and says exactly when', async () => {
    const { act, options } = await boot();
    expect(act.command('bot', 'remind me in 20 min to stretch')).toBe("Okay, I'll remind you in 20 min (2:20 PM): Stretch.");
    expect(act.command('bot', 'remind me tomorrow 9am to call mom')).toBe("Okay, I'll remind you tomorrow at 9:00 AM: Call mom.");
    expect(items(options).map((r) => [r.text, r.at])).toEqual([['Stretch', NOW + 20 * MIN], ['Call mom', at(22, 9)]]);
  });

  it('asks for a time instead of guessing, and sets nothing', async () => {
    const { act, options } = await boot();
    expect(act.command('bot', 'remind me to call mom')).toMatch(/^When should I remind you\?/);
    expect(items(options)).toEqual([]);
  });

  it('takes notes, and remembers things as notes', async () => {
    const { act, options } = await boot();
    expect(act.command('bot', 'note: locker code 1234')).toBe('Saved to your notes: Locker code 1234.');
    expect(act.command('bot', 'remember that the wifi password is abc')).toBe('Saved to your notes: The wifi password is abc.');
    expect(act.command('bot', 'remember to stretch in 10 min')).toBe("Okay, I'll remind you in 10 min (2:10 PM): Stretch.");
    expect(items(options).filter((x) => x.note).map((n) => n.text)).toEqual(['Locker code 1234', 'The wifi password is abc']);
  });

  it('lists reminders and notes', async () => {
    const { act } = await boot();
    expect(act.command('bot', 'what are my reminders?')).toMatch(/^No reminders yet/);
    act.command('bot', 'remind me tomorrow 9am to call mom');
    act.command('bot', 'note: locker 1234');
    expect(act.command('bot', 'what are my reminders?')).toBe('One reminder:\n• Call mom: tomorrow at 9:00 AM');
    expect(act.command('bot', 'show my notes')).toBe('One note:\n• Locker 1234');
  });

  it('says once that a repeating reminder is set only once', async () => {
    const { act } = await boot();
    expect(act.command('bot', 'remind me to take meds every day at 9pm')).toMatch(/Just once/);
  });

  it('leaves other questions to the model', async () => {
    const { act } = await boot();
    expect(act.command('bot', 'capital of Canada?')).toBeNull();
  });
});
