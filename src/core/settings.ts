// The settings schema. Rust stores the blob; this module owns its shape,
// defaults and migration, and keeps both windows in sync.

import { CATALOG, type Band, type Behavior } from '../activities/catalog';
import { normalizeWidths, type Anchor, type IslandSize, type Widths } from './layout';

export type DisplayMode = 'primary' | 'cursor' | 'active' | 'specific' | 'duplicate';

export interface ActivityConfig extends Behavior {
  enabled: boolean;
  priority: Band;
  options: Record<string, unknown>;
}

/** Cell sizes in the open island's grid: columns x rows. */
export type TileSize = '1x1' | '2x1' | '1x2' | '2x2';
export const TILE_SIZES: TileSize[] = ['1x1', '2x1', '1x2', '2x2'];

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

export type PillColor = 'black' | 'white' | 'matte-white' | 'matte-black' | 'glass';

export const SETTINGS_VERSION = 5;

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
    size: IslandSize;
    /** What the island does when nothing is happening. */
    idle: 'pill' | 'hidden';
    hoverExpand: boolean;
    hideInFullscreen: boolean;
    showSecondary: boolean;
    accent: string;
    /** The pill's own colour, and the card's under it. */
    color: PillColor;
    reduceMotion: 'system' | 'on' | 'off';
    /** How fast the border glow moves, or off. */
    glow: 'off' | 'slow' | 'medium' | 'fast';
    /** What hovering the island shows: the card of whatever is pointed at, or always Claude's stats. */
    hoverCard: 'pointer' | 'claude';
    /** Tapping Ctrl over the pill fades it and lets clicks through to what is behind. */
    peekThrough: boolean;
    /** The bot in its bubble beside the pill (src/core/bubble.ts). */
    bot: boolean;
    grid: GridLayout;
  };
  activities: {
    order: string[];
    config: Record<string, ActivityConfig>;
  };
  general: {
    startWithWindows: boolean;
    notifications: boolean;
    sounds: boolean;
    /** Do not disturb: nothing auto-expands, only interrupts marked urgent. */
    dnd: boolean;
    toggleHotkey: string;
    activitiesHotkey: string;
    /** The first-run setup (src/welcome.ts) was finished or skipped. */
    onboarded: boolean;
    /** Install newer Island.exe releases from GitHub on their own (src-tauri/src/updater.rs). */
    autoUpdate: boolean;
  };
  privacy: {
    clipboardContent: boolean;
    screenshotPreview: boolean;
  };
}

/** Orange stays Claude's colour, so the island's own default is sky. */
export const ACCENTS: Record<string, string> = {
  sky: '#6aa6e8',
  white: '#ffffff',
  ember: '#e8845f',
  mint: '#62c99a',
  violet: '#a58cf0',
  gold: '#e3b34f',
  rose: '#ea7aa1',
};

/** The accent as the pill draws it: white turns dark on a white or matte white pill, where it would vanish. */
export function accentColor(island: Settings['island']): string {
  const c = ACCENTS[island.accent] ?? island.accent ?? ACCENTS.ember;
  return (island.color === 'white' || island.color === 'matte-white') && c.toLowerCase() === '#ffffff' ? '#1c1c1e' : c;
}

export function defaultActivityConfig(id: string): ActivityConfig {
  const meta = CATALOG.find((m) => m.id === id);
  const options: Record<string, unknown> = {};
  // A secret option has no value here: the key lives in the Credential Manager, not in settings.
  for (const o of meta?.options ?? []) if (o.type !== 'secret') options[o.key] = o.default;
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
      size: 'medium',
      idle: 'pill',
      hoverExpand: true,
      // Moss: the island stays on screen over full-screen apps and videos too.
      hideInFullscreen: false,
      showSecondary: true,
      accent: 'sky',
      color: 'black',
      reduceMotion: 'system',
      glow: 'medium',
      hoverCard: 'pointer',
      peekThrough: true,
      bot: true,
      grid: { order: [], sizes: {}, hidden: [], pages: [] },
    },
    activities: { order: CATALOG.map((m) => m.id), config },
    general: {
      startWithWindows: false,
      notifications: true,
      sounds: false,
      dnd: false,
      toggleHotkey: 'Alt+Shift+Space',
      activitiesHotkey: 'Alt+Shift+A',
      onboarded: false,
      autoUpdate: true,
    },
    privacy: { clipboardContent: true, screenshotPreview: true },
  };
}

type Json = Record<string, unknown>;
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
  // 0.2.4 called matte white "silver" and matte black "blur".
  const renamed: Record<string, PillColor> = { silver: 'matte-white', blur: 'matte-black' };
  out.island.color = renamed[out.island.color] ?? out.island.color;
  if (!['black', 'white', 'matte-white', 'matte-black', 'glass'].includes(out.island.color)) out.island.color = 'black';

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
    out.activities.config[m.id] = merged;
  }
  // Order: saved order of known ids, then any new activities in catalog order.
  const known = new Set(CATALOG.map((m) => m.id));
  const order = Array.isArray(savedActs.order) ? (savedActs.order as unknown[]).filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  for (const m of CATALOG) if (!order.includes(m.id)) order.push(m.id);
  out.activities.order = [...new Set(order)];

  // The grid layout is free-form (tile keys come from activities), so it is checked by hand.
  const savedGrid = isObj(saved.island) && isObj(saved.island.grid) ? saved.island.grid : {};
  const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 120))] : []);
  const sizes: Record<string, TileSize> = {};
  if (isObj(savedGrid.sizes)) for (const [k, v] of Object.entries(savedGrid.sizes)) if (TILE_SIZES.includes(v as TileSize)) sizes[k] = v as TileSize;
  // Pages: tile keys (each on one page at most) and nulls for the empty cells the user left.
  const seen = new Set<string>();
  const pages: Array<Array<string | null>> = [];
  for (const p of Array.isArray(savedGrid.pages) ? savedGrid.pages.slice(0, 24) : []) {
    if (!Array.isArray(p)) continue;
    const list: Array<string | null> = [];
    for (const e of p.slice(0, 96)) {
      if (e === null) list.push(null);
      else if (typeof e === 'string' && e.length > 0 && e.length < 120 && !seen.has(e)) {
        seen.add(e);
        list.push(e);
      }
    }
    pages.push(list);
  }
  out.island.grid = { order: strings(savedGrid.order), sizes, hidden: strings(savedGrid.hidden), pages };
  out.island.displayIds = strings(isObj(saved.island) ? saved.island.displayIds : null);
  if (!['primary', 'cursor', 'active', 'specific', 'duplicate'].includes(out.island.display)) out.island.display = 'primary';

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
  out.version = SETTINGS_VERSION;
  return out;
}

/** Deep clone through JSON: settings are plain data. */
export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}
