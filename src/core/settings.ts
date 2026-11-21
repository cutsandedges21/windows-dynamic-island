// The settings schema. Rust stores the blob; this module owns its shape,
// defaults and migration, and keeps both windows in sync.

import { cleanWidgets } from './widgets';
import { CATALOG, type Band, type Behavior } from '../activities/catalog';
import { normalizeWidths, type Anchor, type IslandSize, type Widths } from './layout';
import { FULL_FADE, normalizeFadeShown, type FadeShown } from './fade-menu';
import { CUSTOM_DEFAULT, GLASS_DEFAULT, hexIsLight, pillHex } from './glass';
import { SOUND_PACKS } from './sound-packs';
import { DEFAULT_ICON_ONLY, DEFAULT_MENU_ORDER, FULL_MENU, normalizeIconOnly, normalizeMenuOrder, type MenuIconOnly, type MenuItemId, type MenuShown } from './menu';

export type DisplayMode = 'primary' | 'cursor' | 'active' | 'specific' | 'duplicate';

export interface ActivityConfig extends Behavior {
  enabled: boolean;
  priority: Band;
  options: Record<string, unknown>;
  /** Pointed at: 'wide' widens the pill, 'card' grows a card out of it, 'below' hangs one under it. Unset: growsOf's default. */
  grows?: Grows;
}

/**
 * How an activity grows when pointed at. Two are Claude's alone: 'below' is the card hanging under
 * the pill (Claude Code's look: its limits, tokens and chats), and 'more', its default, is Claude
 * Status's small card grown out of the pill, whose ⌄ opens the rest of that card under the rows.
 */
export type Grows = 'wide' | 'card' | 'below' | 'more';

/** Only Claude's card can hang below the pill or open for more (Activities › Grows). */
export const GROWS_BELOW = 'claude';

/** The choices an activity offers: Sideways and Into a card, and for Claude also Below and Card with more. */
export function growsChoices(id: string): Grows[] {
  return id === GROWS_BELOW ? ['wide', 'card', 'below', 'more'] : ['wide', 'card'];
}

/**
 * An activity's own choice, else the island's default (Settings › When pointed at). With `id`, a
 * choice that activity doesn't offer is ignored, and Claude falls back to its card with more.
 */
export function growsOf(c: Pick<ActivityConfig, 'grows'> | undefined, fallback: Grows, id?: string): Grows {
  if (id === undefined) return c?.grows ?? fallback;
  if (c?.grows && growsChoices(id).includes(c.grows)) return c.grows;
  return id === GROWS_BELOW ? 'more' : fallback;
}

/** Cell sizes in the open island's grid: columns x rows. */
export type TileSize = '1x1' | '2x1' | '1x2' | '2x2' | '1x4' | '2x4' | '4x1' | '4x2' | '4x4';
export const TILE_SIZES: TileSize[] = ['1x1', '2x1', '1x2', '2x2'];
/** Every size a tile can be saved at: the four, and the tall ones only the lyrics tile takes. */
export const ALL_TILE_SIZES: TileSize[] = [...TILE_SIZES, '1x4', '2x4'];
/** Across the whole grid, four columns: only Music (Now playing) stretches that far (Moss, 2026-11-17). */
export const FULL_WIDTH_SIZES: TileSize[] = ['4x1', '4x2', '4x4'];

/** A widget on the desktop (src/core/widgets.ts): an activity's Control Center tile, or the day and time. */
export interface DesktopWidget {
  id: string;
  /** An activity id, or 'clock'. */
  kind: string;
  /** Where its top-left corner is, in physical px on the desktop; -1: not placed yet (it starts down the right side). */
  x: number;
  y: number;
  /** The size picked on its right-click menu ("2x4"), for tiles that show more when bigger. */
  size?: string;
  /** Dragging it is off (right-click, Lock in place). */
  locked?: boolean;
}

/**
 * How widgets or the taskbar look: like the island ('island'), or a colour of their own with
 * the glass slider's value (Settings, Widgets).
 */
export interface ItemLook {
  color: 'island' | PillColor;
  glass: number;
}

/**
 * What the taskbar can show, in its order (Settings › Widgets › Show on the taskbar, or its right-click menu).
 * `hidden` lists the ones taken off, so an item added here shows on saved settings too.
 */
export const DOCK_ITEMS = ['start', 'search', 'arrow', 'apps', 'music', 'timer', 'claude', 'tray', 'battery', 'wifi', 'sound', 'clock', 'notifications', 'settings'] as const;
export type DockItem = (typeof DOCK_ITEMS)[number];

/** The taskbar's items in the order the user dragged them to (Settings › Taskbar & border): known
 *  ones once each in their saved order, then any missing in DOCK_ITEMS' order (Settings' gear, new
 *  on 11-19, comes in last). */
export function barOrder(saved: unknown): DockItem[] {
  const known = new Set<string>(DOCK_ITEMS);
  const out = [...new Set(Array.isArray(saved) ? saved.filter((k): k is DockItem => typeof k === 'string' && known.has(k)) : [])];
  for (const k of DOCK_ITEMS) if (!out.includes(k)) out.push(k);
  return out;
}

/** The taskbar's size (right-click, or Settings › Widgets); Medium is the size it was first built at. */
export const DOCK_SIZES = ['small', 'medium', 'large'] as const;
export type DockSize = (typeof DOCK_SIZES)[number];

/** Which screen edge the taskbar sits along (Settings › Widgets › Taskbar › Position). */
export const DOCK_SIDES = ['bottom', 'left', 'right', 'top'] as const;
export type DockSide = (typeof DOCK_SIDES)[number];

/** The notches that come out of the screen border (Settings › Widgets › Screen border): their size,
 *  Small under the taskbar's Small, Medium the taskbar's Small, Large its Medium. */
export const NOTCH_SIZES = ['small', 'medium', 'large'] as const;
export type NotchSize = (typeof NOTCH_SIZES)[number];
/** The four places a notch can sit: on the left or right side of the screen, near its top or bottom. */
export const NOTCH_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type NotchCorner = (typeof NOTCH_CORNERS)[number];
export interface NotchConfig {
  on: boolean;
  corner: NotchCorner;
  size: NotchSize;
  /** Dragged to a place of its own (Edit position): the side it comes out of and its middle, 0..1
   *  down the screen. Null: at its corner. */
  at: NotchAt | null;
  /** It can be dragged any time, not only while editing its position. */
  free: boolean;
}
export interface NotchAt {
  side: 'left' | 'right';
  y: number;
}

