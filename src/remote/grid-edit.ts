// Control Center arranged from a phone, in place, the way the PC arranges it: hold a tile and the
// grid jiggles; drag tiles (to the card's side for the other page), drag a corner to resize, take
// tiles off with − and put them back from the tray with +. The phone works on its own copy (a
// GridDraft, laid out with the PC's own src/core/grid.ts) and Done sends the whole layout
// ({ t: 'grid-set' }: pages, hidden tiles, sizes changed). The island takes it only with tiles it
// showed that phone (on the grid or in the tray), each at a size that tile allows: a phone
// arranges, it can't name tiles or sizes of its own.

import { CELLS, moveTile, pageCount, rowsUsed, settle, sizeOf, unhide, withNew, type GridDims, type GridEntry, type GridPages, type GridSlot } from '../core/grid';
import type { SheetView, Tile } from '../core/sheet';
import type { TileSize } from '../core/settings';

/** What a phone sends: tiles on the grid in reading order, and the ones taken off. */
export interface PhoneLayout {
  order: string[];
  hidden: string[];
  /** Where the tiles sit, one list per page in reading order; null is an empty cell left on purpose (src/core/grid.ts). */
  pages?: GridPages;
  /** Tiles the phone resized. */
  sizes?: Record<string, TileSize>;
  /** Reset layout, as on the PC: the island forgets the pages, sizes and tiles taken off. */
  reset?: boolean;
}

/** Most tiles a layout from a phone may name. */
export const MAX_GRID_KEYS = 64;
/** Most pages, and entries on one page (tiles and empty cells), a layout from a phone may have. */
export const MAX_GRID_PAGES = 16;
export const MAX_PAGE_ENTRIES = 32;
/** Rows on every page of the grid (src/core/island.ts GRID_ROWS); the phone's card shows only the rows used. */
export const PAGE_ROWS = 4;

/** A size as a phone may name it. */
export const isTileSize = (v: unknown): v is TileSize => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CELLS, v);

/** The grid's tiles and tray in a view (the phone's Control Center); empty for any other card. */
export function gridTiles(view: SheetView | null): { items: Tile[]; tray: Tile[] } {
  const b = gridBlock(view);
  return b ? { items: b.items, tray: b.tray ?? [] } : { items: [], tray: [] };
}

type TilesBlock = Extract<SheetView['blocks'][number], { t: 'tiles' }>;

function gridBlock(view: SheetView | null): TilesBlock | null {
  const b = view?.blocks.find((x) => x.t === 'tiles' && x.key === 'grid');
  return b && b.t === 'tiles' ? b : null;
}

/** The layout a view shows, as a phone would send it unchanged. */
export function layoutOf(view: SheetView | null): PhoneLayout {
  const { items, tray } = gridTiles(view);
  const sorted = [...items].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.row ?? 0) - (b.row ?? 0) || (a.col ?? 0) - (b.col ?? 0));
  return { order: sorted.map((t) => t.key), hidden: tray.map((t) => t.key) };
}

/** Every tile key a phone was shown on the grid or in the tray: the only ones it may arrange. */
export function shownGridKeys(view: SheetView | null): Set<string> {
  const { items, tray } = gridTiles(view);
  return new Set([...items, ...tray].map((t) => t.key));
}

/** The sizes each tile shown to a phone may take ('2x1'), as the island offered them. */
export function shownGridSizes(view: SheetView | null): Map<string, Set<string>> {
  const { items, tray } = gridTiles(view);
  return new Map([...items, ...tray].map((t) => [t.key, new Set((t.sizes ?? []).map(([w, h]) => `${w}x${h}`))]));
}

/**
 * Whether a layout from a phone may be saved: each tile it names was shown to it, none twice,
 * and nothing shown is left out (a tile is on the grid or in the tray, never dropped). Its pages
 * name exactly the tiles on the grid, and each size is one that tile was offered.
 */
export function gridSetAllowed(shown: ReadonlySet<string>, l: PhoneLayout, sizes: ReadonlyMap<string, ReadonlySet<string>> = new Map()): boolean {
  const all = [...l.order, ...l.hidden];
  if (!shown.size || all.length !== shown.size || new Set(all).size !== all.length) return false;
  if (!all.every((k) => shown.has(k))) return false;
  const onGrid = new Set(l.order);
  if (l.pages) {
    const keys = l.pages.flat().filter((e): e is string => e !== null);
    if (keys.length !== onGrid.size || new Set(keys).size !== keys.length || !keys.every((k) => onGrid.has(k))) return false;
  }
  return Object.entries(l.sizes ?? {}).every(([k, s]) => onGrid.has(k) && sizes.get(k)?.has(s) === true);
}

/** The view without its tray: hidden tiles are shown to arrange, never to press. */
export function withoutTray(view: SheetView | null): SheetView | null {
  if (!view) return view;
  return { ...view, blocks: view.blocks.map((b) => (b.t === 'tiles' && b.tray ? { ...b, tray: [] } : b)) };
}

// ---------------------------------------------------------------- the phone's working copy

