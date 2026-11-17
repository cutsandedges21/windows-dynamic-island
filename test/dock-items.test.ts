import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { batteryTone, DOCK_LABELS, toggleDockItem } from '../src/core/dock';
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
    expect(toggleDockItem(['start', ...off], 'wifi')).toEqual(['start']);
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
