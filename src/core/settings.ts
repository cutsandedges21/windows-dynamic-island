// The settings schema. Rust stores the blob; this module owns its shape,
// defaults and migration, and keeps both windows in sync.

import { CATALOG, type Band, type Behavior } from '../activities/catalog';
import { normalizeWidths, type Anchor, type IslandSize, type Widths } from './layout';
import { GLASS_DEFAULT } from './glass';
import { FULL_MENU, type MenuShown } from './menu';

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

export const SETTINGS_VERSION = 6;

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
    /** Glass only, like iOS Liquid Glass: 0 is clear, 100 is tinted (less of what is behind shows through). */
    glass: number;
    reduceMotion: 'system' | 'on' | 'off';
    /** How fast the border glow moves, or off. */
    glow: 'off' | 'slow' | 'medium' | 'fast';
    /** What hovering the island shows: the card of whatever is pointed at, or always Claude's stats. */
    hoverCard: 'pointer' | 'claude';
    /** How a persistent activity grows when pointed at, unless it has its own choice (Activities › Grows). */
    defaultGrows: Exclude<Grows, 'below' | 'more'>;
    /** Tapping Ctrl over the pill fades it and lets clicks through to what is behind. */
    peekThrough: boolean;
    /** The bot in its bubble beside the pill (src/core/bubble.ts). */
    bot: boolean;
    grid: GridLayout;
    /** The island is off the screen until this time (epoch ms); 0: shown. HIDE_UNTIL_SHOWN: until the user brings it back. */
    hiddenUntil: number;
    /** What the right-click menu shows (src/core/menu.ts); Settings is always in it. */
    menu: MenuShown;
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
      size: 'medium',
      idle: 'pill',
      hoverExpand: true,
      // Moss: the island stays on screen over full-screen apps and videos too.
      hideInFullscreen: false,
      showSecondary: true,
      accent: 'sky',
      color: 'black',
      glass: GLASS_DEFAULT,
      reduceMotion: 'system',
      glow: 'medium',
      hoverCard: 'pointer',
      defaultGrows: 'card',
      peekThrough: true,
      bot: true,
      grid: { order: [], sizes: {}, hidden: [], pages: [] },
      hiddenUntil: 0,
      menu: { ...FULL_MENU },
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
  if (out.island.defaultGrows !== 'wide' && out.island.defaultGrows !== 'card') out.island.defaultGrows = 'card';
  // 0.2.4 called matte white "silver" and matte black "blur".
  const renamed: Record<string, PillColor> = { silver: 'matte-white', blur: 'matte-black' };
  out.island.color = renamed[out.island.color] ?? out.island.color;
  if (!['black', 'white', 'matte-white', 'matte-black', 'glass'].includes(out.island.color)) out.island.color = 'black';
  // Justin's 0.2.11 saved the glass slider; Moss's 0.4.2 had none and gets the old look.
  out.island.glass = Number.isFinite(out.island.glass) ? Math.max(0, Math.min(100, out.island.glass)) : GLASS_DEFAULT;

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
  if (isObj(savedGrid.sizes)) for (const [k, v] of Object.entries(savedGrid.sizes)) if (TILE_SIZES.includes(v as TileSize) && tileKey(k)) sizes[tileKey(k)] = v as TileSize;
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
  out.island.displayIds = strings(isObj(saved.island) ? saved.island.displayIds : null);
  if (!Number.isFinite(out.island.hiddenUntil) || out.island.hiddenUntil < 0) out.island.hiddenUntil = 0;
  out.island.hiddenUntil = Math.min(out.island.hiddenUntil, HIDE_UNTIL_SHOWN);
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
  // Version 6: Claude pops up for a moment (Claude Status's rule), so the 45 s Reply window that
  // was Claude Code's default goes off for everyone who still had it; another length someone chose stays.
  if (from < 6) {
    const o = out.activities.config.claude?.options;
    if (o && o.replyWindowSeconds === 45) o.replyWindowSeconds = 0;
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
const STATUS_OPTIONS = ['showDone', 'showAutoModel', 'glowInFront'];

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
