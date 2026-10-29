// Island on your phone: what the island and the phone website say to each other. Shared by both
// sides (the island imports it from here, the phone site from ../../src/remote), so neither can
// drift. Rust reads only the lines it handles itself (pair, hi, ping, push-sub, term-list,
// term-kill, file and terminal headers) and writes paired/denied/pong/bye/terms; everything else
// passes between this file's two users.
// Design: docs/superpowers/specs/2026-10-22-island-phone-design.md, and for terminals, Claude's
// chat and the screen: docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md.

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
/** A phone's action string is at most this long (Claude's New chat names its folder in it). */
export const MAX_ACTION = 1000;
/** Recent project folders a hello carries, at most (the terminal's folder picker). */
export const HELLO_FOLDERS = 6;
/** Chrome Remote Desktop: the phone opens it in Safari, and Settings opens it on the PC to set it up. */
export const SCREEN_SITE = 'https://remotedesktop.google.com/access';

/** Terminals on the PC, at most, phones' and Claude chats' together. */
export const MAX_TERMS = 8;

// A terminal stream, after `term-ok`, carries frames both ways:
// [kind: u8][len: u32 big-endian][payload: len bytes], one of these kinds.

/** Raw bytes, both ways: the terminal's output to the phone, the keyboard's input to the PC. */
export const TERM_DATA = 0;
/** Phone → PC: JSON `{cols, rows}`, each 1..=TERM_SIZE_MAX. */
export const TERM_RESIZE = 1;
/** PC → phone: JSON `{code}` (null when unknown); the PC finishes the stream after it. */
export const TERM_EXIT = 2;
/** PC → phone: JSON `{title}`. */
export const TERM_TITLE = 3;
/** One frame's payload, at most. */
export const TERM_FRAME_MAX = 65536;
/** The output a terminal keeps (its last 256 KiB), sent to a stream right after `term-ok`. */
export const TERM_REPLAY_MAX = 262144;
/** Columns and rows of a terminal, each at most. */
export const TERM_SIZE_MAX = 500;

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
  | { t: 'push-sub'; sub: PushSub | null }
  /** The terminals on the PC → `terms`. */
  | { t: 'term-list' }
  /** Ends that terminal (if it runs) and removes it → `terms`. */
  | { t: 'term-kill'; id: string };

/** Chrome Remote Desktop on the PC: its host running, installed but stopped, not installed; null where Island can't tell (a Mac). */
export type ScreenState = 'ready' | 'off' | 'missing' | null;

/** The shells a phone can start: PowerShell, Command Prompt, Git Bash (a Mac starts the user's own). */
export type TermShell = 'powershell' | 'cmd' | 'bash';

/** A terminal on the PC (`terms`, and Rust's `term_list`). */
export interface TermInfo {
  /** 8 random hex. */
  id: string;
  title: string;
  cwd: string;
  /** 'powershell' | 'cmd' | 'bash', or on a Mac its shell's name ('zsh'). */
  shell: string;
  /** Its child process: the shell, or the program it runs. */
  pid: number;
  /** When it started (ms). */
  started: number;
  /** Its exit code once it ended; null while it runs. An ended one stays listed for 10 minutes. */
  exit: number | null;
  /** Streams attached to it now. */
  attached: number;
  /** Island started it for a Claude chat. */
  claude: boolean;
}

/** A terminal stream's first line: attach to `id` (and resize it), or open a new one (id null) in `cwd` with `shell` (defaults when null). */
export interface TermHeader {
  t: 'term';
  id: string | null;
  cols: number;
  rows: number;
  cwd: string | null;
  shell: TermShell | null;
}

/** The PC's one-line answer on a terminal stream; after `term-error` it finishes the stream. */
export type TermReply = { t: 'term-ok'; id: string; title: string } | { t: 'term-error'; error: string };

/** What `hello` says about this island, beside the protocol version and the push key. */
export type HelloFacts = Omit<Extract<IslandMsg, { t: 'hello' }>, 't' | 'v' | 'vapid'>;

