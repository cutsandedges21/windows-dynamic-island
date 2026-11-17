// The sheet: a card hanging off the pill on the side it grows towards (below a
// top pill, above a bottom one, beside a side one). It holds what one row
// can't: a chat's last message with a reply box, a question and its options,
// sessions and limits, and the grid of everything that is switched on.
//
// Blocks are keyed like segments. A block whose description did not change is
// left alone; inputs, meters and countdowns are patched in place (typing and
// running animations survive); anything else is rebuilt. The card's height
// springs to fit its content and its position rides the pill's springs every
// frame, so the two move as one. Every string from an activity goes in through
// textContent; only icons.ts markup is set as HTML.

import { SpringSet, reducedMotion } from './animator';
import { icon } from './icons';
import type { Anchor, Area, Rect } from './layout';
import { carryApart, carryCard, carryCurve, carryFades, carryShape, carrySplit, closeCurve, contentLeft, GROW_MS, GROW_SPRING, handOff, pillSlice, snapSpan, tweenShape, type Shape, type Side } from './grow';
import { buildPlayer, patchPlayer, type PlayerBlock } from './player';
import { springAnimate, wheelDelta, type PillCover } from './renderer';
import type { Tone } from './segments';
import { springs } from './spring';

export type ButtonStyle = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface SheetButton {
  key: string;
  label?: string;
  icon?: string;
  action: string;
  arg?: unknown;
  style?: ButtonStyle;
  tip?: string;
  /** Shown but not pressable (Send with nothing to send). */
  disabled?: boolean;
  /** On a row: always shown, not only while the row is pointed at (a send's Cancel). */
  shown?: boolean;
}

/** Someone to pick, as a round avatar with a name under it (Land's nearby devices). */
export interface Person {
  key: string;
  name: string;
  /** Under the name: what it is, or how a transfer to it is going. */
  sub?: string;
  initials: string;
  /** Avatar colour, a hue 0..360. */
  hue: number;
  selected?: boolean;
  /** A ring around the avatar filling 0..1; null circles (waiting). Absent: no ring. */
  progress?: number | null;
  /** An icon in a small disc at the avatar's corner (sent, declined). */
  badge?: string;
  tone?: Tone;
  action?: string;
  arg?: unknown;
  tip?: string;
}

/** A file on a shelf (Land's): its picture or icon over its name, with a tick to pick it. */
export interface FileTile {
  key: string;
  name: string;
  sub?: string;
  /** A picture (a data address); without one, `icon`. */
  thumb?: string | null;
  icon: string;
  ticked?: boolean;
  tone?: Tone;
  /** Clicking the tile (ticks it). */
  action?: string;
  arg?: unknown;
  tip?: string;
  /** A small button at the tile's corner (shown on hover), to take it off. */
  remove?: SheetButton;
}

export interface SheetRow {
  key: string;
  icon?: string;
  dot?: Tone;
  pulse?: boolean;
  /** A small pink dot on the dot's corner: something new to read. */
  unread?: boolean;
  title: string;
  detail?: string;
  /** A thin progress bar after the detail, to the end of the row: what it is (label) and the time left (text). */
  bar?: RowBar;
  badge?: string;
  tone?: Tone;
  action?: string;
  arg?: unknown;
  tip?: string;
  /** A small button at the row's end (shown on hover), e.g. hide. */
  button?: SheetButton;
  /** A right-click on the row runs this action, with the row's `arg` (a Claude chat's reply box). */
  context?: string;
  /** A thin bar under the title, 0..1, with a figure beside it (a chat's context). */
  meter?: { value: number; text?: string; tone?: Tone; tip?: string };
}

export interface RowBar {
  value: number;
  text: string;
  label?: string;
  tone?: Tone;
}

/** The pill's chips (other activities, "+N"), carried onto a card grown out of the pill, which covers them. */
export interface SheetChip {
  key: string;
  icon?: string;
  label?: string;
  dot?: Tone;
  pulse?: boolean;
  tone?: Tone;
  action: string;
  arg?: unknown;
  tip?: string;
}

export interface Choice {
  key: string;
  label: string;
  detail?: string;
  selected?: boolean;
  /** What pressing the row does; a row with `options` does nothing itself. */
  action: string;
  arg?: unknown;
  /**
   * A setting in one row (the menu's Fade card): its name on the left and these side by side on the
   * right, the one in use lit, like Settings' segmented choices. The row itself is not a button.
   */
  options?: Array<{ key: string; label: string; selected?: boolean; action: string; arg?: unknown }>;
}

export type Block =
  /** `back`: a button before the title (an arrow back to Control Center), the rest at the end. */
  | { t: 'head'; key: string; icon?: string; tone?: Tone; title: string; sub?: string; buttons?: SheetButton[]; chips?: SheetChip[]; back?: SheetButton }
  /** Wrapped text. `bubble` scrolls after `lines` lines (default 8). */
  | { t: 'text'; key: string; text: string; tone?: Tone; size?: 'sm' | 'md'; bubble?: boolean; lines?: number }
  | { t: 'code'; key: string; text: string }
  | { t: 'buttons'; key: string; items: SheetButton[]; align?: 'start' | 'end' | 'fill' | 'center' }
  /**
   * Never focused on its own: clicking it engages it (`engage` fires), Enter sends `action` with the text.
   * With `lines` it is a box of that many lines (a note): Enter starts a new line, Ctrl+Enter sends; it
   * starts out holding `value`, and `change` gets the text as it is typed (and when the box lets go), so
   * what was typed is kept even if the card closes. `point` fires with true when the pointer comes onto
   * the box and false when it leaves (Claude's finished card stays up while you are about to reply).
   */
  | { t: 'input'; key: string; placeholder: string; action: string; engage?: string; hint?: string; lines?: number; value?: string; change?: string; point?: string; pasteFiles?: string }
  /** `action`: the whole meter can be clicked. */
  | { t: 'meter'; key: string; label: string; value: number; pace?: number | null; text: string; sub?: string; tone?: Tone; tip?: string; action?: string; arg?: unknown }
  | { t: 'rows'; key: string; items: SheetRow[] }
  | { t: 'choices'; key: string; items: Choice[] }
  | { t: 'stats'; key: string; items: Array<{ key: string; label: string; value: string; tone?: Tone; tip?: string }> }
  /** A thin bar draining until `until` (epoch ms) out of `total` ms. */
  | { t: 'countdown'; key: string; until: number; total: number; tone?: Tone }
  /** A row of avatars to pick from; `empty` (with a searching pulse) when there are none. */
  | { t: 'people'; key: string; items: Person[]; empty?: string }
  /**
   * A shelf of files in one scrolling row. `drag`: pressing a tile and moving sends this action
   * with the tile's key, once, for the activity to start a real drag out of the island (a pointer
   * gesture, so never something a phone can press). `wrap`: a grid that wraps instead (Apps).
   */
  | { t: 'files'; key: string; items: FileTile[]; drag?: string; wrap?: boolean; reorder?: string }
  /**
   * Places to drop files dragged over the island, side by side (the Shelf, Land): `grow` is each
   * one's share of the width, `hot` the one under the pointer, `off` one that takes nothing now.
   * Each carries `data-zone` = its key, which the island looks up under the drop.
   */
  | { t: 'zones'; key: string; height: number; hot?: string | null; items: DropZone[] }
  /** A QR code: `size` modules a side, `cells` row by row with '1' for dark. */
  | { t: 'qr'; key: string; size: number; cells: string; caption?: string }
  /** A picture (a data address or a URL), as big as the card allows up to `max` px tall. */
  | { t: 'image'; key: string; src: string; alt?: string; max?: number }
  /**
   * The Control Center grid. `items` already know where they sit (the island
   * packed them); `tray` holds the ones taken off the grid, shown while editing.
   */
  | { t: 'tiles'; key: string; items: Tile[]; tray?: Tile[]; cols: number; rows: number; pages: number; cell: number; editing?: boolean }
  /** Music's player (player.ts); grown out of the pill it carries the pill's chips at its top. */
  | (PlayerBlock & { chips?: SheetChip[] })
  /**
   * A calendar like a phone's: a month (or one week) of days to pick from, with week numbers, and
   * beside it the picked day, its events and their buttons. `pick` gets the day's key (2026-11-13).
   */
  | { t: 'calendar'; key: string; title: string; year?: string; heads: string[]; weeks: Array<{ no: number; days: CalDay[] }>; pick: string; week?: boolean; day: CalPanel };

/** A day in a calendar block or a month tile. `busy`: how many events (dots, up to 3). `out`: of the month around. */
export interface CalDay {
  key: string;
  num: number;
  today?: boolean;
  selected?: boolean;
  out?: boolean;
  busy: number;
}

/** The picked day beside a calendar block: FRIDAY / 13 November / Today · Week 46, and its events. */
export interface CalPanel {
  kicker: string;
  title: string;
  sub: string;
  events: CalEvent[];
  empty: string;
}

export interface CalEvent {
  key: string;
  /** 14:30, or All day. */
  time: string;
  title: string;
  sub?: string;
  tone?: Tone;
  buttons?: SheetButton[];
}

/** One side of the drop card. */
export interface DropZone {
  key: string;
  icon: string;
  title: string;
  sub: string;
  grow: number;
  off?: boolean;
}

/** One cell of the open island's grid (Control Center style). */
export interface Tile {
  key: string;
  /** Default size the activity asks for: columns (1 or 2) and rows (1 or 2). */
  span?: 1 | 2;
  rows?: 1 | 2 | 4;
  /** Where the island packed it: page and 0-based cell, with its size in cells. */
  page?: number;
  col?: number;
  row?: number;
  w?: number;
  h?: number;
  tone?: Tone;
  /** Tapping the tile itself. */
  action?: string;
  arg?: unknown;
  tip?: string;
  /** Taken off the grid by the user: only shown while editing, to be put back. */
  hidden?: boolean;
  /** A stand-in holding a placed tile's spot while its activity has nothing to show (island.ts restingTile). */
  resting?: boolean;
  /** Sizes (columns, rows) its corner can be dragged to while editing. */
  sizes?: Array<[number, number]>;
  body: TileBody;
}

export type TileBody =
  /** `buttons`: small ones beside the number (volume − and +). */
  | { k: 'stat'; icon: string; label: string; value: string; sub?: string; progress?: number | null; buttons?: SheetButton[] }
  | { k: 'battery'; pct: number; charging: boolean; head: string; sub: string }
  /** `open`: clicking the art (Music: the app playing comes forward). */
  | { k: 'media'; art?: string | null; title: string; artist: string; playing: boolean; progress?: number | null; buttons: SheetButton[]; open?: string }
  /**
   * Music's lyrics: the cover, title and artist small at the top, the lines big under them, the
   * one being sung lit (`at`, -1 before the first) and kept in view. `lines` empty: `note` instead.
   */
  | { k: 'lyrics'; art?: string | null; title: string; artist: string; playing: boolean; lines: string[]; at: number; note?: string; open?: string }
  | { k: 'week'; title: string; sub: string; days: Array<{ label: string; num: number; today: boolean; busy: number }> }
  /** A month: `heads` (Su Mo…) over its weeks of days, row by row. */
  | { k: 'month'; title: string; sub: string; heads: string[]; days: CalDay[] }
  | { k: 'dots'; label: string; pct: number; sub?: string }
  | { k: 'forecast'; icon: string; temp: string; label: string; hours: Array<{ t: string; icon: string; temp: string }> }
  /**
   * `dial`: hours, minutes and seconds like the iPhone's timer (scroll one to change it, click to
   * type), with `start` beside them; `buttons` then sit small at the heading's end.
   */
  | { k: 'actions'; icon?: string; label: string; sub?: string; buttons: SheetButton[]; dial?: Dial }
  | { k: 'list'; icon: string; label: string; sub?: string; rows: SheetRow[]; empty?: string }
  /**
   * iPhone-style controls in one tile: wide pills that switch something (Wi-Fi, Bluetooth), tall
   * sliders whose fill rises from the bottom (brightness, volume), and round `buttons`.
   */
  | { k: 'hub'; pills: HubPill[]; sliders: HubSlider[]; buttons: SheetButton[] };

/** A wide switch in a hub tile: bright when on, glass when off. No `action`: it only says how it is. */
export interface HubPill {
  key: string;
  icon: string;
  label: string;
  sub: string;
  on: boolean;
  action?: string;
  tip?: string;
  /** Holding the pill opens this menu over Control Center, as an iPhone's Wi-Fi and Bluetooth do. */
  menu?: HubMenu;
}

/** A hub pill's hold menu: a list of rows, a divider, and `more` pinned at the bottom ("Wi-Fi Settings…"). */
export interface HubMenu {
  rows: HubMenuRow[];
  more?: HubMenuRow;
  /** Said in place of the rows when there are none. */
  empty?: string;
  /** Sent (with no argument) when the menu opens: a fresh Wi-Fi scan, say. */
  open?: string;
}

/**
 * One row of a hold menu: `label` wraps onto as many lines as it takes; `sub` is a dimmer second
 * line; `icon` (with a small lock when `lock`) sits left of the label, and a check left of that
 * when `check`. A tap sends `action` with `arg` and closes the menu.
 */
export interface HubMenuRow {
  key: string;
  label: string;
  sub?: string;
  icon?: string;
  lock?: boolean;
  check?: boolean;
  action?: string;
  arg?: unknown;
}

/** A tall slider in a hub tile, 0-1. Dragging sends `action` with the new value (0-1) as its arg. */
export interface HubSlider {
  key: string;
  icon: string;
  value: number;
  action?: string;
  tip?: string;
}

/** A slider's value for a pointer `y` px down a track `top`..`top + height`: 1 at the top, 0 at the bottom, in hundredths. */
export function sliderAt(y: number, top: number, height: number): number {
  if (!(height > 0)) return 0;
  return Math.round(clamp01(1 - (y - top) / height) * 100) / 100;
}

/** A length picker: `action` gets the new total in seconds, `start` is sent with it as its arg. */
export interface Dial {
  seconds: number;
  action: string;
  start: SheetButton;
}

export interface SheetView {
  /** What the card is about. A different key cross-fades the content. */
  key: string;
  blocks: Block[];
  /** The grid: a wider card. */
  wide?: boolean;
  /** The view knows how wide it wants to be (the grid sizes itself from its cells). */
  width?: number;
  /**
   * The card grows out of the pill itself and covers it, like an iPhone's Dynamic Island
   * opening (Music's player, any activity that grows into a card), instead of hanging below
   * it; it shrinks back into the pill.
   */
  morph?: boolean;
}

export type SheetAction = (action: string, arg: unknown, source: HTMLElement) => void;

/**
 * The island's own elements, side by side with the card on one stage: a card block that took
 * one of their class names would take their styles too (the bot's `.bubble` is
 * `position: absolute`, which once laid a chat's last message over the card's header).
 */
export const ISLAND_CLASSES: readonly string[] = ['pill', 'sheet', 'bubble', 'chat', 'glow'];

/** A scroll turns Control Center's page once it has moved this far (a wheel notch moves 100). */
const WHEEL_TURN_PX = 40;
/** After a turn the wheel must rest this long before the next one. */
const WHEEL_REST_MS = 220;

/** A scroll gesture on Control Center: how far it moved, when it last did, and whether it turned a page. */
export interface WheelGesture {
  acc: number;
  last: number;
  turned: boolean;
}

/**
 * One page per scroll gesture. A touchpad swipe or a quick spin of the wheel sends dozens of
 * wheel events, and turning a page on each went straight from the first page to the last
 * (Moss, 2026-10-22: "I can never see the second page"). Movement adds up until it passes
 * WHEEL_TURN_PX, which turns one page; then nothing turns until the wheel rests WHEEL_REST_MS.
 */
export function wheelTurn(g: WheelGesture, delta: number, now: number): -1 | 0 | 1 {
  if (now - g.last > WHEEL_REST_MS) {
    g.acc = 0;
    g.turned = false;
  }
  g.last = now;
  if (g.turned) return 0;
  g.acc += delta;
  if (Math.abs(g.acc) < WHEEL_TURN_PX) return 0;
  g.turned = true;
  return g.acc > 0 ? 1 : -1;
}

/** A text block's classes; a boxed one (a chat's message, an answer) scrolls after `lines`. */
export function textClass(b: Extract<Block, { t: 'text' }>): string {
  return `sb sb-text sz-${b.size ?? 'md'} tone-${b.tone ?? 'default'}${b.bubble ? ' boxed' : ''}`;
}

/** A hub pill with its own action and its hold menu's rewritten. */
function hubPillActions(p: HubPill, fn: (action: string) => string): HubPill {
  const out: HubPill = p.action ? { ...p, action: fn(p.action) } : { ...p };
  const m = p.menu;
  if (!m) return out;
  const row = (r: HubMenuRow): HubMenuRow => (r.action ? { ...r, action: fn(r.action) } : r);
  out.menu = { ...m, rows: m.rows.map(row), more: m.more ? row(m.more) : undefined, open: m.open ? fn(m.open) : undefined };
  return out;
}

/** Rewrites every action in a view (the island namespaces them per activity). */
export function mapActions(blocks: Block[], fn: (action: string) => string): Block[] {
  const btn = (b: SheetButton): SheetButton => ({ ...b, action: fn(b.action) });
  const row = (r: SheetRow): SheetRow => ({ ...r, action: r.action ? fn(r.action) : undefined, button: r.button ? btn(r.button) : undefined, context: r.context ? fn(r.context) : undefined });
  const body = (b: TileBody): TileBody => {
    if (b.k === 'actions' && b.dial) return { ...b, buttons: b.buttons.map(btn), dial: { ...b.dial, action: fn(b.dial.action), start: btn(b.dial.start) } };
    if (b.k === 'media') return { ...b, buttons: b.buttons.map(btn), open: b.open ? fn(b.open) : undefined };
    if (b.k === 'lyrics') return { ...b, open: b.open ? fn(b.open) : undefined };
    if (b.k === 'actions') return { ...b, buttons: b.buttons.map(btn) };
    if (b.k === 'stat' && b.buttons) return { ...b, buttons: b.buttons.map(btn) };
    if (b.k === 'list') return { ...b, rows: b.rows.map(row) };
    // Control Center's Wi-Fi / Bluetooth / sliders tile: every press is its activity's.
    if (b.k === 'hub') return { ...b, pills: b.pills.map((p) => hubPillActions(p, fn)), sliders: b.sliders.map((h) => (h.action ? { ...h, action: fn(h.action) } : h)), buttons: b.buttons.map(btn) };
    return b;
  };
  return blocks.map((b): Block => {
    switch (b.t) {
      case 'head':
        return { ...b, buttons: b.buttons?.map(btn), back: b.back ? btn(b.back) : undefined };
      case 'buttons':
        return { ...b, items: b.items.map(btn) };
      case 'input':
        return { ...b, action: fn(b.action), engage: b.engage ? fn(b.engage) : undefined, change: b.change ? fn(b.change) : undefined, point: b.point ? fn(b.point) : undefined, pasteFiles: b.pasteFiles ? fn(b.pasteFiles) : undefined };
      case 'meter':
        return b.action ? { ...b, action: fn(b.action) } : b;
      case 'rows':
        return { ...b, items: b.items.map(row) };
      case 'choices':
        return { ...b, items: b.items.map((c) => ({ ...c, action: fn(c.action), options: c.options?.map((o) => ({ ...o, action: fn(o.action) })) })) };
      case 'people':
        return { ...b, items: b.items.map((p) => ({ ...p, action: p.action ? fn(p.action) : undefined })) };
      case 'files':
        return { ...b, drag: b.drag ? fn(b.drag) : undefined, reorder: b.reorder ? fn(b.reorder) : undefined, items: b.items.map((f) => ({ ...f, action: f.action ? fn(f.action) : undefined, remove: f.remove ? btn(f.remove) : undefined })) };
      case 'tiles':
        return { ...b, items: b.items.map((t) => ({ ...t, action: t.action ? fn(t.action) : undefined, body: body(t.body) })) };
      case 'calendar':
        return { ...b, pick: fn(b.pick), day: { ...b.day, events: b.day.events.map((x) => (x.buttons ? { ...x, buttons: x.buttons.map(btn) } : x)) } };
      case 'player': {
        // An empty action stays empty: a player with no buttons (not interactive).
        const m = <T extends string | undefined>(a: T): T => (a ? (fn(a) as T) : a);
        return {
          ...b,
          actions: { prev: m(b.actions.prev), toggle: m(b.actions.toggle), next: m(b.actions.next), seek: m(b.actions.seek), output: m(b.actions.output), open: m(b.actions.open) },
          lyrics: b.lyrics ? { ...b.lyrics, close: m(b.lyrics.close), split: m(b.lyrics.split) } : b.lyrics,
          lyricsButton: b.lyricsButton ? { ...b.lyricsButton, action: m(b.lyricsButton.action) } : b.lyricsButton,
        };
      }
      default:
        return b;
    }
  });
}

