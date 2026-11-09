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

/**
 * What pointing at an activity shows, by how it grows: 'card' grows its own card out of the pill,
 * or else one made from its Control Center tile (`tile`, asked only then); 'below' hangs its own
 * card under the pill; 'wide' widens the pill and hangs its own card under it, unless that card
 * only makes sense grown out of the pill (Music's player), then nothing.
 */
export function hoverView(grows: Grows, own: SheetView | null, tile: () => SheetView | null): SheetView | null {
  if (grows === 'wide') return own?.morph ? null : own;
  if (grows === 'below') return own ? { ...own, morph: undefined } : null;
  if (own) return { ...own, morph: true };
  const made = tile();
  return made ? { ...made, morph: true } : null;
}

/**
 * Claude Code's finished and needs-you cards (keys `claude/done:…`, `claude/note:…`, a held reply
 * `claude/reply:…`) grow out of the pill like its hover card when it grows into a card; its
 * permission and question cards always hang below.
 */
export function chatView(owner: string, grows: Grows, view: SheetView): SheetView {
  if (owner !== 'claude' || grows !== 'card') return view;
  return /^claude\/(done|note|reply):/.test(view.key) ? { ...view, morph: true } : view;
}

/** A phone draws every card under its pill: none grows out of it there. */
export function flatView(view: SheetView): SheetView {
  return { ...view, morph: undefined };
}

/**
 * What the card does with the next view, from what it shows now: grows a new one out of the
 * pill, grows one still on its way back again from where it is, carries a grown one on as an
 * ordinary card (the island opening from it: one motion, no frame of the small pill alone),
 * replaces one at once, or just updates it.
 */
export type HandOff = 'appear' | 'grow' | 'regrow' | 'unmorph' | 'replace' | 'update';

export function handOff(now: { shown: boolean; morph: boolean; closing: boolean }, morph: boolean, instant: boolean): HandOff {
  if (now.shown) {
    if (morph === now.morph) return 'update';
    return now.morph && !instant ? 'unmorph' : 'replace';
  }
  if (!morph) return 'appear';
  return now.closing && !instant ? 'regrow' : 'grow';
}
