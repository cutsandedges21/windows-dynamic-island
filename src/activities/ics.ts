// A small iCalendar (RFC 5545) reader: just what a "next meeting" widget needs.
// Pure functions with no I/O, so they are tested without the app.
//
// Understood: VEVENT with UID, SUMMARY, LOCATION, DESCRIPTION and URL; DTSTART
// and DTEND as UTC ("...Z"), floating local time, TZID (IANA or Windows zone
// names) or all-day (VALUE=DATE); DURATION; RRULE with FREQ DAILY, WEEKLY,
// MONTHLY or YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (numbered for monthly rules,
// like 2TU) and BYMONTHDAY; EXDATE; RECURRENCE-ID overrides; STATUS:CANCELLED.
// Alarms, RDATE and everything else are ignored.

export interface Occurrence {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  description: string;
  url: string;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** An IANA zone name ('UTC' included), or null for the machine's local time. */
type Zone = string | null;

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null;
  /** day: 0 Sunday to 6 Saturday; n: the "2" in 2TU, 0 when absent. */
  byDay: Array<{ n: number; day: number }>;
  byMonthDay: number[];
}

export interface IcsEvent {
  uid: string;
  title: string;
  location: string;
  description: string;
  url: string;
  allDay: boolean;
  /** First instance, ms since the epoch. */
  start: number;
  end: number;
  /** DTSTART as written, so a series keeps its wall-clock time across daylight saving. */
  wall: Wall;
  zone: Zone;
  /** Length of an all-day event in days. */
  days: number;
  rule: Rule | null;
  exdates: number[];
  /** On an override: the start of the series instance it replaces. */
  recurrenceId: number | null;
  cancelled: boolean;
}

const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Outlook writes Windows zone names in TZID. */
const WINDOWS_ZONES: Record<string, string> = {
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Canada Central Standard Time': 'America/Regina',
  'Mexico Standard Time': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Pakistan Standard Time': 'Asia/Karachi',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Africa Standard Time': 'Africa/Nairobi',
};

// ------------------------------------------------------------------ time zones

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null; // not a zone this engine knows
    }
    formatters.set(zone, f);
  }
  return f;
}

/** How far the zone's wall clock runs ahead of UTC at this instant, in ms; null for an unknown zone. */
function offsetAt(ms: number, zone: string): number | null {
  const f = formatter(zone);
  if (!f) return null;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time happens in a zone (offset math through Intl, two passes for daylight saving). */
function wallToMs(w: Wall, zone: Zone): number {
  if (zone === null) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const first = offsetAt(guess, zone) ?? 0;
  const ms = guess - first;
  const second = offsetAt(ms, zone) ?? first;
  return second === first ? ms : guess - second;
}

/** A zone name an event can use, or null (read as local time rather than lose the event). */
function zoneFor(tzid: string | undefined): Zone {
  if (!tzid) return null;
  const raw = tzid.trim();
  const parts = raw.split('/').filter(Boolean); // "/mozilla.org/20050126_1/America/New_York"
  for (const name of [WINDOWS_ZONES[raw], raw, parts.slice(-3).join('/'), parts.slice(-2).join('/')]) {
    if (name && offsetAt(0, name) !== null) return name;
  }
  return null;
}

// ------------------------------------------------------------------ calendar arithmetic (wall clock, no zones)

const addDays = (w: Wall, n: number): Wall => {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const daysBetween = (a: Wall, b: Wall) => Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / DAY);
const weekday = (w: Wall) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// ------------------------------------------------------------------ parsing

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** NAME;PARAM=value:value, where a colon inside a quoted parameter does not end the name. */
function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [name, ...rest] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const r of rest) {
    const eq = r.indexOf('=');
    if (eq > 0) params[r.slice(0, eq).toUpperCase()] = r.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

function parseTime(p: Prop): { ms: number; wall: Wall; zone: Zone; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(p.value.trim());
  if (!m) return null;
  const wall: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  if (m[4] === undefined || p.params.VALUE === 'DATE') return { ms: wallToMs(wall, null), wall, zone: null, allDay: true };
  const zone: Zone = m[7] ? 'UTC' : zoneFor(p.params.TZID);
  return { ms: wallToMs(wall, zone), wall, zone, allDay: false };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((n(2) * 7 + n(3)) * 24 * 3600 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRule(value: string, zone: Zone): Rule | null {
  const parts = new Map<string, string>();
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts.set(kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1));
  }
  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const byDay: Rule['byDay'] = [];
  for (const token of (parts.get('BYDAY') ?? '').split(',')) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
    if (m) byDay.push({ n: m[1] ? Number(m[1]) : 0, day: WEEKDAYS.indexOf(m[2].toUpperCase()) });
  }

  // UNTIL is a date (end of that day) or a date-time, UTC or in the event's zone.
  let until: number | null = null;
  const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(parts.get('UNTIL') ?? '');
  if (u) until = wallToMs({ y: +u[1], mo: +u[2], d: +u[3], h: +(u[4] ?? 23), mi: +(u[5] ?? 59), s: +(u[6] ?? 59) }, u[7] ? 'UTC' : zone);

  const count = Number(parts.get('COUNT'));
  return {
    freq,
    interval: Math.max(1, Math.floor(Number(parts.get('INTERVAL'))) || 1),
    count: Number.isInteger(count) && count > 0 ? count : null,
    until,
    byDay,
    byMonthDay: (parts.get('BYMONTHDAY') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31),
  };
}

