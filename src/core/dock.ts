// The taskbar (Settings › Taskbar): a pill along the bottom of the screen in the island's own glass.
// Start, then your apps (the Apps tile's list first, then whatever else has a window open; a dot
// under the ones running, a longer one under the one in front), then what is playing and the
// timer, then Wi-Fi and sound, the clock and the notification bell.
//
// The island owns it, as it owns desktop widgets: DockHost reads the windows and the activities
// and sends the dock window (src-tauri/src/dock.rs) one frame when anything changes; a click in
// the dock comes back as `dock-act` and the island does it.

import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { applyGlass } from './glass';
import { isTauri, native, on, sendTo, type InstalledApp, type LiveWindow } from './native';
import type { PillColor } from './settings';

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
  muted: boolean;
  wifi: boolean | null;
  accent: string;
  color: PillColor;
  glass?: number;
  /** Dragging it is off (right-click › Lock in place). */
  locked: boolean;
}

/** What the taskbar's right-click menu changes. */
export interface DockPref {
  locked?: boolean;
  /** Back to the middle. */
  centre?: boolean;
}

export type DockAct = { kind: 'app'; key: string } | { kind: 'start' | 'quick' | 'notifications' | 'music' | 'timer' };

/** Apps on the dock, at most. */
export const DOCK_MAX = 14;
/** Programs whose windows never get a place (Island's own, the shell's). */
const SKIP = /\\(island|explorer|applicationframehost|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|systemsettings)\.exe$/i;

const keyOf = (path: string) => path.toLowerCase();
const nameOf = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.exe$/i, '');

/**
 * The dock's apps: the pinned ones in their order (with their windows), then every other program
 * with a window, in the order they were last in front. `front` is the window in front now.
 */
export function dockApps(pinned: readonly InstalledApp[], windows: readonly LiveWindow[], front: number, icons: ReadonlyMap<string, string | null>): DockApp[] {
  const byExe = new Map<string, LiveWindow[]>();
  for (const w of windows) {
    if (!w.exe || SKIP.test(w.exe)) continue;
    const k = keyOf(w.exe);
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
  for (const [key, wins] of [...byExe]) out.push(app(key, nameOf(wins[0].exe), false));
  return out.slice(0, DOCK_MAX);
}

/** Which window a click on an app brings forward: none open → launch; the one in front → the next one; else the first. */
export function nextWindow(app: DockApp): number | null {
  if (!app.windows.length) return null;
  if (!app.front) return app.windows[0];
  return app.windows[1] ?? app.windows[0];
}

// ------------------------------------------------------------------ the island's side

export interface DockHooks {
  pinned(): InstalledApp[];
  music(): DockFrame['music'];
  timer(): string | null;
  muted(): boolean;
  wifi(): boolean | null;
  look(): { accent: string; color: PillColor; glass?: number };
  /** One of an activity's actions (`act:music:toggle`). */
  act(action: string): void;
  /** Opens the island (the timer: its time is there). */
  open(): void;
  /** Where the taskbar was dragged to, 0..1 across the screen (-1: the middle). */
  centre(): number;
  saveCentre(centre: number): void;
  locked(): boolean;
  setLocked(on: boolean): void;
}

export class DockHost {
  private apps: DockApp[] = [];
  private readonly icons = new Map<string, string | null>();
  private sent = '';
  private shown = false;
  private busy = false;
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
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.shown) {
        this.shown = true;
        void native.dockShow(true, 640, 60, this.hooks.centre());
      }
      const [wins, front] = await Promise.all([native.wsWindows(), native.foreground()]);
      const live = wins.ok ? wins.value : [];
      const pinned = this.hooks.pinned();
      const want = [...new Set([...pinned.map((p) => p.target), ...live.map((w) => w.exe).filter(Boolean)])].filter((t) => !this.icons.has(keyOf(t)));
      if (want.length) {
        for (const t of want) this.icons.set(keyOf(t), null);
        const got = await native.appsIcons(want, 48);
        want.forEach((t, i) => this.icons.set(keyOf(t), got[i] ?? null));
      }
      this.apps = dockApps(pinned, live, front, this.icons);
      const frame: DockFrame = { apps: this.apps, music: this.hooks.music(), timer: this.hooks.timer(), muted: this.hooks.muted(), wifi: this.hooks.wifi(), ...this.hooks.look(), locked: this.hooks.locked() };
      const json = JSON.stringify(frame);
      if (json !== this.sent) {
        this.sent = json;
        void sendTo('dock', 'dock-frame', frame);
      }
    } finally {
      this.busy = false;
    }
  }

  private async act(a: DockAct): Promise<void> {
    if (!a || typeof a !== 'object') return;
    if (a.kind === 'start' || a.kind === 'quick' || a.kind === 'notifications') {
      void native.dockPanel(a.kind);
      return;
    }
    if (a.kind === 'music') return this.hooks.act('act:music:toggle');
    if (a.kind === 'timer') return this.hooks.open();
    if (a.kind !== 'app' || typeof a.key !== 'string') return;
    const app = this.apps.find((x) => x.key === a.key);
    if (!app) return;
    const hwnd = nextWindow(app);
    if (hwnd !== null) {
      await native.activate(hwnd);
    } else {
      const target = this.hooks.pinned().find((p) => keyOf(p.target) === app.key)?.target;
      if (target) await native.wsLaunch({ kind: 'app', path: target, args: '', cwd: '' }, '');
    }
    setTimeout(() => void this.tick(), 400);
  }
}

// ------------------------------------------------------------------ the dock window

