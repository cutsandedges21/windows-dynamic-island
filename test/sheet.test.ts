// The card's blocks and the island's own elements share one page: their class names must not meet.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISLAND_CLASSES, textClass, wheelTurn, type WheelGesture } from '../src/core/sheet';

describe('card blocks', () => {
  it("a boxed message (a chat's last words, an answer) never takes a class of the island's own elements", () => {
    for (const bubble of [false, true]) {
      const classes = textClass({ t: 'text', key: 'm', text: 'x', bubble }).split(' ');
      for (const c of ISLAND_CLASSES) expect(classes, c).not.toContain(c);
    }
    expect(textClass({ t: 'text', key: 'm', text: 'x', bubble: true }).split(' ')).toContain('boxed');
    // The boxed look is styled under the name the renderer gives it.
    expect(readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8')).toContain('.sb-text.boxed .tx');
  });
});

describe("Control Center's pages", () => {
  const fresh = (): WheelGesture => ({ acc: 0, last: -Infinity, turned: false });
  /** Wheel events `gap` ms apart from `start`; the page steps they turn, added up. */
  const scroll = (g: WheelGesture, deltas: number[], start: number, gap = 16) => deltas.reduce<number>((sum, d, i) => sum + wheelTurn(g, d, start + i * gap), 0);

  it('turns one page per scroll, however many wheel events it sends', () => {
    const g = fresh();
    // A touchpad swipe: forty small events, then its glide slowing down.
    expect(scroll(g, [...Array(40).fill(9), ...Array(30).fill(2)], 0)).toBe(1);
    // After a rest, the next swipe turns the next page (the second page is reachable).
    expect(scroll(g, Array(40).fill(9), 2000)).toBe(1);
    // One notch of a mouse wheel turns one page, back as well.
    expect(scroll(g, [-100], 4000)).toBe(-1);
    // A fast spin, notches 60 ms apart, is one gesture: one page.
    expect(scroll(g, [100, 100, 100, 100], 6000, 60)).toBe(1);
  });

  it('a nudge too small to mean anything turns nothing', () => {
    expect(scroll(fresh(), [5, 6, 4], 0)).toBe(0);
  });
});
