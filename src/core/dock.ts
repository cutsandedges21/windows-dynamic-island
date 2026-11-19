// The taskbar (Settings › Taskbar): a pill along the bottom of the screen in the island's own glass.
// Start, then your apps (the Apps tile's list first, then whatever else has a window open; a dot
// under the ones running, a longer one under the one in front), then what is playing and the
// timer, then the battery, Wi-Fi and sound, the clock and the notification bell. Each can be taken
// off (Settings › Widgets › Show on the taskbar, or the taskbar's right-click menu).
//
// The island owns it, as it owns desktop widgets: DockHost reads the windows and the activities
// and sends the dock window (src-tauri/src/dock.rs) one frame when anything changes; a click in
// the dock comes back as `dock-act` and the island does it.

import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { duration } from './format';
import { applyGlass } from './glass';
import { isTauri, native, on, sendTo, type DockIconRect, type InstalledApp, type LiveWindow } from './native';
import { DOCK_ITEMS, DOCK_SIDES, DOCK_SIZES, DOCK_STYLES, type DockItem, type DockSide, type DockSize, type DockStyle, type NameStyle, type PillColor } from './settings';

/** One app on the dock. */
export interface DockApp {
  /** Its program's path (lower case), or a Store app's shell name. */
  key: string;
  name: string;
  icon: string | null;
  /** Its windows, front first. */
  windows: number[];
  /** Each window's title, as `windows` (for the previews over its icon). */
  titles?: string[];
  /** Its window is the one in front. */
  front: boolean;
  /** On the Apps tile's list (stays when closed). */
  pinned: boolean;
}

export interface DockFrame {
  apps: DockApp[];
  music: { title: string; artist: string; playing: boolean; art: string | null } | null;
  timer: string | null;
  /** Claude's limits used, whole percents: the session (5 hours) and the week, and when each
   *  resets (ms since 1970; null: not started). */
  claude: { session: number | null; week: number | null; sessionReset?: number | null; weekReset?: number | null } | null;
  /** The Apps card, while it is open over the taskbar (the arrow at its start). */
  card?: DockCard | null;
  /** This PC's battery; null on a desktop. */
  battery: { percent: number; charging: boolean } | null;
  muted: boolean;
  wifi: boolean | null;
  /** What the user took off the taskbar. */
  hidden: DockItem[];
  accent: string;
  color: PillColor;
  glass?: number;
  /** Dragging it is off (right-click › Lock in place). */
  locked: boolean;
  size: DockSize;
  /** Rise, Spotlight, Glide, Names: the ones on (Settings › Taskbar › Styles). */
  styles?: DockStyle[];
  /** How the names over the bar look (style Names): font, bubble/plain/outline, bold. */
  names?: NameStyle;
  /** On the screen's bottom edge, over Windows' taskbar ... */
  edge?: boolean;
  /** ... its ends curving out into the edge. */
  melt?: boolean;
  /** The screen edge it sits along (bottom unless set). */
  side?: DockSide;
  /** Auto-hide is on (for the right-click menu's tick). */
  autoHide?: boolean;
  /** The screen border's width (CSS px) while it is on (Settings › Widgets › Screen border): the bar's
   *  melted feet flatten onto it. 0 or unset: no border. */
  border?: number;
  /** On the top edge with the island there: the island's width (CSS px), the gap the bar leaves in its
   *  middle for it. Unset: no gap. */
  gap?: number | null;
}

/** The Apps card over the taskbar: the same list as Control Center's Apps (Apps activity). */
export interface DockCard {
  apps: Array<{ name: string; target: string; icon: string | null }>;
  editing: boolean;
  query: string;
  /** Start's apps matching the query, while editing. */
  found: Array<{ name: string; target: string }>;
  /** "Opening Photos", or why it couldn't. */
  note: string | null;
  bad: boolean;
  /** Start's list is still being read. */
  reading: boolean;
  /** The Apps activity is off: nothing to show. */
  off?: boolean;
}

/** What the taskbar's right-click menu changes. */
export interface DockPref {
  locked?: boolean;
  /** Back to the middle. */
  centre?: boolean;
  /** Show or hide one of its items. */
  toggle?: DockItem;
  size?: DockSize;
  /** Turns one style on or off. */
  style?: DockStyle;
  edge?: boolean;
  melt?: boolean;
  side?: DockSide;
  autoHide?: boolean;
}

/** Each item's name, for the right-click menu and Settings. */
export const DOCK_LABELS: Record<DockItem, string> = {
  arrow: 'Apps arrow',
  apps: 'Apps',
  music: 'Now playing',
  timer: 'Timer',
  claude: 'Claude usage',
  battery: 'Battery',
  wifi: 'Wi-Fi',
  sound: 'Sound',
  clock: 'Time and date',
  notifications: 'Notifications',
};

/** The taskbar's hidden items with `item` shown again, or hidden. */
export function toggleDockItem(hidden: readonly DockItem[], item: DockItem): DockItem[] {
  const off = new Set(hidden);
  if (off.has(item)) off.delete(item);
  else off.add(item);
  return DOCK_ITEMS.filter((k) => off.has(k));
}

/** The battery's colour: green while charging, red when low, else the text's. */
export function batteryTone(b: { percent: number; charging: boolean }): 'low' | 'charging' | '' {
  if (b.charging) return 'charging';
  return b.percent <= 15 ? 'low' : '';
}

export type DockAct =
  | { kind: 'app'; key: string; rect?: DockIconRect }
  /** Right-click › Pin to taskbar / Unpin from taskbar. */
  | { kind: 'pin'; key: string; on: boolean }
  /** Right-click › Close: every window of the app. */
  | { kind: 'close'; key: string; rect?: DockIconRect }
  /** A window's preview over the icon: bring that one forward, or close it. */
  | { kind: 'window' | 'closewin'; key: string; hwnd: number; rect?: DockIconRect }
  /** Dragged to place `to` in the row (its index once dropped). */
  | { kind: 'move'; key: string; to: number }
  | { kind: 'start' | 'quick' | 'notifications' | 'music' | 'timer' | 'claude' }
  /** Now playing's buttons beside the song: the next one, or back to the one before. */
  | { kind: 'skip'; dir: 'next' | 'prev' }
  /** The arrow opened or closed the Apps card. */
  | { kind: 'card'; open: boolean }
  /** One of the Apps card's actions (the Apps activity's: open, edit, find, add, remove). */
  | { kind: 'apps'; name: string; arg?: string };

/** Apps on the dock, at most. */
export const DOCK_MAX = 14;
/** Programs whose windows never get a place (Island's own, the shell's). */
const SKIP = /\\(island|explorer|applicationframehost|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|systemsettings)\.exe$/i;

const keyOf = (path: string) => path.toLowerCase();
/** What a window belongs to: its web app (YouTube Music), else its program (so not "Chrome"). */
export const targetOf = (w: LiveWindow) => (w.appId ? 'shell:AppsFolder\\' + w.appId : w.exe);
const nameOf = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.exe$/i, '');

/**
 * The dock's apps: the pinned ones in their order (with their windows), then every other program
 * with a window, each keeping its place: in `seen`'s order (the order they opened in), new ones at
 * the end. `front` is the window in front now.
 */