/** A QR code as one SVG path, black on a white square with a quiet zone around it (also Settings › Your phone). */
export function qrSvg(size: number, cells: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const quiet = 3;
  const side = size + quiet * 2;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(side));
  bg.setAttribute('height', String(side));
  bg.setAttribute('fill', '#fff');
  let d = '';
  for (let i = 0; i < Math.min(cells.length, size * size); i++) if (cells[i] === '1') d += `M${(i % size) + quiet} ${Math.floor(i / size) + quiet}h1v1h-1z`;
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

const GAP = 8;
/** A typing pause this long sends an input's `change` (a note saves itself). */
const CHANGE_MS = 400;
/** The card grows out of a sliver about the size of a resting pill. */
const SLIVER = 26;
const EDGE = 8;
/** Holding a tile this long starts arranging the grid. */
const LONG_PRESS_MS = 450;
/** Holding a hub pill this long opens its menu (Wi-Fi's networks, Bluetooth's devices). */
const MENU_HOLD_MS = 450;
/** A hold menu: its corners, its gap to the card's edges, and how long it takes to grow out of the pill and back. */
const MENU_RADIUS = 22;
const MENU_PAD = 8;
const MENU_OPEN_MS = 320;
const MENU_CLOSE_MS = 220;
/** A tile carried this close to the card's side (or past it)... */
const EDGE_ZONE = 30;
/** ...and held there this long turns the page; past the last page it makes a new one. */
const EDGE_HOLD_MS = 2000;
/** How far past the card a carried tile keeps the mouse (beyond, clicks reach the desktop). */
const DRAG_REACH = 160;
/** How far past the island a held drag keeps the mouse, px: past any screen. */
const HOLD_REACH = 20000;
/** How long a carried tile rests over a spot before the grid makes room for it there. */
const REFLOW_DWELL_MS = 150;
/** A card grown out of the pill: its corners at full size (island.css .sheet.morph). */
const MORPH_RADIUS = 34;
/** An ordinary card's corners (island.css .sheet), for the hand-off from a grown card. */
const CARD_RADIUS = 24;

const args = new WeakMap<HTMLElement, unknown>();
/** A row's arg for its right-click action (SheetRow.context). */
const contextArgs = new WeakMap<HTMLElement, unknown>();
/** A dial's way to take a new length from the activity without being rebuilt. */
const dialSetters = new WeakMap<Element, (seconds: number) => void>();
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A hub slider being dragged sends its value at most this often (brightness.rs sets only the latest, about 15 ms each). */
const SLIDER_SEND_MS = 60;
/** After a slider is let go, its fill stays where it was left this long: the level read back from Windows lags behind. */
const SLIDER_HOLD_MS = 1500;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Rounds a CSS length to whole device pixels (125% and 150% scaling make those fractions of a CSS px). */
const snapPx = (v: number) => {
  const k = window.devicePixelRatio || 1;
  return Math.round(v * k) / k;
};

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconEl(name: string, cls: string): HTMLElement {
  const e = make('span', cls);
  e.innerHTML = icon(name); // static markup from icons.ts
  return e;
}

interface BlockNode {
  t: Block['t'];
  sig: string;
  el: HTMLElement;
  spec: Block;
}

