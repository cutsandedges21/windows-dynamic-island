// How a card grows out of the pill and goes back into it (sheet.ts), and which card pointing at
// an activity shows, by its Grows choice (island.ts). No DOM in here, so it is covered by plain vitest.

import type { Grows } from './settings';
import type { SheetView } from './sheet';

/** How long a card takes to grow out of the pill, and to close back into it. */
export const GROW_MS = 340;

/** A grown card's size changes after that (new content, a wider view): critically damped, no overshoot. */
export const GROW_SPRING = { response: 0.4, damping: 1 };

/**
 * The grown card's move, 0 → 1 over u = 0 → 1: a critically damped spring's own curve
 * (GROW_SPRING) cut off at GROW_MS and stretched to land exactly on 1. It springs out fast and
 * eases into place, and stops: no tail creeping the last pixel, no overshoot settling back.
 */
export function growCurve(u: number): number {
  const T = GROW_MS / 1000;
  const omega = (2 * Math.PI) / GROW_SPRING.response;
  const f = (t: number) => 1 - (1 + omega * t) * Math.exp(-omega * t);
  return f(Math.max(0, Math.min(1, u)) * T) / f(T);
}

/**
 * The close is the grow played backwards: it starts gently, speeds up into the pill and lands
 * there. A spring back would ease in too, and creep the last pixels into the pill.
 */
export function closeCurve(u: number): number {
  return 1 - growCurve(1 - u);
}

/** A card's shape on its way: width, height and how far it stands over the pill (m, see sheet.ts). */
export interface Shape {
  w: number;
  h: number;
  m: number;
}

/** The shape `r` of the way (0 → 1, already on the curve) from `from` to `to`. */
export function tweenShape(from: Shape, to: Shape, r: number): Shape {
  return { w: from.w + (to.w - from.w) * r, h: from.h + (to.h - from.h) * r, m: from.m + (to.m - from.m) * r };
}

/**
 * How far along a tween is, 0 → 1, `u` of its time in (0 → 1). One started while a grow was `s`
 * of its time in carries that grow's curve on from where it got to (no stop and restart at the
 * click), stretched over its own full time.
 */
export function carryCurve(u: number, s = 0): number {
  const from = Math.max(0, Math.min(0.6, s));
  const q0 = growCurve(from);
  return (growCurve(from + (1 - from) * Math.max(0, Math.min(1, u))) - q0) / (1 - q0);
}

