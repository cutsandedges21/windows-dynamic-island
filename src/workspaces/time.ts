// The Workspaces page's Time tab, the numbers: how long each workspace was in front, day by day
// through a week (Sunday first), from what Notice what I work on keeps (notice/model.ts). Pure;
// timeview.ts draws it.

import { ACCENTS } from '../core/settings';
import { displayName, type Workspace } from './model';

/** Time with one workspace's window in front: [start, end, workspace id]. */
export type WsSpan = [number, number, string];

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The noticed spans that belong to a workspace and touch [since, until). */
export function workspaceSpans(spans: ReadonlyArray<{ start: number; end: number; ws: string | null }>, since: number, until: number): WsSpan[] {
  const out: WsSpan[] = [];
  for (const s of spans) if (s.ws && s.end > since && s.start < until) out.push([s.start, s.end, s.ws]);
  return out;
}

const WEEK_MS = 7 * 86_400_000;

/** Midnight starting the Sunday of the week `back` weeks before the one holding `now` (local time). */
export function weekStart(now: number, back = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() - 7 * back);
  return d.getTime();
}

/** The week's eight midnights: day i runs from [i] to [i + 1]. Right across daylight saving changes. */
export function midnights(start: number): number[] {
  const d = new Date(start);
  const out = [d.getTime()];
  for (let i = 0; i < 7; i++) {
    d.setDate(d.getDate() + 1);
    out.push(d.getTime());
  }
  return out;
}

export interface Week {
  start: number;
  bounds: number[];
  /** Per day, the time per workspace id. */
  days: Array<Map<string, number>>;
  /** The week's time per workspace id. */
  byWs: Map<string, number>;
  total: number;
}

/** The spans' time, day by day through the week that starts at `start`; a span over midnight counts on both days. */
export function weekOf(spans: WsSpan[], start: number): Week {
  const bounds = midnights(start);
  const days = bounds.slice(0, 7).map(() => new Map<string, number>());
  const byWs = new Map<string, number>();
  let total = 0;
  for (const [s, e, ws] of spans) {
    for (let i = 0; i < 7; i++) {
      const ms = Math.min(e, bounds[i + 1]) - Math.max(s, bounds[i]);
      if (ms <= 0) continue;
      days[i].set(ws, (days[i].get(ws) ?? 0) + ms);
      byWs.set(ws, (byWs.get(ws) ?? 0) + ms);
      total += ms;
    }
  }
  return { start, bounds, days, byWs, total };
}

/** Days of the week that have begun: all seven for a past week, up to today for this one. */
export function daysBegun(week: Week, now: number): number {
  return week.bounds.slice(0, 7).filter((b) => b <= now).length;
}

/** The average day so far (today counts: it's under way). */
export function averageDay(week: Week, now: number): number {
  const n = daysBegun(week, now);
  return n ? week.total / n : 0;
}

// ------------------------------------------------------------------ series and colours

export type Family = 'sky' | 'ember' | 'mint' | 'violet' | 'gold' | 'rose';

/**
 * Each workspace colour, stepped for the dark chart card: same hue, lightness in the band where a
 * colour reads as itself on a dark surface. Checked as a set with the data-viz palette validator
 * on the card's colour (#212123): any two of them stay apart for colour-blind eyes (OKLab ΔE ≥ 8,
 * protan/deutan) and for everyone else (≥ 15), and each is ≥ 3:1 against the card. Any two can
 * sit side by side, so the order of slices and stacks never matters.
 */
export const CHART_COLORS: Record<Family, string> = { sky: '#4f97e4', ember: '#bc4d1f', mint: '#10895e', violet: '#7c5cca', gold: '#bd8c12', rose: '#e06290' };
const FAMILIES = Object.keys(CHART_COLORS) as Family[];
/** Workspaces past the fifth, together. */
export const OTHER_COLOR = '#6b6b72';
/** A donut stays readable up to six slices. */
const MAX_SERIES = 6;

export interface Series {
  /** The workspace's id, or 'other'. */
  key: string;
  name: string;
  color: string;
  /** Over the week. */
  ms: number;
  /** The workspaces it stands for (several for Other). */
  ids: string[];
}

