// Island on your phone: what the island and the phone website say to each other. Shared by both
// sides (the island imports it from here, the phone site from ../../src/remote), so neither can
// drift. Rust reads only the lines it handles itself (pair, hi, ping, push-sub, file headers) and
// writes paired/denied/pong/bye; everything else passes between this file's two users.
// Design: docs/superpowers/specs/2026-10-22-island-phone-design.md.

import type { PetLook } from '../core/looks';
import type { MirrorFrame } from '../core/mirror';
import type { SheetView } from '../core/sheet';

/** Where the phone website lives; the pairing QR code points here. */
export const PHONE_SITE = 'https://islandphone.vercel.app';
/** The iroh protocol (ALPN) of a phone's connection to the island. */
export const ALPN_PHONE = 'island-phone/1';
/** The protocol version this build speaks. */
export const PROTOCOL_V = 1;
/** One control message, its newline included, is at most this many bytes. */
export const MAX_LINE = 1024 * 1024;
/** Views sent to one phone, at most this many a second. */
export const MAX_VIEWS_PER_S = 8;
/** The phone's keepalive while its page shows. */
export const PING_MS = 15_000;
/** A phone page hidden this long drops its connection (it reconnects when shown). */
export const HIDDEN_CLOSE_MS = 30_000;
/** A pairing code works this long. */
export const PAIR_MS = 10 * 60_000;
/** Largest file a phone sends to the PC (saved to Downloads). */
export const MAX_UPLOAD = 2 * 1024 ** 3;
/** Largest file the PC sends to a phone (held in the phone's memory). */
export const MAX_DOWNLOAD = 200 * 1024 ** 2;
/** The only island-wide actions a phone may press (Quiet). Activity actions are `act:<id>:<name>`. */
export const PHONE_ISLAND_ACTIONS: readonly string[] = ['island:dnd'];

/** What the pairing QR code carries (base64url JSON after `#pair=`). */
export interface PairPayload {
  v: 1;
  /** The island's iroh EndpointId, in its Display form. */
  id: string;
  /** Relay URLs to dial it through, its home relay first, never with a trailing dot. */
  relays: string[];
  /** The one-time code: 32 hex characters. */
  code: string;
  /** The computer's name ("MossLaptop"). */
  name: string;
}

/** What a phone shows under its pill. */
export type Nav = { open: 'grid' } | { open: 'none' } | { open: 'card'; id: string };

/** The bot beside the pill, as `BubbleView.show(look, play, strength)` takes it. */
export interface BotState {
  look: PetLook;
  play: number;
  strength: number;
}

/** A Web Push subscription, as `PushSubscription.toJSON()` gives it (phase 3). */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Phone → island lines the island's TypeScript handles (Rust passes them on as `remote-msg`). */
export type PhoneMsg =
  | { t: 'nav'; open: 'grid' | 'none'; width?: number }
  | { t: 'nav'; open: 'card'; id: string; width?: number }
  | { t: 'act'; action: string; arg?: unknown }
  | { t: 'text'; text: string }
  | { t: 'clip-get' }
  | { t: 'lock' };

/** Phone → island lines Rust handles itself (never passed on). */
export type PhoneControl =
  | { t: 'pair'; v: number; code: string; name: string }
  | { t: 'hi'; v: number }
  | { t: 'ping' }
  | { t: 'push-sub'; sub: PushSub | null };

/** Island → phone lines. The first six come from TypeScript, the last four from Rust. */
export type IslandMsg =
  | { t: 'hello'; v: number; name: string; platform: 'windows' | 'macos'; version: string; allow: boolean; vapid: string | null }
  | { t: 'pill'; frame: MirrorFrame; bot: BotState | null }
  | { t: 'view'; nav: Nav; view: SheetView | null; urgent: string | null }
  | { t: 'toast'; text: string; tone: 'good' | 'bad' | 'info' }
  | { t: 'clip'; text: string }
  /** Text or a link sent from the PC (Land's card, phase 2). */
  | { t: 'text'; text: string; from: string }
  | { t: 'paired'; name: string }
  | { t: 'denied'; why: 'code' | 'expired' | 'unknown' | 'version' }
  | { t: 'pong' }
  | { t: 'bye'; why: 'removed' };

/** First line of a file stream (either way), then exactly `size` bytes. */
export interface FileHeader {
  t: 'file';
  id: string;
  name: string;
  size: number;
  mime: string;
}

/** The receiving side's one-line answer on a file stream. */
export type FileReply = { t: 'file-ok'; id: string; name: string } | { t: 'file-error'; id: string; error: string };

// ------------------------------------------------------------------ pairing payload

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The payload as it goes after `#pair=`: base64url (no padding) of its UTF-8 JSON. Rust writes the same. */
export function encodePair(p: PairPayload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(p)));
}

/** The URL the pairing QR code shows. */
export function pairUrl(p: PairPayload, site = PHONE_SITE): string {
  return `${site.replace(/\/+$/, '')}/#pair=${encodePair(p)}`;
}

