// The island's right-click menu: the user picks what it shows (Settings › Behavior › Right-click menu),
// Settings always stays, and the pill is only as long as what it holds.

import { describe, expect, it } from 'vitest';
import { innerPadding, normalizeWidths, pillSize, type Orientation } from '../src/core/layout';
import { FULL_MENU, MENU_ITEMS, MENU_SPLIT, menuLength, menuMain, menuSegments, type MenuShown, type MenuState } from '../src/core/menu';
import { fitSegments, fitVertical, GAP, naturalRun, verticalRun, VGAP, type Measure, type Placed, type Seg } from '../src/core/segments';
import { defaultSettings, migrate } from '../src/core/settings';

const st: MenuState = { anchor: 'top', dnd: false, mac: false, reminders: true };
const keys = (segs: Seg[]) => segs.map((x) => x.key);
const without = (...off: Array<keyof MenuShown>): MenuShown => ({ ...FULL_MENU, ...Object.fromEntries(off.map((id) => [id, false])) });
/** Fixed text widths, so lengths don't depend on fonts. */
const measure: Measure = (text) => text.length * 7;

/** The open island at the default widths on a 1920 × 1080 screen, as island.ts sizes it for the menu. */
function menuPill(shown: MenuShown, orient: Orientation = 'horizontal') {
  const area = { width: 1920, height: 1080 };
  const size = pillSize(area, normalizeWidths(null), 'maximum', 8, 'medium', orient);
  const pad = innerPadding(size.cross);
  const vertical = orient === 'vertical';
  const crossMax = vertical ? Math.max(16, size.cross - 14) : size.h;
  const main = menuMain(shown, st, { max: size.main, cross: size.cross, pad, vertical, crossMax }, measure);
  const segs = menuSegments(shown, st);
  const inner = main - pad * 2;
  const placed = vertical ? fitVertical(segs, inner, crossMax, measure) : fitSegments(segs, inner, size.h, measure);
  return { max: size.main, main, inner, segs, placed, crossMax };
}

describe('the right-click menu', () => {
  it('shows everything it always did, in the same order, until the user takes something out', () => {
    expect(keys(menuSegments(FULL_MENU, st))).toEqual([
      'menu/label', 'menu/top', 'menu/right', 'menu/bottom', 'menu/left', 'menu/sep',
      'menu/dnd', 'menu/hide', 'menu/reminders', 'menu/workspaces', 'menu/activities', 'menu/settings',
    ]);
    expect(defaultSettings().island.menu).toEqual(FULL_MENU);
    expect(MENU_ITEMS.map((m) => m.id)).toEqual(['position', 'quiet', 'hide', 'reminders', 'workspaces', 'activities']);
  });

  it('drops Position as a whole: its label, its four buttons and the line after them', () => {
    const segs = keys(menuSegments(without('position'), st));
    expect(segs).toEqual(['menu/dnd', 'menu/hide', 'menu/reminders', 'menu/workspaces', 'menu/activities', 'menu/settings']);
  });

  it('keeps the line after Position, whatever follows it', () => {
    for (const shown of [FULL_MENU, without('quiet'), without('hide'), without('quiet', 'hide'), without('quiet', 'hide', 'reminders', 'workspaces', 'activities')]) {
      const segs = keys(menuSegments(shown, st));
      expect(segs[segs.indexOf('menu/left') + 1]).toBe('menu/sep');
    }
    expect(keys(menuSegments(without('position'), st))).not.toContain('menu/sep');
  });

  it('keeps Settings whatever is turned off', () => {
    const none = without('position', 'quiet', 'hide', 'reminders', 'workspaces', 'activities');
    expect(keys(menuSegments(none, st))).toEqual(['menu/settings']);
    for (const m of MENU_ITEMS) expect(keys(menuSegments(without(m.id), st))).toContain('menu/settings');
  });

  it('takes out only the item turned off', () => {
    expect(keys(menuSegments(without('workspaces'), st))).toEqual([
      'menu/label', 'menu/top', 'menu/right', 'menu/bottom', 'menu/left', 'menu/sep',
      'menu/dnd', 'menu/hide', 'menu/reminders', 'menu/activities', 'menu/settings',
    ]);
  });

  it('shows Reminders only while the Reminders activity is on', () => {
    expect(keys(menuSegments(FULL_MENU, { ...st, reminders: false }))).not.toContain('menu/reminders');
    expect(menuSegments(FULL_MENU, st).find((x) => x.key === 'menu/reminders')).toMatchObject({ action: 'island:reminders', side: 'end' });
  });

  it('still marks where the island is and whether Quiet is on', () => {
    const segs = menuSegments(FULL_MENU, { anchor: 'left', dnd: true, mac: false, reminders: true });
    const by = (k: string) => segs.find((x) => x.key === k) as Extract<Seg, { t: 'button' }>;
    expect(by('menu/left').style).toBe('primary');
    expect(by('menu/top').style).toBe('ghost');
    expect(by('menu/dnd')).toMatchObject({ label: 'Quiet on', style: 'primary' });
  });
});

describe('saving the choice', () => {
  const saved = (menu: unknown) => {
    const raw = defaultSettings() as unknown as Record<string, any>;
    raw.island.menu = menu;
    return migrate(raw).island.menu;
  };

  it('keeps what was turned off across restarts', () => {
    expect(saved(without('position'))).toEqual(without('position'));
    expect(saved(without('position', 'hide', 'activities'))).toEqual(without('position', 'hide', 'activities'));
  });

  it('shows the whole menu for settings saved before the choice existed', () => {
    const raw = defaultSettings() as unknown as Record<string, any>;
    delete raw.island.menu;
    expect(migrate(raw).island.menu).toEqual(FULL_MENU);
  });

  it('drops junk: an unknown item, a mistyped value, a menu that is not a list of switches', () => {
    expect(saved({ position: false, zoom: false })).toEqual(without('position'));
    expect(saved({ position: 'no', hide: false })).toEqual(without('hide'));
    expect(saved('position')).toEqual(FULL_MENU);
    expect(saved(null)).toEqual(FULL_MENU);
  });
});

