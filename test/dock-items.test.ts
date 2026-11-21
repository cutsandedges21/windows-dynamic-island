import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { batteryBadge, batteryTone, claudeUsageText, DOCK_DROP, DOCK_LABELS, DOCK_ZOOM, soundWaves, toggleDockItem } from '../src/core/dock';
import { DOCK_ITEMS, migrate } from '../src/core/settings';

describe('taskbar items', () => {
  it('shows everything by default', () => {
    expect(migrate({}).island.taskbar.hidden).toEqual([]);
  });

  it('keeps only known items, in the taskbar order', () => {
    const s = migrate({ island: { taskbar: { on: true, hidden: ['clock', 'nope', 'battery', 3, 'battery'] } } });
    expect(s.island.taskbar.hidden).toEqual(['battery', 'clock']);
  });

  it('puts Start and Search on saved taskbars, and keeps them off once taken off', () => {
    const before = migrate({ version: 8, island: { taskbar: { on: true, hidden: ['clock'] } } });
    expect(before.island.taskbar.hidden).toEqual(['clock']);
    expect(DOCK_ITEMS.slice(0, 2)).toEqual(['start', 'search']);
    const off = migrate({ version: 8, island: { taskbar: { on: true, hidden: ['search', 'start'] } } });
    expect(off.island.taskbar.hidden).toEqual(['start', 'search']);
    expect(toggleDockItem(off.island.taskbar.hidden, 'search')).toEqual(['start']);
  });

  it('toggles an item off and back on', () => {
    const off = toggleDockItem([], 'wifi');
    expect(off).toEqual(['wifi']);
    expect(toggleDockItem(['arrow', ...off], 'wifi')).toEqual(['arrow']);
  });

  it('names every item', () => {
    for (const k of DOCK_ITEMS) expect(DOCK_LABELS[k]).toBeTruthy();
  });

  it('colours the battery', () => {
    expect(batteryTone({ percent: 10, charging: true })).toBe('charging');
    expect(batteryTone({ percent: 10, charging: false })).toBe('low');
    expect(batteryTone({ percent: 80, charging: false })).toBe('');
    // Plugged in, not charging (at its limit): the bolt, as Windows shows it.
    expect(batteryTone({ percent: 99, charging: false, ac: true })).toBe('plugged');
    expect(batteryTone({ percent: 99, charging: true, ac: true })).toBe('charging');
  });
});

describe('taskbar Claude usage and sizes', () => {
  it('reads xx% | xx% (the session, the week), a dash for one not known', () => {
    expect(claudeUsageText({ session: 42.4, week: 18 })).toBe('42% | 18%');
    expect(claudeUsageText({ session: null, week: 7 })).toBe('– | 7%');
    expect(claudeUsageText({ session: 100, week: null })).toBe('100% | –');
    expect(claudeUsageText({ session: null, week: null })).toBe('');
  });

  it('is Medium (the size it was built at) unless a size was saved', () => {
    expect(migrate({}).island.taskbar.size).toBe('medium');
    expect(migrate({ island: { taskbar: { size: 'large' } } }).island.taskbar.size).toBe('large');
    expect(migrate({ island: { taskbar: { size: 'huge' } } }).island.taskbar.size).toBe('medium');
    expect(DOCK_ZOOM.medium).toBe(1);
    expect(DOCK_ZOOM.small).toBeLessThan(1);
    expect(DOCK_ZOOM.large).toBeGreaterThan(1);
  });

  it("shows as many sound waves as the volume is loud, as Windows' taskbar does", () => {
    expect(soundWaves(0)).toBe(0);
    expect(soundWaves(0.12)).toBe(1);
    expect(soundWaves(0.33)).toBe(1);
    expect(soundWaves(0.5)).toBe(2);
    expect(soundWaves(0.67)).toBe(3);
    expect(soundWaves(1)).toBe(3);
    // Not known yet: the middle one.
    expect(soundWaves(null)).toBe(2);
  });
});

describe('a full taskbar', () => {
  it("shrinks Search to its icon before anything leaves the bar (Justin, 11-21: the gear went once a song played)", () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8');
    // The 220px box with its word is only drawn while there is room for it.
    const box = css.split(/\r?\n/).filter((l) => l.includes('.dock .dk-search') && l.includes('html.dock-full'));
    expect(box.length).toBeGreaterThan(0);
    for (const l of box) expect(l).toContain(':not(.dk-tight)');
    const dock = readFileSync(resolve(__dirname, '../src/core/dock.ts'), 'utf8');
    const squeeze = dock.slice(dock.indexOf('const squeezeToFit'), dock.indexOf('let sq = n;'));
    // dk-tight is tried before the loop that drops DOCK_DROP's items.
    expect(squeeze.indexOf("classList.add('dk-tight')")).toBeGreaterThan(0);
    expect(squeeze.indexOf("classList.add('dk-tight')")).toBeLessThan(squeeze.indexOf('while (n < DROP.length'));
  });

  it('drops every item but the apps at most, each once', () => {
    expect(new Set(DOCK_DROP).size).toBe(DOCK_DROP.length);
    expect(DOCK_DROP).not.toContain('apps');
    expect(DOCK_DROP[DOCK_DROP.length - 1]).toBe('clock');
  });
});

describe("the battery orange inside while Energy saver is on, as Windows 11's (Justin, 11-21)", () => {
  it('orange on battery with Energy saver on, nothing with it off', () => {
    expect(batteryBadge({ charging: false, ac: false, saver: true })).toBe('saver');
    expect(batteryBadge({ charging: false, ac: false, saver: false })).toBeNull();
    expect(batteryBadge({ charging: false })).toBeNull();
  });

  it('the bolt wins while plugged in, charging or not', () => {
    expect(batteryBadge({ charging: true, ac: true, saver: true })).toBe('bolt');
    expect(batteryBadge({ charging: false, ac: true, saver: true })).toBe('bolt');
    expect(batteryBadge({ charging: true, saver: false })).toBe('bolt');
  });

  it('low on Energy saver: orange, as Windows shows it', () => {
    expect(batteryTone({ percent: 9, charging: false, ac: false })).toBe('low');
    expect(batteryBadge({ charging: false, ac: false, saver: true })).toBe('saver');
  });
});
