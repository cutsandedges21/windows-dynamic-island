/// <reference types="vite/client" />
// The phone's link to an island (the contract is api.ts). One iroh endpoint per page, from
// phone/wasm built into ./pkg by `node scripts/phone.mjs wasm`, loaded once on first use. It
// dials the island on island-phone/1 and says `pair` or `hi` first, keeps the connection while
// the page shows (ping every PING_MS; reconnect after 1 s, 2 s, 4 s … 30 s), drops it
// HIDDEN_CLOSE_MS after the page is hidden and dials again when it shows. Files go on streams
// of their own: read from the File piece by piece going up, kept whole in memory coming down.

import { HIDDEN_CLOSE_MS, MAX_DOWNLOAD, MAX_UPLOAD, PING_MS, PROTOCOL_V, readIslandMsg, relayUrl, type FileHeader, type FileReply, type IslandMsg, type PairPayload, type PhoneMsg, type PushSub } from '../../../../src/remote/protocol';
import type { CreateLink, IncomingFile, Link, LinkState, SavedIsland } from './api';

// ------------------------------------------------------------------ phone/wasm (src/lib.rs)

interface WasmFileOut {
  write(chunk: Uint8Array): Promise<void>;
  /** Resolves with the PC's one-line answer. */
  finish(): Promise<string>;
  abort(): void;
  free(): void;
}
interface WasmFileIn {
  /** The next piece; undefined once all of it is in. */
  read(): Promise<Uint8Array<ArrayBuffer> | undefined>;
  reply(line: string): Promise<void>;
  free(): void;
}
interface WasmSession {
  send(line: string): boolean;
  onLine(cb: (line: string) => void): void;
  onClosed(cb: (why: string) => void): void;
  onFile(cb: (header: string, file: WasmFileIn) => void): void;
  openFile(header: string): Promise<WasmFileOut>;
  close(why: string): void;
  paths(): string;
  free(): void;
}
interface WasmPhone {
  id(): string;
  connect(island: string, relays: string[], timeoutMs: number): Promise<WasmSession>;
  close(): Promise<void>;
  free(): void;
}
interface WasmModule {
  default(): Promise<unknown>;
  phoneId(secret: Uint8Array): string;
  Phone: { bind(secret: Uint8Array): Promise<WasmPhone> };
}

// A glob, not an import: a checkout that hasn't built the wasm yet still typechecks and bundles.
const builds = import.meta.glob<WasmModule>('./pkg/island_phone.js');
let loading: Promise<WasmModule> | null = null;

