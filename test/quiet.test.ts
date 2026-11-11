// Quiet's moon: while Quiet (do not disturb) is on, a small moon sits at the end of the pill,
// on the pills that show what is going on, and goes as soon as Quiet is off.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { innerPadding, normalizeWidths, pillSize, type Level, type Orientation } from '../src/core/layout';
import { FULL_MENU, menuSegments } from '../src/core/menu';
import { moonShows, quietMoon } from '../src/core/quiet';
import { PHONE_ISLAND_ACTIONS } from '../src/remote/protocol';
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
      expect(quietMoon(true, view).map((x) => x.key)).toEqual(['island/quiet']);
    }
  });

  it('not on the menu (its Quiet button is lit), the +N list, Hide’s choices, a file drop or a note', () => {
    for (const view of NOT_SHOWN) {
      expect(moonShows(view)).toBe(false);
      expect(quietMoon(true, view)).toEqual([]);
    }
  });

  it('goes as soon as Quiet is off', () => {
    for (const view of [...SHOWN, ...NOT_SHOWN]) expect(quietMoon(false, view)).toEqual([]);
  });

  it('is a small violet moon at the far end', () => {
    const [moon] = quietMoon(true, 'act:music');
    expect(moon).toMatchObject({ t: 'icon', icon: 'moon', tone: 'violet', size: 'sm', side: 'end', prio: 1 });
  });

  it("clicking it turns Quiet off the way the menu's Quiet button does, and its tip says so", () => {
    const [moon] = quietMoon(true, 'idle');
    const menuQuiet = menuSegments({ ...FULL_MENU }, { anchor: 'top', dnd: true, mac: false, reminders: false }).find((x) => x.key === 'menu/dnd');
    expect(menuQuiet).toMatchObject({ action: 'island:dnd' });
    expect(moon).toMatchObject({ action: 'island:dnd', tip: 'Quiet is on: click to turn it off' });
    // Also with Quiet taken out of the right-click menu, and from a phone (its pill mirrors this one).
    expect(PHONE_ISLAND_ACTIONS).toContain('island:dnd');
    // The pill gives an icon with an action its click, and the pointer shows it can be clicked.
    const renderer = readFileSync(resolve(__dirname, '../src/core/renderer.ts'), 'utf8');
    const icon = renderer.indexOf("case 'icon': {");
    expect(renderer.slice(icon, renderer.indexOf("case 'dot':", icon))).toContain('e.dataset.action = seg.action');
    expect(readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8')).toContain('.seg-icon[data-action] { cursor: pointer; }');
  });
});

describe('the moon on the pill', () => {
  const activity: Seg[] = [
    { t: 'icon', key: 'music/icon', icon: 'music', prio: 0 },
    { t: 'text', key: 'music/title', text: 'A fairly long song title by someone', prio: 2 },
  ];

  it('sits last, after the activity, on a compact and an expanded pill', () => {
    for (const level of ['compact', 'expanded'] as const) {
      const { placed, inner } = lay(activity.concat(quietMoon(true, 'act:music')), level);
      const moon = placed.at(-1)!;
      expect(moon.seg.key).toBe('island/quiet');
      expect(moon.x + moon.w).toBe(inner);
    }
  });

  it('a pill standing on the left or right edge keeps it too, at its bottom end', () => {
    const { placed } = lay(activity.concat(quietMoon(true, 'act:music')), 'compact', 'vertical');
    expect(placed.at(-1)!.seg.key).toBe('island/quiet');
  });

  it('the idle pill holds just the moon', () => {
    const { placed } = lay(quietMoon(true, 'idle'), 'idle');
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
