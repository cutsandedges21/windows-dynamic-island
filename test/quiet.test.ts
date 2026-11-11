// Quiet's moon: while Quiet (do not disturb) is on, a small moon sits at the end of the pill,
// on the pills that show what is going on, and goes as soon as Quiet is off.

import { describe, expect, it } from 'vitest';
import { innerPadding, normalizeWidths, pillSize, type Level, type Orientation } from '../src/core/layout';
import { moonShows, quietMoon } from '../src/core/quiet';
import { fitSegments, fitVertical, type Measure, type Seg } from '../src/core/segments';
import { defaultSettings, migrate } from '../src/core/settings';

/** Fixed text widths, so the fit doesn't depend on fonts. */
const measure: Measure = (text) => text.length * 7;

/** The pill's views (island.ts viewKey): the ones that show what is going on, and the short-lived rest. */
const SHOWN = ['act:music', 'act:claude', 'idle', 'chips', 'home'];
const NOT_SHOWN = ['menu', 'overflow', 'hide', 'drop', 'note'];

/** Lays `segs` out on the pill at `level`, as island.ts does at the default widths on a 1920 × 1080 screen. */
function lay(segs: Seg[], level: Level, orient: Orientation = 'horizontal') {
  const size = pillSize({ width: 1920, height: 1080 }, normalizeWidths(null), level, 8, 'medium', orient);
  const inner = Math.max(40, size.main - innerPadding(size.cross) * 2);
  if (orient === 'vertical') return { placed: fitVertical(segs, inner, Math.max(16, size.cross - 14), measure), inner };
  return { placed: fitSegments(segs, inner, size.h, measure), inner };
}

describe('the moon while Quiet is on', () => {
  it('shows on an activity’s pill, the idle pill, lone chips and the open island', () => {
    for (const view of SHOWN) {
      expect(moonShows(view)).toBe(true);
      expect(quietMoon(true, view, true).map((x) => x.key)).toEqual(['island/quiet']);
    }
  });

  it('not on the menu (its Quiet button is lit), the +N list, Hide’s choices, a file drop or a note', () => {
    for (const view of NOT_SHOWN) {
      expect(moonShows(view)).toBe(false);
      expect(quietMoon(true, view, true)).toEqual([]);
    }
  });

  it('goes as soon as Quiet is off', () => {
    for (const view of [...SHOWN, ...NOT_SHOWN]) expect(quietMoon(false, view, true)).toEqual([]);
  });

  it('is a small violet moon at the far end that only tells: nothing to press', () => {
    const [moon] = quietMoon(true, 'act:music', true);
    expect(moon).toMatchObject({ t: 'icon', icon: 'moon', tone: 'violet', size: 'sm', side: 'end', prio: 1 });
    expect('action' in moon).toBe(false);
  });

  it('says where to turn Quiet off: the right-click menu, or Settings when the menu has no Quiet', () => {
    expect(quietMoon(true, 'idle', true)[0].tip).toMatch(/right-click/);
    expect(quietMoon(true, 'idle', false)[0].tip).toMatch(/Settings/);
  });
});

describe('the moon on the pill', () => {
  const activity: Seg[] = [
    { t: 'icon', key: 'music/icon', icon: 'music', prio: 0 },
    { t: 'text', key: 'music/title', text: 'A fairly long song title by someone', prio: 2 },
  ];

  it('sits last, after the activity, on a compact and an expanded pill', () => {
    for (const level of ['compact', 'expanded'] as const) {
      const { placed, inner } = lay(activity.concat(quietMoon(true, 'act:music', true)), level);
      const moon = placed.at(-1)!;
      expect(moon.seg.key).toBe('island/quiet');
      expect(moon.x + moon.w).toBe(inner);
    }
  });

  it('a pill standing on the left or right edge keeps it too, at its bottom end', () => {
    const { placed } = lay(activity.concat(quietMoon(true, 'act:music', true)), 'compact', 'vertical');
    expect(placed.at(-1)!.seg.key).toBe('island/quiet');
  });

  it('the idle pill holds just the moon', () => {
    const { placed } = lay(quietMoon(true, 'idle', true), 'idle');
    expect(placed.map((p) => p.seg.key)).toEqual(['island/quiet']);
  });
});

describe('Quiet as saved', () => {
  it('both forks keep it in general.dnd, so a saved Quiet still shows the moon after the update', () => {
    // Moss's 0.4.2 and Justin's 0.2.11 both save settings version 5 with Quiet at general.dnd.
    const saved = defaultSettings() as unknown as Record<string, any>;
    saved.general.dnd = true;
    expect(migrate(JSON.parse(JSON.stringify(saved))).general.dnd).toBe(true);
    expect(migrate({ version: 5, general: { dnd: true } }).general.dnd).toBe(true);
    expect(migrate({ version: 5 }).general.dnd).toBe(false);
  });
});
