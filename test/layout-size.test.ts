import { describe, expect, it } from 'vitest';
import { LEVELS, levelWidth, normalizeWidths, pillSize, sizeScale } from '../src/core/layout';

// Moss (11-18): on Small, opening the pill made it Medium-sized. Every level follows the Size setting.
describe('the Size setting scales every level', () => {
  const area = { width: 1536, height: 816 };
  const widths = normalizeWidths(null);

  it('a Small pill is narrower than a Medium one at every level, a Large one wider', () => {
    for (const level of LEVELS) {
      const s = levelWidth(area, widths, level, 8, 'small');
      const m = levelWidth(area, widths, level, 8, 'medium');
      const l = levelWidth(area, widths, level, 8, 'large');
      expect(s, level).toBeLessThan(m);
      expect(l, level).toBeGreaterThan(m);
    }
  });

  it('open levels scale by the size factor', () => {
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      const m = levelWidth(area, widths, level, 8, 'medium');
      expect(levelWidth(area, widths, level, 8, 'small')).toBe(Math.round(m * sizeScale('small')));
    }
  });

  it('vertical pills follow it too', () => {
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      const s = pillSize(area, widths, level, 8, 'small', 'vertical');
      const m = pillSize(area, widths, level, 8, 'medium', 'vertical');
      expect(s.main).toBeLessThan(m.main);
      expect(s.cross).toBeLessThan(m.cross);
    }
  });

  it('never wider than the screen, even on Large', () => {
    const wide = normalizeWidths({ compact: 0.5, expanded: 0.7, maximum: 0.9 });
    expect(levelWidth(area, wide, 'maximum', 8, 'large')).toBeLessThanOrEqual(area.width - 16);
  });
});
