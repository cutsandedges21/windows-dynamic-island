// The screen border (Settings › Widgets › Screen border): with the taskbar and the island both on
// their edges, a thin line in the taskbar's look runs round the whole screen and joins them. Out of
// it come the notches, upright on the left or right side near a corner, in the taskbar's look and
// melting into the line as its ends do: Websites (your pinned sites; a click opens one) and the
// Shelf (its files, dragged straight out; files dropped on it go on it). Each sits tucked into the
// line, slim, until the pointer (or a file being dragged) comes to it, then widens out of it.
// When chosen, an activity's light runs round the whole border instead of the island alone,
// round the taskbar, the island and the notches on its way.
//
// The island owns it, as it owns the taskbar: FrameHost sends the frame window (src-tauri/src/
// frame.rs) what to show, and what is clicked there comes back as `frame-act`. The taskbar and the
// island tell the window where they are (frame-dock, frame-island), for the light's path.

import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { meltMasks } from './dock';
import { applyGlass, applyPill } from './glass';
import { GLOW_PACE, type GlowSpec, type GlowSpeed } from './glow';
import { icon } from './icons';
import { isTauri, native, on, onMine, onFileDrop, sendTo, windowLabel, type DockScreen } from './native';

/** The taskbar on the same screen as border `frame` ('frame-DISPLAY2' → 'dock-DISPLAY2'), and the other way round. */
export const dockFor = (frame: string): string => `dock${frame.slice('frame'.length)}`;
export const frameFor = (dock: string): string => `frame${dock.slice('dock'.length)}`;
import type { DockSide, NotchAt, NotchConfig, NotchCorner, NotchSize, PillColor, PinnedSite } from './settings';
import type { ShelfFile } from '../activities/shelf';

/** Each notch size's scale; Medium is the taskbar's Small, Large its Medium. */
export const NOTCH_ZOOM: Record<NotchSize, number> = { small: 0.7, medium: 0.84, large: 1 };
/** A notch's thickness, as the taskbar's, CSS px before its scale. */
const NOTCH_T = 52;
/** Its ends melt into the border over this much (CSS px before its scale), as the taskbar's do. */
export const NOTCH_MELT = { out: 44, up: 30 };
/** Tucked, a notch is the same notch, as long, only this thick from the screen's edge (CSS px): it
 *  widens out of the border as one shape when pointed at (Moss: not a bump of its own). */
export const TAB = { thick: 13 };
/** A tucked notch's thickness out of the edge, CSS px: TAB.thick at Small, more as its size grows
 *  (Moss, 11-19: the sizes showed no difference while tucked). */
export const restThick = (zoom: number): number => (TAB.thick * zoom) / NOTCH_ZOOM.small;
/** How small a tucked notch is: restThick of its thickness, the rest of it in proportion. */
const restK = (n: { thick: number; zoom: number }): number => (n.thick > 0 ? Math.min(1, restThick(n.zoom) / n.thick) : 1);
/** The light's path is drawn again this long after the last shape moved, ms. */
const GLOW_SETTLE_MS = 60;
/** The light round an expanded notch: its ring's width and the halo's, CSS px; the room for it past
 *  the notch's inner edge. */
const NOTCH_RING = { core: 1.6, halo: 5, room: 10 };
/** From the screen's corner to a notch's foot, CSS px. */
const CORNER_GAP = 28;
/** Between two notches in the same place, CSS px. */
const STACK_GAP = 14;
/** The border's inner corners. */
const INNER_R = 14;
/** The island's colour on the border fades out over this far past its melted ends, CSS px, from this strong (%). */
const TINT_FADE = 120;
const TINT_STRENGTH = 26;
/** A notch tucks back this long after the pointer leaves it, ms. */
const TUCK_MS = 380;
/** Shelf files shown in its notch at most; the rest are counted. */
export const SHELF_SHOWN = 6;

export interface FrameFrame {
  /** The border's width, CSS px. */
  width: number;
  color: PillColor;
  glass?: number;
  /** Pill colour › Custom's own colour. */
  custom?: string;
  accent: string;
  reduce: boolean;
  sites: NotchConfig & { list: PinnedSite[] };
  shelf: NotchConfig & { files: ShelfFile[]; undo: boolean };
  /** The light round the whole border (Glow › Whole screen), else null. */
  glow: { spec: GlowSpec | null; speed: Exclude<GlowSpeed, 'off'> } | null;
  /** Faint until the pointer comes to the screen's edge. */
  autoHide?: boolean;
  /** The notches' ends curve into the edge (unset: yes). */
  melt?: boolean;
  /** The notches sit on the edge (unset: yes); off they float FLOAT_GAP off it. */
  blend?: boolean;
}

/** A notch that doesn't blend into its edge floats this far off it, CSS px. */
export const FLOAT_GAP = 8;
/** Ends that don't melt: next to nothing (a ring's path needs some). */
const FLAT = { out: 0.01, up: 0.01 };

/** Where the taskbar or the island is, from its own window: a rect in screen CSS px, its side (the
 *  edge it sits on), its scale, and its melted ends' size (0: none). */
export interface FramePart {
  rect: [number, number, number, number];
  side: DockSide;
  zoom: number;
  melt: { out: number; up: number } | null;
  /** The bar's thickness and corner radius before its scale. */
  thick: number;
  radius: number;
  /** Its colour where it meets the edge (Music's player, from the art): the border takes a little of
   *  it on either side, fading out. */
  tint?: string | null;
  /** Drawn this much as thick (a tucked notch: the notch, slimmed toward the edge). */
  squash?: number;
}

