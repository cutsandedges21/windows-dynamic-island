// "Sleep this PC at 99%" (Claude Code's option): once a limit window reaches the mark, the island
// counts down and then puts the PC to sleep, once per window, so waking it while the limit is
// still at 99% doesn't send it straight back. Pure: which window is due, and remembering the ones
// that already had their turn.

import type { UsageData } from './usage';

export const SLEEP_AT = 99;
export const SLEEP_COUNTDOWN_MS = 60_000;
const DONE_KEY = 'island.claude.sleptFor';

export interface SleepDue {
  /** The limit window ("session:<resets at>"): done once per window. */
  key: string;
  /** "5-hour limit" or "weekly limit". */
  label: string;
  pct: number;
}

/** The first limit window at `at`% or more that hasn't had its turn yet; null for none. */
export function sleepDue(d: UsageData | null | undefined, done: ReadonlySet<string>, at = SLEEP_AT): SleepDue | null {
  const windows = [
    ['session', d?.fiveHour, '5-hour limit'],
    ['week', d?.sevenDay, 'weekly limit'],
  ] as const;
  for (const [name, w, label] of windows) {
    if (!w || w.resetsAt == null || w.pct < at) continue;
    const key = `${name}:${w.resetsAt}`;
    if (!done.has(key)) return { key, label, pct: w.pct };
  }
  return null;
}

/** The windows that already had their turn (kept across restarts, the last few). */
export function sleptFor(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markSlept(key: string): void {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...sleptFor(), key].slice(-10)));
  } catch {
    /* no storage: at worst it asks again after a restart */
  }
}
