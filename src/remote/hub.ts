// Island on your phone, the island's side: one session per connected phone. It greets a phone,
// sends it the pill and what shows under it whenever they change (at most MAX_VIEWS_PER_S of
// each a second, the last state always going out), and runs its taps through the island, but
// only taps on what it was shown. Rust (src-tauri/src/remote) holds the connections and the
// pairing; this decides what goes over them. Design: docs/superpowers/specs/2026-10-22-island-phone-design.md.

import type { MirrorFrame } from '../core/mirror';
import type { RemoteFile, RemotePhone } from '../core/native';
import type { Settings } from '../core/settings';
import type { SheetView } from '../core/sheet';
import { MAX_VIEWS_PER_S, PHONE_ISLAND_ACTIONS, PROTOCOL_V, readPhoneMsg, type BotState, type HelloFacts, type IslandMsg, type Nav, type PrefActivity, type PrefRow, type PrefValue } from './protocol';
import { gridSetAllowed, shownGridKeys, withoutTray, type PhoneLayout } from './grid-edit';
import { heldPush, PhoneOutbox, setPhoneHolder, type HeldItem } from './outbox';
import { HELLO_GUARDED, mayPress, PC_ONLY, pressables, stripActions, stripPill, type Pressables } from './views';

/** A paired phone, as Rust lists it (`remote_phones`, the `remote-phones` event). */
export type PhoneInfo = RemotePhone;

/** What a phone's tap ran into, in words for the phone: it shows there as a toast ("Couldn't start Claude: …"). */
export class PhoneError extends Error {}

/**
 * A paired phone may open terminals on this PC: Settings › Your phone allows it, and Windows Hello
 * isn't asked before Claude's Allow (a phone can't pass Hello, so it gets no terminals either).
 */
export function termAllowed(s: Pick<Settings, 'general' | 'activities'>): boolean {
  return s.general.phoneTerminal === true && s.activities.config.claude?.options.requireHello !== true;
}

/** Something a phone sent the PC, for the island to show the way Land shows what another computer sent. */
export type PhoneDelivery =
  | { kind: 'text'; phone: string; from: string; text: string }
  | { kind: 'file'; phone: string; from: string; id: string; name: string; path: string; size: number; mime: string; copied: boolean };

/** What the island gives the hub (src/core/island.ts). */
export interface PhoneIslandHooks {
  /** The pill as last composed, and the bot beside it (null while it is off); null before the first compose. */
  pill(): { frame: MirrorFrame; bot: BotState | null } | null;
  /** What shows under a phone's pill: an urgent card first, else what `nav` asks for. `nav` comes back as what it shows. */
  view(nav: Nav, width: number): { nav: Nav; view: SheetView | null; urgent: string | null };
  /** Runs a tap the hub allowed, as a click on the island would; settles when the activity is done with it (a PhoneError rejects it). */
  act(phone: string, action: string, arg: unknown): Promise<void>;
  /**
   * This island, for `hello`. `allow`: Claude's Allow may be pressed from a phone (Windows Hello
   * isn't asked first); `term`: a phone may open terminals; `screen`: Chrome Remote Desktop;
   * `folders`: recent project folders. Asked after every compose: a change sends a fresh hello.
   */
  facts(): HelloFacts;
  /** Text or a file from a phone arrived (already copied, or saved to Downloads; a picture copied too). */
  fromPhone(item: PhoneDelivery): void;
  /** The settings and activities a phone may change, with their values now (src/remote/prefs.ts `prefsOf`); null before settings load. */
  prefs?(): { rows: PrefRow[]; acts: PrefActivity[] } | null;
  /** Changes one of them, through the allow-list (`applyPref`) only, and saves; false: refused. */
  setPref?(key: string, value: PrefValue): boolean;
  /** Control Center arranged on a phone (tiles the hub checked it was shown): saved like an edit on the PC. */
  setGrid(layout: PhoneLayout): void;
}

/** The native calls the hub makes (src/remote/native.ts; faked in tests). */
export interface PhoneNative {
  phones(): Promise<PhoneInfo[]>;
  send(phone: string | null, msg: IslandMsg): Promise<boolean>;
  /** Phase 3: the key phones subscribe to pushes with; '' while there is none. */
  vapid(): Promise<string>;
  /** To every phone with a subscription, or only `phone`'s when given. */
  push(title: string, body: string, tag: string, open: string, urgent: boolean, phone?: string): Promise<number>;
  /** A file to a connected phone (Rust says how it went with `remote-file-sent`). */
  sendFile?(phone: string, path: string): Promise<unknown>;
  copy(text: string): Promise<boolean>;
  clipboard(): Promise<{ files: string[]; text: string | null }>;
  lock(): Promise<unknown>;
  sleep(): Promise<unknown>;
  log(text: string): void;
  on<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

/** A phone's card before it says how wide it is: an iPhone's. */
export const DEFAULT_WIDTH = 390;
/** The least time between two views (or two pills) to one phone. */
const GAP_MS = Math.ceil(1000 / MAX_VIEWS_PER_S);
/** Clipboard text a phone gets at most: a control line holds 1 MiB, and escaped text takes up to 6 bytes a character. */
export const CLIP_MAX = 100_000;
const AT_THE_PC: ReadonlySet<string> = new Set(PC_ONLY);

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
  return `${frame.sig}|${frame.hidden}|${frame.fsHide}|${frame.fullscreen}|${JSON.stringify(frame.glow)}|${frame.speed}|${frame.anchor}|${frame.edge}|${frame.accent}|${frame.color}|${frame.glass}|${frame.reduce}|${frame.bot?.d ?? 0}|${JSON.stringify(bot)}`;
}