export function dockApps(pinned: readonly InstalledApp[], windows: readonly LiveWindow[], front: number, icons: ReadonlyMap<string, string | null>, seen: readonly string[] = []): DockApp[] {
  const byExe = new Map<string, LiveWindow[]>();
  for (const w of windows) {
    if (!w.exe || SKIP.test(w.exe)) continue;
    const k = keyOf(targetOf(w));
    const list = byExe.get(k);
    if (list) list.push(w);
    else byExe.set(k, [w]);
  }
  const app = (key: string, name: string, pin: boolean): DockApp => {
    const wins = byExe.get(key) ?? [];
    byExe.delete(key);
    return { key, name, icon: icons.get(key) ?? null, windows: wins.map((w) => w.hwnd), titles: wins.map((w) => w.title), front: wins.some((w) => w.hwnd === front), pinned: pin };
  };
  const out = pinned.map((p) => app(keyOf(p.target), p.name, true));
  const rank = (key: string) => {
    const i = seen.indexOf(key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rest = [...byExe].sort((a, b) => rank(a[0]) - rank(b[0]));
  // A Store app by Start's name for it (Calculator, not CalculatorApp), a web app by its title.
  for (const [key, wins] of rest) out.push(app(key, wins[0].appName || (wins[0].appId ? wins[0].title : nameOf(wins[0].exe)), false));
  return out.slice(0, DOCK_MAX);
}

/** The programs with a window, in the order they opened: `seen` plus newly opened ones, less closed ones. */
export function openOrder(seen: readonly string[], windows: readonly LiveWindow[]): string[] {
  const open: string[] = [];
  for (const w of windows) {
    if (!w.exe || SKIP.test(w.exe)) continue;
    const k = keyOf(targetOf(w));
    if (!open.includes(k)) open.push(k);
  }
  return [...seen.filter((k) => open.includes(k)), ...open.filter((k) => !seen.includes(k))];
}

/**
 * What a click on an app does: nothing open → launch it; its window in front → minimize that one
 * into the icon; else bring its first window forward (out of the icon if it was minimized).
 */
export function clickPlan(app: DockApp): { do: 'launch' } | { do: 'minimize' | 'raise'; hwnd: number } {
  if (!app.windows.length) return { do: 'launch' };
  return { do: app.front ? 'minimize' : 'raise', hwnd: app.windows[0] };
}

/** The pinned list with `app` pinned (at the end) or unpinned; null when nothing changes. */
export function pinToggle(pins: readonly InstalledApp[], app: Pick<DockApp, 'key' | 'name'>, on: boolean): InstalledApp[] | null {
  const has = pins.some((p) => keyOf(p.target) === app.key);
  if (on === has) return null;
  return on ? [...pins, { name: app.name, target: app.key }] : pins.filter((p) => keyOf(p.target) !== app.key);
}

/**
 * The pinned list after `key` was dragged to place `to` in the row `apps`. A pinned app moves among
 * the pins; an open app dropped among them (or right after the last) gets pinned there; one
 * dropped among the other open apps changes nothing (they follow the order they were used in).
 * Null when nothing changes.
 */
export function movePins(pins: readonly InstalledApp[], apps: readonly DockApp[], key: string, to: number): InstalledApp[] | null {
  const dragged = apps.find((a) => a.key === key);
  if (!dragged) return null;
  const row = apps.filter((a) => a.key !== key);
  const at = Math.max(0, Math.min(row.length, Math.round(to)));
  row.splice(at, 0, dragged);
  const pinnedBefore = row.slice(0, at).filter((a) => a.pinned).length;
  if (!dragged.pinned && pinnedBefore < at) return null;
  const byKey = new Map(pins.map((p) => [keyOf(p.target), p] as const));
  const next = row.filter((a) => a.pinned || a.key === key).map((a) => byKey.get(a.key) ?? { name: a.name, target: a.key });
  // Pins whose program isn't on the dock right now (more than DOCK_MAX) keep their place at the end.
  for (const p of pins) if (!next.some((n) => keyOf(n.target) === keyOf(p.target))) next.push(p);
  const same = next.length === pins.length && next.every((n, i) => keyOf(n.target) === keyOf(pins[i].target));
  return same ? null : next;
}

// ------------------------------------------------------------------ the island's side

export interface DockHooks {
  pinned(): InstalledApp[];
  /** The pinned list changed on the taskbar (pinned, unpinned, moved). */
  setPinned(apps: InstalledApp[]): void;
  music(): DockFrame['music'];
  timer(): string | null;
  claude(): DockFrame['claude'];
  /** The Apps card's content (from the Apps activity). */
  appsCard(): DockCard;
  /** One of the Apps activity's actions, from the card. */
  appsAct(name: string, arg?: string): Promise<void> | void;
  battery(): DockFrame['battery'];
  muted(): boolean;
  wifi(): boolean | null;
  hidden(): DockItem[];
  setHidden(items: DockItem[]): void;
  look(): { accent: string; color: PillColor; glass?: number };
  /** One of an activity's actions (`act:music:toggle`). */
  act(action: string): void;
  /** Opens the island, on activity `id` when given (the timer: its time is there). */
  open(id?: string): void;
  /** Where the taskbar was dragged to, 0..1 across the screen (-1: the middle). */
  centre(): number;
  saveCentre(centre: number): void;
  locked(): boolean;
  setLocked(on: boolean): void;
  size(): DockSize;
  setSize(size: DockSize): void;
  styles(): DockStyle[];
  setStyles(styles: DockStyle[]): void;
  /** How the names over the bar look. */
  names(): NameStyle;
  edge(): boolean;
  setEdge(on: boolean): void;
  melt(): boolean;
  setMelt(on: boolean): void;
  /** Auto-hide: faint on its edge until pointed at. */
  autoHide(): boolean;
  setAutoHide(on: boolean): void;
  side(): DockSide;
  setSide(side: DockSide): void;
  /** The screen border's width while it is on, else 0. */
  border(): number;
  /** The gap for the island on the top edge (its pill's width), or null. */
  gap(): number | null;
}

export class DockHost {
  private apps: DockApp[] = [];
  /** Programs with a window, in the order they opened (their places on the dock). */
  private seen: string[] = [];
  private readonly icons = new Map<string, string | null>();
  private sent = '';
  private shown = false;
  private busy = false;
  /** The Apps card is open over the taskbar. */
  private cardOpen = false;
  private again = false;
  /** On the bottom edge, as last told to the dock's window. */
  private edgeSent: boolean | undefined;
  /** The side last told to the dock's window. */
  private sideSent: DockSide | undefined;
  /** Auto-hide, as last told to the dock's window. */
  private autoSent: boolean | undefined;
  private offs: Array<() => void> = [];

  constructor(
    private readonly hooks: DockHooks,
    private readonly enabled: () => boolean,
  ) {}

  async start(): Promise<void> {
    this.offs.push(
      await on<DockAct>('dock-act', (a) => void this.act(a)),
      await on<null>('dock-ready', () => {
        this.sent = '';
        void this.tick();
      }),
      await on<DockPref>('dock-pref', (p) => {
        if (typeof p?.locked === 'boolean') this.hooks.setLocked(p.locked);
        if (typeof p?.size === 'string' && (DOCK_SIZES as readonly string[]).includes(p.size)) this.hooks.setSize(p.size);
        if (typeof p?.style === 'string' && (DOCK_STYLES as readonly string[]).includes(p.style)) this.hooks.setStyles(toggleStyle(this.hooks.styles(), p.style));
        if (typeof p?.edge === 'boolean') this.hooks.setEdge(p.edge);
        if (typeof p?.melt === 'boolean') this.hooks.setMelt(p.melt);
        if (typeof p?.autoHide === 'boolean') this.hooks.setAutoHide(p.autoHide);
        if (typeof p?.side === 'string' && (DOCK_SIDES as readonly string[]).includes(p.side)) this.hooks.setSide(p.side);
        if (typeof p?.toggle === 'string' && (DOCK_ITEMS as readonly string[]).includes(p.toggle)) this.hooks.setHidden(toggleDockItem(this.hooks.hidden(), p.toggle));
        if (p?.centre === true) void native.dockAt(-1, true);
        void this.tick();
      }),
      await on<{ centre: number }>('dock-moved', (m) => {
        if (typeof m?.centre === 'number' && Number.isFinite(m.centre)) this.hooks.saveCentre(m.centre < 0 ? -1 : Math.min(1, m.centre));
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.shown) void native.dockShow(false, 0, 0);
  }

  /** Once a second: the dock open or closed as Settings says, and its frame when it changed. */
  async tick(): Promise<void> {
    if (!this.enabled()) {
      if (this.shown) void native.dockShow(false, 0, 0);
      this.shown = false;
      return;
    }
    if (this.busy) {
      // A card action while a frame is being made: make another right after.
      this.again = true;
      return;
    }
    this.busy = true;
    this.again = false;
    try {
      if (!this.shown) {
        this.shown = true;
        this.edgeSent = undefined;
        this.sideSent = undefined;
        this.autoSent = undefined;
        void native.dockShow(true, 640, 60, this.hooks.centre());
      }
      const [wins, front] = await Promise.all([native.wsWindows(), native.foreground()]);
      const live = wins.ok ? wins.value : [];
      const pinned = this.hooks.pinned();
      const want = [...new Set([...pinned.map((p) => p.target), ...live.filter((w) => w.exe).map(targetOf)])].filter((t) => !this.icons.has(keyOf(t)));
      if (want.length) {
        for (const t of want) this.icons.set(keyOf(t), null);
        const got = await native.appsIcons(want, 48);
        want.forEach((t, i) => this.icons.set(keyOf(t), got[i] ?? null));
      }
      this.seen = openOrder(this.seen, live);
      this.apps = dockApps(pinned, live, front, this.icons, this.seen);
      const frame: DockFrame = {
        apps: this.apps,
        music: this.hooks.music(),
        timer: this.hooks.timer(),
        claude: this.hooks.claude(),
        card: this.cardOpen ? this.hooks.appsCard() : null,
        battery: this.hooks.battery(),
        muted: this.hooks.muted(),
        wifi: this.hooks.wifi(),
        hidden: this.hooks.hidden(),
        ...this.hooks.look(),
        locked: this.hooks.locked(),
        size: this.hooks.size(),
        styles: this.hooks.styles(),
        names: this.hooks.names(),
        edge: this.hooks.edge(),
        melt: this.hooks.melt(),
        side: this.hooks.side(),
        autoHide: this.hooks.autoHide(),
        border: this.hooks.border(),
        gap: this.hooks.gap(),
      };
      if (frame.side !== this.sideSent) {
        this.sideSent = frame.side;
        void native.dockSide(frame.side ?? 'bottom');
      }
      const auto = this.hooks.autoHide();
      if (auto !== this.autoSent) {
        this.autoSent = auto;
        void native.dockAuto(auto);
      }
      if (frame.edge !== this.edgeSent) {
        this.edgeSent = frame.edge;
        void native.dockEdge(frame.edge === true);
      }
      const json = JSON.stringify(frame);
      if (json !== this.sent) {
        this.sent = json;
        void sendTo('dock', 'dock-frame', frame);
      }
    } finally {
      this.busy = false;
    }
    if (this.again) void this.tick();
  }

  private async act(a: DockAct): Promise<void> {
    if (!a || typeof a !== 'object') return;
    if (a.kind === 'start' || a.kind === 'quick' || a.kind === 'notifications') {
      void native.dockPanel(a.kind);
      return;
    }
    if (a.kind === 'card') {
      this.cardOpen = a.open === true;
      return this.tick();
    }
    if (a.kind === 'apps') {
      if (typeof a.name !== 'string') return;
      await this.hooks.appsAct(a.name, typeof a.arg === 'string' ? a.arg : undefined);
      return this.tick();
    }
    if (a.kind === 'music') return this.hooks.act('act:music:toggle');
    if (a.kind === 'skip') return this.hooks.act(a.dir === 'prev' ? 'act:music:prev' : 'act:music:next');
    if (a.kind === 'timer') return this.hooks.open('timer');
    if (a.kind === 'claude') return this.hooks.open('claude');
    if (typeof (a as { key?: unknown }).key !== 'string') return;
    const app = this.apps.find((x) => x.key === (a as { key: string }).key);
    if (!app) return;
    const rect = 'rect' in a && validRect(a.rect) ? a.rect : null;
    if (a.kind === 'pin') {
      const next = pinToggle(this.hooks.pinned(), app, a.on === true);
      if (next) this.hooks.setPinned(next);
    } else if (a.kind === 'move') {
      const next = movePins(this.hooks.pinned(), this.apps, app.key, Number(a.to));
      if (next) this.hooks.setPinned(next);
    } else if (a.kind === 'close') {
      if (app.windows.length) void native.dockClose(app.windows, rect ?? [0, 0, 0, 0]);
    } else if (a.kind === 'window' || a.kind === 'closewin') {
      // Only one of its own windows.
      if (!app.windows.includes(a.hwnd)) return;
      if (a.kind === 'window') await native.dockRaise(a.hwnd, rect ?? [0, 0, 0, 0]);
      else void native.dockClose([a.hwnd], rect ?? [0, 0, 0, 0]);
    } else if (a.kind === 'app') {
      const plan = clickPlan(app);
      if (plan.do === 'launch') {
        const target = this.hooks.pinned().find((p) => keyOf(p.target) === app.key)?.target;
        if (target) await native.wsLaunch({ kind: 'app', path: target, args: '', cwd: '' }, '');
      } else if (plan.do === 'minimize') {
        void native.dockMinimize(plan.hwnd, rect ?? [0, 0, 0, 0]);
      } else {
        await native.dockRaise(plan.hwnd, rect ?? [0, 0, 0, 0]);
      }
    }
    setTimeout(() => void this.tick(), 400);
  }
}

const validRect = (r: unknown): r is DockIconRect => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number' && Number.isFinite(n));

// ------------------------------------------------------------------ the dock window

const SVG = {
  up: '<svg viewBox="0 0 24 24" class="line"><path d="M6.5 14.5 12 9l5.5 5.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" class="line"><path d="M12 6v12M6 12h12"/></svg>',
  x: '<svg viewBox="0 0 24 24" class="line"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  go: '<svg viewBox="0 0 24 24" class="line"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  timer: '<svg viewBox="0 0 24 24" class="line"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2.5h4"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" class="line"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r="1" class="dot"/></svg>',
  wifiOff: '<svg viewBox="0 0 24 24" class="line"><path d="M8.5 16a5 5 0 0 1 7 0M3 3l18 18"/><circle cx="12" cy="19.2" r="1" class="dot"/></svg>',
  sound: '<svg viewBox="0 0 24 24" class="line"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24" class="line"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" class="line"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  app: '<svg viewBox="0 0 24 24" class="line"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 5 13.5h5.5L10 22l8-11.5h-5.5z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 17.5a3 3 0 1 1-2-2.83V5l11-2v12.5a3 3 0 1 1-2-2.83V6.4l-7 1.3z"/></svg>',
  // As the island's own (icons.ts prev / next).
  prev: '<svg viewBox="0 0 24 24" class="line"><path d="M18 6l-9 6 9 6z" fill="currentColor"/><path d="M6 6v12" stroke-width="2.4"/></svg>',
  next: '<svg viewBox="0 0 24 24" class="line"><path d="M6 6l9 6-9 6z" fill="currentColor"/><path d="M18 6v12" stroke-width="2.4"/></svg>',
};

function el(tag: string, cls: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** The taskbar's right-click menu (Windows' own): what it shows, lock it in place, back to the middle, Settings › Widgets. */
async function dockMenu(f: DockFrame, pref: (p: DockPref) => void): Promise<void> {
  const show = await Submenu.new({
    text: 'Show on the taskbar',
    items: await Promise.all(DOCK_ITEMS.map((k) => CheckMenuItem.new({ text: DOCK_LABELS[k], checked: !(f.hidden ?? []).includes(k), action: () => pref({ toggle: k }) }))),
  });
  const sizes = await Submenu.new({
    text: 'Size',
    items: await Promise.all(DOCK_SIZES.map((k) => CheckMenuItem.new({ text: DOCK_SIZE_LABELS[k], checked: f.size === k, action: () => pref({ size: k }) }))),
  });
  const styles = await Submenu.new({
    text: 'Style',
    items: await Promise.all(DOCK_STYLES.map((k) => CheckMenuItem.new({ text: DOCK_STYLE_LABELS[k], checked: (f.styles ?? ['rise']).includes(k), action: () => pref({ style: k }) }))),
  });
  const sides = await Submenu.new({
    text: 'Position',
    items: await Promise.all(DOCK_SIDES.map((k) => CheckMenuItem.new({ text: k[0].toUpperCase() + k.slice(1), checked: (f.side ?? 'bottom') === k, action: () => pref({ side: k }) }))),
  });
  const side = f.side ?? 'bottom';
  const menu = await Menu.new({
    items: [
      show,
      sizes,
      styles,
      sides,
      await CheckMenuItem.new({ text: side === 'bottom' ? 'Blend into the bottom' : `Blend into the ${side} edge`, checked: f.edge === true, action: () => pref({ edge: !f.edge }) }),
      ...(f.edge ? [await CheckMenuItem.new({ text: 'Melt the ends', checked: f.melt === true, action: () => pref({ melt: !f.melt }) })] : []),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await CheckMenuItem.new({ text: 'Auto-hide', checked: f.autoHide === true, action: () => pref({ autoHide: !f.autoHide }) }),
      await CheckMenuItem.new({ text: 'Lock in place', checked: f.locked, action: () => pref({ locked: !f.locked }) }),
      await MenuItem.new({ text: 'Back to the middle', action: () => pref({ centre: true }) }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Taskbar settings…', action: () => void native.openApp('taskbar') }),
    ],
  });
  await menu.popup();
}

/** An app's right-click menu: Pin or Unpin, and Close its windows. */
async function appMenu(a: DockApp, act: (x: DockAct) => void, rect: () => DockIconRect): Promise<void> {
  const n = a.windows.length;
  const items = [
    await MenuItem.new({ text: a.name, enabled: false }),
    await PredefinedMenuItem.new({ item: 'Separator' }),
    await MenuItem.new({ text: a.pinned ? 'Unpin from taskbar' : 'Pin to taskbar', action: () => act({ kind: 'pin', key: a.key, on: !a.pinned }) }),
  ];
  if (n) items.push(await MenuItem.new({ text: n === 1 ? 'Close window' : `Close all ${n} windows`, action: () => act({ kind: 'close', key: a.key, rect: rect() }) }));
  const menu = await Menu.new({ items });
  await menu.popup();
}

/** How far from the pointer an icon still rises, CSS px. */
const RISE_REACH = 96;
/** An icon right under the pointer: this much bigger and this many CSS px higher. */
const RISE_GROW = 0.4;
const RISE_LIFT = 8;
/** Room above the bar for risen icons, CSS px. */
const HEADROOM = 14;
/** Rise along a bar across the screen also makes room (Moss, 11-19, "like Windhawk's"): an icon right
 *  under the pointer grows this much and its place this much wider, pushing its neighbours apart. */
const RISE_GROW_SPREAD = 0.6;
const RISE_SPREAD = 0.55;
/** An app's place on the bar and the gap between places, CSS px (island.css .dk-app, .dk-apps). */
const APP_W = 40;
const APP_GAP = 2;
/** Room the window keeps at each end for the bar to widen into while it spreads (CSS px before its
 *  size's zoom): the window never resizes under the pointer. */
const RISE_ROOM = 36;

export const DOCK_SIZE_LABELS: Record<DockSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
export const DOCK_STYLE_LABELS: Record<DockStyle, string> = { rise: 'Rise', spotlight: 'Spotlight', glide: 'Glide', names: 'Names' };

/** The taskbar's styles with `style` turned on, or off. */
export function toggleStyle(on: readonly DockStyle[], style: DockStyle): DockStyle[] {
  const set = new Set(on);
  if (set.has(style)) set.delete(style);
  else set.add(style);
  return DOCK_STYLES.filter((k) => set.has(k));
}

/**
 * Which app the spotlight is on: the app in front; while none is (Alt+Tab, the desktop, Island's own
 * windows), still the one it was on, as long as that one is open.
 */
export function spotlightOn(apps: readonly Pick<DockApp, 'key' | 'front' | 'windows'>[], was: string | null): string | null {
  const front = apps.find((a) => a.front);
  if (front) return front.key;
  return was && apps.some((a) => a.key === was && a.windows.length > 0) ? was : null;
}

/** Each size's scale; Medium is the size the taskbar was first built at. */
export const DOCK_ZOOM: Record<DockSize, number> = { small: 0.84, medium: 1, large: 1.18 };

/** The Claude item's text: `S: 42% | W: 18%`, a part left out while it isn't known. */
export function claudeUsageText(c: { session: number | null; week: number | null }): string {
  const parts: string[] = [];
  if (c.session != null) parts.push(`S: ${Math.round(c.session)}%`);
  if (c.week != null) parts.push(`W: ${Math.round(c.week)}%`);
  return parts.join(' | ');
}

/** A limit's reset for the hover card over S/W: "in 2h 10m · 4:15 PM", "Tue 4:00 AM". */
export function resetLine(at: number | null | undefined, now: number, week: boolean): string {
  if (at == null || !Number.isFinite(at)) return 'Starts with your next message';
  if (at <= now) return 'Resetting now';
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!week) return `in ${duration(at - now)} · ${time}`;
  const day = d.toDateString() === new Date(now).toDateString() ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${day} ${time} · in ${duration(at - now)}`;
}

/**
 * The hover rise, as on a Mac: how much an icon `d` CSS px from the pointer rises and grows (0..1),
 * falling off smoothly over about two icons each side.
 */
export function riseAt(d: number): number {
  const r = Math.abs(d) / RISE_REACH;
  return r >= 1 ? 0 : (Math.cos(r * Math.PI) + 1) / 2;
}

/** The Apps card's width at most (CSS px); never wider than the bar. */
const CARD_W = 380;
/** Room over the bar for a card (the Apps card at its tallest), CSS px. The window always has it, so
 *  nothing resizes (and flickers) when a card comes up; clicks there go through unless a card is up. */
const ROOM = 480;
/** Melt the ends (Blend into the bottom › Melt the ends): each end of the bar curves out into the
 *  screen's edge this far beside the bar (`out`), from this far up its side (`up`), CSS px at the
 *  medium size. `up` reaches the top corner (BAR_H - BAR_R), so each side is one S-curve. */
export const MELT = { out: 72, up: 34 };
/** The bar's height and its top corners along the edge, CSS px (.dock, html.dock-edge .dock). */
const BAR_H = 52;
const BAR_R = 18;

/** One end of the melted bar as the CSS masks that cut it, `width` wide and the bar's height. */
export interface MeltEnd {
  width: number;
  /** The shape: the foot, the bar's side and its top corner. */
  fill: string;
  /** Its outline, the bar's rim carried down the foot to the screen's edge. */
  rim: string;
}

/**
 * The melted ends (Melt the ends), left and right. Each foot is a quarter ellipse from the screen's
 * edge (flat where it meets it) up to the bar's side (upright there), so it flows into the side and
 * the top corner without a kink. The rim is stroked 2px on that outline; the shape keeps the inner
 * 1px, like the bar's own rim. The right end is the left one mirrored.
 */
export function meltEnds(out: number, up: number, border = 0, side: DockSide = 'bottom', h = BAR_H, r = BAR_R): { left: MeltEnd; right: MeltEnd } {
  const u = Math.min(up, h - r);
  const w = out + r;
  // With the screen border on, each foot flattens onto the border's inner edge (`b` up from the
  // screen's edge) instead of the edge itself, so the foot and the border are one line.
  const b = Math.max(0, Math.min(border, u - 2));
  const left = `M0 ${h - b}A${out} ${u - b} 0 0 0 ${out} ${h - u}L${out} ${r}A${r} ${r} 0 0 1 ${w} 0`;
  const right = `M${w} ${h - b}A${out} ${u - b} 0 0 1 ${r} ${h - u}L${r} ${r}A${r} ${r} 0 0 0 0 0`;
  // Drawn as along the bottom, then turned to the bar's side: the edge is where the bottom was.
  const across = side === 'bottom' || side === 'top';
  const [vw, vh] = across ? [w, h] : [h, w];
  const turn = { bottom: '', top: `matrix(1 0 0 -1 0 ${h})`, left: `matrix(0 1 -1 0 ${h} 0)`, right: 'matrix(0 1 1 0 0 0)' }[side];
  const url = (path: string) =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${vw}' height='${vh}' viewBox='0 0 ${vw} ${vh}' preserveAspectRatio='none'>${turn ? `<g transform='${turn}'>${path}</g>` : path}</svg>`)}")`;
  const end = (outline: string, close: string): MeltEnd => ({
    width: w,
    fill: url(`<path d='${outline}${close}Z'/>`),
    rim: url(`<path d='${outline}' fill='none' stroke='#000' stroke-width='2'/>`),
  });
  // Under a foot that stops short of the edge, the border's own strip.
  return { left: end(left, `L${w} ${h}${b ? `L0 ${h}` : ''}`), right: end(right, `L0 ${h}${b ? `L${w} ${h}` : ''}`) };
}

/**
 * The CSS masks that cut the melted bar on side `side`: `fill` its shape (both feet and the middle),
 * `rim` its outline (both feet's curves and the inner edge between them). `border`: the screen
 * border's width in the bar's own px (0: none).
 */
export function meltMasks(side: DockSide, out: number, up: number, border = 0, h = BAR_H, r = BAR_R): { end: number; fill: string; rim: string } {
  const e = meltEnds(out, up, border, side, h, r);
  const end = e.left.width;
  const across = side === 'bottom' || side === 'top';
  // Where the bar's two ends are, and its inner edge (away from the screen's edge).
  const [a, z] = across ? [`left ${side}`, `right ${side}`] : [`${side} top`, `${side} bottom`];
  const size = across ? `${end}px 100%` : `100% ${end}px`;
  const middle = across ? `calc(100% - ${2 * end - 4}px) calc(100% + 4px)` : `calc(100% + 4px) calc(100% - ${2 * end - 4}px)`;
  const inner = { bottom: 'center top', top: 'center bottom', left: 'right center', right: 'left center' }[side];
  const line = across ? `calc(100% - ${2 * end - 4}px) 1px` : `1px calc(100% - ${2 * end - 4}px)`;
  return {
    end,
    fill: `${e.left.fill} ${a} / ${size} no-repeat, ${e.right.fill} ${z} / ${size} no-repeat, linear-gradient(#000 0 0) center / ${middle} no-repeat`,
    rim: `${e.left.rim} ${a} / ${size} no-repeat, ${e.right.rim} ${z} / ${size} no-repeat, linear-gradient(#000 0 0) ${inner} / ${line} no-repeat`,
  };
}
/** Room each side of the island in the top bar's gap, CSS px. */
const GAP_PAD = 10;
/** Between the bar and a card over it, CSS px. */
const POP_GAP = 8;
/** A card's slide down behind the bar, ms (as in the CSS). */
const POP_MS = 240;
/** Pointing at S/W this long shows when they reset, ms. */
const TIP_DELAY_MS = 250;
/** The pointer resting on an app this long (still) shows its windows' previews, ms (Moss, 11-18: "only
 *  show the previews after a delay, not instant"). */
export const PEEK_REST_MS = 500;
/** The pointer moving less than this (CSS px) from where it came to rest still counts as resting. */
export const PEEK_STILL_PX = 6;
/** Previews already up: resting on the next app shows its own after this, ms. */
export const PEEK_SWITCH_MS = 90;

/**
 * Whether the pointer has rested on an app long enough for its previews: each move further than
 * PEEK_STILL_PX from where it came to rest starts the wait again, so sweeping across the icons shows
 * none. `due` is when the wait ends (on the clock `move` is given), null while there is none.
 */
export class PeekRest {
  private x = 0;
  private y = 0;
  due: number | null = null;
  /** The pointer is at (x, y) at `now`; `quick`: previews are up already. The new due time when the
   *  wait (re)started, else null (still resting, the wait goes on). */
  move(x: number, y: number, now: number, quick: boolean): number | null {
    if (this.due !== null && Math.hypot(x - this.x, y - this.y) < PEEK_STILL_PX) return null;
    this.x = x;
    this.y = y;
    this.due = now + (quick ? PEEK_SWITCH_MS : PEEK_REST_MS);
    return this.due;
  }
  stop(): void {
    this.due = null;
  }
}

/** A drag along the bottom starts once the pointer has moved this far (CSS px); a shorter press is a click. */
const DRAG_PX = 5;

/**
 * This window is the dock: it draws what the island sends (keeping its elements, so a click
 * never lands on one that was just replaced), fits its window to its content, and moves along
 * the bottom when dragged by anything but a button. A double-click there puts it back in the
 * middle.
 */
export async function runDock(stage: HTMLElement): Promise<void> {
  document.documentElement.classList.add('dock-window');
  document.documentElement.style.setProperty('--dk-melt-out', `${MELT.out}px`);
  /** The melted ends' masks last written (side, border), so they're made again only when those change. */
  let meltSig = '';
  const bar = el('div', 'dock');
  bar.append(el('i', 'dock-bg'));
  stage.append(bar);
  const send = (a: DockAct) => void sendTo('island', 'dock-act', a);
  /** A style is on (Rise, Spotlight, Glide; any together). */
  const has = (k: DockStyle) => (frame?.styles ?? ['rise']).includes(k);
  let frame: DockFrame | null = null;
  let lastSize = '';
  /** The edge it sits along, and whether the bar stands upright (on the left or right). */
  const side = (): DockSide => frame?.side ?? 'bottom';
  const upright = () => side() === 'left' || side() === 'right';
  /** Along the bar: x across the screen, y on a side. */
  const along = (e: { clientX: number; clientY: number }) => (upright() ? e.clientY : e.clientX);
  const alongOf = (r: DOMRect) => (upright() ? r.top + r.height / 2 : r.left + r.width / 2);
  /** Away from the screen's edge by `px`, as a CSS translate. */
  const outward = (px: number) => ({ bottom: `translateY(${-px}px)`, top: `translateY(${px}px)`, left: `translateX(${px}px)`, right: `translateX(${-px}px)` })[side()];
  /** Along the bar by `px`, as a CSS translate. */
  const slide = (px: number) => (upright() ? `translateY(${px}px)` : `translateX(${px}px)`);

  // The arrow at the start: the Apps card (Control Center's Apps) comes up over the bar.
  const start = el('button', 'dk-btn dk-start', SVG.up);
  start.title = 'Your apps';
  start.addEventListener('click', () => setCard(!cardOn));
  const appsBox = el('div', 'dk-apps');
  // On the top edge with the island there: room in the bar's middle for it (the bar runs on behind).
  const gapEl = el('i', 'dk-gap');
  gapEl.hidden = true;
  const sepA = el('i', 'dk-sep');
  // What is playing: its cover (play/pause over it when pointed at or paused), the title over the
  // artist, the size of the clock's time over its date.
  const music = el('button', 'dk-music');
  const musicCover = el('span', 'dk-cover');
  const musicArt = document.createElement('img');
  musicArt.alt = '';
  musicArt.draggable = false;
  const musicNote = el('span', 'dk-note', SVG.note);
  const musicPP = el('span', 'dk-pp');
  musicCover.append(musicArt, musicNote, musicPP);
  const musicTitle = el('b', '');
  const musicArtist = el('span', '');
  const musicText = el('span', 'dk-mtext');
  musicText.append(musicTitle, musicArtist);
  music.append(musicCover, musicText);
  music.addEventListener('click', () => send({ kind: 'music' }));
  // Either side of the song: back to the one before, on to the next.
  const musicPrev = el('button', 'dk-btn dk-skip dk-prev', SVG.prev);
  musicPrev.title = 'Previous';
  musicPrev.addEventListener('click', () => send({ kind: 'skip', dir: 'prev' }));
  const musicNext = el('button', 'dk-btn dk-skip dk-next', SVG.next);
  musicNext.title = 'Next';
  musicNext.addEventListener('click', () => send({ kind: 'skip', dir: 'next' }));
  const timer = el('button', 'dk-timer', SVG.timer);
  const timerText = el('span', '');
  timer.append(timerText);
  timer.title = 'Timer';
  timer.addEventListener('click', () => send({ kind: 'timer' }));
  const claude = el('button', 'dk-claude');
  const claudeText = el('span', '');
  claude.append(claudeText);
  claude.addEventListener('click', () => send({ kind: 'claude' }));
  const sepB = el('i', 'dk-sep');
  const battery = el('button', 'dk-batt');
  const battBody = el('i', 'dk-bbody');
  const battFill = el('i', 'dk-bfill');
  battBody.append(battFill, el('i', 'dk-bbolt', SVG.bolt));
  const battText = el('span', '');
  battery.append(battBody, battText);
  battery.addEventListener('click', () => send({ kind: 'quick' }));
  const wifi = el('button', 'dk-btn dk-wifi');
  wifi.title = 'Wi-Fi';
  wifi.addEventListener('click', () => send({ kind: 'quick' }));
  const sound = el('button', 'dk-btn dk-sound');
  sound.title = 'Sound';
  sound.addEventListener('click', () => send({ kind: 'quick' }));
  const clock = el('button', 'dk-clock');
  const clockTime = el('b', '');
  const clockDate = el('span', '');
  clock.append(clockTime, clockDate);
  clock.title = 'Notifications and calendar';
  clock.addEventListener('click', () => send({ kind: 'notifications' }));
  const bell = el('button', 'dk-btn dk-bell', SVG.bell);
  bell.title = 'Notifications';
  bell.addEventListener('click', () => send({ kind: 'notifications' }));
  bar.append(start, appsBox, gapEl, sepA, musicPrev, music, musicNext, timer, claude, sepB, battery, wifi, sound, clock, bell);

  // Over the bar, coming up from behind it: the Apps card (the arrow) and when S/W reset (pointing at them).
  const above = el('div', 'dk-above');
  stage.prepend(above);
  const card = el('div', 'dk-pop dk-card');
  const cardTitle = el('b', '');
  cardTitle.textContent = 'Apps';
  const cardSub = el('span', 'dk-card-sub');
  const cardText = el('div', 'dk-card-text');
  cardText.append(cardTitle, cardSub);
  const cardEdit = el('button', 'dk-card-edit');
  cardEdit.addEventListener('click', () => send({ kind: 'apps', name: 'edit' }));
  const cardHead = el('div', 'dk-card-head');
  cardHead.append(cardText, cardEdit);
  const cardGrid = el('div', 'dk-grid');
  const cardEmpty = el('div', 'dk-card-empty');
  cardEmpty.textContent = 'No apps here yet. Press Edit and add the ones you open most.';
  const find = document.createElement('input');
  find.className = 'dk-find';
  find.placeholder = 'Search your apps';
  find.spellcheck = false;
  const found = el('div', 'dk-found');
  card.append(cardHead, cardGrid, cardEmpty, find, found);
  const tip = el('div', 'dk-pop dk-tip');
  card.hidden = tip.hidden = true;
  above.append(card, tip);

  let cardOn = false;
  let wasEditing = false;
  let gridSig = '';
  let foundSig = '';
  const popTimers = new Map<HTMLElement, number>();
  /** `pop` comes up over the bar: the window grows first, then it slides up from behind the bar. */
  const showPop = (pop: HTMLElement) => {
    window.clearTimeout(popTimers.get(pop));
    if (!pop.hidden && pop.classList.contains('up')) return;
    pop.hidden = false;
    solid();
    // Laid out first (still down behind the bar), then it slides up.
    requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.add('up')));
  };
  /** `pop` slides back down behind the bar; then the window shrinks. */
  const hidePop = (pop: HTMLElement) => {
    if (pop.hidden) return;
    pop.classList.remove('up');
    window.clearTimeout(popTimers.get(pop));
    popTimers.set(
      pop,
      window.setTimeout(() => {
        pop.hidden = true;
        solid();
      }, POP_MS),
    );
  };
  const setCard = (on: boolean) => {
    if (on === cardOn) return;
    cardOn = on;
    start.classList.toggle('on', on);
    send({ kind: 'card', open: on });
    // The card's search field needs the keyboard: the taskbar can be the active window meanwhile.
    void native.dockTyping(on);
    if (on) {
      hidePop(tip);
      closePeek();
      // Type straight away: the search opens any app (MacDock's Launchpad search).
      requestAnimationFrame(() => requestAnimationFrame(() => find.focus()));
    } else {
      find.blur();
      if (find.value) {
        find.value = '';
        send({ kind: 'apps', name: 'find', arg: '' });
      }
      hidePop(card);
      // Closed while editing: the next open starts with the apps, not the search.
      if (wasEditing) send({ kind: 'apps', name: 'edit' });
      wasEditing = false;
    }
  };
  const drawCard = (c: DockCard) => {
    cardSub.textContent = c.off ? 'Turn Apps on in Activities to use this' : (c.note ?? (c.editing ? 'Take apps off, or add one below' : 'Open one, or press Edit to add apps'));
    cardSub.classList.toggle('bad', c.bad);
    cardEdit.hidden = Boolean(c.off);
    cardEdit.textContent = c.editing ? 'Done' : 'Edit';
    cardEdit.classList.toggle('primary', c.editing);
    const sig = JSON.stringify([c.editing, c.apps]);
    if (sig !== gridSig) {
      gridSig = sig;
      cardGrid.replaceChildren(
        ...c.apps.map((a) => {
          const t = el(c.editing ? 'div' : 'button', 'dk-tile');
          t.title = c.editing ? a.name : `Open ${a.name}`;
          const ico = el('span', 'dk-tile-ico', a.icon ? undefined : SVG.app);
          if (a.icon) {
            const img = document.createElement('img');
            img.src = a.icon;
            img.alt = '';
            img.draggable = false;
            ico.append(img);
          }
          const name = el('span', 'dk-tile-name');
          name.textContent = a.name;
          t.append(ico, name);
          if (c.editing) {
            const rm = el('button', 'dk-tile-rm', SVG.x);
            rm.title = `Take ${a.name} off`;
            rm.addEventListener('click', () => send({ kind: 'apps', name: 'remove', arg: a.target }));
            t.append(rm);
          } else {
            t.addEventListener('click', () => {
              send({ kind: 'apps', name: 'open', arg: a.target });
              setCard(false);
            });
          }
          return t;
        }),
      );
    }
    const typed = c.query.trim() !== '';
    // Searching: the results in place of the apps; editing: the add field under them.
    cardGrid.hidden = typed && !c.editing;
    cardEmpty.hidden = c.apps.length > 0 || c.editing || typed || Boolean(c.off);
    find.hidden = Boolean(c.off);
    find.placeholder = c.editing ? 'Add an app: type its name' : 'Search your apps';
    if (c.editing) card.insertBefore(find, found);
    else card.insertBefore(find, cardGrid);
    if (document.activeElement !== find && find.value !== c.query) find.value = c.query;
    if (c.editing !== wasEditing) requestAnimationFrame(() => find.focus());
    wasEditing = c.editing;
    const fsig = JSON.stringify([c.found, c.reading, typed, c.editing]);
    if (fsig !== foundSig) {
      foundSig = fsig;
      const rows = c.found.map((a) => {
        const r = el('button', 'dk-row', c.editing ? SVG.plus : SVG.go);
        const name = el('span', '');
        name.textContent = a.name;
        r.append(name);
        r.title = c.editing ? `Add ${a.name}` : `Open ${a.name}`;
        r.addEventListener('click', () => {
          find.value = '';
          if (c.editing) {
            send({ kind: 'apps', name: 'add', arg: a.target });
            find.focus();
          } else {
            send({ kind: 'apps', name: 'launch', arg: a.target });
            setCard(false);
          }
        });
        return r;
      });
      if (!rows.length && typed) {
        const none = el('div', 'dk-card-empty');
        none.textContent = c.reading ? 'Reading your apps…' : 'No app with that name in Start.';
        rows.push(none);
      }
      found.replaceChildren(...rows);
    }
    solid();
  };
  find.addEventListener('input', () => send({ kind: 'apps', name: 'find', arg: find.value }));
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') found.querySelector<HTMLElement>('.dk-row')?.click();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setCard(false);
  });
  // Clicking anywhere else (the taskbar took the keyboard, so it notices) closes the card.
  window.addEventListener('blur', () => setCard(false));

  // Pointing at S/W: when each resets.
  let tipHover = false;
  let tipWait = 0;
  const drawTip = () => {
    const c = frame?.claude;
    if (!c || !tipHover || cardOn || claude.hidden) return hidePop(tip);
    const now = Date.now();
    const rows: HTMLElement[] = [];
    const row = (label: string, pct: number | null, at: number | null | undefined, week: boolean) => {
      if (pct == null) return;
      const r = el('div', 'dk-tip-row');
      const l = el('b', '');
      l.textContent = `${label} ${Math.round(pct)}%`;
      const t = el('span', '');
      t.textContent = resetLine(at, now, week);
      r.append(l, t);
      rows.push(r);
    };
    row('Session', c.session, c.sessionReset, false);
    row('Week', c.week, c.weekReset, true);
    const head = el('span', 'dk-tip-head');
    head.textContent = 'Resets';
    tip.replaceChildren(head, ...rows);
    tip.hidden = false;
    const b = claude.getBoundingClientRect();
    if (upright()) {
      const h = tip.offsetHeight;
      tip.style.left = '';
      tip.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - h - 8, b.top + b.height / 2 - h / 2)))}px`;
    } else {
      const w = tip.offsetWidth;
      tip.style.top = '';
      tip.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, b.left + b.width / 2 - w / 2)))}px`;
    }
    showPop(tip);
  };
  claude.addEventListener('pointerenter', () => {
    tipHover = true;
    window.clearTimeout(tipWait);
    tipWait = window.setTimeout(drawTip, TIP_DELAY_MS);
  });
  claude.addEventListener('pointerleave', () => {
    tipHover = false;
    window.clearTimeout(tipWait);
    hidePop(tip);
  });

  const appEls = new Map<string, HTMLElement>();
  const appOf = (key: string) => frame?.apps.find((x) => x.key === key) ?? null;
  /** Where an app's icon is in this window (CSS px), for its window to fly out of or into. */
  const iconRect = (b: HTMLElement): DockIconRect => {
    const r = (b.querySelector('.dk-ico') ?? b).getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };

  // Pointing at an app with windows open: a live picture of each over its icon (MacDock's previews,
  // Moss). A click brings that window forward, the x closes it. DWM draws the pictures into this window
  // where the slots are (src-tauri/src/dockpeek.rs), once the card has slid up.
  const peek = el('div', 'dk-pop dk-peek');
  peek.hidden = true;
  above.append(peek);
  let peekKey: string | null = null;
  let peekSig = '';
  let peekWait = 0;
  let peekLeave = 0;
  let peekShots = 0;
  const clearShots = () => {
    window.clearTimeout(peekShots);
    void native.dockPeek([]);
  };
  const closePeek = () => {
    window.clearTimeout(peekWait);
    window.clearTimeout(peekLeave);
    if (peekKey === null && peek.hidden) return;
    peekKey = null;
    peekSig = '';
    clearShots();
    hidePop(peek);
  };
  /** The pictures into the slots, each a little inside its slot (its hover ring shows round it). */
  const sendShots = () => {
    if (peekKey === null || peek.hidden) return;
    const items = [...peek.querySelectorAll<HTMLElement>('.dk-pk-shot')].map((s) => {
      const r = s.getBoundingClientRect();
      return { hwnd: Number(s.dataset.hwnd), rect: [r.left + 4, r.top + 4, r.width - 8, r.height - 8] as DockIconRect };
    });
    void native.dockPeek(items);
  };
  const drawPeek = (b: HTMLElement) => {
    const a = appOf(b.dataset.key ?? '');
    if (!a || !a.windows.length || cardOn || move?.moved || b.hidden || b.classList.contains('dk-cut')) return closePeek();
    const up = upright();
    const sig = JSON.stringify([a.key, a.windows, a.titles, up]);
    const changed = sig !== peekSig;
    peekKey = a.key;
    if (changed) {
      peekSig = sig;
      const fits = up ? Math.max(1, Math.floor((window.innerHeight - 40) / (200 * 0.62 + 40))) : 4;
      const n = Math.min(a.windows.length, fits, 4);
      const w = up ? 200 : Math.round(Math.max(140, Math.min(220, (window.innerWidth - 40) / n - 8)));
      const slots: HTMLElement[] = a.windows.slice(0, n).map((hwnd, i) => {
        const slot = el('div', 'dk-pk');
        slot.style.width = `${w}px`;
        const title = el('span', 'dk-pk-title');
        title.textContent = a.titles?.[i] || a.name;
        const x = el('button', 'dk-pk-x', SVG.x);
        x.title = 'Close this window';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          send({ kind: 'closewin', key: a.key, hwnd, rect: iconRect(b) });
          closePeek();
        });
        const head = el('div', 'dk-pk-head');
        head.append(title, x);
        const shot = el('button', 'dk-pk-shot');
        shot.dataset.hwnd = String(hwnd);
        shot.title = title.textContent ?? '';
        shot.style.height = `${Math.round(w * 0.62)}px`;
        // Under the picture (a minimized window draws none): the app's icon.
        if (a.icon) {
          const img = document.createElement('img');
          img.src = a.icon;
          img.alt = '';
          img.draggable = false;
          shot.append(img);
        }
        shot.addEventListener('click', () => {
          send({ kind: 'window', key: a.key, hwnd, rect: iconRect(b) });
          closePeek();
        });
        slot.append(head, shot);
        return slot;
      });
      if (a.windows.length > n) {
        const more = el('span', 'dk-pk-more');
        more.textContent = `+${a.windows.length - n}`;
        slots.push(more);
      }
      peek.replaceChildren(...slots);
      peek.classList.toggle('stack', up);
    }
    peek.hidden = false;
    const r = b.getBoundingClientRect();
    if (up) {
      const h = peek.offsetHeight;
      peek.style.left = '';
      peek.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - h - 8, r.top + r.height / 2 - h / 2)))}px`;
    } else {
      const w = peek.offsetWidth;
      peek.style.top = '';
      peek.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`;
    }
    const wasUp = peek.classList.contains('up');
    showPop(peek);
    if (changed || !wasUp) {
      clearShots();
      peekShots = window.setTimeout(sendShots, wasUp ? 40 : POP_MS + 40);
    }
  };
  /** Pointing at an app: its previews once the pointer has rested there (PeekRest), not while it sweeps
   *  across the icons; quickly when another app's are up already. */
  const rest = new PeekRest();
  let restOn: HTMLElement | null = null;
  const peekRest = (b: HTMLElement, e: PointerEvent) => {
    // Its own previews are up already.
    if (peekKey === b.dataset.key && !peek.hidden) return;
    const due = rest.move(e.clientX, e.clientY, performance.now(), peekKey !== null);
    if (due === null) return;
    window.clearTimeout(peekWait);
    peekWait = window.setTimeout(
      () => {
        if (restOn === b) drawPeek(b);
      },
      Math.max(0, due - performance.now()),
    );
  };
  const peekEnter = (b: HTMLElement, e: PointerEvent) => {
    window.clearTimeout(peekLeave);
    window.clearTimeout(peekWait);
    rest.stop();
    restOn = b;
    peekRest(b, e);
  };
  const peekOut = () => {
    window.clearTimeout(peekWait);
    window.clearTimeout(peekLeave);
    rest.stop();
    restOn = null;
    peekLeave = window.setTimeout(closePeek, 280);
  };
  peek.addEventListener('pointerenter', () => window.clearTimeout(peekLeave));
  peek.addEventListener('pointerleave', peekOut);

  // Launching: the icon bounces until the app has a window (or a few seconds pass).
  const bounce = (b: HTMLElement) => {
    b.classList.add('launching');
    window.setTimeout(() => b.classList.remove('launching'), 4000);
  };

  // Dragging an icon along the row to a new place; the others make room.
  let move: { b: HTMLElement; id: number; x0: number; moved: boolean; slots: number[]; from: number; to: number } | null = null;
  let swallowClick = false;
  const wireApp = (b: HTMLElement) => {
    b.addEventListener('pointerenter', (e) => peekEnter(b, e));
    b.addEventListener('pointermove', (e) => {
      if (restOn === b) peekRest(b, e);
    });
    b.addEventListener('pointerleave', peekOut);
    b.addEventListener('click', () => {
      closePeek();
      if (swallowClick) return;
      const key = b.dataset.key!;
      const a = appOf(key);
      if (a && !a.windows.length) bounce(b);
      send({ kind: 'app', key, rect: iconRect(b) });
    });
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const kids = [...appsBox.children] as HTMLElement[];
      const slots = kids.map((k) => alongOf(k.getBoundingClientRect()));
      move = { b, id: e.pointerId, x0: along(e), moved: false, slots, from: kids.indexOf(b), to: kids.indexOf(b) };
    });
    b.addEventListener('pointermove', (e) => {
      const m = move;
      if (!m || m.b !== b || e.pointerId !== m.id) return;
      const dx = along(e) - m.x0;
      if (!m.moved) {
        if (Math.abs(dx) < DRAG_PX) return;
        m.moved = true;
        closePeek();
        b.setPointerCapture(e.pointerId);
        bar.classList.add('reordering');
        b.classList.add('moving');
      }
      const x = m.slots[m.from] + dx;
      let to = 0;
      m.slots.forEach((c, i) => {
        if (i !== m.from && x > c) to++;
      });
      m.to = to;
      const kids = [...appsBox.children] as HTMLElement[];
      const step = kids.length > 1 ? (m.slots[m.slots.length - 1] - m.slots[0]) / (kids.length - 1) : 0;
      kids.forEach((k, i) => {
        if (k === b) k.style.transform = slide(dx);
        else if (m.from < to && i > m.from && i <= to) k.style.transform = slide(-step);
        else if (m.from > to && i >= to && i < m.from) k.style.transform = slide(step);
        else k.style.transform = '';
      });
    });
    const end = (e: PointerEvent) => {
      const m = move;
      if (!m || m.b !== b || e.pointerId !== m.id) return;
      move = null;
      if (!m.moved) return;
      swallowClick = true;
      window.setTimeout(() => (swallowClick = false), 0);
      bar.classList.remove('reordering');
      b.classList.remove('moving');
      for (const k of appsBox.children) (k as HTMLElement).style.transform = '';
      if (m.to !== m.from) {
        // Its new place at once; the island's next frame confirms it (or puts it back).
        const kids = [...appsBox.children].filter((k) => k !== b);
        appsBox.insertBefore(b, kids[m.to] ?? null);
        send({ kind: 'move', key: b.dataset.key!, to: m.to });
      }
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
  };

  // The hover rise: each icon eases toward how high it should be, every frame while any moves. Along
  // a bar across the screen (not split round the island) its place widens too and the bar with it,
  // from its middle, into room its window keeps at each end (RISE_ROOM).
  const rise = new Map<HTMLElement, number>();
  let pointerX: number | null = null;
  let raf = 0;
  let lastT = 0;
  /** How much wider the spread makes the bar now (CSS px before the zoom). */
  let riseExtra = 0;
  let solidAt = 0;
  const spreads = () => has('rise') && !upright() && gapEl.hidden;
  const animateRise = (t: number) => {
    const dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    const k = 1 - Math.exp(-dt / 70);
    let busy = false;
    const spread = spreads();
    const z = Number(bar.style.zoom) || 1;
    // Where each place's middle would be with nothing spread: the pointer is measured against
    // those, so the spreading never moves the icon it is on away from it.
    const places = [...appsBox.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('dk-app') && !c.hidden);
    const left0 = appsBox.getBoundingClientRect().left + (riseExtra / 2) * z;
    let extra = 0;
    places.forEach((b, i) => {
      const ico = b.querySelector<HTMLElement>('.dk-ico');
      if (!ico) return;
      let want = 0;
      if (pointerX !== null && !move?.moved && has('rise')) {
        const mid = spread ? left0 + (i * (APP_W + APP_GAP) + APP_W / 2) * z : alongOf(b.getBoundingClientRect());
        want = riseAt(pointerX - mid);
      }
      const was = rise.get(b) ?? 0;
      const now = Math.abs(want - was) < 0.002 ? want : was + (want - was) * k;
      if (now !== want) busy = true;
      rise.set(b, now);
      const grow = spread ? RISE_GROW_SPREAD : RISE_GROW;
      ico.style.transform = now ? `${outward(Number((RISE_LIFT * now).toFixed(2)))} scale(${(1 + grow * now).toFixed(3)})` : '';
      const wide = spread ? APP_W * RISE_SPREAD * now : 0;
      b.style.width = wide > 0.05 ? `${(APP_W + wide).toFixed(2)}px` : '';
      extra += wide;
    });
    riseExtra = extra > 0.05 ? extra : 0;
    // Wider from its middle: half of it to each side.
    bar.style.translate = riseExtra ? `${(-riseExtra / 2).toFixed(2)}px 0` : '';
    raf = busy ? requestAnimationFrame(animateRise) : 0;
    // Where it takes clicks follows the widened bar, now and then while it moves, and when it stops.
    if (!raf || t - solidAt > 120) {
      solidAt = t;
      solid();
    }
    if (!raf) lastT = 0;
  };
  const kickRise = () => {
    if (!raf) raf = requestAnimationFrame(animateRise);
  };
  appsBox.addEventListener('pointermove', (e) => {
    pointerX = along(e);
    kickRise();
  });
  appsBox.addEventListener('pointerleave', () => {
    pointerX = null;
    kickRise();
  });

  // Spotlight: a line on the bar's top edge over the app in front, its light shining down on it; it
  // slides to the next app in front.
  const spot = el('i', 'dk-spot');
  bar.insertBefore(spot, start);
  let spotKey: string | null = null;
  const placeSpot = () => {
    spotKey = frame && has('spotlight') ? spotlightOn(frame.apps, spotKey) : null;
    const front = spotKey ? appEls.get(spotKey) : undefined;
    if (!front || front.hidden) {
      spot.classList.remove('on');
      return;
    }
    const x = upright() ? front.offsetTop + front.offsetHeight / 2 : front.offsetLeft + front.offsetWidth / 2;
    if (!spot.classList.contains('on')) {
      // From nothing: it appears there, no slide in from the side.
      spot.style.transition = 'none';
      spot.style.transform = slide(x);
      void spot.offsetWidth;
      spot.style.transition = '';
      spot.classList.add('on');
    } else spot.style.transform = slide(x);
  };

  // Glide: a highlight slides behind what the pointer is on. Names: its name slides along over the bar
  // (part of Glide until 11-19; now a style of its own, with its own font and look).
  const glow = el('i', 'dk-glow');
  bar.insertBefore(glow, start);
  const label = el('div', 'dk-label');
  above.append(label);
  let glideOn: HTMLElement | null = null;
  /** With Names on, the names are the label over the bar, not Windows' tooltips. */
  const titles = () => {
    const names = has('names');
    for (const b of bar.querySelectorAll<HTMLElement>('button')) {
      if (names && b.title) {
        b.dataset.tip = b.title;
        b.removeAttribute('title');
      } else if (!names && !b.title && b.dataset.tip) b.title = b.dataset.tip;
    }
  };
  const glideTo = (b: HTMLElement | null) => {
    if ((!has('glide') && !has('names')) || b === glideOn) return;
    const from = glideOn;
    glideOn = b;
    if (!b) {
      glow.classList.remove('on');
      label.classList.remove('on');
      return;
    }
    if (has('glide')) {
      // The highlight: from nothing it appears in place; from another item it slides over.
      const box = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
      const jump = !glow.classList.contains('on');
      if (jump) glow.style.transition = 'none';
      glow.style.width = `${b.offsetWidth}px`;
      glow.style.height = `${b.offsetHeight}px`;
      glow.style.transform = box;
      if (jump) {
        void glow.offsetWidth;
        glow.style.transition = '';
      }
      glow.classList.add('on');
    } else glow.classList.remove('on');
    // The name, over the bar (not for S/W: when they reset comes up there instead).
    const name = !has('names') || b === claude ? '' : (b.dataset.tip ?? b.title ?? '');
    if (!name) {
      label.classList.remove('on');
      return;
    }
    const leftward = Boolean(from && alongOf(from.getBoundingClientRect()) > alongOf(b.getBoundingClientRect()));
    const text = el('span', label.classList.contains('on') ? (leftward ? 'in-l' : 'in-r') : '');
    text.textContent = name;
    label.replaceChildren(text);
    const w = text.offsetWidth + 24;
    const r = b.getBoundingClientRect();
    // Over the bar, centred on the item; beside an upright bar, level with it.
    const x = upright()
      ? Math.round(Math.max(6, Math.min(window.innerHeight - 36, r.top + r.height / 2 - 15)))
      : Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)));
    if (!label.classList.contains('on')) {
      label.style.transition = 'none';
      label.style.width = `${w}px`;
      label.style.transform = slide(x);
      void label.offsetWidth;
      label.style.transition = '';
      label.classList.add('on');
    } else {
      label.style.width = `${w}px`;
      label.style.transform = slide(x);
    }
  };
  bar.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (b && bar.contains(b)) glideTo(b);
  });
  bar.addEventListener('pointerleave', () => glideTo(null));
  bar.addEventListener('pointerdown', () => {
    // A press (a launch, a drag) puts the name away.
    label.classList.remove('on');
  });

  const tickClock = () => {
    const now = new Date();
    // Upright there's only the bar's width: 4:32 over 11/18.
    const short = upright();
    clockTime.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(short ? /\s?[AP]M$/ : /$^/, '');
    clockDate.textContent = now.toLocaleDateString('en-US', short ? { month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric', year: 'numeric' });
  };

  /** The gap in the bar's middle for the island (its width, CSS px; 0: none). */
  let gapW = 0;
  const setGap = (w: number) => {
    const want = w > 0 ? Math.round(w) : 0;
    if (want === gapW) return;
    gapW = want;
    gapEl.hidden = !want;
    if (want) gapEl.style.width = `${(want + 2 * GAP_PAD) / (DOCK_ZOOM[frame?.size ?? 'medium'] ?? 1)}px`;
  };

  /** The island is open in the gap (the top bar splits round it). */
  let islandOpen = false;
  /** What the island's frame shows, before any squeezing. */
  const want = { start: true, apps: true, music: false, timer: false, claude: false, battery: false, wifi: true, sound: true, clock: true, bell: true };
  /**
   * What goes first when the bar runs off the screen (an open island in the middle of a top bar, or a
   * small screen), one at a time until it fits; what is left at the end is the apps (Moss: "the
   * taskbar CANNOT go off the screen ... only keep tabs and time (if there is space)").
   */
  const DROP = ['claude', 'timer', 'battery', 'sound', 'wifi', 'bell', 'music', 'start', 'clock'] as const;
  /** Shows what `want` says, less the first `n` of DROP. */
  const showItems = (n: number) => {
    const gone = new Set<string>(DROP.slice(0, n));
    const keep = (k: (typeof DROP)[number]) => want[k] && !gone.has(k);
    start.hidden = !keep('start');
    appsBox.hidden = !want.apps;
    music.hidden = musicPrev.hidden = musicNext.hidden = !keep('music');
    timer.hidden = !keep('timer');
    claude.hidden = !keep('claude');
    battery.hidden = !keep('battery');
    wifi.hidden = !keep('wifi');
    sound.hidden = !keep('sound');
    bell.hidden = !keep('bell');
    clock.hidden = !keep('clock');
    const split = !gapEl.hidden;
    const middle = !music.hidden || !timer.hidden || !claude.hidden;
    // Beside the island's gap a line is one too many: the island parts them.
    sepA.hidden = !middle || split;
    const leftShown = !start.hidden || !appsBox.hidden || middle;
    const rightShown = !battery.hidden || !wifi.hidden || !sound.hidden || !clock.hidden || !bell.hidden;
    sepB.hidden = !leftShown || !rightShown || (split && !middle);
  };
  /** The screen's length along the bar (CSS px): its work area's (the window is only the bar's size);
   *  in the browser preview, the page's. */
  const screenLen = () => {
    const preview = document.documentElement.classList.contains('dock-preview');
    if (upright()) return preview ? innerHeight : screen.availHeight || screen.height;
    return preview ? innerWidth : screen.availWidth || screen.width;
  };
  /** How far (CSS px) the bar runs past the screen's ends, 0 when it fits: `apps` past the end its apps
   *  are at, `any` past either. Split round the island, each half counts from the screen's middle
   *  (dock.rs puts the gap's middle there). */
  const overflow = (): { apps: number; any: number } => {
    const r = bar.getBoundingClientRect();
    const up = upright();
    const zoom = frame ? (DOCK_ZOOM[frame.size] ?? 1) : 1;
    // The window's 12px at each end, and the melted feet.
    const ends = 12 + (frame?.edge && frame.melt ? MELT.out * zoom : 0);
    const len = screenLen();
    if (!gapEl.hidden) {
      const g = gapEl.getBoundingClientRect();
      const mid = up ? g.top + g.height / 2 : g.left + g.width / 2;
      const before = Math.max(0, mid - (up ? r.top : r.left) + ends - len / 2);
      const after = Math.max(0, (up ? r.bottom : r.right) - mid + ends - len / 2);
      return { apps: before, any: Math.max(before, after) };
    }
    const over = Math.max(0, (up ? r.height : r.width) - riseExtra * zoom + 2 * ends - len);
    return { apps: over, any: over };
  };
  /** The bar squeezed until it fits on the screen: DROP's items go one by one, then the apps furthest
   *  along (never the one in front). Everything comes back once there is room again. */
  const squeezeToFit = () => {
    for (const k of appsBox.children) (k as HTMLElement).classList.remove('dk-cut');
    // The island open in the bar's middle: only the apps and the clock, room or not (Moss: "temporarily
    // hide things like now playing ... only keep tabs and time").
    let n = islandOpen && !gapEl.hidden ? DROP.indexOf('clock') : 0;
    showItems(n);
    while (n < DROP.length && overflow().any > 0) {
      // Past the ones not on the bar anyway: no layout for those.
      do n++;
      while (n < DROP.length && !want[DROP[n - 1]]);
      showItems(n);
    }
    let sq = n;
    const over = overflow().apps;
    if (over > 0) {
      sq = DROP.length + 1;
      const zoom = frame ? (DOCK_ZOOM[frame.size] ?? 1) : 1;
      // An app's place: its 40px and the 2px between apps.
      let cut = Math.ceil(over / (42 * zoom));
      for (const k of [...appsBox.children].reverse() as HTMLElement[]) {
        if (cut <= 0) break;
        if (k.classList.contains('front')) continue;
        k.classList.add('dk-cut');
        cut--;
      }
    }
    document.documentElement.dataset.squeeze = String(sq);
  };

  /** The window to the bar's width, with the room over it for a card. */
  const fit = async (): Promise<void> => {
    const r = bar.getBoundingClientRect();
    const up = upright();
    // 12px at each end; the melted ends grow with the bar's size, as the bar does.
    const zoom = frame ? (DOCK_ZOOM[frame.size] ?? 1) : 1;
    // Rise spreading: room at each end for the bar to widen into (and its width without the spread).
    const spreadRoom = spreads() ? RISE_ROOM * zoom : 0;
    document.documentElement.style.setProperty('--dk-room', `${spreadRoom}px`);
    const restLen = (up ? r.height : r.width) - riseExtra * zoom;
    const len = Math.ceil(restLen + 24 + 2 * spreadRoom + (frame?.edge && frame.melt ? 2 * MELT.out * zoom : 0));
    const thick = up ? r.width : r.height;
    const barArea = Math.ceil(thick + 16 + HEADROOM);
    // Beside an upright bar the card stands out sideways, as tall as the bar lets it.
    card.style.width = `${up ? CARD_W : Math.min(CARD_W, Math.floor(r.width))}px`;
    card.style.maxHeight = up ? `${Math.max(160, Math.floor(r.height) - 8)}px` : '';
    // The room for a card starts this far in from the window's edge side.
    for (const k of ['top', 'bottom', 'left', 'right']) above.style.removeProperty(k);
    above.style.setProperty(side(), `${Math.ceil(thick) + 12 + POP_GAP}px`);
    solid();
    tellFrame(r, zoom);
    const room = up ? CARD_W + 24 : ROOM;
    const [w, h] = up ? [barArea + room, len] : [len, barArea + room];
    // Split round the island: the gap's middle goes on the screen's middle.
    let pivot: number | null = null;
    if (!gapEl.hidden) {
      const g = gapEl.getBoundingClientRect();
      pivot = Math.round(g.left + g.width / 2);
    }
    const size = `${w}x${h}x${pivot}`;
    if (size === lastSize) return;
    lastSize = size;
    await native.dockFit(w, h, barArea, pivot);
  };
  /** The screen border's window hears where the bar is (for its light's path round it), while the border is on. */
  let frameSent = '';
  const tellFrame = (r: DOMRect, zoom: number) => {
    const part = frame?.border
      ? { rect: [window.screenX + r.left, window.screenY + r.top, r.width, r.height], side: side(), zoom, melt: frame.edge && frame.melt ? MELT : null, thick: BAR_H, radius: BAR_R }
      : null;
    const json = JSON.stringify(part);
    if (json === frameSent) return;
    frameSent = json;
    void sendTo('frame', 'frame-dock', part);
  };
  /** Tells the window where it takes clicks: the bar (and the room its icons rise into) and the card
   *  while it is up. Elsewhere a click goes through to what is under it. */
  let solidSent = '';
  const solid = () => {
    const r = bar.getBoundingClientRect();
    const H = HEADROOM;
    // The bar, and the room its icons rise into on its inner side.
    const box = {
      bottom: [r.left - 4, r.top - H, r.width + 8, r.height + H + 4],
      top: [r.left - 4, r.top - 4, r.width + 8, r.height + H + 4],
      left: [r.left - 4, r.top - 4, r.width + H + 4, r.height + 8],
      right: [r.left - H, r.top - 4, r.width + H + 4, r.height + 8],
    }[side()];
    const rects: number[][] = [];
    if (gapEl.hidden) rects.push(box);
    else {
      // Not the gap: a click there goes to the island under it.
      const g = gapEl.getBoundingClientRect();
      rects.push([box[0], box[1], g.left - box[0], box[3]], [g.right, box[1], box[0] + box[2] - g.right, box[3]]);
    }
    if (frame?.edge && frame.melt) {
      // The thick part of each melted foot takes clicks too: what they cover can't be seen.
      const z = DOCK_ZOOM[frame.size] ?? 1;
      const fw = MELT.out * z * 0.3;
      const fh = MELT.up * z * 0.6;
      const feet = {
        bottom: [[r.left - fw, r.bottom - fh, fw, fh], [r.right, r.bottom - fh, fw, fh]],
        top: [[r.left - fw, r.top, fw, fh], [r.right, r.top, fw, fh]],
        left: [[r.left, r.top - fw, fh, fw], [r.left, r.bottom, fh, fw]],
        right: [[r.right - fh, r.top - fw, fh, fw], [r.right - fh, r.bottom, fh, fw]],
      }[side()];
      rects.push(...feet);
    }
    for (const pop of [card, peek]) {
      if (pop.hidden) continue;
      // The card where it stands when up (its slide is a transform, which offsets leave out).
      const a = above.getBoundingClientRect();
      const m = POP_GAP + 4;
      rects.push([a.left + pop.offsetLeft - m, a.top + pop.offsetTop - m, pop.offsetWidth + 2 * m, pop.offsetHeight + 2 * m]);
    }
    const json = JSON.stringify(rects.map((q) => q.map((n) => Math.round(n))));
    if (json === solidSent) return;
    solidSent = json;
    void native.dockSolid(JSON.parse(json) as number[][]);
  };

  const draw = () => {
    const f = frame;
    if (!f) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', f.accent);
    bar.style.zoom = String(DOCK_ZOOM[f.size] ?? 1);
    // The zoom scales the bar's place in its window too; the CSS divides it back out of that.
    root.style.setProperty('--dk-z', bar.style.zoom);
    root.dataset.pill = f.color;
    root.dataset.side = side();
    root.classList.toggle('dk-upright', upright());
    // The melted ends' masks for this side, their feet on the border while it is on.
    const z = DOCK_ZOOM[f.size] ?? 1;
    const border = f.edge ? (f.border ?? 0) : 0;
    const sig = `${side()}|${(border / z).toFixed(2)}`;
    if (sig !== meltSig) {
      meltSig = sig;
      const m = meltMasks(side(), MELT.out, MELT.up, border / z);
      root.style.setProperty('--dk-melt-end', `${m.end}px`);
      root.style.setProperty('--dk-mask-fill', m.fill);
      root.style.setProperty('--dk-mask-rim', m.rim);
    }
    root.classList.toggle('dk-border', border > 0);
    setGap(side() === 'top' && f.gap ? f.gap : 0);
    applyGlass(root, f.glass);
    for (const k of DOCK_STYLES) root.classList.toggle(`dk-${k}`, (f.styles ?? ['rise']).includes(k));
    root.dataset.nameFont = f.names?.font ?? 'system';
    root.dataset.nameLook = f.names?.look ?? 'bubble';
    root.classList.toggle('dk-name-bold', f.names?.bold === true);
    root.classList.toggle('dock-edge', f.edge === true);
    root.classList.toggle('dock-melt', f.edge === true && f.melt === true);
    bar.classList.toggle('locked', f.locked);
    const off = new Set(f.hidden ?? []);
    // Apps, kept by key.
    const seen = new Set<string>();
    f.apps.forEach((a, i) => {
      seen.add(a.key);
      let b = appEls.get(a.key);
      if (!b) {
        b = el('button', 'dk-app');
        b.dataset.key = a.key;
        b.append(el('span', 'dk-ico'), el('i', 'dk-dot'));
        wireApp(b);
        appEls.set(a.key, b);
      }
      // With windows open the previews over it carry its name: Windows' tooltip would cover them.
      if (a.windows.length) {
        b.removeAttribute('title');
        delete b.dataset.tip;
      } else b.title = a.name;
      b.classList.toggle('open', a.windows.length > 0);
      if (a.windows.length) b.classList.remove('launching');
      b.classList.toggle('front', a.front);
      const ico = b.querySelector<HTMLElement>('.dk-ico')!;
      if (ico.dataset.src !== (a.icon ?? '')) {
        ico.dataset.src = a.icon ?? '';
        if (a.icon) {
          const img = document.createElement('img');
          img.src = a.icon;
          img.alt = '';
          img.draggable = false;
          ico.replaceChildren(img);
        } else ico.innerHTML = SVG.app;
      }
      if (appsBox.children[i] !== b) appsBox.insertBefore(b, appsBox.children[i] ?? null);
    });
    for (const [key, b] of appEls) {
      if (!seen.has(key)) {
        b.remove();
        appEls.delete(key);
      }
    }
    want.start = !off.has('arrow');
    want.apps = !off.has('apps');
    // What is playing, and the timer.
    const m = off.has('music') ? null : f.music;
    want.music = Boolean(m);
    if (m) {
      music.title = `${m.playing ? 'Pause' : 'Play'}: ${m.title}${m.artist ? ` · ${m.artist}` : ''}`;
      music.classList.toggle('paused', !m.playing);
      musicArt.hidden = !m.art;
      musicNote.hidden = Boolean(m.art);
      if (m.art && musicArt.src !== m.art) musicArt.src = m.art;
      musicTitle.textContent = m.title || 'Playing';
      musicArtist.textContent = m.artist;
      musicArtist.hidden = !m.artist;
      const pp = m.playing ? 'pause' : 'play';
      if (musicPP.dataset.k !== pp) {
        musicPP.dataset.k = pp;
        musicPP.innerHTML = SVG[pp];
      }
    }
    const t = off.has('timer') ? null : f.timer;
    want.timer = Boolean(t);
    timerText.textContent = t ?? '';
    // Claude's limits: S: 42% | W: 18%.
    const c = off.has('claude') ? null : f.claude;
    want.claude = Boolean(c);
    // Upright, S and W stack.
    if (c) claudeText.textContent = upright() ? claudeUsageText(c).replace(' | ', '\n') : claudeUsageText(c);
    // The battery: a small one filled to its charge, the percent beside it.
    const b = off.has('battery') ? null : f.battery;
    want.battery = Boolean(b);
    if (b) {
      const pct = Math.max(0, Math.min(100, Math.round(b.percent)));
      battFill.style.width = `${pct}%`;
      battText.textContent = `${pct}%`;
      battery.dataset.tone = batteryTone(b);
      battery.title = `Battery ${pct}%${b.charging ? ', charging' : ''}`;
    }
    // Wi-Fi and sound.
    want.wifi = !off.has('wifi');
    const wk = f.wifi === false ? 'off' : 'on';
    if (wifi.dataset.k !== wk) {
      wifi.dataset.k = wk;
      wifi.innerHTML = wk === 'off' ? SVG.wifiOff : SVG.wifi;
    }
    want.sound = !off.has('sound');
    const sk = f.muted ? 'mute' : 'sound';
    if (sound.dataset.k !== sk) {
      sound.dataset.k = sk;
      sound.innerHTML = SVG[sk];
    }
    want.clock = !off.has('clock');
    want.bell = !off.has('notifications');
    tickClock();
    squeezeToFit();
    if (cardOn && f.card) {
      drawCard(f.card);
      showPop(card);
    }
    if (!tip.hidden && tipHover) drawTip();
    void fit();
    titles();
    placeSpot();
    // Previews up: the app's windows may have changed (one closed, a title).
    if (peekKey !== null) {
      const pb = appEls.get(peekKey);
      if (pb) drawPeek(pb);
      else closePeek();
    }
  };

  // Dragging along its edge: by anything but a button. Not while it splits round the island.
  let drag: { id: number; grab: number; startX: number; moved: boolean } | null = null;
  const screenAlong = (e: PointerEvent) => (upright() ? e.screenY : e.screenX);
  // Never below 0: a negative x is "back to the middle" (a double-click), and dragging past the
  // screen's left edge made one, so the taskbar bounced back to the middle (Moss).
  const leftPx = (e: PointerEvent) => Math.max(0, (screenAlong(e) - drag!.grab) * devicePixelRatio);
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') || frame?.locked || !gapEl.hidden) return;
    drag = { id: e.pointerId, grab: screenAlong(e) - (upright() ? window.screenY : window.screenX), startX: screenAlong(e), moved: false };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('grabbing');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(screenAlong(e) - drag.startX) < DRAG_PX) return;
    drag.moved = true;
    void native.dockAt(leftPx(e), false);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) void native.dockAt(leftPx(e), true);
    drag = null;
    bar.classList.remove('grabbing');
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement).closest('button') && !frame?.locked) void native.dockAt(-1, true);
  });

  await on<{ full: boolean; up: boolean }>('dock-full', (st) => bar.classList.toggle('faint', Boolean(st?.full && !st.up)));
  // The screen border's window just opened: it hears where the bar is.
  await on<null>('frame-hello', () => {
    frameSent = '';
    void fit();
  });
  // The island's pill changed width, while the bar splits round it: the gap follows at once.
  await on<number | { w: number; open?: boolean }>('dock-gap', (g) => {
    const w = typeof g === 'number' ? g : g?.w;
    if (typeof g === 'object' && g) islandOpen = g.open === true;
    if (!frame || side() !== 'top' || !frame.gap || typeof w !== 'number' || !Number.isFinite(w)) return;
    setGap(w);
    squeezeToFit();
    void fit();
    placeSpot();
  });
  await on<DockFrame>('dock-frame', (f) => {
    frame = f;
    draw();
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const b = (e.target as HTMLElement).closest<HTMLElement>('.dk-app');
    const a = b ? appOf(b.dataset.key ?? '') : null;
    if (isTauri && b && a) {
      void appMenu(a, send, () => iconRect(b)).catch((err) => void native.log(`taskbar app menu: ${String(err)}`));
      return;
    }
    if (isTauri && frame) void dockMenu(frame, (p) => void sendTo('island', 'dock-pref', p)).catch((err) => void native.log(`taskbar menu: ${String(err)}`));
  });
  setInterval(() => {
    tickClock();
    if (!tip.hidden && tipHover) drawTip();
  }, 1000);
  tickClock();
  void sendTo('island', 'dock-ready', null);
}
