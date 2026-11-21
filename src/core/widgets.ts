// Desktop widgets: any Control Center tile, live on the desktop under your windows. The island
// owns them: it makes their windows (src-tauri/src/widgets.rs), sends each its tile once a
// second (and when it changes), runs a press the window reports as the tile's own action, and
// saves where each was dragged to. A widget window runs no activities; `runWidget` draws what
// it is sent with the same SheetRenderer the island's cards use.

import { applyGlass, applyPill } from './glass';
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { isTauri, native, on, sendTo, windowLabel } from './native';
import { SheetRenderer, type SheetView, type Tile } from './sheet';
import type { DesktopWidget, ItemLook, PillColor } from './settings';

/**
 * The widgets that can be added: `kind` is an activity id (its first Control Center tile), or
 * 'clock'. `about` is the line under its name in Settings › Widgets.
 */
export const WIDGET_KINDS: ReadonlyArray<{ kind: string; label: string; icon: string; about: string }> = [
  { kind: 'clock', label: 'Day and time', icon: 'clock', about: 'The day, the date and the time, large and clean.' },
  { kind: 'music', label: 'Music', icon: 'music', about: "What's playing, with its lyrics when there are any." },
  { kind: 'weather', label: 'Weather', icon: 'sun', about: 'Now and the next hours.' },
  { kind: 'calendar', label: 'Calendar', icon: 'calendar', about: 'Your week at a glance.' },
  { kind: 'timer', label: 'Timer', icon: 'timer', about: 'Start a timer or a focus session.' },
  { kind: 'system', label: 'System stats', icon: 'cpu', about: 'CPU, memory and graphics.' },
  { kind: 'claude', label: 'Claude sessions', icon: 'claude', about: 'Every Claude chat and what it is doing.' },
  { kind: 'reminders', label: 'Reminders', icon: 'bell', about: "What's next on your list." },
  { kind: 'clipboard', label: 'Clipboard', icon: 'clipboard', about: 'What you copied lately.' },
  { kind: 'downloads', label: 'Downloads', icon: 'download', about: 'Files arriving, and the last ones.' },
  { kind: 'battery', label: 'Battery', icon: 'battery', about: 'How much is left.' },
  { kind: 'game', label: 'Games', icon: 'gamepad', about: 'Frame rate and ping while you play.' },
];

/**
 * Sizes a widget may take, by what its tile shows: only tiles that show more when bigger (a
 * list gets more rows, lyrics more lines). Cells as "columns x rows", with a word for the menu.
 */
export const WIDGET_SIZES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  lyrics: [
    ['1x2', 'Narrow'],
    ['1x4', 'Tall'],
    ['2x4', 'Large'],
  ],
  list: [
    ['2x1', 'Small'],
    ['2x2', 'Medium'],
    ['2x4', 'Large'],
  ],
};

/** The sizes a tile offers as a widget (none: it shows the same at any size). */
export function sizesOf(tile: Tile | null): ReadonlyArray<readonly [string, string]> {
  return (tile && WIDGET_SIZES[tile.body.k]) ?? [];
}

/** A tile at the size the user picked for its widget, when that size is one it offers. */
export function sized(tile: Tile, size: string | undefined): Tile {
  if (!size || !sizesOf(tile).some(([v]) => v === size)) return tile;
  const [w, h] = size.split('x').map(Number);
  return { ...tile, w, h };
}

/** The look widgets (or the taskbar) are drawn in: their own, or the island's when set to follow it. */
export function lookOf(own: ItemLook, island: { color: PillColor; glass?: number; tint?: number; custom?: string; tinted?: boolean }): { color: PillColor; glass?: number; tint?: number; custom?: string; tinted?: boolean } {
  return own.color === 'island' ? { color: island.color, glass: island.glass, tint: island.tint, custom: island.custom, tinted: island.tinted } : { color: own.color, glass: own.glass, tint: own.tint };
}

export const MAX_WIDGETS = 8;
/** A tile's cell, and the space round it, as drawn in a widget (design size; see sheet.ts --k). */
export const CELL = 92;
const GAP = 8;
/** Room round the card for its shadow, in the widget window. */
export const PAD = 12;

export const kindLabel = (kind: string): string => WIDGET_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/** The saved list as it may be used: known kinds only, ids safe for a window label, MAX_WIDGETS at most. */
export function cleanWidgets(saved: unknown): DesktopWidget[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const out: DesktopWidget[] = [];
  for (const w of saved) {
    if (typeof w !== 'object' || w === null) continue;
    const { id, kind, x, y, size, locked } = w as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id) || seen.has(id) || typeof kind !== 'string' || !WIDGET_KINDS.some((k) => k.kind === kind)) continue;
    seen.add(id);
    const item: DesktopWidget = { id, kind, x: Number.isFinite(x) ? Math.round(x as number) : -1, y: Number.isFinite(y) ? Math.round(y as number) : -1 };
    if (typeof size === 'string' && /^[12]x[124]$/.test(size)) item.size = size;
    if (locked === true) item.locked = true;
    out.push(item);
    if (out.length === MAX_WIDGETS) break;
  }
  return out;
}

