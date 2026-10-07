// Where the open island's tiles sit. Tiles are boxes of whole cells laid out
// in order, left to right then down; each one takes the first space it fits,
// so a small tile backfills a gap a big one left behind. When a page is full
// the rest go to the next page, like a second shelf.
//
// Moving a tile is "put this one here"; everything else re-packs around it.
// Resizing is the same thing with a bigger box. Both are just a change to the
// order or to one tile's size, followed by a fresh pack: no stored positions
// to go stale. Pure data, no DOM.

import type { TileSize } from './settings';

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

export const CELLS: Record<TileSize, { w: number; h: number }> = {
  '1x1': { w: 1, h: 1 },
  '2x1': { w: 2, h: 1 },
  '1x2': { w: 1, h: 2 },
  '2x2': { w: 2, h: 2 },
};

export function sizeOf(w: number, h: number): TileSize {
  return `${Math.min(2, Math.max(1, w))}x${Math.min(2, Math.max(1, h))}` as TileSize;
}

type Page = boolean[][];

function emptyPage(cols: number, rows: number): Page {
  return Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
}

function free(page: Page, col: number, row: number, w: number, h: number): boolean {
  if (col + w > page[0].length || row + h > page.length) return false;
  for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (page[r][c]) return false;
  return true;
}

function fill(page: Page, col: number, row: number, w: number, h: number): void {
  for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) page[r][c] = true;
}

/** Lays `items` out in order over as many pages as they need. */
export function packGrid(items: GridItem[], cols: number, rows: number): GridSlot[] {
  const pages: Page[] = [];
  const out: GridSlot[] = [];
  for (const item of items) {
    const w = Math.max(1, Math.min(cols, Math.round(item.w) || 1));
    const h = Math.max(1, Math.min(rows, Math.round(item.h) || 1));
    let placed = false;
    for (let p = 0; p < pages.length && !placed; p++) {
      for (let row = 0; row <= rows - h && !placed; row++) {
        for (let col = 0; col <= cols - w && !placed; col++) {
          if (!free(pages[p], col, row, w, h)) continue;
          fill(pages[p], col, row, w, h);
          out.push({ key: item.key, w, h, page: p, col, row });
          placed = true;
        }
      }
    }
    if (!placed) {
      const page = emptyPage(cols, rows);
      fill(page, 0, 0, w, h);
      pages.push(page);
      out.push({ key: item.key, w, h, page: pages.length - 1, col: 0, row: 0 });
    }
  }
  return out;
}

export function pageCount(slots: GridSlot[]): number {
  return slots.reduce((n, s) => Math.max(n, s.page + 1), 1);
}

/** Reading order: page, then row, then column. */
function rank(page: number, row: number, col: number): number {
  return page * 1e6 + row * 1e3 + col;
}

/**
 * Dropping `dragKey` on a cell: which tile it should land in front of
 * (null means last). Landing on another tile takes that tile's place and
 * pushes it along; landing on empty space puts it after whatever comes before.
 */
export function dropBefore(slots: GridSlot[], order: string[], dragKey: string, page: number, col: number, row: number): string | null {
  const after = (key: string): string | null => {
    const i = order.indexOf(key);
    return i < 0 || i + 1 >= order.length ? null : order[i + 1];
  };
  const hit = slots.find((s) => s.page === page && col >= s.col && col < s.col + s.w && row >= s.row && row < s.row + s.h);
  if (hit?.key === dragKey) return after(dragKey) ?? null;
  if (hit) {
    // Moving it forward means taking the target's place, so it goes in front of it;
    // moving it back, it goes behind the target.
    const from = order.indexOf(dragKey);
    const to = order.indexOf(hit.key);
    return from >= 0 && from < to ? after(hit.key) : hit.key;
  }
  const target = rank(page, row, col);
  let best: GridSlot | null = null;
  for (const s of slots) {
    if (s.key === dragKey) continue;
    const r = rank(s.page, s.row, s.col);
    if (r < target && (!best || r > rank(best.page, best.row, best.col))) best = s;
  }
  return best ? after(best.key) : (order.find((k) => k !== dragKey) ?? null);
}

/** `order` with `key` moved in front of `before` (or to the end). */
export function moveBefore(order: string[], key: string, before: string | null): string[] {
  if (key === before || !order.includes(key)) return order;
  const next = order.filter((k) => k !== key);
  const at = before === null ? next.length : next.indexOf(before);
  next.splice(at < 0 ? next.length : at, 0, key);
  return next;
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