export function cleanAt(v: unknown): NotchAt | null {
  const o = isObj(v) ? v : null;
  if (!o || (o.side !== 'left' && o.side !== 'right') || typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
  return { side: o.side, y: Math.min(1, Math.max(0, o.y)) };
}
/** A website pinned to the Websites notch. */
export interface PinnedSite {
  url: string;
  title: string;
}
/** The screen border's width, CSS px. */
export const FRAME_W = 4;

/** Websites pinned at most. */
export const MAX_SITES = 16;

/**
 * The screen border (Settings › Widgets › Screen border): a thin line round the whole screen that
 * joins the taskbar and the island, with the Websites and Shelf notches coming out of it. `glow`:
 * an activity's light runs round the island only, or round the whole border.
 */
export interface FrameConfig {
  on: boolean;
  glow: 'island' | 'screen';
  sites: NotchConfig;
  shelf: NotchConfig;
  /** The border's and the notches' own look (Moss, 11-19); colour 'island' here: like the taskbar. */
  look: ItemLook;
  /** They wait faint until the pointer comes to the screen's edge. */
  autoHide: boolean;
  /** The notches' ends curve out into the edge. */
  melt: boolean;
  /** The notches sit on the edge (off: they float just off it, rounded all round). */
  blend: boolean;
}

/**
 * The border can only be on while the taskbar sits on its edge. The island may float (Moss, 11-19):
 * then the line just runs straight across the top under it; blended, it melts into it.
 */
export function frameAvailable(island: Pick<Settings['island'], 'taskbar'>): boolean {
  return island.taskbar.on && barEdge(island.taskbar);
}

/**
 * At the bottom, Blend into the bottom and Auto-hide live inside Hide Windows' taskbar (Moss, 11-18:
 * on with Windows' own taskbar still there, they look wrong), so there they only count while it hides.
 */
export function barNeedsHidden(t: Pick<Settings['island']['taskbar'], 'side'>): boolean {
  return t.side === 'bottom';
}
export function barEdge(t: Pick<Settings['island']['taskbar'], 'edge' | 'side' | 'hideWindows'>): boolean {
  return t.edge && (!barNeedsHidden(t) || t.hideWindows);
}
export function barAutoHide(t: Pick<Settings['island']['taskbar'], 'autoHide' | 'side' | 'hideWindows'>): boolean {
  return t.autoHide && (!barNeedsHidden(t) || t.hideWindows);
}
/** Fill the width (Justin, 11-20): with its room kept clear of windows, along the bottom, the bar runs the
 *  screen's whole width, its Start, search and apps in the middle and the rest at the ends. */
export function barFill(t: Pick<Settings['island']['taskbar'], 'fill' | 'keepClear' | 'autoHide' | 'side' | 'hideWindows'>): boolean {
  return t.fill && t.keepClear && !barAutoHide(t) && t.side === 'bottom';
}
/** Filling the width square, flat on the edge as Windows' own taskbar (no round corners, no melted ends). */
export function barSquare(t: Pick<Settings['island']['taskbar'], 'fill' | 'keepClear' | 'autoHide' | 'side' | 'hideWindows' | 'square' | 'edge'>): boolean {
  return barFill(t) && t.square && barEdge(t);
}

/** The border is on and can be. */
export function frameOn(island: Pick<Settings['island'], 'taskbar' | 'frame'>): boolean {
  return island.frame.on && frameAvailable(island);
}

/** A notch is on: they need no border (without one they melt into the screen's edge itself). */
export function notchesOn(island: Pick<Settings['island'], 'frame'>): boolean {
  return island.frame.sites.on || island.frame.shelf.on;
}

/** A pasted or dropped link as a site to pin: https:// added when it has no scheme; null if it isn't a web address. */
export function siteOf(text: string, title = ''): PinnedSite | null {
  const raw = text.trim().split(/\s+/)[0] ?? '';
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  const name = title.trim() || url.hostname.replace(/^www\./, '');
  return { url: url.href, title: name.slice(0, 80) };
}

function cleanNotch(v: unknown, corner: NotchCorner): NotchConfig {
  const o = isObj(v) ? v : {};
  return {
    on: o.on === true,
    corner: (NOTCH_CORNERS as readonly unknown[]).includes(o.corner) ? (o.corner as NotchCorner) : corner,
    size: (NOTCH_SIZES as readonly unknown[]).includes(o.size) ? (o.size as NotchSize) : 'small',
    at: cleanAt(o.at),
    free: o.free === true,
  };
}

function cleanSites(v: unknown): PinnedSite[] {
  const out: PinnedSite[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    if (!isObj(s) || typeof s.url !== 'string') continue;
    const site = siteOf(s.url, typeof s.title === 'string' ? s.title : '');
    if (site && !out.some((x) => x.url === site.url)) out.push(site);
    if (out.length >= MAX_SITES) break;
  }
  return out;
}

/** How the taskbar shows what you point at and what is in front (Settings › Widgets, or its right-click
 *  menu), any of them together: Rise (icons grow under the pointer), Spotlight (a light shines down on
 *  the app in front), Glide (a highlight and the name slide along to what you point at), Accent (the
 *  icons that aren't apps' in the accent colour). */
export const DOCK_STYLES = ['rise', 'glide', 'spotlight', 'names', 'accent'] as const;
export type DockStyle = (typeof DOCK_STYLES)[number];

/** The taskbar's styles on, from saved settings: the list, or the one style saved before they could be
 *  mixed, or Rise. */
export function barStyles(saved: Record<string, unknown>): DockStyle[] {
  let out: DockStyle[];
  if (Array.isArray(saved.styles)) out = DOCK_STYLES.filter((k) => (saved.styles as unknown[]).includes(k));
  else if ((DOCK_STYLES as readonly unknown[]).includes(saved.style)) out = [saved.style as DockStyle];
  else out = ['rise'];
  // The names over the bar were part of Glide until 11-19: a bar saved before then with Glide keeps them.
  if (saved.names === undefined && out.includes('glide') && !out.includes('names')) out = DOCK_STYLES.filter((k) => k === 'names' || out.includes(k));
  // The accent-coloured icons were a toggle of their own for a day (11-20): turned on, they are the style.
  if (saved.accentIcons === true && !out.includes('accent')) out = DOCK_STYLES.filter((k) => k === 'accent' || out.includes(k));
  return out;
}

/** The names over the taskbar (style Names): their font and how they sit (Settings › Taskbar › Styles). */
export const NAME_FONTS = ['system', 'clean', 'serif', 'mono', 'hand'] as const;
export type NameFont = (typeof NAME_FONTS)[number];
export const NAME_LOOKS = ['bubble', 'plain', 'outline'] as const;
export type NameLook = (typeof NAME_LOOKS)[number];
export interface NameStyle {
  font: NameFont;
  look: NameLook;
  bold: boolean;
}

/** Start's pinned apps (name and target, at most 30); null while never set (it starts from the taskbar's). */
export function cleanPins(v: unknown): Array<{ name: string; target: string }> | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((a): a is { name: string; target: string } => isObj(a) && typeof a.name === 'string' && typeof a.target === 'string' && a.target.length > 0 && a.target.length < 1000)
    .slice(0, 30)
    .map((a) => ({ name: a.name.slice(0, 200), target: a.target }));
}

