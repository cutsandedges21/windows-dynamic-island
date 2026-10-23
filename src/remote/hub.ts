// Island on your phone, the island's side: one session per connected phone. It greets a phone,
// sends it the pill and what shows under it whenever they change (at most MAX_VIEWS_PER_S of
// each a second, the last state always going out), and runs its taps through the island, but
// only taps on what it was shown. Rust (src-tauri/src/remote) holds the connections and the
// pairing; this decides what goes over them. Design: docs/superpowers/specs/2026-10-22-island-phone-design.md.

import type { MirrorFrame } from '../core/mirror';
import type { RemoteFile, RemotePhone } from '../core/native';
import type { SheetView } from '../core/sheet';
import { MAX_VIEWS_PER_S, PHONE_ISLAND_ACTIONS, PROTOCOL_V, readPhoneMsg, type BotState, type IslandMsg, type Nav } from './protocol';
import { HELLO_GUARDED, mayPress, pressables, stripActions, stripPill, type Pressables } from './views';

/** A paired phone, as Rust lists it (`remote_phones`, the `remote-phones` event). */
export type PhoneInfo = RemotePhone;

/** Something a phone sent the PC, for the island to show the way Land shows what another computer sent. */
export type PhoneDelivery =
  | { kind: 'text'; phone: string; from: string; text: string }
  | { kind: 'file'; phone: string; from: string; id: string; name: string; path: string; size: number; mime: string };

/** What the island gives the hub (src/core/island.ts). */
export interface PhoneIslandHooks {
  /** The pill as last composed, and the bot beside it (null while it is off); null before the first compose. */
  pill(): { frame: MirrorFrame; bot: BotState | null } | null;
  /** What shows under a phone's pill: an urgent card first, else what `nav` asks for. `nav` comes back as what it shows. */
  view(nav: Nav, width: number): { nav: Nav; view: SheetView | null; urgent: string | null };
  /** Runs a tap the hub allowed, as a click on the island would; settles when the activity is done with it. */
  act(phone: string, action: string, arg: unknown): Promise<void>;
  /** This island, for `hello`. `allow`: Claude's Allow may be pressed from a phone (Windows Hello isn't asked first). */
  facts(): { name: string; platform: 'windows' | 'macos'; version: string; allow: boolean };
  /** Text or a file from a phone arrived (already copied, or saved to Downloads). */
  fromPhone(item: PhoneDelivery): void;
}

/** The native calls the hub makes (src/remote/native.ts; faked in tests). */
export interface PhoneNative {
  phones(): Promise<PhoneInfo[]>;
  send(phone: string | null, msg: IslandMsg): Promise<boolean>;
  /** Phase 3: the key phones subscribe to pushes with; '' while there is none. */
  vapid(): Promise<string>;
  push(title: string, body: string, tag: string, open: string, urgent: boolean): Promise<number>;
  copy(text: string): Promise<boolean>;
  clipboard(): Promise<{ files: string[]; text: string | null }>;
  lock(): Promise<unknown>;
  log(text: string): void;
  on<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

/** A phone's card before it says how wide it is: an iPhone's. */
export const DEFAULT_WIDTH = 390;
/** The least time between two views (or two pills) to one phone. */
const GAP_MS = Math.ceil(1000 / MAX_VIEWS_PER_S);
/** Clipboard text a phone gets at most: a control line holds 1 MiB, and escaped text takes up to 6 bytes a character. */
export const CLIP_MAX = 100_000;
const NONE: ReadonlySet<string> = new Set();

/** At most one run per `gap` ms; a poke inside the gap runs once at its end, so the newest state always goes. */
export class Throttle {
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gap: number,
    private readonly run: () => void,
  ) {}

  poke(): void {
    if (this.timer) return;
    const wait = this.last + this.gap - Date.now();
    if (wait <= 0) this.fire();
    else this.timer = setTimeout(() => this.fire(), wait);
  }

