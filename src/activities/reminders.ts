// Reminders and notes, one list. "submit the lab at 3pm", "stretch in 20m", "call mom tomorrow 9am"
// are reminders: kept with the activity's options (so they survive a restart), and when one is due it
// takes the island with Snooze and Done. Windows also gets every upcoming one as a scheduled
// notification (src-tauri/src/reminders.rs), so it shows at its time even when Island isn't running;
// one that came due while Island was closed shows on the pill as soon as it starts. Anything written
// without a time is a note (the card's Notes tab); a note can get a time and remind too. The bot sets
// both ("remind me tomorrow 9am to call mom", "note: locker 1234"), through command('bot').

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { agoText, clip, timeOfDay } from '../core/format';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { Block, SheetButton, SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity, chime } from './base';

export interface Reminder {
  id: string;
  /** What it says: the first line is its title, the lines after it its note. */
  text: string;
  /** When it is due, ms. None: a note without a reminder. */
  at?: number;
  /** It came due (the island showed it); it stays until Done. */
  due?: boolean;
  /** Tapped away while due: still listed, no longer holding the island. */
  seen?: boolean;
  /** Kept in Notes: Done only takes its time away. */
  note?: boolean;
  /** Last written, ms (Notes are listed newest first). */
  edited?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SNOOZE_MS = 10 * MIN;
/** A day with no time of day ("tomorrow"): this hour. */
const MORNING = 9;
const MAX_ITEMS = 300;
/** A note keeps this many characters at most. */
const MAX_TEXT = 5000;
const ROWS = 8;
/** Seen coming due later than this, Windows may not have shown it (the PC slept): Island notifies too. */
const LATE_MS = 2 * MIN;

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Parts of the day: the time they stand for, and whether a bare hour in them is after noon. */
const PERIODS: Record<string, { h: number; pm: boolean }> = {
  morning: { h: 9, pm: false },
  afternoon: { h: 14, pm: true },
  evening: { h: 18, pm: true },
  night: { h: 20, pm: true },
  tonight: { h: 20, pm: true },
};
/** Where a word ends. */
const END = '(?=[\\s,.!?;:]|$)';

export type Parsed = { text: string; at: number; repeats?: boolean } | { error: string };

const NEED_TIME = 'Add when: “in 20 min”, “at 3pm”, “tomorrow 9am” or “friday 2pm”.';

/**
 * What to remind and when, from one line, the words around the time being the reminder ("remind me
 * to" left out). Understands "in 20m", "in 1h30", "in an hour", "in 3 days", "at 3pm", "15:30",
 * "15h30", "at 9", "noon", "tomorrow", "tonight", "friday 2pm", "next monday", "oct 30", "the day
 * after tomorrow", "tomorrow morning". A time already past today means tomorrow; a bare hour from 1
 * to 6 is in the afternoon, from 7 to 11 whichever comes first.
 */
export function parseReminder(input: string, now: number): Parsed {
  let s = ` ${input.replace(/\s+/g, ' ').trim()} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m;
  };
  const repeats = /\s(?:every|each)\s+\w|\s(?:daily|weekly|monthly)\b/i.test(s);

  // "in 20 min", "in 1h30", "in an hour", "in half an hour", "in 2 hours and 15 minutes"
  let rel: { ms: number; days: number | null } | null = null;
  const r = take(new RegExp(`\\sin\\s+(an?|half\\s+an?|\\d+(?:[.,]\\d+)?)\\s*(${UNIT_RE})(?:\\s*(?:and\\s+)?(\\d+)\\s*(?:m|min|mins|minutes?)?)?${END}`, 'i'));
  if (r) {
    const n = /^half/i.test(r[1]) ? 0.5 : /^an?$/i.test(r[1]) ? 1 : parseFloat(r[1].replace(',', '.'));
    const unit = UNITS[r[2].toLowerCase()];
    let ms = n * unit;
    if (r[3] && unit === HOUR) ms += parseInt(r[3], 10) * MIN;
    rel = { ms, days: unit >= DAY && Number.isInteger(n * (unit / DAY)) ? n * (unit / DAY) : null };
  }

  // Which day.
  let day: { kind: 'offset'; n: number } | { kind: 'weekday'; w: number; next: boolean } | { kind: 'date'; month: number; date: number; year: number | null } | null = null;
  let period: { h: number; pm: boolean } | null = null;
  const dm = take(new RegExp(`\\s(?:on\\s+|by\\s+)?(?:the\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${END}`, 'i'))
    ?? take(new RegExp(`\\s(?:on\\s+|by\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?${END}`, 'i'));
  if (dm) {
    const [mo, d] = /^\d/.test(dm[1]) ? [dm[2], dm[1]] : [dm[1], dm[2]];
    const month = MONTHS.indexOf(mo.slice(0, 3).toLowerCase());
    const date = parseInt(d, 10);
    if (month >= 0 && date >= 1 && date <= 31) day = { kind: 'date', month, date, year: dm[3] ? parseInt(dm[3], 10) : null };
  }
  if (!day && take(new RegExp(`\\s(?:the\\s+)?day\\s+after\\s+tomorrow${END}`, 'i'))) day = { kind: 'offset', n: 2 };
  if (!day && take(new RegExp(`\\s(?:by\\s+|on\\s+)?(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr|tmw)${END}`, 'i'))) day = { kind: 'offset', n: 1 };
  if (!day && take(new RegExp(`\\s(?:by\\s+)?next\\s+week${END}`, 'i'))) day = { kind: 'offset', n: 7 };
  if (!day) {
    const wd =
      take(new RegExp(`\\s(?:(on|by|this|next)\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)${END}`, 'i')) ??
      take(new RegExp(`\\s(on|by|this|next)\\s+(sun|mon|tues?|wed|thurs?|thu|fri|sat)\\.?${END}`, 'i')) ??
      take(/\s()(sun|mon|tues?|wed|thurs?|thu|fri|sat)\.?(?=\s+\d)/i);
    if (wd) day = { kind: 'weekday', w: WEEKDAYS[wd[2].toLowerCase()], next: (wd[1] ?? '').toLowerCase() === 'next' };
  }
  if (!day && take(new RegExp(`\\s(?:by\\s+)?tonight${END}`, 'i'))) {
    day = { kind: 'offset', n: 0 };
    period = PERIODS.tonight;
  }
  const today = !day ? take(new RegExp(`\\s(?:by\\s+|for\\s+)?today${END}`, 'i')) : null;
  if (today) day = { kind: 'offset', n: 0 };

  // The time of day.
  let hm: { h: number; m: number } | null = null;
  const nm = take(new RegExp(`\\s(?:at\\s+|by\\s+)?(noon|midday|midnight)${END}`, 'i'));
  if (nm) hm = nm[1].toLowerCase() === 'midnight' ? { h: 24, m: 0 } : { h: 12, m: 0 };
  const pd = take(new RegExp(`\\s(?:this\\s+|in\\s+the\\s+|at\\s+)?(morning|afternoon|evening|night)${END}`, 'i'));
  if (pd) period = PERIODS[pd[1].toLowerCase()];
  let bare = false;
  if (!hm) {
    const clockRe = new RegExp(`\\s(?:(at|@|by)\\s*)?(\\d{1,2})(?:[:h.](\\d{2}))?\\s*(am|pm|a\\.m\\.?|p\\.m\\.?)?${END}`, 'gi');
    let hit: RegExpExecArray | null;
    while ((hit = clockRe.exec(s))) {
      const [all, word, hh, mm, ampm] = hit;
      if (!word && !mm && !ampm) continue;
      let h = parseInt(hh, 10);
      const m = mm ? parseInt(mm, 10) : 0;
      if (m > 59 || h > 23 || (ampm && (h < 1 || h > 12))) continue;
      if (ampm) {
        const pm = ampm.toLowerCase().startsWith('p');
        h = h === 12 ? (pm ? 12 : 0) : pm ? h + 12 : h;
      } else if (h >= 1 && h <= 12) bare = true;
      hm = { h, m };
      s = `${s.slice(0, hit.index)} ${s.slice(hit.index + all.length)}`;
      break;
    }
  }

  let at: number | null = null;
  if (rel && !(rel.days !== null && (hm || period))) {
    at = now + rel.ms + (day?.kind === 'offset' ? day.n * DAY : 0);
  } else if (day || hm || period || rel) {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const dayGiven = day !== null && !(day.kind === 'offset' && day.n === 0) || rel !== null;
    let { h, m } = hm ?? (period ? { h: period.h, m: 0 } : { h: MORNING, m: 0 });
    if (!hm && !period && !dayGiven) return { error: NEED_TIME };
    if (hm && bare) {
      if (period) h = period.pm ? (h % 12) + 12 : h % 12;
      else if (h <= 6) h += 12;
      else if (h === 12) h = 12;
    }
    const make = (dayStart: Date, hour: number) => {
      const d = new Date(dayStart);
      d.setHours(hour, m, 0, 0);
      return d.getTime();
    };
    const plus = (n: number) => {
      const d = new Date(base);
      d.setDate(d.getDate() + n);
      return d;
    };
    if (day?.kind === 'date') {
      const d = new Date(day.year ?? base.getFullYear(), day.month, day.date);
      if (d.getMonth() !== day.month) return { error: 'That date does not exist.' };
      at = make(d, h);
      if (day.year === null && at <= now) {
        d.setFullYear(d.getFullYear() + 1);
        at = make(d, h);
      }
    } else if (day?.kind === 'weekday') {
      let n = (day.w - base.getDay() + 7) % 7;
      if (day.next && n === 0) n = 7;
      at = make(plus(n), h);
      if (at <= now) at = make(plus(n + 7), h);
    } else {
      const n = rel?.days ?? (day?.kind === 'offset' ? day.n : 0);
      at = make(plus(n), h);
      // A bare 7 to 11 with nothing else said: whichever of the morning and the evening comes first.
      if (n === 0 && !day && hm && bare && !period && h >= 7 && h <= 11 && at <= now) at = make(plus(0), h + 12);
      if (at <= now && n === 0) at = make(plus(1), h);
    }
  }
  if (at === null) return { error: NEED_TIME };

  let text = s
    .replace(/^\s*(?:(?:please|pls|hey|ok(?:ay)?)[\s,]+)*(?:remind\s+me|set\s+(?:up\s+)?(?:a\s+|an\s+)?reminder|add\s+(?:a\s+)?reminder|reminder)\b[\s,:-]*/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  for (let i = 0; i < 3; i++) text = text.replace(/^(?:to|that|about|for|of)\s+/i, '');
  text = text.replace(/\s+(?:at|in|by|on|for|to|from)$/i, '').trim();
  return { text: text ? text[0].toUpperCase() + text.slice(1) : 'Reminder', at, ...(repeats ? { repeats } : {}) };
}

const dayStart = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const daysApart = (at: number, now: number) => Math.round((dayStart(at) - dayStart(now)) / DAY);

/** "3:00 PM", "Tomorrow 9:00 AM", "Thu 9:00 AM", or a date further out. */
export function whenText(at: number, now: number): string {
  const d = new Date(at);
  const time = timeOfDay(at);
  const days = daysApart(at, now);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

/** When, to end a sentence: "in 20 min (3:20 PM)", "today at 3:00 PM", "tomorrow at 9:00 AM", "Friday at 9:00 AM", "Oct 30 at 9:00 AM". */
export function dueText(at: number, now: number): string {
  const time = timeOfDay(at);
  const days = daysApart(at, now);
  const mins = Math.round((at - now) / MIN);
  if (days === 0 && mins >= 0 && mins < 60) return mins <= 1 ? `in a minute (${time})` : `in ${mins} min (${time})`;
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const d = new Date(at);
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
}

/** The first line: what a reminder or note is called. */
export function titleOf(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}

/** The lines after the first: a reminder's note. */
export function bodyOf(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  return first < 0 ? '' : lines.slice(first + 1).join('\n').trim();
}

// ------------------------------------------------------------------ the bot

/** What the bot was asked, when it is about reminders or notes. */
export type BotAsk = { kind: 'remind'; what: string } | { kind: 'note'; what: string } | { kind: 'remember'; what: string } | { kind: 'reminders' } | { kind: 'notes' };

const POLITE = '^(?:(?:hey|ok(?:ay)?|please|pls|so|and)[\\s,]+)*(?:(?:can|could|would|will)\\s+you\\s+|i\\s+(?:want|need)\\s+you\\s+to\\s+)?(?:please\\s+)?';

/** Whether a line typed to the bot is for reminders or notes, and what it carries; null: for the model. */
export function botAsk(input: string): BotAsk | null {
  const t = input.replace(/\s+/g, ' ').trim();
  const strip = (re: RegExp) => t.replace(re, '').replace(/^[\s,:;-]+/, '').trim();
  if (new RegExp(`${POLITE}(?:what(?:'s|\\s+is|\\s+are)?\\s+(?:are\\s+)?my\\s+reminders|(?:show|list|see|read|check)\\s+(?:me\\s+)?(?:all\\s+)?my\\s+reminders|my\\s+reminders|do\\s+i\\s+have\\s+(?:any\\s+)?reminders|any\\s+reminders)\\b`, 'i').test(t)) return { kind: 'reminders' };
  if (new RegExp(`${POLITE}(?:what(?:'s|\\s+is|\\s+are)?\\s+(?:are\\s+)?(?:in\\s+)?my\\s+notes|(?:show|list|see|read|check)\\s+(?:me\\s+)?(?:all\\s+)?my\\s+notes|my\\s+notes)\\b`, 'i').test(t)) return { kind: 'notes' };
  const remind = new RegExp(`${POLITE}(?:remind\\s+me\\b|set\\s+(?:up\\s+)?(?:a\\s+|an\\s+)?reminder\\b|(?:add|create|make)\\s+(?:a\\s+|an\\s+)?reminder\\b|new\\s+reminder\\b|reminder\\s*[:\\-–]|remind\\b)`, 'i');
  if (remind.test(t)) return { kind: 'remind', what: strip(remind) };
  const note = new RegExp(`${POLITE}(?:(?:take|make|write|add|save|create|jot)(?:\\s+down)?(?:\\s+(?:me|a|an|this|the|quick))*\\s+notes?(?:\\s+(?:that|of|to\\s+self|saying))?\\b|note(?:\\s+to\\s+self)?\\s*[:\\-–]|note\\s+(?:that|down)\\b|(?:write|jot)\\s+(?:this|it|that)?\\s*down\\b)`, 'i');
  if (note.test(t)) return { kind: 'note', what: strip(note) };
  const remember = new RegExp(`${POLITE}remember\\s+(?:that\\s+|to\\s+)?`, 'i');
  if (remember.test(t)) return { kind: 'remember', what: t.replace(remember, '').trim() };
  return null;
}

/** The bot's answer when Reminders is off. */
export const REMINDERS_OFF = 'Reminders is off. Turn it on in Activities › Reminders, then ask me again.';

// ------------------------------------------------------------------ the activity

type Tab = 'reminders' | 'notes';

export class RemindersActivity extends BaseActivity {
  private items: Reminder[] = [];
  private notice: string | null = null;
  private tab: Tab = 'reminders';
  /** The reminder or note open in the card's editor. */
  private editing: string | null = null;
  /** Ids Windows holds as scheduled notifications (it shows those itself, on time). */
  private scheduled = new Set<string>();
  /** What was last handed to Windows, so it is only told again when that changes. */
  private sentSchedule = '';

  constructor() {
    super('reminders');
  }

  protected init(): void {
    const saved = this.ctx.options<{ items?: unknown }>().items;
    this.items = Array.isArray(saved) ? saved.filter(isReminder).slice(0, MAX_ITEMS) : [];
    this.every(1000, () => this.check(), true);
  }

  protected override dispose(): void {
    // Turned off: Windows shouldn't remind of anything any more.
    void this.schedule([]);
  }

  private save(): void {
    this.ctx.setOptions?.({ items: this.items.map((r) => ({ ...r })) });
    this.syncWindows();
  }

  private find(id: string): Reminder | undefined {
    return this.items.find((x) => x.id === id);
  }

  private newId(now: number): string {
    return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Reminders whose time came: due now, with a notification once. */
  private check(): void {
    const now = Date.now();
    let changed = false;
    for (const r of this.items) {
      if (r.due || r.at === undefined || r.at > now) continue;
      r.due = true;
      r.seen = false;
      changed = true;
      chime('attention');
      const late = now - r.at > LATE_MS;
      const title = titleOf(r.text) || 'Reminder';
      const body = late ? `Was due ${whenText(r.at, now)}` : 'Reminder';
      // Windows showed it itself, on time: only phones still need telling.
      const byWindows = this.scheduled.has(r.id) && !late;
      if (byWindows) this.ctx.push?.(title, body, { tag: 'bell', priority: 4 });
      else this.ctx.notify(title, body);
      this.ctx.log(`due ${Math.round((now - r.at) / 1000)}s after its time; ${byWindows ? 'Windows showed it' : 'Island notified'}`);
    }
    if (changed) {
      this.save();
      this.ctx.update();
    } else this.syncWindows();
  }

  /**
   * Reminders not yet due, as Windows should hold them; nothing while Windows notifications are off.
   * The list only changes when the reminders do (never as time passes), so Windows is never told to
   * drop one that is about to fire.
   */
  private upcomingForWindows(): Array<{ id: string; title: string; body: string; at: number }> {
    if (!this.ctx.settings().general.notifications) return [];
    return this.items
      .filter((r) => r.at !== undefined && !r.due)
      .map((r) => ({ id: r.id, title: clip(titleOf(r.text) || 'Reminder', 120), body: clip(bodyOf(r.text) || `Reminder · ${timeOfDay(r.at!)}`, 240), at: r.at! }));
  }

  private syncWindows(): void {
    const list = this.upcomingForWindows();
    const sig = JSON.stringify(list);
    if (sig === this.sentSchedule) return;
    this.sentSchedule = sig;
    void this.schedule(list);
  }

  private async schedule(list: Array<{ id: string; title: string; body: string; at: number }>): Promise<void> {
    try {
      const held = await native.remindersSchedule(list);
      this.scheduled = new Set(Array.isArray(held) ? held : []);
    } catch {
      this.scheduled = new Set();
    }
    if (this.alive) this.ctx.log(`Windows holds ${this.scheduled.size} of ${list.length} upcoming reminder${list.length === 1 ? '' : 's'}`);
  }

  /** The reminder holding the island: due, not tapped away, the oldest first. */
  private current(): Reminder | null {
    return this.reminders().find((r) => r.due && !r.seen) ?? null;
  }

  /** Everything with a time, due first, then soonest. */
  private reminders(): Reminder[] {
    return this.items.filter((r) => r.at !== undefined).sort((a, b) => Number(Boolean(b.due)) - Number(Boolean(a.due)) || a.at! - b.at!);
  }

  private notes(): Reminder[] {
    return this.items.filter((r) => r.note).sort((a, b) => (b.edited ?? 0) - (a.edited ?? 0));
  }

  status(): ActivityStatus {
    const r = this.current();
    if (!r) return { active: false };
    return { active: true, weight: 'foreground', urgent: { key: `rem-${r.id}`, level: 'expanded' }, summary: titleOf(r.text), beam: { tone: 'warn', motion: 'pulse' } };
  }

  dismiss(key: string): void {
    const r = this.items.find((x) => `rem-${x.id}` === key);
    if (!r) return;
    r.seen = true;
    this.save();
    this.ctx.update();
  }

  render(env: RenderEnv): Seg[] {
    const r = this.current();
    if (!r) return [];
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: 'bell', tone: 'warn', anim: 'bob', prio: 0 },
      { t: 'text', key: 'text', text: titleOf(r.text) || 'Reminder', weight: 'semibold', prio: 0, min: 60 },
    ];
    if (env.level === 'compact' || env.level === 'idle' || !env.interactive) return segs;
    const v = env.vertical;
    segs.push(
      { t: 'button', key: 'snooze', icon: 'timer', label: v ? undefined : '10 min', action: 'snooze', arg: r.id, style: 'secondary', side: 'end', prio: 2, tip: 'Remind me again in 10 minutes' },
      { t: 'button', key: 'done', icon: 'check', label: v ? undefined : 'Done', action: 'done', arg: r.id, style: 'primary', side: 'end', prio: 1, tip: 'Done' },
    );
    return segs;
  }

  tile(env: SheetEnv): Tile | null {
    const list = this.reminders();
    const next = list.find((r) => !r.due);
    const due = list.filter((r) => r.due).length;
    const notes = this.notes().length;
    const value = due ? `${due} due` : next ? clip(titleOf(next.text), 22) : notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'None';
    const sub = next ? whenText(next.at!, env.now) : 'Tap to add one';
    return { key: 'reminders', tone: due ? 'warn' : 'accent', action: 'card', tip: 'Reminders and notes', body: { k: 'stat', icon: 'bell', label: 'Reminders', value, sub } };
  }

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason === 'urgent') {
      const r = this.current();
      return r ? this.dueCard(r, env) : null;
    }
    if (env.reason !== 'open') return null;
    const open = this.editing ? this.find(this.editing) : undefined;
    return open ? this.editor(open, env) : this.card(env);
  }

  private dueCard(r: Reminder, env: SheetEnv): SheetView {
    const late = env.now - r.at! > LATE_MS;
    const blocks: Block[] = [{ t: 'head', key: 'head', icon: 'bell', tone: 'warn', title: titleOf(r.text) || 'Reminder', sub: late ? `Was due ${whenText(r.at!, env.now)}` : `Reminder · ${timeOfDay(r.at!)}` }];
    const body = bodyOf(r.text);
    if (body) blocks.push({ t: 'text', key: 'note', text: body, size: 'sm', lines: 8 });
    blocks.push({
      t: 'buttons',
      key: 'act',
      align: 'fill',
      items: [
        { key: 'hour', label: '1 hour', icon: 'timer', action: 'snooze', arg: [r.id, HOUR], style: 'secondary', disabled: !env.interactive },
        { key: 'snooze', label: '10 min', icon: 'timer', action: 'snooze', arg: r.id, style: 'secondary', disabled: !env.interactive },
        { key: 'done', label: 'Done', icon: 'check', action: 'done', arg: r.id, style: 'primary', disabled: !env.interactive },
      ],
    });
    return { key: `due/${r.id}`, blocks };
  }

  private tabs(): Block {
    const tab = (key: Tab, label: string): SheetButton => ({ key, label, action: 'tab', arg: key, style: this.tab === key ? 'secondary' : 'ghost' });
    return { t: 'buttons', key: 'tabs', align: 'fill', items: [tab('reminders', 'Reminders'), tab('notes', 'Notes')] };
  }

  private card(env: SheetEnv): SheetView {
    const reminders = this.reminders();
    const notes = this.notes();
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: 'bell',
        tone: 'accent',
        title: 'Reminders',
        sub: `${reminders.length ? `${reminders.length} set` : 'None set'} · ${notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : 'no notes'}`,
        buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost', tip: 'Control Center' }],
      },
      this.tabs(),
    ];
    if (this.tab === 'reminders') {
      blocks.push({ t: 'input', key: 'add', placeholder: 'Submit lab at 3pm · call mom tomorrow 9am', action: 'add' });
      if (this.notice) blocks.push({ t: 'text', key: 'notice', text: this.notice, tone: 'muted', size: 'sm' });
      if (reminders.length) {
        const rows: SheetRow[] = reminders.slice(0, ROWS).map((r) => ({
          key: r.id,
          icon: 'bell',
          tone: r.due ? 'warn' : undefined,
          title: titleOf(r.text) || 'Reminder',
          detail: `${r.due ? 'Due · ' : ''}${whenText(r.at!, env.now)}${bodyOf(r.text) ? ' · has a note' : ''}`,
          action: 'open',
          arg: r.id,
          button: r.due ? { key: 'done', icon: 'check', action: 'done', arg: r.id, style: 'ghost', tip: 'Done' } : { key: 'rm', icon: 'x', action: 'unremind', arg: r.id, style: 'ghost', tip: r.note ? 'Remove the reminder (the note stays)' : 'Remove' },
        }));
        if (reminders.length > ROWS) rows.push({ key: 'more', title: `and ${reminders.length - ROWS} more`, tone: 'muted' });
        blocks.push({ t: 'rows', key: 'list', items: rows });
      } else {
        blocks.push({ t: 'text', key: 'hint', text: 'Type what and when, then Enter. The island shows it at that time and Windows notifies you, even if Island is closed. Without a time it goes to Notes. You can also ask the bot: “remind me tomorrow 9am to call mom”.', tone: 'muted', size: 'sm' });
      }
    } else {
      blocks.push({ t: 'input', key: 'note-add', placeholder: 'Write a note…', action: 'note-add' });
      if (this.notice) blocks.push({ t: 'text', key: 'notice', text: this.notice, tone: 'muted', size: 'sm' });
      if (notes.length) {
        const rows: SheetRow[] = notes.slice(0, ROWS).map((n) => {
          const more = bodyOf(n.text).split('\n').filter((l) => l.trim()).length;
          const when = n.at !== undefined ? `${n.due ? 'Due' : 'Reminds you'} ${whenText(n.at, env.now)}` : n.edited ? agoText(env.now - n.edited) : '';
          return {
            key: n.id,
            icon: n.at !== undefined ? 'bell' : 'edit',
            tone: n.due ? 'warn' : undefined,
            title: titleOf(n.text) || 'Note',
            detail: [when, more ? `${more} more line${more === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
            action: 'open',
            arg: n.id,
            button: { key: 'rm', icon: 'x', action: 'delete', arg: n.id, style: 'ghost', tip: 'Delete the note' },
          };
        });
        if (notes.length > ROWS) rows.push({ key: 'more', title: `and ${notes.length - ROWS} more`, tone: 'muted' });
        blocks.push({ t: 'rows', key: 'list', items: rows });
      } else {
        blocks.push({ t: 'text', key: 'hint', text: 'Notes stay until you delete them. Tap one to write more or to be reminded of it. You can also tell the bot: “note: locker code 1234”.', tone: 'muted', size: 'sm' });
      }
    }
    return { key: 'card', blocks };
  }

  /** One reminder or note, open to write in, to give a time, or to delete. */
  private editor(r: Reminder, env: SheetEnv): SheetView {
    const when = r.at !== undefined ? `${r.due ? 'Was due' : 'Reminds you'} ${dueText(r.at, env.now)}` : 'No reminder';
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: r.at !== undefined ? 'bell' : 'edit',
        tone: r.due ? 'warn' : 'accent',
        title: r.note ? 'Note' : 'Reminder',
        sub: when,
        buttons: [{ key: 'back', icon: 'chevron-left', action: 'close-editor', style: 'ghost', tip: 'Back' }],
      },
      { t: 'input', key: `text-${r.id}`, placeholder: 'Write here. The first line is its title.', action: 'close-editor', change: `text:${r.id}`, lines: 6, value: r.text },
      { t: 'input', key: `when-${r.id}`, placeholder: r.at !== undefined ? 'Change when: in 2h, fri 3pm…' : 'Remind me: in 2h, tonight, fri 3pm…', action: `when:${r.id}` },
    ];
    if (this.notice) blocks.push({ t: 'text', key: 'notice', text: this.notice, tone: 'muted', size: 'sm' });
    const quick: SheetButton[] = [
      { key: 'q-hour', label: 'In 1 hour', icon: 'timer', action: 'when', arg: [r.id, 'in 1 hour'], style: 'secondary', disabled: !env.interactive },
      { key: 'q-tonight', label: 'Tonight', action: 'when', arg: [r.id, 'tonight 8pm'], style: 'secondary', disabled: !env.interactive },
      { key: 'q-tomorrow', label: 'Tomorrow 9 AM', action: 'when', arg: [r.id, 'tomorrow 9am'], style: 'secondary', disabled: !env.interactive },
    ];
    blocks.push({ t: 'buttons', key: 'quick', align: 'fill', items: quick });
    const end: SheetButton[] = [{ key: 'delete', label: 'Delete', icon: 'x', action: 'delete', arg: r.id, style: 'danger', disabled: !env.interactive }];
    if (r.at !== undefined && r.note) end.push({ key: 'unremind', label: 'No reminder', action: 'unremind', arg: r.id, style: 'secondary', disabled: !env.interactive });
    if (!r.note) end.push({ key: 'keep', label: 'Keep in Notes', icon: 'edit', action: 'keep', arg: r.id, style: 'secondary', disabled: !env.interactive });
    end.push({ key: 'done', label: 'Done', icon: 'check', action: 'close-editor', style: 'primary' });
    blocks.push({ t: 'buttons', key: 'end', align: 'end', items: end });
    return { key: `edit/${r.id}`, blocks };
  }

  // ---------------------------------------------------------------- changes

  /** A new reminder (with a time) or note (without one, or with `note`). */
  private addItem(text: string, at: number | undefined, note: boolean, now: number): Reminder {
    if (this.items.length >= MAX_ITEMS) {
      // The oldest finished thing goes first: a note without a reminder, then anything.
      const i = this.items.findIndex((x) => x.at === undefined);
      this.items.splice(i >= 0 ? i : 0, 1);
    }
    const r: Reminder = { id: this.newId(now), text: text.slice(0, MAX_TEXT), edited: now };
    if (at !== undefined) r.at = at;
    if (note) r.note = true;
    this.items.push(r);
    this.save();
    return r;
  }

  /** Gives `id` the time in `when`; an error to show when it has none. */
  private setWhen(id: string, when: string, now: number): string | null {
    const r = this.find(id);
    if (!r) return null;
    const p = parseReminder(when, now);
    if ('error' in p) return p.error;
    r.at = p.at;
    r.due = false;
    r.seen = false;
    r.edited = now;
    // A reminder that only had a title: the typed words (beyond the time) can name it.
    this.save();
    return null;
  }

  action(name: string, arg: unknown): void {
    const now = Date.now();
    if (name.startsWith('text:')) {
      const r = this.find(name.slice(5));
      if (!r || typeof arg !== 'string') return;
      const text = arg.slice(0, MAX_TEXT);
      if (text === r.text) return;
      r.text = text;
      r.edited = now;
      this.save();
      return;
    }
    if (name.startsWith('when:') || name === 'when') {
      const [id, when] = name === 'when' && Array.isArray(arg) ? [String(arg[0]), String(arg[1])] : [name.slice(5), typeof arg === 'string' ? arg : ''];
      if (!when.trim()) return;
      this.notice = this.setWhen(id, when, now);
      this.ctx.update();
      return;
    }
    switch (name) {
      case 'card':
        this.notice = null;
        this.editing = null;
        this.tab = 'reminders';
        this.ctx.openCard?.();
        break;
      case 'tab':
        if (arg === 'reminders' || arg === 'notes') this.tab = arg;
        this.notice = null;
        break;
      case 'add': {
        const text = typeof arg === 'string' ? arg.trim() : '';
        if (!text) return;
        const p = parseReminder(text, now);
        if ('error' in p) {
          // No time in it: it is a note.
          this.addItem(text[0].toUpperCase() + text.slice(1), undefined, true, now);
          this.notice = 'No time in that, so it went to Notes. Add a time (“at 3pm”, “tomorrow 9am”) to be reminded.';
          break;
        }
        this.notice = null;
        this.addItem(p.text, p.at, false, now);
        break;
      }
      case 'note-add': {
        const text = typeof arg === 'string' ? arg.trim() : '';
        if (!text) return;
        this.notice = null;
        this.addItem(text, undefined, true, now);
        break;
      }
      case 'open':
        if (typeof arg === 'string' && this.find(arg)) {
          this.editing = arg;
          this.notice = null;
        }
        break;
      case 'close-editor': {
        const r = this.editing ? this.find(this.editing) : undefined;
        // An empty note goes away on its own.
        if (r && !r.text.trim()) {
          this.items = this.items.filter((x) => x !== r);
          this.save();
        }
        this.editing = null;
        this.notice = null;
        break;
      }
      case 'snooze': {
        const [id, ms] = Array.isArray(arg) ? [String(arg[0]), Number(arg[1]) || SNOOZE_MS] : [String(arg), SNOOZE_MS];
        const r = this.find(id);
        if (!r) return;
        r.at = now + ms;
        r.due = false;
        r.seen = false;
        this.save();
        break;
      }
      case 'done':
      case 'unremind': {
        const r = this.find(String(arg));
        if (!r) return;
        // A note keeps its words; a plain reminder is finished.
        if (r.note) {
          delete r.at;
          delete r.due;
          delete r.seen;
        } else this.items = this.items.filter((x) => x !== r);
        this.save();
        break;
      }
      case 'remove':
      case 'delete':
        this.items = this.items.filter((x) => x.id !== String(arg));
        if (this.editing === String(arg)) this.editing = null;
        this.save();
        break;
      case 'keep': {
        const r = this.find(String(arg));
        if (!r) return;
        r.note = true;
        this.save();
        break;
      }
      default:
        return;
    }
    this.ctx.update();
  }

  /** The bot's answer to `text` (it was about reminders or notes), having done what it asked. */
  private answerBot(text: string): string | null {
    const ask = botAsk(text);
    if (!ask) return null;
    const now = Date.now();
    switch (ask.kind) {
      case 'reminders': {
        const list = this.reminders();
        if (!list.length) return 'No reminders yet. Try “remind me tomorrow 9am to call mom”.';
        const lines = list.slice(0, 6).map((r) => `• ${titleOf(r.text) || 'Reminder'}: ${r.due ? 'due now' : dueText(r.at!, now)}`);
        if (list.length > 6) lines.push(`…and ${list.length - 6} more, in Reminders.`);
        return `${list.length === 1 ? 'One reminder' : `${list.length} reminders`}:\n${lines.join('\n')}`;
      }
      case 'notes': {
        const list = this.notes();
        if (!list.length) return 'No notes yet. Try “note: locker code 1234”.';
        const lines = list.slice(0, 6).map((n) => `• ${titleOf(n.text) || 'Note'}`);
        if (list.length > 6) lines.push(`…and ${list.length - 6} more, in Reminders › Notes.`);
        return `${list.length === 1 ? 'One note' : `${list.length} notes`}:\n${lines.join('\n')}`;
      }
      case 'note': {
        if (!ask.what) return 'What should the note say? Like “note: locker code 1234”.';
        const r = this.addItem(ask.what[0].toUpperCase() + ask.what.slice(1), undefined, true, now);
        this.ctx.update();
        return `Saved to your notes: ${titleOf(r.text)}.`;
      }
      case 'remember':
      case 'remind': {
        const p = parseReminder(ask.what, now);
        if ('error' in p) {
          if (ask.kind === 'remember' && ask.what) {
            const r = this.addItem(ask.what[0].toUpperCase() + ask.what.slice(1), undefined, true, now);
            this.ctx.update();
            return `Saved to your notes: ${titleOf(r.text)}.`;
          }
          return 'When should I remind you? Say it with a time, like “remind me tomorrow 9am to call mom” or “remind me in 20 min to stretch”.';
        }
        this.addItem(p.text, p.at, false, now);
        this.ctx.update();
        return `Okay, I'll remind you ${dueText(p.at, now)}: ${p.text}.${p.repeats ? ' (Just once: repeating reminders are not in Island yet.)' : ''}`;
      }
    }
  }

  command(cmd: string, arg: unknown): unknown {
    if (cmd === 'bot' && typeof arg === 'string') return this.answerBot(arg);
    if (cmd === 'add' && typeof arg === 'string') {
      this.action('add', arg);
      return this.notice === null;
    }
    return false;
  }
}

function isReminder(x: unknown): x is Reminder {
  const r = x as Reminder;
  if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') return false;
  if (r.at !== undefined && (typeof r.at !== 'number' || !Number.isFinite(r.at))) return false;
  // Anything kept has a time, or is a note.
  return r.at !== undefined || r.note === true;
}
