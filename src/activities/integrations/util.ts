// Pure helpers for the integration activities: what a change is, how long to wait after
// a failed poll, which of several changes to show, and small parsers and formatters.
// Nothing here touches the window or the network, so all of it is unit-tested.

import type { IconName } from '../../core/icons';
import type { Level } from '../../core/layout';
import type { Tone } from '../../core/segments';

export const MINUTE = 60_000;

/** One thing worth a glance, found by comparing two snapshots of a service. */
export interface Change {
  /** The same key is the same event, and surfaces once. */
  key: string;
  tone: Tone;
  icon: IconName;
  /** Short enough for the pill: "island: CI failed". */
  title: string;
  /** Where and what: "main · Fix the build". */
  detail?: string;
  /** The page that explains it. */
  url?: string;
  /** The button beside it; Open by default. */
  cta?: { icon: IconName; label: string };
  /** How loudly to surface. Failures default to expanded, everything else to compact. */
  level?: Level;
}

/** What the pill shows when the user keeps the activity on the island and nothing new happened. */
export type Glance = Pick<Change, 'icon' | 'tone' | 'title' | 'detail' | 'url' | 'cta'>;

/** A failed poll, as `integration_poll` reports it. */
export interface Failure {
  code: string;
  error: string;
  retryAfter?: number | null;
}

// ------------------------------------------------------------------ pacing

/**
 * How long until the next poll. After a plain failure the wait doubles up to 15 minutes; a
 * missing key or a bad setting waits for the user to fix it (saving a key polls at once anyway),
 * a refused key rests longer, and a rate limit obeys the service's own Retry-After.
 */
export function retryDelay(baseMs: number, failure: Failure | null, failures: number): number {
  if (!failure) return baseMs;
  switch (failure.code) {
    case 'no-key':
      return 30_000;
    case 'config':
      return MINUTE;
    case 'auth':
      return 10 * MINUTE;
    case 'limit':
      return Math.min(15 * MINUTE, Math.max((failure.retryAfter ?? 0) * 1000, baseMs * 4));
    default:
      return Math.min(15 * MINUTE, baseMs * 2 ** Math.max(1, failures));
  }
}

// ------------------------------------------------------------------ choosing what to show

const SEVERITY: Partial<Record<Tone, number>> = { bad: 3, warn: 2, good: 1 };

/** The most severe change (the first among equals) and how many others came with it. */
export function pickChange(changes: Change[]): { top: Change; more: number } | null {
  let top: Change | null = null;
  for (const c of changes) if (!top || (SEVERITY[c.tone] ?? 0) > (SEVERITY[top.tone] ?? 0)) top = c;
  return top ? { top, more: changes.length - 1 } : null;
}

/** How long a change stays on the island: failures longer than good news. */
export function noticeMs(change: Change): number {
  return change.tone === 'bad' ? 12_000 : change.tone === 'warn' ? 9_000 : 5_000;
}

// ------------------------------------------------------------------ time

/**
 * Epoch milliseconds from a service's timestamp: ISO, epoch ms, or Resend's Postgres style
 * ("2026-10-01 10:00:00+00"). Null when it is not a time.
 */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const iso = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
    .replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, '$1:00');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `time` is within `windowMs` before `now`: an item that shows up already finished is news only if it is recent. */
export function isRecent(time: unknown, now: number, windowMs: number): boolean {
  const ms = parseTime(time);
  return ms !== null && now - ms >= -MINUTE && now - ms <= windowMs;
}

// ------------------------------------------------------------------ links

const HTTPS = /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;
const LOCAL_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * A link the island will open: https anywhere, http only for localhost, and http on the user's
 * own self-hosted address (`origin`, such as their n8n instance). Anything else is null.
 */
export function safeUrl(url: unknown, origin?: string): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (HTTPS.test(u) || LOCAL_HTTP.test(u)) return u;
  if (origin && /^https?:\/\//i.test(origin) && u.startsWith(origin) && (u.length === origin.length || '/?#'.includes(u[origin.length]))) return u;
  return null;
}

// ------------------------------------------------------------------ numbers and names

/** Stripe amounts are in the currency's smallest unit, and how many decimals that is depends on the currency. */
export function formatMoney(minor: number, currency: string, signed = false): string {
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, signDisplay: signed ? 'exceptZero' : 'auto' });
    return money.format(minor / 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

/** 1234 becomes 1.2k. */
export function compactCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
}

/** "owner/name" becomes "name". */
export function repoName(full: string): string {
  return full.split('/').pop() || full;
}

/**
 * The repositories box: "owner/name" or a github.com link, separated by commas or spaces.
 * At most five, no repeats, nothing that is not a repository name (the poller asks GitHub
 * for each, so a stray "../" must never get through).
 */
export function parseRepoList(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(piece);
    if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) continue;
    const full = `${m[1]}/${m[2]}`;
    if (!out.some((r) => r.toLowerCase() === full.toLowerCase())) out.push(full);
    if (out.length === 5) break;
  }
  return out;
}

/** n8n puts the failing node on one line and its message on the next; the pill has one line. */
export function oneLine(text: string | null | undefined): string {
  return (text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).join(': ');
}
