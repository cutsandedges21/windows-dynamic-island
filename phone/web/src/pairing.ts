// What the phone makes of a pairing code: the page's own address (the QR code opens
// `PHONE_SITE/#pair=…`), a pasted link, or a scanned one; and the plain words for when it fails.
// No DOM.

import { decodePair, type PairPayload } from '../../../src/remote/protocol';

/** Where the code is made on the PC. */
export const WHERE_PAIR = 'Settings › Your phone › Pair a phone';

export type PairRead = { ok: true; pair: PairPayload } | { ok: false; error: string };

/** A pasted or scanned pairing link (the whole URL, its `#pair=…` part, or the bare code). */
export function readPairInput(text: string): PairRead {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Paste the pairing link from your PC first.' };
  const pair = decodePair(t);
  if (pair) return { ok: true, pair };
  if (t.includes('pair=')) return { ok: false, error: `That pairing link is cut short or damaged. Copy it again on your PC: ${WHERE_PAIR}.` };
  return { ok: false, error: `That isn't a pairing link. Make one on your PC: ${WHERE_PAIR}.` };
}

/**
 * A pairing code in the page's own address. `found` says the address had one at all, so a
 * damaged one can be told apart from none.
 */
export function pairInLocation(loc: { hash: string; search: string }): { found: boolean; pair: PairPayload | null } {
  for (const part of [loc.hash, loc.search]) {
    if (!part.includes('pair=')) continue;
    return { found: true, pair: decodePair(part) };
  }
  return { found: false, pair: null };
}

export type DeniedWhy = 'code' | 'expired' | 'unknown' | 'version';

/** Why an island said no, in plain words. */
export function deniedText(why: DeniedWhy, pc: string): string {
  switch (why) {
    case 'expired':
      return `That code ran out. Make a new one on your PC: ${WHERE_PAIR}.`;
    case 'code':
      return `That code didn't work (it may have been used already). Make a new one on your PC: ${WHERE_PAIR}.`;
    case 'unknown':
      return `${pc} doesn't know this phone anymore. Pair it again: ${WHERE_PAIR}.`;
    case 'version':
      return `${pc} runs a different version of Island. Update Island on your PC, then reload this page.`;
  }
}

const DENIED: readonly string[] = ['code', 'expired', 'unknown', 'version'];

/** The words for a failed `link.pair()`: a `denied` answer, no answer, or anything else. */
export function pairErrorText(err: unknown, pc: string): string {
  const why = typeof err === 'object' && err !== null ? (err as { why?: unknown }).why : undefined;
  if (typeof why === 'string' && DENIED.includes(why)) return deniedText(why as DeniedWhy, pc);
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const named = /\b(expired|code|unknown|version)\b/.exec(msg.toLowerCase());
  if (/denied/i.test(msg) && named) return deniedText(named[1] as DeniedWhy, pc);
  if (/expired/i.test(msg)) return deniedText('expired', pc);
  if (/time ?out|timed out|no answer|20 ?s/i.test(msg) || why === 'timeout')
    return `${pc} didn't answer. Check that Island is running on it and the code is still showing, then try again.`;
  return msg ? `Couldn't pair with ${pc}: ${msg}` : `Couldn't pair with ${pc}. Try again.`;
}

/** What the PC lists this phone as until it is renamed there ("iPhone"). */
export function phoneName(ua: string, touchPoints = 0): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Phone';
}