/** A drag or resize under way, as the PC keeps it (island.ts gridDrag). */
interface DraftDrag {
  key: string;
  snap: GridPages;
  dims: Map<string, { w: number; h: number }>;
  size: { w: number; h: number };
  preview: GridPages | null;
}

/** Control Center being arranged on a phone. */
export interface GridDraft {
  /** The view it started from (the latest the PC sent): its tiles' live content. */
  base: SheetView;
  /** Every tile, on the grid or in the tray, by key; `keys` in the order the PC lists them. */
  tiles: Map<string, Tile>;
  keys: string[];
  pages: GridPages;
  hidden: string[];
  size: Map<string, { w: number; h: number }>;
  /** Sizes as the PC drew them, and the tiles resized here: only real changes are sent. */
  was: Map<string, { w: number; h: number }>;
  resized: Set<string>;
  cols: number;
  cell: number;
  drag: DraftDrag | null;
}

/**
 * The pages a packed grid came from: on each page, tiles by their top-left cell in reading
 * order, with an empty cell (null) for every uncovered cell before the last tile. Packed again
 * (grid.ts settle), every tile lands where it was.
 */
export function pagesOf(items: Tile[], cols: number): GridPages {
  const n = items.reduce((m, t) => Math.max(m, (t.page ?? 0) + 1), 0);
  const pages: GridPages = [];
  for (let p = 0; p < n; p++) {
    const at = new Map<number, string>();
    const covered = new Set<number>();
    for (const t of items) {
      if ((t.page ?? 0) !== p) continue;
      const c = t.col ?? 0;
      const r = t.row ?? 0;
      at.set(r * cols + c, t.key);
      for (let dy = 0; dy < (t.h ?? 1); dy++) for (let dx = 0; dx < (t.w ?? 1); dx++) covered.add((r + dy) * cols + c + dx);
    }
    const last = Math.max(-1, ...at.keys());
    const page: GridEntry[] = [];
    for (let i = 0; i <= last; i++) {
      const k = at.get(i);
      if (k) page.push(k);
      else if (!covered.has(i)) page.push(null);
    }
    pages.push(page);
  }
  return pages;
}

/** A working copy of the Control Center a view shows; null for any other card. */
export function draftOf(view: SheetView | null): GridDraft | null {
  const b = gridBlock(view);
  if (!view || !b) return null;
  const size = new Map(b.items.map((t) => [t.key, { w: t.w ?? 1, h: t.h ?? 1 }]));
  return {
    base: view,
    tiles: new Map([...b.items, ...(b.tray ?? [])].map((t) => [t.key, t])),
    keys: [...b.items, ...(b.tray ?? [])].map((t) => t.key),
    pages: pagesOf(b.items, b.cols),
    hidden: (b.tray ?? []).map((t) => t.key),
    size,
    was: new Map(size),
    resized: new Set(),
    cols: b.cols,
    cell: b.cell,
    drag: null,
  };
}

/**
 * A newer view from the PC while arranging: the tiles' content follows it, the arrangement
 * stays the phone's. A tile that appeared joins the grid; one that went is left out. False when
 * the view is no longer Control Center (arranging ends).
 */
export function rebaseDraft(d: GridDraft, view: SheetView | null): boolean {
  const b = gridBlock(view);
  if (!view || !b) return false;
  d.base = view;
  const tray = b.tray ?? [];
  d.tiles = new Map([...b.items, ...tray].map((t) => [t.key, t]));
  d.keys = [...b.items, ...tray].map((t) => t.key);
  for (const t of b.items) if (!d.size.has(t.key)) d.size.set(t.key, { w: t.w ?? 1, h: t.h ?? 1 });
  for (const t of tray) if (!d.hidden.includes(t.key) && !d.pages.some((p) => p.includes(t.key))) d.hidden.push(t.key);
  return true;
}

/** The cells a tile takes when it has no size yet (it came back from the tray): its own, if offered. */
function natural(t: Tile): { w: number; h: number } {
  const w = t.span ?? 1;
  const h = t.rows ?? 1;
  const offered = t.sizes ?? [];
  if (!offered.length || offered.some(([a, b]) => a === w && b === h)) return { w, h };
  return { w: offered[0][0], h: offered[0][1] };
}

function dimsOf(d: GridDraft): { shown: string[]; dims: GridDims } {
  const hidden = new Set(d.hidden);
  const shown = d.keys.filter((k) => !hidden.has(k));
  const on = new Set(shown);
  const dims: GridDims = (k) => {
    if (!on.has(k)) return null;
    if (d.drag?.key === k) return d.drag.size;
    const t = d.tiles.get(k);
    return d.size.get(k) ?? (t ? natural(t) : null);
  };
  return { shown, dims };
}

/** Where every tile sits now (with a drag's preview while one is under way). */
export function draftLayoutNow(d: GridDraft): { pages: GridPages; slots: GridSlot[] } {
  const { shown, dims } = dimsOf(d);
  return settle(withNew(d.drag?.preview ?? d.pages, shown, dims), dims, d.cols, PAGE_ROWS);
}