/** A new widget's id: its kind, and a number when that kind is already there. */
export function newWidgetId(kind: string, taken: readonly string[]): string {
  let id = kind;
  for (let n = 2; taken.includes(id); n++) id = `${kind}-${n}`;
  return id;
}

/** The tile a kind shows: the first Control Center tile its activity has. */
export function tileFor(kind: string, tiles: readonly Tile[]): Tile | null {
  return tiles.find((t) => t.key.startsWith(`${kind}/`)) ?? null;
}

/** A widget window's first size (logical px) for a tile of w x h cells; the page fits it to its content afterwards. */
export function sizeFor(w: number, h: number): { w: number; h: number } {
  return { w: w * CELL + (w - 1) * GAP + PAD * 2 + 28, h: h * CELL + (h - 1) * GAP + PAD * 2 + 28 };
}

/** What the island sends a widget window. */
export interface WidgetFrame {
  kind: string;
  /** The tile, already named for its activity's actions; null when its activity has nothing to show now. */
  tile: Tile | null;
  accent: string;
  color: PillColor;
  glass?: number;
  /** Tinted black's tint slider, 0–100 (glass.ts tintAlpha). */
  tint?: number;
  /** Pill colour › Custom's own colour. */
  custom?: string;
  /** Black or Matte black see-through (Settings › Tinted). */
  tinted?: boolean;
  reduce: boolean;
  /** Dragging it is off (right-click › Lock in place). */
  locked: boolean;
  /** Sizes it offers (right-click), and the one it has. */
  sizes: ReadonlyArray<readonly [string, string]>;
  size: string;
  /** No tile: its activity is off, or on with nothing to show right now. */
  idle: 'off' | 'quiet' | null;
}

/** What a widget says when its activity is on but has nothing to show right now. */
export const QUIET: Readonly<Record<string, string>> = {
  music: 'Nothing playing',
  game: 'No game running',
  battery: 'No battery here',
  downloads: 'Nothing downloading',
  clipboard: 'Nothing copied yet',
  claude: 'No Claude chats',
  calendar: 'No calendar yet',
  weather: 'Getting the weather',
  reminders: 'Nothing coming up',
  system: 'Reading',
  timer: 'No timer',
};

/** The card a widget shows with no tile: why there is nothing. */
export function idleTile(kind: string, idle: 'off' | 'quiet' | null): Tile {
  const label = kindLabel(kind);
  const icon = WIDGET_KINDS.find((k) => k.kind === kind)?.icon ?? 'info';
  return idle === 'off'
    ? { key: `${kind}/none`, span: 2, rows: 1, body: { k: 'stat', icon, label, value: `${label} is off`, sub: 'Turn it on in Activities' } }
    : { key: `${kind}/none`, span: 2, rows: 1, body: { k: 'stat', icon, label, value: QUIET[kind] ?? 'Nothing right now' } };
}

/** What a widget's right-click menu changes. */
export interface WidgetPref {
  id: string;
  locked?: boolean;
  size?: string;
  remove?: boolean;
}

// ------------------------------------------------------------------ the island's side

export interface WidgetHostHooks {
  /** Every Control Center tile as the island would draw it now. */
  tiles(now: number): Tile[];
  /** A press in a widget: one of its tile's `act:<activity>:<name>` actions. */
  act(action: string, arg: unknown): void;
  /** The widgets' saved places or choices changed. */
  save(): void;
  /** The island's own look. */
  look(): { accent: string; color: PillColor; glass?: number; tint?: number; custom?: string; tinted?: boolean; reduce: boolean };
  /** Its activity runs (the clock always does). */
  enabled(kind: string): boolean;
}

export class WidgetHost {
  private syncKey = '';
  private readonly sent = new Map<string, string>();
  private offs: Array<() => void> = [];

  constructor(
    private readonly hooks: WidgetHostHooks,
    private readonly get: () => { on: boolean; items: DesktopWidget[]; look: ItemLook },
  ) {}