  /** Runs now, whatever the gap (a phone just asked for something else). */
  now(): void {
    this.fire();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(): void {
    this.cancel();
    this.last = Date.now();
    this.run();
  }
}

/** Which phone pressed what each activity is running now, so a card it opens meanwhile opens on that phone. */
export class PhoneActs {
  private readonly by = new Map<string, string>();

  async run(id: string, phone: string, go: () => Promise<void>): Promise<void> {
    this.by.set(id, phone);
    try {
      await go();
    } finally {
      if (this.by.get(id) === phone) this.by.delete(id);
    }
  }

  phoneFor(id: string): string | null {
    return this.by.get(id) ?? null;
  }
}

/** What makes a pill different to a phone: the key Duplicate mode's copies use (island.ts sendMirror), and the bot. */
export function pillKey(frame: MirrorFrame, bot: BotState | null): string {
  return `${frame.sig}|${frame.hidden}|${frame.fsHide}|${frame.fullscreen}|${JSON.stringify(frame.glow)}|${frame.speed}|${frame.anchor}|${frame.edge}|${frame.accent}|${frame.color}|${frame.reduce}|${frame.bot?.d ?? 0}|${JSON.stringify(bot)}`;
}

interface Session {
  id: string;
  name: string;
  nav: Nav;
  width: number;
  /** The last view sent (its JSON), and what it offered to press. */
  viewJson: string;
  viewPress: Pressables;
  /** The last pill sent (its key and frame), and what it offered to press. */
  pillKey: string;
  pillFrame: MirrorFrame | null;
  pillPress: Pressables;
  /** Lines go out one after another, in order (hello first). */
  chain: Promise<void>;
  pill: Throttle;
  view: Throttle;
}

const isPhone = (p: unknown): p is PhoneInfo => typeof p === 'object' && p !== null && typeof (p as PhoneInfo).id === 'string' && typeof (p as PhoneInfo).name === 'string';

export class PhoneHub {
  private readonly sessions = new Map<string, Session>();
  /** Every paired phone, connected or not (phase 3: which ones take pushes). */
  private phones: PhoneInfo[] = [];
  private vapidKey: Promise<string | null> | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly hooks: PhoneIslandHooks,
    private readonly native: PhoneNative,
  ) {}