/** The draft drawn as the island draws its grid: every row open, the tray and Reset layout / Done while editing. */
export function draftView(d: GridDraft, editing: boolean): SheetView {
  const { slots } = draftLayoutNow(d);
  const items: Tile[] = slots.flatMap((s) => {
    const t = d.tiles.get(s.key);
    return t ? [{ ...t, hidden: undefined, page: s.page, col: s.col, row: s.row, w: s.w, h: s.h }] : [];
  });
  const tray: Tile[] = d.hidden.flatMap((k) => {
    const t = d.tiles.get(k);
    return t ? [{ ...t, w: 1, h: 1, hidden: true }] : [];
  });
  const blocks: SheetView['blocks'] = [
    { t: 'tiles', key: 'grid', items, tray, cols: d.cols, rows: editing ? PAGE_ROWS : rowsUsed(slots), cell: d.cell, pages: pageCount(slots), editing },
  ];
  if (editing) {
    blocks.push({
      t: 'buttons',
      key: 'grid-edit',
      items: [
        { key: 'reset', label: 'Reset layout', icon: 'refresh', action: 'island:grid-reset', style: 'ghost' },
        { key: 'done', label: 'Done', icon: 'check', action: 'island:grid-done', style: 'primary' },
      ],
    });
  }
  return { ...d.base, blocks };
}

/**
 * An arranging action from the grid (sheet.ts wireGrid, editControls), applied to the draft as the
 * island applies it to its own grid (island.ts gridAction). 'done' and 'reset' are for the caller
 * to send; 'changed' redraws; null when the action isn't one of these.
 */
export function draftAct(d: GridDraft, action: string, arg: unknown): 'done' | 'reset' | 'changed' | null {
  const key = typeof arg === 'string' ? arg : '';
  switch (action) {
    case 'island:grid-edit':
      return 'changed';
    case 'island:grid-done':
      d.drag = null;
      return 'done';
    case 'island:grid-reset':
      d.drag = null;
      return 'reset';
    case 'island:grid-hide':
      if (d.tiles.has(key) && !d.hidden.includes(key)) d.hidden.push(key);
      return 'changed';
    case 'island:grid-show':
      d.hidden = unhide(d.hidden, key);
      return 'changed';
    case 'island:grid-lift': {
      const { pages, slots } = draftLayoutNow({ ...d, drag: null });
      const slot = slots.find((s) => s.key === key);
      if (!slot) return null;
      d.drag = { key, snap: pages.map((p) => [...p]), dims: new Map(slots.map((s) => [s.key, { w: s.w, h: s.h }])), size: { w: slot.w, h: slot.h }, preview: null };
      return 'changed';
    }
    case 'island:grid-move': {
      const drag = d.drag;
      const a = (arg ?? {}) as { key?: unknown; page?: unknown; col?: unknown; row?: unknown; w?: unknown; h?: unknown };
      if (!drag || a.key !== drag.key || typeof a.page !== 'number' || typeof a.col !== 'number' || typeof a.row !== 'number') return null;
      if (typeof a.w === 'number' && typeof a.h === 'number' && (d.tiles.get(drag.key)?.sizes ?? []).some(([w, h]) => w === a.w && h === a.h)) {
        drag.size = { w: a.w, h: a.h };
      }
      drag.preview = moveTile(drag.snap, drag.key, { page: a.page, col: a.col, row: a.row }, drag.size, (k) => drag.dims.get(k) ?? null, d.cols, PAGE_ROWS).pages;
      return 'changed';
    }
    case 'island:grid-drop': {
      const drag = d.drag;
      d.drag = null;
      if (!drag?.preview || drag.key !== key) return 'changed';
      d.pages = drag.preview.filter((p) => p.length > 0);
      const was = drag.dims.get(drag.key);
      if (was && (was.w !== drag.size.w || was.h !== drag.size.h)) {
        d.size.set(drag.key, { ...drag.size });
        d.resized.add(drag.key);
      }
      return 'changed';
    }
    case 'island:grid-cancel':
      d.drag = null;
      return 'changed';
    default:
      return null;
  }
}

/** What Done sends: the pages as arranged (only tiles still shown), the tray, and the sizes changed. */
export function draftLayout(d: GridDraft): PhoneLayout {
  const { pages } = draftLayoutNow({ ...d, drag: null });
  const known = new Set(d.keys);
  const hidden = d.hidden.filter((k) => known.has(k));
  const off = new Set(hidden);
  const out = pages
    .map((p) => {
      const kept = p.filter((e) => e === null || (known.has(e) && !off.has(e)));
      while (kept.length && kept[kept.length - 1] === null) kept.pop();
      return kept;
    })
    .filter((p) => p.some((e) => e !== null));
  const order = out.flat().filter((e): e is string => e !== null);
  const sizes: Record<string, TileSize> = {};
  for (const k of d.resized) {
    const s = d.size.get(k);
    const was = d.was.get(k);
    if (s && known.has(k) && !off.has(k) && (!was || was.w !== s.w || was.h !== s.h)) sizes[k] = sizeOf(s.w, s.h);
  }
  return Object.keys(sizes).length ? { order, hidden, pages: out, sizes } : { order, hidden, pages: out };
}