/** Island → phone lines. The first six come from TypeScript, the last five from Rust. */
export type IslandMsg =
  | {
      t: 'hello';
      v: number;
      name: string;
      platform: 'windows' | 'macos';
      version: string;
      allow: boolean;
      vapid: string | null;
      /** A phone may open terminals now (Settings › Your phone, and Windows Hello isn't asked before Allow). An older island: false. */
      term: boolean;
      /** Chrome Remote Desktop, for the Screen button. An older island: null. */
      screen: ScreenState;
      /** Recent project folders, newest first (at most HELLO_FOLDERS). An older island: none. */
      folders: string[];
    }
  | { t: 'pill'; frame: MirrorFrame; bot: BotState | null }
  | { t: 'view'; nav: Nav; view: SheetView | null; urgent: string | null }
  | { t: 'toast'; text: string; tone: 'good' | 'bad' | 'info' }
  | { t: 'clip'; text: string }
  /** Text or a link sent from the PC (Land's card, phase 2). */
  | { t: 'text'; text: string; from: string }
  | { t: 'paired'; name: string }
  | { t: 'denied'; why: 'code' | 'expired' | 'unknown' | 'version' }
  | { t: 'pong' }
  | { t: 'bye'; why: 'removed' }
  /** The terminals on the PC: the answer to `term-list` and `term-kill`, and sent whenever they change. `allowed`: this phone may open them. */
  | { t: 'terms'; items: TermInfo[]; allowed: boolean };

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
      return short(v.action, MAX_ACTION) && v.action ? ('arg' in v ? { t: 'act', action: v.action, arg: v.arg } : { t: 'act', action: v.action }) : null;
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
    case 'hello': {
      if (!(typeof v.v === 'number' && short(v.name, 200) && (v.platform === 'windows' || v.platform === 'macos') && short(v.version, 40) && typeof v.allow === 'boolean' && (v.vapid === null || short(v.vapid, 200)))) return null;
      // An older island says nothing of terminals, the screen or folders: none of them, then.
      const screen = v.screen === 'ready' || v.screen === 'off' || v.screen === 'missing' ? v.screen : null;
      const folders = Array.isArray(v.folders) ? v.folders.filter((f): f is string => short(f, 1000) && f.trim() !== '').slice(0, HELLO_FOLDERS) : [];
      return { t: 'hello', v: v.v, name: v.name, platform: v.platform, version: v.version, allow: v.allow, vapid: v.vapid, term: v.term === true, screen, folders };
    }
    case 'terms':
      return Array.isArray(v.items) && typeof v.allowed === 'boolean'
        ? { t: 'terms', items: v.items.slice(0, 64).map((x) => readTermInfo(x)).filter((x): x is TermInfo => x !== null), allowed: v.allowed }
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

// ------------------------------------------------------------------ terminals

const isTermId = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(v);
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= TERM_SIZE_MAX;

/** A terminal as Rust lists it, checked; null for anything else. */
export function readTermInfo(v: unknown): TermInfo | null {
  if (!isObj(v) || !isTermId(v.id) || !short(v.title, 400) || !short(v.cwd, 4096) || !short(v.shell, 64)) return null;
  const { pid, started, exit, attached } = v;
  if (!Number.isInteger(pid) || (pid as number) < 0 || typeof started !== 'number' || !Number.isFinite(started)) return null;
  if (exit !== null && exit !== undefined && !Number.isInteger(exit)) return null;
  return {
    id: v.id,
    title: v.title,
    cwd: v.cwd,
    shell: v.shell,
    pid: pid as number,
    started,
    exit: Number.isInteger(exit) ? (exit as number) : null,
    attached: Number.isInteger(attached) && (attached as number) > 0 ? (attached as number) : 0,
    claude: v.claude === true,
  };
}

/** A terminal stream's first line, checked; null for anything else. */
export function readTermHeader(v: unknown): TermHeader | null {
  if (!isObj(v) || v.t !== 'term' || !isSize(v.cols) || !isSize(v.rows)) return null;
  const id = v.id === null || v.id === undefined ? null : isTermId(v.id) ? v.id : undefined;
  const cwd = v.cwd === null || v.cwd === undefined ? null : short(v.cwd, 4096) ? v.cwd : undefined;
  const shell = v.shell === null || v.shell === undefined ? null : v.shell === 'powershell' || v.shell === 'cmd' || v.shell === 'bash' ? v.shell : undefined;
  if (id === undefined || cwd === undefined || shell === undefined) return null;
  return { t: 'term', id, cols: v.cols, rows: v.rows, cwd, shell };
}

/** The PC's answer on a terminal stream, checked; null for anything else. */
export function readTermReply(v: unknown): TermReply | null {
  if (!isObj(v)) return null;
  if (v.t === 'term-ok') return isTermId(v.id) && short(v.title, 400) ? { t: 'term-ok', id: v.id, title: v.title } : null;
  if (v.t === 'term-error') return short(v.error, 1000) ? { t: 'term-error', error: v.error } : null;
  return null;
}

// ------------------------------------------------------------------ what a phone may press

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