  async start(): Promise<void> {
    this.offs.push(
      await on<{ action: string; arg: unknown }>('widget-act', (e) => {
        if (typeof e?.action === 'string' && e.action.startsWith('act:')) this.hooks.act(e.action, e.arg);
      }),
      await on<{ id: string; x: number; y: number }>('widget-moved', (e) => {
        const w = this.get().items.find((x) => x.id === e?.id);
        if (!w || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return;
        w.x = Math.round(e.x);
        w.y = Math.round(e.y);
        this.hooks.save();
      }),
      await on<WidgetPref>('widget-pref', (p) => this.pref(p)),
      await on<{ id: string }>('widget-ready', (e) => {
        if (e?.id) this.sent.delete(e.id);
        this.tick(Date.now());
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    void native.widgetsSync([]);
  }

  /** A widget's right-click menu: lock it, size it, or take it off the desktop. */
  pref(p: WidgetPref | null): void {
    const settings = this.get();
    const w = settings.items.find((x) => x.id === p?.id);
    if (!p || !w) return;
    const before = JSON.stringify(settings.items);
    if (p.remove === true) settings.items.splice(settings.items.indexOf(w), 1);
    if (typeof p.locked === 'boolean') {
      if (p.locked) w.locked = true;
      else delete w.locked;
    }
    if (typeof p.size === 'string' && /^[12]x[124]$/.test(p.size)) w.size = p.size;
    if (JSON.stringify(settings.items) === before) return;
    this.hooks.save();
    this.tick(Date.now());
  }

  /** Once a second (and when asked): windows in line with the settings, and each one's tile if it changed. */
  tick(now: number): void {
    const { on: enabled, items } = this.get();
    const live = enabled ? items : [];
    const tiles = live.some((w) => w.kind !== 'clock') ? this.hooks.tiles(now) : [];
    const key = JSON.stringify(live.map((w) => [w.id, w.kind]));
    const tileOf = (w: DesktopWidget): Tile | null => {
      const t = w.kind === 'clock' ? null : tileFor(w.kind, tiles);
      return t ? sized(t, w.size) : null;
    };
    const sizes = live.map((w) => {
      const t = tileOf(w);
      return t ? sizeFor(t.w ?? t.span ?? 2, t.h ?? t.rows ?? 1) : w.kind === 'clock' ? { w: 300, h: 150 } : sizeFor(2, 1);
    });
    if (key !== this.syncKey) {
      this.syncKey = key;
      this.sent.clear();
      void native.widgetsSync(live.map((w, i) => ({ id: w.id, x: w.x, y: w.y, w: sizes[i].w, h: sizes[i].h })));
    }
    const island = this.hooks.look();
    const look = { ...island, ...lookOf(this.get().look, island) };
    for (const w of live) {
      const t = tileOf(w);
      const offered = sizesOf(t);
      // The size it has: the one picked, else its tile's own (so the menu ticks the right one).
      const own = t ? `${t.w ?? t.span ?? 1}x${t.h ?? t.rows ?? 1}` : '';
      const size = w.size && offered.some(([v]) => v === w.size) ? w.size : offered.some(([v]) => v === own) ? own : '';
      const idle = t || w.kind === 'clock' ? null : this.hooks.enabled(w.kind) ? 'quiet' : 'off';
      const frame: WidgetFrame = { kind: w.kind, tile: t, ...look, locked: w.locked === true, sizes: offered, size, idle };
      const json = JSON.stringify(frame);
      if (this.sent.get(w.id) === json) continue;
      this.sent.set(w.id, json);
      // Every window hears every event, so each widget has its own event name.
      void sendTo(`widget-${w.id}`, `widget-frame-${w.id}`, frame);
    }
  }
}

// ------------------------------------------------------------------ the widget window

function clockText(now: Date): { day: string; date: string; time: string } {
  return {
    day: now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase(),
    date: now.toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase(),
    time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  };
}

/**
 * A widget's right-click menu (Windows' own, so it is never cut off by the widget's small window):
 * lock it in place, its sizes when it has any, remove it, and Settings › Widgets.
 */
async function widgetMenu(f: WidgetFrame, pref: (p: Omit<WidgetPref, 'id'>) => void): Promise<void> {
  const items = [
    await CheckMenuItem.new({ text: 'Lock in place', checked: f.locked, action: () => pref({ locked: !f.locked }) }),
  ];
  const sizes = f.sizes.length ? [await PredefinedMenuItem.new({ item: 'Separator' })] : [];
  for (const [value, label] of f.sizes) {
    const on = f.size ? f.size === value : false;
    sizes.push(await CheckMenuItem.new({ text: `${label} size`, checked: on, action: () => pref({ size: value }) }));
  }
  const menu = await Menu.new({
    items: [
      ...items,
      ...sizes,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Remove widget', action: () => pref({ remove: true }) }),
      await MenuItem.new({ text: 'Widget settings…', action: () => void native.openApp('widgets') }),
    ],
  });
  await menu.popup();
}

/** Pressing one of these in a widget uses it; pressing anywhere else drags the widget. */
const PRESSABLE = 'button, input, textarea, select, a, .sbtn, .pl-btn';

/**
 * This window's widget: waits for its frame and draws it, reports presses on its buttons, fits
 * its window to its content, and moves when dragged by anything but a button (the island saves
 * where it was left).
 */
export async function runWidget(stage: HTMLElement, label = windowLabel): Promise<void> {
  const id = label.slice('widget-'.length);
  const root = document.documentElement;
  root.classList.add('widget-window');
  let drawn = false;
  let lastSize = '';

  const fit = (w: number, h: number) => {
    const size = `${Math.ceil(w)}x${Math.ceil(h)}`;
    if (size === lastSize) return;
    lastSize = size;
    void native.widgetSize(Math.ceil(w), Math.ceil(h));
  };
  const sheet = new SheetRenderer(
    stage,
    (action, arg) => {
      if (action.startsWith('act:')) void sendTo('island', 'widget-act', { action, arg });
    },
    () => {
      const r = sheet.rect;
      if (r && sheet.visible) fit(r.x + r.w + PAD, r.y + r.h + PAD);
    },
  );

  let clock: HTMLElement | null = null;
  let current: WidgetFrame | null = null;
  const pref = (p: Omit<WidgetPref, 'id'>) => void sendTo('island', 'widget-pref', { id, ...p });
  const drawClock = () => {
    if (!clock) return;
    const t = clockText(new Date());
    clock.querySelector('.wc-day')!.textContent = t.day;
    clock.querySelector('.wc-date')!.textContent = t.date;
    clock.querySelector('.wc-time')!.textContent = `- ${t.time} -`;
    const r = clock.getBoundingClientRect();
    fit(r.width + PAD * 2, r.height + PAD * 2);
  };

  const draw = (f: WidgetFrame) => {
    current = f;
    root.classList.toggle('locked', f.locked);
    root.style.setProperty('--accent', f.accent);
    applyPill(root, f.color, f.custom, f.tinted);
    applyGlass(root, f.glass, f.tint);
    root.classList.toggle('reduce', f.reduce);
    if (f.kind === 'clock') {
      sheet.show(null, { anchor: 'top', area: { width: 300, height: 600 }, width: 300, immediate: true });
      if (!clock) {
        clock = document.createElement('div');
        clock.className = 'wc';
        for (const c of ['wc-day', 'wc-date', 'wc-time']) {
          const e = document.createElement('div');
          e.className = c;
          clock.append(e);
        }
        stage.append(clock);
      }
      drawClock();
      return;
    }
    clock?.remove();
    clock = null;
    // An activity that is off (or has nothing now) still gets a card, saying which.
    const shown: Tile = f.tile ?? idleTile(f.kind, f.idle);
    const w = shown.w ?? shown.span ?? 2;
    const h = shown.h ?? shown.rows ?? 1;
    const width = w * CELL + (w - 1) * GAP + 28;
    const area = { width: width + PAD * 2, height: 3000 };
    const v: SheetView = {
      key: `widget:${f.kind}`,
      wide: true,
      width,
      blocks: [{ t: 'tiles', key: 'tile', items: [{ ...shown, page: 0, col: 0, row: 0, w, h }], cols: w, rows: h, pages: 1, cell: CELL }],
    };
    // The card hangs from a point PAD from the window's top, centred.
    sheet.follow({ x: area.width / 2, y: PAD - 8, w: 0, h: 0 });
    sheet.show(v, { anchor: 'top', area, width, immediate: !drawn });
    // Music's colour from the art, as the island's music card takes it (Moss, 11-18): the card's
    // glass fades to it, and over to the next song's.
    const tint = shown.tint && /^[#\w\s(),.%-]+$/.test(shown.tint) ? shown.tint : null;
    if (tint) sheet.el.style.setProperty('--card-tint', tint);
    sheet.el.classList.toggle('tinted', tint !== null);
    drawn = true;
  };

  await on<WidgetFrame>(`widget-frame-${id}`, draw);
  // The whole widget is a handle (unless locked). Caught before the card sees it, so holding a tile
  // never starts arranging it as in Control Center; Windows moves the window until the button is
  // let go. Buttons on the card stay buttons.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(PRESSABLE)) return;
      e.stopPropagation();
      if (current?.locked) return;
      e.preventDefault();
      void native.widgetDrag();
    },
    { capture: true },
  );
  // Where it was left is saved once it stops moving.
  let settle: ReturnType<typeof setTimeout> | undefined;
  void native.onMoved(() => {
    clearTimeout(settle);
    settle = setTimeout(() => void native.widgetMoved(), 400);
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isTauri && current) void widgetMenu(current, pref).catch((err) => void native.log(`widget menu: ${String(err)}`));
  });
  setInterval(drawClock, 1000);
  void sendTo('island', 'widget-ready', { id });
}