/** A folder of apps on the taskbar (dock.ts DockFolder): its apps by their keys (lower-case targets). */
export interface DockFolder {
  id: string;
  name: string;
  apps: string[];
}

/** The taskbar's folders as saved: each with an id (the first of a repeated one kept), a name, its apps. */
export function cleanDockFolders(v: unknown): DockFolder[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set<string>();
  const out: DockFolder[] = [];
  for (const f of v.slice(0, 30)) {
    if (!isObj(f) || typeof f.id !== 'string' || !f.id || f.id.length > 64 || ids.has(f.id) || !Array.isArray(f.apps)) continue;
    ids.add(f.id);
    const name = typeof f.name === 'string' ? f.name.trim().slice(0, 40) : '';
    const apps = f.apps.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 1000).map((k) => k.toLowerCase());
    out.push({ id: f.id, name: name || 'Folder', apps: [...new Set(apps)].slice(0, 30) });
  }
  return out;
}

export function cleanNames(v: unknown): NameStyle {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    font: (NAME_FONTS as readonly unknown[]).includes(o.font) ? (o.font as NameFont) : 'system',
    look: (NAME_LOOKS as readonly unknown[]).includes(o.look) ? (o.look as NameLook) : 'bubble',
    bold: o.bold === true,
  };
}

/** The taskbar's own height, stretched in Edit position (a zoom like its sizes'); null: its size's. */
export function barScale(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(BAR_SCALE.max, Math.max(BAR_SCALE.min, v)) : null;
}
export const BAR_SCALE = { min: 0.7, max: 1.5 };

/** How much taller than its size the taskbar is (CSS px before its zoom), stretched by its top in Edit
 *  position: only taller, what it holds keeps its size (Justin, 11-19: "higher not wider too"). */
export function barTall(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(BAR_TALL_MAX, Math.round(v)) : 0;
}
export const BAR_TALL_MAX = 60;

/** The taskbar's least length (CSS px before its zoom), stretched in Edit position; 0: as long as what it holds. */
export function barMinLen(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(4000, Math.round(v)) : 0;
}

export const ITEM_COLORS: ReadonlyArray<ItemLook['color']> = ['island', 'black', 'white', 'matte-black', 'matte-white', 'glass', 'tinted'];

function cleanLook(v: unknown): ItemLook {
  const o = isObj(v) ? v : {};
  const color = ITEM_COLORS.includes(o.color as ItemLook['color']) ? (o.color as ItemLook['color']) : 'island';
  const glass = typeof o.glass === 'number' && Number.isFinite(o.glass) ? Math.max(0, Math.min(100, Math.round(o.glass))) : GLASS_DEFAULT;
  return { color, glass };
}

/** How the user arranged the open island's grid (long-press a tile to edit). */
export interface GridLayout {
  /** Older builds' tile order, used as the starting layout while `pages` is empty. */
  order: string[];
  sizes: Record<string, TileSize>;
  /** Tiles taken off the grid. */
  hidden: string[];
  /**
   * Each page's tiles in reading order (src/core/grid.ts); null is an empty cell the
   * user left. Empty until the user first moves or resizes a tile.
   */
  pages: Array<Array<string | null>>;
}

/** tinted: the taskbar's and widgets' near-black with a blue tint, as Windows' own dark taskbar (Justin, 11-20).
 *  custom: a colour you pick (Settings › Appearance › Pill colour › Custom; island.custom). */
export type PillColor = 'black' | 'white' | 'matte-white' | 'matte-black' | 'glass' | 'tinted' | 'custom';

/** The chimes Island synthesizes (src/core/sounds.ts). */
export type SynthStyle = 'soft' | 'glass' | 'pop' | 'bell' | 'retro';
export const SYNTH_STYLES: SynthStyle[] = ['soft', 'glass', 'pop', 'bell', 'retro'];
/** How the chime sounds: synthesized, a pack that ships with Island (src/core/sound-packs.ts) by
 *  its id, or custom: your own files. */
export type SoundStyle = SynthStyle | 'custom' | (string & {});

export function soundStyleKnown(style: string): boolean {
  return (SYNTH_STYLES as string[]).includes(style) || style === 'custom' || SOUND_PACKS.some((p) => p.id === style);
}


export const SETTINGS_VERSION = 8;

