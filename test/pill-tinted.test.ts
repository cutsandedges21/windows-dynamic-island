// Pill colour › Tinted: Black and Matte black can be see-through. The switch is kept clean when saved,
// only those two colours wear it, and the taskbar, widgets and border that follow the island take it.

import { describe, expect, it } from 'vitest';
import { applyPill, pillTints } from '../src/core/glass';
import { defaultSettings, migrate } from '../src/core/settings';
import { lookOf } from '../src/core/widgets';

describe('tinted black and matte black', () => {
  it('is off by default, and survives a save and load', () => {
    expect(defaultSettings().island.tinted).toBe(false);
    const s = defaultSettings();
    s.island.color = 'matte-black';
    s.island.tinted = true;
    const back = migrate(JSON.parse(JSON.stringify(s)));
    expect(back.island.color).toBe('matte-black');
    expect(back.island.tinted).toBe(true);
    expect(migrate({ island: { tinted: 'yes' } }).island.tinted).toBe(false);
  });

  it('only Black and Matte black have the switch', () => {
    expect(pillTints('black')).toBe(true);
    expect(pillTints('matte-black')).toBe(true);
    for (const c of ['white', 'matte-white', 'glass', 'tinted', 'custom']) expect(pillTints(c)).toBe(false);
  });

  it('marks the page only when the colour has the switch and it is on', () => {
    // A page root as applyPill uses it (the tests run without a DOM).
    const root = { dataset: {} as DOMStringMap, style: { setProperty: () => {}, removeProperty: () => '' } } as unknown as HTMLElement;
    applyPill(root, 'black', undefined, true);
    expect(root.dataset.pill).toBe('black');
    expect(root.dataset.tinted).toBe('');
    applyPill(root, 'matte-black', undefined, true);
    expect(root.dataset.tinted).toBe('');
    applyPill(root, 'white', undefined, true);
    expect(root.dataset.tinted).toBeUndefined();
    applyPill(root, 'black', undefined, true);
    applyPill(root, 'black', undefined, false);
    expect(root.dataset.tinted).toBeUndefined();
  });

  it('things that follow the island take it; their own colour does not', () => {
    const island = { color: 'black' as const, glass: 10, tint: 60, tinted: true };
    expect(lookOf({ color: 'island', glass: 10, tint: 80 }, island).tinted).toBe(true);
    expect(lookOf({ color: 'black', glass: 10, tint: 80 }, island).tinted).toBeUndefined();
  });
});
