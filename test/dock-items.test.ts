import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { batteryTone, claudeUsageText, DOCK_LABELS, DOCK_ZOOM, toggleDockItem } from '../src/core/dock';
import { DOCK_ITEMS, migrate } from '../src/core/settings';

describe('taskbar items', () => {
  it('shows everything by default', () => {
    expect(migrate({}).island.taskbar.hidden).toEqual([]);
  });

  it('keeps only known items, in the taskbar order', () => {
    const s = migrate({ island: { taskbar: { on: true, hidden: ['clock', 'nope', 'battery', 3, 'battery'] } } });
    expect(s.island.taskbar.hidden).toEqual(['battery', 'clock']);
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
  });
});

describe('taskbar Claude usage and sizes', () => {
  it('reads S: xx% | W: xx%, leaving out what is not known', () => {
    expect(claudeUsageText({ session: 42.4, week: 18 })).toBe('S: 42% | W: 18%');
    expect(claudeUsageText({ session: null, week: 7 })).toBe('W: 7%');
    expect(claudeUsageText({ session: 100, week: null })).toBe('S: 100%');
  });

  it('is Medium (the size it was built at) unless a size was saved', () => {
    expect(migrate({}).island.taskbar.size).toBe('medium');
    expect(migrate({ island: { taskbar: { size: 'large' } } }).island.taskbar.size).toBe('large');
    expect(migrate({ island: { taskbar: { size: 'huge' } } }).island.taskbar.size).toBe('medium');
    expect(DOCK_ZOOM.medium).toBe(1);
    expect(DOCK_ZOOM.small).toBeLessThan(1);
    expect(DOCK_ZOOM.large).toBeGreaterThan(1);
  });
});
