// Cal.com: your next booked call. It shows up on the island a set time before it starts and
// again when it starts, with a Join button when the booking has a meeting link, and it says
// when a booking arrives or is cancelled. The poll (src-tauri/src/integrations.rs) lists your
// upcoming bookings with a key from the Credential Manager every few minutes; the countdown
// itself runs here, on the clock.

import { agoText, until } from '../../core/format';
import type { SheetRow } from '../../core/sheet';
import { IntegrationActivity, type TileContent } from './base';
import { MINUTE, parseTime, safeUrl, type Change, type Glance } from './util';

export interface Booking {
  id: string;
  uid: string;
  title: string;
  start: string;
  end: string | null;
  status: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  attendeeNotes: string | null;
  meetingUrl: string | null;
}

export interface CalcomSnapshot {
  bookings: Booking[];
}

const BOOKINGS_PAGE = 'https://app.cal.com/bookings/upcoming';
/** A call that has started keeps its card (and Join button) this long, for people arriving late. */
const LATE_MS = 5 * MINUTE;

export interface Upcoming {
  booking: Booking;
  start: number;
  /** soon: inside the lead time. now: started within the last few minutes. */
  phase: 'soon' | 'now';
}

/** Bookings that are still on, soonest first, as [booking, start time]. */
function live(bookings: Booking[]): Array<[Booking, number]> {
  const out: Array<[Booking, number]> = [];
  for (const b of bookings) {
    const start = parseTime(b.start);
    if (start !== null && !/cancel|reject/i.test(b.status)) out.push([b, start]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}

/** The booking the island should be showing: starting within the lead time, or just started. */
export function nextBooking(bookings: Booking[], now: number, leadMs: number): Upcoming | null {
  for (const [booking, start] of live(bookings)) {
    if (start + LATE_MS <= now) continue;
    return now >= start ? { booking, start, phase: 'now' } : start - now <= leadMs ? { booking, start, phase: 'soon' } : null;
  }
  return null;
}

/** The nod for a booking coming into range, and again at its start. */
export function bookingChange(u: Upcoming, now: number): Change {
  const { booking: b } = u;
  const join = safeUrl(b.meetingUrl);
  const who = b.attendeeName ? ` · ${b.attendeeName}` : '';
  if (u.phase === 'now') {
    return { key: `calcom:${b.id}:now`, tone: 'warn', icon: 'calendar', title: `${b.title} starting`, detail: `Started ${agoText(now - u.start)}${who}`, url: join ?? BOOKINGS_PAGE, cta: join ? { icon: 'video', label: 'Join' } : undefined, level: 'expanded' };
  }
  return { key: `calcom:${b.id}:soon`, tone: 'info', icon: 'calendar', title: `${b.title} ${until(u.start - now)}`, detail: b.attendeeName ?? undefined, url: join ?? BOOKINGS_PAGE, cta: join ? { icon: 'video', label: 'Join' } : undefined, level: 'expanded' };
}

const whenText = (start: number) => new Date(start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Bookings that arrived, and ones that disappeared before they were due (cancelled). */
export function compareCalcom(prev: CalcomSnapshot, next: CalcomSnapshot, now: number): Change[] {
  const had = new Set(live(prev.bookings).map(([b]) => b.id));
  const has = new Set(live(next.bookings).map(([b]) => b.id));
  const changes: Change[] = [];
  for (const [b, start] of live(next.bookings)) {
    if (!had.has(b.id)) changes.push({ key: `calcom:${b.id}:new`, tone: 'info', icon: 'calendar', title: 'New booking', detail: `${b.title} · ${whenText(start)}`, url: BOOKINGS_PAGE, level: 'expanded' });
  }
  for (const [b, start] of live(prev.bookings)) {
    if (!has.has(b.id) && start - now > MINUTE) changes.push({ key: `calcom:${b.id}:gone`, tone: 'warn', icon: 'calendar', title: 'Booking cancelled', detail: `${b.title} · ${whenText(start)}`, url: BOOKINGS_PAGE });
  }
  return changes;
}

export function calcomGlance(u: Upcoming, now: number): Glance {
  const join = safeUrl(u.booking.meetingUrl);
  const left = u.start - now;
  const who = u.booking.attendeeName ? ` · ${u.booking.attendeeName}` : '';
  return {
    icon: 'calendar',
    tone: left <= 5 * MINUTE ? 'warn' : 'accent',
    title: u.booking.title,
    detail: `${until(left)}${who}`,
    url: join ?? BOOKINGS_PAGE,
    cta: join ? { icon: 'video', label: 'Join' } : undefined,
  };
}

export function calcomTile(s: CalcomSnapshot, now: number): TileContent {
  const rows: SheetRow[] = live(s.bookings)
    .filter(([, start]) => start + LATE_MS > now)
    .slice(0, 3)
    .map(([b, start]) => ({
      key: b.id,
      title: b.title,
      detail: [whenText(start), b.attendeeName].filter(Boolean).join(' · '),
      badge: until(start - now).replace(/^in /, ''),
      action: 'open',
      arg: safeUrl(b.meetingUrl) ?? BOOKINGS_PAGE,
    }));
  return { span: 2, rows: 2, tone: 'accent', body: { k: 'list', icon: 'calendar', label: 'Cal.com', rows, empty: 'No calls scheduled' } };
}

export class CalcomActivity extends IntegrationActivity<CalcomSnapshot> {
  constructor() {
    super('calcom', { secret: 'calcom.key', everyMs: 300_000, home: BOOKINGS_PAGE });
  }

  protected override init(): void {
    super.init();
    this.every(5000, () => this.check());
  }

  private leadMs(): number {
    return (Number(this.ctx.options<{ leadMinutes?: number }>().leadMinutes) || 15) * MINUTE;
  }

  /** The clock side: nods when a booking comes into range and again when it starts. */
  private check(): void {
    if (!this.snapshot) return;
    const now = Date.now();
    const next = nextBooking(this.snapshot.bookings, now, this.leadMs());
    if (next) this.announce([bookingChange(next, now)]);
  }

  protected compare(prev: CalcomSnapshot, next: CalcomSnapshot, now: number): Change[] {
    return compareCalcom(prev, next, now);
  }

  protected headline(s: CalcomSnapshot, now: number): Glance | null {
    const next = nextBooking(s.bookings, now, this.leadMs());
    return next ? calcomGlance(next, now) : null;
  }

  protected tileFor(s: CalcomSnapshot, now: number): TileContent {
    return calcomTile(s, now);
  }
}
