// What the PC sends a phone while Island isn't open there: Land's text, links and files wait
// here (files stay where they are on disk; only their path waits) and go the moment that phone
// connects. Meanwhile the phone gets a notification ("MossLaptop sent you a picture") whose tap
// opens its inbox. In memory only: a restart forgets what was waiting (the Land card says so).
// No DOM, no Tauri: the hub (src/remote/hub.ts) owns one.

import { INBOX_OPEN } from './protocol';

/** Items one phone keeps at most: an older one gives way to a newer. */
export const OUTBOX_MAX = 10;
/** How long an item waits for its phone. */
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
/** The longest text that waits (what the phone's clipboard view takes too). */
export const OUTBOX_TEXT_MAX = 100_000;
/** What a note's notification shows of it at most. */
export const PREVIEW_MAX = 60;

/** How a held item ended: it went to the phone, or it was dropped (too old, or pushed out). */
export type HeldEnd = 'sent' | 'dropped';

export type HeldItem =
  | { kind: 'text'; text: string; from: string; settle?: (end: HeldEnd) => void }
  | { kind: 'file'; path: string; name: string; size: number; mime?: string; settle?: (end: HeldEnd) => void };

interface Held {
  item: HeldItem;
  at: number;
}

export class PhoneOutbox {
  private readonly by = new Map<string, Held[]>();

  /** Keeps `item` for `phone`; false when it can't wait (text too long). The oldest gives way past OUTBOX_MAX. */
  add(phone: string, item: HeldItem, now: number): boolean {
    if (item.kind === 'text' && (!item.text || item.text.length > OUTBOX_TEXT_MAX)) return false;
    this.sweep(now);
    const list = this.by.get(phone) ?? [];
    list.push({ item, at: now });
    while (list.length > OUTBOX_MAX) list.shift()?.item.settle?.('dropped');
    this.by.set(phone, list);
    return true;
  }

  /** What still waits for `phone`, oldest first; it no longer waits here. */
  take(phone: string, now: number): HeldItem[] {
    this.sweep(now);
    const list = this.by.get(phone) ?? [];
    this.by.delete(phone);
    return list.map((h) => h.item);
  }

  /** How many items wait for `phone`. */
  count(phone: string, now: number): number {
    this.sweep(now);
    return this.by.get(phone)?.length ?? 0;
  }

  /** A phone unpaired: what waited for it is dropped. */
  forget(phone: string): void {
    for (const h of this.by.get(phone) ?? []) h.item.settle?.('dropped');
    this.by.delete(phone);
  }

  /** Drops what waited longer than OUTBOX_TTL_MS. */
  sweep(now: number): void {
    for (const [phone, list] of this.by) {
      const keep = list.filter((h) => now - h.at < OUTBOX_TTL_MS);
      for (const h of list) if (!keep.includes(h)) h.item.settle?.('dropped');
      if (keep.length) this.by.set(phone, keep);
      else this.by.delete(phone);
    }
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i;

/** What kind of thing it is, in the notification's words. */
export function heldWhat(item: HeldItem): 'a picture' | 'a file' | 'a link' | 'a note' {
  if (item.kind === 'file') return (item.mime ?? '').startsWith('image/') || IMAGE.test(item.name) ? 'a picture' : 'a file';
  return /^\s*https?:\/\/\S+\s*$/i.test(item.text) ? 'a link' : 'a note';
}

/**
 * The notification for a held item: "MossLaptop sent you a picture". A note shows its first
 * PREVIEW_MAX characters (Claude's notifications already carry text), a link only its site,
 * a file nothing of itself. A tap opens the phone's inbox; one tag, so several fold into one.
 */
export function heldPush(item: HeldItem, pc: string): { title: string; body: string; tag: string; open: string } {
  const what = heldWhat(item);
  let body = 'Tap to get it.';
  if (what === 'a picture') body = 'Tap to save it to Photos.';
  else if (what === 'a link' && item.kind === 'text') {
    try {
      body = new URL(item.text.trim()).host || body;
    } catch {
      /* the generic line */
    }
  } else if (item.kind === 'text') {
    const one = item.text.replace(/\s+/g, ' ').trim();
    body = one.length > PREVIEW_MAX ? `${one.slice(0, PREVIEW_MAX - 1)}…` : one;
  }
  return { title: `${pc || 'Your PC'} sent you ${what}`, body, tag: INBOX_OPEN, open: INBOX_OPEN };
}

/** Land's way to the hub (set while the hub runs): holds an item for a phone that isn't connected. */
type Holder = (phone: string, item: HeldItem) => boolean;
let holder: Holder | null = null;

export function setPhoneHolder(h: Holder | null): void {
  holder = h;
}

/** Holds `item` for `phone` (an unconnected paired phone) and notifies it; false when it can't wait. */
export function holdForPhone(phone: string, item: HeldItem): boolean {
  return holder ? holder(phone, item) : false;
}