export interface Settings {
  version: number;
  island: {
    anchor: Anchor;
    display: DisplayMode;
    displayId: string | null;
    /** Duplicate mode: every screen that shows the pill. */
    displayIds: string[];
    widths: Widths;
    /** Gap between the pill and its screen edge, CSS px. */
    edge: number;
    /** Blend into the edge: the pill sits on its screen edge, flat along it, instead of floating (no gap). */
    blend: boolean;
    /** The pill (compact), or the pill and every card (all), in the playing song's album colour. */
    albumTint: 'off' | 'compact' | 'all';
    size: IslandSize;
    /** What the island does when nothing is happening. */
    idle: 'pill' | 'hidden';
    hoverExpand: boolean;
    hideInFullscreen: boolean;
    showSecondary: boolean;
    /**
     * The other activities' small icons on the resting (compact) pill (Moss, 11-20): `show` always,
     * only while pointed at, or never; `side` which end of the pill they sit at.
     */
    compactIcons: { show: 'always' | 'hover' | 'never'; side: 'start' | 'end' };
    accent: string;
    /** The pill's own colour, and the card's under it. */
    color: PillColor;
    /** Glass only, like iOS Liquid Glass: 0 is clear, 100 is tinted (less of what is behind shows through). */
    glass: number;
    /** Custom only: the pill's own colour, #rrggbb. */
    custom: string;
    reduceMotion: 'system' | 'on' | 'off';
    /** How fast the border glow moves, or off. */
    glow: 'off' | 'slow' | 'medium' | 'fast';
    /** What hovering the island shows: the card of whatever is pointed at, or always Claude's stats. */
    hoverCard: 'pointer' | 'claude';
    /** How a persistent activity grows when pointed at, unless it has its own choice (Activities › Grows). */
    defaultGrows: Exclude<Grows, 'below' | 'more'>;
    /** Tapping Ctrl over the pill fades it and lets clicks through to what is behind. */
    peekThrough: boolean;
    /** That fade lasts until the pointer comes back onto the island, not just until it moves off. */
    peekUntilBack: boolean;
    /** The bot in its bubble beside the pill (src/core/bubble.ts). */
    bot: boolean;
    grid: GridLayout;
    /** Widgets on the desktop, under your windows (Settings, Widgets). Off until turned on. */
    widgets: { on: boolean; items: DesktopWidget[]; look: ItemLook };
    /**
     * The taskbar at the bottom (src/core/dock.ts); `hideWindows`: Windows' own taskbar hides itself
     * meanwhile; `centre`: where it was dragged to, 0..1 across the screen (-1: the middle), and `centres` the
     * other screens' taskbars' (by screen: each screen's keeps its own place, Moss 11-20); `screens`: a
     * taskbar on every screen ('all') or on the main one only; `edge`: it
     * sits on the screen's bottom edge, over Windows' taskbar, instead of floating above it; `melt`: there,
     * its ends curve out into the edge instead of going straight down; `styles`: the ones on, together;
     * `autoHide`: it waits faint on its edge until the pointer comes to it (as under a full-screen app).
     */
    taskbar: { on: boolean; hideWindows: boolean; centre: number; centres: Record<string, number>; screens: 'all' | 'main'; look: ItemLook; scale: number | null; minLen: number; tall: number; hidden: DockItem[]; order: DockItem[]; size: DockSize; styles: DockStyle[]; edge: boolean; melt: boolean; side: DockSide; autoHide: boolean; names: NameStyle; startOpens: 'island' | 'windows'; startKey: boolean; startPins: Array<{ name: string; target: string }> | null; accentBorder: boolean; keepClear: boolean; fill: boolean; square: boolean; songOpens: 'app' | 'tile'; songTint: boolean; barTint: boolean; folders: DockFolder[]; startFolders: DockFolder[] };
    /** The screen border and its notches (Settings › Widgets › Screen border). */
    frame: FrameConfig;
    /** The Websites notch's sites, in order. */
    sites: PinnedSite[];
    /** The island is off the screen until this time (epoch ms); 0: shown. HIDE_UNTIL_SHOWN: until the user brings it back. */
    hiddenUntil: number;
    /** Faded from the right-click menu's Fade: see-through and click-through until Show (kept across restarts). */
    faded: boolean;
    /** Smart fade: faded whenever the pointer is off the island; pop-ups still show in full. */
    smartFade: boolean;
    /** What the right-click menu's Fade card shows (Settings › Behavior › Fade the island). */
    fadeCard: FadeShown;
    /** What the right-click menu shows (src/core/menu.ts); Settings is always in it, whatever this says. */
    menu: MenuShown;
    /** The right-click menu's order (Settings � Behavior � Right-click menu, by dragging); Settings stays last. */
    menuOrder: MenuItemId[];
    /** Which of its items show only their icon, their name in a tip. */
    menuIconOnly: MenuIconOnly;
    /** Settings' gear in the menu: icon only (as it came) or with its name. */
    menuSettingsIconOnly: boolean;
  };
  activities: {
    order: string[];
    config: Record<string, ActivityConfig>;
  };
  general: {
    startWithWindows: boolean;
    notifications: boolean;
    sounds: boolean;
    sound: {
      style: SoundStyle;
      /** 0 to 100; 50 is the chime's first loudness. */
      volume: number;
      /** The names of your own files (style custom); '' for none, and the Soft chime plays. */
      done: string;
      attention: string;
      /** Goes up when a file is picked or removed, so the island loads it again. */
      rev: number;
    };
    /** Do not disturb: nothing auto-expands, only interrupts marked urgent. */
    dnd: boolean;
    toggleHotkey: string;
    activitiesHotkey: string;
    /** The first-run setup (src/welcome.ts) was finished or skipped. */
    onboarded: boolean;
    /** Install newer Island.exe releases from GitHub on their own (src-tauri/src/updater.rs). */
    autoUpdate: boolean;
    /** The same notifications also go to the ntfy app on a phone (src-tauri/src/phone.rs). */
    phonePush: boolean;
    /** The private ntfy.sh topic the phone subscribes to; made when phone pushes are first turned on. */
    phoneTopic: string;
    /** Claude's permission pushes carry Allow and Deny buttons that answer from the phone. */
    phoneApprove: boolean;
    /** The second private topic those buttons post to; made when phoneApprove is first turned on. */
    phoneReplyTopic: string;
    /** Settings › Your phone › Terminal from your phone: a paired phone may open a terminal here (src-tauri/src/term). */
    phoneTerminal: boolean;
  };
  privacy: {
    clipboardContent: boolean;
    screenshotPreview: boolean;
  };
}