describe('how long the menu is', () => {
  it('is just its items, with a little room between its two ends', () => {
    expect(menuLength(700, 600, true, 50)).toBe(600 + MENU_SPLIT);
    expect(menuLength(700, 280, false, 50)).toBe(280);
  });

  it('never outgrows the open island, never gets narrower than round', () => {
    expect(menuLength(700, 690, true, 50)).toBe(700);
    expect(menuLength(700, 900, true, 50)).toBe(700);
    expect(menuLength(700, 30, false, 50)).toBe(50);
  });

  /** Room between the last item on the near end and the first on the far end. */
  const split = (placed: Placed[], vertical = false) => {
    const near = placed.filter((p) => (p.seg.side ?? 'start') === 'start').at(-1)!;
    const far = placed.find((p) => p.seg.side === 'end')!;
    return far.x - (near.x + (vertical ? near.h ?? 0 : near.w));
  };

  it('in the pill: the full menu hugs its items, every one fits, its two groups a little apart', () => {
    const full = menuPill(FULL_MENU);
    expect(full.main).toBeLessThan(full.max);
    expect(full.inner).toBe(naturalRun(full.segs, 50, measure) + MENU_SPLIT);
    expect(keys(full.placed.map((p) => p.seg))).toEqual(keys(full.segs));
    expect(split(full.placed)).toBe(GAP + MENU_SPLIT);
  });

  it('in the pill: whatever is left on the near end, no hole after it', () => {
    // Quiet or Hide ending the near end: a little room before the far one.
    for (const shown of [without('position', 'workspaces', 'activities'), without('position'), FULL_MENU]) {
      const m = menuPill(shown);
      expect(m.placed).toHaveLength(m.segs.length);
      expect(m.inner).toBe(naturalRun(m.segs, 50, measure) + MENU_SPLIT);
      expect(split(m.placed)).toBe(GAP + MENU_SPLIT);
    }
    // Position's line ending it: the line parts the two ends, as far from each.
    for (const shown of [without('quiet', 'hide', 'workspaces', 'activities'), without('quiet', 'hide')]) {
      const m = menuPill(shown);
      expect(m.placed).toHaveLength(m.segs.length);
      expect(m.inner).toBe(naturalRun(m.segs, 50, measure));
      const at = (k: string) => m.placed.find((p) => p.seg.key === k)!;
      const line = at('menu/sep');
      const left = at('menu/left');
      const far = m.placed.find((p) => p.seg.side === 'end')!;
      expect(line.x - (left.x + left.w)).toBe(far.x - (line.x + line.w));
    }
  });

  it('in the pill: taking Position out shortens it by exactly Position’s room', () => {
    const full = menuPill(FULL_MENU);
    const less = menuPill(without('position'));
    const fullSegs = menuSegments(FULL_MENU, st);
    // Label, four buttons and the line, with the gaps after each of them.
    const saved = naturalRun(fullSegs, 50, measure) - naturalRun(fullSegs.slice(6), 50, measure);
    expect(saved).toBeGreaterThan(naturalRun(fullSegs.slice(0, 6), 50, measure));
    expect(full.main - less.main).toBe(saved);
  });

  it('in the pill: Workspaces, Activities and Settings alone hug the pill', () => {
    const ends = menuPill(without('position', 'quiet', 'hide'));
    expect(ends.placed[0].x).toBe(0);
    expect(ends.inner).toBe(naturalRun(ends.segs, 50, measure));
  });

  it('in the pill: Settings alone is a small round-ended pill', () => {
    const lone = menuPill(without('position', 'quiet', 'hide', 'reminders', 'workspaces', 'activities'));
    expect(lone.placed.map((p) => p.seg.key)).toEqual(['menu/settings']);
    expect(lone.main).toBeGreaterThanOrEqual(50);
    expect(lone.main).toBeLessThan(100);
  });

  it('down a side edge: hugs its items the same way', () => {
    for (const shown of [FULL_MENU, without('position'), without('quiet', 'hide', 'workspaces', 'activities')]) {
      const m = menuPill(shown, 'vertical');
      const lined = m.segs.filter((x) => (x.side ?? 'start') === 'start').at(-1)?.t === 'sep';
      expect(m.placed).toHaveLength(m.segs.length);
      expect(m.inner).toBe(verticalRun(m.segs, m.crossMax, measure) + (lined ? 0 : MENU_SPLIT));
      expect(split(m.placed, true)).toBe(VGAP + (lined ? 0 : MENU_SPLIT));
      const last = m.placed[m.placed.length - 1];
      expect(last.x + (last.h ?? 0)).toBe(m.inner);
    }
    expect(menuPill(without('position'), 'vertical').main).toBeLessThan(menuPill(FULL_MENU, 'vertical').main);
  });

  it('measures gaps the way the pill lays items out', () => {
    const two: Seg[] = [
      { t: 'button', key: 'a', icon: 'moon', action: 'x' },
      { t: 'button', key: 'b', icon: 'moon', action: 'x' },
    ];
    expect(naturalRun(two, 50, measure)).toBe(26 * 2 + GAP);
  });
});