function build(props: Prop[]): IcsEvent | null {
  const first = (name: string) => props.find((p) => p.name === name);
  const text = (name: string) => unescapeText(first(name)?.value ?? '');

  const dtstart = first('DTSTART');
  const start = dtstart && parseTime(dtstart);
  if (!start) return null;
  const dtend = first('DTEND');
  const end = dtend && parseTime(dtend);
  const dur = first('DURATION') ? parseDuration(first('DURATION')!.value) : null;

  let days = 1;
  let endMs: number;
  if (start.allDay) {
    // An all-day DTEND is the day after the last day.
    days = end ? Math.max(1, daysBetween(start.wall, end.wall)) : dur !== null ? Math.max(1, Math.round(dur / DAY)) : 1;
    endMs = wallToMs(addDays(start.wall, days), null);
  } else endMs = end ? end.ms : dur !== null ? start.ms + dur : start.ms;

  const exdates: number[] = [];
  for (const p of props) {
    if (p.name !== 'EXDATE') continue;
    for (const v of p.value.split(',')) {
      const t = parseTime({ ...p, value: v });
      if (t) exdates.push(t.ms);
    }
  }
  const rid = first('RECURRENCE-ID');
  const rec = rid && parseTime(rid);
  const rrule = first('RRULE');
  const title = text('SUMMARY');
  return {
    uid: text('UID') || `${title}@${start.ms}`,
    title,
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    url: text('URL') || text('X-GOOGLE-CONFERENCE') || text('X-MICROSOFT-SKYPETEAMSMEETINGURL'),
    allDay: start.allDay,
    start: start.ms,
    end: Math.max(endMs, start.ms),
    wall: start.wall,
    zone: start.zone,
    days,
    rule: rrule ? parseRule(rrule.value, start.zone) : null,
    exdates,
    recurrenceId: rec ? rec.ms : null,
    cancelled: first('STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
  };
}

/** Reads every VEVENT in an .ics file. Never throws on odd input: events it cannot read are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Prop[] | null = null;
  let nested = 0; // depth inside a VALARM or other sub-component of the event
  // Long lines are folded: a CRLF followed by a space or tab continues the line.
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r\n|\n|\r/)) {
    const p = line ? parseLine(line) : null;
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT') {
        cur = [];
        nested = 0;
      } else if (cur) nested++;
    } else if (p.name === 'END') {
      if (p.value.toUpperCase() === 'VEVENT') {
        const ev = cur && build(cur);
        if (ev) events.push(ev);
        cur = null;
      } else if (cur && nested > 0) nested--;
    } else if (cur && nested === 0) cur.push(p);
  }
  return events;
}

// ------------------------------------------------------------------ recurrence

/** Wall-clock starts inside the k-th period of the rule, earliest first. */
function period(base: Wall, r: Rule, k: number): Wall[] {
  switch (r.freq) {
    case 'DAILY': {
      const w = addDays(base, k * r.interval);
      return r.byDay.length && !r.byDay.some((b) => b.day === weekday(w)) ? [] : [w];
    }
    case 'WEEKLY': {
      const monday = addDays(base, -((weekday(base) + 6) % 7) + 7 * r.interval * k);
      const offsets = (r.byDay.length ? r.byDay.map((b) => b.day) : [weekday(base)]).map((d) => (d + 6) % 7);
      return [...new Set(offsets)].sort((a, b) => a - b).map((o) => addDays(monday, o));
    }
    case 'MONTHLY': {
      const m = base.mo - 1 + k * r.interval;
      return monthDays(base, base.y + Math.floor(m / 12), (m % 12) + 1, r);
    }
    case 'YEARLY': {
      const y = base.y + k * r.interval;
      return base.d <= daysIn(y, base.mo) ? [{ ...base, y }] : [];
    }
  }
}

function monthDays(base: Wall, y: number, mo: number, r: Rule): Wall[] {
  const size = daysIn(y, mo);
  const days = new Set<number>();
  if (r.byDay.length) {
    const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    for (const { n, day } of r.byDay) {
      const hits: number[] = [];
      for (let d = 1 + ((day - firstDow + 7) % 7); d <= size; d += 7) hits.push(d);
      if (n === 0) hits.forEach((d) => days.add(d));
      else {
        const d = n > 0 ? hits[n - 1] : hits[hits.length + n]; // 2TU is the second Tuesday, -1FR the last Friday
        if (d) days.add(d);
      }
    }
  } else {
    for (const n of r.byMonthDay.length ? r.byMonthDay : [base.d]) {
      const d = n > 0 ? n : size + 1 + n;
      if (d >= 1 && d <= size) days.add(d);
    }
  }
  return [...days].sort((a, b) => a - b).map((d) => ({ ...base, y, mo, d }));
}

/** Instance starts of a recurring event in order, up to `untilMs` (COUNT and UNTIL honoured). */
function* instances(e: IcsEvent, fromMs: number, untilMs: number): Generator<{ ms: number; wall: Wall }> {
  const r = e.rule!;
  const periodMs = r.freq === 'DAILY' ? DAY : r.freq === 'WEEKLY' ? 7 * DAY : r.freq === 'MONTHLY' ? 28 * DAY : 365 * DAY;
  // Without COUNT the old periods need not be walked: begin a little before the window.
  let k = r.count === null ? Math.max(0, Math.floor((fromMs - (e.end - e.start) - e.start) / (periodMs * r.interval)) - 1) : 0;
  let produced = 0;
  for (let guard = 0; guard < 20000; guard++, k++) {
    for (const wall of period(e.wall, r, k)) {
      const ms = wallToMs(wall, e.zone);
      if (ms < e.start) continue; // earlier in the first week than DTSTART itself
      if (r.until !== null && ms > r.until) return;
      if (r.count !== null && ++produced > r.count) return;
      if (ms >= untilMs) return;
      yield { ms, wall };
    }
  }
}

/** Occurrences that overlap [fromMs, toMs), sorted by start. */
export function expand(events: IcsEvent[], fromMs: number, toMs: number): Occurrence[] {
  // An override (RECURRENCE-ID) replaces one instance of its series, whether it moved or was cancelled.
  const replaced = new Map<string, Set<number>>();
  for (const e of events) {
    if (e.recurrenceId === null) continue;
    let set = replaced.get(e.uid);
    if (!set) replaced.set(e.uid, (set = new Set()));
    set.add(e.recurrenceId);
  }

  const out: Occurrence[] = [];
  const add = (e: IcsEvent, start: number, end: number) => {
    if (start < toMs && Math.max(end, start + 1) > fromMs) {
      out.push({ uid: e.uid, title: e.title, start, end, allDay: e.allDay, location: e.location, description: e.description, url: e.url });
    }
  };
  for (const e of events) {
    if (e.cancelled) continue;
    if (!e.rule || e.recurrenceId !== null) {
      add(e, e.start, e.end);
      continue;
    }
    const skip = replaced.get(e.uid);
    for (const { ms, wall } of instances(e, fromMs, toMs)) {
      if (e.exdates.includes(ms) || skip?.has(ms)) continue;
      add(e, ms, e.allDay ? wallToMs(addDays(wall, e.days), null) : ms + (e.end - e.start));
    }
  }
  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}
