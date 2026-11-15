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
 * shape. Nothing inside it moves (sheet.ts placeCarry keeps both contents where they are on screen),
 * so its edges uncover the content it takes on. The edge away from the pill goes at the carry's own
 * pace. The two beside it, where they go outward (the card widening), are there by half way: the
 * new content is all in by then, and at the carry's pace they were still cutting through its outer
 * tiles and the pill bar's end icons while those could be read. Going inward they keep the pace
 * (the content they close over is fading out ahead of them).
 */
export function carryShape(from: Box, to: Box, r: number, side: Side = 'top'): Box {
  const t = Math.max(0, Math.min(1, r));
  const ahead = Math.min(1, t / 0.5);
  const along = side === 'top' || side === 'bottom';
  // An edge and how far it has got: `out` is the way that is outward for it (-1: towards 0).
  const edge = (a: number, b: number, out: number, beside: boolean) => a + (b - a) * (beside && (b - a) * out > 0 ? ahead : t);
  const x = edge(from.x, to.x, -1, along);
  const y = edge(from.y, to.y, -1, !along);
  const right = edge(from.x + from.w, to.x + to.w, 1, along);
  const bottom = edge(from.y + from.h, to.y + to.h, 1, !along);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * How far apart the card and the pill bar are (for carrySplit) `r` of the way through a carry that
 * set off `from` apart. Opening, they part over the whole of it. Joining back, they are one by a
 * little past half way: at the carry's own pace the last of it (the bar's glass giving its part
 * back to the card) took the long tail of the curve, a darker band left across the grown card.
 */
export function carryApart(from: number, way: 'open' | 'back', r: number): number {
  const t = Math.max(0, Math.min(1, r));
  return way === 'open' ? from + (1 - from) * t : from * (1 - Math.min(1, t / 0.6));
}

/** The pill's edges along the way a card hangs from it: its outer one, the one facing the card, and which way the card lies. */
function pillEdges(pill: Box, side: Side): { far: number; near: number; sign: number; depth: number } {
  switch (side) {
    case 'top':
      return { far: pill.y, near: pill.y + pill.h, sign: 1, depth: pill.h };
    case 'bottom':
      return { far: pill.y + pill.h, near: pill.y, sign: -1, depth: pill.h };
    case 'left':
      return { far: pill.x, near: pill.x + pill.w, sign: 1, depth: pill.w };
    case 'right':
      return { far: pill.x + pill.w, near: pill.x, sign: -1, depth: pill.w };
  }
}

/** `box` with its edge on `side` moved to `v`, the opposite edge staying. */
function withEdge(box: Box, side: Side, v: number): Box {
  switch (side) {
    case 'top':
      return { x: box.x, y: v, w: box.w, h: box.y + box.h - v };
    case 'bottom':
      return { x: box.x, y: box.y, w: box.w, h: v - box.y };
    case 'left':
      return { x: v, y: box.y, w: box.x + box.w - v, h: box.h };
    case 'right':
      return { x: box.x, y: box.y, w: v - box.x, h: box.h };
  }
}

/**
 * A grown card splitting into the pill bar and the open island's card, `k` of the way apart (0 =
 * one shape, the grown card; 1 = the two): first the bar's own glass takes over its part of the
 * shape from the card's (`glass`, a cross-fade in place), then a seam opens between the two and
 * their new corners round off (`seam`), and last the light round the pill comes back (`ring`).
 * Joining back is the same at falling `k`.
 */
export function carrySplit(k: number): { glass: number; seam: number; ring: number } {
  return { glass: smooth(k, 0, 0.25), seam: smooth(k, 0.25, 0.8), ring: smooth(k, 0.8, 1) };
}

/**
 * A carried card `k` apart from the pill bar (carrySplit), with `body` its growing shape
 * (carryShape; its edge facing the pill is not used: that edge does not travel). `outer` is the
 * whole shape, from the pill's outer edge: what the content is clipped to and the shadow follows,
 * its outline never stepping. `glass` is the card's own background: the whole shape while the
 * bar's glass takes over the part over the pill (`depth` deep, the card's showing `over` of itself
 * there), then from across the seam (`handed`).
 */
export function carryCard(pill: Box, body: Box, side: Side, gap: number, k: number): { outer: Box; glass: Box; handed: boolean; over: number; depth: number } {
  const e = pillEdges(pill, side);
  const s = carrySplit(k);
  const outer = withEdge(body, side, e.far);
  const handed = s.glass >= 1;
  return { outer, glass: handed ? withEdge(body, side, e.near + e.sign * gap * s.seam) : outer, handed, over: 1 - s.glass, depth: e.depth };
}

/**
 * The part of the pill bar that belongs to the shape while a carried card is `k` apart from it, as
 * the pill's own clip (insets from its box: top, right, bottom, left; a negative one reaches past
 * the box): all of its depth, as wide as the card's `body`. Should the card end up the narrower
 * one, the pill's ends come out over the second half of the way: apart, all of the pill shows.
 */
export function pillSlice(pill: Box, body: Box, side: Side, k: number): { top: number; right: number; bottom: number; left: number } {
  const ease = (v: number) => (v > 0 ? v * (1 - smooth(k, 0.5, 1)) : v);
  if (side === 'top' || side === 'bottom') return { top: 0, right: ease(pill.x + pill.w - (body.x + body.w)), bottom: 0, left: ease(body.x - pill.x) };
  return { top: ease(body.y - pill.y), right: 0, bottom: ease(pill.y + pill.h - (body.y + body.h)), left: 0 };
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