interface Session {
  id: string;
  name: string;
  nav: Nav;
  width: number;
  /** The last view sent (its JSON), and what it offered to press. */
  viewJson: string;
  viewPress: Pressables;
  /** The Control Center tiles it was last shown (grid and tray): the only ones it may arrange. */
  gridKeys: Set<string>;
  /** The last pill sent (its key and frame), and what it offered to press. */
  pillKey: string;
  pillFrame: MirrorFrame | null;
  pillPress: Pressables;
  /** The facts its last hello said (JSON): a change sends a fresh one. */
  helloKey: string;
  /** The last `prefs` sent (JSON); null until the phone asks for them (its Activities or Settings screen). */
  prefsKey: string | null;
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
  /** What Land sent a phone while it wasn't connected: it goes when that phone connects. */
  private readonly outbox = new PhoneOutbox();

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
    setPhoneHolder((phone, item) => this.hold(phone, item));
    await this.refresh();
  }

  stop(): void {
    setPhoneHolder(null);
    for (const off of this.offs.splice(0)) off();
    for (const s of [...this.sessions.values()]) this.drop(s);
  }

  /** After every island compose: whatever changed goes to each phone. */
  tick(): void {
    this.syncHello();
    this.syncPrefs();
    for (const s of this.sessions.values()) {
      s.pill.poke();
      s.view.poke();
    }
  }

  /** What hello says changed (terminals allowed, the screen, recent folders, Allow): each phone gets a fresh one. */
  syncHello(): void {
    if (!this.sessions.size) return;
    const facts = this.hooks.facts();
    const key = JSON.stringify(facts);
    for (const s of this.sessions.values()) if (s.helloKey !== key) this.sendHello(s, facts, key);
  }

  /** Settings changed (here, on the PC or from a phone): each phone that asked for them gets the new values. */
  syncPrefs(force: Session | null = null): void {
    if (!this.hooks.prefs) return;
    const want = [...this.sessions.values()].filter((s) => s === force || s.prefsKey !== null);
    if (!want.length) return;
    const p = this.hooks.prefs();
    if (!p) return;
    const msg: IslandMsg = { t: 'prefs', rows: p.rows, acts: p.acts };
    const key = JSON.stringify(msg);
    for (const s of want) {
      if (s.prefsKey === key && s !== force) continue;
      s.prefsKey = key;
      this.send(s, msg);
    }
  }

  /** A paired phone's name (the island says which phone opened a terminal); null for one it doesn't know. */
  phoneName(id: string): string | null {
    return this.sessions.get(id)?.name ?? this.phones.find((p) => p.id === id)?.name ?? null;
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

  /**
   * Phase 3: a notification to the phones that turned them on (only `phone`, when given); `open`
   * is the activity whose card a tap opens.
   */
  push(title: string, body: string, tag: string, open: string, urgent: boolean, phone?: string): void {
    if (!this.phones.some((p) => p.push && (!phone || p.id === phone))) return;
    const sent = phone ? this.native.push(title, body, tag, open, urgent, phone) : this.native.push(title, body, tag, open, urgent);
    void sent.catch((err) => this.native.log(`phone: push failed: ${String(err)}`));
  }

  /**
   * Land sends a paired phone that isn't connected: the item waits (bounded, a day at most) and
   * the phone is notified, if it took notifications. False when the phone is connected (send it
   * now, as always), unknown, or the item can't wait.
   */
  hold(phone: string, item: HeldItem): boolean {
    if (this.sessions.has(phone)) return false;
    const p = this.phones.find((x) => x.id === phone);
    if (!p || p.connected) return false;
    if (!this.outbox.add(phone, item, Date.now())) return false;
    if (p.push) {
      const n = heldPush(item, this.hooks.facts().name);
      this.push(n.title, n.body, n.tag, n.open, false, p.id);
    }
    return true;
  }

  /** What waits for a phone now (Land's card counts on it; tests too). */
  held(phone: string): number {
    return this.outbox.count(phone, Date.now());
  }

  // ---------------------------------------------------------------- phones coming and going

  private async refresh(): Promise<void> {
    this.onPhones(await this.native.phones());
  }

  private onPhones(list: unknown): void {
    const before = this.phones;
    this.phones = Array.isArray(list) ? list.filter(isPhone) : [];
    for (const p of before) if (!this.phones.some((x) => x.id === p.id)) this.outbox.forget(p.id);
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
      gridKeys: new Set(),
      pillKey: '',
      pillFrame: null,
      pillPress: new Map(),
      helloKey: '',
      prefsKey: null,
      chain: Promise.resolve(),
      pill: new Throttle(GAP_MS, () => this.sendPill(s)),
      view: new Throttle(GAP_MS, () => this.sendView(s)),
    };
    this.sessions.set(p.id, s);
    this.native.log(`phone: ${p.name} connected`);
    const facts = this.hooks.facts();
    this.sendHello(s, facts, JSON.stringify(facts));
    s.pill.now();
    s.view.now();
    this.deliverHeld(s);
  }

  /** What waited for this phone goes now, after its hello, oldest first. */
  private deliverHeld(s: Session): void {
    for (const item of this.outbox.take(s.id, Date.now())) {
      if (item.kind === 'text') {
        this.send(s, { t: 'text', text: item.text, from: item.from });
        s.chain = s.chain.then(() => item.settle?.(this.sessions.get(s.id) === s ? 'sent' : 'dropped'));
      } else {
        const sendFile = this.native.sendFile;
        s.chain = s.chain
          .then(async () => {
            if (this.sessions.get(s.id) !== s) return item.settle?.('dropped');
            if (!sendFile) return item.settle?.('dropped');
            await sendFile.call(this.native, s.id, item.path);
            item.settle?.('sent');
          })
          .catch((err) => this.native.log(`phone: a held file for ${s.name} failed: ${String(err)}`));
      }
    }
  }

  /** Hello: who this island is, what a phone may do here, and the push key (asked once). */
  private sendHello(s: Session, facts: HelloFacts, key: string): void {
    s.helloKey = key;
    this.send(s, async () => ({ t: 'hello', v: PROTOCOL_V, ...facts, vapid: await this.vapid() }));
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

  /** Claude's Allow is held back while Windows Hello is asked before it; the PC's own buttons always are. */
  private blocked(): ReadonlySet<string> {
    return this.hooks.facts().allow ? AT_THE_PC : new Set([...PC_ONLY, ...HELLO_GUARDED]);
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
    // Tiles taken off the grid are shown to put back, never to press.
    s.viewPress = pressables(withoutTray(view));
    s.gridKeys = shownGridKeys(view);
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
      case 'prefs-get':
        return this.syncPrefs(s);
      case 'pref':
        return this.pref(s, m.key, m.value);
      case 'sleep':
        return this.sleep(s);
      case 'grid-set':
        return this.gridSet(s, { order: m.order, hidden: m.hidden });
    }
  }

  /**
   * A setting changed from the phone's Activities or Settings screen. Only the allow-list in
   * src/remote/prefs.ts is ever written (the island's `setPref` goes through `applyPref`): never
   * pairing, terminals, keys or paths. Refused, the phone says so and gets the values back.
   */
  private pref(s: Session, key: string, value: PrefValue): void {
    const ok = this.hooks.setPref?.(key, value) === true;
    if (!ok) {
      this.native.log(`phone: refused setting ${key} from ${s.name}`);
      this.toast(s, "That setting can't be changed from your phone", 'bad');
    }
    this.syncPrefs(s);
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
      this.toast(s, guarded ? (AT_THE_PC.has(action) ? 'Only on the PC' : 'Allow needs Windows Hello, on the PC') : "That button isn't there any more", 'bad');
      return;
    }
    try {
      await this.hooks.act(s.id, action, arg);
    } catch (err) {
      this.native.log(`phone: ${action} failed: ${String(err)}`);
      // Said for the phone ("Couldn't start Claude: …"): it flashes there.
      if (err instanceof PhoneError) this.toast(s, err.message, 'bad');
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

  /** Control Center arranged on the phone: saved only if it names exactly the tiles it was shown. */
  private gridSet(s: Session, l: PhoneLayout): void {
    if (!gridSetAllowed(s.gridKeys, l)) {
      this.native.log(`phone: refused a layout from ${s.name}`);
      this.toast(s, 'Control Center changed meanwhile; try again', 'bad');
      return;
    }
    this.hooks.setGrid(l);
    this.toast(s, 'Control Center saved', 'good');
  }

  /** Sleep: said first, since the link drops with the PC. Waking it takes the PC itself. */
  private async sleep(s: Session): Promise<void> {
    this.toast(s, 'Going to sleep', 'good');
    await this.native.sleep();
  }

  /** A file from a phone, saved to Downloads by Rust (which told the phone): the island shows it. */
  private onFile(e: RemoteFile | null): void {
    if (!e || typeof e.phone !== 'string' || typeof e.path !== 'string' || !e.path) return;
    const from = this.sessions.get(e.phone)?.name ?? this.phones.find((p) => p.id === e.phone)?.name ?? 'Your phone';
    const name = typeof e.name === 'string' && e.name ? e.name : (e.path.split(/[\\/]/).pop() ?? e.path);
    this.hooks.fromPhone({ kind: 'file', phone: e.phone, from, id: String(e.id ?? ''), name, path: e.path, size: Number(e.size) || 0, mime: String(e.mime ?? ''), copied: e.copied === true });
  }
}
