// The link tests' page: the real Link (phone/web/src/link) with a few helpers phone/e2e/run.mjs
// calls through Playwright. Nothing here is drawn; window.t is the whole interface.

import { decodePair, type IslandMsg } from '../../../src/remote/protocol';
import type { Link, LinkState, SavedIsland } from '../../web/src/link/api';
import { createLink } from '../../web/src/link/index';

interface Ev {
  at: number;
  kind: 'state' | 'msg' | 'file';
  data: unknown;
}

const events: Ev[] = [];
const now = () => performance.now();
const push = (kind: Ev['kind'], data: unknown) => events.push({ at: now(), kind, data });
let link: Link;

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves with the event (and how long it took) once one after `from` matches. */
function waitEvent(pred: (e: Ev) => boolean, timeoutMs: number, from = events.length): Promise<Ev> {
  const t0 = now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = events.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (now() - t0 > timeoutMs) return reject(new Error(`timed out waiting (state ${JSON.stringify(link.state)})`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const isMsg = (t: IslandMsg['t'], text?: string) => (e: Ev) => e.kind === 'msg' && (e.data as IslandMsg).t === t && (text === undefined || (e.data as { text?: string }).text === text);

const t = {
  ready: createLink().then((l) => {
    link = l;
    l.onState((s) => push('state', s));
    l.onMessage((m) => push('msg', m));
    l.onFile(async (f) => push('file', { header: f.header, size: f.blob.size, type: f.blob.type, sha256: await sha256(await f.blob.arrayBuffer()) }));
    (document.getElementById('log') as HTMLElement).textContent = `phone ${l.phoneId}`;
    return l.phoneId;
  }),
  events,
  state: (): LinkState => link.state,
  async pair(text: string, wait = 20_000) {
    const p = decodePair(text);
    if (!p) throw new Error('not a pairing payload');
    const t0 = now();
    const from = events.length;
    const saved = await link.pair(p, 'TestPhone');
    const ms = now() - t0;
    const hello = await waitEvent(isMsg('hello'), wait, from);
    return { saved, ms, helloMs: hello.at - t0 };
  },
  async pairError(text: string) {
    try {
      await link.pair(decodePair(text)!, 'TestPhone');
      return null;
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e), why: (e as { why?: string }).why, state: link.state };
    }
  },
  async open(saved: SavedIsland, wait = 30_000) {
    const t0 = now();
    const from = events.length;
    link.open(saved);
    await this.waitState('online', wait, from);
    const hello = await waitEvent(isMsg('hello'), wait, from);
    return { onlineMs: now() - t0, helloMs: hello.at - t0 };
  },
  async waitState(s: LinkState['s'], wait: number, from = events.length) {
    const t0 = now();
    if (link.state.s === s) return 0;
    await waitEvent((e) => e.kind === 'state' && (e.data as LinkState).s === s, wait, from);
    return now() - t0;
  },
  /** Round trips: an `act` out, the fake island's `toast` with the same action back. */
  async rtt(n: number) {
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const action = `act:test:echo-${Date.now()}-${i}`;
      const from = events.length;
      const t0 = now();
      if (!link.send({ t: 'act', action })) throw new Error(`send refused in state ${link.state.s}`);
      await waitEvent(isMsg('toast', action), 10_000, from);
      ms.push(Math.round((now() - t0) * 10) / 10);
    }
    return ms;
  },
  async upload(size: number) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 253;
    const file = new File([bytes], 'from-phone.bin', { type: 'application/octet-stream' });
    const progress: number[] = [];
    const t0 = now();
    const r = await link.sendFile(file, (p) => progress.push(p));
    return { ...r, ms: now() - t0, sha256: await sha256(bytes.buffer), progressCalls: progress.length, lastProgress: progress.at(-1) };
  },
  async download(size: number) {
    const from = events.length;
    const t0 = now();
    link.send({ t: 'act', action: 'act:test:push-file', arg: { size } });
    const e = await waitEvent((x) => x.kind === 'file', 60_000, from);
    return { ...(e.data as object), ms: e.at - t0 };
  },
  /** Pretends the page went to the background (or came back). */
  setHidden(hidden: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  },
  send: (m: Parameters<Link['send']>[0]) => link.send(m),
  /**
   * A terminal on the fake island: open, type, rename, resize, a paste longer than a frame, close,
   * open it again (its output so far comes first), exit; then an id it doesn't know; then the list.
   */
  async term() {
    const r: Record<string, unknown> = {};
    const watch = () => {
      const dec = new TextDecoder();
      const o = { text: '', titles: [] as string[], exits: [] as (number | null)[], closed: 0 };
      const on = {
        data: (b: Uint8Array) => void (o.text += dec.decode(b, { stream: true })),
        title: (x: string) => void o.titles.push(x),
        exit: (c: number | null) => void o.exits.push(c),
        closed: () => void (o.closed += 1),
      };
      return { o, on };
    };
    const until = async (ok: () => boolean, what: string, wait = 10_000) => {
      const t0 = now();
      while (!ok()) {
        if (now() - t0 > wait) throw new Error(`timed out waiting for ${what}`);
        await new Promise((res) => setTimeout(res, 10));
      }
      return now() - t0;
    };
    const first = watch();
    let t0 = now();
    const h = await link.openTerm({ t: 'term', id: null, cols: 80, rows: 24, cwd: null, shell: null }, first.on);
    r.openMs = now() - t0;
    r.id = h.id;
    r.title = h.title;
    await until(() => first.o.text.includes('PS C:\\fake> '), 'the prompt');
    t0 = now();
    h.write('echo hi\r');
    await until(() => first.o.text.includes('you typed: echo hi'), 'the echo');
    r.echoMs = now() - t0;
    h.write('title Build\r');
    await until(() => first.o.titles.includes('Build'), 'the new title');
    r.titleAfter = h.title;
    h.resize(100, 30);
    const paste = 'x'.repeat(150 * 1024);
    const before = first.o.text.length;
    h.write(paste);
    await until(() => first.o.text.length - before >= paste.length, 'the paste echoed', 30_000);
    h.close();
    await new Promise((res) => setTimeout(res, 300));
    r.closedAfterClose = first.o.closed;
    const again = watch();
    const h2 = await link.openTerm({ t: 'term', id: h.id, cols: 100, rows: 30, cwd: null, shell: null }, again.on);
    await until(() => again.o.text.includes('you typed: echo hi'), 'the output replayed');
    r.reattachedId = h2.id;
    r.reattachedTitle = h2.title;
    h2.write('exit\r');
    await until(() => again.o.closed > 0, 'closed after exit');
    r.exits = again.o.exits;
    r.closedTimes = again.o.closed;
    r.unknown = await link.openTerm({ t: 'term', id: 'deadbeef', cols: 80, rows: 24, cwd: null, shell: null }, watch().on).then(
      () => 'opened',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    const from = events.length;
    link.send({ t: 'term-list' });
    r.terms = (await waitEvent((e) => e.kind === 'msg' && (e.data as { t: string }).t === 'terms', 5_000, from)).data;
    return r;
  },
};

(window as unknown as { t: typeof t }).t = t;
