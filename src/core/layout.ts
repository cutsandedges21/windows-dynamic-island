// Island geometry. One function set serves all four positions: the anchor picks
// the fixed point and the expansion vector, widths are fractions of the usable
// display width, and text never rotates.

export type Anchor = 'top' | 'bottom' | 'left' | 'right';
export type Level = 'idle' | 'compact' | 'expanded' | 'maximum';

export interface Area {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Widths {
  compact: number;
  expanded: number;
  maximum: number;
}

export const DEFAULT_WIDTHS: Widths = { compact: 0.12, expanded: 0.26, maximum: 0.45 };
export const WIDTH_LIMITS = { min: 0.06, max: 0.9 };

export const LEVELS: Level[] = ['idle', 'compact', 'expanded', 'maximum'];

/** Pill heights in CSS px per level, for the "medium" size. Corners are always height / 2. */
const BASE_HEIGHTS: Record<Level, number> = { idle: 24, compact: 36, expanded: 42, maximum: 50 };
const SIZE_SCALE = { small: 0.88, medium: 1, large: 1.14 } as const;
export type IslandSize = keyof typeof SIZE_SCALE;

/** Narrowest a level may get whatever the percentage, so content stays usable. */
const MIN_WIDTHS: Record<Level, number> = { idle: 64, compact: 150, expanded: 300, maximum: 420 };

export function heightFor(level: Level, size: IslandSize = 'medium'): number {
  return Math.round(BASE_HEIGHTS[level] * SIZE_SCALE[size]);
}

/** Widths stay ordered (compact < expanded < maximum) and inside the limits. */
export function normalizeWidths(w: Partial<Widths> | null | undefined): Widths {
  const clamp = (v: unknown, d: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
    return Math.min(WIDTH_LIMITS.max, Math.max(WIDTH_LIMITS.min, n));
  };
  const compact = clamp(w?.compact, DEFAULT_WIDTHS.compact);
  const expanded = Math.max(compact + 0.02, clamp(w?.expanded, DEFAULT_WIDTHS.expanded));
  const maximum = Math.max(expanded + 0.02, clamp(w?.maximum, DEFAULT_WIDTHS.maximum));
  return { compact, expanded: Math.min(expanded, WIDTH_LIMITS.max), maximum: Math.min(maximum, WIDTH_LIMITS.max) };
}

/** Width of the pill at a level, in CSS px, for this display's usable area. */
export function levelWidth(area: Area, widths: Widths, level: Level, edge: number, size: IslandSize = 'medium'): number {
  const usable = Math.max(80, area.width - edge * 2);
  if (level === 'idle') {
    const compact = Math.min(usable, Math.max(MIN_WIDTHS.compact, area.width * widths.compact));
    return Math.round(Math.min(compact, Math.max(MIN_WIDTHS.idle, compact * 0.42)) * SIZE_SCALE[size]);
  }
  const want = area.width * widths[level];
  return Math.round(Math.min(usable, Math.max(MIN_WIDTHS[level] * SIZE_SCALE[size], want)));
}

/** Which way the pill grows from its fixed point. */
export function expansionVector(anchor: Anchor): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  switch (anchor) {
    case 'top':
      return { x: 0, y: 1 };
    case 'bottom':
      return { x: 0, y: -1 };
    case 'left':
      return { x: 1, y: 0 };
    case 'right':
      return { x: -1, y: 0 };
  }
}

/** The pill's rectangle: pinned to its edge, centred along it. */
export function pillRect(area: Area, anchor: Anchor, w: number, h: number, edge: number): Rect {
  switch (anchor) {
    case 'top':
      return { x: (area.width - w) / 2, y: edge, w, h };
    case 'bottom':
      return { x: (area.width - w) / 2, y: area.height - edge - h, w, h };
    case 'left':
      return { x: edge, y: (area.height - h) / 2, w, h };
    case 'right':
      return { x: area.width - edge - w, y: (area.height - h) / 2, w, h };
  }
}

/** Where the pill rests when hidden: tucked against its edge, a sliver wide. */
export function tuckedRect(area: Area, anchor: Anchor, w: number, h: number): Rect {
  const r = pillRect(area, anchor, w, h, 0);
  switch (anchor) {
    case 'top':
      return { ...r, y: -h - 4 };
    case 'bottom':
      return { ...r, y: area.height + 4 };
    case 'left':
      return { ...r, x: -w - 4 };
    case 'right':
      return { ...r, x: area.width + 4 };
  }
}

// ------------------------------------------------------------------ the bot's bubble

/** Space between the bubble and the pill, CSS px. */
export const BUBBLE_GAP = 6;

/** The bubble is as tall as the compact pill, whatever the pill is doing. */
export function bubbleSize(size: IslandSize): number {
  return heightFor('compact', size);
}

/**
 * The bubble beside the pill: to its left on the top and bottom edges, above it on the
 * sides, lined up with the screen edge the pill is pinned to.
 */
