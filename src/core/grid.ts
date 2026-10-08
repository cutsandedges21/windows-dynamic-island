// Where the open island's tiles sit: an invisible grid of whole cells, a fixed
// number of columns and rows per page (shown only while the user arranges it).
//
// The layout is a list per page, in reading order. Each page is packed on its
// own: every tile takes the first space it fits, so a small tile backfills a gap
// a big one left behind. A `null` entry is an empty cell the user left on
// purpose (by dropping a tile further on than the tiles before it reach); it
// holds its cell like an invisible 1x1 tile. Tiles that do not fit on a page go
// to the front of the next one.
//
// Moving a tile lifts it (the tiles after it close the hole, as on a phone's
// home screen) and puts it back in the list where it lands exactly on the cell
// it was dropped on: after empty cells when dropped past the other tiles, in
// front of whatever it was dropped onto otherwise. Resizing is a move to the
// same cell with a bigger or smaller box. Pure data, no DOM.

import type { TileSize } from './settings';

/** A tile key, or null for an empty cell the user left on purpose. */
export type GridEntry = string | null;
export type GridPages = GridEntry[][];

export interface GridItem {
  key: string;
  /** Cells across and down. */
  w: number;
  h: number;
}

export interface GridSlot extends GridItem {
  page: number;
  /** 0-based cell coordinates within the page. */
  col: number;
  row: number;
}

export interface GridCell {
  page: number;
  col: number;
  row: number;
}

/**
 * A tile's size in cells, or null when it is not on the grid right now (an
 * activity with nothing to show). Such a tile keeps its place in the list and
 * takes its cells back when it returns.
 */
export type GridDims = (key: string) => { w: number; h: number } | null;

export const CELLS: Record<TileSize, { w: number; h: number }> = {
  '1x1': { w: 1, h: 1 },
  '2x1': { w: 2, h: 1 },
  '1x2': { w: 1, h: 2 },
  '2x2': { w: 2, h: 2 },
};

export function sizeOf(w: number, h: number): TileSize {
  return `${Math.min(2, Math.max(1, w))}x${Math.min(2, Math.max(1, h))}` as TileSize;
}

/**
 * The activity whose tile opens the grid until the user arranges it themselves: right
 * after the day tile, which on four columns puts this two-cell tile top and centre.
 */
export const GRID_LEAD = 'local';

/** `ids` with GRID_LEAD moved to the front (when it is there at all). */
export function leadFirst(ids: string[]): string[] {
  return ids.includes(GRID_LEAD) ? [GRID_LEAD, ...ids.filter((id) => id !== GRID_LEAD)] : ids;
}

/** How many rows the packed tiles reach down to: the grid is no taller than that. */
export function rowsUsed(slots: GridSlot[]): number {
  return slots.reduce((n, s) => Math.max(n, s.row + s.h), 1);
}

export function pageCount(slots: GridSlot[]): number {
  return slots.reduce((n, s) => Math.max(n, s.page + 1), 1);
}

// ---------------------------------------------------------------- packing one page

type Occupancy = boolean[][];

interface Pos {
  col: number;
  row: number;
  w: number;
  h: number;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || 0));

function emptyPage(cols: number, rows: number): Occupancy {
  return Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
}

function free(occ: Occupancy, col: number, row: number, w: number, h: number): boolean {
  if (col < 0 || row < 0 || col + w > occ[0].length || row + h > occ.length) return false;
  for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (occ[r][c]) return false;
  return true;
}

function fill(occ: Occupancy, p: Pos): void {
  for (let r = p.row; r < p.row + p.h; r++) for (let c = p.col; c < p.col + p.w; c++) occ[r][c] = true;
}

/** The first spot a w x h box fits, scanning row by row. */
function firstFit(occ: Occupancy, w: number, h: number): Pos | null {
  for (let row = 0; row + h <= occ.length; row++) {
    for (let col = 0; col + w <= occ[0].length; col++) if (free(occ, col, row, w, h)) return { col, row, w, h };
  }
  return null;
}