  /** Listens to Rust and greets the phones connected already (the island window reloaded). */
  async start(): Promise<void> {
    this.offs.push(
      await this.native.on<PhoneInfo[]>('remote-phones', (list) => this.onPhones(list)),
      await this.native.on<{ phone: string; msg: unknown }>('remote-msg', (e) => void this.onMsg(e)),
      await this.native.on<RemoteFile>('remote-file', (e) => this.onFile(e)),
    );
    await this.refresh();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const s of [...this.sessions.values()]) this.drop(s);
  }

  /** After every island compose: whatever changed goes to each phone. */
  tick(): void {
    for (const s of this.sessions.values()) {
      s.pill.poke();
      s.view.poke();
    }
  }

  /** An activity opened its card while running what this phone pressed: the phone shows it. */
  openCard(phone: string, id: string): void {
    const s = this.sessions.get(phone);
    if (!s) return;
    s.nav = { open: 'card', id };
    s.view.now();
  }

  /** It went back to Control Center, on that phone. */
  closeCard(phone: string, id: string): void {
    const s = this.sessions.get(phone);
    if (s?.nav.open !== 'card' || s.nav.id !== id) return;
    s.nav = { open: 'grid' };
    s.view.now();
  }

  /** Some phone shows this activity's card (Land keeps its lists fresh while one does). */
  showsCard(id: string): boolean {
    for (const s of this.sessions.values()) if (s.nav.open === 'card' && s.nav.id === id) return true;
    return false;
  }

  /** Phase 3: a notification to the phones that turned them on; `open` is the activity whose card a tap opens. */
  push(title: string, body: string, tag: string, open: string, urgent: boolean): void {
    if (!this.phones.some((p) => p.push)) return;
    void this.native.push(title, body, tag, open, urgent).catch((err) => this.native.log(`phone: push failed: ${String(err)}`));
  }

  // ---------------------------------------------------------------- phones coming and going

  private async refresh(): Promise<void> {
    this.onPhones(await this.native.phones());
  }

  private onPhones(list: unknown): void {
    this.phones = Array.isArray(list) ? list.filter(isPhone) : [];
    const live = new Set(this.phones.filter((p) => p.connected).map((p) => p.id));
    for (const s of [...this.sessions.values()]) if (!live.has(s.id)) this.drop(s);
    for (const p of this.phones) {
      const s = this.sessions.get(p.id);
      if (s) s.name = p.name;
      else if (p.connected) this.greet(p);
    }
  }

  /** A phone connected: hello, then its pill and view at once. */
  private greet(p: PhoneInfo): void {
    const s: Session = {
      id: p.id,
      name: p.name,
      nav: { open: 'grid' },
      width: DEFAULT_WIDTH,
      viewJson: '',
      viewPress: new Map(),
      pillKey: '',
      pillFrame: null,
      pillPress: new Map(),
      chain: Promise.resolve(),
      pill: new Throttle(GAP_MS, () => this.sendPill(s)),
      view: new Throttle(GAP_MS, () => this.sendView(s)),
    };
    this.sessions.set(p.id, s);
    this.native.log(`phone: ${p.name} connected`);
    this.send(s, async () => {
      const f = this.hooks.facts();
      return { t: 'hello', v: PROTOCOL_V, name: f.name, platform: f.platform, version: f.version, allow: f.allow, vapid: await this.vapid() };
    });
    s.pill.now();
    s.view.now();
  }

  /** Gone, offline or removed: the hub forgets it. */
  private drop(s: Session): void {
    s.pill.cancel();
    s.view.cancel();
    this.sessions.delete(s.id);
    this.native.log(`phone: ${s.name} left`);
  }

  /** The push key, asked once (phones connecting together share the ask); none yet asks again next time. */
  private vapid(): Promise<string | null> {
    return (this.vapidKey ??= this.native.vapid().then(
      (v) => {
        if (!v) this.vapidKey = null;
        return v || null;
      },
      () => (this.vapidKey = null),
    ));
  }

  // ---------------------------------------------------------------- what goes to a phone

  /** Queues a line for one phone; it goes only while that session lasts. */
  private send(s: Session, msg: IslandMsg | (() => Promise<IslandMsg>)): void {
    s.chain = s.chain
      .then(async () => {
        const m = typeof msg === 'function' ? await msg() : msg;
        if (this.sessions.get(s.id) === s) await this.native.send(s.id, m);
      })
      .catch((err) => this.native.log(`phone: sending to ${s.name} failed: ${String(err)}`));
  }

  private toast(s: Session, text: string, tone: 'good' | 'bad' | 'info'): void {
    this.send(s, { t: 'toast', text, tone });
  }

  /** Claude's Allow is held back while Windows Hello is asked before it. */
  private blocked(): ReadonlySet<string> {
    return this.hooks.facts().allow ? NONE : new Set(HELLO_GUARDED);
  }

  private sendPill(s: Session): void {
    const p = this.hooks.pill();
    if (!p) return;
    const frame = stripPill(p.frame, this.blocked());
    const key = pillKey(frame, p.bot);
    // A nod (bump) is news once per composed frame, even when nothing else changed.
    if (key === s.pillKey && !(p.frame.bump && p.frame !== s.pillFrame)) return;
    s.pillKey = key;
    s.pillFrame = p.frame;
    s.pillPress = pressables(frame.placed);
    this.send(s, { t: 'pill', frame, bot: p.bot });
  }

  private sendView(s: Session): void {
    const got = this.hooks.view(s.nav, s.width);
    // A card it can't have shows as Control Center, and the phone is told so.
    s.nav = got.nav;
    const view = got.view ? stripActions(got.view, this.blocked()) : null;
    const msg: IslandMsg = { t: 'view', nav: got.nav, view, urgent: got.urgent };
    const json = JSON.stringify(msg);
    if (json === s.viewJson) return;
    s.viewJson = json;
    s.viewPress = pressables(view);
    this.send(s, msg);
  }

  // ---------------------------------------------------------------- what a phone says

  private async onMsg(e: { phone: string; msg: unknown } | null): Promise<void> {
    if (!e || typeof e.phone !== 'string') return;
    let s = this.sessions.get(e.phone);
    if (!s) {
      // Its first line can beat the list that says it connected.
      await this.refresh();
      s = this.sessions.get(e.phone);
      if (!s) return this.native.log('phone: a line from a phone that is not connected');
    }
    const m = readPhoneMsg(e.msg);
    if (!m) return this.native.log(`phone: ${s.name} sent a line the island doesn't read`);
    switch (m.t) {
      case 'nav':
        s.nav = m.open === 'card' ? { open: 'card', id: m.id } : { open: m.open };
        if (m.width) s.width = m.width;
        s.view.now();
        return;
      case 'act':
        return this.press(s, m.action, m.arg);
      case 'text':
        return this.text(s, m.text);
      case 'clip-get':
        return this.clip(s);
      case 'lock':
        return this.lock(s);
    }
  }

  /**
   * A tap. It runs only if this phone was shown it (in its last view or pill, with the same
   * argument), and of the island's own actions only Quiet: never arranging, hiding or moving
   * the island, or opening windows on the PC.
   */
  private async press(s: Session, action: string, arg: unknown): Promise<void> {
    const guarded = action.startsWith('act:') && this.blocked().has(action);
    if (guarded || !this.allowed(s, action, arg)) {
      this.native.log(`phone: refused ${action} from ${s.name}`);
      this.toast(s, guarded ? 'Allow needs Windows Hello, on the PC' : "That button isn't there any more", 'bad');
      return;
    }
    try {
      await this.hooks.act(s.id, action, arg);
    } catch (err) {
      this.native.log(`phone: ${action} failed: ${String(err)}`);
    }
  }

  private allowed(s: Session, action: string, arg: unknown): boolean {
    if (PHONE_ISLAND_ACTIONS.includes(action)) return true;
    if (!action.startsWith('act:')) return false;
    return mayPress(s.viewPress, action, arg) || mayPress(s.pillPress, action, arg);
  }

  /** Text or a link: on the PC's clipboard at once, and on the island like Land shows text from another computer. */
  private async text(s: Session, text: string): Promise<void> {
    const ok = await this.native.copy(text);
    this.hooks.fromPhone({ kind: 'text', phone: s.id, from: s.name, text });
    const name = this.hooks.facts().name;
    this.toast(s, ok ? `Copied on ${name}` : `Couldn't copy it on ${name}`, ok ? 'good' : 'bad');
  }

  /** The PC's clipboard, its text only ('' when it holds files or nothing). */
  private async clip(s: Session): Promise<void> {
    const text = (await this.native.clipboard()).text ?? '';
    this.send(s, { t: 'clip', text: text.slice(0, CLIP_MAX) });
    if (text.length > CLIP_MAX) this.toast(s, `Only the first ${CLIP_MAX.toLocaleString('en-US')} characters came`, 'info');
  }

  private async lock(s: Session): Promise<void> {
    await this.native.lock();
    this.toast(s, 'Locked', 'good');
  }

  /** A file from a phone, saved to Downloads by Rust (which told the phone): the island shows it. */
  private onFile(e: RemoteFile | null): void {
    if (!e || typeof e.phone !== 'string' || typeof e.path !== 'string' || !e.path) return;
    const from = this.sessions.get(e.phone)?.name ?? this.phones.find((p) => p.id === e.phone)?.name ?? 'Your phone';
    const name = typeof e.name === 'string' && e.name ? e.name : (e.path.split(/[\\/]/).pop() ?? e.path);
    this.hooks.fromPhone({ kind: 'file', phone: e.phone, from, id: String(e.id ?? ''), name, path: e.path, size: Number(e.size) || 0, mime: String(e.mime ?? '') });
  }
}