const smooth = (r: number, a: number, b: number): number => {
  const u = Math.max(0, Math.min(1, (r - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** A rectangle on screen. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The screen edge the island sits on, which is also the side of a card that faces the pill. */
export type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * A carried card (a grown card turning into the open island's card, or back) `r` of the way: its
 * shape. All four edges go at the one pace, so they set off together and land together; nothing
 * inside it moves (sheet.ts placeCarry keeps both contents where they are on screen).
 */
export function carryShape(from: Box, to: Box, r: number): Box {
  const t = Math.max(0, Math.min(1, r));
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;
  const right = from.x + from.w + (to.x + to.w - from.x - from.w) * t;
  const bottom = from.y + from.h + (to.y + to.h - from.y - from.h) * t;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * How far a carried card stands off the pill, 0 (over it: one shape) → 1 (beside it, across the
 * gap), from where its edge facing the pill is. `reach` is how far that edge travels: the pill's
 * depth plus the gap.
 */
export function carryApart(pill: Box, card: Box, side: Side, gap: number): number {
  const depth = side === 'top' || side === 'bottom' ? pill.h : pill.w;
  const moved = side === 'top' ? card.y - pill.y : side === 'bottom' ? pill.y + pill.h - (card.y + card.h) : side === 'left' ? card.x - pill.x : pill.x + pill.w - (card.x + card.w);
  return Math.max(0, Math.min(1, moved / Math.max(1, depth + gap)));
}

/**
 * The part of the pill a carried card has uncovered, as the pill's own clip (insets from its box,
 * top right bottom left; a negative one reaches past the box): from its outer edge to a seam just
 * short of the card, as wide as the card. The seam opens from nothing to the full gap over the first
 * third of the way, so the one shape splits in two along a line that widens: the outline of the
 * whole never steps. Null when none of the pill shows yet.
 */
export function pillReveal(pill: Box, card: Box, side: Side, gap: number): { top: number; right: number; bottom: number; left: number } | null {
  const apart = carryApart(pill, card, side, gap);
  const seam = gap * smooth(apart, 0, 0.35);
  const along = side === 'top' || side === 'bottom';
  // Across the pill: as wide as the card (past the pill's own ends once the card is wider than it).
  // Should the card end up the narrower one, the pill's ends come out over the second half of the
  // way: apart, all of the pill shows.
  const ease = (v: number) => (v > 0 ? v * (1 - smooth(apart, 0.5, 1)) : v);
  const a0 = ease(along ? card.x - pill.x : card.y - pill.y);
  const a1 = ease(along ? pill.x + pill.w - (card.x + card.w) : pill.y + pill.h - (card.y + card.h));
  // Along the way the card goes: from the pill's outer edge to the seam.
  const depth = along ? pill.h : pill.w;
  const shown = side === 'top' ? card.y - seam - pill.y : side === 'bottom' ? pill.y + pill.h - (card.y + card.h + seam) : side === 'left' ? card.x - seam - pill.x : pill.x + pill.w - (card.x + card.w + seam);
  if (shown <= 0.01) return null;
  const cut = Math.max(0, depth - shown);
  switch (side) {
    case 'top':
      return { top: 0, right: a1, bottom: cut, left: a0 };
    case 'bottom':
      return { top: cut, right: a1, bottom: 0, left: a0 };
    case 'left':
      return { top: a0, right: cut, bottom: a1, left: 0 };
    case 'right':
      return { top: a0, right: 0, bottom: a1, left: cut };
  }
}

/**
 * A carried card `r` of the way: the opacity of the content it had (`old`) and of the content it
 * takes on (`new`), locked to how far the shape got. The old fades a little ahead of the new, so the
 * two are never both more than half there, and close enough behind it that the card is never empty
 * (together never under 0.8).
 */
export function carryFades(r: number): { old: number; new: number } {
  return { old: 1 - smooth(r, 0, 0.42), new: smooth(r, 0.05, 0.47) };
}

/**
 * The pill's own content and the light round it while a carried card stands `apart` (carryApart)
 * from it: the content fades in as the seam uncovers it (and out as the card comes back over it),
 * the light only once the pill is all but whole.
 */
export function pillFades(apart: number): { content: number; ring: number } {
  return { content: smooth(apart, 0.3, 0.7), ring: smooth(apart, 0.8, 1) };
}

/**
 * What pointing at an activity shows, by how it grows: 'card' grows its own card out of the pill,
 * or else one made from its Control Center tile (`tile`, asked only then); 'more' (Claude's) grows
 * its own card too, the card itself carrying the button that opens the rest; 'below' hangs its own
 * card under the pill; 'wide' widens the pill and hangs its own card under it, unless that card
 * only makes sense grown out of the pill (Music's player), then nothing.
 */
export function hoverView(grows: Grows, own: SheetView | null, tile: () => SheetView | null): SheetView | null {
  if (grows === 'wide') return own?.morph ? null : own;
  if (grows === 'below') return own ? { ...own, morph: undefined } : null;
  if (grows === 'more') return own ? { ...own, morph: true } : null;
  if (own) return { ...own, morph: true };
  const made = tile();
  return made ? { ...made, morph: true } : null;
}

/**
 * How `id` grows when pointed at, from its Grows (`grows`) and its options. Music with "Player on
 * hover" off has no player to grow into, so the pill widens (Sideways) rather than growing its
 * tile's card; with it on, its Grows stands.
 */
export function hoverGrows(id: string, grows: Grows, options: Record<string, unknown> | undefined): Grows {
  return id === 'music' && options?.hoverPlayer === false ? 'wide' : grows;
}

/**
 * Claude's pop-ups grow out of the pill like its hover card when it grows into a card (Into a card,
 * or Card with more): a finished chat (`claude/done:…`), one that needs you (`claude/note:…`),
 * a held reply (`claude/reply:…`) and the sessions card a Claude app or Chrome
 * chat raises (`claude/status`). Its permission and question cards (`claude/perm:…`, `claude/ask:…`)
 * always hang below.
 */
export function chatView(owner: string, grows: Grows, view: SheetView): SheetView {
  if ((grows !== 'card' && grows !== 'more') || owner !== 'claude') return view;
  return /^claude\/(perm|ask):/.test(view.key) ? view : { ...view, morph: true };
}

/** A phone draws every card under its pill: none grows out of it there. */
export function flatView(view: SheetView): SheetView {
  return { ...view, morph: undefined };
}

/**
 * What the card does with the next view, from what it shows now: grows a new one out of the
 * pill, grows one still on its way back again from where it is, carries a grown one on as an
 * ordinary card (the island opening from it: one motion, no frame of the small pill alone),
 * carries an ordinary one on back into a grown one (the island closing with the pointer on the
 * pill), replaces one at once (no motion wanted), or just updates it.
 */
export type HandOff = 'appear' | 'grow' | 'regrow' | 'unmorph' | 'remorph' | 'replace' | 'update';

export function handOff(now: { shown: boolean; morph: boolean; closing: boolean }, morph: boolean, instant: boolean): HandOff {
  if (now.shown) {
    if (morph === now.morph) return 'update';
    if (instant) return 'replace';
    return now.morph ? 'unmorph' : 'remorph';
  }
  if (!morph) return 'appear';
  return now.closing && !instant ? 'regrow' : 'grow';
}

/**
 * Rounds to whole device pixels. Spring noise is dropped first (to a thousandth of a pixel): a spot
 * that sits on a half device pixel (a centred card at 125%) would otherwise round one way on one
 * frame and the other way on the next.
 */
function devicePixels(scale: number): (v: number) => number {
  return (v) => Math.round(Math.round(v * scale * 1000) / 1000) / scale;
}

/**
 * A card's box at `x`, `w` wide, on whole device pixels (`scale` of them per CSS px): each edge
 * rounded on its own, so as the card widens each edge only ever moves outward. Rounding the left
 * edge and the width apart let the right edge step back and forth by part of a pixel.
 */
export function snapSpan(x: number, w: number, scale: number): { x: number; w: number } {
  const snap = devicePixels(scale);
  const left = snap(x);
  return { x: left, w: snap(x + w) - left };
}

/**
 * Where content `innerW` wide sits inside that box (from its left edge), centred on the card's
 * unrounded centre and on a whole device pixel of its own: the card's rounding changes from frame
 * to frame as it widens, the content's spot does not (no half-pixel wobble of the text).
 */
export function contentLeft(x: number, w: number, innerW: number, scale: number): number {
  const snap = devicePixels(scale);
  return snap(x + w / 2 - innerW / 2) - snap(x);
}