function hue(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 0.08) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The colour family a workspace's colour belongs to ('' is the accent; white has none). */
export function familyOf(color: string, accent: string): Family | null {
  if ((FAMILIES as string[]).includes(color)) return color as Family;
  if (color) return null;
  const named = Object.entries(ACCENTS).find(([, hex]) => hex.toLowerCase() === accent.trim().toLowerCase());
  if (named) return familyOf(named[0], '');
  // A colour of the user's own: the family nearest in hue.
  const h = hue(accent);
  if (h === null) return null;
  const gap = (f: Family) => {
    const d = Math.abs(hue(ACCENTS[f])! - h);
    return Math.min(d, 360 - d);
  };
  return FAMILIES.reduce((best, f) => (gap(f) < gap(best) ? f : best));
}

/**
 * The week's workspaces, most time first: up to six, or five and the rest as Others. Each keeps
 * its own colour's family; two wanting the same one, the first in the user's order keeps it and
 * the other takes the first that's free (so colours don't move with the ranking).
 */
export function seriesOf(week: Week, list: Workspace[], accent: string): Series[] {
  const byId = new Map(list.map((w, i) => [w.id, { w, i }]));
  const ranked = [...week.byWs.entries()].filter(([id, ms]) => ms > 0 && byId.has(id)).sort((a, b) => b[1] - a[1] || byId.get(a[0])!.i - byId.get(b[0])!.i);
  const shown = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const rest = ranked.slice(shown.length);
  const inOrder = shown.map(([id]) => id).sort((a, b) => byId.get(a)!.i - byId.get(b)!.i);
  const color = new Map<string, Family>();
  const taken = new Set<Family>();
  for (const id of inOrder) {
    const f = familyOf(byId.get(id)!.w.color, accent);
    if (f && !taken.has(f)) {
      color.set(id, f);
      taken.add(f);
    }
  }
  for (const id of inOrder) {
    if (color.has(id)) continue;
    const f = FAMILIES.find((x) => !taken.has(x))!;
    color.set(id, f);
    taken.add(f);
  }
  const series: Series[] = shown.map(([id, ms]) => ({ key: id, name: displayName(byId.get(id)!.w), color: CHART_COLORS[color.get(id)!], ms, ids: [id] }));
  if (rest.length) series.push({ key: 'other', name: `Others (${rest.length})`, color: OTHER_COLOR, ms: rest.reduce((a, [, ms]) => a + ms, 0), ids: rest.map(([id]) => id) });
  return series;
}

/** A series' time on one day. */
export function seriesMs(day: Map<string, number>, s: Series): number {
  return s.ids.reduce((a, id) => a + (day.get(id) ?? 0), 0);
}

// ------------------------------------------------------------------ words

/** "6h 54m", "10m", "<1m". */
export function hm(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return ms > 0 ? '<1m' : '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return !h ? `${m}m` : m ? `${h}h ${m}m` : `${h}h`;
}

/** Whole percentages that add up to 100 (largest remainders get the leftover points). */
export function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/** "98%", or "<1%" for a sliver. */
export function shareText(share: number, ms: number): string {
  return share === 0 && ms > 0 ? '<1%' : `${share}%`;
}

/** "This week", "Last week", "Oct 4 – 10", "Sep 27 – Oct 3". */
export function weekLabel(start: number, now: number): string {
  const back = Math.round((weekStart(now) - start) / WEEK_MS);
  if (back === 0) return 'This week';
  if (back === 1) return 'Last week';
  const s = new Date(start);
  const e = new Date(midnights(start)[7] - 1);
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' });
  return s.getMonth() === e.getMonth() ? `${month(s)} ${s.getDate()} – ${e.getDate()}` : `${month(s)} ${s.getDate()} – ${month(e)} ${e.getDate()}`;
}

/** "Today", "Yesterday", or the weekday ("Monday"). */
export function dayName(dayStart: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayStart === today.getTime()) return 'Today';
  if (dayStart === yesterday.getTime()) return 'Yesterday';
  return new Date(dayStart).toLocaleDateString('en-US', { weekday: 'long' });
}
