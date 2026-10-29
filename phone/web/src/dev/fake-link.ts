// A pretend connection for ?demo (and the fallback while the real link isn't built): a PC
// named MossLaptop with music playing, Claude working, a Control Center of every tile kind, and
// a permission card that comes in after a few seconds (?urgent: at once). Taps change the demo
// and answer with a toast, so a press visibly does something. ?offline: it never answers. Its
// terminals are pretend ones too (fake-term.ts), and its Screen says Chrome Remote Desktop is
// ready (?noterm: terminals off; ?screen=off|missing|none: Screen's other answers).

import type { FileHeader, IslandMsg, Nav, PairPayload, ScreenState, TermHeader } from '../../../../src/remote/protocol';
import { MAX_UPLOAD } from '../../../../src/remote/protocol';
import type { IncomingFile, Link, LinkState, SavedIsland, TermHandle } from '../link/api';
import { DEMO_NAME, DESKTOP_NAME, TRACKS, demoHello, demoPill, demoView, desktopDemo, initialDemo, position, type DemoState } from './demo-data';
import { FakeTerms } from './fake-term';

type Sent = Parameters<Link['send']>[0];
type TermEvents = Parameters<Link['openTerm']>[1];

export const DEMO_ISLAND: SavedIsland = {
  id: 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0',
  name: DEMO_NAME,
  relays: ['https://use1-1.relay.n0.iroh.iroh.link/'],
  pairedAt: Date.UTC(2026, 9, 22, 18, 0),
  lastSeen: null,
};

/** The second pretend PC (?demo&two), to see a phone switch between PCs. */
export const DESKTOP_ISLAND: SavedIsland = {
  id: 'p7d2kq9x4m1w8z3c6b5n0h2rtfa8e4gj1sv6ou9lqxw3y5z7c2d4',
  name: DESKTOP_NAME,
  relays: ['https://use1-1.relay.n0.iroh.iroh.link/'],
  pairedAt: Date.UTC(2026, 9, 23, 18, 0),
  lastSeen: null,
};

export interface FakeOptions {
  /** Start with Claude's permission card. */
  urgent?: boolean;
  /** Never come online (the offline screen). */
  offline?: boolean;
  /** Terminals from phones allowed on the pretend PC (yes unless false). */
  term?: boolean;
  /** Chrome Remote Desktop on the pretend PC ('ready' unless given). */
  screen?: ScreenState;
}

export class FakeLink implements Link {
  readonly phoneId = 'demo-phone-0000000000000000000000000000000000000000';
  private st: LinkState = { s: 'idle' };
  private readonly states = new Set<(s: LinkState) => void>();
  private readonly msgs = new Set<(m: IslandMsg) => void>();
  private readonly files = new Set<(f: IncomingFile) => void>();
  private demo: DemoState = initialDemo(Date.now());
  private nav: Nav = { open: 'none' };
  private width = 374;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastPill = '';
  private lastView = '';
  private askSeq = 0;
  /** The pretend PC this link is open to. */
  private island: SavedIsland | null = null;
  /** Each pretend PC's terminals: they keep running while the phone is away, as on a PC. */
  private readonly termsByPc = new Map<string, FakeTerms>();

  constructor(private readonly opts: FakeOptions = {}) {}

  private get terms(): FakeTerms {
    const key = this.island?.id ?? '';
    let t = this.termsByPc.get(key);
    if (!t) {
      t = new FakeTerms({ emit: (m) => this.emit(m), later: (ms, fn) => this.later(ms, fn) }, { allowed: this.opts.term !== false });
      this.termsByPc.set(key, t);
    }
    return t;
  }

  get state(): LinkState {
    return this.st;
  }

  private set(s: LinkState): void {
    this.st = s;
    for (const cb of this.states) cb(s);
  }

