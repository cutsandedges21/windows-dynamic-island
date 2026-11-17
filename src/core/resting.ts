// A Control Center tile the user placed keeps its spot: while its activity has nothing to show,
// a stand-in rests there (its name and icon, dimmed) at the tile's own size, so the grid around it
// does not move when the activity goes quiet or comes back (island.ts gridTiles).

import type { Tile } from './sheet';

/** A tile's own size and kind, from the last time its activity drew it. */
export type TileShape = { span: number; rows: number; kind: string };

const SHAPES_KEY = 'island.grid.shapes';

export function loadShapes(): Record<string, TileShape> {
  try {
    const v = JSON.parse(localStorage.getItem(SHAPES_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function saveShapes(shapes: Record<string, TileShape>): void {
  try {
    localStorage.setItem(SHAPES_KEY, JSON.stringify(shapes));
  } catch {
    /* storage refused: the stand-ins are 1x1 until their tiles show again */
  }
}

/**
 * The stand-in for a placed tile whose activity has nothing to show right now, at the size the
 * tile last had. Kinds that need two columns (`narrow` lists the ones that don't) keep them, so
 * the real tile fits back in the same spot.
 */
export function restingTile(key: string, name: string, icon: string, shape: TileShape | undefined, narrow: ReadonlySet<string>): Tile {
  const span = shape?.span === 2 || (shape && !narrow.has(shape.kind)) ? 2 : 1;
  // Tall ones too (Music's lyrics, 4 rows): the stand-in keeps the spot at the same size.
  const rows = shape?.rows === 4 ? 4 : shape?.rows === 2 ? 2 : 1;
  return { key, span, rows, tone: 'dim', resting: true, body: { k: 'actions', icon, label: name, sub: 'Nothing right now', buttons: [] } };
}
