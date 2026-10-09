// Calendar: your next event from an iCal (ICS) link, with a Join button for
// Teams, Meet and Zoom links. Secret feed URLs are never logged.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clip, timeOfDay, until } from '../core/format';
import { native } from '../core/native';
import { platform } from '../core/platform';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';
import { expand, parseIcs, type IcsEvent, type Occurrence } from './ics';

type Options = { ics: string; leadMinutes: number; source: 'windows' | 'ics' };

const MIN = 60000;
const HOUR = 60 * MIN;
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
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

/** Monday 00:00, local time, of the week that contains `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export class CalendarActivity extends BaseActivity {
  private events: IcsEvent[] = [];
  private occ: Occurrence[] = [];
  /** This week's events, kept until the week turns or a new feed arrives. */
  private week: { start: number; events: IcsEvent[]; occ: Occurrence[] } | null = null;
  private url = '';
  /** Occurrences straight from Windows (already expanded, no repeat rules to work out). */
  private fromWindows: Occurrence[] = [];
  /** Bumped on every Windows read, so the week cache knows the events changed. */
  private windowsRev: IcsEvent[] = [];
  /** What Windows said when it could not help (no accounts, access turned off). */
  private windowsNote: string | null = null;
  private fetchedAt = 0;
  private retryAt = 0;
  private fetching = false;
  private phase = '';
  private readonly dismissed = new Set<string>();

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
      } else this.retryAt = Date.now() + RETRY_MS;
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
    const back = Math.ceil((now - weekStart(now)) / (24 * 60 * MIN)) + 1;
    const agenda = await native.agendaRead(back, 14);
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
    this.occ = this.source() === 'windows' ? this.fromWindows.filter((o) => o.end > from && o.start < to) : expand(this.events, from, to);
    this.ctx.update();
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
    let w = this.week;
    if (!w || w.start !== start || w.events !== events) {
      const occ = windows ? this.fromWindows.filter((o) => o.start < end.getTime() && o.end > start) : expand(this.events, start, end.getTime());
      w = this.week = { start, events, occ };
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

  /** This week, Monday to Sunday. Nothing until a feed is set and has loaded once. */
  tile(env: SheetEnv): Tile | null {
    const windows = this.source() === 'windows';
    if (windows ? !this.fetchedAt : !this.url || !this.fetchedAt) return null;
    const { start, occ } = this.weekOf(env.now);
    const today = new Date(env.now).toDateString();
    const days = WEEKDAYS.map((label, i) => {
      const from = new Date(start);
      from.setDate(from.getDate() + i);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      // Overlap, the way expand() decides what is in a window: an event over midnight busies both days.
      const busy = occ.filter((o) => o.start < to.getTime() && Math.max(o.end, o.start + 1) > from.getTime()).length;
      return { label, num: from.getDate(), today: from.toDateString() === today, busy: Math.min(3, busy) };
    });
    const join = env.interactive ? this.joinable(env.now) : null;
    return {
      key: 'calendar',
      span: 2,
      action: join ? 'join' : undefined,
      tip: join ? `Join ${clip(join.o.title, 40)}` : undefined,
      body: {
        k: 'week',
        title: new Date(env.now).toLocaleDateString('en-US', { month: 'long' }),
        // With nothing to show, say why rather than leaving an empty week.
        sub: occ.length === 0 ? (windows ? (this.windowsNote ?? 'No events') : 'No events') : occ.length === 1 ? '1 event' : `${occ.length} events`,
        days,
      },
    };
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

  action(name: string): void {
    if (name !== 'join') return;
    // The card's Join button and the week tile both land here: the tile's meeting may be up to an hour away.
    const link = this.joinable(Date.now())?.link;
    if (!link) return;
    void native.open(link);
    this.ctx.close();
  }
}
