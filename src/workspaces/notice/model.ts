// What Workspaces notices you work on: spans of time with one window in front, each with the
// project and workspace it belonged to. Kept on this PC (recent-work.json in Island's data
// folder) for a few days, then dropped. Unless "Keep window titles" is on, only what was worked
// out is kept (the program, the project's name, the file's name, the workspace), never the
// whole title. Pure: the activity (src/activities/notice.ts) samples, this decides what it means.

import { appName } from '../model';

export const TRAIL_VERSION = 1;
/** A gap longer than this between samples (asleep, away, Island closed) ends a span. */
export const GAP_MS = 30_000;
const MAX_SPANS = 20_000;

export interface Span {
  start: number;
  end: number;
  /** The program's full path. */
  app: string;
  project: string | null;
  /** The workspace it belonged to. */
  ws: string | null;
  file: string | null;
  /** The whole window title; '' unless titles are kept. */
  title: string;
}

export interface TrailDoc {
  version: number;
  spans: Span[];
  /** Suggestions answered "Not now", until when (ms). */
  quiet: Record<string, number>;
}

export interface Sample {
  at: number;
  app: string;
  project: string | null;
  ws: string | null;
  file: string | null;
  title: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

export function emptyTrail(): TrailDoc {
  return { version: TRAIL_VERSION, spans: [], quiet: {} };
}

/** The file as Rust hands it over, every field checked. */
export function readTrail(raw: unknown): TrailDoc {
  if (!isObj(raw)) return emptyTrail();
  const spans: Span[] = [];
  for (const s of Array.isArray(raw.spans) ? raw.spans.slice(-MAX_SPANS) : []) {
    if (!isObj(s) || typeof s.start !== 'number' || typeof s.end !== 'number' || !(s.end >= s.start)) continue;
    spans.push({ start: s.start, end: s.end, app: str(s.app, 1024), project: strOrNull(s.project, 120), ws: strOrNull(s.ws, 64), file: strOrNull(s.file, 200), title: str(s.title, 300) });
  }
  spans.sort((a, b) => a.start - b.start);
  const quiet: Record<string, number> = {};
  if (isObj(raw.quiet)) for (const [k, v] of Object.entries(raw.quiet)) if (typeof v === 'number') quiet[k.slice(0, 160)] = v;
  return { version: TRAIL_VERSION, spans, quiet };
}

const sameSpan = (s: Span, x: Sample) => s.app === x.app && s.project === x.project && s.ws === x.ws && s.file === x.file && s.title === x.title;

/**
 * Adds what was in front at `x.at`. The time since the last sample goes to the window that was
 * in front then (if the gap was short); a different window starts a new span.
 */
export function addSample(doc: TrailDoc, x: Sample): TrailDoc {
  const spans = doc.spans.slice();
  const last = spans[spans.length - 1];
  const joined = last && x.at - last.end <= GAP_MS && x.at >= last.end;
  if (joined) spans[spans.length - 1] = { ...last, end: x.at };
  if (!(joined && sameSpan(last, x))) spans.push({ start: x.at, end: x.at, app: x.app, project: x.project, ws: x.ws, file: x.file, title: x.title });
  return { ...doc, spans: spans.length > MAX_SPANS ? spans.slice(-MAX_SPANS) : spans };
}

/** Drops spans older than `days`, and quiet suggestions that are over. */
export function prune(doc: TrailDoc, now: number, days: number): TrailDoc {
  const since = now - days * 86_400_000;
  const quiet: Record<string, number> = {};
  for (const [k, until] of Object.entries(doc.quiet)) if (until > now) quiet[k] = until;
  return { ...doc, spans: doc.spans.filter((s) => s.end >= since), quiet };
}

/** The key of what a span was about: its workspace, or else its project; null for neither. */
export function contextKey(s: { ws: string | null; project: string | null }): string | null {
  if (s.ws) return `ws:${s.ws}`;
  if (s.project) return `project:${s.project.toLowerCase()}`;
  return null;
}

export interface Context {
  key: string;
  ws: string | null;
  project: string | null;
  /** Time spent on it (in the spans given). */
  ms: number;
  /** When it was last in front. */
  last: number;
  /** File names, most recent first. */
  files: string[];
  /** Programs used for it (full paths), most used first. */
  apps: string[];
}

/** Everything worked on since `since`, most recent first. */
export function contexts(spans: Span[], since = 0): Context[] {
  const map = new Map<string, Context & { appMs: Map<string, number> }>();
  for (const s of spans) {
    if (s.end < since) continue;
    const key = contextKey(s);
    if (!key) continue;
    const ms = Math.max(0, s.end - Math.max(s.start, since));
    let c = map.get(key);
    if (!c) map.set(key, (c = { key, ws: s.ws, project: s.project, ms: 0, last: 0, files: [], apps: [], appMs: new Map() }));
    c.ms += ms;
    c.last = Math.max(c.last, s.end);
    if (!c.project && s.project) c.project = s.project;
    if (s.file) {
      c.files = [s.file, ...c.files.filter((f) => f !== s.file)].slice(0, 8);
    }
    c.appMs.set(s.app, (c.appMs.get(s.app) ?? 0) + ms);
  }
  return [...map.values()]
    .map(({ appMs, ...c }) => ({ ...c, apps: [...appMs.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a) }))
    .sort((a, b) => b.last - a.last);
}

/** Midnight today, local time. */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * What the user has settled into: the context of the last spans in a row, once they've been in
 * front for `holdMs` and are still current. Null while moving between things.
 */
export function settled(spans: Span[], now: number, holdMs = 20_000): string | null {
  const last = spans[spans.length - 1];
  if (!last || now - last.end > GAP_MS) return null;
  const key = contextKey(last);
  if (!key) return null;
  let start = last.start;
  for (let i = spans.length - 2; i >= 0; i--) {
    const s = spans[i];
    if (contextKey(s) !== key || start - s.end > GAP_MS) break;
    start = s.start;
  }
  return last.end - start >= holdMs ? key : null;
}

/** "1 h 20 min", "25 min", "under a minute". */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** How a context reads: its workspace's name, or its project's. */
export function contextName(c: Pick<Context, 'project' | 'apps'>, wsName?: string): string {
  return wsName ?? c.project ?? (c.apps[0] ? appName(c.apps[0]) : 'Something');
}
