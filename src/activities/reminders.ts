// Reminders: "submit the lab at 3pm", "stretch in 20m", "call mom tomorrow 9am". Typed in the
// card, kept with the activity's options (so they survive a restart), and when one is due it
// takes the island with Snooze and Done, plus a Windows notification. One that came due while
// Island was closed shows as soon as it starts.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import type { Seg } from '../core/segments';
import type { Block, SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity, chime } from './base';

export interface Reminder {
  id: string;
  text: string;
  /** When it is due, ms. */
  at: number;
  /** It came due (the island showed it); it stays until Done. */
  due?: boolean;
  /** Tapped away while due: still listed, no longer holding the island. */
  seen?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const SNOOZE_MS = 10 * MIN;
/** A reminder with no time of day ("tomorrow"): this hour. */
const MORNING = 9;
const MAX_ITEMS = 50;
const ROWS = 8;

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: 24 * HOUR, day: 24 * HOUR, days: 24 * HOUR,
};

/**
 * What to remind and when, from one line. Understands "in 20m", "in 1h30", "in 2 hours",
 * "at 3pm", "at 15:30", "3:30pm", "tomorrow", "tomorrow 9am", with the words around them as
 * the reminder ("remind me to" left out). A time of day already past today means tomorrow.
 */
export function parseReminder(input: string, now: number): { text: string; at: number } | { error: string } {
  let s = ` ${input.trim()} `;
  let at: number | null = null;

  // "in 1h 30m", "in 90 min", "in 1h30"
  const rel = /\s(?:in\s+)(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s*(\d+)\s*(m|min|mins|minutes?)?)?(?=[\s,.!?]|$)/i.exec(s);
  if (rel && UNITS[rel[2].toLowerCase()]) {
    let ms = parseFloat(rel[1]) * UNITS[rel[2].toLowerCase()];
    if (rel[3] && UNITS[rel[2].toLowerCase()] === HOUR) ms += parseInt(rel[3], 10) * MIN;
    at = now + ms;
    s = s.replace(rel[0], ' ');
  }

  let tomorrow = false;
  const tm = /\s(?:by\s+|on\s+)?tomorrow(?=[\s,.!?]|$)/i.exec(s);
  if (tm) {
    tomorrow = true;
    s = s.replace(tm[0], ' ');
  }

  // "at 3pm", "3:30 pm", "at 15:30", "at 9" (a bare number needs "at")
  const clockRe = /\s(?:(at)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=[\s,.!?]|$)/gi;
  let hit: RegExpExecArray | null;
  while (at === null && (hit = clockRe.exec(s))) {
    const [all, word, hh, mm, ampm] = hit;
    if (!word && !mm && !ampm) continue;
    let h = parseInt(hh, 10);
    const m = mm ? parseInt(mm, 10) : 0;
    if (m > 59 || h > 23 || (ampm && (h < 1 || h > 12))) continue;
    if (ampm) {
      const pm = ampm.toLowerCase().startsWith('p');
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (tomorrow) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    at = d.getTime();
    s = s.replace(all, ' ');
  }

  if (at === null && tomorrow) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(MORNING, 0, 0, 0);
    at = d.getTime();
  } else if (at !== null && tomorrow && rel) {
    at += 24 * HOUR;
  }
  if (at === null) return { error: 'Add when: “in 20 min”, “at 3pm” or “tomorrow 9am”.' };

  const text = s
    .replace(/^\s*remind\s+me\s+(?:to\s+)?/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/\s+(?:at|in|by|on)$/i, '')
    .trim();
  return { text: text ? text[0].toUpperCase() + text.slice(1) : 'Reminder', at };
}