export class SheetRenderer {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  /** m: how far the card stands over the pill (1, grown out of it) rather than under it (0). */
  private readonly springs: SpringSet<'h' | 'o' | 's' | 'b' | 'w' | 'm'>;
  private readonly bg: HTMLElement;
  /** Grown out of the pill: the card's shadow, drawn round the growing shape (the box itself is clipped to it). */
  private readonly shadow: HTMLElement;
  private readonly nodes = new Map<string, BlockNode>();
  private readonly tileSigs = new WeakMap<HTMLElement, string>();
  private viewKey: string | null = null;
  /** Where the lyrics list was scrolled to: a new list (every update builds one) starts there and glides on. */
  private lyricScroll = { sig: '', top: 0 };
  /** A long-press just opened edit mode: the click that ends it must not run the tile's action. */
  private swallowClick = false;
  /** Every hub pill's hold menu as last drawn, by `tile/pill`. */
  private readonly hubMenus = new Map<string, HubMenu>();
  /** The hold menu open over the card, if any (see openHubMenu). */
  private hubMenu: { tile: string; pill: string; box: HTMLElement; scrim: HTMLElement; sig: string; openedAt: number; pressedAt: number; closing: boolean } | null = null;
  private swallowTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tile being carried or resized right now: `abort` ends it unsaved, `rescan` re-aims it after a page turn. */
  private drag: { key: string; mode: 'move' | 'resize'; host: HTMLElement; abort: () => void; rescan: () => void } | null = null;
  /** A tile is being dragged to a new place (wireReorder): its row is not redrawn under it meanwhile. */
  private reordering = false;
  /** Something on the card is being dragged (the lyrics' split line): the mouse stays the card's anywhere on screen. */
  private pointerHeld = false;
  /** Pages the grid keeps while a tile is carried (a page made at the edge stays until the drop). */
  private dragPages = 0;
  /** A dropped tile whose floating copy is still flying home: its spot stays empty until it lands. */
  private landing: string | null = null;
  /** The page a turn is sliding to: the scroll position lags behind a smooth scroll. */
  private readonly aim = new WeakMap<HTMLElement, number>();
  /** The tiles last drawn, for the empty cells shown while editing. */
  private grid: { items: Tile[]; cols: number; rows: number } | null = null;
  private shown = false;
  private anchor: Anchor = 'top';
  private area: Area = { width: 1280, height: 720 };
  private pill: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Where the pill is springing to (island.ts sets it with the pill's target each compose). */
  pillTo: Rect | null = null;
  private width = 380;
  private drawn: Rect | null = null;
  private engagedInput: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** The spring set writes once while it is being built; nothing to place yet. */
  private ready = false;
  /** The card grows out of the pill and covers it (SheetView.morph), and the height it grows to. */
  private morph = false;
  private morphH = 0;
  /** What the grown card means for the pill under it, from the moment it grows until it is back. */
  private cover: PillCover = 'off';
  /** Grown: where the card's box sits on screen, on whole device pixels (see placeGrown()), and the content's height. */
  private boxX: number | null = null;
  private boxY: number | null = null;
  private fitH = 0;
  private grownStyled = false;
  /**
   * Growing out of the pill, or a grown card carried on into the open island's card (or back):
   * where it is heading (show() updates the width, fit() the height), in a fixed time. `s`: how far
   * in time a grow it carries on had got (see carryCurve).
   */
  private opening: { start: number; s: number; w0: number; h0: number; m0: number; w1: number; h1: number; m1: number } | null = null;
  private openFrame = 0;
  /**
   * Carried on: a grown card turning into the open island's card ('open'), or that card turning
   * back into a grown one ('back'). Only its shape moves (from `carryRect`, see placeCarry): the
   * content it had (`carryOld`) and the content it takes on stay where they are on screen and fade
   * locked to how far the shape got (`carryR`, see carryFades).
   */
  private carry: 'open' | 'back' | null = null;
  private carryR = 0;
  private carryOld: HTMLElement | null = null;
  private carryFrom = 1;
  private carryRect: Rect | null = null;
  /** Its corner radius where it set off, and now. */
  private carryRadius = MORPH_RADIUS;
  private carryRadiusNow = MORPH_RADIUS;
  /** How far apart the card and the pill bar are (carrySplit): where the carry set off, and now. */
  private carrySplit0 = 0;
  private carrySplitNow = 0;
  /** The pill's own content: how much of it showed where the carry set off, and now. */
  private carryPill0 = 0;
  private carryPillNow = 0;
  /** Where the card's box is on screen (it stays there all through a carry). */
  private elAt = { x: 0, y: 0 };
  /** Going back into the pill: how far, 0 → 1, and the frame request driving it. */
  private closeT = 0;
  private closeFrame = 0;
  /** Player buttons bind like any card button; an empty action unbinds (no buttons). */
  private readonly bindPlayer = (e: HTMLElement, action: string | undefined, arg: unknown): void => {
    if (!action) delete e.dataset.action;
    this.bind(e, action, arg);
  };

  constructor(
    private readonly stage: HTMLElement,
    private readonly onAction: SheetAction,
    private readonly onMove: () => void,
    private readonly onCover: (cover: PillCover) => void = () => {},
    /**
     * `still`: a card grown out of the pill keeps its content where it ends up from the first frame
     * (it fades in and out there while only the shape grows and shrinks) instead of scaling it with
     * the shape. The phone's held pill uses it (Justin: content must not move).
     */
    private readonly opts: { still?: boolean } = {},
  ) {
    this.el = make('div', 'sheet');
    this.bg = make('div', 'sheet-bg');
    this.el.append(this.bg);
    this.inner = make('div', 'sheet-inner');
    this.el.append(this.inner);
    this.el.style.display = 'none';
    this.shadow = make('div', 'sheet-shadow');
    this.shadow.style.display = 'none';
    stage.append(this.shadow, this.el);

    this.springs = new SpringSet(
      { h: SLIVER, o: 0, s: 0.94, b: 8, w: this.width, m: 0 },
      (v) => this.place(v),
      springs.shell,
      { h: 0.3, o: 0.002, s: 0.0005, b: 0.02, w: 0.3, m: 0.002 },
    );
    this.ready = true;

    this.el.addEventListener('click', (e) => {
      // The click that ends a long-press must not also press the tile under it.
      if (this.swallowClick && (e.target as HTMLElement).closest('.sb-tiles')) {
        this.swallowClick = false;
        e.stopPropagation();
        return;
      }
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target || !this.el.contains(target)) {
        // Grown out of the pill, the card stands in for it: a tap opens the island (not one in
        // its reply box, or one that ends selecting its text).
        const typing = (e.target as HTMLElement).closest('.sb-input');
        const selecting = Boolean(window.getSelection()?.toString());
        if (this.morph && this.shown && !typing && !selecting) this.onAction('island:tap', null, this.el);
        // Carried, the one shape still lies over the pill bar: a click there is the pill's (a
        // second click straight after the first closes the island again, or opens it again).
        else if (this.carry && this.shown) {
          const p = this.pill;
          if (e.clientX >= p.x && e.clientX <= p.x + p.w && e.clientY >= p.y && e.clientY <= p.y + p.h) this.onAction('island:tap', null, this.el);
        }
        return;
      }
      e.stopPropagation();
      // The action first: the press pulse is decoration and must never stand in its way.
      this.onAction(target.dataset.action!, args.get(target), target);
      springAnimate(target, [{ transform: 'scale(0.94)' }, { transform: 'none' }], springs.bouncy);
    });
    // Grown out of the pill, the card covers it, so it takes the pill's right-click and scroll too.
    this.el.addEventListener('contextmenu', (e) => {
      // A row with its own right-click (a Claude chat's: its reply box); anywhere else, the island's.
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-context]');
      if (row && this.el.contains(row)) {
        e.preventDefault();
        e.stopPropagation();
        this.onAction(row.dataset.context!, contextArgs.get(row), row);
        return;
      }
      // Text fields keep the browser's own menu (copy, paste); on anything else it never shows.
      const t = e.target as HTMLElement;
      if (!this.morph) {
        if (!t.closest('input, textarea, [contenteditable]')) e.preventDefault();
        return;
      }
      e.preventDefault();
      this.onAction('island:menu', null, this.el);
    });
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!this.morph || !this.shown) return;
        // Every swipe switches, up, down or sideways (Justin): a long card's list no longer takes it,
        // nor does a card still growing to its new height (its content overflowed it for a moment,
        // and the swipes made then were lost, so switching felt laggy).
        // Scrolling picks another activity: the card follows it, not the segment last pointed at.
        this.onAction('island:hover-key', null, this.el);
        // In pixels, like the pill's: one flick on a touchpad switches once (wheel.ts).
        this.onAction('island:wheel', wheelDelta(e), this.el);
      },
      { passive: true },
    );
    this.el.addEventListener('pointerenter', () => this.onAction('island:sheet-hover', true, this.el));
    this.el.addEventListener('pointerleave', () => {
      // Dragged past the card's edge: the card stays (Justin), it was not left.
      if (!this.pointerHeld) this.onAction('island:sheet-hover', false, this.el);
    });
    // A drag on the card (player.ts wireGrip) holds the pointer: the mouse is the card's anywhere till it
    // is let go, so the card stays open and the drag keeps getting the pointer past its edges.
    this.el.addEventListener('island-hold', (ev) => {
      const on = Boolean((ev as CustomEvent<boolean>).detail);
      if (on === this.pointerHeld) return;
      this.pointerHeld = on;
      this.onAction('island:pointer-hold', on, this.el);
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  get key(): string | null {
    return this.shown ? this.viewKey : null;
  }

  /** A card grown out of the pill is standing in for it, growing, open or on its way back. */
  get covering(): boolean {
    return this.cover === 'grown' || this.cover === 'shrinking';
  }

  /** Showing a card grown out of the pill (not one on its way back). */
  get grown(): boolean {
    return this.shown && this.morph;
  }

  /** Carried on into the open island's card ('open') or back into a grown one ('back'), see placeCarry(). */
  get carrying(): 'open' | 'back' | null {
    return this.carry;
  }

  /** Where the card is drawn right now (null while hidden). */
  get rect(): Rect | null {
    return this.drawn;
  }

  /** Where the card is drawn, plus the gap to the pill (so the cursor can cross it). */
  hitRect(): Rect | null {
    const d = this.drawn;
    if (!d || this.springs.get('o') < 0.05) return null;
    // Dragging something on the card: the whole screen, till it is let go.
    if (this.pointerHeld) return { x: -HOLD_REACH, y: -HOLD_REACH, w: HOLD_REACH * 2 + d.w + d.x, h: HOLD_REACH * 2 + d.h + d.y };
    // A carried tile can go past the card (to its side, to turn the page): keep the mouse that far.
    if (this.drag) return { x: d.x - DRAG_REACH, y: d.y - DRAG_REACH, w: d.w + DRAG_REACH * 2, h: d.h + DRAG_REACH * 2 };
    // Over the pill: no gap to cross.
    if (this.morph) return d;
    switch (this.anchor) {
      case 'top':
        return { x: d.x, y: d.y - GAP, w: d.w, h: d.h + GAP };
      case 'bottom':
        return { x: d.x, y: d.y, w: d.w, h: d.h + GAP };
      case 'left':
        return { x: d.x - GAP, y: d.y, w: d.w + GAP, h: d.h };
      case 'right':
        return { x: d.x, y: d.y, w: d.w + GAP, h: d.h };
    }
  }

  /** Whether the pointer is over the card now (its :hover, which a held drag does not change). */
  pointerInside(): boolean {
    return this.el.matches(':hover');
  }

  /** The input the user clicked into, if it is still on the card. */
  focusedInput(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.engagedInput && this.engagedInput.isConnected ? this.engagedInput : null;
  }

  /** Called on every pill frame: the card stays attached to the moving pill. */
  follow(pill: Rect): void {
    this.pill = pill;
    // On its way back a grown card lands on the pill as it is now (each frame of the close reads
    // it), not as it was when it left: the pill may be changing too (a right-click turns it into the menu).
    if (this.shown || !this.springs.settled || this.cover === 'shrinking') this.place();
  }

  /**
   * Shows `view` (or hides the card when null). `width` is the card width;
   * the island picks it from the pill and the anchor.
   */
  show(view: SheetView | null, geo: { anchor: Anchor; area: Area; width: number; immediate?: boolean }): void {
    const anchorChanged = geo.anchor !== this.anchor;
    this.anchor = geo.anchor;
    this.area = geo.area;
    this.el.dataset.anchor = geo.anchor;
    if (!view) {
      this.hide(geo.immediate || anchorChanged);
      return;
    }
    this.width = Math.round(geo.width);
    // A player on the art's colour (Music's hover card): the card's glass takes it, fading in.
    const tint = view.blocks.find((b): b is Extract<Block, { t: 'player' }> => b.t === 'player')?.cardTint ?? null;
    if (tint) this.el.style.setProperty('--card-tint', tint);
    this.el.classList.toggle('tinted', tint !== null);

    // Out of a card grown from the pill (the island opening from it): the same card carries on.
    // Into one (the island closing with the pointer on the pill): it carries on back the same way.
    // On its way back into a grown card it counts as one already.
    const morph = view.morph === true;
    const nowMorph = this.carry === 'back' || this.morph;
    const step = handOff({ shown: this.shown, morph: nowMorph, closing: this.cover === 'shrinking' }, morph, geo.immediate === true || reducedMotion());
    // The columns for the new width: not on content a carry is about to fade out (it keeps the
    // layout it has; the content that takes over gets its own in crossFade()).
    if (step !== 'unmorph' && step !== 'remorph') this.inner.style.setProperty('--cols', this.width >= 520 ? '4' : '2');
    if (step === 'unmorph') this.unmorph();
    else if (step === 'remorph') this.remorph();
    else if (step === 'replace') this.hide(true);
    const appearing = !this.shown;
    if (appearing) {
      // Still shrinking back into the pill: it grows again from where it is, its content
      // coming back from however far it had faded.
      const regrow = step === 'regrow';
      const faded = regrow ? clamp01(Number(this.inner.style.opacity || 1)) : 0.35;
      const from = regrow && this.drawn ? { w: this.drawn.w, h: this.drawn.h } : { w: this.pill.w, h: this.pill.h };
      this.stopClose();
      this.morph = morph;
      this.el.classList.toggle('morph', morph);
      this.el.style.display = '';
      this.shown = true;
      for (const a of this.inner.getAnimations()) a.cancel();
      this.inner.style.opacity = '';

      this.inner.style.filter = '';
      if (morph) {
        // Grown out of the pill it starts as the pill itself, solid, and from here it is the pill:
        // the pill's own glass goes, its content fades out.
        this.setCover('grown');
        this.springs.set({ h: from.h, o: 1, s: 1, b: 0, w: from.w, m: 1 }, { immediate: true });
        if (geo.immediate || reducedMotion()) this.springs.set({ w: this.width }, { immediate: true });
        else this.grow(from.w, from.h);
        // The content grows with the shape (placeGrown scales it) and fades in with it; held still,
        // it fades in where it ends up, uncovered by the shape.
        springAnimate(this.inner, [{ opacity: this.opts.still && !regrow ? 0 : faded }, { opacity: 1 }], springs.fade);
      } else this.springs.set({ h: SLIVER, o: 0, s: 0.94, b: 8, w: this.width, m: 0 }, { immediate: true });
    } else if (this.opening) this.opening.w1 = this.width;
    // A new width (the hover card turning into the Control Center as the pill opens)
    // springs with the pill instead of jumping in one frame.
    else this.springs.set({ w: this.width }, { config: morph ? GROW_SPRING : springs.open, immediate: geo.immediate });
    let changed = false;
    // Out of a grown card the content always crosses over: the old one keeps the grown card's
    // layout where it is and fades, the new one comes in laid out for the open island.
    const carried = step === 'unmorph' || step === 'remorph';
    if (view.key !== this.viewKey || carried) {
      if (!appearing && this.viewKey !== null) this.crossFade(carried);
      else this.clear();
      this.viewKey = view.key;
      changed = true;
    }
    if (step === 'remorph') {
      // Laid out (and measured) as the grown card it is turning into, so nothing moves inside it
      // when it becomes one.
      this.el.classList.add('morph');
      this.inner.style.padding = getComputedStyle(this.inner).padding;
      this.el.classList.remove('morph');
    }
    this.pinInner(this.inner, this.width);
    changed = this.patch(view.blocks) || changed;
    if (changed || appearing) this.fit(geo.immediate === true);
    // In without a bounce: an overshooting scale reads as a shake as the island opens.
    if (appearing && !morph) this.springs.set({ o: 1, s: 1, b: 0 }, { config: { o: springs.fade, s: springs.snappy, b: springs.fade }, immediate: geo.immediate });
    // New content gets its whole-pixel spot now, not on the next frame the springs happen to move.
    this.place();
  }

  // ---------------------------------------------------------------- placement

  /**
   * The island opened while a grown card stood in for the pill: the same card carries on as the
   * open island's card. One shape splits in two: its edges grow on to the open card's, the edge over
   * the pill drawing back off it, and the pill bar shows in what that edge uncovers. It used to
   * vanish at once, leaving the resting pill showing for a moment before the island opened (Moss: it
   * looked like a glitch).
   */
  private unmorph(): void {
    // Opened mid-grow: the card carries on from where it got to, on the grow's own curve (a new
    // tween from rest there read as the card stopping at the click and setting off again).
    const g = this.opening;
    const s = g && this.carry === null ? (performance.now() - g.start) / GROW_MS : 0;
    // Its content stays exactly as it was drawn (a grown card pads it differently) while it fades:
    // dropping the grown look first nudged it sideways inside the card the moment of the click.
    this.inner.style.padding = getComputedStyle(this.inner).padding;
    this.startCarry('open', s < 1 ? s : 0);
  }

  /**
   * The island closed with the pointer still on the pill: its card carries on back into the grown
   * card the pointer asks for, the opening played backwards (the card's edge coming back over the
   * pill bar, the two joining into one shape).
   */
  private remorph(): void {
    this.startCarry('back', 0);
  }

  /**
   * Sets a carry off from the shape on screen. From here to its end the card's box does not move
   * and nothing in it does: placeCarry() draws the shape as a clip, like a grown card's.
   */
  private startCarry(way: 'open' | 'back', s: number): void {
    const from = this.drawn ?? { x: this.elAt.x, y: this.elAt.y, w: this.springs.get('w'), h: this.springs.get('h') };
    const radius = this.carry ? this.carryRadiusNow : this.morph ? MORPH_RADIUS : CARD_RADIUS;
    // A grown card is one shape with the pill; an ordinary card stands apart from it, the pill whole.
    this.carrySplit0 = this.carry ? this.carrySplitNow : this.morph ? 0 : 1;
    this.carryPill0 = this.carry ? this.carryPillNow : this.morph ? 0 : 1;
    this.carrySplitNow = this.carrySplit0;
    this.carryPillNow = this.carryPill0;
    cancelAnimationFrame(this.openFrame);
    // A carry cut short by this one: what it was fading out goes now.
    this.carryOld?.remove();
    this.carryOld = null;
    const sh = this.shadow;
    if (this.el.classList.contains('morph') || this.carry) {
      // The shadow is already the shape's own (a grown card's, a carry's): it turns into the one this ends with.
      sh.classList.toggle('card', way === 'open');
    } else {
      // An ordinary card's shadow is its box's: the shape's own takes over, looking the same, then turns.
      sh.classList.add('card');
      sh.style.transform = `translate3d(${from.x}px, ${from.y}px, 0)`;
      sh.style.width = `${from.w}px`;
      sh.style.height = `${from.h}px`;
      sh.style.borderRadius = `${radius}px`;
      sh.style.opacity = '1';
      sh.style.display = '';
      void sh.offsetWidth;
      sh.classList.toggle('card', way === 'open');
    }
    this.morph = false;
    this.el.classList.remove('morph');
    this.el.classList.add('carry');
    // The styles a grown card left are the carry's now (leaveCarry() clears them).
    this.grownStyled = false;
    this.boxX = null;
    this.boxY = null;
    this.carry = way;
    this.carryR = 0;
    this.carryRect = { ...from };
    this.carryRadius = radius;
    this.carryRadiusNow = radius;
    this.setCover('uncovering');
    // One move, the hover's grow carried on, in the grow's time (show() and fit() aim it).
    const now = this.shapeNow();
    this.opening = { start: performance.now(), s, w0: now.w, h0: now.h, m0: now.m, w1: this.width, h1: this.fitH || now.h, m1: way === 'open' ? 0 : 1 };
    const step = (t: number) => {
      const o = this.opening;
      if (!o || !this.carry) return;
      const u = Math.min(1, (t - o.start) / GROW_MS);
      this.carryR = carryCurve(u, o.s);
      if (u < 1) {
        this.place();
        this.openFrame = requestAnimationFrame(step);
        return;
      }
      this.opening = null;
      this.endCarry();
    };
    this.openFrame = requestAnimationFrame(step);
  }

  /** The card's shape as it is now. */
  private shapeNow(): Shape {
    return { w: this.springs.get('w'), h: this.springs.get('h'), m: clamp01(this.springs.get('m')) };
  }

  /** A carry that got where it was going: its old content goes, and the card is what it became. */
  private endCarry(): void {
    const way = this.carry;
    if (!way) return;
    const goal = this.carryGoal();
    this.leaveCarry();
    if (way === 'open') {
      this.springs.set({ w: this.width, h: this.fitH, m: 0, o: 1, s: 1, b: 0 }, { immediate: true });
      this.setCover('off');
    } else {
      // Back as a grown card: from here it is the pill again (laid out as one all the way, see show()).
      this.morph = true;
      this.morphH = this.fitH;
      this.el.classList.add('morph');
      this.inner.style.padding = '';
      // Its box where the carry kept its content: nothing moves as it takes over.
      this.boxX = goal.box.x;
      this.boxY = goal.box.y;
      this.springs.set({ w: this.width, h: this.fitH, m: 1, o: 1, s: 1, b: 0 }, { immediate: true });
      this.setCover('grown');
    }
    this.place();
  }

  /** Out of a carry: the box is the card's own again, its content where a card keeps it, the pill whole. */
  private leaveCarry(): void {
    if (!this.carry) return;
    this.carry = null;
    this.carryRect = null;
    this.carryOld?.remove();
    this.carryOld = null;
    this.el.classList.remove('carry');
    const st = this.el.style;
    st.clipPath = '';
    st.borderRadius = '';
    const bg = this.bg.style;
    bg.left = '';
    bg.top = '';
    bg.width = '';
    bg.height = '';
    bg.maskImage = '';
    bg.webkitMaskImage = '';
    const sh = this.shadow;
    sh.style.display = 'none';
    sh.style.borderRadius = '';
    sh.classList.remove('card');
    const ns = this.inner.style;
    ns.opacity = '';
    ns.filter = '';
    ns.top = '';
    ns.bottom = '';
    this.pinInner(this.inner, parseFloat(ns.width) || this.width);
    this.pillWhole();
  }

  /** The pill is its own again: nothing of a carry's holds its content, its light or its outline. */
  private pillWhole(): void {
    const root = document.documentElement.style;
    root.removeProperty('--pill-in');
    root.removeProperty('--pill-glass');
    root.removeProperty('--pill-ring');
    root.removeProperty('--pill-clip');
    root.removeProperty('--grown-ring');
  }

  private setCover(cover: PillCover): void {
    if (cover === this.cover) return;
    this.cover = cover;
    this.onCover(cover);
  }

  private hide(immediate: boolean): void {
    if (!this.shown) return;
    // Back into the pill, which has no tint: it fades as the card goes.
    this.el.classList.remove('tinted');
    // Gone mid-grow: the grow stops here (the close starts from where it got to). Gone mid-carry:
    // it fades where it stands (its shape and content stay as drawn), and the pill is whole again.
    this.stopGrow();
    if (this.carry) {
      this.pillWhole();
      this.setCover('off');
    }
    this.drag?.abort();
    this.closeHubMenu(true);
    this.shown = false;
    this.viewKey = null;
    this.engagedInput = null;
    const done = () => {
      if (this.shown) return;
      this.stopClose();
      this.el.style.display = 'none';
      this.clear();
      for (const a of this.inner.getAnimations()) a.cancel();
      this.inner.style.opacity = '';

      this.inner.style.filter = '';
      this.leaveCarry();
      this.morph = false;
      this.el.classList.remove('morph');
      this.unstyleGrown();
      this.el.style.borderRadius = '';
      this.drawn = null;
      // Back on the pill's exact shape: the pill takes over again.
      this.setCover('off');
      this.onMove();
    };
    if (immediate || reducedMotion()) {
      this.springs.set({ h: SLIVER, o: 0, s: 0.94, b: 8, m: 0 }, { immediate: true });
      done();
      return;
    }
    if (this.morph) {
      this.close(done);
      return;
    }
    this.springs.set({ h: SLIVER, o: 0, s: 0.95, b: 6 }, { config: { h: springs.snappy, o: springs.fade, s: springs.snappy, b: springs.fade } });
    this.springs.onRest(done);
  }

  /**
   * Back into the pill: the grow played backwards, in the same fixed time. The content shrinks
   * with the shape and fades ahead of it, and the pill's own content fades in as it lands (both
   * locked to how far it got, see placeGrown), so the two barely overlap.
   */
  private close(done: () => void): void {
    const w0 = this.drawn?.w ?? this.springs.get('w');
    const h0 = this.drawn?.h ?? this.springs.get('h');
    this.closeT = 0;
    // The pill's content stays out until the shape nears it.
    document.documentElement.style.setProperty('--pill-in', '0');
    this.setCover('shrinking');
    const start = performance.now();
    cancelAnimationFrame(this.closeFrame);
    const step = (now: number) => {
      if (this.shown || this.cover !== 'shrinking') return;
      const u = Math.min(1, (now - start) / GROW_MS);
      this.closeT = closeCurve(u);
      // The pill as it is on this frame: it may be turning into the menu.
      const p = this.pill;
      this.springs.set({ w: w0 + (p.w - w0) * this.closeT, h: h0 + (p.h - h0) * this.closeT }, { immediate: true });
      if (u < 1) this.closeFrame = requestAnimationFrame(step);
      else done();
    };
    this.closeFrame = requestAnimationFrame(step);
  }

  private stopClose(): void {
    cancelAnimationFrame(this.closeFrame);
    this.closeT = 0;
    document.documentElement.style.removeProperty('--pill-in');
  }

  /** Grows a card out of the pill to its full size, in a fixed time (the close's mirror). */
  private grow(w0: number, h0: number): void {
    this.tween({ w: w0, h: h0, m: 1 }, 1, 0);
  }

  /**
   * The card's shape from `from` to this.width wide, the fitted height and `m1` (over the pill or
   * under it), on the grow's curve in its fixed time; show() and fit() re-aim it on the way.
   */
  private tween(from: Shape, m1: number, s: number): void {
    cancelAnimationFrame(this.openFrame);
    this.opening = { start: performance.now(), s, w0: from.w, h0: from.h, m0: from.m, w1: this.width, h1: this.fitH || from.h, m1 };
    const step = (now: number) => {
      const o = this.opening;
      if (!o) return;
      const u = Math.min(1, (now - o.start) / GROW_MS);
      const r = carryCurve(u, o.s);
      this.springs.set(tweenShape({ w: o.w0, h: o.h0, m: o.m0 }, { w: o.w1, h: o.h1, m: o.m1 }, r), { immediate: true });
      if (u < 1) this.openFrame = requestAnimationFrame(step);
      else this.opening = null;
    };
    this.openFrame = requestAnimationFrame(step);
  }

  /** Stops a grow (or a carry's move) where it got to. */
  private stopGrow(): void {
    cancelAnimationFrame(this.openFrame);
    this.opening = null;
  }

  /** Measures the content and springs the card's height to it. */
  private fit(immediate: boolean): void {
    const max = Math.max(160, Math.min(this.area.height * 0.72, 660));
    this.inner.style.maxHeight = `${max}px`;
    // The content box itself (capped at max), not scrollHeight: that also counts whatever only
    // overflows (a tile mid-slide, the page-turn bars), and on a Mac the card kept its edit-mode
    // height after Done.
    let h = Math.min(max, this.inner.offsetHeight);
    // Grown on a side edge: at least as long as the pill it covers, so no end of the pill is left out.
    if (this.morph && (this.anchor === 'left' || this.anchor === 'right')) h = Math.max(h, this.pill.h);
    this.fitH = h;
    if (this.morph || this.carry === 'back') this.morphH = h;
    if (this.opening) {
      this.opening.h1 = h;
      return;
    }
    this.springs.set({ h }, { config: this.morph ? GROW_SPRING : springs.open, immediate });
  }

  /**
   * Lays content out at its final width, centred: while the card's width springs, the
   * card clips it instead of the text re-wrapping every frame. Content that is fading out
   * keeps the width it had, so it does not re-wrap either.
   */
  private pinInner(inner: HTMLElement, width: number): void {
    inner.style.width = `${width}px`;
    inner.style.left = `calc(50% - ${width / 2}px)`;
    inner.style.right = 'auto';
  }

  private place(v = this.springs.values()): void {
    // Nothing to place while hidden (a hit area for a card no one sees would take the mouse).
    if (!this.ready || this.el.style.display === 'none') return;
    if (this.carry) {
      this.placeCarry(v);
      return;
    }
    // Snapped too: a bottom-anchored card's content hangs from its bottom edge.
    const p = this.pill;
    // On its way back it is never smaller than the pill: a pill growing faster than the card
    // shrinks (into the menu) would otherwise show its content off the card, with no glass under it.
    const back = this.cover === 'shrinking';
    const h = snapPx(Math.max(0, back ? Math.max(v.h, p.h) : v.h));
    let w = Math.max(0, Math.round(back ? Math.max(v.w, p.w) : v.w));
    const { width: W, height: H } = this.area;
    const clampX = (x: number) => Math.max(EDGE, Math.min(W - w - EDGE, x));
    const clampY = (y: number) => Math.max(EDGE, Math.min(H - h - EDGE, y));
    let x: number;
    let y: number;
    // Grown out of the pill: over it, from the edge it rests on; else beside it, across the gap.
    // In between while a grown card slides off the pill to become the open island's card.
    const m = clamp01(v.m);
    switch (this.anchor) {
      case 'top':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = mix(p.y + p.h + GAP, p.y, m);
        break;
      case 'bottom':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = mix(p.y - GAP - h, p.y + p.h - h, m);
        break;
      case 'left':
        x = mix(p.x + p.w + GAP, p.x, m);
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
      case 'right':
        x = mix(p.x - GAP - w, p.x + p.w - w, m);
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
    }
    if (this.morph) {
      this.placeGrown(x, y, w, h, v.o);
      return;
    }
    if (m > 0) {
      // The pill's round ends while it is the pill's size, the grown card's corners once grown, and
      // an ordinary card's as it slides off the pill.
      const pillR = Math.min(p.w, p.h) / 2;
      const t = clamp01(Math.abs(h - p.h) / Math.max(1, Math.abs(this.morphH - p.h)));
      this.el.style.borderRadius = `${mix(CARD_RADIUS, pillR + (MORPH_RADIUS - pillR) * t, m)}px`;
    } else if (this.el.style.borderRadius) this.el.style.borderRadius = '';
    // On whole screen pixels: the card is its own layer, and once it stops resizing, moving it by a
    // fraction of a pixel (following the pill as it settles) stretches what was drawn and blurs it.
    // Each edge on its own pixel, and the content on one of its own about the card's true centre, so
    // a card widening (a grown card turning into the open island's) moves neither by a part of a pixel.
    const k = window.devicePixelRatio || 1;
    for (const inner of this.el.querySelectorAll<HTMLElement>(':scope > .sheet-inner')) {
      const iw = parseFloat(inner.style.width);
      if (iw > 0) inner.style.left = `${contentLeft(x, w, iw, k)}px`;
    }
    const span = snapSpan(x, w, k);
    x = span.x;
    w = span.w;
    y = snapPx(y);
    const st = this.el.style;
    st.transform = `translate3d(${x}px, ${y}px, 0) scale(${v.s})`;
    st.width = `${w}px`;
    st.height = `${h}px`;
    st.opacity = String(clamp01(v.o));
    st.filter = v.b > 0.08 ? `blur(${v.b.toFixed(2)}px)` : '';
    this.elAt = { x, y };
    this.drawn = { x, y, w, h };
    this.onMove();
  }

  /**
   * Where a carry is heading: the shape as place() (or, back into a grown card, placeGrown()) draws
   * it once there, the card's box then, and the spot its content has in it, all on screen.
   */
  private carryGoal(): { shape: Rect; radius: number; box: { x: number; y: number }; inner: { x: number; y: number } } {
    const back = this.carry === 'back';
    // Opening, the pill is already where it will be (island.ts puts it there at the click). Back
    // into a grown card it is held as it was, so the card goes by where the pill will be; a grown
    // card sits by the pill's centre and outer edge, which are the same for both, so a carry that
    // turns round half way (a second click) does not shift what it was drawing.
    const p = back ? (this.pillTo ?? this.pill) : this.pill;
    const { width: W, height: H } = this.area;
    const k = window.devicePixelRatio || 1;
    const w = Math.max(0, this.width);
    const h = snapPx(Math.max(0, this.fitH));
    const clampX = (x: number) => Math.max(EDGE, Math.min(W - w - EDGE, x));
    const clampY = (y: number) => Math.max(EDGE, Math.min(H - h - EDGE, y));
    let x: number;
    let y: number;
    switch (this.anchor) {
      case 'top':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = back ? p.y : p.y + p.h + GAP;
        break;
      case 'bottom':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = back ? p.y + p.h - h : p.y - GAP - h;
        break;
      case 'left':
        x = back ? p.x : p.x + p.w + GAP;
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
      case 'right':
        x = back ? p.x + p.w - w : p.x - GAP - w;
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
    }
    // Content that hangs from the card's bottom edge (the island at the bottom of the screen).
    const hang = this.anchor === 'bottom' ? h - Math.min(h, this.inner.offsetHeight) : 0;
    if (back) {
      // A grown card's box (placeGrown): its full size, on whole device pixels, its content at its corner.
      let fx = this.anchor === 'left' ? p.x : this.anchor === 'right' ? p.x + p.w - w : p.x + p.w / 2 - w / 2;
      let fy = this.anchor === 'top' ? p.y : this.anchor === 'bottom' ? p.y + p.h - h : p.y + p.h / 2 - h / 2;
      fx = snapPx(Math.max(EDGE, Math.min(W - w - EDGE, fx)));
      fy = snapPx(Math.max(EDGE, Math.min(H - h - EDGE, fy)));
      return { shape: { x, y, w, h }, radius: MORPH_RADIUS, box: { x: fx, y: fy }, inner: { x: fx, y: fy + hang } };
    }
    // An ordinary card's (place): each edge on its own device pixel, its content on one of its own.
    const span = snapSpan(x, w, k);
    const top = snapPx(y);
    const iw = parseFloat(this.inner.style.width) || w;
    return { shape: { x: span.x, y: top, w: span.w, h }, radius: CARD_RADIUS, box: { x: span.x, y: top }, inner: { x: span.x + contentLeft(x, w, iw, k), y: top + hang } };
  }

  /**
   * A carried card: a grown card turning into the open island's card, or back. Nothing a reader
   * can see moves, and the outline of the whole never steps:
   * - The card's box stays where it was. The content it had stays in it and fades; the content it
   *   takes on sits where it will stay from the first frame and fades in. Only the shape goes (a
   *   clip, the background and the shadow, as for a grown card), its edges at one pace.
   * - The pill bar is not moved, and not uncovered bit by bit: the part of the shape over the pill
   *   simply becomes the bar. Its glass takes over from the card's there (a cross-fade in place),
   *   its content fades in as the card's old content fades out, and then a seam opens between bar
   *   and card and their new corners round off (carrySplit). One shape splits in two; joining back
   *   is the same backwards.
   * Content that slid with the card read as a shake however the slide was timed, and a bar
   * uncovered from its top edge down had its text cut through on the way (Justin, 2026-11-14).
   */
  private placeCarry(v: { o: number; b: number }): void {
    const from = this.carryRect;
    const way = this.carry;
    if (!from || !way) return;
    const goal = this.carryGoal();
    const r = this.carryR;
    const side: Side = this.anchor;
    const body = carryShape(from, goal.shape, r, side);
    const radius = mix(this.carryRadius, goal.radius, r);
    this.carryRadiusNow = radius;
    const k = carryApart(this.carrySplit0, way, r);
    this.carrySplitNow = k;
    const split = carrySplit(k);
    const p = this.pill;
    const card = carryCard(p, body, side, GAP, k);
    const at = this.elAt;
    // The content it takes on: where it will stay.
    const ns = this.inner.style;
    ns.left = `${goal.inner.x - at.x}px`;
    ns.top = `${goal.inner.y - at.y}px`;
    ns.right = 'auto';
    ns.bottom = 'auto';
    ns.transform = '';
    // The two fade locked to how far the shape got; blurred as they cross (as the island always
    // blurs what leaves), so in the frames where both are partly there neither reads over the other.
    const f = carryFades(r);
    const old = this.carryOld;
    if (old) {
      old.style.opacity = String(f.old * this.carryFrom);
      old.style.filter = f.old < 0.999 ? `blur(${(6 * (1 - f.old)).toFixed(2)}px)` : '';
    }
    ns.opacity = String(f.new);
    ns.filter = f.new < 0.999 ? `blur(${(4 * (1 - f.new)).toFixed(2)}px)` : '';
    // Four corner radii, clockwise from the top left: `near` for the two on the side facing the pill.
    const corners = (near: number, far: number): string => {
      const n = `${near.toFixed(2)}px`;
      const o = `${far.toFixed(2)}px`;
      return { top: `${n} ${n} ${o} ${o}`, bottom: `${o} ${o} ${n} ${n}`, left: `${n} ${o} ${o} ${n}`, right: `${o} ${n} ${n} ${o}` }[side];
    };
    if (this.cover === 'uncovering') {
      // The pill bar's part of the shape: as wide as the card, its outer corners the shape's, the
      // ones on the seam rounding as it opens. Its content comes with the card's new content (or
      // goes with the old), from however much of it showed.
      const slice = pillSlice(p, body, side, k);
      const own = Math.min(p.w, p.h) / 2;
      const shown = way === 'open' ? this.carryPill0 + (1 - this.carryPill0) * f.new : this.carryPill0 * f.old;
      this.carryPillNow = shown;
      // Its own round ends take over from the shape's corners once the two are apart. (For the
      // pill the seam's corners are the far ones of a card's: the pill lies on the other side of it.)
      const outerR = radius * (1 - clamp01((k - 0.7) / 0.3));
      const pillCorners = corners(outerR, own * split.seam);
      const root = document.documentElement.style;
      root.setProperty('--pill-in', shown.toFixed(3));
      root.setProperty('--pill-glass', split.glass.toFixed(3));
      root.setProperty('--pill-ring', split.ring.toFixed(3));
      root.setProperty('--grown-ring', (1 - split.glass).toFixed(3));
      root.setProperty('--pill-clip', `inset(${slice.top.toFixed(2)}px ${slice.right.toFixed(2)}px ${slice.bottom.toFixed(2)}px ${slice.left.toFixed(2)}px round ${pillCorners})`);
    }
    // The shape: a clip on the box that stays (the whole outline, so neither content is cut where
    // the bar is), the card's own glass, and the shadow round the whole.
    const op = String(clamp01(v.o));
    const st = this.el.style;
    st.opacity = op;
    st.filter = v.b > 0.08 ? `blur(${v.b.toFixed(2)}px)` : '';
    const o = card.outer;
    st.clipPath = `xywh(${(o.x - at.x).toFixed(2)}px ${(o.y - at.y).toFixed(2)}px ${o.w.toFixed(2)}px ${o.h.toFixed(2)}px round ${radius.toFixed(2)}px)`;
    // Its glass: over the whole shape while the bar's takes over its part (see-through there by as
    // much as the bar's is in), then from across the seam, its corners there rounding as it opens.
    st.borderRadius = corners(card.handed ? radius * split.seam : radius, radius);
    const g = card.glass;
    const bg = this.bg.style;
    bg.left = `${g.x - at.x}px`;
    bg.top = `${g.y - at.y}px`;
    bg.width = `${g.w}px`;
    bg.height = `${g.h}px`;
    const mask = card.handed || card.over >= 0.999 ? '' : `linear-gradient(to ${{ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side]}, rgba(0, 0, 0, ${card.over.toFixed(3)}) ${card.depth.toFixed(2)}px, #000 ${card.depth.toFixed(2)}px)`;
    bg.maskImage = mask;
    bg.webkitMaskImage = mask;
    const sh = this.shadow.style;
    sh.display = '';
    sh.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
    sh.width = `${o.w}px`;
    sh.height = `${o.h}px`;
    sh.borderRadius = `${radius.toFixed(2)}px`;
    sh.opacity = op;
    this.drawn = { x: g.x, y: g.y, w: g.w, h: g.h };
    this.onMove();
  }

  /**
   * A card grown out of the pill. The box holding the content stays at its full-size spot on
   * whole device pixels and never moves while the card grows or shrinks; only its shape does: the
   * background, the shadow and a clip that hides whatever is past the shape. Moving the box every
   * frame (and the content back inside it) re-rounded half-pixel edges each frame, so the cover
   * art and the text flickered by a pixel.
   */
  private placeGrown(vx: number, vy: number, vw: number, vh: number, o: number): void {
    const p = this.pill;
    const { width: W, height: H } = this.area;
    const fw = this.width;
    const fh = Math.max(this.fitH, vh);
    let fx: number;
    let fy: number;
    switch (this.anchor) {
      case 'top':
        fx = p.x + p.w / 2 - fw / 2;
        fy = p.y;
        break;
      case 'bottom':
        fx = p.x + p.w / 2 - fw / 2;
        fy = p.y + p.h - fh;
        break;
      case 'left':
        fx = p.x;
        fy = p.y + p.h / 2 - fh / 2;
        break;
      case 'right':
        fx = p.x + p.w - fw;
        fy = p.y + p.h / 2 - fh / 2;
        break;
    }
    fx = Math.max(EDGE, Math.min(W - fw - EDGE, fx));
    fy = Math.max(EDGE, Math.min(H - fh - EDGE, fy));
    // Kept unless the spot really moves: spring noise must not flip the rounding.
    if (this.boxX === null || Math.abs(fx - this.boxX) > 0.6) this.boxX = snapPx(fx);
    if (this.boxY === null || Math.abs(fy - this.boxY) > 0.6) this.boxY = snapPx(fy);
    const bx = this.boxX;
    const by = this.boxY;
    const lx = vx - bx;
    const ly = vy - by;
    const op = String(clamp01(o));
    const st = this.el.style;
    st.transform = `translate3d(${bx}px, ${by}px, 0)`;
    this.elAt = { x: bx, y: by };
    st.width = `${fw}px`;
    st.height = `${fh}px`;
    st.opacity = op;
    st.filter = '';
    st.borderRadius = '';
    st.clipPath = `xywh(${lx.toFixed(2)}px ${ly.toFixed(2)}px ${vw.toFixed(2)}px ${vh.toFixed(2)}px round ${MORPH_RADIUS}px)`;
    const bg = this.bg.style;
    bg.left = `${lx}px`;
    bg.top = `${ly}px`;
    bg.width = `${vw}px`;
    bg.height = `${vh}px`;
    const sh = this.shadow.style;
    sh.display = '';
    sh.transform = `translate3d(${vx}px, ${vy}px, 0)`;
    sh.width = `${vw}px`;
    sh.height = `${vh}px`;
    sh.opacity = op;
    this.inner.style.left = '0px';
    // While the shape is smaller than the card, the content scales with it from the pill's outer
    // edge, so it grows out of the pill and shrinks back into it (never a blank card). At full size
    // there is no transform at all, so the text is crisp and still.
    const vertical = this.anchor === 'left' || this.anchor === 'right';
    const k = clamp01(vertical ? vh / Math.max(1, fh) : vw / Math.max(1, fw));
    this.inner.style.transformOrigin = { top: '50% 0', bottom: '50% 100%', left: '0 50%', right: '100% 50%' }[this.anchor];
    // Already grown and only widening (Music's lyrics panel opening): the content keeps its size and
    // rides the card's left edge, so the player glides aside as the panel is uncovered, instead of
    // the whole card shrinking and zooming back in (Justin's recording).
    const resizing = !this.opening && this.cover === 'grown' && !vertical;
    if (resizing) this.inner.style.transform = k < 0.999 ? `translateX(${lx.toFixed(2)}px)` : '';
    else this.inner.style.transform = k < 0.999 && !this.opts.still ? `scale(${k.toFixed(4)})` : '';
    if (this.cover === 'shrinking') {
      // The card's content fades over most of the way back and the pill's own content fades in
      // over the last part (island.css, --pill-in), both locked to the shape, not to a clock.
      const ease = (a: number, b: number) => {
        const u = clamp01((this.closeT - a) / (b - a));
        return u * u * (3 - 2 * u);
      };
      this.inner.style.opacity = String(1 - ease(0.1, 0.85));
      document.documentElement.style.setProperty('--pill-in', String(ease(0.55, 1)));
    }
    this.grownStyled = true;
    this.drawn = { x: vx, y: vy, w: vw, h: vh };
    this.onMove();
  }

  /** Back to an ordinary card: the box is the shape again. */
  private unstyleGrown(): void {
    if (!this.grownStyled) return;
    this.grownStyled = false;
    this.el.style.clipPath = '';
    const bg = this.bg.style;
    bg.left = '';
    bg.top = '';
    bg.width = '';
    bg.height = '';
    this.shadow.style.display = 'none';
    this.inner.style.transform = '';
    // At the width it was laid out at, not the new one (the open island's): its text stays put.
    this.pinInner(this.inner, parseFloat(this.inner.style.width) || this.width);
    this.boxX = null;
    this.boxY = null;
  }

  // ---------------------------------------------------------------- content

  private clear(): void {
    this.gridPage = 0;
    this.boxX = null;
    this.boxY = null;
    this.drag?.abort();
    this.nodes.clear();
    this.inner.replaceChildren();
    this.engagedInput = null;
  }

  /** Control Center's page when a tile's card took its place, to come back to. */
  private gridPage = 0;

  /** The old content blurs out in place while the new content builds up. */

  private crossFade(fromGrown = false): void {
    // Control Center giving way to an activity's card (a tile tapped): its page is kept for the way back.
    const grid = [...this.nodes.values()].find((n) => n.t === 'tiles');
    if (grid) this.gridPage = this.currentPage(grid.el);
    this.drag?.abort();
    const old = this.inner;
    old.classList.add('leaving');
    old.style.pointerEvents = 'none';
    if (fromGrown && this.carry) {
      // Carried on: the two fade locked to the shape's move (place(), carryFades), from however far
      // the old one had faded in.
      this.carryFrom = clamp01(Number(getComputedStyle(old).opacity));
      for (const a of old.getAnimations()) a.cancel();
      old.style.opacity = String(this.carryFrom);
      this.carryOld?.remove();
      this.carryOld = old;
      this.inner = make('div', 'sheet-inner');
      this.inner.style.setProperty('--cols', this.width >= 520 ? '4' : '2');
      this.inner.style.opacity = '0';
      this.el.append(this.inner);
      this.nodes.clear();
      this.engagedInput = null;
      return;
    }
    const gone = () => old.remove();
    // A grown card swaps with a plain fade (and so does one turning into the open island's card):
    // blurring text that size reads as a wobble.
    const blur = this.morph || fromGrown ? 0 : 5;
    const anim = springAnimate(old, [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: `blur(${blur}px)` }], springs.fade, { fill: 'forwards' });
    if (anim) anim.finished.then(gone, gone);
    else gone();
    this.inner = make('div', 'sheet-inner');
    this.inner.style.setProperty('--cols', this.width >= 520 ? '4' : '2');
    this.el.append(this.inner);
    springAnimate(this.inner, [{ opacity: 0, filter: `blur(${blur}px)` }, { opacity: 1, filter: 'blur(0px)' }], springs.content);
    this.nodes.clear();
    this.engagedInput = null;
  }

  /** Brings the DOM in line with `blocks`; true when anything changed. */
  private patch(blocks: Block[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    blocks.forEach((b, i) => {
      seen.add(b.key);
      const sig = JSON.stringify(b);
      let node = this.nodes.get(b.key);
      if (node && node.t === b.t && node.sig === sig) {
        node.spec = b;
      } else if (node && node.t === b.t && this.patchInPlace(node, b)) {
        node.sig = sig;
        node.spec = b;
        changed = true;
      } else {
        const el = this.build(b);
        el.dataset.k = b.key;
        if (node) node.el.replaceWith(el);
        node = { t: b.t, sig, el, spec: b };
        this.nodes.set(b.key, node);
        if (!this.inner.contains(el)) this.inner.append(el);
        changed = true;
      }
      // Keep DOM order without touching nodes already in place (a moved input loses focus).
      const at = this.inner.children[i];
      if (at !== node.el) this.inner.insertBefore(node.el, at ?? null);
    });
    for (const [key, node] of this.nodes) {
      if (seen.has(key)) continue;
      node.el.remove();
      this.nodes.delete(key);
      if (this.engagedInput && node.el.contains(this.engagedInput)) this.engagedInput = null;
      changed = true;
    }
    return changed;
  }

  /** Updates that must not rebuild the element. False means "rebuild it". */
  private patchInPlace(node: BlockNode, b: Block): boolean {
    const e = node.el;
    switch (b.t) {
      case 'input': {
        const input = e.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!;
        // One line or several are different elements: changing between them rebuilds it.
        if (input instanceof HTMLTextAreaElement !== Boolean(b.lines)) return false;
        input.placeholder = b.placeholder;
        // What is being typed wins: a new value only reaches a box that doesn't have the keyboard.
        if (b.value !== undefined && document.activeElement !== input && input.value !== b.value) input.value = b.value;
        const hint = e.querySelector<HTMLElement>('.ih');
        if (b.hint && hint) hint.textContent = b.hint;
        else if (b.hint) e.append(make('div', 'ih', b.hint));
        else hint?.remove();
        return true;
      }
      case 'meter': {
        this.fillMeter(e, b);
        return true;
      }
      case 'rows': {
        // Only the bars moved: fill them where they are, so a row being clicked stays put.
        const shape = (items: SheetRow[]) => JSON.stringify(items.map((r) => ({ ...r, bar: r.bar && { label: r.bar.label, tone: r.bar.tone } })));
        if (node.spec.t !== 'rows' || shape(node.spec.items) !== shape(b.items)) return false;
        b.items.forEach((r, i) => {
          const line = e.children[i]?.querySelector<HTMLElement>('.r2.with-bar');
          if (line && r.bar) this.fillRowBar(line, r.bar);
        });
        return true;
      }
      case 'countdown': {
        const prev = node.spec.t === 'countdown' ? node.spec : null;
        e.className = `sb sb-countdown tone-${b.tone ?? 'claude'}`;
        if (!prev || prev.until !== b.until || prev.total !== b.total) this.runCountdown(e.querySelector('.cf')!, b);
        return true;
      }
      case 'tiles': {
        this.patchTiles(e, b);
        return true;
      }
      case 'people':
        return this.fillPeople(e, b);
      case 'files':
        // A tile being dragged into a new place: left as it is till it is let go.
        if (this.reordering) return true;
        this.fillFiles(e, b);
        return true;
      case 'zones': {
        // Only which one is lit, or what they say: patched where they are, so nothing flickers mid-drag.
        if (node.spec.t !== 'zones' || node.spec.items.length !== b.items.length || node.spec.items.some((z, i) => z.key !== b.items[i].key)) return false;
        this.fillZones(e, b);
        return true;
      }
      case 'player':
        // Every second while it plays: the bars and a drag on the scrubber must survive it.
        patchPlayer(e, b, this.bindPlayer);
        if (node.spec.t === 'player' && JSON.stringify(node.spec.chips ?? []) !== JSON.stringify(b.chips ?? [])) e.querySelector('.pk')?.replaceWith(this.chips(b.chips ?? []));
        return true;
      default:
        return false;
    }
  }

  private bind(e: HTMLElement, action: string | undefined, arg: unknown): void {
    if (!action) return;
    e.dataset.action = action;
    args.set(e, arg);
  }

  private button(b: SheetButton, size?: 'sm'): HTMLButtonElement {
    const e = make('button', `sbtn style-${b.style ?? 'secondary'}${b.label ? '' : ' icon-only'}${size ? ` ${size}` : ''}`);
    e.type = 'button';
    if (b.icon) e.append(iconEl(b.icon, 'bi'));
    if (b.label) e.append(make('span', 'bl', b.label));
    if (b.tip) e.title = b.tip;
    if (b.disabled) e.disabled = true;
    else this.bind(e, b.action, b.arg);
    return e;
  }

  /** The pill's chips on a card grown over them, the same look as on the pill (island.css .seg-chip). */
  private chips(list: SheetChip[]): HTMLElement {
    const host = make('div', 'pk');
    if (!list.length) host.style.display = 'none';
    for (const c of list) {
      const e = make('button', `seg-chip tone-${c.tone ?? 'default'}${c.label ? '' : ' icon-only'}`);
      e.type = 'button';
      if (c.dot) {
        const d = make('span', `cd tone-${c.dot}${c.pulse ? ' pulse' : ''}`);
        d.append(make('i', 'ring'), make('i', 'core'));
        e.append(d);
      }
      if (c.icon) e.append(iconEl(c.icon, 'ci'));
      if (c.label) e.append(make('span', 'cl', c.label));
      if (c.tip) e.title = c.tip;
      this.bind(e, c.action, c.arg);
      host.append(e);
    }
    return host;
  }

  private row(r: SheetRow): HTMLElement {
    // A row with its own button cannot itself be a <button>.
    const e = make(r.action && !r.button ? 'button' : 'div', `row${r.action ? ' act' : ''}`);
    if (e instanceof HTMLButtonElement) e.type = 'button';
    if (r.context) {
      e.dataset.context = r.context;
      contextArgs.set(e, r.arg);
    }

    if (r.dot) {
      const d = make('span', `rd tone-${r.dot}${r.pulse ? ' pulse' : ''}${r.unread ? ' unread' : ''}`);
      d.append(make('i', 'ring'), make('i', 'core'), make('i', 'badge'));
      e.append(d);
    } else if (r.icon) e.append(iconEl(r.icon, `ri tone-${r.tone ?? 'muted'}`));
    const tx = make('span', 'rt');
    tx.append(make('span', 'r1', r.title));
    if (r.meter) tx.append(this.rowMeter(r.meter));
    if (r.bar) {
      const line = make('span', 'r2 with-bar');
      const bar = make('span', 'rbar');
      bar.append(make('i', 'fill'));
      line.append(make('span', 'rbd', r.detail ?? ''), bar, make('span', 'rbs'), make('span', 'rbt'));
      this.fillRowBar(line, r.bar);
      tx.append(line);
    } else if (r.detail) tx.append(make('span', 'r2', r.detail));
    e.append(tx);
    if (r.badge) e.append(make('span', 'rb', r.badge));
    if (r.button) {
      const b = this.button(r.button);
      b.classList.add('rbtn');
      b.classList.toggle('shown', r.button.shown === true);
      e.append(b);
    }
    if (r.tip) e.title = r.tip;
    this.bind(e, r.action, r.arg);
    return e;
  }

  /** A row's thin bar under its title (a chat's context), with its figure beside it. */
  private rowMeter(m: NonNullable<SheetRow['meter']>): HTMLElement {
    const e = make('span', `rm tone-${m.tone ?? 'claude'}`);
    const bar = make('i', 'rmb');
    const fill = make('i', 'rmf');
    fill.style.transform = `scaleX(${clamp01(m.value)})`;
    bar.append(fill);
    e.append(bar);
    if (m.text) e.append(make('span', 'rmt', m.text));
    if (m.tip) e.title = m.tip;
    return e;
  }

  private build(b: Block): HTMLElement {
    switch (b.t) {
      case 'player': {
        const e = buildPlayer(b, this.bindPlayer, this.onAction);
        e.querySelector('.pl-top')?.append(this.chips(b.chips ?? []));
        return e;
      }
      case 'head': {
        const e = make('div', `sb sb-head${b.back ? ' has-back' : ''}`);
        if (b.back) e.append(this.button(b.back));
        if (b.icon) e.append(iconEl(b.icon, `hi tone-${b.tone ?? 'default'}`));

        const tx = make('div', 'ht');
        tx.append(make('div', 'h1', b.title));
        if (b.sub) tx.append(make('div', 'h2', b.sub));
        e.append(tx);
        if (b.buttons?.length) {
          const bar = make('div', 'hb');
          for (const x of b.buttons) bar.append(this.button(x));
          e.append(bar);
        }
        if (b.chips?.length) e.append(this.chips(b.chips));
        return e;
      }
      case 'text': {
        const e = make('div', textClass(b));
        const tx = make('div', 'tx', b.text);
        tx.style.setProperty('--lines', String(b.lines ?? 8));
        e.append(tx);
        return e;
      }
      case 'code': {
        const e = make('div', 'sb sb-code');
        e.append(make('code', '', b.text));
        return e;
      }
      case 'buttons': {
        const e = make('div', `sb sb-buttons align-${b.align ?? 'end'}`);
        for (const x of b.items) e.append(this.button(x));
        return e;
      }
      case 'input':
        return this.buildInput(b);
      case 'meter': {
        const e = make('div', 'sb sb-meter');
        const top = make('div', 'mt');
        top.append(make('span', 'ml'), make('span', 'mv'));
        const bar = make('div', 'mb');
        bar.append(make('i', 'fill'), make('i', 'pace'));
        e.append(top, bar, make('div', 'ms'));
        this.fillMeter(e, b);
        return e;
      }
      case 'rows': {
        const e = make('div', 'sb sb-rows');
        for (const r of b.items) e.append(this.row(r));
        return e;
      }
      case 'choices': {
        const e = make('div', 'sb sb-choices');
        for (const c of b.items) {
          if (c.options?.length) {
            // A setting in one row: its name, then its choices side by side.
            const row = make('div', 'choice opts');
            const text = make('span', 'ct');
            text.append(make('span', 'c1', c.label));
            if (c.detail) text.append(make('span', 'c2', c.detail));
            const seg = make('span', 'cseg');
            for (const o of c.options) {
              const ob = make('button', `co${o.selected ? ' on' : ''}`, o.label);
              ob.type = 'button';
              this.bind(ob, o.action, o.arg);
              seg.append(ob);
            }
            row.append(text, seg);
            e.append(row);
            continue;
          }
          const btn = make('button', `choice${c.selected ? ' selected' : ''}`);
          btn.type = 'button';
          btn.append(make('span', 'c1', c.label));
          if (c.detail) btn.append(make('span', 'c2', c.detail));
          this.bind(btn, c.action, c.arg);
          e.append(btn);
        }
        return e;
      }
      case 'stats': {
        const e = make('div', 'sb sb-stats');
        for (const s of b.items) {
          const c = make('div', `stat tone-${s.tone ?? 'default'}`);
          c.append(make('div', 'sv', s.value), make('div', 'sl', s.label));
          if (s.tip) c.title = s.tip;
          e.append(c);
        }
        return e;
      }
      case 'countdown': {
        const e = make('div', `sb sb-countdown tone-${b.tone ?? 'claude'}`);
        const fill = make('i', 'cf');
        e.append(fill);
        this.runCountdown(fill, b);
        return e;
      }
      case 'people': {
        const e = make('div', 'sb sb-people');
        this.fillPeople(e, b);
        return e;
      }
      case 'files': {
        const e = make('div', `sb sb-files${b.wrap ? ' wrap' : ''}`);
        this.fillFiles(e, b);
        return e;
      }
      case 'zones': {
        const e = make('div', 'sb sb-zones');
        for (const z of b.items) {
          const c = make('div', `zone z-${z.key}`);
          c.dataset.zone = z.key;
          const ring = make('div', 'zr');
          ring.append(iconEl(z.icon, 'zi'));
          c.append(ring, make('div', 'zt', z.title), make('div', 'zs', z.sub));
          e.append(c);
        }
        this.fillZones(e, b);
        return e;
      }
      case 'qr': {
        const e = make('div', 'sb sb-qr');
        e.append(qrSvg(b.size, b.cells));
        if (b.caption) e.append(make('div', 'qc', b.caption));
        return e;
      }
      case 'image': {
        const e = make('div', 'sb sb-img');
        const img = make('img', '');
        img.alt = b.alt ?? '';
        img.decoding = 'async';
        img.draggable = false;
        img.src = b.src;
        if (b.max) img.style.maxHeight = `${b.max}px`;
        e.append(img);
        return e;
      }
      case 'calendar':
        return this.buildCalendar(b);
      case 'tiles': {
        const e = make('div', 'sb sb-tiles');
        const bar = (side: string) => {
          const b = make('div', `edge-hold ${side}`);
          b.append(make('i', ''));
          return b;
        };
        e.append(make('div', 'pages'), make('div', 'dots'), make('div', 'tray'), bar('left'), bar('right'));
        this.wireGrid(e);
        this.patchTiles(e, b);
        // Back from a tile's card: the page that tile was on, not the first.
        const page = this.gridPage;
        this.gridPage = 0;
        if (page > 0) {
          requestAnimationFrame(() => {
            const pages = e.querySelector<HTMLElement>('.pages');
            if (!pages || page >= pages.children.length) return;
            pages.scrollLeft = page * this.pageWidth(e);
            this.markPage(e);
          });
        }
        return e;
      }
    }
  }

  /** The calendar block: the grid of days (left) and the picked day with its events (right). */
  private buildCalendar(b: Extract<Block, { t: 'calendar' }>): HTMLElement {
    const e = make('div', `sb sb-cal${b.week ? ' week' : ''}`);
    const left = make('div', 'cg');
    const title = make('div', 'ct');
    title.append(make('span', 'cm', b.title));
    if (b.year) title.append(make('span', 'cy', b.year));
    left.append(title);
    const grid = make('div', 'cd');
    grid.append(make('span', 'cw cwh', ''));
    for (const x of b.heads) grid.append(make('span', 'ch', x));
    for (const w of b.weeks) {
      grid.append(make('span', 'cw', String(w.no)));
      for (const d of w.days) {
        const cell = make('button', `cday${d.today ? ' today' : ''}${d.selected ? ' sel' : ''}${d.out ? ' out' : ''}`);
        cell.type = 'button';
        cell.append(make('span', 'cn', String(d.num)));
        const dots = make('span', 'cb');
        for (let i = 0; i < Math.min(3, d.busy); i++) dots.append(make('i', ''));
        cell.append(dots);
        this.bind(cell, b.pick, d.key);
        grid.append(cell);
      }
    }
    left.append(grid);
    const right = make('div', 'cp');
    right.append(make('div', 'ck', b.day.kicker), make('div', 'cpt', b.day.title), make('div', 'cps', b.day.sub));
    const list = make('div', 'ce');
    if (!b.day.events.length) list.append(make('div', 'cempty', b.day.empty));
    for (const x of b.day.events) {
      const row = make('div', `cev tone-${x.tone ?? 'accent'}`);
      const tx = make('div', 'cet');
      tx.append(make('span', 'cetime', x.time), make('span', 'cetitle', x.title));
      if (x.sub) tx.append(make('span', 'cesub', x.sub));
      row.append(make('i', 'cebar'), tx);
      if (x.buttons?.length) {
        const bar = make('div', 'ceb');
        for (const btn of x.buttons) bar.append(this.button(btn, 'sm'));
        row.append(bar);
      }
      list.append(row);
    }
    right.append(list);
    e.append(left, right);
    return e;
  }

  private fillZones(e: HTMLElement, b: Extract<Block, { t: 'zones' }>): void {
    e.style.height = `${b.height}px`;
    b.items.forEach((z, i) => {
      const c = e.children[i] as HTMLElement | undefined;
      if (!c) return;
      c.style.flexGrow = String(z.grow);
      c.classList.toggle('hot', b.hot === z.key && !z.off);
      c.classList.toggle('off', Boolean(z.off));
      const t = c.querySelector('.zt');
      const s = c.querySelector('.zs');
      if (t && t.textContent !== z.title) t.textContent = z.title;
      if (s && s.textContent !== z.sub) s.textContent = z.sub;
    });
  }

  private buildInput(b: Extract<Block, { t: 'input' }>): HTMLElement {

    const multi = Boolean(b.lines);
    const e = make('div', `sb sb-input${multi ? ' multi' : ''}`);
    const box = make('div', 'ib');
    let input: HTMLInputElement | HTMLTextAreaElement;
    if (multi) {
      const area = make('textarea', '');
      area.rows = Math.max(2, Math.min(12, b.lines ?? 4));
      input = area;
    } else {
      const line = make('input', '');
      line.type = 'text';
      line.autocomplete = 'off';
      input = line;
    }
    input.spellcheck = true;
    input.placeholder = b.placeholder;
    if (b.value !== undefined) input.value = b.value;
    const send = make('button', 'send');
    send.type = 'button';
    send.innerHTML = icon('enter');
    send.title = multi ? 'Done (Ctrl+Enter)' : 'Send (Enter)';
    box.append(input, send);
    e.append(box);
    if (b.hint) e.append(make('div', 'ih', b.hint));
    const spec = () => {
      const n = this.nodes.get(b.key);
      return n && n.spec.t === 'input' ? n.spec : b;
    };
    // A box of lines keeps its text after sending (it is a note being edited); one line starts over.
    const submit = () => {
      const text = input.value.trim();
      if (!text && !multi) return;
      if (!multi) input.value = '';
      flush();
      this.onAction(spec().action, multi ? input.value : text, e);
    };
    // What is typed reaches the activity as it is typed, so nothing is lost when the card closes.
    let sent = input.value;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(wait);
      const change = spec().change;
      if (!change || input.value === sent) return;
      sent = input.value;
      this.onAction(change, sent, e);
    };
    input.addEventListener('input', () => {
      clearTimeout(wait);
      wait = setTimeout(flush, CHANGE_MS);
    });
    input.addEventListener('blur', flush);
    // Pasting a picture or files (no text) into a box that takes them: the activity reads the clipboard itself.
    input.addEventListener('paste', (ev) => {
      const s = spec();
      const data = (ev as ClipboardEvent).clipboardData;
      // No text in it: files or a picture (WebView2 doesn't always list a screenshot in `files`), so Rust reads the clipboard.
      if (!s.pasteFiles || !data || data.getData('text/plain')) return;
      ev.preventDefault();
      this.onAction(s.pasteFiles, null, e);
    });
    // Clicking is the only way in: the island takes the keyboard just for this.
    input.addEventListener('pointerdown', () => {
      this.engagedInput = input;
      this.onAction('island:sheet-engage', b.key, e);
    });
    input.addEventListener('focus', () => {
      const s = spec();
      if (s.engage) this.onAction(s.engage, null, e);
    });
    // Pointing at the box, and leaving it: a card that would go by itself can stay while the user is about to type.
    input.addEventListener('pointerenter', () => {
      const s = spec();
      if (s.point) this.onAction(s.point, true, e);
    });
    input.addEventListener('pointerleave', () => {
      const s = spec();
      if (s.point) this.onAction(s.point, false, e);
    });
    input.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      if (k.key === 'Enter' && (!multi || k.ctrlKey || k.metaKey)) {
        k.preventDefault();
        submit();
      } else if (k.key === 'Escape') {
        k.preventDefault();
        flush();
        this.onAction('island:sheet-escape', null, e);
      }
    });
    send.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submit();
    });
    return e;
  }

  /**
   * A shelf's tiles. Pressing one and moving 6 px starts a drag out of the island (`drag`), and
   * the click that would follow is dropped, so dragging a file never also ticks it.
   */
  private fillFiles(e: HTMLElement, b: Extract<Block, { t: 'files' }>): void {
    e.replaceChildren(
      ...b.items.map((f) => {
        const el = make('div', `ftile tone-${f.tone ?? 'default'}${f.ticked ? ' ticked' : ''}${f.action ? ' act' : ''}`);
        const pic = make('span', 'fpic');
        if (f.thumb) {
          const img = document.createElement('img');
          img.src = f.thumb;
          img.alt = '';
          img.draggable = false;
          pic.append(img);
        } else pic.append(iconEl(f.icon, 'fi'));
        el.append(pic);
        // The tick circle only on tiles that can be ticked (the shelf's files), not on Apps (Justin).
        if (f.ticked !== undefined) {
          const tick = make('span', 'ftick');
          tick.append(iconEl('check', 'fc'));
          el.append(tick);
        }
        el.append(make('span', 'fname', f.name));
        if (f.sub) el.append(make('span', 'fsub', f.sub));
        if (f.tip) el.title = f.tip;
        this.bind(el, f.action, f.arg);
        if (f.remove) {
          const x = this.button(f.remove, 'sm');
          x.classList.add('frm');
          el.append(x);
        }
        if (b.reorder) this.wireReorder(e, el, f.key, b.reorder);
        const drag = b.drag;
        if (drag) {
          let dragged = false;
          el.addEventListener(
            'click',
            (c) => {
              if (dragged) c.stopPropagation();
              dragged = false;
            },
            { capture: true },
          );
          el.addEventListener('pointerdown', (down) => {
            if (down.button !== 0 || (down.target as HTMLElement).closest('.frm')) return;
            dragged = false;
            const move = (ev: PointerEvent) => {
              if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
              stop();
              // The drop ends outside this window: no click may follow the press.
              dragged = true;
              this.onAction(drag, f.key, el);
            };
            const stop = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop);
          });
        }
        return el;
      }),
    );
  }

  /**
   * Drag a tile to a new place among the others (Apps while editing, Justin): it lifts and follows
   * the pointer, the others make room as it passes over them, and letting go sends `action` with
   * { key, to } (its new index). A press that doesn't move stays a click.
   */
  private wireReorder(box: HTMLElement, el: HTMLElement, key: string, action: string): void {
    let moved = false;
    el.addEventListener('click', (c) => {
      if (moved) c.stopPropagation();
      moved = false;
    }, { capture: true });
    el.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest('.frm')) return;
      moved = false;
      const from = [...box.children].indexOf(el);
      const r0 = el.getBoundingClientRect();
      const grab = { x: down.clientX - r0.left, y: down.clientY - r0.top };
      const place = (x: number, y: number) => {
        el.style.transform = '';
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${x - grab.x - r.left}px, ${y - grab.y - r.top}px) scale(1.06)`;
      };
      const move = (ev: PointerEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
          moved = true;
          this.reordering = true;
          el.setPointerCapture(ev.pointerId);
          el.classList.add('lifted');
          box.classList.add('reordering');
        }
        // Over another tile: this one takes its place, the rest shift along.
        const over = ([...box.children] as HTMLElement[]).find((c) => {
          if (c === el) return false;
          const r = c.getBoundingClientRect();
          return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
        });
        if (over) {
          const kids = [...box.children];
          box.insertBefore(el, kids.indexOf(over) > kids.indexOf(el) ? over.nextSibling : over);
        }
        place(ev.clientX, ev.clientY);
      };
      const stop = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', stop);
        el.removeEventListener('pointercancel', stop);
        if (!moved) return;
        el.classList.remove('lifted');
        box.classList.remove('reordering');
        el.style.transform = '';
        this.reordering = false;
        const to = [...box.children].indexOf(el);
        if (to !== from) this.onAction(action, { key, to }, el);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
    });
  }

  /**
   * Avatars, kept by key so a ring filling or a name changing never rebuilds the row (a
   * rebuilt avatar would restart its animations). False when the row must be rebuilt.
   */
  private fillPeople(e: HTMLElement, b: Extract<Block, { t: 'people' }>): boolean {
    if (!b.items.length) {
      if (!e.querySelector('.pe-empty')) {
        e.replaceChildren();
        const empty = make('div', 'pe-empty');
        const scan = make('span', 'pe-scan');
        scan.append(make('i', ''), make('i', ''), iconEl('land', 'pe-dot'));
        empty.append(scan, make('span', 'pe-text', b.empty ?? ''));
        e.append(empty);
      } else e.querySelector('.pe-text')!.textContent = b.empty ?? '';
      return true;
    }
    const keyed = new Map<string, HTMLElement>();
    for (const c of Array.from(e.querySelectorAll<HTMLElement>(':scope > .person'))) keyed.set(c.dataset.p ?? '', c);
    const els = b.items.map((p) => {
      let el = keyed.get(p.key);
      if (!el) {
        el = make('button', 'person');
        (el as HTMLButtonElement).type = 'button';
        el.dataset.p = p.key;
        const av = make('span', 'av');
        av.append(make('span', 'ini'));
        el.append(av, make('span', 'pn'), make('span', 'ps'));
      }
      keyed.delete(p.key);
      el.className = `person tone-${p.tone ?? 'default'}${p.selected ? ' selected' : ''}${p.progress !== undefined ? ' ringed' : ''}${p.action ? ' act' : ''}`;
      const av = el.querySelector<HTMLElement>('.av')!;
      av.style.setProperty('--hue', String(Math.round(p.hue)));
      av.querySelector('.ini')!.textContent = p.initials;
      let ring = av.querySelector<HTMLElement>('.pring');
      if (p.progress === undefined) ring?.remove();
      else {
        if (!ring) av.append((ring = make('span', 'pring')));
        ring.classList.toggle('spin', p.progress === null);
        ring.style.setProperty('--p', String(p.progress === null ? 0.28 : clamp01(p.progress)));
      }
      const badge = av.querySelector<HTMLElement>('.pbadge');
      if (badge?.dataset.icon !== p.badge) {
        badge?.remove();
        if (p.badge) {
          const b2 = iconEl(p.badge, 'pbadge');
          b2.dataset.icon = p.badge;
          av.append(b2);
        }
      }
      el.querySelector('.pn')!.textContent = p.name;
      const sub = el.querySelector<HTMLElement>('.ps')!;
      sub.textContent = p.sub ?? '';
      sub.style.display = p.sub ? '' : 'none';
      if (p.tip) el.title = p.tip;
      else el.removeAttribute('title');
      if (p.action) this.bind(el, p.action, p.arg);
      else delete el.dataset.action;
      return el;
    });
    e.querySelector('.pe-empty')?.remove();
    for (const gone of keyed.values()) gone.remove();
    els.forEach((el, i) => {
      if (e.children[i] !== el) e.insertBefore(el, e.children[i] ?? null);
    });
    return true;
  }

  private fillRowBar(line: HTMLElement, b: RowBar): void {
    line.querySelector('.rbar')!.className = `rbar tone-${b.tone ?? 'claude'}`;
    line.querySelector<HTMLElement>('.fill')!.style.transform = `scaleX(${clamp01(b.value)})`;
    line.querySelector('.rbs')!.textContent = b.label ?? '';
    line.querySelector('.rbt')!.textContent = b.text;
  }

  private fillMeter(e: HTMLElement, b: Extract<Block, { t: 'meter' }>): void {
    e.className = `sb sb-meter tone-${b.tone ?? 'claude'}`;
    e.querySelector('.ml')!.textContent = b.label;
    e.querySelector('.mv')!.textContent = b.text;
    const sub = e.querySelector<HTMLElement>('.ms')!;
    sub.textContent = b.sub ?? '';
    sub.style.display = b.sub ? '' : 'none';
    e.querySelector<HTMLElement>('.fill')!.style.transform = `scaleX(${clamp01(b.value)})`;
    const pace = e.querySelector<HTMLElement>('.pace')!;
    pace.style.opacity = b.pace == null ? '0' : '1';
    if (b.pace != null) pace.style.left = `${clamp01(b.pace) * 100}%`;
    if (b.tip) e.title = b.tip;
    else e.removeAttribute('title');
    if (b.action) this.bind(e, b.action, b.arg);
    else delete e.dataset.action;
  }

  private runCountdown(fill: HTMLElement, b: Extract<Block, { t: 'countdown' }>): void {
    for (const a of fill.getAnimations?.() ?? []) a.cancel();
    const left = Math.max(0, b.until - Date.now());
    const from = b.total > 0 ? clamp01(left / b.total) : 0;
    fill.style.transform = `scaleX(${from})`;
    if (left > 0 && fill.animate) fill.animate([{ transform: `scaleX(${from})` }, { transform: 'scaleX(0)' }], { duration: left, easing: 'linear', fill: 'forwards' });
  }

  // ---------------------------------------------------------------- tiles

  /** Everything about a tile except where it sits: position is patched, never rebuilt. */
  private tileSig(t: Tile, editing: boolean): string {
    const { page, col, row, ...rest } = t;
    return JSON.stringify(rest) + (editing ? '|edit' : '');
  }

  private placeTile(el: HTMLElement, t: Tile): void {
    const w = t.w ?? 1;
    const h = t.h ?? 1;
    el.style.gridArea = `${(t.row ?? 0) + 1} / ${(t.col ?? 0) + 1} / span ${h} / span ${w}`;
    // Size classes follow the cells it has now: a tile being resized is not rebuilt.
    for (const c of Array.from(el.classList)) if (/^(span|rows)-\d+$/.test(c)) el.classList.remove(c);
    el.classList.add(`span-${w}`, `rows-${h}`);
    // Where it sits, for a drag to start from.
    const data: Record<string, string> = { page: String(t.page ?? 0), col: String(t.col ?? 0), row: String(t.row ?? 0), w: String(w), h: String(h), sizes: (t.sizes ?? []).map(([a, b]) => `${a}x${b}`).join(' ') };
    for (const [k, v] of Object.entries(data)) if (el.dataset[k] !== v) el.dataset[k] = v;
  }

  /**
   * Brings the grid in line with the layout the island packed. Elements are kept
   * and moved; only a tile whose content changed is rebuilt, and nothing is
   * rebuilt mid-drag. Tiles that end up somewhere new slide there.
   */
  private patchTiles(host: HTMLElement, b: Extract<Block, { t: 'tiles' }>): void {
    const editing = b.editing === true;
    host.classList.toggle('editing', editing);
    host.style.setProperty('--cols', String(b.cols));
    host.style.setProperty('--rows', String(b.rows));
    host.style.setProperty('--cell', `${b.cell}px`);
    // Everything inside a tile is drawn for a 92 px cell (island.ts TILE_DESIGN_CELL) and scales with the real one.
    host.style.setProperty('--k', b.cell > 0 ? (b.cell / 92).toFixed(4) : '1');
    const pagesEl = host.querySelector<HTMLElement>('.pages')!;
    const trayEl = host.querySelector<HTMLElement>('.tray')!;
    this.grid = { items: b.items, cols: b.cols, rows: b.rows };

    // A page made at the card's edge mid-drag stays until the drop, even while empty.
    const pages = Math.max(1, b.pages, this.drag?.host === host ? this.dragPages : 0);
    while (pagesEl.children.length < pages) pagesEl.append(make('div', 'page'));
    while (pagesEl.children.length > pages) pagesEl.lastElementChild!.remove();
    this.syncDots(host, pages);

    const existing = new Map<string, HTMLElement>();
    for (const el of host.querySelectorAll<HTMLElement>('.tile')) if (el.dataset.k) existing.set(el.dataset.k, el);
    const was = new Map<HTMLElement, { rect: DOMRect; page: Element | null }>();
    for (const el of existing.values()) was.set(el, { rect: el.getBoundingClientRect(), page: el.parentElement });

    const seen = new Set<string>();
    const render = (t: Tile, parent: HTMLElement, tray: boolean) => {
      seen.add(t.key);
      const sig = this.tileSig(t, editing) + (tray ? '|tray' : '');
      let el = existing.get(t.key);
      if (!el || (this.tileSigs.get(el) !== sig && this.drag?.key !== t.key)) {
        if (el && this.tileSigs.get(el) === sig) {
          /* unchanged */
        } else if (el && this.patchTile(el, t, editing)) {
          this.tileSigs.set(el, sig);
        } else {
          const next = this.tile(t, editing);
          next.dataset.k = t.key;
          this.tileSigs.set(next, sig);
          if (el) {
            el.replaceWith(next);
            // A rebuilt tile slides from where the old one was, like its neighbours.
            const before = was.get(el);
            if (before) was.set(next, before);
          }
          // A new tile pops in, but not one that arrives with a carried card (placeCarry): that card's
          // content fades in where it stays, and every tile growing 8% into place under the fade was
          // content moving for half a second after the click (Justin's recordings, 2026-11-14).
          else if (!this.carry) springAnimate(next, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], springs.content);
          el = next;
        }
      }
      if (!tray) this.placeTile(el, t);
      else el.style.gridArea = '';
      // The carried tile's own spot shows where it will land; its copy is on the pointer.
      el.classList.toggle('drag-slot', !tray && ((this.drag?.mode === 'move' && this.drag.key === t.key) || this.landing === t.key));
      el.classList.toggle('resizing', !tray && this.drag?.mode === 'resize' && this.drag.key === t.key);
      if (el.parentElement !== parent) parent.append(el);
      existing.set(t.key, el);
    };

    for (const t of b.items) render(t, (pagesEl.children[t.page ?? 0] as HTMLElement) ?? (pagesEl.firstElementChild as HTMLElement), false);
    trayEl.style.display = editing && b.tray?.length ? '' : 'none';
    for (const t of b.tray ?? []) if (editing) render(t, trayEl, true);

    for (const [key, el] of existing) {
      if (seen.has(key)) continue;
      el.remove();
      this.tileSigs.delete(el);
    }
    this.syncGhosts(pagesEl, editing);
    this.syncHubMenu();

    // Anything that moved slides from where it was drawn.
    for (const el of host.querySelectorAll<HTMLElement>('.tile')) {
      const before = was.get(el);
      if (!before) continue;
      // Moving to another page would fly the tile across the card: it fades in at its new place instead.
      if (before.page !== el.parentElement) {
        springAnimate(el, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], springs.content);
        continue;
      }
      const a = before.rect;
      const r = el.getBoundingClientRect();
      const dx = a.left - r.left;
      const dy = a.top - r.top;
      if (el.classList.contains('resizing') && (Math.abs(a.width - r.width) > 0.5 || Math.abs(a.height - r.height) > 0.5)) {
        // The tile being resized grows out of its old box rather than jumping.
        springAnimate(el, [{ width: `${a.width}px`, height: `${a.height}px`, transform: `translate(${dx}px, ${dy}px)` }, { width: `${r.width}px`, height: `${r.height}px`, transform: 'none' }], springs.snappy);
      } else if (Math.abs(dx) + Math.abs(dy) > 0.5) springAnimate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], springs.content);
    }
  }

  /** While editing, the empty cells of every page show faintly: the grid the tiles snap to. */
  private syncGhosts(pagesEl: HTMLElement, editing: boolean): void {
    const g = this.grid;
    Array.from(pagesEl.children).forEach((child, i) => {
      const page = child as HTMLElement;
      const empty: Array<[number, number]> = [];
      if (editing && g) {
        const taken = new Set<string>();
        for (const t of g.items) {
          if ((t.page ?? 0) !== i) continue;
          const c0 = t.col ?? 0;
          const r0 = t.row ?? 0;
          for (let r = r0; r < r0 + (t.h ?? 1); r++) for (let c = c0; c < c0 + (t.w ?? 1); c++) taken.add(`${c},${r}`);
        }
        for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (!taken.has(`${c},${r}`)) empty.push([c, r]);
      }
      const sig = empty.map(([c, r]) => `${c},${r}`).join(' ');
      if (page.dataset.ghosts === sig) return;
      page.dataset.ghosts = sig;
      for (const old of page.querySelectorAll('.cell-ghost')) old.remove();
      for (const [c, r] of empty) {
        const ghost = make('i', 'cell-ghost');
        ghost.style.gridArea = `${r + 1} / ${c + 1}`;
        page.prepend(ghost);
      }
    });
  }

  /** Remove (or put back) and the resize corner, laid over a tile in edit mode. */
  private editControls(e: HTMLElement, t: Tile): void {
    const key = t.key;
    if (t.hidden) {
      const add = make('button', 'tile-add');
      add.type = 'button';
      add.innerHTML = icon('plus');
      add.title = 'Put back on the grid';
      this.bind(add, 'island:grid-show', key);
      e.append(add);
      return;
    }
    const x = make('button', 'tile-x');
    x.type = 'button';
    x.innerHTML = icon('minus');
    x.title = 'Take off the grid';
    this.bind(x, 'island:grid-hide', key);
    e.append(x);
    // Drag the corner to resize, as on a phone (startDrag, mode 'resize').
    if ((t.sizes?.length ?? 0) > 1) {
      const grip = iconEl('corner', 'tile-resize');
      grip.title = 'Drag to resize';
      e.append(grip);
    }
  }

  // ---------------------------------------------------------------- pages

  private pageWidth(host: HTMLElement): number {
    return host.querySelector<HTMLElement>('.pages')?.clientWidth || 1;
  }

  /** The page in view (pages scroll sideways, one at a time). */
  private visiblePage(host: HTMLElement): number {
    const pages = host.querySelector<HTMLElement>('.pages');
    if (!pages) return 0;
    return Math.max(0, Math.min(pages.children.length - 1, Math.round(pages.scrollLeft / this.pageWidth(host))));
  }

  /** The page in view, or the one it is sliding to (unless that page has gone meanwhile). */
  private currentPage(host: HTMLElement): number {
    const aim = this.aim.get(host);
    const pages = host.querySelector<HTMLElement>('.pages')?.children.length ?? 1;
    if (aim !== undefined && aim < pages) return aim;
    this.aim.delete(host);
    return this.visiblePage(host);
  }

  private goToPage(host: HTMLElement, i: number): void {
    const pages = host.querySelector<HTMLElement>('.pages');
    if (!pages) return;
    this.aim.set(host, i);
    pages.scrollTo({ left: i * this.pageWidth(host), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  private markPage(host: HTMLElement): void {
    const dots = host.querySelectorAll<HTMLElement>('.dot');
    if (!dots.length) return;
    const at = this.visiblePage(host);
    dots.forEach((d, i) => d.classList.toggle('on', i === at));
    // The arrows beside the dots: none before the first page, none after the last.
    const prev = host.querySelector<HTMLButtonElement>('.pg-prev');
    const next = host.querySelector<HTMLButtonElement>('.pg-next');
    if (prev) prev.disabled = at <= 0;
    if (next) next.disabled = at >= dots.length - 1;
  }

  /** One dot per page, when there is more than one, between a ‹ and a › that turn the page. */
  private syncDots(host: HTMLElement, pages: number): void {
    const dotsEl = host.querySelector<HTMLElement>('.dots')!;
    const want = pages > 1 ? pages : 0;
    if (dotsEl.querySelectorAll('.dot').length !== want) {
      dotsEl.replaceChildren();
      const arrow = (dir: -1 | 1) => {
        const b = make('button', dir < 0 ? 'pg pg-prev' : 'pg pg-next');
        b.type = 'button';
        b.title = dir < 0 ? 'Previous page' : 'Next page';
        b.setAttribute('aria-label', b.title);
        b.innerHTML = icon(dir < 0 ? 'chevron-left' : 'chevron-right');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const to = this.visiblePage(host) + dir;
          if (to >= 0 && to < want) this.goToPage(host, to);
        });
        return b;
      };
      if (want) dotsEl.append(arrow(-1));
      for (let i = 0; i < want; i++) {
        const dot = make('button', 'dot');
        dot.type = 'button';
        dot.title = `Page ${i + 1}`;
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          this.goToPage(host, i);
        });
        dotsEl.append(dot);
      }
      if (want) dotsEl.append(arrow(1));
    }
    this.markPage(host);
  }

  /** A held tile may turn to the page before, the page after, or a new page after one that keeps tiles of its own. */
  private canTurn(host: HTMLElement, dir: 1 | -1, key: string): boolean {
    const pages = host.querySelector<HTMLElement>('.pages');
    if (!pages) return false;
    const at = this.currentPage(host);
    if (dir < 0) return at > 0;
    if (at < pages.children.length - 1) return true;
    // Never two empty pages in a row: the last page must hold a tile besides the one carried.
    const last = pages.children[pages.children.length - 1];
    return Array.from(last.querySelectorAll<HTMLElement>('.tile')).some((t) => t.dataset.k !== key);
  }

  private turnPage(host: HTMLElement, dir: 1 | -1): void {
    const pages = host.querySelector<HTMLElement>('.pages');
    if (!pages) return;
    const next = this.currentPage(host) + dir;
    if (next < 0) return;
    if (next >= pages.children.length) {
      // Past the last page: a new, empty one, kept until the tile is let go.
      this.dragPages = next + 1;
      pages.append(make('div', 'page'));
      this.syncDots(host, pages.children.length);
      this.syncGhosts(pages, true);
    }
    this.goToPage(host, next);
  }

  /** The bar along the card's side that fills while a held tile waits there to turn the page. */
  private showHold(host: HTMLElement, dir: -1 | 0 | 1): void {
    const pages = host.querySelector<HTMLElement>('.pages');
    for (const side of [-1, 1] as const) {
      const bar = host.querySelector<HTMLElement>(side < 0 ? '.edge-hold.left' : '.edge-hold.right');
      const fill = bar?.firstElementChild as HTMLElement | null;
      if (!bar || !fill) continue;
      const on = side === dir;
      bar.classList.toggle('on', on);
      for (const a of fill.getAnimations?.() ?? []) a.cancel();
      if (!on) {
        bar.style.height = '';
        continue;
      }
      bar.style.height = `${pages?.offsetHeight ?? 0}px`;
      // A timer, not decoration: it runs at full length even with reduced motion.
      fill.animate?.([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: EDGE_HOLD_MS, easing: 'linear', fill: 'forwards' });
    }
  }

  // ---------------------------------------------------------------- long press and drag

  /**
   * Long-press a tile (or an empty spot) to arrange the grid; still holding, the
   * same press carries the tile. While editing, a tile is dragged straight away
   * and its corner resizes it.
   */
  private wireGrid(host: HTMLElement): void {
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.drag) return;
      const target = e.target as HTMLElement;
      if (target.closest('.tile-x, .tile-add')) return;
      const tile = target.closest<HTMLElement>('.tile');
      const key = tile?.dataset.k ?? null;
      if (host.classList.contains('editing')) {
        if (tile && key && !tile.classList.contains('hidden-tile')) this.startDrag(host, key, e, target.closest('.tile-resize') ? 'resize' : 'move');
        return;
      }
      if (!tile && !target.closest('.page')) return;
      cancel();
      // Holding Wi-Fi or Bluetooth opens its menu; held anywhere else, the tile is arranged (as on an iPhone).
      const held = target.closest<HTMLElement>('.hp[data-menu]');
      if (held && key && held.dataset.key) {
        const pill = held.dataset.key;
        press = {
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            press = null;
            this.swallowNextClick();
            this.openHubMenu(key, pill);
          }, MENU_HOLD_MS),
        };
        return;
      }
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null;
          this.swallowNextClick();
          this.onAction('island:grid-edit', key, tile ?? host);
          if (key) this.startDrag(host, key, e, 'move');
        }, LONG_PRESS_MS),
      };
    });
    host.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) cancel();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) host.addEventListener(ev, cancel);
    host.querySelector('.pages')?.addEventListener(
      'scroll',
      () => {
        this.markPage(host);
        // Arrived: the scroll position speaks for itself again.
        const aim = this.aim.get(host);
        const pages = host.querySelector<HTMLElement>('.pages');
        if (aim !== undefined && pages && Math.abs(pages.scrollLeft - aim * this.pageWidth(host)) < 2) this.aim.delete(host);
        // The page under a carried tile changed: where it would land did too.
        if (this.drag?.host === host) this.drag.rescan();
      },
      { passive: true },
    );
    const gesture: WheelGesture = { acc: 0, last: -Infinity, turned: false };
    host.addEventListener(
      'wheel',
      (e) => {
        const pages = host.querySelector<HTMLElement>('.pages');
        if (!pages || pages.scrollWidth <= pages.clientWidth + 2) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        const step = wheelTurn(gesture, unit * (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY), e.timeStamp);
        if (!step) return;
        this.goToPage(host, Math.max(0, Math.min(pages.children.length - 1, this.currentPage(host) + step)));
      },
      { passive: false },
    );
  }

  /** The click that ends a long-press must not press what is under it. */
  private swallowNextClick(): void {
    this.swallowClick = true;
    clearTimeout(this.swallowTimer);
    // If no click follows (the pointer was lifted elsewhere), stop swallowing.
    this.swallowTimer = setTimeout(() => (this.swallowClick = false), 700);
  }

  // ---------------------------------------------------------------- hub pills' hold menus

  /** The pill a hold menu belongs to, while it is drawn and still has its menu. */
  private hubPillEl(tile: string, pill: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`.tile[data-k="${CSS.escape(tile)}"] .hp[data-key="${CSS.escape(pill)}"][data-menu]`);
  }

  /**
   * Holding Wi-Fi or Bluetooth (Justin's iPhone screenshots): a glass menu grows out of the pill
   * over Control Center, which blurs behind it. Only its shape grows: the rows sit where they
   * end up from the first frame and fade in there, so nothing in it moves. A tap on a row sends
   * its action and closes it; a tap beside it, Esc, or the card closing closes it.
   */
  private openHubMenu(tile: string, pill: string): void {
    const pillEl = this.hubPillEl(tile, pill);
    const menu = this.hubMenus.get(`${tile}/${pill}`);
    if (!pillEl || !menu || !this.shown) return;
    this.closeHubMenu(true);
    const scrim = make('div', 'hub-scrim');
    const box = make('div', 'hub-menu');
    this.fillHubMenu(box, menu);
    this.el.append(scrim, box);
    const now = performance.now();
    const state = { tile, pill, box, scrim, sig: JSON.stringify(menu), openedAt: now, pressedAt: 0, closing: false };
    this.hubMenu = state;
    const from = this.placeHubMenu(box, pillEl, true);

    // A tap beside the menu closes it, and goes no further.
    scrim.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.closeHubMenu(false);
    });
    scrim.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('pointerdown', () => (state.pressedAt = performance.now()));
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      // The finger that held the pill lifts over the menu: only a press made on the menu itself counts.
      if (state.pressedAt <= state.openedAt || state.closing) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('.hm-row[data-action]');
      if (!row) return;
      this.onAction(row.dataset.action!, args.get(row), row);
      this.closeHubMenu(false);
    });

    box.animate(
      [{ clipPath: `inset(${from.t}px ${from.r}px ${from.b}px ${from.l}px round ${from.radius}px)` }, { clipPath: `inset(0px 0px 0px 0px round ${MENU_RADIUS}px)` }],
      { duration: MENU_OPEN_MS, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' },
    );
    box.querySelector('.hm-in')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 40, easing: 'ease-out', fill: 'backwards' });
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    document.addEventListener('keydown', this.hubMenuKey, true);
    if (menu.open) this.onAction(menu.open, null, pillEl);
  }

  private readonly hubMenuKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.hubMenu) return;
    e.stopPropagation();
    e.preventDefault();
    this.closeHubMenu(false);
  };

  /**
   * Sizes and places the menu over the card: as wide as 1.6 pills, its top and left at the pill's
   * (kept inside the card), as tall as its rows up to the card's height (then the rows scroll and
   * the last row stays pinned). Returns the pill's rect as insets of the menu, where it grows from.
   */
  private placeHubMenu(box: HTMLElement, pillEl: HTMLElement, fresh: boolean): { t: number; r: number; b: number; l: number; radius: number } {
    const card = this.el.getBoundingClientRect();
    const scale = this.el.offsetWidth ? card.width / this.el.offsetWidth : 1;
    const elW = this.el.offsetWidth;
    const elH = this.el.offsetHeight;
    const pr = pillEl.getBoundingClientRect();
    const p = { x: (pr.left - card.left) / scale, y: (pr.top - card.top) / scale, w: pr.width / scale, h: pr.height / scale };
    const w = Math.max(0, Math.min(Math.max(p.w * 1.6, 230), elW - MENU_PAD * 2));
    const left = Math.round(Math.max(MENU_PAD, Math.min(p.x - 4, elW - MENU_PAD - w)));
    box.style.width = `${w}px`;
    box.style.height = '';
    box.style.maxHeight = `${Math.max(0, elH - MENU_PAD * 2)}px`;
    const h = box.offsetHeight;
    const prevTop = parseFloat(box.style.top);
    const want = fresh || Number.isNaN(prevTop) ? p.y : prevTop;
    const top = Math.round(Math.max(MENU_PAD, Math.min(want, elH - MENU_PAD - h)));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    const clamp = (v: number) => Math.max(0, v);
    return { t: clamp(p.y - top), r: clamp(left + w - (p.x + p.w)), b: clamp(top + h - (p.y + p.h)), l: clamp(p.x - left), radius: p.h / 2 };
  }

  /** The menu's rows (the list scrolls), a divider, and its last row pinned under them. */
  private fillHubMenu(box: HTMLElement, menu: HubMenu): void {
    const scroll = box.querySelector<HTMLElement>('.hm-list')?.scrollTop ?? 0;
    box.replaceChildren();
    const inner = make('div', 'hm-in');
    // Wi-Fi's rows have a check and an icon in front; Bluetooth's are names only (as on the iPhone).
    box.classList.toggle('with-icons', menu.rows.some((r) => r.icon || r.check));
    const list = make('div', 'hm-list');
    for (const r of menu.rows) list.append(this.hubMenuRow(r));
    if (!menu.rows.length && menu.empty) list.append(make('div', 'hm-empty', menu.empty));
    inner.append(list);
    if (menu.more) inner.append(make('div', 'hm-div'), this.hubMenuRow(menu.more, 'hm-more'));
    box.append(inner);
    list.scrollTop = scroll;
  }

  private hubMenuRow(r: HubMenuRow, extra = ''): HTMLElement {
    const e = make(r.action ? 'button' : 'div', `hm-row${extra ? ` ${extra}` : ''}${r.action ? ' act' : ''}`);
    if (e instanceof HTMLButtonElement) e.type = 'button';
    if (r.action) {
      e.dataset.action = r.action;
      args.set(e, r.arg);
    }
    if (!extra) {
      const check = make('span', 'hm-check');
      if (r.check) check.append(iconEl('check', 'hm-ci'));
      e.append(check);
      if (r.icon) {
        const ico = make('span', 'hm-ico');
        ico.append(iconEl(r.icon, 'hm-ii'));
        if (r.lock) ico.append(iconEl('lock', 'hm-lock'));
        e.append(ico);
      }
    }
    const tx = make('span', 'hm-tx');
    tx.append(make('span', 'hm-l', r.label));
    if (r.sub) tx.append(make('span', 'hm-s', r.sub));
    e.append(tx);
    return e;
  }

  /** The tiles were drawn again: the open menu shows what its pill's menu says now, or closes with it. */
  private syncHubMenu(): void {
    const m = this.hubMenu;
    if (!m || m.closing) return;
    const pillEl = this.hubPillEl(m.tile, m.pill);
    const menu = this.hubMenus.get(`${m.tile}/${m.pill}`);
    if (!pillEl || !menu) return this.closeHubMenu(false);
    const sig = JSON.stringify(menu);
    if (sig === m.sig) return;
    m.sig = sig;
    this.fillHubMenu(m.box, menu);
    this.placeHubMenu(m.box, pillEl, false);
  }

  /** Back into the pill it grew from (or gone at once): the shape shrinks while the rows fade where they are. */
  private closeHubMenu(immediate: boolean): void {
    const m = this.hubMenu;
    if (!m) return;
    this.hubMenu = null;
    document.removeEventListener('keydown', this.hubMenuKey, true);
    m.closing = true;
    const gone = () => {
      m.box.remove();
      m.scrim.remove();
    };
    const pillEl = this.hubPillEl(m.tile, m.pill);
    if (immediate || !pillEl || !this.shown) return gone();
    const box = m.box.getBoundingClientRect();
    const pr = pillEl.getBoundingClientRect();
    const scale = this.el.offsetWidth ? this.el.getBoundingClientRect().width / this.el.offsetWidth : 1;
    const c = (v: number) => Math.max(0, v / scale);
    const to = `inset(${c(pr.top - box.top)}px ${c(box.right - pr.right)}px ${c(box.bottom - pr.bottom)}px ${c(pr.left - box.left)}px round ${pr.height / scale / 2}px)`;
    m.box.style.pointerEvents = 'none';
    m.scrim.style.pointerEvents = 'none';
    const shape = m.box.animate([{ clipPath: `inset(0px 0px 0px 0px round ${MENU_RADIUS}px)` }, { clipPath: to }], { duration: MENU_CLOSE_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    m.box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MENU_CLOSE_MS * 0.6, delay: MENU_CLOSE_MS * 0.4, easing: 'ease-in', fill: 'forwards' });
    m.box.querySelector('.hm-in')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
    m.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MENU_CLOSE_MS, easing: 'ease-in', fill: 'forwards' });
    const fallback = setTimeout(gone, MENU_CLOSE_MS + 400);
    shape.finished.then(
      () => {
        clearTimeout(fallback);
        gone();
      },
      () => {},
    );
  }

  /** Cell geometry of the page in view, in screen px. */
  private gridMetrics(host: HTMLElement): { left: number; top: number; cols: number; rows: number; gap: number; pitchX: number; pitchY: number } {
    const pages = host.querySelector<HTMLElement>('.pages')!;
    const r = pages.getBoundingClientRect();
    const cols = Number(host.style.getPropertyValue('--cols')) || 4;
    const rows = Number(host.style.getPropertyValue('--rows')) || 4;
    const cell = parseFloat(host.style.getPropertyValue('--cell')) || 92;
    const first = pages.firstElementChild as HTMLElement | null;
    const gap = (first && parseFloat(getComputedStyle(first).columnGap)) || 8;
    return { left: r.left, top: r.top, cols, rows, gap, pitchX: (r.width + gap) / cols, pitchY: cell + gap };
  }

  /** The cell a w x h tile snaps to with its top-left corner at (left, top), on the page in view. */
  private cellUnder(host: HTMLElement, left: number, top: number, size: { w: number; h: number }): { page: number; col: number; row: number } {
    const g = this.gridMetrics(host);
    const col = Math.max(0, Math.min(g.cols - size.w, Math.round((left - g.left) / g.pitchX)));
    const row = Math.max(0, Math.min(g.rows - size.h, Math.round((top - g.top) / g.pitchY)));
    return { page: this.currentPage(host), col, row };
  }

  /** Of the sizes a tile may take, the one whose corner is nearest the pointer (a cell counts once the pointer is past its middle). */
  private sizeAt(host: HTMLElement, anchor: { col: number; row: number }, p: { x: number; y: number }, sizes: Array<[number, number]>): [number, number] | null {
    if (!sizes.length) return null;
    const g = this.gridMetrics(host);
    const across = (p.x - (g.left + anchor.col * g.pitchX) + g.gap / 2) / g.pitchX;
    const down = (p.y - (g.top + anchor.row * g.pitchY) + g.gap / 2) / g.pitchY;
    let best = sizes[0];
    let bestD = Infinity;
    for (const s of sizes) {
      const d = (s[0] - across) ** 2 + (s[1] - down) ** 2;
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  /** A copy of the tile that follows the pointer above everything: the card clips its own content. */
  private floatCopy(tile: HTMLElement, r: DOMRect): HTMLElement {
    const f = tile.cloneNode(true) as HTMLElement;
    for (const x of f.querySelectorAll('.tile-x, .tile-resize, .tile-add')) x.remove();
    delete f.dataset.k;
    f.classList.remove('drag-slot', 'resizing', 'act');
    f.classList.add('tile-float');
    f.style.gridArea = '';
    f.style.width = `${r.width}px`;
    f.style.height = `${r.height}px`;
    f.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    this.stage.append(f);
    requestAnimationFrame(() => f.classList.add('up'));
    return f;
  }

  /** After a drop, the floating copy flies into the tile's spot and the tile shows again. */
  private land(host: HTMLElement, key: string, float: HTMLElement): void {
    this.landing = key;
    const find = () => (host.isConnected ? host.querySelector<HTMLElement>(`.tile[data-k="${CSS.escape(key)}"]`) : null);
    const done = () => {
      clearTimeout(fallback);
      float.remove();
      if (this.landing !== key) return;
      this.landing = null;
      // Picked up again while it flew home: it is still being carried.
      if (this.drag?.key !== key) find()?.classList.remove('drag-slot');
    };
    // Whatever happens to the animation (a hidden window pauses it), the tile shows again.
    const fallback = setTimeout(done, 1200);
    // The island redraws on the next frame; aim for where the tile is then.
    requestAnimationFrame(() => {
      const slot = find();
      if (!slot) return done();
      const to = slot.getBoundingClientRect();
      float.classList.remove('up');
      const anim = springAnimate(float, [{ transform: float.style.transform }, { transform: `translate3d(${to.left}px, ${to.top}px, 0)` }], springs.content, { fill: 'forwards' });
      if (anim) anim.finished.then(done, done);
      else done();
    });
  }

  /**
   * Carries a tile, or resizes it by its corner, until the pointer lets go.
   * Moving: a copy floats under the pointer while the tile's own spot shows where
   * it will land, and the grid re-packs live around it; held at the card's side
   * for EDGE_HOLD_MS the next page slides in, a new one past the last. Resizing:
   * the tile takes the size nearest the pointer and the others make room. The
   * island saves the layout on the drop.
   */
  private startDrag(host: HTMLElement, key: string, down: PointerEvent, mode: 'move' | 'resize'): void {
    const pointerId = down.pointerId;
    const start = { x: down.clientX, y: down.clientY };
    let last = start;
    let live = false;
    let grab = { x: 0, y: 0 };
    let size = { w: 1, h: 1 };
    let anchor = { page: 0, col: 0, row: 0 };
    let sizes: Array<[number, number]> = [];
    let float: HTMLElement | null = null;
    let sent = '';
    let pending: Record<string, number> | null = null;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let edge: { dir: 1 | -1; timer: ReturnType<typeof setTimeout> } | null = null;
    const find = () => host.querySelector<HTMLElement>(`.tile[data-k="${CSS.escape(key)}"]`);
    const num = (v: string | undefined, d: number) => (v ? Number(v) || 0 : d);

    const flush = () => {
      clearTimeout(dwell);
      if (!pending) return;
      const arg = pending;
      pending = null;
      sent = JSON.stringify(arg);
      this.onAction('island:grid-move', { key, ...arg }, host);
    };
    // The grid re-packs once a carried tile rests over a spot (REFLOW_DWELL_MS), not on
    // every cell it crosses; a size change or a drop applies at once.
    const send = (arg: Record<string, number>, now: boolean) => {
      clearTimeout(dwell);
      pending = JSON.stringify(arg) === sent ? null : arg;
      if (!pending) return;
      if (now) flush();
      else dwell = setTimeout(flush, REFLOW_DWELL_MS);
    };

    const stopEdge = () => {
      if (!edge) return;
      clearTimeout(edge.timer);
      edge = null;
      this.showHold(host, 0);
    };
    const holdEdge = () => {
      const card = this.el.getBoundingClientRect();
      const dir = last.x >= card.right - EDGE_ZONE ? 1 : last.x <= card.left + EDGE_ZONE ? -1 : 0;
      if (edge && edge.dir === dir) return;
      stopEdge();
      if (!dir || !this.canTurn(host, dir, key)) return;
      edge = {
        dir,
        timer: setTimeout(() => {
          stopEdge();
          // Asked again now: the grid may have changed under the held tile meanwhile.
          if (this.canTurn(host, dir, key)) this.turnPage(host, dir);
        }, EDGE_HOLD_MS),
      };
      this.showHold(host, dir);
    };

    const update = () => {
      if (mode === 'resize') {
        const s = this.sizeAt(host, anchor, last, sizes);
        if (s) send({ ...anchor, w: s[0], h: s[1] }, true);
        return;
      }
      if (float) float.style.transform = `translate3d(${last.x - grab.x}px, ${last.y - grab.y}px, 0)`;
      send(this.cellUnder(host, last.x - grab.x, last.y - grab.y, size), false);
      holdEdge();
    };

    const lift = (): boolean => {
      const tile = find();
      if (!tile) return false;
      const r = tile.getBoundingClientRect();
      grab = { x: start.x - r.left, y: start.y - r.top };
      size = { w: num(tile.dataset.w, 1), h: num(tile.dataset.h, 1) };
      anchor = { page: num(tile.dataset.page, 0), col: num(tile.dataset.col, 0), row: num(tile.dataset.row, 0) };
      sizes = (tile.dataset.sizes ?? '')
        .split(' ')
        .filter(Boolean)
        .map((s) => s.split('x').map(Number) as [number, number]);
      live = true;
      this.drag = { key, mode, host, abort: () => end(true), rescan: () => live && update() };
      try {
        host.setPointerCapture(pointerId);
      } catch {
        /* the pointer is already gone; pointerup ends the drag */
      }
      if (mode === 'move') {
        float = this.floatCopy(tile, r);
        tile.classList.add('drag-slot');
      } else tile.classList.add('resizing');
      host.classList.add(mode === 'move' ? 'carrying' : 'sizing');
      this.onAction('island:grid-lift', key, tile);
      return true;
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // Let go somewhere the island could not see: the first move after that ends it.
      if (live && ev.buttons === 0) return end(false);
      last = { x: ev.clientX, y: ev.clientY };
      if (!live) {
        if (Math.hypot(last.x - start.x, last.y - start.y) < 5) return;
        if (!lift()) return end(false);
      }
      update();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end(false);
    };

    const end = (aborted: boolean) => {
      stopEdge();
      // Dropped before the grid caught up: it lands where it was let go.
      if (aborted) clearTimeout(dwell);
      else if (live) flush();
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      if (!live) return;
      live = false;
      this.drag = null;
      this.dragPages = 0;
      host.classList.remove('carrying', 'sizing');
      find()?.classList.remove('resizing');
      try {
        host.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      this.onAction(aborted ? 'island:grid-cancel' : 'island:grid-drop', key, host);
      if (float) {
        if (aborted) float.remove();
        else this.land(host, key, float);
      }
    };

    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
  }

  /** What a tile was built for: its edit controls (− or +) are only made when it is built. */
  private tileMode(t: Tile, editing: boolean): string {
    return editing ? (t.hidden ? 'tray' : 'edit') : 'live';
  }

  /**
   * Changes that should move rather than redraw (the battery bar sliding to the
   * new charge). False means "rebuild this tile", as it must be when arranging starts or ends
   * (the battery tile used to keep its charge patched in and never got its − to take it off).
   */
  private patchTile(el: HTMLElement, t: Tile, editing: boolean): boolean {
    const b = t.body;
    if (b.k === 'actions' && b.dial) return el.dataset.mode === this.tileMode(t, editing) && this.patchDial(el, t, b.dial);
    if (b.k === 'hub') return el.dataset.mode === this.tileMode(t, editing) && this.patchHub(el, t);
    if (b.k !== 'battery' || !el.classList.contains('k-battery') || el.dataset.mode !== this.tileMode(t, editing)) return false;
    const was = this.tileSigs.get(el);
    const prev = was ? (JSON.parse(was.split('|')[0]) as Tile) : null;
    if (!prev || prev.body.k !== 'battery' || prev.body.charging !== b.charging) return false;
    el.querySelector('.bh span:last-child')!.textContent = b.head;
    el.querySelector('.bp')!.textContent = `${Math.round(b.pct)}%`;
    el.querySelector('.bs')!.textContent = b.sub;
    el.querySelector<HTMLElement>('.bb i')!.style.width = `${Math.max(3, Math.min(100, b.pct))}%`;
    el.classList.toggle('low', !b.charging && b.pct <= 20);
    return true;
  }

  /** Only the sliders moved (the volume or brightness changed): slide them, never the one being dragged. */
  private patchHub(el: HTMLElement, t: Tile): boolean {
    const was = this.tileSigs.get(el);
    const prev = was ? (JSON.parse(was.split('|')[0]) as Tile) : null;
    if (!prev || prev.body.k !== 'hub' || t.body.k !== 'hub') return false;
    // Only what shows on the tile counts: the sliders' levels slide, and the pills' hold menus are kept aside.
    const flat = (x: Tile) => {
      const hb = x.body as { sliders: HubSlider[]; pills: HubPill[] };
      // A slider's level, and the icon and tip that follow it (sun-low under half, "Brightness 40%"):
      // rebuilding the tile for those replaced the slider mid-drag, and the fill stopped following.
      return this.tileSig({ ...x, body: { ...x.body, sliders: hb.sliders.map((h) => ({ ...h, value: 0, icon: '', tip: undefined })), pills: hb.pills.map((p) => ({ ...p, menu: undefined })) } } as Tile, false);
    };
    if (flat(prev) !== flat(t)) return false;
    for (const p of t.body.pills) if (p.menu) this.hubMenus.set(`${t.key}/${p.key}`, p.menu);
    for (const h of t.body.sliders) {
      const track = el.querySelector<HTMLElement>(`.hs[data-key="${h.key}"]`);
      if (!track) continue;
      // Being dragged, or just let go (what Windows reports back lags behind): the fill stays the user's.
      const held = track.classList.contains('dragging') || Date.now() < Number(track.dataset.heldUntil ?? 0);
      if (!held) {
        track.style.setProperty('--v', String(clamp01(h.value)));
        if (h.tip) track.title = h.tip;
      }
      if (track.dataset.icon !== h.icon) {
        track.dataset.icon = h.icon;
        track.querySelector('.hsi')?.replaceWith(iconEl(h.icon, 'hsi'));
      }
    }
    return true;
  }

  /** Only the dial's length changed (it was just scrolled or typed): set it in place, keeping the pointer's spot. */
  private patchDial(el: HTMLElement, t: Tile, dial: Dial): boolean {
    const was = this.tileSigs.get(el);
    const prev = was ? (JSON.parse(was.split('|')[0]) as Tile) : null;
    if (!prev || prev.body.k !== 'actions' || !prev.body.dial) return false;
    // Everything but the length the same (where it sits aside, as in its signature).
    const same = (x: Tile) => this.tileSig({ ...x, body: { ...x.body, dial: { ...(x.body as { dial: Dial }).dial, seconds: 0 } } } as Tile, false);
    if (same(prev) !== same(t)) return false;
    const set = dialSetters.get(el.querySelector('.dial')!);
    if (!set) return false;
    set(dial.seconds);
    return true;
  }

  /**
   * Hours, minutes and seconds, like the iPhone's timer. Each box is a field: scroll over it to turn
   * it (down adds, up takes away), or click it and type (two digits move on to the next box; Enter or
   * clicking away sets it, Esc puts it back). The length is shown at once and sent a moment later.
   */
  private dial(d: Dial): HTMLElement {
    const row = make('div', 'dial');
    const MAX = [23, 59, 59];
    let secs = Math.max(0, Math.min(86399, Math.round(d.seconds)));
    const parts = () => [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60];
    const shown = (i: number, n: number) => (i === 0 ? String(n) : String(n).padStart(2, '0'));
    const inputs: HTMLInputElement[] = [];
    const cols = ['h', 'm', 's'].map((u, i) => {
      const c = make('div', 'dc');
      const inp = make('input', 'di');
      inp.type = 'text';
      inp.inputMode = 'numeric';
      inp.maxLength = 2;
      inp.spellcheck = false;
      inp.autocomplete = 'off';
      inp.placeholder = ['HH', 'MM', 'SS'][i];
      inputs.push(inp);
      c.append(inp, make('span', 'du', u));
      return c;
    });
    const start = this.button(d.start);
    const paint = () => {
      const p = parts();
      // The box being typed in keeps what is typed.
      inputs.forEach((inp, i) => {
        if (document.activeElement !== inp) inp.value = shown(i, p[i]);
      });
      args.set(start, secs);
      start.disabled = secs === 0;
    };
    let sendTimer = 0;
    const send = (wait: number) => {
      clearTimeout(sendTimer);
      sendTimer = window.setTimeout(() => this.onAction(d.action, secs, row), wait);
    };
    /** What is typed in box i becomes its part of the length. */
    const take = (i: number) => {
      const p = parts();
      p[i] = Math.min(MAX[i], Number(inputs[i].value.replace(/\D/g, '')) || 0);
      secs = p[0] * 3600 + p[1] * 60 + p[2];
    };
    const focusBox = (i: number) => {
      this.engagedInput = inputs[i];
      inputs[i].focus({ preventScroll: true });
      // The island takes the keyboard only while typing here (focus lands once it has it).
      this.onAction('island:sheet-engage', 'dial', row);
    };

    inputs.forEach((inp, i) => {
      inp.addEventListener('focus', () => {
        this.engagedInput = inp;
        inp.select();
      });
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 2);
        if (inp.value.length === 2 && i < 2) {
          take(i);
          focusBox(i + 1);
        }
      });
      inp.addEventListener('blur', () => {
        take(i);
        paint();
        send(0);
      });
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          inp.blur();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          inp.value = shown(i, parts()[i]);
          inp.blur();
        } else if (ev.key === 'Backspace' && !inp.value && i > 0) {
          ev.preventDefault();
          focusBox(i - 1);
        }
      });
    });

    cols.forEach((c, i) => {
      let acc = 0;
      c.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          // A mouse notch is one step; a touchpad's small deltas add up to one.
          const dy = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY;
          let steps = 0;
          if (Math.abs(dy) >= 50) steps = Math.sign(dy);
          else {
            acc += dy;
            if (Math.abs(acc) >= 30) {
              steps = Math.sign(acc);
              acc = 0;
            }
          }
          if (!steps) return;
          // Scrolling a box mid-typing starts from what is typed.
          if (document.activeElement === inputs[i]) take(i);
          const p = parts();
          // Hours stop at 0 and 23; minutes and seconds go round, as on the iPhone.
          p[i] = i === 0 ? Math.min(MAX[0], Math.max(0, p[0] + steps)) : (p[i] + steps + MAX[i] + 1) % (MAX[i] + 1);
          secs = p[0] * 3600 + p[1] * 60 + p[2];
          if (document.activeElement === inputs[i]) inputs[i].value = shown(i, p[i]);
          paint();
          send(250);
        },
        { passive: false },
      );
      // Anywhere on the box (its letter too) types into it; the grid and the card never see the press.
      c.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        focusBox(i);
      });
    });

    row.append(...cols, start);
    paint();
    dialSetters.set(row, (v) => {
      secs = Math.max(0, Math.min(86399, Math.round(v)));
      paint();
    });
    return row;
  }

  /**
   * A tall slider: press or drag anywhere on it to set it (the fill follows at once; the value is
   * sent every SLIDER_SEND_MS while dragging and once more on letting go), or scroll over it.
   */
  private hubSlider(h: HubSlider, live: boolean): HTMLElement {
    const track = make('div', 'hs');
    track.dataset.key = h.key;
    track.dataset.icon = h.icon;
    track.style.setProperty('--v', String(clamp01(h.value)));
    if (h.tip) track.title = h.tip;
    track.append(make('i', 'hf'), iconEl(h.icon, 'hsi'));
    if (!live || !h.action) return track;
    const action = h.action;
    let value = clamp01(h.value);
    let sentAt = 0;
    let timer = 0;
    const send = (now: boolean) => {
      clearTimeout(timer);
      const wait = now ? 0 : Math.max(0, SLIDER_SEND_MS - (Date.now() - sentAt));
      timer = window.setTimeout(() => {
        sentAt = Date.now();
        this.onAction(action, value, track);
      }, wait);
    };
    const follow = (y: number) => {
      const r = track.getBoundingClientRect();
      value = sliderAt(y, r.top, r.height);
      track.style.setProperty('--v', String(value));
    };
    track.addEventListener('pointerdown', (ev) => {
      // The grid never sees it: no long-press to arrange, no page turn.
      ev.stopPropagation();
      ev.preventDefault();
      track.setPointerCapture(ev.pointerId);
      track.classList.add('dragging');
      follow(ev.clientY);
      send(false);
    });
    track.addEventListener('pointermove', (ev) => {
      if (!track.hasPointerCapture(ev.pointerId)) return;
      follow(ev.clientY);
      send(false);
    });
    const end = (ev: PointerEvent) => {
      if (!track.classList.contains('dragging')) return;
      if (track.hasPointerCapture(ev.pointerId)) track.releasePointerCapture(ev.pointerId);
      track.classList.remove('dragging');
      track.dataset.heldUntil = String(Date.now() + SLIDER_HOLD_MS);
      send(true);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('click', (ev) => ev.stopPropagation());
    track.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        value = clamp01(Math.round((value - Math.sign(ev.deltaY) * 0.05) * 100) / 100);
        track.style.setProperty('--v', String(value));
        track.dataset.heldUntil = String(Date.now() + SLIDER_HOLD_MS);
        send(false);
      },
      { passive: false },
    );
    return track;
  }

  private tile(t: Tile, editing = false): HTMLElement {
    const b = t.body;
    const live = Boolean(t.action) && !editing && !t.hidden;
    // The size classes follow the cells it actually got, not the size it asked for.
    const e = make(live ? 'button' : 'div', `tile k-${b.k} span-${t.w ?? t.span ?? 1} rows-${t.h ?? t.rows ?? 1}${live ? ' act' : ''}${t.hidden ? ' hidden-tile' : ''}${t.resting ? ' resting' : ''}`);
    if (e instanceof HTMLButtonElement) e.type = 'button';
    e.dataset.mode = this.tileMode(t, editing);
    // Tone tints the tile's icon and accents only (a tone class would tint all its text).
    e.dataset.tone = t.tone ?? 'default';
    if (t.tip && !editing) e.title = t.tip;
    if (live) this.bind(e, t.action, t.arg);
    if (editing) this.editControls(e, t);
    switch (b.k) {
      case 'stat': {
        // Three rows that fit one cell: what it is, the number, and a detail (or a bar).
        const top = make('div', 'sh');
        top.append(iconEl(b.icon, 'ti'), make('span', 'tl', b.label));
        if (b.sub && b.progress != null) top.append(make('span', 'ts aside', b.sub));
        if (b.buttons?.length) {
          const line = make('div', 'tvr');
          line.append(make('div', 'tv', b.value));
          for (const x of b.buttons) line.append(this.button(x, 'sm'));
          e.append(top, line);
        } else e.append(top, make('div', 'tv', b.value));
        if (b.progress != null) {
          const bar = make('div', 'tp');
          const f = make('i', '');
          f.style.transform = `scaleX(${clamp01(b.progress)})`;
          bar.append(f);
          e.append(bar);
        } else if (b.sub) e.append(make('div', 'ts', b.sub));
        break;
      }
      case 'battery': {
        const head = make('div', 'bh');
        head.append(iconEl(b.charging ? 'bolt' : 'battery', 'ti'), make('span', '', b.head));
        const big = make('div', 'bv');
        big.append(make('span', 'bp', `${Math.round(b.pct)}%`), make('span', 'bs', b.sub));
        const bar = make('div', 'bb');
        const f = make('i', '');
        f.style.width = `${Math.max(3, Math.min(100, b.pct))}%`;
        bar.append(f);
        const scale = make('div', 'bscale');
        scale.append(make('span', '', '0'), make('span', '', '50'), make('span', '', '100'));
        e.append(head, big, bar, scale);
        e.classList.toggle('charging', b.charging);
        e.classList.toggle('low', !b.charging && b.pct <= 20);
        break;
      }
      case 'media': {
        const art = make('div', 'ma');
        if (b.art) {
          const img = make('img', '');
          img.alt = '';
          img.decoding = 'async';
          img.src = b.art;
          art.append(img);
        } else art.innerHTML = icon('music');
        this.bind(art, b.open, undefined);
        const meta = make('div', 'mm');
        meta.append(make('div', 'm1', b.title), make('div', 'm2', b.artist));
        const top = make('div', 'mtop');
        top.append(art, meta);
        e.append(top);
        if (b.progress != null) {
          const bar = make('div', 'tp');
          const f = make('i', '');
          f.style.transform = `scaleX(${clamp01(b.progress)})`;
          bar.append(f);
          e.append(bar);
        }
        const ctl = make('div', 'mc');
        for (const x of b.buttons) ctl.append(this.button(x));
        e.append(ctl);
        break;
      }
      case 'month': {
        const head = make('div', 'wh');
        head.append(make('span', 'w1', b.title), make('span', 'w2', b.sub));
        const grid = make('div', 'mg');
        for (const x of b.heads) grid.append(make('span', 'mh', x));
        for (const d of b.days) {
          const cell = make('span', `md${d.today ? ' today' : ''}${d.out ? ' out' : ''}${d.busy ? ' busy' : ''}`, String(d.num));
          grid.append(cell);
        }
        e.append(head, grid);
        break;
      }
      case 'lyrics': {
        const top = make('div', 'ltop');
        const art = make('div', 'la');
        if (b.art) {
          const img = make('img', '');
          img.alt = '';
          img.decoding = 'async';
          img.src = b.art;
          art.append(img);
        } else art.innerHTML = icon('music');
        this.bind(art, b.open, undefined);
        const meta = make('div', 'lm');
        meta.append(make('div', 'l1', b.title), make('div', 'l2', b.artist));
        top.append(art, meta);
        const body = make('div', 'lb');
        if (!b.lines.length) body.append(make('div', 'ln note', b.note ?? 'No lyrics for this one'));
        b.lines.forEach((line, i) => body.append(make('div', `ln${i === b.at ? ' now' : i < b.at ? ' past' : ''}`, line || '♪')));
        e.append(top, body);
        // The line being sung sits in the middle of the lyrics, at every tile size (Justin). Each update
        // builds a new list, so it starts where the last one was and glides to the new line (a new song
        // starts in place). Half the box of room above the first line and below the last lets any line
        // reach the middle; before the first line is sung, the first one waits there.
        const sig = `${b.title}|${b.artist}|${b.lines.length}`;
        body.addEventListener('scroll', () => (this.lyricScroll = { sig, top: body.scrollTop }), { passive: true });
        requestAnimationFrame(() => {
          const half = Math.round(body.clientHeight / 2);
          body.style.paddingBlock = `${half}px`;
          const now = body.querySelector<HTMLElement>('.ln.now') ?? body.querySelector<HTMLElement>('.ln');
          if (!now) return;
          const to = Math.max(0, now.offsetTop + now.offsetHeight / 2 - half);
          const was = this.lyricScroll;
          if (was.sig === sig && !reducedMotion() && Math.abs(was.top - to) > 1) {
            body.scrollTo({ top: was.top, behavior: 'instant' });
            body.scrollTo({ top: to, behavior: 'smooth' });
          } else body.scrollTo({ top: to, behavior: 'instant' });
        });
        break;
      }
      case 'week': {
        const head = make('div', 'wh');
        head.append(make('span', 'w1', b.title), make('span', 'w2', b.sub));
        const strip = make('div', 'ws');
        for (const d of b.days) {
          const cell = make('div', `wd${d.today ? ' today' : ''}`);
          cell.append(make('span', 'wl', d.label), make('span', 'wn', String(d.num)));
          const dots = make('span', 'wb');
          for (let i = 0; i < Math.min(3, d.busy); i++) dots.append(make('i', ''));
          cell.append(dots);
          strip.append(cell);
        }
        e.append(head, strip);
        break;
      }
      case 'dots': {
        const head = make('div', 'dh');
        head.append(make('span', 'd1', b.label), make('span', 'd2', `${Math.round(b.pct)}%`));
        const grid = make('div', 'dg');
        const filled = Math.round((clamp01(b.pct / 100) * 24));
        for (let i = 0; i < 24; i++) grid.append(make('i', i < filled ? 'on' : ''));
        e.append(head, grid);
        if (b.sub) e.append(make('div', 'ts', b.sub));
        break;
      }
      case 'forecast': {
        const now = make('div', 'fn');
        now.append(iconEl(b.icon, 'ti'), make('span', 'ft', b.temp), make('span', 'fl', b.label));
        e.append(now);
        const hours = make('div', 'fh');
        for (const h of b.hours) {
          const c = make('div', 'fc');
          c.append(make('span', 'f1', h.t), iconEl(h.icon, 'fi'), make('span', 'f2', h.temp));
          hours.append(c);
        }
        e.append(hours);
        break;
      }
      case 'actions': {
        const head = make('div', 'ah');
        if (b.icon) head.append(iconEl(b.icon, 'ti'));
        const tx = make('div', 'at');
        tx.append(make('div', 'tl strong', b.label));
        if (b.sub) tx.append(make('div', 'ts', b.sub));
        head.append(tx);
        if (b.dial) {
          const side = make('div', 'step');
          for (const x of b.buttons) side.append(this.button(x, 'sm'));
          head.append(side);
          e.append(head, this.dial(b.dial));
          break;
        }
        const bar = make('div', 'ab');
        for (const x of b.buttons) bar.append(this.button(x));
        e.append(head, bar);
        break;
      }
      case 'hub': {
        const live = !editing && !t.hidden;
        const left = make('div', 'hub-l');
        for (const p of b.pills) {
          const pill = make(live && p.action ? 'button' : 'div', `hp${p.on ? ' on' : ''}`);
          if (pill instanceof HTMLButtonElement) pill.type = 'button';
          pill.dataset.key = p.key;
          if (p.menu) this.hubMenus.set(`${t.key}/${p.key}`, p.menu);
          // Held, it opens its menu (wireGrid); arranging the grid leaves it a plain pill.
          if (p.menu && live) pill.dataset.menu = '1';
          if (live) this.bind(pill, p.action, undefined);
          if (p.tip && live) pill.title = p.tip;
          const tx = make('div', 'hpt');
          tx.append(make('div', 'hpl', p.label), make('div', 'hps', p.sub));
          pill.append(iconEl(p.icon, 'hpi'), tx);
          left.append(pill);
        }
        if (b.buttons.length) {
          const row = make('div', 'hub-b');
          for (const x of b.buttons) row.append(this.button(x));
          left.append(row);
        }
        const right = make('div', 'hub-s');
        for (const h of b.sliders) right.append(this.hubSlider(h, live));
        e.append(left, right);
        break;
      }
      case 'list': {
        const head = make('div', 'ah');
        head.append(iconEl(b.icon, 'ti'), make('div', 'tl strong', b.label));
        e.append(head);
        // A line under the title (Claude's limits), never squeezed into the title's own row.
        if (b.sub) e.append(make('div', 'tl lsub', b.sub));
        const rows = make('div', 'sb-rows');
        for (const r of b.rows) rows.append(this.row(r));
        if (!b.rows.length && b.empty) rows.append(make('div', 'ts', b.empty));
        e.append(rows);
        break;
      }
    }
    return e;
  }
}
