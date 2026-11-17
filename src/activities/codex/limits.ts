// Codex's plan limits, from the `rate_limits` Codex writes into its session files with every
// token count: { primary, secondary } windows of { used_percent, window_minutes, resets_at (s) }.
// ChatGPT plans have a 5-hour and a weekly window; an API key or a local model has none (null).

import type { LimitWindow, UsageData } from '../claude/usage';

const FIVE_HOURS = 300;
const WEEK = 7 * 24 * 60;

interface RawWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

function windowOf(raw: unknown): (LimitWindow & { minutes: number | null }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as RawWindow;
  const pct = Number(w.used_percent);
  if (!Number.isFinite(pct)) return null;
  const minutes = Number.isFinite(Number(w.window_minutes)) ? Number(w.window_minutes) : null;
  const resets = Number(w.resets_at);
  return { pct: Math.max(0, Math.min(100, pct)), resetsAt: Number.isFinite(resets) && resets > 0 ? resets * 1000 : null, minutes };
}

/** The 5-hour and weekly windows, matched by their length (else the shorter is the session's). */
export function codexLimits(raw: unknown): UsageData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { primary?: unknown; secondary?: unknown };
  const found = [windowOf(r.primary), windowOf(r.secondary)].filter((w): w is NonNullable<typeof w> => w !== null);
  if (!found.length) return null;
  const strip = (w: (typeof found)[number] | undefined): LimitWindow | null => (w ? { pct: w.pct, resetsAt: w.resetsAt } : null);
  let fiveHour = found.find((w) => w.minutes === FIVE_HOURS);
  let sevenDay = found.find((w) => w.minutes === WEEK);
  if (!fiveHour && !sevenDay) {
    const byLength = [...found].sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    fiveHour = byLength[0];
    sevenDay = byLength[1];
  }
  return { fiveHour: strip(fiveHour), sevenDay: strip(sevenDay), models: [] };
}
