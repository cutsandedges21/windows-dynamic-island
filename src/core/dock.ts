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
import { DOCK_ITEMS, DOCK_SIZES, DOCK_STYLES, type DockItem, type DockSize, type DockStyle, type PillColor } from './settings';

/** One app on the dock. */
export interface DockApp {
  /** Its program's path (lower case), or a Store app's shell name. */
  key: string;
  name: string;
  icon: string | null;
  /** Its windows, front first. */
  windows: number[];
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
  /** Rise, Spotlight or Glide (Settings › Widgets › Style). */
  style?: DockStyle;
  /** On the screen's bottom edge, over Windows' taskbar. */
  edge?: boolean;
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
  style?: DockStyle;
  edge?: boolean;
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
  /** Dragged to place `to` in the row (its index once dropped). */
  | { kind: 'move'; key: string; to: number }
  | { kind: 'start' | 'quick' | 'notifications' | 'music' | 'timer' | 'claude' }
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
    return { key, name, icon: icons.get(key) ?? null, windows: wins.map((w) => w.hwnd), front: wins.some((w) => w.hwnd === front), pinned: pin };
  };
  const out = pinned.map((p) => app(keyOf(p.target), p.name, true));
  const rank = (key: string) => {
    const i = seen.indexOf(key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rest = [...byExe].sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [key, wins] of rest) out.push(app(key, wins[0].appId ? wins[0].title : nameOf(wins[0].exe), false));
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
  style(): DockStyle;
  setStyle(style: DockStyle): void;
  edge(): boolean;
  setEdge(on: boolean): void;
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
        if (typeof p?.style === 'string' && (DOCK_STYLES as readonly string[]).includes(p.style)) this.hooks.setStyle(p.style);
        if (typeof p?.edge === 'boolean') this.hooks.setEdge(p.edge);
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
        style: this.hooks.style(),
        edge: this.hooks.edge(),
      };
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
    items: await Promise.all(DOCK_STYLES.map((k) => CheckMenuItem.new({ text: DOCK_STYLE_LABELS[k], checked: (f.style ?? 'rise') === k, action: () => pref({ style: k }) }))),
  });
  const menu = await Menu.new({
    items: [
      show,
      sizes,
      styles,
      await CheckMenuItem.new({ text: 'Blend into the bottom', checked: f.edge === true, action: () => pref({ edge: !f.edge }) }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await CheckMenuItem.new({ text: 'Lock in place', checked: f.locked, action: () => pref({ locked: !f.locked }) }),
      await MenuItem.new({ text: 'Back to the middle', action: () => pref({ centre: true }) }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Taskbar settings…', action: () => void native.openApp('widgets') }),
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

export const DOCK_SIZE_LABELS: Record<DockSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
export const DOCK_STYLE_LABELS: Record<DockStyle, string> = { rise: 'Rise', spotlight: 'Spotlight', glide: 'Glide' };

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
/** Between the bar and a card over it, CSS px. */
const POP_GAP = 8;
/** A card's slide down behind the bar, ms (as in the CSS). */
const POP_MS = 240;
/** Pointing at S/W this long shows when they reset, ms. */
const TIP_DELAY_MS = 250;

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
  const bar = el('div', 'dock');
  bar.append(el('i', 'dock-bg'));
  stage.append(bar);
  const send = (a: DockAct) => void sendTo('island', 'dock-act', a);
  let frame: DockFrame | null = null;
  let lastSize = '';

  // The arrow at the start: the Apps card (Control Center's Apps) comes up over the bar.
  const start = el('button', 'dk-btn dk-start', SVG.up);
  start.title = 'Your apps';
  start.addEventListener('click', () => setCard(!cardOn));
  const appsBox = el('div', 'dk-apps');
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
  bar.append(start, appsBox, sepA, music, timer, claude, sepB, battery, wifi, sound, clock, bell);

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
  find.placeholder = 'Add an app: type its name';
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
    if (on) hidePop(tip);
    else {
      find.blur();
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
    cardEmpty.hidden = c.apps.length > 0 || c.editing || Boolean(c.off);
    find.hidden = !c.editing;
    if (!c.editing) find.value = '';
    else if (document.activeElement !== find && find.value !== c.query) find.value = c.query;
    if (c.editing && !wasEditing) requestAnimationFrame(() => find.focus());
    wasEditing = c.editing;
    const typed = c.editing && c.query.trim() !== '';
    const fsig = JSON.stringify([c.found, c.reading, typed]);
    if (fsig !== foundSig) {
      foundSig = fsig;
      const rows = c.found.map((a) => {
        const r = el('button', 'dk-row', SVG.plus);
        const name = el('span', '');
        name.textContent = a.name;
        r.append(name);
        r.title = `Add ${a.name}`;
        r.addEventListener('click', () => {
          find.value = '';
          send({ kind: 'apps', name: 'add', arg: a.target });
          find.focus();
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
    const w = tip.offsetWidth;
    tip.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, b.left + b.width / 2 - w / 2)))}px`;
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

  // Launching: the icon bounces until the app has a window (or a few seconds pass).
  const bounce = (b: HTMLElement) => {
    b.classList.add('launching');
    window.setTimeout(() => b.classList.remove('launching'), 4000);
  };

  // Dragging an icon along the row to a new place; the others make room.
  let move: { b: HTMLElement; id: number; x0: number; moved: boolean; slots: number[]; from: number; to: number } | null = null;
  let swallowClick = false;
  const wireApp = (b: HTMLElement) => {
    b.addEventListener('click', () => {
      if (swallowClick) return;
      const key = b.dataset.key!;
      const a = appOf(key);
      if (a && !a.windows.length) bounce(b);
      send({ kind: 'app', key, rect: iconRect(b) });
    });
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const kids = [...appsBox.children] as HTMLElement[];
      const slots = kids.map((k) => {
        const r = k.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      move = { b, id: e.pointerId, x0: e.clientX, moved: false, slots, from: kids.indexOf(b), to: kids.indexOf(b) };
    });
    b.addEventListener('pointermove', (e) => {
      const m = move;
      if (!m || m.b !== b || e.pointerId !== m.id) return;
      const dx = e.clientX - m.x0;
      if (!m.moved) {
        if (Math.abs(dx) < DRAG_PX) return;
        m.moved = true;
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
        if (k === b) k.style.transform = `translateX(${dx}px)`;
        else if (m.from < to && i > m.from && i <= to) k.style.transform = `translateX(${-step}px)`;
        else if (m.from > to && i >= to && i < m.from) k.style.transform = `translateX(${step}px)`;
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

  // The hover rise: each icon eases toward how high it should be, every frame while any moves.
  const rise = new Map<HTMLElement, number>();
  let pointerX: number | null = null;
  let raf = 0;
  let lastT = 0;
  const animateRise = (t: number) => {
    const dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    const k = 1 - Math.exp(-dt / 70);
    let busy = false;
    for (const b of appEls.values()) {
      const ico = b.querySelector<HTMLElement>('.dk-ico');
      if (!ico) continue;
      let want = 0;
      if (pointerX !== null && !move?.moved && (frame?.style ?? 'rise') === 'rise') {
        const r = b.getBoundingClientRect();
        want = riseAt(pointerX - (r.left + r.width / 2));
      }
      const was = rise.get(b) ?? 0;
      const now = Math.abs(want - was) < 0.002 ? want : was + (want - was) * k;
      if (now !== want) busy = true;
      rise.set(b, now);
      ico.style.transform = now ? `translateY(${(-RISE_LIFT * now).toFixed(2)}px) scale(${(1 + RISE_GROW * now).toFixed(3)})` : '';
    }
    raf = busy ? requestAnimationFrame(animateRise) : 0;
    if (!raf) lastT = 0;
  };
  const kickRise = () => {
    if (!raf) raf = requestAnimationFrame(animateRise);
  };
  appsBox.addEventListener('pointermove', (e) => {
    pointerX = e.clientX;
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
  const placeSpot = () => {
    const front = frame?.style === 'spotlight' ? [...appEls.values()].find((b) => b.classList.contains('front') && !b.hidden) : undefined;
    if (!front) {
      spot.classList.remove('on');
      return;
    }
    const x = front.offsetLeft + front.offsetWidth / 2;
    if (!spot.classList.contains('on')) {
      // From nothing: it appears there, no slide in from the side.
      spot.style.transition = 'none';
      spot.style.transform = `translateX(${x}px)`;
      void spot.offsetWidth;
      spot.style.transition = '';
      spot.classList.add('on');
    } else spot.style.transform = `translateX(${x}px)`;
  };

  // Glide: a highlight slides behind what the pointer is on, and its name slides along over the bar.
  const glow = el('i', 'dk-glow');
  bar.insertBefore(glow, start);
  const label = el('div', 'dk-label');
  above.append(label);
  let glideOn: HTMLElement | null = null;
  /** In Glide the names are the label over the bar, not Windows' tooltips. */
  const titles = () => {
    const glide = frame?.style === 'glide';
    for (const b of bar.querySelectorAll<HTMLElement>('button')) {
      if (glide && b.title) {
        b.dataset.tip = b.title;
        b.removeAttribute('title');
      } else if (!glide && !b.title && b.dataset.tip) b.title = b.dataset.tip;
    }
  };
  const glideTo = (b: HTMLElement | null) => {
    if (frame?.style !== 'glide' || b === glideOn) return;
    const from = glideOn;
    glideOn = b;
    if (!b) {
      glow.classList.remove('on');
      label.classList.remove('on');
      return;
    }
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
    // The name, over the bar (not for S/W: when they reset comes up there instead).
    const name = b === claude ? '' : (b.dataset.tip ?? b.title ?? '');
    if (!name) {
      label.classList.remove('on');
      return;
    }
    const leftward = Boolean(from && from.getBoundingClientRect().left > b.getBoundingClientRect().left);
    const text = el('span', label.classList.contains('on') ? (leftward ? 'in-l' : 'in-r') : '');
    text.textContent = name;
    label.replaceChildren(text);
    const w = text.offsetWidth + 24;
    const r = b.getBoundingClientRect();
    const x = Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)));
    if (!label.classList.contains('on')) {
      label.style.transition = 'none';
      label.style.width = `${w}px`;
      label.style.transform = `translateX(${x}px)`;
      void label.offsetWidth;
      label.style.transition = '';
      label.classList.add('on');
    } else {
      label.style.width = `${w}px`;
      label.style.transform = `translateX(${x}px)`;
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
    clockTime.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    clockDate.textContent = now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
  };

  /** The window to the bar's width, with the room over it for a card. */
  const fit = async (): Promise<void> => {
    const r = bar.getBoundingClientRect();
    const w = Math.ceil(r.width + 24);
    const barArea = Math.ceil(r.height + 16 + HEADROOM);
    card.style.width = `${Math.min(CARD_W, Math.floor(r.width))}px`;
    above.style.bottom = `${Math.ceil(r.height) + 12 + POP_GAP}px`;
    solid();
    const size = `${w}x${barArea + ROOM}`;
    if (size === lastSize) return;
    lastSize = size;
    await native.dockFit(w, barArea + ROOM, barArea);
  };
  /** Tells the window where it takes clicks: the bar (and the room its icons rise into) and the card
   *  while it is up. Elsewhere a click goes through to what is under it. */
  let solidSent = '';
  const solid = () => {
    const r = bar.getBoundingClientRect();
    const rects: number[][] = [[r.left - 4, r.top - HEADROOM, r.width + 8, r.height + HEADROOM + 4]];
    const base = window.innerHeight - (parseFloat(above.style.bottom) || 0);
    if (!card.hidden) rects.push([card.offsetLeft - 4, base - card.offsetHeight - 4, card.offsetWidth + 8, card.offsetHeight + POP_GAP + 8]);
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
    root.dataset.pill = f.color;
    applyGlass(root, f.glass);
    root.dataset.dstyle = f.style ?? 'rise';
    root.classList.toggle('dock-edge', f.edge === true);
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
      b.title = a.name;
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
    start.hidden = off.has('arrow');
    appsBox.hidden = off.has('apps');
    // What is playing, and the timer.
    const m = off.has('music') ? null : f.music;
    music.hidden = !m;
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
    timer.hidden = !t;
    timerText.textContent = t ?? '';
    // Claude's limits: S: 42% | W: 18%.
    const c = off.has('claude') ? null : f.claude;
    claude.hidden = !c;
    if (c) claudeText.textContent = claudeUsageText(c);
    sepA.hidden = !m && !t && !c;
    // The battery: a small one filled to its charge, the percent beside it.
    const b = off.has('battery') ? null : f.battery;
    battery.hidden = !b;
    if (b) {
      const pct = Math.max(0, Math.min(100, Math.round(b.percent)));
      battFill.style.width = `${pct}%`;
      battText.textContent = `${pct}%`;
      battery.dataset.tone = batteryTone(b);
      battery.title = `Battery ${pct}%${b.charging ? ', charging' : ''}`;
    }
    // Wi-Fi and sound.
    wifi.hidden = off.has('wifi');
    const wk = f.wifi === false ? 'off' : 'on';
    if (wifi.dataset.k !== wk) {
      wifi.dataset.k = wk;
      wifi.innerHTML = wk === 'off' ? SVG.wifiOff : SVG.wifi;
    }
    sound.hidden = off.has('sound');
    const sk = f.muted ? 'mute' : 'sound';
    if (sound.dataset.k !== sk) {
      sound.dataset.k = sk;
      sound.innerHTML = SVG[sk];
    }
    clock.hidden = off.has('clock');
    bell.hidden = off.has('notifications');
    const leftShown = !start.hidden || !appsBox.hidden || !sepA.hidden;
    const rightShown = !battery.hidden || !wifi.hidden || !sound.hidden || !clock.hidden || !bell.hidden;
    sepB.hidden = !leftShown || !rightShown;
    tickClock();
    if (cardOn && f.card) {
      drawCard(f.card);
      showPop(card);
    }
    if (!tip.hidden && tipHover) drawTip();
    void fit();
    titles();
    placeSpot();
  };

  // Dragging along the bottom: by anything but a button.
  let drag: { id: number; grab: number; startX: number; moved: boolean } | null = null;
  const leftPx = (e: PointerEvent) => (e.screenX - drag!.grab) * devicePixelRatio;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') || frame?.locked) return;
    drag = { id: e.pointerId, grab: e.screenX - window.screenX, startX: e.screenX, moved: false };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('grabbing');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(e.screenX - drag.startX) < DRAG_PX) return;
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
