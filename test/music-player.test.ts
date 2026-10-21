// The music player's pieces that need no screen: the bars' colour from the art, and the times.

import { describe, expect, it } from 'vitest';
import { barColour, vividColour } from '../src/core/artcolor';
import { trackTime } from '../src/core/player';

/** RGBA pixels: `n` of each colour given. */
const pixels = (...runs: Array<[number, [number, number, number]]>) => runs.flatMap(([n, [r, g, b]]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());

describe('bar colour from the art', () => {
  it("takes the art's main vivid colour", () => {
    const [h, s] = vividColour(pixels([100, [255, 120, 40]]))!;
    expect(h).toBeGreaterThan(18);
    expect(h).toBeLessThan(26);
    expect(s).toBeGreaterThan(0.9);
  });

  it('a little vivid colour in a mostly dark picture still wins (a sunset over a black sky)', () => {
    const c = vividColour(pixels([90, [12, 12, 14]], [10, [255, 120, 40]]))!;
    expect(c[0]).toBeGreaterThan(15);
    expect(c[0]).toBeLessThan(30);
  });

  it('grey or black-and-white art has none, and the bars keep the accent', () => {
    expect(vividColour(pixels([60, [30, 30, 30]], [40, [220, 220, 220]]))).toBeNull();
    expect(vividColour([])).toBeNull();
  });

  it('reds either side of 0° stay red', () => {
    const [h] = vividColour(pixels([50, [255, 30, 60]], [50, [255, 60, 30]]))!;
    expect(Math.min(h, 360 - h)).toBeLessThan(12);
  });

  it('light enough to glow on a dark pill, dark enough to read on a light one', () => {
    expect(barColour([20, 0.9, 0.5], false)).toBe('hsl(20 90% 60%)');
    expect(barColour([20, 0.9, 0.5], true)).toBe('hsl(20 90% 42%)');
    expect(barColour([200, 0.2, 0.5], false)).toBe('hsl(200 55% 60%)');
  });
});

describe('player times', () => {
  it('reads like an iPhone: elapsed on the left, a minus and what is left on the right', () => {
    expect(trackTime(36)).toBe('0:36');
    expect(trackTime(95, true)).toBe('−1:35');
    expect(trackTime(3725)).toBe('1:02:05');
    expect(trackTime(-3)).toBe('0:00');
  });
});