/**
 * A pairing payload from whatever the phone got: the whole URL, its `#pair=…` part, or the bare
 * payload. Null for anything that isn't a well-formed version 1 payload.
 */
export function decodePair(text: string): PairPayload | null {
  const raw = text.trim();
  const at = raw.indexOf('pair=');
  const payload = at >= 0 ? raw.slice(at + 5).split(/[&\s]/)[0] : raw;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 1) return null;
  const { id, relays, code, name } = v;
  if (typeof id !== 'string' || !/^[0-9A-Za-z]{20,128}$/.test(id)) return null;
  if (!Array.isArray(relays) || relays.length > 8) return null;
  const clean = relays.map(relayUrl).filter((r): r is string => r !== null);
  if (!clean.length || clean.length !== relays.length) return null;
  if (typeof code !== 'string' || !/^[0-9a-f]{32}$/.test(code)) return null;
  if (typeof name !== 'string' || name.length > 80) return null;
  return { v: 1, id, relays: clean, code, name };
}

/**
 * A relay URL a browser can dial: https only, and without the trailing dot n0's relay names
 * carry ("…iroh.link."), which makes a browser's WebSocket hang (iroh issue 4550).
 */
export function relayUrl(r: unknown): string | null {
  if (typeof r !== 'string' || r.length > 300) return null;
  try {
    const u = new URL(r);
    if (u.protocol !== 'https:') return null;
    u.hostname = u.hostname.replace(/\.$/, '');
    return u.toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ reading lines

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** A phone's line for the island's TypeScript, checked; null for anything else. */
export function readPhoneMsg(v: unknown): PhoneMsg | null {
  if (!isObj(v)) return null;
  const width = typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= 200 && v.width <= 2000 ? Math.round(v.width) : undefined;
  switch (v.t) {
    case 'nav':
      if (v.open === 'grid' || v.open === 'none') return width === undefined ? { t: 'nav', open: v.open } : { t: 'nav', open: v.open, width };
      if (v.open === 'card' && short(v.id, 64) && v.id) return width === undefined ? { t: 'nav', open: 'card', id: v.id } : { t: 'nav', open: 'card', id: v.id, width };
      return null;
    case 'act':
      return short(v.action, 200) && v.action ? ('arg' in v ? { t: 'act', action: v.action, arg: v.arg } : { t: 'act', action: v.action }) : null;
    case 'text':
      return short(v.text, 20_000) && v.text.trim() ? { t: 'text', text: v.text } : null;
    case 'clip-get':
    case 'lock':
      return { t: v.t };
    default:
      return null;
  }
}

/** An island's line for the phone, checked enough to draw it; null for anything else. */
export function readIslandMsg(v: unknown): IslandMsg | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'hello':
      return typeof v.v === 'number' && short(v.name, 200) && (v.platform === 'windows' || v.platform === 'macos') && short(v.version, 40) && typeof v.allow === 'boolean' && (v.vapid === null || short(v.vapid, 200))
        ? (v as unknown as IslandMsg)
        : null;
    case 'pill':
      return isObj(v.frame) && Array.isArray(v.frame.placed) && (v.bot === null || isObj(v.bot)) ? (v as unknown as IslandMsg) : null;
    case 'view':
      return isObj(v.nav) && (v.view === null || (isObj(v.view) && Array.isArray(v.view.blocks))) && (v.urgent === null || typeof v.urgent === 'string') ? (v as unknown as IslandMsg) : null;
    case 'toast':
      return short(v.text, 500) && (v.tone === 'good' || v.tone === 'bad' || v.tone === 'info') ? { t: 'toast', text: v.text, tone: v.tone } : null;
    case 'clip':
      return typeof v.text === 'string' ? { t: 'clip', text: v.text } : null;
    case 'text':
      return typeof v.text === 'string' && v.text && short(v.from, 200) ? { t: 'text', text: v.text, from: v.from } : null;
    case 'paired':
      return short(v.name, 200) ? { t: 'paired', name: v.name } : null;
    case 'denied':
      return v.why === 'code' || v.why === 'expired' || v.why === 'unknown' || v.why === 'version' ? { t: 'denied', why: v.why } : null;
    case 'pong':
      return { t: 'pong' };
    case 'bye':
      return { t: 'bye', why: 'removed' };
    default:
      return null;
  }
}

/** Fields that hold one action string: buttons, rows, tiles, inputs (and what engages or cancels them). */
const ACTION_KEYS = new Set(['action', 'engage', 'cancel']);

/**
 * Every action string a view or pill offers to be pressed (the phone's allowlist is built from
 * these): `action`, `engage` and `cancel` fields anywhere, and every value of a player's `actions`.
 */
export function actionsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const x of value) actionsIn(x, out);
  } else if (isObj(value)) {
    for (const [k, x] of Object.entries(value)) {
      if (ACTION_KEYS.has(k) && typeof x === 'string' && x) out.add(x);
      else if (k === 'actions' && isObj(x)) for (const a of Object.values(x)) typeof a === 'string' && a && out.add(a);
      else if (typeof x === 'object' && x !== null) actionsIn(x, out);
    }
  }
  return out;
}
