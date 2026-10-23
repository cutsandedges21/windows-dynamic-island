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
};

(window as unknown as { t: typeof t }).t = t;
