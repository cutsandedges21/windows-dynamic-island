// Control Center arranged from a phone: hold a tile there, reorder, take tiles off and put them
// back, then Save sends the whole layout ({ t: 'grid-set' }). The island takes it only with tiles
// it showed that phone (on the grid or in the tray): a phone arranges, it can't name tiles of its own.

import type { SheetView, Tile } from '../core/sheet';

/** The phone's working copy: tiles on the grid in reading order, and the ones taken off. */
export interface PhoneLayout {
  order: string[];
  hidden: string[];
}

/** Most tiles a layout from a phone may name. */
export const MAX_GRID_KEYS = 64;

/** The grid's tiles and tray in a view (the phone's Control Center); empty for any other card. */
export function gridTiles(view: SheetView | null): { items: Tile[]; tray: Tile[] } {
  const b = view?.blocks.find((x) => x.t === 'tiles' && x.key === 'grid');
  return b && b.t === 'tiles' ? { items: b.items, tray: b.tray ?? [] } : { items: [], tray: [] };
}

/** The layout a phone starts editing from: what the view shows. */
export function layoutOf(view: SheetView | null): PhoneLayout {
  const { items, tray } = gridTiles(view);
  const sorted = [...items].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.row ?? 0) - (b.row ?? 0) || (a.col ?? 0) - (b.col ?? 0));
  return { order: sorted.map((t) => t.key), hidden: tray.map((t) => t.key) };
}

/** `key` moved to `to` in the order (clamped); unknown keys change nothing. */
export function moveKey(l: PhoneLayout, key: string, to: number): PhoneLayout {
  const from = l.order.indexOf(key);
  if (from < 0) return l;
  const order = l.order.filter((k) => k !== key);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, key);
  return { ...l, order };
}

/** Taken off the grid, into the tray. */
export function removeKey(l: PhoneLayout, key: string): PhoneLayout {
  if (!l.order.includes(key)) return l;
  return { order: l.order.filter((k) => k !== key), hidden: [...l.hidden.filter((k) => k !== key), key] };
}

/** Back on the grid from the tray, at the end. */
export function addKey(l: PhoneLayout, key: string): PhoneLayout {
  if (!l.hidden.includes(key)) return l;
  return { order: [...l.order.filter((k) => k !== key), key], hidden: l.hidden.filter((k) => k !== key) };
}

/** Every tile key a phone was shown on the grid or in the tray: the only ones it may arrange. */
export function shownGridKeys(view: SheetView | null): Set<string> {
  const { items, tray } = gridTiles(view);
  return new Set([...items, ...tray].map((t) => t.key));
}

/**
 * Whether a layout from a phone may be saved: each tile it names was shown to it, none twice,
 * and nothing shown is left out (a tile is on the grid or in the tray, never dropped).
 */
export function gridSetAllowed(shown: ReadonlySet<string>, l: PhoneLayout): boolean {
  const all = [...l.order, ...l.hidden];
  if (!shown.size || all.length !== shown.size || new Set(all).size !== all.length) return false;
  return all.every((k) => shown.has(k));
}

/** The view without its tray: hidden tiles are shown to arrange, never to press. */
export function withoutTray(view: SheetView | null): SheetView | null {
  if (!view) return view;
  return { ...view, blocks: view.blocks.map((b) => (b.t === 'tiles' && b.tray ? { ...b, tray: [] } : b)) };
}
