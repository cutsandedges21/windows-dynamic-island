// Stripe: a new payment (or a failed one, or a refund) and your balance at a glance. The poll
// (src-tauri/src/integrations.rs) reads the balance and the latest charges with a key from the
// Credential Manager; a restricted key with read access to both is enough.

import { agoText } from '../../core/format';
import { IntegrationActivity, type TileContent } from './base';
import { formatMoney, isRecent, MINUTE, type Change, type Glance } from './util';

export interface Payment {
  id: string;
  /** In the currency's smallest unit (cents). */
  amount: number;
  currency: string;
  description: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  status: string;
  refunded: boolean;
}

export interface StripeSnapshot {
  balance: number;
  available: number;
  pending: number;
  currency: string;
  livemode: boolean;
  /** Newest first. */
  payments: Payment[];
}

/** A payment that shows up already settled is news only when it happened lately. */
const RECENT_MS = 15 * MINUTE;

/** The dashboard page for one payment, or for all of them. */
export function dashboardUrl(livemode: boolean, paymentId?: string): string {
  return `https://dashboard.stripe.com${livemode ? '' : '/test'}/payments${paymentId ? `/${encodeURIComponent(paymentId)}` : ''}`;
}

/** Payments that succeeded, failed or were refunded since the last poll. */
export function compareStripe(prev: StripeSnapshot, next: StripeSnapshot, now: number): Change[] {
  const before = new Map(prev.payments.map((p) => [p.id, p]));
  const changes: Change[] = [];
  for (const p of next.payments) {
    const was = before.get(p.id);
    const url = dashboardUrl(next.livemode, p.id);
    const detail = p.description ?? undefined;
    const money = formatMoney(p.amount, p.currency);
    if (was && !was.refunded && p.refunded) changes.push({ key: `stripe:${p.id}:refunded`, tone: 'info', icon: 'bolt', title: `Refund ${money}`, detail, url, level: 'expanded' });
    if (was ? was.status === p.status : !isRecent(p.createdAt, now, RECENT_MS)) continue;
    if (p.status === 'succeeded') changes.push({ key: `stripe:${p.id}:paid`, tone: 'good', icon: 'bolt', title: `Payment ${formatMoney(p.amount, p.currency, true)}`, detail, url, level: 'expanded' });
    else if (p.status === 'failed') changes.push({ key: `stripe:${p.id}:failed`, tone: 'warn', icon: 'bolt', title: `Payment failed ${money}`, detail, url });
  }
  return changes;
}

export function stripeGlance(s: StripeSnapshot, now: number): Glance {
  const last = s.payments.find((p) => p.status === 'succeeded');
  const detail = last ? `Last ${formatMoney(last.amount, last.currency, true)} ${agoText(now - last.createdAt)}` : `Available ${formatMoney(s.available, s.currency)}`;
  return { icon: 'bolt', tone: 'info', title: formatMoney(s.balance, s.currency), detail: s.livemode ? detail : `Test mode · ${detail}`, url: dashboardUrl(s.livemode) };
}

export function stripeTile(s: StripeSnapshot, now: number): TileContent {
  const last = s.payments.find((p) => p.status === 'succeeded');
  const lastLine = last ? `${formatMoney(last.amount, last.currency, true)} · ${agoText(now - last.createdAt)}` : 'No payments yet';
  return {
    tone: 'info',
    action: 'open',
    arg: dashboardUrl(s.livemode),
    body: { k: 'stat', icon: 'bolt', label: s.livemode ? 'Stripe' : 'Stripe (test)', value: formatMoney(s.balance, s.currency), sub: lastLine },
  };
}

export class StripeActivity extends IntegrationActivity<StripeSnapshot> {
  constructor() {
    super('stripe', { secret: 'stripe.key', everyMs: 60_000, home: 'https://dashboard.stripe.com/payments' });
  }

  protected compare(prev: StripeSnapshot, next: StripeSnapshot, now: number): Change[] {
    return compareStripe(prev, next, now);
  }

  protected headline(s: StripeSnapshot, now: number): Glance {
    return stripeGlance(s, now);
  }

  protected tileFor(s: StripeSnapshot, now: number): TileContent {
    return stripeTile(s, now);
  }
}
