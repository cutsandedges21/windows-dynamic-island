// Synced lyrics for the music player: the line being sung, from LRCLIB (lrclib.net, free,
// no key). Island sends it the song's name, artist, album and length; nothing else.

import { native, type MediaState } from '../core/native';

export interface LrcLine {
  at: number;
  text: string;
}

const STAMP = /^\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/;

/** LRC text to lines sorted by time; several stamps on a line give it several times, tags like [ar:..] are skipped. */
export function parseLrc(text: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let rest = raw.trim();
    const at: number[] = [];
    let m: RegExpMatchArray | null;
    while ((m = rest.match(STAMP))) {
      at.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    for (const t of at) out.push({ at: t, text: rest.trim() });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The line being sung at `secs`: null before the first line and in a gap (an empty line). */
export function lineAt(lines: LrcLine[], secs: number): string | null {
  let hit: LrcLine | null = null;
  for (const l of lines) {
    if (l.at > secs) break;
    hit = l;
  }
  return hit?.text || null;
}

const CAP = 50;
/**
 * After LRCLIB couldn't answer (busy, rate limit, no connection): the next try waits this long,
 * longer each time, at most a minute. LRCLIB has busy spells ("503: The server is busy, please
 * retry in a moment"); waiting 3 minutes, as at first, lost each song's lyrics to one busy answer.
 */
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];

export function trackKey(m: MediaState): string {
  return `${m.artist}|${m.title}|${Math.round(m.duration ?? 0)}`;
}

/** Fetches once per track and keeps what it found (or that there's none) for the session. */
export class LyricsLoader {
  private cache = new Map<string, LrcLine[] | null>();
  /** When a track's last try failed, and how many tries in a row have. */
  private failed = new Map<string, { at: number; tries: number }>();
  private busy = new Set<string>();
  private current: string | null = null;

  constructor(private changed: () => void = () => {}) {}

  /** The synced lines of what's playing; null while there are none (or not yet). */
  lines(m: MediaState | null, on: boolean, now = Date.now()): LrcLine[] | null {
    if (!on || !m?.title || (m.status !== 'playing' && m.status !== 'paused')) {
      this.current = null;
      return null;
    }
    const key = trackKey(m);
    this.current = key;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const f = this.failed.get(key);
    if (!this.busy.has(key) && (!f || now - f.at >= RETRY_MS[Math.min(f.tries, RETRY_MS.length) - 1])) void this.load(m, key, now);
    return null;
  }

  private async load(m: MediaState, key: string, now: number): Promise<void> {
    this.busy.add(key);
    let got: LrcLine[] | null | undefined;
    try {
      got = await fetchLyrics(m);
    } catch {
      got = undefined;
    }
    this.busy.delete(key);
    if (key !== this.current) return;
    if (got === undefined) {
      this.failed.set(key, { at: now, tries: (this.failed.get(key)?.tries ?? 0) + 1 });
      return;
    }
    this.failed.delete(key);
    this.cache.set(key, got && got.length ? got : null);
    if (this.cache.size > CAP) this.cache.delete(this.cache.keys().next().value!);
    this.changed();
  }
}

interface Found {
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
}

function json<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** LRCLIB couldn't answer: one line in island.log, then the loader tries again soon. */
function unanswered(r: { status: number } | null): undefined {
  void native.log?.(`lyrics: LRCLIB ${r ? `answered ${r.status}` : "couldn't be reached"}; trying again soon`);
  return undefined;
}

/** The lines, null when LRCLIB has none, undefined when it couldn't be asked (try again later). */
async function fetchLyrics(m: MediaState): Promise<LrcLine[] | null | undefined> {
  const dur = Math.round(m.duration ?? 0);
  const q = new URLSearchParams({ artist_name: m.artist, track_name: m.title });
  if (m.album) q.set('album_name', m.album);
  if (dur > 0) q.set('duration', String(dur));
  const one = await native.httpGet(`https://lrclib.net/api/get?${q}`, 512 * 1024);
  if (!one || one.status === 429 || one.status >= 500) return unanswered(one);
  if (one.status === 200) {
    const f = json<Found>(one.body);
    if (f?.syncedLyrics) return parseLrc(f.syncedLyrics);
    if (f?.instrumental) return null;
  }
  const s = new URLSearchParams({ track_name: m.title, artist_name: m.artist });
  const many = await native.httpGet(`https://lrclib.net/api/search?${s}`, 2 * 1024 * 1024);
  if (!many || many.status === 429 || many.status >= 500) return unanswered(many);
  if (many.status !== 200) return null;
  const list = json<Found[]>(many.body);
  const hit = Array.isArray(list) ? list.find((f) => f?.syncedLyrics && (!dur || Math.abs((f.duration ?? 0) - dur) <= 3)) : null;
  return hit?.syncedLyrics ? parseLrc(hit.syncedLyrics) : null;
}