/** A private ntfy topic for Send to my phone. Knowing it is all it takes to read the pushes, so it is long and random. */
export function newPhoneTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `island-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Orange stays Claude's colour, so the island's own default is sky. In the order the swatches show:
 *  white and silver, then round the colour wheel (Justin, 11-19: more colours). */
export const ACCENTS: Record<string, string> = {
  white: '#ffffff',
  silver: '#a9b4c2',
  red: '#ee6a6a',
  ember: '#e8845f',
  gold: '#e3b34f',
  lime: '#a8d45c',
  mint: '#62c99a',
  teal: '#43c2c0',
  sky: '#6aa6e8',
  indigo: '#7d86f0',
  violet: '#a58cf0',
  magenta: '#d873df',
  rose: '#ea7aa1',
};

/** The accent as the pill draws it: white turns dark on a white or matte white pill, where it would vanish. */
export function accentColor(island: Settings['island']): string {
  const c = ACCENTS[island.accent] ?? island.accent ?? ACCENTS.ember;
  const light = island.color === 'white' || island.color === 'matte-white' || (island.color === 'custom' && hexIsLight(island.custom));
  return light && c.toLowerCase() === '#ffffff' ? '#1c1c1e' : c;
}

export function defaultActivityConfig(id: string): ActivityConfig {
  const meta = CATALOG.find((m) => m.id === id);
  const options: Record<string, unknown> = {};
  // A secret option has no value here: the key lives in the Credential Manager, not in settings.
  for (const o of meta?.options ?? []) if (o.type !== 'secret' && o.type !== 'heading') options[o.key] = o.default;
  return {
    enabled: meta?.enabled ?? false,
    priority: meta?.priority ?? 'low',
    ...(meta?.behavior ?? { autoShow: true, persistent: false, interactive: true, interrupt: false }),
    options,
  };
}

export function defaultSettings(): Settings {
  const config: Record<string, ActivityConfig> = {};
  for (const m of CATALOG) config[m.id] = defaultActivityConfig(m.id);
  return {
    version: SETTINGS_VERSION,
    island: {
      anchor: 'top',
      display: 'primary',
      displayId: null,
      displayIds: [],
      widths: normalizeWidths(null),
      edge: 8,
      // Floating, as it always was; Blend into the top is a choice.
      blend: false,
      albumTint: 'off',
      size: 'medium',
      idle: 'pill',
      hoverExpand: true,
      // Moss: the island stays on screen over full-screen apps and videos too.
      hideInFullscreen: false,
      showSecondary: true,
      compactIcons: { show: 'always', side: 'end' },
      accent: 'sky',
      color: 'black',
      glass: GLASS_DEFAULT,
      custom: CUSTOM_DEFAULT,
      reduceMotion: 'system',
      glow: 'medium',
      hoverCard: 'pointer',
      defaultGrows: 'card',
      peekThrough: true,
      peekUntilBack: false,
      bot: true,
      grid: { order: [], sizes: {}, hidden: [], pages: [] },
      widgets: { on: false, items: [], look: { color: 'island', glass: GLASS_DEFAULT } },
      taskbar: { on: false, hideWindows: true, centre: -1, centres: {}, screens: 'all', look: { color: 'island', glass: GLASS_DEFAULT }, scale: null, minLen: 0, tall: 0, hidden: [], order: [...DOCK_ITEMS], size: 'medium', styles: ['rise'], edge: false, melt: false, side: 'bottom', autoHide: false, names: { font: 'system', look: 'bubble', bold: false }, startOpens: 'island', startKey: false, startPins: null, accentBorder: false, keepClear: false, fill: false, square: false, songOpens: 'app', songTint: true, barTint: false, folders: [], startFolders: [] },
      frame: { on: false, glow: 'island', sites: { on: false, corner: 'bottom-left', size: 'small', at: null, free: false }, shelf: { on: false, corner: 'bottom-right', size: 'small', at: null, free: false }, look: { color: 'island', glass: GLASS_DEFAULT }, autoHide: false, melt: true, blend: true },
      sites: [],
      hiddenUntil: 0,
      faded: false,
      smartFade: false,
      fadeCard: { ...FULL_FADE },
      menu: { ...FULL_MENU },
      menuOrder: [...DEFAULT_MENU_ORDER],
      menuIconOnly: { ...DEFAULT_ICON_ONLY },
      menuSettingsIconOnly: true,
    },
    activities: { order: CATALOG.map((m) => m.id), config },
    general: {
      startWithWindows: false,
      notifications: true,
      sounds: false,
      sound: { style: 'soft', volume: 50, done: '', attention: '', rev: 0 },
      dnd: false,
      toggleHotkey: 'Alt+Shift+Space',
      activitiesHotkey: 'Alt+Shift+A',
      onboarded: false,
      autoUpdate: true,
      phonePush: false,
      phoneTopic: '',
      phoneApprove: false,
      phoneReplyTopic: '',
      // Off until switched on at the PC: a terminal runs any command.
      phoneTerminal: false,
    },
    privacy: { clipboardContent: true, screenshotPreview: true },
  };
}

type Json = Record<string, unknown>;

/** Sound (Justin's), Brightness and Caps Lock (Moss's): one activity, System Controls, since the forks merged. */
const INTO_CONTROLS = ['sound', 'brightness', 'keys'];
/**
 * Their Control Center tiles under System Controls' keys, for a saved grid. An entry naming a whole
 * activity ('sound', as setup hides helpers) hides only that one's tile; Caps Lock never had one.
 */
const CONTROLS_TILES: Record<string, string> = {
  'sound/sound': 'system-controls/sound',
  sound: 'system-controls/sound',
  'brightness/brightness': 'system-controls/brightness',
  brightness: 'system-controls/brightness',
  keys: '',
};
const controlsTile = (key: string) => CONTROLS_TILES[key] ?? key;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Saved values over the defaults, key by key; unknown or mistyped values fall back. */
function mergeInto<T>(base: T, saved: unknown): T {
  if (!isObj(base) || !isObj(saved)) return base;
  const out: Json = { ...base };
  for (const [k, def] of Object.entries(base)) {
    const v = saved[k];
    if (v === undefined) continue;
    if (isObj(def)) out[k] = mergeInto(def, v);
    else if (def === null || typeof v === typeof def) out[k] = v;
  }
  return out as T;
}

export function migrate(saved: unknown): Settings {
  const base = defaultSettings();
  if (!isObj(saved)) return base;
  const out = mergeInto(base, saved);
  out.island.widths = normalizeWidths(out.island.widths);
  out.island.edge = Math.max(0, Math.min(64, Number(out.island.edge) || 0));
  if (!['top', 'bottom', 'left', 'right'].includes(out.island.anchor)) out.island.anchor = 'top';
  if (!['off', 'slow', 'medium', 'fast'].includes(out.island.glow)) out.island.glow = 'medium';
  if (!['pointer', 'claude'].includes(out.island.hoverCard)) out.island.hoverCard = 'pointer';
  if (!['off', 'compact', 'all'].includes(out.island.albumTint)) out.island.albumTint = 'off';
  if (out.island.defaultGrows !== 'wide' && out.island.defaultGrows !== 'card') out.island.defaultGrows = 'card';
  // 0.2.4 called matte white "silver" and matte black "blur".
  const renamed: Record<string, PillColor> = { silver: 'matte-white', blur: 'matte-black' };
  out.island.color = renamed[out.island.color] ?? out.island.color;
  if (!['black', 'white', 'matte-white', 'matte-black', 'glass', 'custom'].includes(out.island.color)) out.island.color = 'black';
  out.island.custom = pillHex(out.island.custom);
  out.island.fadeCard = normalizeFadeShown(out.island.fadeCard);
  if (!['always', 'hover', 'never'].includes(out.island.compactIcons.show)) out.island.compactIcons.show = 'always';
  if (out.island.compactIcons.side !== 'start' && out.island.compactIcons.side !== 'end') out.island.compactIcons.side = 'end';
  // Justin's 0.2.11 saved the glass slider; Moss's 0.4.2 had none and gets the old look.
  out.island.glass = Number.isFinite(out.island.glass) ? Math.max(0, Math.min(100, out.island.glass)) : GLASS_DEFAULT;
  const snd = out.general.sound;
  if (!soundStyleKnown(snd.style)) snd.style = 'soft';
  snd.volume = Math.round(Math.max(0, Math.min(100, Number.isFinite(snd.volume) ? snd.volume : 50)));

  // Activity configs: merge each known one; options keep any extra saved keys.
  const savedActs = isObj(saved.activities) ? saved.activities : {};
  const savedCfg = isObj(savedActs.config) ? savedActs.config : {};
  for (const m of CATALOG) {
    const def = defaultActivityConfig(m.id);
    const s = savedCfg[m.id];
    const merged = mergeInto(def, s);
    merged.options = { ...def.options, ...(isObj(s) && isObj(s.options) ? s.options : {}) };
    // Whatever ends up under a secret option's name (a paste in the wrong place) is dropped, not kept.
    for (const o of m.options) if (o.type === 'secret') delete merged.options[o.key];
    if (!['high', 'medium', 'low'].includes(merged.priority)) merged.priority = def.priority;
    // Unset by default, so it is not in `def` for mergeInto to carry over; only a choice this activity offers.
    if (isObj(s) && growsChoices(m.id).includes(s.grows as Grows)) merged.grows = s.grows as Grows;
    // Built into Island (Land): on, whatever an older version saved.
    if (m.builtIn) merged.enabled = true;
    out.activities.config[m.id] = merged;
  }
  // 0.3.0: Ask Claude's choice of backend moved into the bot's chat (Local AI's entry); its key keeps its name.
  const askOpts = isObj(savedCfg.ask) && isObj(savedCfg.ask.options) ? savedCfg.ask.options : null;
  const localOpts = isObj(savedCfg.local) && isObj(savedCfg.local.options) ? savedCfg.local.options : null;
  if (askOpts && (askOpts.backend === 'api' || askOpts.backend === 'claude-code') && !(localOpts && 'backend' in localOpts) && out.activities.config.local) {
    out.activities.config.local.options.backend = askOpts.backend;
  }
  // System Stats before its priority order: "On the pill" defaulted to CPU and was saved like that.
  // That CPU was never picked; with nothing picked the pill follows the priority's top stat instead.
  const sysOpts = isObj(savedCfg.system) && isObj(savedCfg.system.options) ? savedCfg.system.options : null;
  const show = sysOpts?.show;
  if (sysOpts && !('order' in sysOpts) && Array.isArray(show) && show.length === 1 && show[0] === 'cpu' && out.activities.config.system) {
    out.activities.config.system.options.show = [];
  }
  intoControls(savedCfg, out);
  const statusLeads = intoClaude(savedCfg, out);
  // Order: saved order of known ids, then any new activities in catalog order. System Controls
  // takes the place of the first of the three it took in; Claude takes Claude Status's when only that was on.
  const known = new Set(CATALOG.map((m) => m.id));
  const orderId = (id: unknown) =>
    typeof id !== 'string' ? id : INTO_CONTROLS.includes(id) ? 'system-controls' : id === 'claudeStatus' ? (statusLeads ? 'claude' : null) : id === 'claude' && statusLeads ? null : id;
  const savedOrder = Array.isArray(savedActs.order) ? (savedActs.order as unknown[]).map(orderId) : [];
  const order = savedOrder.filter((id): id is string => typeof id === 'string' && known.has(id));
  for (const m of CATALOG) if (!order.includes(m.id)) order.push(m.id);
  out.activities.order = [...new Set(order)];

  // The grid layout is free-form (tile keys come from activities), so it is checked by hand.
  const savedGrid = isObj(saved.island) && isObj(saved.island.grid) ? saved.island.grid : {};
  const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 120))] : []);
  // Claude Status's tile is Claude's now: the one that leads keeps its place and size, the other goes.
  const claudeTile = (key: string) => (CLAUDE_TILES[key] === undefined ? key : statusLeads ? CLAUDE_TILES[key] : key.startsWith('claudeStatus') ? '' : key);
  const tileKey = (key: string) => claudeTile(controlsTile(key));
  const tiles = (v: unknown) => [...new Set(strings(v).map(tileKey).filter(Boolean))];
  const sizes: Record<string, TileSize> = {};
  if (isObj(savedGrid.sizes)) for (const [k, v] of Object.entries(savedGrid.sizes)) if ((ALL_TILE_SIZES.includes(v as TileSize) || FULL_WIDTH_SIZES.includes(v as TileSize)) && tileKey(k)) sizes[tileKey(k)] = v as TileSize;
  // Pages: tile keys (each on one page at most) and nulls for the empty cells the user left.
  const seen = new Set<string>();
  const pages: Array<Array<string | null>> = [];
  for (const p of Array.isArray(savedGrid.pages) ? savedGrid.pages.slice(0, 24) : []) {
    if (!Array.isArray(p)) continue;
    const list: Array<string | null> = [];
    for (const e of p.slice(0, 96)) {
      if (e === null) list.push(null);
      else if (typeof e === 'string' && e.length > 0 && e.length < 120 && tileKey(e) && !seen.has(tileKey(e))) {
        seen.add(tileKey(e));
        list.push(tileKey(e));
      }
    }
    pages.push(list);
  }
  out.island.grid = { order: tiles(savedGrid.order), sizes, hidden: tiles(savedGrid.hidden), pages };
  const savedWidgets = isObj(saved.island) && isObj(saved.island.widgets) ? saved.island.widgets : {};
  out.island.widgets = { on: savedWidgets.on === true, items: cleanWidgets(savedWidgets.items), look: cleanLook(savedWidgets.look) };
  const savedBar = isObj(saved.island) && isObj(saved.island.taskbar) ? saved.island.taskbar : {};
  // The other screens' taskbars' places (the main one's is `centre`), by screen; at most 16.
  const cleanCentres = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!isObj(v)) return out;
    for (const [k, c] of Object.entries(v).slice(0, 16)) if (k.length > 0 && k.length < 120 && typeof c === 'number' && c >= 0 && c <= 1) out[k] = c;
    return out;
  };
  const centre = typeof savedBar.centre === 'number' && savedBar.centre >= 0 && savedBar.centre <= 1 ? savedBar.centre : -1;
  const barHidden = Array.isArray(savedBar.hidden) ? DOCK_ITEMS.filter((k) => (savedBar.hidden as unknown[]).includes(k)) : [];
  out.island.taskbar = { on: savedBar.on === true, hideWindows: savedBar.hideWindows !== false, centre, centres: cleanCentres(savedBar.centres), screens: savedBar.screens === 'main' ? 'main' : 'all', look: cleanLook(savedBar.look), scale: barScale(savedBar.scale), minLen: barMinLen(savedBar.minLen), tall: barTall(savedBar.tall), hidden: barHidden, order: barOrder(savedBar.order), size: (DOCK_SIZES as readonly unknown[]).includes(savedBar.size) ? (savedBar.size as DockSize) : 'medium', styles: barStyles(savedBar), edge: savedBar.edge === true, melt: savedBar.melt === true, side: (DOCK_SIDES as readonly unknown[]).includes(savedBar.side) ? (savedBar.side as DockSide) : 'bottom', autoHide: savedBar.autoHide === true, names: cleanNames(savedBar.names), startOpens: savedBar.startOpens === 'windows' ? 'windows' : 'island', startKey: savedBar.startKey === true, startPins: cleanPins(savedBar.startPins), accentBorder: savedBar.accentBorder === true, keepClear: savedBar.keepClear === true, fill: savedBar.fill === true, square: savedBar.square === true, songOpens: savedBar.songOpens === 'tile' ? 'tile' : 'app', songTint: savedBar.songTint !== false, barTint: savedBar.barTint === true, folders: cleanDockFolders(savedBar.folders), startFolders: cleanDockFolders(savedBar.startFolders) };
  const savedFrame = isObj(saved.island) && isObj(saved.island.frame) ? saved.island.frame : {};
  out.island.frame = {
    on: savedFrame.on === true,
    glow: savedFrame.glow === 'screen' ? 'screen' : 'island',
    sites: cleanNotch(savedFrame.sites, 'bottom-left'),
    shelf: cleanNotch(savedFrame.shelf, 'bottom-right'),
    look: cleanLook(savedFrame.look),
    autoHide: savedFrame.autoHide === true,
    melt: savedFrame.melt !== false,
    blend: savedFrame.blend !== false,
  };
  out.island.sites = cleanSites(isObj(saved.island) ? saved.island.sites : null);
  out.island.displayIds = strings(isObj(saved.island) ? saved.island.displayIds : null);
  if (!Number.isFinite(out.island.hiddenUntil) || out.island.hiddenUntil < 0) out.island.hiddenUntil = 0;
  out.island.hiddenUntil = Math.min(out.island.hiddenUntil, HIDE_UNTIL_SHOWN);
  // Fade came after 0.4.2: missing (older settings) or junk means not faded.
  if (typeof out.island.faded !== 'boolean') out.island.faded = false;
  if (typeof out.island.smartFade !== 'boolean') out.island.smartFade = false;
  if (typeof out.island.peekUntilBack !== 'boolean') out.island.peekUntilBack = false;


  if (!['primary', 'cursor', 'active', 'specific', 'duplicate'].includes(out.island.display)) out.island.display = 'primary';
  // The menu's order and icon-only choices came after 0.4.2: missing (older settings) means the menu as it always was.
  out.island.menuOrder = normalizeMenuOrder(isObj(saved.island) ? saved.island.menuOrder : null);
  out.island.menuIconOnly = normalizeIconOnly(isObj(saved.island) ? saved.island.menuIconOnly : null);
  if (typeof out.island.menuSettingsIconOnly !== 'boolean') out.island.menuSettingsIconOnly = true;
  // Settings became one of the menu's items (11-19): its gear keeps the look it was saved with.
  const savedIconOnly = isObj(saved.island) ? saved.island.menuIconOnly : null;
  if (!(isObj(savedIconOnly) && typeof savedIconOnly.settings === 'boolean')) out.island.menuIconOnly.settings = out.island.menuSettingsIconOnly;
  out.island.menu.settings = true;

  // Version 2: orange is Claude's alone (the old default accent goes), and Claude no
  // longer holds the pill at rest; it shows when a chat works, finishes or needs you.
  const from = typeof saved.version === 'number' ? saved.version : 1;
  if (from < 2) {
    if (out.island.accent === 'ember') out.island.accent = 'sky';
    if (out.activities.config.claude) out.activities.config.claude.persistent = false;
  }
  // Version 3 adds the first-run setup. Settings saved before it belong to someone who
  // already set Island up by hand, so they are not walked through it again.
  if (from < 3) out.general.onboarded = true;
  // Version 4: Peek behind is on by default, also where an earlier build saved it off.
  if (from < 4) out.island.peekThrough = true;
  // 0.2.6: the island no longer hides behind full-screen apps (Moss); the switch stays for anyone who wants it back.
  if (from < 5) out.island.hideInFullscreen = false;
  // Version 6: Claude pops up for a moment (Claude Status's rule), so the 45 s Reply window that
  // was Claude Code's default goes off for everyone who still had it; another length someone chose stays.
  if (from < 6) {
    const o = out.activities.config.claude?.options;
    if (o && o.replyWindowSeconds === 45) o.replyWindowSeconds = 0;
  }
  // Version 7: a Claude chat that finishes in the window (or terminal tab) in front no longer pops
  // up, also where an earlier build saved that switch off (it was off by default, so never chosen).
  // Version 8 does it again: a development build stamped version 7 on settings before that step
  // existed, so they kept the switch off. Nobody had version 7 for long enough to choose off.
  if (from < 8) {
    const o = out.activities.config.claude?.options;
    if (o) o.onlyOtherChats = true;
  }
  out.version = SETTINGS_VERSION;
  return out;
}

/**
 * Settings from before System Controls (Moss's 0.4.2 had Sound, Brightness and Caps Lock; Justin's
 * 0.2.11 only Sound): on if any of them was. Each one's switch, and its Auto-show (all a flash
 * did), becomes that part's option; one never saved counts as on, as it was by default. Sound's
 * Interactive, priority and Grows carry over (it was the one with buttons). Settings that already have
 * System Controls are left alone.
 */
function intoControls(savedCfg: Json, out: Settings): void {
  const sc = out.activities.config['system-controls'];
  if (!sc || isObj(savedCfg['system-controls']) || !INTO_CONTROLS.some((id) => isObj(savedCfg[id]))) return;
  const cfg = (id: string): Json => (isObj(savedCfg[id]) ? savedCfg[id] : {});
  const on = (id: string) => cfg(id).enabled !== false;
  const shows = (id: string) => on(id) && cfg(id).autoShow !== false;
  const keys = isObj(cfg('keys').options) ? (cfg('keys').options as Json) : {};
  sc.enabled = INTO_CONTROLS.some(on);
  sc.options.volume = shows('sound');
  sc.options.device = shows('sound');
  sc.options.brightness = shows('brightness');
  sc.options.caps = shows('keys') && keys.caps !== false;
  sc.options.num = shows('keys') && keys.num !== false;
  const sound = cfg('sound');
  if (typeof sound.interactive === 'boolean') sc.interactive = sound.interactive;
  if (sound.priority === 'high' || sound.priority === 'medium' || sound.priority === 'low') sc.priority = sound.priority;
  // Justin's 0.2.11 saved how Sound grows when pointed at (hover-cards' Grows).
  if (growsChoices('system-controls').includes(sound.grows as Grows)) sc.grows = sound.grows as Grows;
}

/**
 * Claude Status's tile under Claude's key, for a saved grid (when Claude takes Claude Status's
 * place; otherwise Claude's own tile stays and Claude Status's goes). A whole-activity entry (setup
 * hides by activity) the same way.
 */
const CLAUDE_TILES: Record<string, string> = {
  'claudeStatus/claudeStatus': 'claude/claude',
  claudeStatus: 'claude',
  'claude/claude': '',
  claude: '',
};

/** Claude Status's own switches, which Claude carries now. */
const STATUS_OPTIONS = ['showDone', 'glowInFront'];

/**
 * Claude Code and Claude Status became one activity, Claude (shown as Claude Status). On if either
 * was: Claude Code's saved options carry over as they are, and so do Claude Status's switches. When
 * only Claude Status was on, its behaviour (priority, auto-show, persistent, buttons, interrupt,
 * Grows) and its place in the order and the grid carry over too: returns true then. Settings that
 * never had Claude Status (Moss's 0.4.x) are left as they are.
 */
function intoClaude(savedCfg: Json, out: Settings): boolean {
  const claude = out.activities.config.claude;
  const status = savedCfg.claudeStatus;
  if (!claude || !isObj(status)) return false;
  const code = isObj(savedCfg.claude) ? savedCfg.claude : null;
  const codeOn = code ? code.enabled !== false : (CATALOG.find((m) => m.id === 'claude')?.enabled ?? true);
  const statusOn = status.enabled === true;
  claude.enabled = codeOn || statusOn;
  const opts = isObj(status.options) ? status.options : {};
  for (const key of STATUS_OPTIONS) if (typeof opts[key] === 'boolean') claude.options[key] = opts[key];
  const leads = statusOn && !codeOn;
  if (!leads) return false;
  for (const key of ['autoShow', 'persistent', 'interactive', 'interrupt'] as const) if (typeof status[key] === 'boolean') claude[key] = status[key] as boolean;
  if (status.priority === 'high' || status.priority === 'medium' || status.priority === 'low') claude.priority = status.priority;
  if (growsChoices('claude').includes(status.grows as Grows)) claude.grows = status.grows as Grows;
  else delete claude.grows;
  return true;
}

// ------------------------------------------------------------------ hiding the island

/** "Until I show it": the latest time a Date can hold. */
export const HIDE_UNTIL_SHOWN = 8_640_000_000_000_000;

export type HideChoice = '30m' | '1h' | '3h' | 'morning' | 'shown';

/** How long the island can be hidden for, in the order offered. */
export const HIDE_CHOICES: Array<{ id: HideChoice; label: string }> = [
  { id: '30m', label: 'For 30 minutes' },
  { id: '1h', label: 'For 1 hour' },
  { id: '3h', label: 'For 3 hours' },
  { id: 'morning', label: 'Until tomorrow morning' },
  { id: 'shown', label: 'Until I show it again' },
];

/** The island comes back at the next 6 AM that is at least an hour away. */
const MORNING_HOUR = 6;

/** When the island comes back for a choice made at `now` (local time for the morning). */
export function hideUntil(choice: HideChoice, now: number): number {
  const MIN = 60_000;
  switch (choice) {
    case '30m':
      return now + 30 * MIN;
    case '1h':
      return now + 60 * MIN;
    case '3h':
      return now + 180 * MIN;
    case 'morning': {
      const d = new Date(now);
      d.setHours(MORNING_HOUR, 0, 0, 0);
      while (d.getTime() < now + 60 * MIN) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case 'shown':
      return HIDE_UNTIL_SHOWN;
  }
}

export function hiddenNow(island: Pick<Settings['island'], 'hiddenUntil'>, now: number): boolean {
  return island.hiddenUntil > now;
}

/** When it comes back, to follow "back" or "comes back": "at 4:12 PM", "tomorrow at 6:00 AM", "Thursday at 6:00 AM"; null for "until I show it". */
export function backAt(until: number, now: number): string | null {
  if (until >= HIDE_UNTIL_SHOWN) return null;
  const time = new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(until) - day(now)) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${new Date(until).toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
}

/** Deep clone through JSON: settings are plain data. */
export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}