function loadWasm(): Promise<WasmModule> {
  loading ??= (async () => {
    const load = builds['./pkg/island_phone.js'];
    if (!load) throw new Error('The phone link is not built: run `node scripts/phone.mjs wasm`.');
    const mod = await load();
    await mod.default();
    return mod;
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

// ------------------------------------------------------------------ helpers

/** Where the phone's secret key lives (32 bytes, base64). */
const KEY_STORE = 'island-phone:key';
/** One dial (the wasm tries once more through n0's address lookup if it fails). */
const CONNECT_MS = 15_000;
/** pair() gives up with no `paired` or `denied` in this long. */
const PAIR_WAIT_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** No line at all (a pong included) this long after a ping: the connection is dead. A PC that
 * vanishes without closing (asleep, killed) is otherwise only noticed by QUIC's 30 s idle timeout. */
const PONG_WAIT_MS = 10_000;
/** Upload pieces. */
const CHUNK = 256 * 1024;

function phoneKey(): Uint8Array {
  try {
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) {
      const bytes = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
      if (bytes.length === 32) return bytes;
    }
  } catch {
    // No storage (or a broken value): a new key, kept if it can be.
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  try {
    localStorage.setItem(KEY_STORE, btoa(String.fromCharCode(...fresh)));
  } catch {
    // Kept for this page only.
  }
  return fresh;
}

/** pair()'s rejections carry why the island said no, or 'timeout' when it never answered. */
type PairWhy = 'code' | 'expired' | 'unknown' | 'version' | 'timeout';
const pairError = (message: string, why: PairWhy): Error & { why: PairWhy } => Object.assign(new Error(message), { why });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const cleanRelays = (relays: string[]): string[] => relays.map(relayUrl).filter((r): r is string => r !== null);

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readHeader(v: unknown): FileHeader | null {
  if (typeof v !== 'object' || v === null) return null;
  const h = v as Record<string, unknown>;
  const ok =
    h.t === 'file' &&
    typeof h.id === 'string' && h.id.length <= 100 &&
    typeof h.name === 'string' && h.name.length > 0 && h.name.length <= 255 &&
    typeof h.size === 'number' && Number.isInteger(h.size) && h.size >= 0 && h.size <= MAX_DOWNLOAD;
  if (!ok) return null;
  const mime = typeof h.mime === 'string' && h.mime.length <= 200 && h.mime ? h.mime : 'application/octet-stream';
  return { t: 'file', id: h.id as string, name: h.name as string, size: h.size as number, mime };
}

function readReply(line: string, id: string): FileReply {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Not JSON: no answer.
  }
  if (v.t === 'file-ok' && typeof v.name === 'string') return { t: 'file-ok', id, name: v.name };
  if (v.t === 'file-error') return { t: 'file-error', id, error: typeof v.error === 'string' ? v.error : 'The PC refused the file.' };
  throw new Error("The PC didn't answer for the file.");
}

const DENIED: Record<'code' | 'expired' | 'unknown' | 'version', string> = {
  code: 'That pairing code is wrong.',
  expired: 'That pairing code has expired. Make a new one on the PC.',
  unknown: 'This phone is not paired with that PC anymore.',
  version: 'Island on the PC and this page speak different versions.',
};

// ------------------------------------------------------------------ the link

interface Target {
  island: SavedIsland;
  /** Set while pairing: the first line is `pair` instead of `hi`. */
  pairing: { code: string; name: string } | null;
}

class PhoneLink implements Link {
  readonly phoneId: string;
  state: LinkState = { s: 'idle' };
  private phone: Promise<WasmPhone> | null = null;
  private target: Target | null = null;
  private session: WasmSession | null = null;
  /** Bumped whenever the plan changes (open, pair, close, hidden, denied): late callbacks of an older plan do nothing. */
  private gen = 0;
  private attempt = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private hiddenTimer = 0;
  private lastHeard = 0;
  private pairing: { resolve: (s: SavedIsland) => void; reject: (e: Error) => void; timer: number } | null = null;
  private readonly states = new Set<(s: LinkState) => void>();
  private readonly messages = new Set<(m: IslandMsg) => void>();
  private readonly files = new Set<(f: IncomingFile) => void>();

  constructor(
    private readonly wasm: WasmModule,
    private readonly key: Uint8Array,
  ) {
    this.phoneId = wasm.phoneId(key);
    document.addEventListener('visibilitychange', () => this.visibility());
    window.addEventListener('pagehide', () => this.hide());
    window.addEventListener('pageshow', () => this.visibility());
  }

  pair(pair: PairPayload, phoneName: string): Promise<SavedIsland> {
    this.stop(new Error('Pairing started again.'));
    const island: SavedIsland = { id: pair.id, name: pair.name, relays: cleanRelays(pair.relays), pairedAt: Date.now(), lastSeen: null };
    return new Promise<SavedIsland>((resolve, reject) => {
      const gen = this.begin({ island, pairing: { code: pair.code, name: phoneName.trim().slice(0, 80) || 'Phone' } });
      const timer = window.setTimeout(() => {
        if (gen !== this.gen) return;
        this.stop(pairError(`${pair.name} didn't answer. Is Island open on it?`, 'timeout'));
        this.setState({ s: 'idle' });
      }, PAIR_WAIT_MS);
      this.pairing = { resolve, reject, timer };
      this.kick(gen);
    });
  }

  open(island: SavedIsland): void {
    this.stop(new Error('Another island was opened.'));
    this.kick(this.begin({ island: { ...island, relays: cleanRelays(island.relays) }, pairing: null }));
  }

  close(): void {
    this.stop(new Error('The link was closed.'));
    this.target = null;
    this.setState({ s: 'idle' });
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.states.add(cb);
    return () => this.states.delete(cb);
  }

  onMessage(cb: (m: IslandMsg) => void): () => void {
    this.messages.add(cb);
    return () => this.messages.delete(cb);
  }

  onFile(cb: (f: IncomingFile) => void): () => void {
    this.files.add(cb);
    return () => this.files.delete(cb);
  }

  send(m: PhoneMsg | { t: 'push-sub'; sub: PushSub | null }): boolean {
    const s = this.session;
    // The wasm refuses lines over MAX_LINE (bytes, newline included).
    return this.state.s === 'online' && s !== null && s.send(JSON.stringify(m));
  }

  async sendFile(file: File, onProgress?: (p: number) => void): Promise<{ name: string }> {
    const s = this.session;
    if (this.state.s !== 'online' || !s) throw new Error('Not connected to the PC.');
    if (file.size > MAX_UPLOAD) throw new Error('That file is over 2 GB.');
    const header: FileHeader = { t: 'file', id: randomId(), name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' };
    const out = await s.openFile(JSON.stringify(header));
    try {
      for (let at = 0; at < file.size; ) {
        const piece = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
        if (!piece.length) throw new Error('The file could not be read.');
        await out.write(piece);
        at += piece.length;
        onProgress?.(at / file.size);
      }
      const reply = readReply(await out.finish(), header.id);
      if (reply.t === 'file-error') throw new Error(reply.error);
      onProgress?.(1);
      return { name: reply.name };
    } catch (e) {
      out.abort();
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      queueMicrotask(() => out.free());
    }
  }

  // ---------------------------------------------------------------- connecting

  private begin(target: Target): number {
    this.target = target;
    this.attempt = 0;
    return ++this.gen;
  }

  /** Ends the current plan: timers, the connection, a pairing still waiting. */
  private stop(why: Error): void {
    this.gen++;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.hiddenTimer);
    window.clearInterval(this.pingTimer);
    this.dropSession(why.message);
    const p = this.pairing;
    this.pairing = null;
    if (p) {
      window.clearTimeout(p.timer);
      p.reject(why);
    }
  }

  private dropSession(why: string): void {
    const s = this.session;
    this.session = null;
    window.clearInterval(this.pingTimer);
    if (!s) return;
    try {
      s.close(why);
    } catch {
      // Already gone.
    }
    // Not from inside one of its own callbacks.
    queueMicrotask(() => s.free());
  }

  private kick(gen: number): void {
    if (gen !== this.gen || !this.target || this.session) return;
    if (document.visibilityState === 'hidden') return this.setState({ s: 'idle' });
    void this.connect(gen, this.target);
  }

  private async connect(gen: number, target: Target): Promise<void> {
    this.attempt += 1;
    this.setState({ s: 'connecting', attempt: this.attempt });
    let session: WasmSession;
    try {
      this.phone ??= this.wasm.Phone.bind(this.key).catch((e: unknown) => {
        this.phone = null;
        throw e;
      });
      session = await (await this.phone).connect(target.island.id, target.island.relays, CONNECT_MS);
    } catch (e) {
      if (gen === this.gen) this.retry(gen, errText(e));
      return;
    }
    if (gen !== this.gen) {
      session.close('not needed');
      queueMicrotask(() => session.free());
      return;
    }
    this.session = session;
    this.lastHeard = Date.now();
    session.onLine((line) => this.line(gen, line));
    session.onFile((header, file) => void this.receive(gen, header, file));
    const first = target.pairing ? { t: 'pair', v: PROTOCOL_V, code: target.pairing.code, name: target.pairing.name } : { t: 'hi', v: PROTOCOL_V };
    if (session.send(JSON.stringify(first)) && !target.pairing) this.online();
    this.pingTimer = window.setInterval(() => this.ping(gen), PING_MS);
    // Last: it calls back at once if the connection is already over.
    session.onClosed((why) => {
      if (gen === this.gen && this.session === session) this.retry(gen, why);
    });
  }

  private online(): void {
    this.attempt = 0;
    this.setState({ s: 'online', since: Date.now() });
  }

  private retry(gen: number, why: string): void {
    this.dropSession(why);
    if (gen !== this.gen || !this.target) return;
    const wait = BACKOFF_MS[Math.min(Math.max(this.attempt, 1), BACKOFF_MS.length) - 1];
    this.setState({ s: 'offline', retryAt: Date.now() + wait, why });
    // While hidden nothing is tried; showing the page dials at once.
    if (document.visibilityState !== 'hidden') this.retryTimer = window.setTimeout(() => this.kick(gen), wait);
  }

  private ping(gen: number): void {
    const s = this.session;
    if (gen !== this.gen || !s) return;
    const sent = Date.now();
    s.send('{"t":"ping"}');
    window.setTimeout(() => {
      if (gen === this.gen && this.session === s && this.lastHeard < sent) this.retry(gen, 'The PC stopped answering.');
    }, PONG_WAIT_MS);
  }

  private visibility(): void {
    if (document.visibilityState === 'hidden') {
      window.clearTimeout(this.retryTimer);
      window.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = window.setTimeout(() => this.hide(), HIDDEN_CLOSE_MS);
      return;
    }
    window.clearTimeout(this.hiddenTimer);
    if (this.target && !this.session && (this.state.s === 'idle' || this.state.s === 'offline')) {
      window.clearTimeout(this.retryTimer);
      this.attempt = 0;
      this.kick(this.gen);
    }
  }

  /** The page has been hidden a while (or is going away): drop the connection, dial again on show. */
  private hide(): void {
    window.clearTimeout(this.hiddenTimer);
    if (!this.session && this.state.s !== 'offline' && this.state.s !== 'connecting') return;
    const p = this.pairing;
    this.gen++;
    window.clearTimeout(this.retryTimer);
    this.dropSession('hidden');
    if (p) {
      this.pairing = null;
      window.clearTimeout(p.timer);
      p.reject(pairError('The page was hidden before the PC answered.', 'timeout'));
    }
    this.setState({ s: 'idle' });
  }

  // ---------------------------------------------------------------- lines and files

  private line(gen: number, line: string): void {
    if (gen !== this.gen) return;
    this.lastHeard = Date.now();
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const m = readIslandMsg(raw);
    if (!m || m.t === 'pong') return;
    if (m.t === 'paired') {
      const p = this.pairing;
      const t = this.target;
      if (p && t) {
        this.pairing = null;
        window.clearTimeout(p.timer);
        const saved: SavedIsland = { ...t.island, name: m.name, pairedAt: Date.now(), lastSeen: Date.now() };
        this.target = { island: saved, pairing: null };
        this.online();
        p.resolve(saved);
      }
    } else if (m.t === 'denied') {
      this.stop(pairError(DENIED[m.why], m.why));
      this.setState({ s: 'denied', why: m.why });
    } else if (m.t === 'bye') {
      this.stop(new Error('The PC removed this phone.'));
      this.setState({ s: 'removed' });
    }
    for (const cb of [...this.messages]) {
      try {
        cb(m);
      } catch (e) {
        console.error(e);
      }
    }
  }

  private async receive(gen: number, headerLine: string, file: WasmFileIn): Promise<void> {
    let header: FileHeader | null = null;
    try {
      header = readHeader(JSON.parse(headerLine));
    } catch {
      // Not JSON: refused below.
    }
    const id = header?.id ?? '';
    try {
      if (!header) throw new Error('not a file header');
      if (!this.files.size || gen !== this.gen) throw new Error("this page isn't taking files");
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let got = 0;
      for (let piece = await file.read(); piece; piece = await file.read()) {
        parts.push(piece);
        got += piece.length;
      }
      if (got !== header.size) throw new Error('the file was cut short');
      const blob = new Blob(parts, { type: header.mime });
      await file.reply(JSON.stringify({ t: 'file-ok', id, name: header.name } satisfies FileReply));
      for (const cb of [...this.files]) {
        try {
          cb({ header, blob });
        } catch (e) {
          console.error(e);
        }
      }
    } catch (e) {
      await file.reply(JSON.stringify({ t: 'file-error', id, error: errText(e) } satisfies FileReply)).catch(() => undefined);
    } finally {
      queueMicrotask(() => file.free());
    }
  }

  private setState(s: LinkState): void {
    this.state = s;
    for (const cb of [...this.states]) {
      try {
        cb(s);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

let made: Promise<Link> | null = null;

/** The page's one link (one key, one endpoint); the wasm loads on the first call. */
export const createLink: CreateLink = () => {
  made ??= loadWasm()
    .then((wasm): Link => new PhoneLink(wasm, phoneKey()))
    .catch((e: unknown) => {
      made = null;
      throw e;
    });
  return made;
};