  private emit(m: IslandMsg): void {
    for (const cb of this.msgs) cb(m);
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  pair(pair: PairPayload, _phoneName: string): Promise<SavedIsland> {
    this.close();
    this.set({ s: 'connecting', attempt: 1 });
    return new Promise((resolve, reject) => {
      this.later(900, () => {
        // Demo codes: all zeros ran out, all f's were wrong; anything else pairs.
        if (pair.code === '0'.repeat(32) || pair.code === 'f'.repeat(32)) {
          const why = pair.code[0] === '0' ? 'expired' : 'code';
          this.set({ s: 'denied', why });
          reject(Object.assign(new Error(`denied: ${why}`), { why }));
          return;
        }
        const saved: SavedIsland = { id: pair.id, name: pair.name || DEMO_NAME, relays: pair.relays, pairedAt: Date.now(), lastSeen: Date.now() };
        resolve(saved);
        this.connected();
      });
    });
  }

  open(island: SavedIsland): void {
    this.close();
    this.island = island;
    this.set({ s: 'connecting', attempt: 1 });
    if (this.opts.offline) {
      const retry = (attempt: number) => {
        this.set({ s: 'offline', retryAt: Date.now() + 8000, why: "Couldn't reach it through the relay" });
        this.later(8000, () => {
          this.set({ s: 'connecting', attempt });
          this.later(1200, () => retry(attempt + 1));
        });
      };
      this.later(1200, () => retry(2));
      return;
    }
    this.later(700, () => this.connected());
  }

  private connected(): void {
    this.set({ s: 'online', since: Date.now() });
    const desktop = this.island?.id === DESKTOP_ISLAND.id;
    this.demo = desktop ? desktopDemo(Date.now()) : initialDemo(Date.now());
    // Claude asks for permission on the laptop only: the desktop is the quiet one.
    if (!desktop && this.opts.urgent) this.ask();
    else if (!desktop) this.later(9000, () => this.ask());
    this.emit(demoHello(desktop ? DESKTOP_NAME : DEMO_NAME, { term: this.opts.term !== false, screen: this.opts.screen }));
    this.push(true);
    // The tiles' bars and clocks move; the island sends a view when something in it changes.
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  private ask(): void {
    if (this.st.s !== 'online' || this.demo.ask) return;
    this.demo.ask = { id: `req-${++this.askSeq}`, at: Date.now() };
    this.moment('claude-asks');
  }

  private tick(): void {
    const d = this.demo;
    const now = Date.now();
    if (d.playing && position(d, now) >= TRACKS[d.track].duration) this.next();
    if (d.timer && d.timer.pausedLeft === null && now >= d.timer.until) {
      d.timer = null;
      this.toast('Timer done', 'info');
      this.moment('timer-done');
    }
    this.push(false);
  }

  /** Sends the pill and the view if they changed (the island sends on change only). */
  private push(force: boolean): void {
    if (this.st.s !== 'online') return;
    const now = Date.now();
    const pill = demoPill(this.demo, now);
    const pk = JSON.stringify(pill);
    if (force || pk !== this.lastPill) {
      this.lastPill = pk;
      this.emit(pill);
    }
    const view = demoView(this.demo, this.nav, this.width, now);
    const vk = JSON.stringify(view);
    if (force || vk !== this.lastView) {
      this.lastView = vk;
      this.emit(view);
    }
  }

  private moment(id: DemoState['moment']): void {
    this.demo.moment = id;
    this.demo.play += 1;
    const play = this.demo.play;
    this.later(2600, () => {
      if (this.demo.play !== play) return;
      this.demo.moment = null;
      this.push(false);
    });
    this.push(false);
  }

  private toast(text: string, tone: 'good' | 'bad' | 'info' = 'info'): void {
    this.emit({ t: 'toast', text, tone });
  }

  private next(step = 1): void {
    const d = this.demo;
    d.track = (d.track + step + TRACKS.length) % TRACKS.length;
    d.pos = 0;
    d.posAt = Date.now();
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.lastPill = '';
    this.lastView = '';
    if (this.st.s !== 'idle') this.set({ s: 'idle' });
    // The connection's streams go with it; the terminals keep running.
    for (const t of this.termsByPc.values()) t.dropStreams();
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.states.add(cb);
    return () => this.states.delete(cb);
  }

  onMessage(cb: (m: IslandMsg) => void): () => void {
    this.msgs.add(cb);
    return () => this.msgs.delete(cb);
  }

  onFile(cb: (f: IncomingFile) => void): () => void {
    this.files.add(cb);
    return () => this.files.delete(cb);
  }

  send(m: Sent): boolean {
    if (this.st.s !== 'online') return false;
    // The real island answers within a frame or two; so does the demo.
    this.later(60, () => this.handle(m));
    return true;
  }

  openTerm(header: TermHeader, on: TermEvents): Promise<TermHandle> {
    if (this.st.s !== 'online') return Promise.reject(new Error('Not connected'));
    return this.terms.open(header, on);
  }

  private handle(m: Sent): void {
    switch (m.t) {
      case 'term-list':
        this.terms.sendList();
        return;
      case 'term-kill':
        this.terms.kill(m.id);
        return;
      case 'nav':
        this.nav = m.open === 'card' ? { open: 'card', id: m.id } : { open: m.open };
        if (m.width) this.width = m.width;
        this.push(true);
        return;
      case 'act':
        this.act(m.action, m.arg);
        this.push(false);
        return;
      case 'text':
        this.toast(`Sent to ${DEMO_NAME}`, 'good');
        this.moment('copy');
        return;
      case 'clip-get':
        this.later(250, () => this.emit({ t: 'clip', text: 'npm run release -- --notes "Phone site, phase 1"' }));
        return;
      case 'lock':
        this.toast(`Locked ${DEMO_NAME}`, 'good');
        return;
      case 'push-sub':
        return;
    }
  }

  private act(action: string, arg: unknown): void {
    const d = this.demo;
    const now = Date.now();
    // act:<activity>:<name>[:<more>]
    const [, id, name = ''] = action.split(':');
    switch (`${id}:${name}`) {
      case 'music:toggle':
        d.pos = position(d, now);
        d.posAt = now;
        d.playing = !d.playing;
        this.moment(d.playing ? 'played' : 'paused');
        return;
      case 'music:next':
      case 'music:prev':
        this.next(name === 'next' ? 1 : -1);
        this.moment('track');
        return;
      case 'music:seek':
        if (typeof arg === 'number') {
          d.pos = arg;
          d.posAt = now;
        }
        return;
      case 'music:open':
      case 'claude:open':
        // The activity opened its card: on the phone that pressed it (hub.ts does this for ctx.openCard()).
        this.nav = { open: 'card', id };
        this.push(true);
        return;
      case 'claude:allow':
      case 'claude:deny':
      case 'claude:deny-with':
        if (!d.ask) return;
        d.ask = null;
        this.toast(name === 'allow' ? 'Allowed from your phone' : name === 'deny' ? 'Denied from your phone' : `Told Claude: ${String(arg)}`, name === 'allow' ? 'good' : 'info');
        this.moment('answered');
        // Another one later, so the demo keeps asking.
        this.later(45_000, () => this.ask());
        return;
      case 'claude:switch':
        this.toast(`Opened ${arg === 's2' ? 'degreepilot' : 'island-phone'} on ${DEMO_NAME}`, 'info');
        return;
      case 'claude:hide':
        this.toast('Hidden', 'info');
        return;
      case 'timer:start':
      case 'timer:focus': {
        const total = name === 'focus' ? 25 * 60_000 : typeof arg === 'number' ? arg : 300_000;
        d.timer = { label: name === 'focus' ? 'Focus' : 'Timer', until: now + total, total, pausedLeft: null };
        this.moment('timer-start');
        return;
      }
      case 'timer:toggle':
        if (!d.timer) return;
        if (d.timer.pausedLeft === null) d.timer.pausedLeft = Math.max(0, d.timer.until - now);
        else {
          d.timer.until = now + d.timer.pausedLeft;
          d.timer.pausedLeft = null;
        }
        return;
      case 'timer:stop':
        d.timer = null;
        this.toast('Timer stopped', 'info');
        return;
      case 'land:demo-text':
        this.emit({ t: 'text', text: 'https://github.com/cutsandedges21/windows-dynamic-island', from: DEMO_NAME });
        this.moment('land-sent');
        return;
      case 'land:demo-file': {
        const text = `Notes from ${DEMO_NAME}\n\n- Pair the phone from Settings › Your phone\n- Try a tile, answer Claude\n`;
        const blob = new Blob([text], { type: 'text/plain' });
        const header: FileHeader = { t: 'file', id: `f${now}`, name: 'notes.txt', size: blob.size, mime: 'text/plain' };
        for (const cb of this.files) cb({ header, blob });
        this.moment('land-sent');
        return;
      }
    }
    if (action === 'island:dnd') {
      d.dnd = !d.dnd;
      this.toast(d.dnd ? 'Quiet on' : 'Quiet off', 'info');
      return;
    }
    this.toast(`Pressed ${action}`, 'info');
  }

  sendFile(file: File, onProgress?: (p: number) => void): Promise<{ name: string }> {
    if (this.st.s !== 'online') return Promise.reject(new Error('Not connected'));
    if (file.size > MAX_UPLOAD) return Promise.reject(new Error('Too big: 2 GB at most'));
    return new Promise((resolve) => {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        this.later(i * 110, () => {
          onProgress?.(i / steps);
          if (i === steps) {
            // The PC never overwrites: a second copy gets " (2)".
            const dot = file.name.lastIndexOf('.');
            const saved = this.sent.has(file.name) ? (dot > 0 ? `${file.name.slice(0, dot)} (2)${file.name.slice(dot)}` : `${file.name} (2)`) : file.name;
            this.sent.add(file.name);
            resolve({ name: saved });
          }
        });
      }
    });
  }

  private readonly sent = new Set<string>();
}