export type FrameAct =
  | { kind: 'site-remove'; url: string }
  | { kind: 'site-move'; url: string; to: number }
  | { kind: 'sites-settings' }
  | { kind: 'shelf'; name: string; arg?: unknown }
  | { kind: 'shelf-drop'; paths: string[] }
  | { kind: 'shelf-open' }
  /** A notch dragged to its own place (null: back to its corner), or made draggable any time. */
  | { kind: 'notch-place'; notch: 'sites' | 'shelf'; at: NotchAt | null }
  | { kind: 'notch-free'; notch: 'sites' | 'shelf'; on: boolean };

/** Where notch `kind` sits along its side, CSS px from the screen's top, given what is above it
 *  in the same place: `len` its length (feet included), `before` the lengths stacked nearer the corner. */
export function notchTop(corner: NotchCorner, screenH: number, len: number, before: number): number {
  return corner.startsWith('top') ? CORNER_GAP + before : screenH - CORNER_GAP - before - len;
}

/** The side a corner's notch comes out of. */
export const sideOf = (corner: NotchCorner): 'left' | 'right' => (corner.endsWith('left') ? 'left' : 'right');

/** A site's picture: its icon as Google keeps it for any site (what Chrome shows too). */
export function faviconOf(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=64`;
  } catch {
    return '';
  }
}

/**
 * Puts a site's icon in `img`. In the app Rust fetches it (the webview wouldn't load Google's icons
 * itself: Moss saw letters); in a browser preview the page loads it. No picture: `img` errors.
 */
export function loadSiteIcon(img: HTMLImageElement, url: string): void {
  if (!isTauri) {
    img.src = faviconOf(url);
    return;
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a web address: no picture.
  }
  void (host ? native.siteIcon(host) : Promise.resolve(null)).then((data) => {
    if (data && data.startsWith('data:image/')) img.src = data;
    else img.dispatchEvent(new Event('error'));
  });
}

/**
 * The outline of a bar on the screen's edge as an SVG path, drawn as if along the bottom: `len` long
 * and `h` thick, its inner corners rounded by `r`, its ends melting into the edge over `out` and `up`
 * (none: straight down), each foot flattening onto the border `b` up from the edge.
 */
export function barOutline(len: number, h: number, r: number, melt: { out: number; up: number } | null, b: number): string {
  if (!melt) return `M0 ${h}L0 ${r}A${r} ${r} 0 0 1 ${r} 0L${len - r} 0A${r} ${r} 0 0 1 ${len} ${r}L${len} ${h}Z`;
  const u = Math.min(melt.up, h - r);
  const o = melt.out;
  const bb = Math.max(0, Math.min(b, u - 2));
  return (
    `M${-o} ${h - bb}A${o} ${u - bb} 0 0 0 0 ${h - u}L0 ${r}A${r} ${r} 0 0 1 ${r} 0L${len - r} 0A${r} ${r} 0 0 1 ${len} ${r}` +
    `L${len} ${h - u}A${o} ${u - bb} 0 0 0 ${len + o} ${h - bb}L${len + o} ${h}L${-o} ${h}Z`
  );
}

/** The matrix that takes a bar drawn along the bottom (barOutline) to its place: `rect` its box on
 *  the screen (feet left out), on side `side`, at scale `z`. */
export function barMatrix(side: DockSide, rect: [number, number, number, number], z: number, h: number, squash = 1): DOMMatrix {
  const [x, y, w, hh] = rect;
  // Across the bar (toward the screen's edge) it may be drawn slimmer: `squash` of its thickness.
  const t = z * squash;
  switch (side) {
    case 'top':
      return new DOMMatrix([z, 0, 0, -t, x, y + h * t]);
    case 'left':
      return new DOMMatrix([0, z, -t, 0, x + h * t, y]);
    case 'right':
      return new DOMMatrix([0, z, t, 0, x + w - h * t, y]);
    default:
      return new DOMMatrix([z, 0, 0, t, x, y + hh - h * t]);
  }
}

/**
 * The CSS mask of a ring just outside an upright notch on side `side` (its light, when it is out):
 * `len` its body's length, `h` its thickness, `r` its corners, `melt` its ends, `b` the border, all
 * in CSS px; the box is `room` wider than the notch, toward the screen. `w` the ring's width.
 */
export function notchRing(side: 'left' | 'right', len: number, h: number, r: number, melt: { out: number; up: number }, b: number, room: number, w: number): string {
  const o = melt.out;
  const u = Math.min(melt.up, h - r);
  const bb = Math.max(0, Math.min(b, u - 2));
  // Along the bottom (barOutline's frame), then turned upright: open along the edge, and closed.
  const open = `M${-o} ${h - bb}A${o} ${u - bb} 0 0 0 0 ${h - u}L0 ${r}A${r} ${r} 0 0 1 ${r} 0L${len - r} 0A${r} ${r} 0 0 1 ${len} ${r}L${len} ${h - u}A${o} ${u - bb} 0 0 0 ${len + o} ${h - bb}`;
  const closed = `${open}L${len + o} ${h}L${-o} ${h}Z`;
  const W = h + room;
  const H = len + 2 * o;
  const turn = side === 'left' ? `matrix(0 1 -1 0 ${h} ${o})` : `matrix(0 1 1 0 ${room} ${o})`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>` +
    `<defs><mask id='m' maskUnits='userSpaceOnUse' x='0' y='0' width='${W}' height='${H}'><rect width='${W}' height='${H}' fill='white'/>` +
    `<g transform='${turn}'><path d='${closed}' fill='black'/></g></mask></defs>` +
    `<g mask='url(#m)'><g transform='${turn}'><path d='${open}' fill='none' stroke='#000' stroke-width='${w * 2}'/></g></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// ------------------------------------------------------------------ the island's side

export interface FrameHooks {
  /** The border is on (and can be). */
  enabled(): boolean;
  frame(): FrameFrame;
  act(a: FrameAct): void;
  /** The window just loaded: say again where the island is. */
  ready?(): void;
  /** A border on every screen with a taskbar (the taskbars' Show on). */
  allScreens?(): boolean;
}

export class FrameHost {
  private shown = false;
  /** The frame last sent to each border, by its label. */
  private sent = new Map<string, string>();
  /** Which border is on which screen (frame_show's answer). */
  private screens: DockScreen[] = [{ label: 'frame', monitor: '', primary: true }];
  private allSent: boolean | undefined;
  private offs: Array<() => void> = [];

  constructor(private readonly hooks: FrameHooks) {}

  async start(): Promise<void> {
    this.offs.push(
      await on<FrameAct>('frame-act', (a) => {
        if (a && typeof a === 'object' && typeof a.kind === 'string') this.hooks.act(a);
        this.tick();
      }),
      await on<null>('frame-ready', () => {
        this.sent.clear();
        this.tick();
        this.hooks.ready?.();
      }),
      // A screen added or taken away: Rust gives it its border; this learns where.
      await on('displays-changed', () => {
        if (this.shown) void this.showAll();
      }),
    );
  }

  /** The borders on their screens. */
  private async showAll(): Promise<void> {
    this.allSent = this.hooks.allScreens?.() ?? true;
    const screens = await native.frameShow(true);
    this.screens = screens.length ? screens : [{ label: 'frame', monitor: '', primary: true }];
    this.sent.clear();
    this.tick();
  }

  /** The border on screen `monitor` (the main screen's when there is none there). */
  labelOn(monitor: string | null): string {
    return this.screens.find((s) => s.monitor === monitor)?.label ?? 'frame';
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.shown) void native.frameShow(false);
    this.shown = false;
  }

  /** The window open or closed as Settings says, and its frame when it changed. Cheap: called often. */
  tick(): void {
    if (!this.hooks.enabled()) {
      if (this.shown) void native.frameShow(false);
      this.shown = false;
      return;
    }
    if (!this.shown) {
      this.shown = true;
      this.sent.clear();
      void this.showAll();
      return;
    }
    if ((this.hooks.allScreens?.() ?? true) !== this.allSent) {
      void this.showAll();
      return;
    }
    const f = this.hooks.frame();
    const json = JSON.stringify(f);
    for (const s of this.screens) {
      if (json === this.sent.get(s.label)) continue;
      this.sent.set(s.label, json);
      void sendTo(s.label, 'frame-frame', f);
    }
  }
}

// ------------------------------------------------------------------ the frame window

function el(tag: string, cls: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** An SVG mask as a CSS url. */
const svgUrl = (w: number, h: number, body: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`;

interface Notch {
  kind: 'sites' | 'shelf';
  el: HTMLElement;
  /** Its own light, round it while it is out (frame.ts notchRing). */
  ring: HTMLElement;
  inner: HTMLElement;
  bg: HTMLElement;
  items: HTMLElement;
  out: boolean;
  tuck: number;
  /** Where it is (CSS px): its side, top, length with feet, thickness. */
  side: 'left' | 'right';
  top: number;
  len: number;
  thick: number;
  zoom: number;
  sig: string;
}

/**
 * This window is the border: it draws what the island sends, slides the notches out and back, and
 * tells Rust where it takes clicks (only on the notches).
 */
export async function runFrame(stage: HTMLElement): Promise<void> {
  const root = document.documentElement;
  root.classList.add('frame-window');
  let frame: FrameFrame | null = null;
  let screen = { width: window.innerWidth, height: window.innerHeight };
  /** The window's corner on the screen, CSS px, to place what the taskbar and island report. */
  const origin = () => ({ x: window.screenX, y: window.screenY });
  let dock: FramePart | null = null;
  let island: FramePart[] = [];
  /** Blended into the edge, the notches slide in and out at full size; detached, they grow (as before). */
  const slides = () => frame?.blend !== false;
  const send = (a: FrameAct) => void sendTo('island', 'frame-act', a);

  const border = el('div', 'fr-border');
  // The island's colour (Music's player) on the line either side of it, fading out.
  const tintEl = el('div', 'fr-tint');
  stage.append(border, tintEl);
  const label = el('div', 'fr-label');
  stage.append(label);

  // The light round the whole border: a turning cone seen through a ring cut to the outline.
  const glow = el('div', 'fr-glow');
  const halo = el('div', 'fr-ring halo');
  const core = el('div', 'fr-ring core');
  halo.append(el('i', ''));
  core.append(el('i', ''));
  glow.append(halo, core);
  stage.append(glow);

  const makeNotch = (kind: Notch['kind']): Notch => {
    const n = el('div', `notch n-${kind}`);
    const inner = el('div', 'notch-in');
    const bg = el('i', 'notch-bg');
    const items = el('div', 'nt-items');
    inner.append(bg, items);
    // Its light while it is out: the same turning cone as the border's, seen through a ring round it.
    const ring = el('div', 'nt-ring');
    for (const k of ['halo', 'core']) {
      const r = el('div', `nt-ring-${k}`);
      r.append(el('i', 'nt-cone'));
      ring.append(r);
    }
    n.append(ring, inner);
    stage.append(n);
    const notch: Notch = { kind, el: n, ring, inner, bg, items, out: false, tuck: 0, side: 'left', top: 0, len: 0, thick: 0, zoom: 1, sig: '' };
    n.addEventListener('pointerenter', () => slide(notch, true));
    n.addEventListener('pointerleave', () => slide(notch, false));
    return notch;
  };
  const sites = makeNotch('sites');
  const shelf = makeNotch('shelf');
  const notches = [sites, shelf];

  /** Out (pointed at, or a file dragged over it), or tucked back a moment after the pointer leaves. */
  const slide = (n: Notch, out: boolean) => {
    window.clearTimeout(n.tuck);
    // Being moved: it stays out until Done.
    if (!out && editingNotch === n.kind) return;
    // The border's light keeps running round the slim notch; out, the notch carries its own (CSS).
    if (out) {
      if (n.out) return;
      n.out = true;
      n.el.classList.add('out');
      solid();
      return;
    }
    n.tuck = window.setTimeout(() => {
      n.out = false;
      n.el.classList.remove('out');
      hideLabel();
      solid();
    }, TUCK_MS);
  };

  // A site's or a file's name, beside the notch, level with what the pointer is on.
  const showLabel = (n: Notch, item: HTMLElement, text: string) => {
    if (!text) return hideLabel();
    label.textContent = text;
    const r = item.getBoundingClientRect();
    const nr = n.el.getBoundingClientRect();
    const y = Math.round(r.top + r.height / 2 - 15);
    label.style.top = `${y}px`;
    if (n.side === 'left') {
      label.style.left = `${Math.round(nr.right + 8)}px`;
      label.style.right = '';
    } else {
      label.style.right = `${Math.round(screen.width - nr.left + 8)}px`;
      label.style.left = '';
    }
    label.classList.add('on');
  };
  const hideLabel = () => label.classList.remove('on');

  const drawSites = (f: FrameFrame) => {
    const list = f.sites.list;
    const sig = JSON.stringify(list);
    if (sig === sites.sig) return;
    sites.sig = sig;
    const kids: HTMLElement[] = list.map((s) => {
      const b = el('button', 'nt-item nt-site');
      b.setAttribute('aria-label', s.title);
      const pic = el('span', 'nt-pic');
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      // No picture: the site's first letter.
      img.addEventListener('error', () => {
        pic.textContent = (s.title || s.url).replace(/^https?:\/\/(www\.)?/, '').charAt(0).toUpperCase();
        pic.classList.add('letter');
      });
      pic.append(img);
      loadSiteIcon(img, s.url);
      b.append(pic);
      b.addEventListener('click', () => void native.openUrl(s.url));
      b.addEventListener('pointerenter', () => showLabel(sites, b, s.title));
      b.addEventListener('pointerleave', hideLabel);
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void siteMenu(s);
      });
      return b;
    });
    const add = el('button', 'nt-item nt-add', icon('plus'));
    add.setAttribute('aria-label', 'Add a website');
    add.addEventListener('click', () => send({ kind: 'sites-settings' }));
    add.addEventListener('pointerenter', () => showLabel(sites, add, list.length ? 'Add a website' : 'Pin a website here'));
    add.addEventListener('pointerleave', hideLabel);
    sites.items.replaceChildren(...kids, add);
  };

  const siteMenu = async (s: PinnedSite) => {
    if (!isTauri) return;
    const menu = await Menu.new({
      items: [
        await MenuItem.new({ text: s.title, enabled: false }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: 'Open', action: () => void native.openUrl(s.url) }),
        await MenuItem.new({ text: 'Remove from Websites', action: () => send({ kind: 'site-remove', url: s.url }) }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: 'Websites settings…', action: () => send({ kind: 'sites-settings' }) }),
      ],
    });
    await menu.popup();
  };

  // A file pressed and moved this far is dragged out (a shorter press opens the Shelf).
  const DRAG_PX = 4;
  const drawShelf = (f: FrameFrame) => {
    const files = f.shelf.files;
    const sig = JSON.stringify([files.map((x) => [x.path, x.thumb, x.missing]), f.shelf.undo]);
    if (sig === shelf.sig) return;
    shelf.sig = sig;
    const head = el('button', 'nt-item nt-head', icon('shelf'));
    head.setAttribute('aria-label', 'Shelf');
    head.addEventListener('click', () => send({ kind: 'shelf-open' }));
    head.addEventListener('pointerenter', () => showLabel(shelf, head, files.length ? `Shelf · ${files.length} file${files.length === 1 ? '' : 's'}` : 'Shelf · drop files here'));
    head.addEventListener('pointerleave', hideLabel);
    if (files.length) head.append(Object.assign(el('b', 'nt-count'), { textContent: String(files.length) }));
    const shown = files.slice(0, SHELF_SHOWN).map((file) => {
      const b = el('button', `nt-item nt-file${file.missing ? ' missing' : ''}`);
      const pic = el('span', 'nt-pic', file.thumb ? undefined : icon(file.dir ? 'folder' : 'file'));
      if (file.thumb) {
        const img = document.createElement('img');
        img.src = file.thumb;
        img.alt = '';
        img.draggable = false;
        pic.append(img);
      }
      b.append(pic);
      b.addEventListener('pointerenter', () => showLabel(shelf, b, file.name));
      b.addEventListener('pointerleave', hideLabel);
      let press: { x: number; y: number } | null = null;
      b.addEventListener('pointerdown', (e) => {
        if (e.button === 0 && !file.missing) press = { x: e.clientX, y: e.clientY };
      });
      b.addEventListener('pointermove', (e) => {
        if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
        press = null;
        hideLabel();
        send({ kind: 'shelf', name: 'drag-out', arg: file.path });
      });
      b.addEventListener('pointerup', () => {
        if (press) send({ kind: 'shelf-open' });
        press = null;
      });
      return b;
    });
    const more = files.length > SHELF_SHOWN ? [Object.assign(el('span', 'nt-more'), { textContent: `+${files.length - SHELF_SHOWN}` })] : [];
    shelf.items.replaceChildren(head, ...shown, ...more);
  };

  // The Shelf notch's right-click: open it, clear it.
  shelf.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isTauri) return;
    void (async () => {
      const menu = await Menu.new({
        items: [
          await MenuItem.new({ text: 'Open the Shelf', action: () => send({ kind: 'shelf-open' }) }),
          await MenuItem.new({ text: 'Clear the Shelf', enabled: (frame?.shelf.files.length ?? 0) > 0, action: () => send({ kind: 'shelf', name: 'clear-all' }) }),
          ...(await placeItems('shelf')),
        ],
      });
      await menu.popup();
    })();
  });
  sites.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isTauri) return;
    void (async () => {
      const menu = await Menu.new({ items: [await MenuItem.new({ text: 'Websites settings…', action: () => send({ kind: 'sites-settings' }) }), ...(await placeItems('sites'))] });
      await menu.popup();
    })();
  });

  /** The border: the screen less a rounded hole, and its rim along the hole's edge. */
  let borderSig = '';
  const drawBorder = () => {
    const w = frame?.width ?? 3;
    const { width: W, height: H } = screen;
    const sig = `${W}x${H}x${w}`;
    if (sig === borderSig) return;
    borderSig = sig;
    // Notches only (no border): nothing drawn round the screen.
    border.hidden = w <= 0;
    if (w <= 0) return;
    const hole = `M${w + INNER_R} ${w}H${W - w - INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${W - w} ${w + INNER_R}V${H - w - INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${W - w - INNER_R} ${H - w}H${w + INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${w} ${H - w - INNER_R}V${w + INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${w + INNER_R} ${w}Z`;
    border.style.setProperty('--fr-fill', svgUrl(W, H, `<path fill-rule='evenodd' d='M0 0H${W}V${H}H0Z${hole}'/>`));
    // The rim: 2px on the hole's edge, its inner half cut away by the fill above, as the taskbar's.
    border.style.setProperty('--fr-rim', svgUrl(W, H, `<path d='${hole}' fill='none' stroke='#000' stroke-width='2'/>`));
  };

  /** Each notch's size, place and look for its settings. */
  const placeNotches = () => {
    const f = frame;
    if (!f) return;
    // Dragged ones go where the pointer has them until the island confirms the place.
    for (const k of ['sites', 'shelf'] as const) {
      const live = liveAt.get(k);
      if (live !== undefined && JSON.stringify(live) === JSON.stringify(f[k].at)) liveAt.delete(k);
    }
    const w = f.width;
    const cfg = { sites: f.sites, shelf: f.shelf };
    // Stacked from each corner outward, in the order Websites, Shelf.
    const stacked: Record<string, number> = {};
    for (const n of notches) {
      const c = cfg[n.kind];
      n.el.hidden = !c.on;
      if (!c.on) continue;
      const z = NOTCH_ZOOM[c.size] ?? NOTCH_ZOOM.small;
      const at = liveAt.has(n.kind) ? (liveAt.get(n.kind) ?? null) : c.at;
      const side = at ? at.side : sideOf(c.corner);
      n.el.classList.toggle('editing', editingNotch === n.kind);
      n.el.classList.toggle('movable', editingNotch === n.kind || c.free);
      n.zoom = z;
      n.side = side;
      n.el.dataset.side = side;
      n.inner.style.zoom = String(z);
      const m = meltMasks(side, NOTCH_MELT.out, NOTCH_MELT.up, w / z);
      n.inner.style.setProperty('--nt-fill', m.fill);
      n.inner.style.setProperty('--nt-rim', m.rim);
      n.inner.style.setProperty('--nt-end', `${m.end}px`);
      const body = n.inner.offsetHeight * z;
      n.thick = NOTCH_T * z;
      n.len = body + 2 * NOTCH_MELT.out * z;
      if (at) {
        // Its own place: its middle where it was dropped, never off the screen.
        n.top = Math.round(Math.min(screen.height - CORNER_GAP - n.len, Math.max(CORNER_GAP, at.y * screen.height - n.len / 2)));
      } else {
        const before = stacked[c.corner] ?? 0;
        stacked[c.corner] = before + n.len + STACK_GAP;
        n.top = notchTop(c.corner, screen.height, n.len, before);
      }
      // Its body's top (the feet reach above and below it).
      n.el.style.top = `${Math.round(n.top + NOTCH_MELT.out * z)}px`;
      // Tucked: the whole notch made small, in proportion, TAB.thick of it out of the edge.
      n.el.style.setProperty('--nk', String(restK(n)));
      // Blended (fr-slide): the full-size notch pushed into the edge instead, TAB.thick of it showing;
      // it slides out as it is, never growing (Moss, 11-19). Its inside is zoomed, its ring isn't.
      n.el.style.setProperty('--nslide', `${Math.max(0, NOTCH_T - restThick(z) / z)}px`);
      n.el.style.setProperty('--nslide-px', `${Math.max(0, n.thick - restThick(z))}px`);
      // Its light: a ring round it as it is out, the cone turning about the screen's middle.
      const melts = f.melt !== false;
      const ringMasks = [NOTCH_RING.halo, NOTCH_RING.core].map((rw) => notchRing(side, body, n.thick, 18 * z, melts ? { out: NOTCH_MELT.out * z, up: NOTCH_MELT.up * z } : FLAT, w, NOTCH_RING.room, rw));
      const boxW = n.thick + NOTCH_RING.room;
      Object.assign(n.ring.style, { top: `${-NOTCH_MELT.out * z}px`, width: `${boxW}px`, height: `${n.len}px` });
      n.ring.style.setProperty('--m-halo', ringMasks[0]);
      n.ring.style.setProperty('--m-core', ringMasks[1]);
      const boxLeft = side === 'left' ? 0 : screen.width - boxW;
      n.ring.style.setProperty('--cx', `${screen.width / 2 - boxLeft}px`);
      n.ring.style.setProperty('--cy', `${screen.height / 2 - n.top}px`);
    }
  };

  // ---------------------------------------------------------- moving a notch (Moss, 11-19)
  // Edit position (its right-click menu, or Settings): drag it up or down its side, or across to the
  // other side; Done keeps it there, Back to the corner puts it back. Always movable: drag it any time.
  const liveAt = new Map<'sites' | 'shelf', NotchAt | null>();
  let editingNotch: 'sites' | 'shelf' | null = null;
  const editPill = el('div', 'nt-edit');
  const editReset = el('button', 'nt-edit-btn');
  editReset.textContent = 'Back to the corner';
  const editDone = el('button', 'nt-edit-btn done');
  editDone.textContent = 'Done';
  editPill.append(editReset, editDone);
  stage.append(editPill);
  const placeEditPill = () => {
    const n = editingNotch ? notches.find((q) => q.kind === editingNotch) : null;
    editPill.classList.toggle('on', Boolean(n && !n.el.hidden));
    if (!n || n.el.hidden) return;
    const w = editPill.offsetWidth || 220;
    const x = n.side === 'left' ? n.thick + 22 : screen.width - n.thick - 22 - w;
    editPill.style.left = `${Math.round(x)}px`;
    editPill.style.top = `${Math.round(n.top + n.len / 2 - 19)}px`;
  };
  const setEditingNotch = (k: 'sites' | 'shelf' | null) => {
    // The one being moved stands all the way out, so it is plain which it is.
    for (const n of notches) {
      if (n.kind === k) slide(n, true);
      else if (n.kind === editingNotch) slide(n, false);
    }
    editingNotch = k;
    placeNotches();
    placeEditPill();
    solid();
  };
  editDone.addEventListener('click', () => setEditingNotch(null));
  editReset.addEventListener('click', () => {
    if (!editingNotch) return;
    liveAt.set(editingNotch, null);
    send({ kind: 'notch-place', notch: editingNotch, at: null });
    placeNotches();
    placeEditPill();
    solid();
    drawGlow();
  });
  // Auto-hide: up while the pointer is near the screen's edge (frame.rs).
  await onMine<boolean>('frame-near', (v) => root.classList.toggle('fr-near', v === true));
  await onMine<string>('frame-edit', (k) => setEditingNotch(k === 'sites' || k === 'shelf' ? k : null));
  for (const n of notches) {
    let press: { id: number; x: number; y: number; moved: boolean } | null = null;
    let swallow = false;
    n.el.addEventListener('pointerdown', (e) => {
      const c = frame?.[n.kind];
      if (e.button !== 0 || !c || !(editingNotch === n.kind || c.free)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      try {
        n.el.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the page doesn't know (a test's).
      }
    });
    n.el.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
      press.moved = true;
      n.el.classList.add('dragging');
      liveAt.set(n.kind, { side: e.clientX < screen.width / 2 ? 'left' : 'right', y: Math.min(1, Math.max(0, e.clientY / screen.height)) });
      placeNotches();
      placeEditPill();
    });
    const end = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      const moved = press.moved;
      press = null;
      n.el.classList.remove('dragging');
      if (!moved) return;
      // The click a drag ends in opens nothing.
      swallow = true;
      window.setTimeout(() => (swallow = false), 0);
      const at = liveAt.get(n.kind) ?? null;
      send({ kind: 'notch-place', notch: n.kind, at });
      solid();
      drawGlow();
    };
    n.el.addEventListener('pointerup', end);
    n.el.addEventListener('pointercancel', end);
    n.el.addEventListener(
      'click',
      (e) => {
        if (swallow) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }
  /** Its right-click menu's place items: Edit position, Back to the corner, Always movable. */
  const placeItems = async (k: 'sites' | 'shelf') => {
    const c = frame?.[k];
    return [
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: editingNotch === k ? 'Done moving' : 'Edit position', action: () => setEditingNotch(editingNotch === k ? null : k) }),
      ...(c?.at ? [await MenuItem.new({ text: 'Back to the corner', action: () => send({ kind: 'notch-place', notch: k, at: null }) })] : []),
      await CheckMenuItem.new({ text: 'Always movable', checked: c?.free === true, action: () => send({ kind: 'notch-free', notch: k, on: !c?.free }) }),
    ];
  };

  /** Where the window takes clicks: each notch (tucked, its tab and the edge beside it). */
  let solidSent = '';
  const solid = () => {
    const rects: number[][] = [];
    const w = frame?.width ?? 3;
    for (const n of notches) {
      if (n.el.hidden) continue;
      const top = n.top;
      if (n.out) {
        const x = n.side === 'left' ? 0 : screen.width - n.thick - 2;
        rects.push([x, top, n.thick + 2, n.len]);
      } else {
        // Only the small notch as drawn (Moss, 11-20: a margin beyond it took the clicks meant for a
        // window's scrollbar there); the screen's edge stops the pointer on it anyway.
        const reach = Math.max(w, restThick(n.zoom));
        const long = slides() ? n.len : n.len * restK(n);
        rects.push([n.side === 'left' ? 0 : screen.width - reach, top + (n.len - long) / 2, reach, long]);
      }
    }
    if (editPill.classList.contains('on')) {
      const r = editPill.getBoundingClientRect();
      rects.push([r.left - 6, r.top - 6, r.width + 12, r.height + 12]);
    }
    const json = JSON.stringify(rects.map((q) => q.map((v) => Math.round(v))));
    if (json === solidSent) return;
    solidSent = json;
    void native.frameSolid(JSON.parse(json) as number[][]);
  };

  /** The island's colour on the line beside it: strongest at its melted ends, gone TINT_FADE px on. */
  const drawTint = () => {
    const p = island.find((q) => q.tint);
    // Only a colour, nothing that could break out of the style.
    const tint = p?.tint && /^[#\w\s(),.%-]+$/.test(p.tint) ? p.tint : null;
    if (!p || !tint || !frame) {
      tintEl.classList.remove('on');
      return;
    }
    const o = origin();
    const [x, y, w, h] = p.rect;
    const lx = x - o.x;
    const ly = y - o.y;
    const reach = (p.melt?.out ?? 0) * p.zoom + TINT_FADE;
    const bw = frame.width;
    const c = `color-mix(in srgb, ${tint} ${TINT_STRENGTH}%, transparent)`;
    const across = p.side === 'top' || p.side === 'bottom';
    const st = tintEl.style;
    if (across) {
      Object.assign(st, { left: `${lx - reach}px`, width: `${w + 2 * reach}px`, top: p.side === 'top' ? '0px' : `${screen.height - bw}px`, height: `${bw}px` });
    } else {
      Object.assign(st, { top: `${ly - reach}px`, height: `${h + 2 * reach}px`, left: p.side === 'left' ? '0px' : `${screen.width - bw}px`, width: `${bw}px` });
    }
    st.background = `linear-gradient(${across ? 'to right' : 'to bottom'}, transparent, ${c} ${reach}px, ${c} calc(100% - ${reach}px), transparent)`;
    tintEl.classList.add('on');
  };

  // ---------------------------------------------------------------- the light round everything

  /** Every shape on the border as one path in this window's CSS px: the taskbar, the island, the notches. */
  const shapes = (): Path2D => {
    const all = new Path2D();
    const w = frame?.width ?? 3;
    const o = origin();
    const part = (p: FramePart | null) => {
      if (!p) return;
      const [x, y, rw, rh] = p.rect;
      const rect: [number, number, number, number] = [x - o.x, y - o.y, rw, rh];
      const along = p.side === 'left' || p.side === 'right' ? rh : rw;
      // A slimmed notch is the notch stretched, its feet's flattening onto the border with it (as drawn).
      const path = new Path2D(barOutline(along / p.zoom, p.thick, p.radius, p.melt, w / p.zoom));
      all.addPath(path, barMatrix(p.side, rect, p.zoom, p.thick, p.squash ?? 1));
    };
    part(dock);
    for (const p of island) part(p);
    // The notches as they are tucked, always: out, each draws its own light round itself (and covers
    // this ring's part round it), so a notch coming out never makes this path change.
    for (const n of notches) {
      if (n.el.hidden) continue;
      if (slides()) {
        // The full notch pushed into the edge, TAB.thick of it out (its feet go off the screen).
        const push = Math.max(0, n.thick - restThick(n.zoom));
        const body = n.len - 2 * NOTCH_MELT.out * n.zoom;
        const x = n.side === 'left' ? -push : screen.width - n.thick + push;
        part({ rect: [x + o.x, n.top + NOTCH_MELT.out * n.zoom + o.y, n.thick, body], side: n.side, zoom: n.zoom, melt: frame?.melt === false ? null : NOTCH_MELT, thick: NOTCH_T, radius: 18 });
        continue;
      }
      // The whole notch at restK of its size, about the middle of where it meets the edge.
      const k = restK(n);
      const body = (n.len - 2 * NOTCH_MELT.out * n.zoom) * k;
      const off = frame?.blend === false ? FLOAT_GAP : 0;
      const x = n.side === 'left' ? off : screen.width - n.thick * k - off;
      part({ rect: [x + o.x, n.top + n.len / 2 - body / 2 + o.y, n.thick * k, body], side: n.side, zoom: n.zoom * k, melt: frame?.melt === false ? null : NOTCH_MELT, thick: NOTCH_T, radius: 18 });
    }
    return all;
  };

  /** The hole the light runs round: the screen less every shape, as a path (even-odd with the border's). */
  const holePath = (): Path2D => {
    const w = frame?.width ?? 3;
    const { width: W, height: H } = screen;
    const p = new Path2D();
    p.addPath(new Path2D(`M${w + INNER_R} ${w}H${W - w - INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${W - w} ${w + INNER_R}V${H - w - INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${W - w - INNER_R} ${H - w}H${w + INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${w} ${H - w - INNER_R}V${w + INNER_R}A${INNER_R} ${INNER_R} 0 0 1 ${w + INNER_R} ${w}Z`));
    return p;
  };

  /** One ring `width` wide just inside the hole's edge (round every shape), soft by `blur`, as a CSS mask. */
  const ringMask = (width: number, blur: number): string => {
    const { width: W, height: H } = screen;
    const k = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * k);
    c.height = Math.ceil(H * k);
    const g = c.getContext('2d');
    if (!g) return 'none';
    g.scale(k, k);
    if (blur) g.filter = `blur(${blur}px)`;
    // The border's inner edge and every shape's outline, thick, inside the hole only; then the shapes
    // themselves cut out: what's left runs just inside the border and just outside each shape.
    const s = shapes();
    const hole = holePath();
    g.strokeStyle = '#000';
    g.lineWidth = width * 2;
    g.lineJoin = 'round';
    g.save();
    g.clip(hole);
    g.stroke(hole);
    g.stroke(s);
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    g.filter = 'none';
    g.fill(s);
    return `url(${c.toDataURL('image/png')})`;
  };

  let glowSig = '';
  let glowWait = 0;
  /**
   * The light's path again, soon after a shape moved (the taskbar, the island, the screen). The
   * notches never change it (see shapes), and the island says where it is every second, so the path
   * never stays round a card that closed.
   */
  const drawGlow = (wait = GLOW_SETTLE_MS) => {
    window.clearTimeout(glowWait);
    const g = frame?.glow;
    if (!g || !g.spec) return;
    glowWait = window.setTimeout(() => {
      const sig = JSON.stringify([screen, frame?.width, frame?.blend, frame?.melt, dock, island, notches.map((n) => [n.el.hidden, n.top, n.len, n.side, n.thick])]);
      if (sig === glowSig) return;
      glowSig = sig;
      core.style.setProperty('--m', ringMask(1.6, 0));
      halo.style.setProperty('--m', ringMask(5, 1.5));
    }, wait);
  };

  const tone = (t: string) => (t === 'default' ? 'var(--fg)' : `var(--${t})`);
  let glowKey = '';
  const syncGlow = (f: FrameFrame) => {
    const g = f.glow;
    const spec = g?.spec ?? null;
    const key = spec ? JSON.stringify([spec.tone, spec.motion, spec.fast, g?.speed]) : '';
    if (spec?.motion === 'progress') root.style.setProperty('--p', `${Math.max(0, Math.min(1, spec.value ?? 0)) * 360}deg`);
    if (key === glowKey) return;
    glowKey = key;
    if (!spec || !g) {
      glow.classList.remove('on');
      root.classList.remove('fr-lit');
      return;
    }
    const pace = GLOW_PACE[g.speed] ?? GLOW_PACE.medium;
    const brisk = spec.fast ? 0.65 : 1;
    root.style.setProperty('--lap', `${pace.lap * brisk}s`);
    root.style.setProperty('--breath', `${pace.breath * brisk}s`);
    const c = tone(spec.tone);
    root.style.setProperty('--c', c);
    root.style.setProperty('--hot', `color-mix(in srgb, ${c} 45%, white)`);
    // On the page, so the notches' own lights turn with the border's, from the same moment.
    root.dataset.frMotion = glow.dataset.motion = f.reduce && spec.motion !== 'progress' ? 'still' : spec.motion;
    root.classList.add('fr-lit');
    glowSig = '';
    drawGlow();
    glow.classList.add('on');
  };

  const draw = () => {
    const f = frame;
    if (!f) return;
    applyPill(root, f.color, f.custom);
    root.style.setProperty('--accent', f.accent);
    root.style.setProperty('--fr-w', `${f.width}px`);
    root.classList.toggle('fr-autohide', f.autoHide === true);
    root.classList.toggle('fr-flat', f.melt === false);
    root.classList.toggle('fr-float', f.blend === false);
    root.classList.toggle('fr-slide', slides());
    root.classList.toggle('reduce', f.reduce);
    applyGlass(root, f.glass);
    drawBorder();
    drawSites(f);
    drawShelf(f);
    placeNotches();
    solid();
    syncGlow(f);
    drawGlow();
  };

  // Files dragged over the Shelf's notch bring it out; dropped there, they go on the Shelf.
  const overShelf = (x: number, y: number) => {
    if (shelf.el.hidden) return false;
    const r = shelf.el.getBoundingClientRect();
    const reach = Math.max(frame?.width ?? 3, restThick(shelf.zoom)) + 12;
    const left = shelf.side === 'left' ? 0 : Math.min(r.left, screen.width - reach);
    const right = shelf.side === 'left' ? Math.max(r.right, reach) : screen.width;
    return x >= left && x <= right && y >= r.top && y <= r.bottom;
  };
  await onFileDrop((e) => {
    if (e.type === 'leave') {
      shelf.el.classList.remove('drop');
      slide(shelf, false);
      return;
    }
    const hit = overShelf(e.x, e.y);
    shelf.el.classList.toggle('drop', hit);
    if (hit) slide(shelf, true);
    if (e.type === 'drop') {
      shelf.el.classList.remove('drop');
      if (hit && e.paths?.length) send({ kind: 'shelf-drop', paths: e.paths });
      slide(shelf, false);
    }
  });

  await onMine<{ width: number; height: number }>('frame-screen', (s) => {
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return;
    screen = { width: s.width, height: s.height };
    borderSig = '';
    draw();
  });
  await onMine<FrameFrame>('frame-frame', (f) => {
    frame = f;
    draw();
  });
  await onMine<FramePart | null>('frame-dock', (p) => {
    dock = p;
    drawGlow();
  });
  await onMine<FramePart[] | null>('frame-island', (p) => {
    island = Array.isArray(p) ? p : [];
    drawTint();
    drawGlow();
  });
  // Under a full-screen game or video the border goes, as the taskbar does.
  await onMine<boolean>('frame-full', (full) => root.classList.toggle('fr-full', full === true));
  window.addEventListener('resize', () => {
    if (!isTauri) {
      screen = { width: window.innerWidth, height: window.innerHeight };
      borderSig = '';
      draw();
    }
  });
  void native.frameHello();
  void sendTo('island', 'frame-ready', null);
  // The taskbar (on this screen) may have said where it is before this window was there.
  void sendTo(isTauri ? dockFor(windowLabel) : 'dock', 'frame-hello', null);
}
