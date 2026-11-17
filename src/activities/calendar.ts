// Calendar: your next event from an iCal (ICS) link, with a Join button for
// Teams, Meet and Zoom links. Secret feed URLs are never logged.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clip, timeOfDay, until } from '../core/format';
import { native } from '../core/native';
import { platform } from '../core/platform';
import type { Seg } from '../core/segments';
import type { Block, CalDay, CalEvent, SheetButton, SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';
import { addDays, dayKey, dayStart, firstWeekday, fromDayKey, googleAddUrl, isoWeek, monthWeeks, parseAdded, weekdayHeads, weekDays, weekStartOf, type Added, type GridDay } from './calgrid';
import { expand, parseIcs, type IcsEvent, type Occurrence } from './ics';

type Options = { ics: string; leadMinutes: number; source: 'windows' | 'ics'; view: 'week' | 'month'; added: Added[] };

/** Events typed into the card are kept with the calendar's options; their uid says so. */
const ADDED = 'island-added:';
const ADDED_MAX = 300;

const MIN = 60000;
const HOUR = 60 * MIN;
const FETCH_MS = 10 * MIN;
const RETRY_MS = 5 * MIN;
/** A meeting that has started keeps its card (and Join button) this long, for people arriving late. */
const LATE_MS = 5 * MIN;
const URGENT_MS = 60000;
const MEETING = /https?:\/\/(?:[\w-]+\.)*(?:teams\.microsoft\.com|meet\.google\.com|zoom\.us)\/[^\s<>"')\]\\]*/i;

/** webcal:// is how calendar apps hand out ICS links; the native fetch only speaks https. */
function feedUrl(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^(?:webcals?|https?):\/\//i, 'https://') : '';
}

function meetingLink(o: Occurrence): string | null {
  for (const text of [o.url, o.location, o.description]) {
    const m = MEETING.exec(text);
    if (m) return m[0].replace(/[.,;:!?]+$/, '');
  }
  return null;
}

/** Midnight of the first day of the week that contains `ms`, as the user's locale starts weeks. */
function weekStart(ms: number): number {
  return weekStartOf(ms, firstWeekday());
}

/** The events typed into the card, as saved (anything malformed is dropped). */
export function savedAdded(raw: unknown): Added[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is Added =>
      Boolean(a) && typeof a.id === 'string' && typeof a.title === 'string' && Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start && typeof a.allDay === 'boolean',
  );
}

export class CalendarActivity extends BaseActivity {
  private events: IcsEvent[] = [];
  private occ: Occurrence[] = [];
  /** This week's events, kept until the week turns or a new feed arrives. */
  private week: { start: number; events: IcsEvent[]; added: unknown; occ: Occurrence[] } | null = null;
  private url = '';
  /** Occurrences straight from Windows (already expanded, no repeat rules to work out). */
  private fromWindows: Occurrence[] = [];
  /** Bumped on every Windows read, so the week cache knows the events changed. */
  private windowsRev: IcsEvent[] = [];
  /** What Windows said when it could not help (no accounts, access turned off). */
  private windowsNote: string | null = null;
  private fetchedAt = 0;
  private retryAt = 0;
  /** Loads of the link that failed in a row: the first few try again soon (a network still coming up). */
  private fails = 0;
  private fetching = false;
  private phase = '';
  private readonly dismissed = new Set<string>();
  /** The card: the day picked (midnight) and the day whose week or month shows. */
  private picked = 0;
  private shownAt = 0;

  constructor() {
    super('calendar');
  }

  protected init(): void {
    this.every(MIN, () => void this.refresh(), true);
    this.every(1000, () => this.check());
  }

  reconfigure(): void {
    void this.refresh();
  }

  /** Windows accounts by default; a link only when the user picks one. A Mac has only the link so far. */
  private source(): 'windows' | 'ics' {
    if (platform === 'macos') return 'ics';
    return this.ctx.options<Partial<Options>>().source === 'ics' ? 'ics' : 'windows';
  }

  private lead(): number {
    return (Number(this.ctx.options<Partial<Options>>().leadMinutes) || 15) * MIN;
  }

  private async refresh(): Promise<void> {
    if (this.source() === 'windows') return this.refreshWindows();
    const url = feedUrl(this.ctx.options<Partial<Options>>().ics);
    if (url !== this.url) {
      // A new (or removed) link: nothing from the old feed may linger.
      this.url = url;
      this.events = [];
      this.occ = [];
      this.fetchedAt = 0;
      this.retryAt = 0;
      this.ctx.update();
    }
    const now = Date.now();
    if (url && !this.fetching && now - this.fetchedAt >= FETCH_MS && now >= this.retryAt) {
      this.fetching = true;
      const r = await native.httpGet(url, 4_000_000);
      this.fetching = false;
      if (!this.alive) return;
      if (url !== this.url) return void this.refresh(); // the link changed while this was loading
      let events: IcsEvent[] | null = null;
      if (r && r.status === 200 && r.body.includes('BEGIN:VCALENDAR')) {
        try {
          events = parseIcs(r.body);
        } catch {
          events = null;
        }
      }
      if (events) {
        this.events = events;
        this.fetchedAt = Date.now();
        this.fails = 0;
      } else {
        this.fails++;
        this.retryAt = Date.now() + (this.fails <= 3 ? MIN / 2 : RETRY_MS);
      }
    }
    this.recompute(Date.now());
  }

  /**
   * Everything Windows syncs: one read covers the whole of this week (for the
   * strip) and the days ahead (for what is next). Windows expands repeats itself.
   */
  private async refreshWindows(): Promise<void> {
    if (this.fetching) return;
    const now = Date.now();
    if (now - this.fetchedAt < FETCH_MS && now < this.retryAt) return this.recompute(now);
    this.fetching = true;
    // This week and this month (for the grid), and the weeks ahead (what is next, the card).
    const from = Math.min(weekStart(now), monthWeeks(now, firstWeekday())[0][0].start);
    const back = Math.ceil((now - from) / (24 * 60 * MIN)) + 1;
    const agenda = await native.agendaRead(back, 45);
    this.fetching = false;
    if (!this.alive) return;
    if (agenda?.ok) {
      this.fromWindows = agenda.events.map((e) => ({
        uid: e.id || `${e.start}-${e.title}`,
        title: e.title,
        start: e.start,
        end: e.end > e.start ? e.end : e.start + 30 * MIN,
        allDay: e.allDay,
        location: e.location,
        description: '',
        url: e.link,
      }));
      this.fromWindows.sort((a, b) => a.start - b.start);
      this.windowsRev = [];
      this.windowsNote = agenda.reason;
      this.fetchedAt = Date.now();
    } else {
      this.windowsNote = agenda?.reason ?? 'Windows would not share the calendar';
      this.retryAt = Date.now() + RETRY_MS;
    }
    this.recompute(Date.now());
  }

  /** The window the island cares about: the last hour (late joiners) to two days ahead. */
  private recompute(now: number): void {
    const from = now - 60 * MIN;
    const to = now + 2 * 24 * 60 * MIN;
    this.occ = this.occIn(from, to);
    this.ctx.update();
  }

  private added(): Added[] {
    return savedAdded(this.ctx.options<Partial<Options>>().added);
  }

  private view(): 'week' | 'month' {
    return this.ctx.options<Partial<Options>>().view === 'month' ? 'month' : 'week';
  }

  /** Everything between `from` and `to`: the feed's (or Windows') events and those typed into the card, soonest first. */
  private occIn(from: number, to: number): Occurrence[] {
    const base = this.source() === 'windows' ? this.fromWindows.filter((o) => o.end > from && o.start < to) : expand(this.events, from, to);
    const mine = this.added()
      .filter((a) => a.end > from && a.start < to)
      .map((a): Occurrence => ({ uid: ADDED + a.id, title: a.title, start: a.start, end: a.end, allDay: a.allDay, location: '', description: '', url: '' }));
    return [...base, ...mine].sort((a, b) => a.start - b.start);
  }

  /** The first timed event still worth showing, if it starts within the lead time. */
  private next(now: number): Occurrence | null {
    for (const o of this.occ) {
      if (o.allDay || o.start + LATE_MS <= now) continue;
      return o.start - now <= this.lead() ? o : null;
    }
    return null;
  }

  /** The first meeting with a join link that starts within the hour (or the lead time, if that is longer), or began a moment ago. */
  private joinable(now: number): { o: Occurrence; link: string } | null {
    const within = Math.max(HOUR, this.lead());
    for (const o of this.occ) {
      if (o.allDay || o.start + LATE_MS <= now) continue;
      if (o.start - now > within) break; // sorted by start: nothing later is nearer
      const link = meetingLink(o);
      if (link) return { o, link };
    }
    return null;
  }

  private weekOf(now: number): { start: number; occ: Occurrence[] } {
    const start = weekStart(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const windows = this.source() === 'windows';
    const events = windows ? this.windowsRev : this.events;
    const added = this.ctx.options<Partial<Options>>().added;
    let w = this.week;
    if (!w || w.start !== start || w.events !== events || w.added !== added) {
      w = this.week = { start, events, added, occ: this.occIn(start, end.getTime()) };
    }
    return w;
  }

  private urgentKey(o: Occurrence): string {
    return `start-${o.uid}${o.start}`;
  }

  /** Nods when an event comes into range and again at its start, even if nothing else triggers a redraw. */
  /** A meeting starting now needs you. */
  override pet(now: number): PetSignal {
    const o = this.next(now);
    return { mood: o && now >= o.start && now - o.start < URGENT_MS ? 'needs-you' : null, moment: this.petMoment };
  }

  private check(): void {
    const now = Date.now();
    const o = this.next(now);
    const phase = o ? `${this.urgentKey(o)}:${now >= o.start ? 'now' : 'soon'}` : '';
    if (phase === this.phase) return;
    this.phase = phase;
    if (o && now >= o.start && now - o.start < URGENT_MS) {
      this.ctx.surface({ key: this.urgentKey(o), ms: URGENT_MS, level: 'expanded' });
      this.ctx.alert('shake');
      this.ctx.alert('glow', 'accent');
    } else if (o && now < o.start) {
      this.ctx.surface({ key: `soon-${o.uid}${o.start}`, ms: 5000, level: 'expanded' });
      this.saw('meeting-soon', `calendar:${o.uid}${o.start}`);
    }
    this.ctx.update();
  }

  dismiss(key: string): void {
    if (this.dismissed.size > 50) this.dismissed.clear();
    this.dismissed.add(key);
  }

  status(): ActivityStatus {
    const now = Date.now();
    const o = this.next(now);
    if (!o) return { active: false };
    const key = this.urgentKey(o);
    const starting = now >= o.start && now - o.start < URGENT_MS && !this.dismissed.has(key);
    return {
      active: true,
      weight: o.start - now <= 5 * MIN ? 'foreground' : 'background',
      urgent: starting ? { key, level: 'expanded' } : null,
      summary: `${o.title} ${until(o.start - now)}`,
    };
  }

  chip(env: RenderEnv): ChipView | null {
    const o = this.next(env.now);
    if (!o) return null;
    return { icon: 'calendar', label: until(o.start - env.now).replace(/^in /, ''), tone: o.start - env.now <= 5 * MIN ? 'warn' : 'accent' };
  }

  /**
   * Today's events (or this month: Activities › Calendar › Show).
   * A tap opens the calendar card. It always shows (Justin: "Nothing right now" when the link had not
   * loaded yet): the days and the events typed into the card, the link's as soon as it loads.
   */
  tile(env: SheetEnv): Tile | null {
    const windows = this.source() === 'windows';
    if (windows && !this.fetchedAt) return null;
    const open = env.interactive ? { action: 'card', tip: 'Open the calendar' } : {};
    if (this.view() === 'month') {
      const first = firstWeekday();
      const weeks = monthWeeks(env.now, first);
      const from = weeks[0][0].start;
      const occ = this.occIn(from, addDays(weeks[weeks.length - 1][6].start, 1));
      const days = weeks.flat().map((d) => this.calDay(d, occ, env.now, null));
      const inMonth = occ.filter((o) => new Date(o.start).getMonth() === new Date(env.now).getMonth()).length;
      return {
        key: 'calendar',
        span: 2,
        rows: 2,
        ...open,
        body: {
          k: 'month',
          title: new Date(env.now).toLocaleDateString('en-US', { month: 'long' }),
          sub: this.countText(inMonth, windows),
          heads: weekdayHeads(first),
          days,
        },
      };
    }
    // Today's events, not the week's days (Justin): all-day ones first, then what is on now and
    // what comes next; the ones already over are left off.
    const { occ } = this.weekOf(env.now);
    const from = dayStart(env.now);
    const to = addDays(from, 1);
    const today = occ.filter((o) => o.start < to && Math.max(o.end, o.start + 1) > from);
    const left = today
      .filter((o) => o.allDay || Math.max(o.end, o.start + 1) > env.now)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
    const rows = left.map((o): SheetRow => {
      const now = !o.allDay && o.start <= env.now;
      return {
        key: `${o.uid}${o.start}`,
        dot: now ? 'good' : 'accent',
        title: o.title || 'Event',
        detail: o.allDay ? 'All day' : now ? `Now, until ${timeOfDay(o.end)}` : `${timeOfDay(o.start)} - ${timeOfDay(o.end)}`,
      };
    });
    const empty = windows && !today.length && this.windowsNote ? this.windowsNote : today.length ? 'Nothing else today' : 'Nothing today';
    return {
      key: 'calendar',
      span: 2,
      rows: rows.length > 2 ? 2 : 1,
      ...open,
      body: {
        k: 'list',
        icon: 'calendar',
        label: 'Today',
        sub: new Date(env.now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        rows,
        empty,
      },
    };
  }

  private countText(n: number, windows: boolean): string {
    if (n === 0) return windows ? (this.windowsNote ?? 'No events') : 'No events';
    return n === 1 ? '1 event' : `${n} events`;
  }

  /** One day of a grid: its number, whether it is today or picked, and how busy it is. */
  private calDay(d: GridDay, occ: Occurrence[], now: number, picked: number | null): CalDay {
    const to = addDays(d.start, 1);
    // Overlap, the way expand() decides what is in a window: an event over midnight busies both days.
    const busy = occ.filter((o) => o.start < to && Math.max(o.end, o.start + 1) > d.start).length;
    return { key: dayKey(d.start), num: d.num, today: d.start === dayStart(now), selected: picked === d.start, out: !d.inMonth, busy: Math.min(3, busy) };
  }

  /**
   * The calendar card (a tap on the tile): the week or month, arrows to move through them, the
   * picked day with its events beside it, and a box to add one to that day ("14:30 Dentist").
   */
  sheet(env: SheetEnv): SheetView | null {
    if (env.reason !== 'open') return null;
    const now = env.now;
    const picked = this.picked || dayStart(now);
    const shown = this.shownAt || picked;
    const first = firstWeekday();
    const month = this.view() === 'month';
    const weeks: GridDay[][] = month ? monthWeeks(shown, first) : [weekDays(shown, first)];
    const from = weeks[0][0].start;
    const to = addDays(weeks[weeks.length - 1][6].start, 1);
    const occ = this.occIn(Math.min(from, picked), Math.max(to, addDays(picked, 1)));
    const at = new Date(shown);
    const head: SheetButton[] = [
      { key: 'mode', label: month ? 'Week' : 'Month', action: 'cal-view', arg: month ? 'week' : 'month', style: 'ghost', tip: month ? 'Show one week' : 'Show the whole month' },
      { key: 'today', label: 'Today', action: 'cal-today', style: 'ghost', tip: 'Back to today' },
      { key: 'prev', icon: 'chevron-left', action: 'cal-prev', style: 'ghost', tip: month ? 'Last month' : 'Last week' },
      { key: 'next', icon: 'chevron-right', action: 'cal-next', style: 'ghost', tip: month ? 'Next month' : 'Next week' },
    ];
    const pickedDate = new Date(picked);
    const today = picked === dayStart(now);
    const rel = today ? 'Today' : picked === dayStart(addDays(now, 1)) ? 'Tomorrow' : picked === dayStart(addDays(now, -1)) ? 'Yesterday' : pickedDate.getFullYear() !== new Date(now).getFullYear() ? String(pickedDate.getFullYear()) : '';
    const dayEnd = addDays(picked, 1);
    const events: CalEvent[] = occ
      .filter((o) => o.start < dayEnd && Math.max(o.end, o.start + 1) > picked)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
      .map((o) => this.calEvent(o, now));
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: 'calendar',
        title: 'Calendar',
        back: { key: 'back', icon: 'chevron-left', action: 'cal-back', style: 'ghost', tip: 'Back to Control Center' },
        buttons: head,
      },
      {
        t: 'calendar',
        key: 'cal',
        title: month ? at.toLocaleDateString('en-US', { month: 'long' }) : `Week ${isoWeek(weeks[0][3].start)}`,
        year: month ? String(at.getFullYear()) : at.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        heads: weekdayHeads(first),
        week: !month,
        weeks: weeks.map((w) => ({ no: isoWeek(w[3].start), days: w.map((d) => this.calDay(d, occ, now, picked)) })),
        pick: 'cal-pick',
        day: {
          kicker: pickedDate.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase(),
          title: pickedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }),
          sub: [rel, `Week ${isoWeek(picked)}`].filter(Boolean).join(' · '),
          events,
          empty: 'Nothing planned',
        },
      },
      {
        t: 'input',
        key: 'add',
        placeholder: `Add to ${pickedDate.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}: 14:30 Dentist`,
        action: 'cal-add',
        hint: 'A time first or last ("2pm Gym", "Lunch 12:30", "9:00-10:30 Class"), or no time for all day. Enter adds it.',
      },
    ];
    return { key: 'calendar-card', width: 660, blocks };
  }

  private calEvent(o: Occurrence, now: number): CalEvent {
    const mine = o.uid.startsWith(ADDED);
    const link = meetingLink(o);
    const buttons: SheetButton[] = [];
    if (link && o.end + LATE_MS > now) buttons.push({ key: 'join', icon: 'video', label: 'Join', action: 'cal-join', arg: link, style: 'primary', tip: 'Join meeting' });
    if (mine) {
      buttons.push(
        { key: 'google', icon: 'external', action: 'cal-google', arg: o.uid.slice(ADDED.length), style: 'ghost', tip: 'Also add it to Google Calendar (opens its page; press Save there)' },
        { key: 'remove', icon: 'x', action: 'cal-remove', arg: o.uid.slice(ADDED.length), style: 'ghost', tip: 'Remove' },
      );
    }
    const time = o.allDay ? 'All day' : `${timeOfDay(o.start)} – ${timeOfDay(o.end)}`;
    return { key: `${o.uid}${o.start}`, time, title: o.title, sub: mine ? 'Added here' : clip(o.location, 60) || undefined, tone: o.end <= now ? 'muted' : mine ? 'good' : 'accent', buttons };
  }

  render(env: RenderEnv): Seg[] {
    const o = this.next(env.now);
    if (!o) return [];
    const left = o.start - env.now;
    const near = left <= 5 * MIN;
    const when = until(left);
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'calendar', tone: near ? 'warn' : 'accent', anim: left <= 0 ? 'pulse' : undefined, prio: 0 }];
    if (!env.vertical) segs.push({ t: 'text', key: 'title', text: o.title, weight: 'semibold', prio: 2, min: 60, max: roomy ? undefined : 130 });
    if (env.level === 'maximum' && !env.vertical) segs.push({ t: 'text', key: 'at', text: timeOfDay(o.start), tone: 'muted', size: 'sm', side: 'end', prio: 5 });
    segs.push({ t: 'text', key: 'when', text: env.vertical ? when.replace(/^in /, '') : when, tone: near ? 'warn' : 'default', weight: 'semibold', side: 'end', prio: 0 });
    if (roomy && meetingLink(o)) segs.push(this.joinButton(env));
    return segs;
  }

  private joinButton(env: RenderEnv): Seg {
    return { t: 'button', key: 'join', icon: 'video', label: env.vertical ? undefined : 'Join', action: 'join', style: 'primary', side: 'end', prio: 1, tip: 'Join meeting' };
  }

  action(name: string, arg?: unknown): void {
    if (name.startsWith('card') || name.startsWith('cal-')) return this.cardAction(name, arg);
    if (name !== 'join') return;
    // The card's Join button and the week tile both land here: the tile's meeting may be up to an hour away.
    const link = this.joinable(Date.now())?.link;
    if (!link) return;
    void native.open(link);
    this.ctx.close();
  }

  private cardAction(name: string, arg: unknown): void {
    const now = Date.now();
    const month = this.view() === 'month';
    const step = (n: number) => {
      const d = new Date(this.shownAt || this.picked || dayStart(now));
      if (month) {
        d.setDate(1);
        d.setMonth(d.getMonth() + n);
      } else d.setDate(d.getDate() + 7 * n);
      this.shownAt = d.getTime();
      // The picked day moves along, to the same weekday (or the 1st of the month).
      this.picked = month ? dayStart(d.getTime()) : dayStart(addDays(this.picked || dayStart(now), 7 * n));
    };
    switch (name) {
      case 'card':
        this.picked = this.shownAt = dayStart(now);
        this.ctx.openCard?.();
        return;
      case 'cal-back':
        this.ctx.closeCard?.();
        return;
      case 'cal-today':
        this.picked = this.shownAt = dayStart(now);
        break;
      case 'cal-prev':
        step(-1);
        break;
      case 'cal-next':
        step(1);
        break;
      case 'cal-view':
        if (arg === 'week' || arg === 'month') this.ctx.setOptions?.({ view: arg });
        this.shownAt = this.picked || dayStart(now);
        break;
      case 'cal-pick': {
        const day = fromDayKey(arg);
        if (day == null) return;
        this.picked = day;
        // A day of the month before or after, picked from the grid's edge: that month shows.
        if (month && new Date(day).getMonth() !== new Date(this.shownAt || day).getMonth()) this.shownAt = day;
        if (!month) this.shownAt = day;
        break;
      }
      case 'cal-add': {
        const typed = parseAdded(String(arg ?? ''), this.picked || dayStart(now));
        if (!typed) return;
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const added = [...this.added(), { id, ...typed }].sort((a, b) => a.start - b.start).slice(-ADDED_MAX);
        this.ctx.setOptions?.({ added });
        this.recompute(now);
        return;
      }
      case 'cal-remove':
        this.ctx.setOptions?.({ added: this.added().filter((a) => a.id !== arg) });
        this.recompute(now);
        return;
      case 'cal-google': {
        const a = this.added().find((x) => x.id === arg);
        if (a) void native.open(googleAddUrl(a));
        return;
      }
      case 'cal-join':
        if (typeof arg === 'string' && /^https:\/\//i.test(arg)) {
          void native.open(arg);
          this.ctx.close();
        }
        return;
      default:
        return;
    }
    this.ctx.update();
  }
}

