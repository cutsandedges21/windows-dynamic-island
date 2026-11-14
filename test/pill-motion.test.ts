import { describe, expect, it } from 'vitest';
import { GROW_SPRING } from '../src/core/grow';
import { pillMotion, solve, springs } from '../src/core/spring';

describe('the pill opening and closing', () => {
  it('slides its content on the shape’s own spring, so the leading icon never swings against the edge', () => {
    const m = pillMotion(false, true);
    expect(m.content).toBe(m.shell);
    expect(m.shell.damping).toBeGreaterThanOrEqual(1);
    // From the compact pill (edge -77, icon -64 from the centre) to the open one (-288, -270):
    // the icon's distance to the edge only ever grows, from 13 to 18.
    let last = -Infinity;
    for (let t = 0; t <= 1.5; t += 1 / 60) {
      const edge = -288 + solve(-77 + 288, 0, m.shell, t)[0];
      const icon = -270 + solve(-64 + 270, 0, m.content, t)[0];
      expect(icon - edge).toBeGreaterThanOrEqual(last - 1e-9);
      last = icon - edge;
    }
    expect(last).toBeCloseTo(18, 3);
  });

  it('opening from a grown card, grows on that card’s curve, content and shape together', () => {
    const m = pillMotion(false, true, true);
    expect(m.shell).toEqual(GROW_SPRING);
    expect(m.content).toBe(m.shell);
    expect(pillMotion(true, true, true).shell).toBe(springs.travel);
  });

  it('keeps the usual springs otherwise', () => {
    expect(pillMotion(false, false)).toEqual({ shell: springs.shell, content: springs.content });
    expect(pillMotion(true, true)).toEqual({ shell: springs.travel, content: springs.content });
  });
});