function sizeIn(dims: GridDims, key: string, cols: number, rows: number): { w: number; h: number } | null {
  const d = dims(key);
  if (!d) return null;
  return { w: clampInt(d.w || 1, 1, cols), h: clampInt(d.h || 1, 1, rows) };
}

/** Where each entry of one page lands: a spot, 'absent' (not on the grid now) or 'over' (no room left). */
function packPage(seq: GridEntry[], dims: GridDims, cols: number, rows: number): { at: Array<Pos | 'absent' | 'over'>; occ: Occupancy } {
  const occ = emptyPage(cols, rows);
  const at = seq.map((e): Pos | 'absent' | 'over' => {
    const size = e === null ? { w: 1, h: 1 } : sizeIn(dims, e, cols, rows);
    if (!size) return 'absent';
    const p = firstFit(occ, size.w, size.h);
    if (!p) return 'over';
    fill(occ, p);
    return p;
  });
  return { at, occ };
}

// ---------------------------------------------------------------- the whole layout

/**
 * Packs every page and tidies the lists: tiles a page has no room for move to the
 * front of the next page (a new one at the end if need be), empty cells after a
 * page's last tile are dropped (they hold nothing in place), and a page left with
 * no tile on it goes. Tiles not on the grid right now stay in the lists.
 */
export function settle(pages: GridPages, dims: GridDims, cols: number, rows: number): { pages: GridPages; slots: GridSlot[] } {
  const packed: Array<{ entries: GridEntry[]; slots: Array<Omit<GridSlot, 'page'>> }> = [];
  let carry: string[] = [];
  for (let i = 0; i < pages.length || carry.length > 0; i++) {
    const seq: GridEntry[] = [...carry, ...(pages[i] ?? [])];
    carry = [];
    const { at } = packPage(seq, dims, cols, rows);
    const entries: GridEntry[] = [];
    const slots: Array<Omit<GridSlot, 'page'>> = [];
    seq.forEach((e, j) => {
      const p = at[j];
      if (p === 'over') {
        if (e !== null) carry.push(e);
        return;
      }
      entries.push(e);
      if (p !== 'absent' && e !== null) slots.push({ key: e, ...p });
    });
    packed.push({ entries, slots });
  }

  const out: GridPages = [];
  const slots: GridSlot[] = [];
  // Absent tiles from a page that went: they join the page before it (or the next one).
  let orphans: string[] = [];
  for (const p of packed) {
    const placed = new Set(p.slots.map((s) => s.key));
    let last = -1;
    p.entries.forEach((e, j) => {
      if (e !== null && placed.has(e)) last = j;
    });
    const entries = p.entries.filter((e, j) => j <= last || e !== null);
    if (!p.slots.length) {
      const absent = entries.filter((e): e is string => e !== null);
      if (out.length) out[out.length - 1].push(...absent);
      else orphans.push(...absent);
      continue;
    }
    for (const s of p.slots) slots.push({ ...s, page: out.length });
    out.push([...orphans, ...entries]);
    orphans = [];
  }
  if (orphans.length) out.push(orphans);
  return { pages: out, slots };
}

/**
 * Lays out a plain list of tiles over as many pages as they need: the order
 * every tile has before the user arranges anything.
 */
export function packGrid(items: GridItem[], cols: number, rows: number): GridSlot[] {
  const dims = new Map(items.map((i) => [i.key, { w: i.w, h: i.h }]));
  return settle([items.map((i) => i.key)], (k) => dims.get(k) ?? null, cols, rows).slots;
}

/**
 * Puts `key` (sized `size`) on `to`, exactly: the tile is lifted out of the
 * lists, then put back on the target page where it lands on that cell. Dropped
 * past the other tiles, empty cells fill the space before it; dropped onto
 * tiles, it goes in front of them and they move on. Empty cells it covers are
 * its own now. A target page one past the last makes a new page.
 *
 * `dims` gives every tile's size as `pages` was laid out (the moved tile's too);
 * `size` is the moved tile's size from now on.
 */