export function bubbleRect(pill: Rect, anchor: Anchor, d: number): Rect {
  switch (anchor) {
    case 'top':
      return { x: pill.x - BUBBLE_GAP - d, y: pill.y, w: d, h: d };
    case 'bottom':
      return { x: pill.x - BUBBLE_GAP - d, y: pill.y + pill.h - d, w: d, h: d };
    case 'left':
      return { x: pill.x, y: pill.y - BUBBLE_GAP - d, w: d, h: d };
    case 'right':
      return { x: pill.x + pill.w - d, y: pill.y - BUBBLE_GAP - d, w: d, h: d };
  }
}

// ------------------------------------------------------------------ the bot's chat bar

/** Height of the thin bar you type to the bot in, CSS px. */
export const CHAT_BAR_H = 28;
/** On a side edge the bar reaches this far inward from beside the bot. */
const CHAT_SIDE_W = 300;

/**
 * The chat bar (Moss's option A): on the top and bottom edges it runs from the bot's left
 * edge to the pill's right edge, just past both; on the sides it reaches inward from beside
 * the bot. The island itself never opens for it.
 */
export function chatBarRect(anchor: Anchor, bot: Rect, pill: Rect): Rect {
  const h = CHAT_BAR_H;
  switch (anchor) {
    case 'top':
      return { x: bot.x, y: Math.max(bot.y + bot.h, pill.y + pill.h) + BUBBLE_GAP, w: pill.x + pill.w - bot.x, h };
    case 'bottom':
      return { x: bot.x, y: Math.min(bot.y, pill.y) - BUBBLE_GAP - h, w: pill.x + pill.w - bot.x, h };
    case 'left':
      return { x: bot.x + bot.w + BUBBLE_GAP, y: bot.y + (bot.h - h) / 2, w: CHAT_SIDE_W, h };
    case 'right':
      return { x: bot.x - BUBBLE_GAP - CHAT_SIDE_W, y: bot.y + (bot.h - h) / 2, w: CHAT_SIDE_W, h };
  }
}

/** The card with the bot's answer: the bar's width, past the bar (above it on the bottom edge). */
export function chatCardRect(anchor: Anchor, bar: Rect, h: number): Rect {
  return anchor === 'bottom' ? { x: bar.x, y: bar.y - BUBBLE_GAP - h, w: bar.w, h } : { x: bar.x, y: bar.y + bar.h + BUBBLE_GAP, w: bar.w, h };
}

/**
 * The point that stays fixed while the pill changes size, in pill-local
 * coordinates: the centre for top and bottom, the pinned edge for the sides.
 * Content is laid out relative to it, so growth reveals rather than shoves.
 */
export function fixedPointX(anchor: Anchor, w: number): number {
  if (anchor === 'left') return 0;
  if (anchor === 'right') return w;
  return w / 2;
}

/** Horizontal padding inside the pill: the round ends need breathing room. */
export function innerPadding(h: number): number {
  return Math.round(h * 0.36);
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ------------------------------------------------------------------ orientation
//
// Top and bottom pills are horizontal. Left and right pills stand vertical: their
// length runs along the edge (the same level percentages, applied to the work
// area's height) and their thickness grows inward with the level. Text stays
// upright either way; content stacks top to bottom.

export type Orientation = 'horizontal' | 'vertical';

export function orientationFor(anchor: Anchor): Orientation {
  return anchor === 'left' || anchor === 'right' ? 'vertical' : 'horizontal';
}

/** Vertical pills: thickness per level (CSS px, medium size). */
const V_THICKNESS: Record<Level, number> = { idle: 24, compact: 40, expanded: 54, maximum: 72 };
const V_MIN_LENGTH: Record<Level, number> = { idle: 64, compact: 110, expanded: 200, maximum: 300 };

export interface PillSize {
  w: number;
  h: number;
  /** Length along the long axis. */
  main: number;
  /** Thickness across it. */
  cross: number;
}

export function pillSize(area: Area, widths: Widths, level: Level, edge: number, size: IslandSize, orientation: Orientation): PillSize {
  if (orientation === 'horizontal') {
    const main = levelWidth(area, widths, level, edge, size);
    const cross = heightFor(level, size);
    return { w: main, h: cross, main, cross };
  }
  const s = SIZE_SCALE[size];
  const usable = Math.max(80, area.height - edge * 2);
  const cross = Math.round(V_THICKNESS[level] * s);
  let main: number;
  if (level === 'idle') {
    const compact = Math.min(usable, Math.max(V_MIN_LENGTH.compact, area.height * widths.compact));
    main = Math.round(Math.min(compact, Math.max(V_MIN_LENGTH.idle, compact * 0.42)) * s);
  } else {
    main = Math.round(Math.min(usable, Math.max(V_MIN_LENGTH[level] * s, area.height * widths[level])));
  }
  return { w: cross, h: main, main, cross };
}

/** Pill-local point content is laid out from (see fixedPointX). */
export function contentOrigin(anchor: Anchor, orientation: Orientation, w: number, h: number): { x: number; y: number } {
  return orientation === 'vertical' ? { x: w / 2, y: h / 2 } : { x: fixedPointX(anchor, w), y: h / 2 };
}