const SVG = {
  start: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  timer: '<svg viewBox="0 0 24 24" class="line"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2.5h4"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" class="line"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r="1" class="dot"/></svg>',
  wifiOff: '<svg viewBox="0 0 24 24" class="line"><path d="M8.5 16a5 5 0 0 1 7 0M3 3l18 18"/><circle cx="12" cy="19.2" r="1" class="dot"/></svg>',
  sound: '<svg viewBox="0 0 24 24" class="line"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24" class="line"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" class="line"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  app: '<svg viewBox="0 0 24 24" class="line"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>',
};

function el(tag: string, cls: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** The taskbar's right-click menu (Windows' own): lock it in place, back to the middle, Settings › Widgets. */
async function dockMenu(f: DockFrame, pref: (p: DockPref) => void): Promise<void> {
  const menu = await Menu.new({
    items: [
      await CheckMenuItem.new({ text: 'Lock in place', checked: f.locked, action: () => pref({ locked: !f.locked }) }),
      await MenuItem.new({ text: 'Back to the middle', action: () => pref({ centre: true }) }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Taskbar settings…', action: () => void native.openApp('widgets') }),
    ],
  });
  await menu.popup();
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
  const bar = el('div', 'dock');
  bar.append(el('i', 'dock-bg'));
  stage.append(bar);
  const send = (a: DockAct) => void sendTo('island', 'dock-act', a);
  let frame: DockFrame | null = null;
  let lastSize = '';

  const start = el('button', 'dk-btn dk-start', SVG.start);
  start.title = 'Start';
  start.addEventListener('click', () => send({ kind: 'start' }));
  const appsBox = el('div', 'dk-apps');
  const sepA = el('i', 'dk-sep');
  const music = el('button', 'dk-music');
  const musicArt = document.createElement('img');
  musicArt.alt = '';
  musicArt.draggable = false;
  const musicPP = el('span', 'dk-pp');
  music.append(musicArt, musicPP);
  music.addEventListener('click', () => send({ kind: 'music' }));
  const timer = el('button', 'dk-timer', SVG.timer);
  const timerText = el('span', '');
  timer.append(timerText);
  timer.title = 'Timer';
  timer.addEventListener('click', () => send({ kind: 'timer' }));
  const sepB = el('i', 'dk-sep');
  const quick = el('button', 'dk-quick');
  quick.title = 'Wi-Fi and sound';
  quick.addEventListener('click', () => send({ kind: 'quick' }));
  const clock = el('button', 'dk-clock');
  const clockTime = el('b', '');
  const clockDate = el('span', '');
  clock.append(clockTime, clockDate);
  clock.title = 'Notifications and calendar';
  clock.addEventListener('click', () => send({ kind: 'notifications' }));
  const bell = el('button', 'dk-btn dk-bell', SVG.bell);
  bell.title = 'Notifications';
  bell.addEventListener('click', () => send({ kind: 'notifications' }));
  bar.append(start, appsBox, sepA, music, timer, sepB, quick, clock, bell);
  const appEls = new Map<string, HTMLElement>();

  const tickClock = () => {
    const now = new Date();
    clockTime.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    clockDate.textContent = now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
  };

  const fit = () => {
    const r = bar.getBoundingClientRect();
    const w = Math.ceil(r.width + 24);
    const h = Math.ceil(r.height + 16);
    const size = `${w}x${h}`;
    if (size === lastSize) return;
    lastSize = size;
    void native.dockFit(w, h);
  };

  const draw = () => {
    const f = frame;
    if (!f) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', f.accent);
    root.dataset.pill = f.color;
    applyGlass(root, f.glass);
    bar.classList.toggle('locked', f.locked);
    // Apps, kept by key.
    const seen = new Set<string>();
    f.apps.forEach((a, i) => {
      seen.add(a.key);
      let b = appEls.get(a.key);
      if (!b) {
        b = el('button', 'dk-app');
        b.dataset.key = a.key;
        b.append(el('span', 'dk-ico'), el('i', 'dk-dot'));
        b.addEventListener('click', () => send({ kind: 'app', key: b!.dataset.key! }));
        appEls.set(a.key, b);
      }
      b.title = a.name;
      b.classList.toggle('open', a.windows.length > 0);
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
    // What is playing, and the timer.
    music.hidden = !f.music;
    if (f.music) {
      music.title = `${f.music.title}${f.music.artist ? ` · ${f.music.artist}` : ''}`;
      musicArt.hidden = !f.music.art;
      if (f.music.art && musicArt.src !== f.music.art) musicArt.src = f.music.art;
      const pp = f.music.playing ? 'pause' : 'play';
      if (musicPP.dataset.k !== pp) {
        musicPP.dataset.k = pp;
        musicPP.innerHTML = SVG[pp];
      }
    }
    timer.hidden = !f.timer;
    timerText.textContent = f.timer ?? '';
    sepA.hidden = !f.music && !f.timer;
    // Wi-Fi and sound.
    const q = `${f.wifi === false ? 'off' : 'on'}|${f.muted ? 'mute' : 'sound'}`;
    if (quick.dataset.k !== q) {
      quick.dataset.k = q;
      quick.innerHTML = (f.wifi === false ? SVG.wifiOff : SVG.wifi) + (f.muted ? SVG.mute : SVG.sound);
    }
    tickClock();
    fit();
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

  await on<DockFrame>('dock-frame', (f) => {
    frame = f;
    draw();
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isTauri && frame) void dockMenu(frame, (p) => void sendTo('island', 'dock-pref', p)).catch((err) => void native.log(`taskbar menu: ${String(err)}`));
  });
  setInterval(tickClock, 1000);
  tickClock();
  void sendTo('island', 'dock-ready', null);
}
