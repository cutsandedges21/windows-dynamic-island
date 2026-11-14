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

/**
 * How far a carried card has slid off the pill (0 → 1) when the carry is `r` of the way: ahead of
 * its size, done by the time the new content is in, so that content arrives where it stays. Slid
 * on the size's own pace, the new content sank some 40 px under a pill bar growing in above it
 * after it was fully there (Justin's recording, 2026-11-14: "still some shaking").
 */
export function slideCurve(r: number): number {
  const q = Math.max(0, Math.min(1, r / 0.6));
  return 1 - (1 - q) * (1 - q);
}

const smooth = (r: number, a: number, b: number): number => {
  const u = Math.max(0, Math.min(1, (r - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/**
 * A grown card carried on into the open island's card (or back), `r` of the way: the opacity of
 * the content it had (`old`), of the content it takes on (`new`) and of the pill's own content
 * (`pill`), all locked to how far the shape got. The old fades a little ahead of the new, so the
 * two are never both more than half there, and close enough behind it that the card is never
 * empty (together never under 0.8); the pill's content comes back over the last part, once the
 * card has slid off it. Played backwards (into a grown card) it is the same at 1 − r.
 */
export function carryFades(r: number): { old: number; new: number; pill: number; glass: number } {
  // The pill's glass (its dark shape) comes back a little before its content, and only once the card
  // has started sliding off it: drawn at once, it showed through the glass card as a pale bar on the
  // click frame (Justin's real-screen test, 2026-11-14).
  // The bar's glass and its content come back close together: the glass on its own read as an empty
  // bar popping in above the card for a frame or two.
  return { old: 1 - smooth(r, 0, 0.42), new: smooth(r, 0.05, 0.47), pill: smooth(r, 0.4, 0.85), glass: smooth(r, 0.35, 0.7) };
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

/**
 * Carried back into a grown card, `r` of the way: the pill's content and its glass go before the card
 * slides up over them (slideCurve), so neither shows through or over it. Played as the opening's
 * mirror, the pill stayed till the card had covered it and the card crept up after its content was in.
 */
export function uncarryPill(r: number): { pill: number; glass: number } {
  return { pill: 1 - smooth(r, 0, 0.35), glass: 1 - smooth(r, 0.05, 0.4) };
}
