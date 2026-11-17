import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { clickPlan, movePins, pinToggle, riseAt, type DockApp } from '../src/core/dock';

const app = (key: string, pinned: boolean, windows: number[] = [], front = false): DockApp => ({ key, name: key.toUpperCase(), icon: null, windows, front, pinned });
const pin = (key: string) => ({ name: key.toUpperCase(), target: key });
const keys = (list: Array<{ target: string }> | null) => list?.map((p) => p.target) ?? null;

describe('taskbar apps', () => {
  it('a click launches a closed app, minimizes the one in front, else brings it forward', () => {
    expect(clickPlan(app('a', true))).toEqual({ do: 'launch' });
    expect(clickPlan(app('a', true, [11, 12], true))).toEqual({ do: 'minimize', hwnd: 11 });
    expect(clickPlan(app('a', false, [11, 12]))).toEqual({ do: 'raise', hwnd: 11 });
  });

  it('pins an app at the end and unpins it, matching paths in any case', () => {
    expect(keys(pinToggle([pin('a')], app('b', false), true))).toEqual(['a', 'b']);
    expect(keys(pinToggle([pin('a'), { name: 'B', target: 'C:\\B.exe' }], app('c:\\b.exe', true), false))).toEqual(['a']);
    expect(pinToggle([pin('a')], app('a', true), true)).toBeNull();
    expect(pinToggle([pin('a')], app('b', false), false)).toBeNull();
  });

  it('moves a pinned app among the pins', () => {
    const pins = [pin('a'), pin('b'), pin('c')];
    const row = [app('a', true), app('b', true), app('c', true), app('x', false, [1])];
    expect(keys(movePins(pins, row, 'a', 2))).toEqual(['b', 'c', 'a']);
    expect(keys(movePins(pins, row, 'c', 0))).toEqual(['c', 'a', 'b']);
    // Dropped past the pins, it is the last pin.
    expect(keys(movePins(pins, row, 'a', 3))).toEqual(['b', 'c', 'a']);
    expect(movePins(pins, row, 'b', 1)).toBeNull();
  });

  it('pins an open app dropped among the pins or right after them, not further along', () => {
    const pins = [pin('a'), pin('b')];
    const row = [app('a', true), app('b', true), app('x', false, [1]), app('y', false, [2])];
    expect(keys(movePins(pins, row, 'y', 1))).toEqual(['a', 'y', 'b']);
    expect(keys(movePins(pins, row, 'y', 2))).toEqual(['a', 'b', 'y']);
    expect(movePins(pins, row, 'x', 3)).toBeNull();
    expect(movePins(pins, row, 'nope', 0)).toBeNull();
  });

  it('keeps pins that are not on the taskbar right now at the end', () => {
    const pins = [pin('a'), pin('b'), pin('far')];
    expect(keys(movePins(pins, [app('a', true), app('b', true)], 'a', 1))).toEqual(['b', 'a', 'far']);
  });

  it('rises most under the pointer and not at all two icons away', () => {
    expect(riseAt(0)).toBe(1);
    expect(riseAt(-48)).toBeCloseTo(0.5, 5);
    expect(riseAt(48)).toBeCloseTo(0.5, 5);
    expect(riseAt(96)).toBe(0);
    expect(riseAt(200)).toBe(0);
  });
});
