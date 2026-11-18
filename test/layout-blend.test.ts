// Blend into the edge (Settings › Appearance): the pill sits on its screen edge, flat along it.

import { describe, expect, it } from 'vitest';
import { blendLabel, edgeCorners, opposite, pillGap, pillRect, seamCorners, type Anchor } from '../src/core/layout';
import { defaultSettings, migrate } from '../src/core/settings';

const area = { width: 1920, height: 1040 };

describe('Blend into the edge', () => {
  it('is off by default: the pill floats, as the taskbar does', () => {
    expect(defaultSettings().island.blend).toBe(false);
    expect(defaultSettings().island.taskbar.edge).toBe(false);
  });

  it('keeps a saved choice and drops anything that is not one', () => {
    expect(migrate({ island: { blend: true } }).island.blend).toBe(true);
    expect(migrate({ island: { blend: 'yes' } }).island.blend).toBe(false);
    expect(migrate({ island: {} }).island.blend).toBe(false);
  });

  it('puts the pill on its edge, with no gap, whatever the Distance setting', () => {
    expect(pillGap(8, false)).toBe(8);
    expect(pillGap(8, true)).toBe(0);
    expect(pillRect(area, 'top', 200, 36, pillGap(8, true)).y).toBe(0);
    expect(pillRect(area, 'bottom', 200, 36, pillGap(8, true)).y).toBe(area.height - 36);
    expect(pillRect(area, 'left', 36, 200, pillGap(8, true)).x).toBe(0);
    expect(pillRect(area, 'right', 36, 200, pillGap(8, true)).x).toBe(area.width - 36);
  });

  it('squares the two corners on the edge and keeps the others round', () => {
    // CSS order: top left, top right, bottom right, bottom left.
    expect(edgeCorners('top', 18)).toBe('0px 0px 18px 18px');
    expect(edgeCorners('bottom', 18)).toBe('18px 18px 0px 0px');
    expect(edgeCorners('left', 18)).toBe('0px 18px 18px 0px');
    expect(edgeCorners('right', 18)).toBe('18px 0px 0px 18px');
  });

  it('can round the edge corners part way (a card sliding off the pill)', () => {
    expect(edgeCorners('top', 24, 12)).toBe('12px 12px 24px 24px');
  });

  it('makes a card hanging from the pill one shape with it', () => {
    const pill = { x: 100, y: 0, w: 300, h: 40 };
    // The open island: bar and card as wide as each other, both square along the seam.
    const card = { x: 100, y: 40, w: 300, h: 400 };
    expect(seamCorners(opposite('top'), pill, card, 20, 0)).toBe('0px 0px 0px 0px');
    expect(seamCorners('top', card, pill, 24, 24)).toBe('0px 0px 24px 24px');
    // A card wider than the pill: the pill's seam corners square, the card's that reach past it round.
    const wide = { x: 80, y: 40, w: 340, h: 200 };
    expect(seamCorners('bottom', pill, wide, 20, 0)).toBe('0px 0px 0px 0px');
    expect(seamCorners('top', wide, pill, 24, 24)).toBe('24px 24px 24px 24px');
    // Part of the way in: the covered corners on their way to square.
    expect(seamCorners('bottom', pill, card, 20, 0, 0.5)).toBe('0px 0px 10px 10px');
    expect(seamCorners('bottom', pill, card, 20, 0, 0)).toBe('0px 0px 20px 20px');
  });

  it('joins on any edge', () => {
    const pill = { x: 0, y: 100, w: 40, h: 300 };
    const card = { x: 40, y: 100, w: 300, h: 300 };
    expect(seamCorners('right', pill, card, 20, 0)).toBe('0px 0px 0px 0px');
    expect(seamCorners('left', card, pill, 24, 24)).toBe('0px 24px 24px 0px');
    const bar = { x: 100, y: 960, w: 300, h: 40 };
    const above = { x: 120, y: 560, w: 260, h: 400 };
    // The card narrower than the bar: the bar's seam corners stay round, the card's square.
    expect(seamCorners('top', bar, above, 20, 0)).toBe('20px 20px 0px 0px');
    expect(seamCorners('bottom', above, bar, 24, 24)).toBe('24px 24px 0px 0px');
    expect(opposite('left')).toBe('right');
  });

  it('is named after the edge the pill is on', () => {
    const names: Record<Anchor, string> = {
      top: 'Blend into the top',
      bottom: 'Blend into the bottom',
      left: 'Blend into the left edge',
      right: 'Blend into the right edge',
    };
    for (const a of Object.keys(names) as Anchor[]) expect(blendLabel(a)).toBe(names[a]);
  });
});