export function moveTile(
  pages: GridPages,
  key: string,
  to: GridCell,
  size: { w: number; h: number },
  dims: GridDims,
  cols: number,
  rows: number,
): { pages: GridPages; slots: GridSlot[] } {
  const w = clampInt(size.w, 1, cols);
  const h = clampInt(size.h, 1, rows);
  const col = clampInt(to.col, 0, cols - w);
  const row = clampInt(to.row, 0, rows - h);
  const sized: GridDims = (k) => (k === key ? { w, h } : dims(k));

  // Put back where it was, the same size: nothing moves. (Lifting it lets the empty
  // cells after it slide into its spot, and dropping onto those would eat them.)
  const now = settle(pages, dims, cols, rows);
  const was = now.slots.find((s) => s.key === key);
  if (was && was.page === to.page && was.col === col && was.row === row && was.w === w && was.h === h) return now;

  const lists = pages.map((p) => p.filter((e) => e !== key));
  const page = clampInt(to.page, 0, lists.length);
  while (lists.length <= page) lists.push([]);
  const list = lists[page];

  const { at } = packPage(list, sized, cols, rows);
  const target = row * cols + col;
  const covers = (p: Pos) => p.col < col + w && col < p.col + p.w && p.row < row + h && row < p.row + p.h;
  const spot = (j: number): Pos | null => {
    const p = at[j];
    return p === 'absent' || p === 'over' ? null : p;
  };
  // Everything placed before the target (and clear of it) stays ahead of the tile.
  let k = list.findIndex((_, j) => {
    const p = spot(j);
    return p !== null && (p.row * cols + p.col >= target || covers(p));
  });
  if (k < 0) k = list.length;
  const head = list.slice(0, k);
  const rest = list.slice(k).filter((e, j) => {
    const p = spot(k + j);
    return !(e === null && p && covers(p));
  });

  // Empty cells until the tile's first fit is the target itself.
  const { occ } = packPage(head, sized, cols, rows);
  const pad: GridEntry[] = [];
  for (;;) {
    const fit = firstFit(occ, w, h);
    if (!fit || fit.row * cols + fit.col >= target) break;
    const cell = firstFit(occ, 1, 1)!;
    fill(occ, cell);
    pad.push(null);
  }
  lists[page] = [...head, ...pad, key, ...rest];
  return settle(lists, sized, cols, rows);
}

/**
 * `pages` with each of `keys` that is not on them yet put in after the key before
 * it in `keys` (its neighbour in the activities' own order), taking up empty
 * cells right behind that neighbour, or at the very end. New and returning tiles
 * show up next to where they belong instead of at a random spot.
 */
export function withNew(pages: GridPages, keys: string[], dims: GridDims): GridPages {
  const out = pages.map((p) => [...p]);
  const where = new Map<string, [number, number]>();
  const index = () => {
    where.clear();
    out.forEach((p, i) => p.forEach((e, j) => e !== null && where.set(e, [i, j])));
  };
  index();
  keys.forEach((key, n) => {
    if (where.has(key)) return;
    const d = dims(key);
    const cells = d ? Math.max(1, d.w * d.h) : 1;
    const insert = (pageIdx: number, at: number) => {
      const list = out[pageIdx];
      let eat = 0;
      while (eat < cells && list[at + eat] === null) eat++;
      list.splice(at, eat, key);
      index();
    };
    for (let m = n - 1; m >= 0; m--) {
      const at = where.get(keys[m]);
      if (at) return insert(at[0], at[1] + 1);
    }
    for (let m = n + 1; m < keys.length; m++) {
      const at = where.get(keys[m]);
      if (at) return insert(at[0], at[1]);
    }
    if (!out.length) out.push([]);
    out[out.length - 1].push(key);
    index();
  });
  return out;
}

/**
 * Which tiles are off the grid. A `hidden` entry names one tile ('sound/sound') or every
 * tile of an activity ('sound'): the first-run setup hides helpers that way, since it
 * cannot know their tile keys.
 */
export function hiddenTest(hidden: string[]): (key: string) => boolean {
  const set = new Set(hidden);
  return (key) => set.has(key) || set.has(key.split('/')[0]);
}

/** `hidden` without whatever hides `key`, so "+" brings a tile back either way it was hidden. */
export function unhide(hidden: string[], key: string): string[] {
  return hidden.filter((k) => k !== key && k !== key.split('/')[0]);
}
