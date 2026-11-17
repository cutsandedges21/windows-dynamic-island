// The calendar's grid, worked out on its own: weeks that start on the day the
// user's locale starts them (Sunday in Canada and the US, Monday in most of
// Europe), month grids, ISO week numbers, and the "14:30 Dentist" an event is
// added with. No DOM and no clock of its own, so it is all testable.

const DAY = 24 * 60 * 60 * 1000;

/** The weekday a week starts on, as Date.getDay() counts (0 Sunday … 6 Saturday), from the locale. */
export function firstWeekday(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    // Intl counts Monday 1 … Sunday 7.
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch {
    /* an old engine: Monday */
  }
  return 1;
}

/** Midnight, local time, of the day that contains `ms`. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `n` calendar days after `ms` (whatever daylight saving does in between), at the same time of day. */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Midnight on the first day of the week that contains `ms`. */
export function weekStartOf(ms: number, first: number): number {
  const d = new Date(dayStart(ms));
  d.setDate(d.getDate() - ((d.getDay() - first + 7) % 7));
  return d.getTime();
}

/** The ISO 8601 week number (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeek(ms: number): number {
  const d = new Date(dayStart(ms));
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

/** 2026-11-13: a day's key, local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Midnight of a day from its key; null for anything else. */
export function fromDayKey(key: unknown): number | null {
  const m = typeof key === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}

/** Su, Mo, Tu… starting on `first`. */
export function weekdayHeads(first: number, locale = 'en-US'): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + ((first + i) % 7)).toLocaleDateString(locale, { weekday: 'short' }).slice(0, 2));
}

export interface GridDay {
  /** Midnight, local time. */
  start: number;
  num: number;
  /** In the month shown (a month grid starts and ends with days of the months around it). */
  inMonth: boolean;
}

/** The weeks a month grid shows for the month that contains `ms`: whole weeks, first to last day of the month. */
export function monthWeeks(ms: number, first: number): GridDay[][] {
  const d = new Date(ms);
  const month = d.getMonth();
  const firstOfMonth = new Date(d.getFullYear(), month, 1).getTime();
  let day = weekStartOf(firstOfMonth, first);
  const weeks: GridDay[][] = [];
  do {
    const week: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      const at = new Date(day);
      week.push({ start: day, num: at.getDate(), inMonth: at.getMonth() === month });
      day = addDays(day, 1);
    }
    weeks.push(week);
  } while (new Date(day).getMonth() === month);
  return weeks;
}

/** The week that contains `ms`. */
export function weekDays(ms: number, first: number): GridDay[] {
  const start = weekStartOf(ms, first);
  const month = new Date(ms).getMonth();
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(start, i);
    return { start: day, num: new Date(day).getDate(), inMonth: new Date(day).getMonth() === month };
  });
}

/** An event typed into the calendar card. */
export interface Added {
  id: string;
  title: string;
  /** Epoch ms. An all-day event runs midnight to midnight. */
  start: number;
  end: number;
  allDay: boolean;
}

/**
 * "14:30 Dentist", "2pm Gym", "9:15am Call with Sam", "14h30 Dentiste", "Lunch 12:30",
 * "14:30-15:15 Physio", or just "Mom's birthday" (all day), on the day `day` (midnight).
 * An hour alone ("9 Gym") is not taken as a time: it could be part of the name.
 */
export function parseAdded(text: string, day: number): Omit<Added, 'id'> | null {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const time = String.raw`(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
  const at = (h: string, m: string | undefined, ampm: string | undefined): number | null => {
    let hour = Number(h);
    const min = m ? Number(m) : 0;
    if (!m && !ampm) return null;
    const half = ampm?.[0]?.toLowerCase();
    if (half) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (half === 'p' ? 12 : 0);
    }
    if (hour > 23 || min > 59) return null;
    return hour * 60 + min;
  };
  const range = new RegExp(String.raw`(?:^|\s)${time}\s*(?:-|–|to)\s*${time}(?=\s|$)`, 'i');
  const one = new RegExp(String.raw`(?:^|\s)${time}(?=\s|$)`, 'i');
  const minutesFrom = (mins: number) => {
    const d = new Date(day);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d.getTime();
  };
  const r = range.exec(raw);
  if (r) {
    // "2-3pm": the first time takes the second's half of the day.
    const a = at(r[1], r[2], r[3] ?? r[6]);
    const b = at(r[4], r[5], r[6]);
    const title = (raw.slice(0, r.index) + ' ' + raw.slice(r.index + r[0].length)).trim();
    if (a != null && b != null && b > a && title) return { title, start: minutesFrom(a), end: minutesFrom(b), allDay: false };
  }
  const o = one.exec(raw);
  if (o) {
    const a = at(o[1], o[2], o[3]);
    const title = (raw.slice(0, o.index) + ' ' + raw.slice(o.index + o[0].length)).trim();
    if (a != null && title) {
      const start = minutesFrom(a);
      return { title, start, end: start + 60 * 60 * 1000, allDay: false };
    }
  }
  return { title: raw, start: day, end: addDays(day, 1), allDay: true };
}

/** Google Calendar's own "add an event" page, filled in with this event (it is saved only once you press Save there). */
export function googleAddUrl(e: Pick<Added, 'title' | 'start' | 'end' | 'allDay'>): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}00Z`;
  };
  const date = (ms: number) => dayKey(ms).replace(/-/g, '');
  const dates = e.allDay ? `${date(e.start)}/${date(e.end)}` : `${stamp(e.start)}/${stamp(e.end)}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(e.title)}&dates=${dates}`;
}
