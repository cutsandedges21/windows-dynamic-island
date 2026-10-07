// Resend: an email that bounces, fails or is marked as spam, how many you sent in the last day,
// and your newest messages. The poll (src-tauri/src/integrations.rs) lists your latest emails
// with a full-access key from the Credential Manager.

import { agoText, clip } from '../../core/format';
import type { Tone } from '../../core/segments';
import { IntegrationActivity, type TileContent } from './base';
import { isRecent, MINUTE, parseTime, type Change, type Glance } from './util';

export interface Email {
  id: string;
  to: string[];
  subject: string;
  /** Resend's own format: "2026-10-01 10:00:00+00". */
  createdAt: string;
  lastEvent: string;
}

export interface ResendSnapshot {
  /** The newest five. */
  emails: Email[];
  /** How many of the last 100 came back. */
  count: number;
  /** More than 100 exist. */
  hasMore: boolean;
  /** When each of those came back was created. */
  createdAt: string[];
}

const DAY = 24 * 60 * MINUTE;
/** A bounce shows up within minutes; an email that appears already bounced is news only if it is recent. */
const RECENT_MS = 30 * MINUTE;

const PROBLEMS: Record<string, { title: string; tone: Tone }> = {
  bounced: { title: 'Email bounced', tone: 'bad' },
  failed: { title: 'Email failed', tone: 'bad' },
  complained: { title: 'Marked as spam', tone: 'bad' },
  delivery_delayed: { title: 'Delivery delayed', tone: 'warn' },
};

const recipient = (e: Email) => e.to[0] ?? 'someone';

/** Emails whose latest event is a problem that was not there at the last poll. */
export function compareResend(prev: ResendSnapshot, next: ResendSnapshot, now: number): Change[] {
  const before = new Map(prev.emails.map((e) => [e.id, e]));
  const changes: Change[] = [];
  for (const e of next.emails) {
    const problem = PROBLEMS[e.lastEvent];
    if (!problem) continue;
    const was = before.get(e.id);
    if (was ? was.lastEvent === e.lastEvent : !isRecent(e.createdAt, now, RECENT_MS)) continue;
    changes.push({
      key: `resend:${e.id}:${e.lastEvent}`,
      tone: problem.tone,
      icon: 'send',
      title: problem.title,
      detail: clip([recipient(e), e.subject].filter(Boolean).join(' · '), 70),
      url: `https://resend.com/emails/${encodeURIComponent(e.id)}`,
    });
  }
  return changes;
}

/** Emails sent in the last 24 hours, and whether that is only the part Resend returned. */
export function sentToday(s: ResendSnapshot, now: number): { n: number; capped: boolean } {
  const n = s.createdAt.filter((t) => {
    const at = parseTime(t);
    return at !== null && now - at <= DAY;
  }).length;
  return { n, capped: s.hasMore && n === s.createdAt.length };
}

export function resendGlance(s: ResendSnapshot): Glance | null {
  const e = s.emails[0];
  if (!e) return null;
  const problem = PROBLEMS[e.lastEvent];
  return { icon: 'send', tone: problem?.tone ?? 'good', title: `${recipient(e)}: ${problem ? problem.title.toLowerCase() : e.lastEvent.replace(/_/g, ' ') || 'sent'}`, detail: e.subject || undefined, url: `https://resend.com/emails/${encodeURIComponent(e.id)}` };
}

export function resendTile(s: ResendSnapshot, now: number): TileContent {
  const { n, capped } = sentToday(s, now);
  const latest = s.emails[0];
  const problem = latest ? PROBLEMS[latest.lastEvent] : undefined;
  const at = latest ? parseTime(latest.createdAt) : null;
  const sub = problem && latest ? `${problem.title} · ${recipient(latest)}` : at === null ? 'sent in the last day' : `Last sent ${agoText(now - at)}`;
  return { tone: problem ? problem.tone : 'good', action: 'open', arg: 'https://resend.com/emails', body: { k: 'stat', icon: 'send', label: 'Resend', value: `${n}${capped ? '+' : ''} today`, sub } };
}

export class ResendActivity extends IntegrationActivity<ResendSnapshot> {
  constructor() {
    super('resend', { secret: 'resend.key', everyMs: 60_000, home: 'https://resend.com/emails' });
  }

  protected compare(prev: ResendSnapshot, next: ResendSnapshot, now: number): Change[] {
    return compareResend(prev, next, now);
  }

  protected headline(s: ResendSnapshot): Glance | null {
    return resendGlance(s);
  }

  protected tileFor(s: ResendSnapshot, now: number): TileContent {
    return resendTile(s, now);
  }
}
