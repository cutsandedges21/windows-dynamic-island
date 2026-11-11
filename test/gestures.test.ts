// The Controls page's list of gestures: what it says follows the user's settings, and a Mac
// never lists what only Windows has.

import { describe, expect, it } from 'vitest';
import { gestureGroups } from '../src/gestures';
import { defaultSettings } from '../src/core/settings';

const lines = (groups: ReturnType<typeof gestureGroups>) => groups.flatMap((g) => g.items);
const how = (groups: ReturnType<typeof gestureGroups>) => lines(groups).map(([h]) => h);
const what = (groups: ReturnType<typeof gestureGroups>, h: string) => lines(groups).find(([x]) => x === h)?.[1];

describe('the Controls page', () => {
  it('lists the island, Hide, Control Center and activities, each with something in it', () => {
    const groups = gestureGroups(defaultSettings(), 'windows');
    expect(groups.map((g) => g.title)).toEqual(['On the island', 'Hide and show', 'In the Control Center', 'In activities']);
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
    for (const [h, w] of lines(groups)) {
      expect(h.length).toBeGreaterThan(0);
      expect(w).toMatch(/\.$/);
    }
  });

  it('names the keys as this computer has them', () => {
    const win = how(gestureGroups(defaultSettings(), 'windows'));
    const mac = how(gestureGroups(defaultSettings(), 'macos'));
    expect(win).toContain('Tap Ctrl over it');
    expect(win).toContain("Point at Land's icon, press Ctrl+V");
    expect(mac).toContain('Tap Control over it');
    expect(mac).toContain("Point at Land's icon, press Cmd+V");
  });

  it("leaves out what a Mac doesn't have yet", () => {
    const win = how(gestureGroups(defaultSettings(), 'windows'));
    const mac = how(gestureGroups(defaultSettings(), 'macos'));
    expect(win).toContain('System Stats: click a bar');
    expect(win).toContain('System Controls: Screenshot, Record');
    expect(mac).not.toContain('System Stats: click a bar');
    expect(mac).not.toContain('System Controls: Screenshot, Record');
  });

  it('says how to bring a hidden island back with the key the user set, or without one', () => {
    const s = defaultSettings();
    expect(what(gestureGroups(s, 'windows'), 'Bring it back')).toBe('Press Alt+Shift+Space, or use the tray icon › Show island, or Settings › Behavior › Show it now.');
    s.general.toggleHotkey = '';
    expect(what(gestureGroups(s, 'macos'), 'Bring it back')).toBe('Use the menu bar icon › Show island, or Settings › Behavior › Show it now.');
  });

  it('points Hide at the tray when the right-click menu no longer has it', () => {
    const s = defaultSettings();
    expect(how(gestureGroups(s, 'windows'))).toContain('Right click › Hide');
    s.island.menu.hide = false;
    expect(how(gestureGroups(s, 'windows'))).toContain('Tray icon › Hide island');
    expect(how(gestureGroups(s, 'macos'))).toContain('Menu bar icon › Hide island');
  });
});