/** "3:00 PM", "Tomorrow 9:00 AM", "Thu 9:00 AM", or a date further out. */
export function whenText(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((day(at) - day(now)) / (24 * HOUR));
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export class RemindersActivity extends BaseActivity {
  private items: Reminder[] = [];
  private note: string | null = null;

  constructor() {
    super('reminders');
  }

  protected init(): void {
    const saved = this.ctx.options<{ items?: unknown }>().items;
    this.items = Array.isArray(saved) ? saved.filter(isReminder).slice(0, MAX_ITEMS) : [];
    this.every(1000, () => this.check(), true);
  }

  private save(): void {
    this.items.sort((a, b) => a.at - b.at);
    this.ctx.setOptions?.({ items: this.items.map((r) => ({ ...r })) });
  }

  /** Reminders whose time came: due now (and a notification once). */
  private check(): void {
    const now = Date.now();
    let changed = false;
    for (const r of this.items) {
      if (r.due || r.at > now) continue;
      r.due = true;
      changed = true;
      chime('attention');
      const late = now - r.at > 2 * MIN ? ` (was due ${whenText(r.at, now)})` : '';
      this.ctx.notify('Reminder', `${r.text}${late}`);
    }
    if (changed) {
      this.save();
      this.ctx.update();
    }
  }

  /** The reminder holding the island: due, not tapped away, the oldest first. */
  private current(): Reminder | null {
    return this.items.find((r) => r.due && !r.seen) ?? null;
  }

  private upcoming(): Reminder[] {
    return this.items.filter((r) => !r.due);
  }

  status(): ActivityStatus {
    const r = this.current();
    if (!r) return { active: false };
    return { active: true, weight: 'foreground', urgent: { key: `rem-${r.id}`, level: 'expanded' }, summary: r.text, beam: { tone: 'warn', motion: 'pulse' } };
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
      { t: 'text', key: 'text', text: r.text, weight: 'semibold', prio: 0, min: 60 },
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
    const next = this.upcoming()[0];
    const due = this.items.filter((r) => r.due).length;
    const value = due ? `${due} due` : next ? clip(next.text, 22) : 'None';
    const sub = next ? whenText(next.at, env.now) : 'Tap to add one';
    return { key: 'reminders', tone: due ? 'warn' : 'accent', action: 'card', tip: 'Reminders', body: { k: 'stat', icon: 'bell', label: 'Reminders', value, sub } };
  }

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason === 'urgent') {
      const r = this.current();
      return r ? this.dueCard(r, env) : null;
    }
    return env.reason === 'open' ? this.card(env) : null;
  }

  private dueCard(r: Reminder, env: SheetEnv): SheetView {
    const late = env.now - r.at > 2 * MIN;
    return {
      key: `due/${r.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'bell', tone: 'warn', title: r.text, sub: late ? `Was due ${whenText(r.at, env.now)}` : 'Reminder' },
        {
          t: 'buttons',
          key: 'act',
          align: 'fill',
          items: [
            { key: 'hour', label: '1 hour', icon: 'timer', action: 'snooze', arg: [r.id, HOUR], style: 'secondary', disabled: !env.interactive },
            { key: 'snooze', label: '10 min', icon: 'timer', action: 'snooze', arg: r.id, style: 'secondary', disabled: !env.interactive },
            { key: 'done', label: 'Done', icon: 'check', action: 'done', arg: r.id, style: 'primary', disabled: !env.interactive },
          ],
        },
      ],
    };
  }

  private card(env: SheetEnv): SheetView {
    const n = this.items.length;
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: 'bell',
        tone: 'accent',
        title: 'Reminders',
        sub: n ? `${n} set` : 'Nothing yet',
        buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost', tip: 'Control Center' }],
      },
      { t: 'input', key: 'add', placeholder: 'Submit lab at 3pm · stretch in 20m · tomorrow 9am', action: 'add' },
    ];
    if (this.note) blocks.push({ t: 'text', key: 'note', text: this.note, tone: 'bad', size: 'sm' });
    if (n) {
      const rows: SheetRow[] = this.items.slice(0, ROWS).map((r) => ({
        key: r.id,
        icon: 'bell',
        tone: r.due ? 'warn' : undefined,
        title: r.text,
        detail: r.due ? `Due · ${whenText(r.at, env.now)}` : whenText(r.at, env.now),
        button: r.due ? { key: 'done', icon: 'check', action: 'done', arg: r.id, style: 'ghost', tip: 'Done' } : { key: 'rm', icon: 'x', action: 'remove', arg: r.id, style: 'ghost', tip: 'Remove' },
      }));
      if (n > ROWS) rows.push({ key: 'more', title: `and ${n - ROWS} more`, tone: 'muted' });
      blocks.push({ t: 'rows', key: 'list', items: rows });
    } else {
      blocks.push({ t: 'text', key: 'hint', text: 'Type what and when, then Enter. The island shows it at that time, with a Windows notification.', tone: 'muted', size: 'sm' });
    }
    return { key: 'card', blocks };
  }

  action(name: string, arg: unknown): void {
    const now = Date.now();
    switch (name) {
      case 'card':
        this.note = null;
        this.ctx.openCard?.();
        break;
      case 'add': {
        const text = typeof arg === 'string' ? arg : '';
        if (!text.trim()) return;
        const p = parseReminder(text, now);
        if ('error' in p) {
          this.note = p.error;
          break;
        }
        this.note = null;
        if (this.items.length >= MAX_ITEMS) this.items.shift();
        this.items.push({ id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: p.text, at: p.at });
        this.save();
        break;
      }
      case 'snooze': {
        const [id, ms] = Array.isArray(arg) ? [String(arg[0]), Number(arg[1]) || SNOOZE_MS] : [String(arg), SNOOZE_MS];
        const r = this.items.find((x) => x.id === id);
        if (!r) return;
        r.at = now + ms;
        r.due = false;
        r.seen = false;
        this.save();
        break;
      }
      case 'done':
      case 'remove':
        this.items = this.items.filter((x) => x.id !== String(arg));
        this.save();
        break;
      default:
        return;
    }
    this.ctx.update();
  }

  command(cmd: string, arg: unknown): unknown {
    if (cmd === 'add' && typeof arg === 'string') {
      this.action('add', arg);
      return this.note === null;
    }
    return false;
  }
}

function isReminder(x: unknown): x is Reminder {
  const r = x as Reminder;
  return !!r && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.at === 'number' && Number.isFinite(r.at);
}
