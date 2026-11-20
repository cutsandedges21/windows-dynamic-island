import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { clickPlan, dockApps, dockRow, meltEnds, movePins, openOrder, pinToggle, resetLine, riseAt, riseShifts, spotlightOn, toggleStyle, type DockApp } from '../src/core/dock';
import { barAutoHide, barEdge, barOrder, barStyles, barTall, BAR_TALL_MAX, cleanNames, DOCK_ITEMS, type DockItem } from '../src/core/settings';

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

  it('keeps open apps where they are when another comes to the front', () => {
    const win = (hwnd: number, exe: string) => ({ hwnd, pid: hwnd, exe, title: exe, className: 'X', rect: { x: 0, y: 0, width: 10, height: 10 }, state: 'normal' as const, monitor: 'm', dpi: 96, appId: '' });
    // Opened in this order: chrome, then code.
    let seen = openOrder([], [win(1, 'C:\\chrome.exe')]);
    seen = openOrder(seen, [win(2, 'C:\\code.exe'), win(1, 'C:\\chrome.exe')]);
    expect(seen).toEqual(['c:\\chrome.exe', 'c:\\code.exe']);
    // Chrome comes to the front: it keeps its place.
    const front = [win(1, 'C:\\chrome.exe'), win(2, 'C:\\code.exe')];
    expect(dockApps([], front, 1, new Map(), seen).map((a) => a.key)).toEqual(['c:\\chrome.exe', 'c:\\code.exe']);
    const back = [win(2, 'C:\\code.exe'), win(1, 'C:\\chrome.exe')];
    expect(dockApps([], back, 2, new Map(), seen).map((a) => a.key)).toEqual(['c:\\chrome.exe', 'c:\\code.exe']);
    // Chrome closes and opens again: now it's last.
    seen = openOrder(seen, [win(2, 'C:\\code.exe')]);
    seen = openOrder(seen, [win(3, 'C:\\chrome.exe'), win(2, 'C:\\code.exe')]);
    expect(seen).toEqual(['c:\\code.exe', 'c:\\chrome.exe']);
  });

  it('keeps the items in the order dragged to, Settings last by default', () => {
    expect(barOrder(null)).toEqual([...DOCK_ITEMS]);
    expect(barOrder(null).at(-1)).toBe('settings');
    const saved = barOrder(['clock', 'nope', 'clock', 'apps']);
    expect(saved.slice(0, 2)).toEqual(['clock', 'apps']);
    expect(saved).toHaveLength(DOCK_ITEMS.length);
    expect(saved.at(-1)).toBe('settings');
  });

  it('draws a line where one kind of item gives way to another, and after the song', () => {
    const all = new Set<DockItem>(DOCK_ITEMS);
    expect(dockRow(DOCK_ITEMS, all).join(' ')).toBe('start search arrow apps sep music sep timer claude sep tray battery wifi sound clock notifications settings');
    expect(dockRow(['clock', 'settings', 'start', 'apps', 'music'], all).join(' ')).toBe('clock settings sep start apps sep music');
    // Only what shows; split round the island, no line beside the apps.
    expect(dockRow(DOCK_ITEMS, new Set<DockItem>(['apps', 'timer', 'clock']), true).join(' ')).toBe('apps timer sep clock');
    expect(dockRow(DOCK_ITEMS, new Set<DockItem>(['apps', 'clock']), true).join(' ')).toBe('apps clock');
  });

  it("gives Windows' Settings a place, under its own name", () => {
    const w = { hwnd: 7, pid: 7, exe: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe', title: 'Settings', className: 'ApplicationFrameWindow', rect: { x: 0, y: 0, width: 10, height: 10 }, state: 'normal' as const, monitor: 'm', dpi: 96, appId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', appName: 'Settings' };
    expect(dockApps([], [w], 7, new Map()).map((a) => [a.name, a.windows])).toEqual([['Settings', [7]]]);
  });

  it('keeps how much taller the bar was stretched, within its bounds', () => {
    expect(barTall(23.4)).toBe(23);
    expect(barTall(-5)).toBe(0);
    expect(barTall('20')).toBe(0);
    expect(barTall(999)).toBe(BAR_TALL_MAX);
  });

  it('gives a browser\'s app window its shortcut\'s place, and Island\'s Settings one of its own', () => {
    const base = { pid: 1, className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, width: 10, height: 10 }, state: 'normal' as const, monitor: 'm', dpi: 96, appId: '' };
    const lnk = 'C:\\Pins\\Google Calendar.lnk';
    const chrome = { ...base, hwnd: 1, exe: 'C:\\chrome.exe', title: 'Google' };
    const cal = { ...base, hwnd: 2, exe: 'C:\\chrome.exe', title: 'Google Agenda', appName: 'Google Calendar', link: lnk };
    const own = { ...base, hwnd: 3, exe: 'C:\\x\\island.exe', title: 'Island', appName: 'Island', own: true };
    const other = { ...base, hwnd: 4, exe: 'C:\\y\\island.exe', title: 'Island' };
    // Pinned by its shortcut (as Windows' pins give it): its window goes with the pin.
    const apps = dockApps([{ name: 'Google Calendar', target: lnk }], [cal, chrome, own, other], 2, new Map());
    expect(apps.map((a) => [a.name, a.windows])).toEqual([['Google Calendar', [2]], ['chrome', [1]], ['Island', [3]]]);
    expect(apps[0].front).toBe(true);
    expect(dockApps([], [cal], 0, new Map()).map((a) => [a.key, a.name])).toEqual([[lnk.toLowerCase(), 'Google Calendar']]);
  });

  it('groups a web app\'s window under its own icon, not the browser\'s', () => {
    const base = { pid: 1, className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, width: 10, height: 10 }, state: 'normal' as const, monitor: 'm', dpi: 96 };
    const chrome = { ...base, hwnd: 1, exe: 'C:\\chrome.exe', title: 'Google', appId: '' };
    const music = { ...base, hwnd: 2, exe: 'C:\\chrome.exe', title: 'YouTube Music', appId: 'Chrome._crx_abc' };
    const pins = [{ name: 'YouTube Music', target: 'shell:AppsFolder\\Chrome._crx_abc' }];
    const apps = dockApps(pins, [music, chrome], 2, new Map());
    expect(apps.map((a) => [a.name, a.windows])).toEqual([['YouTube Music', [2]], ['chrome', [1]]]);
    expect(apps[0].front).toBe(true);
    // Not pinned: still its own icon, named by its window.
    expect(dockApps([], [music, chrome], 1, new Map()).map((a) => a.name)).toEqual(['YouTube Music', 'chrome']);
  });

  it("shows a Store app by Start's name and icon, and matches its pin", () => {
    const calc = { hwnd: 5, pid: 5, className: 'ApplicationFrameWindow', rect: { x: 0, y: 0, width: 10, height: 10 }, state: 'normal' as const, monitor: 'm', dpi: 96, exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_1\\CalculatorApp.exe', title: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', appName: 'Calculator' };
    const key = 'shell:appsfolder\\microsoft.windowscalculator_8wekyb3d8bbwe!app';
    const icons = new Map([[key, 'data:image/png;base64,x']]);
    expect(dockApps([], [calc], 5, icons).map((a) => [a.key, a.name, a.icon])).toEqual([[key, 'Calculator', 'data:image/png;base64,x']]);
    const pins = [{ name: 'Calculator', target: 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }];
    expect(dockApps(pins, [calc], 5, icons).map((a) => [a.name, a.pinned, a.windows])).toEqual([['Calculator', true, [5]]]);
  });

  it('rises most under the pointer and not at all two icons away', () => {
    expect(riseAt(0)).toBe(1);
    expect(riseAt(-50)).toBeCloseTo(0.5, 5);
    expect(riseAt(50)).toBeCloseTo(0.5, 5);
    expect(riseAt(100)).toBe(0);
    expect(riseAt(200)).toBe(0);
  });

  it("parts the row round what grew, like Windhawk's dock: half the growth as room, the ends out by half of it", () => {
    // Nothing grown: nothing moves.
    expect(riseShifts([0, 0, 0])).toEqual({ shifts: [0, 0, 0], total: 0 });
    // The middle one fully grown: 30 % of 40 px, half of it as room (6 px); the others 3 px out each side.
    const one = riseShifts([0, 1, 0]);
    expect(one.total).toBeCloseTo(6, 5);
    expect(one.shifts.map((s) => Number(s.toFixed(5)))).toEqual([-3, 0, 3]);
    // Grown on one side more than the other: the row parts nearer the pointer, every app stays in order.
    const lop = riseShifts([0, 1, 0.5, 0]);
    expect(lop.total).toBeCloseTo(9, 5);
    expect(lop.shifts[0]).toBeCloseTo(-4.5, 5);
    expect(lop.shifts[3]).toBeCloseTo(4.5, 5);
    for (let i = 1; i < 4; i++) expect(lop.shifts[i]).toBeGreaterThanOrEqual(lop.shifts[i - 1]);
  });

  it('says when a limit resets: the session in so long and at what time, the week on what day', () => {
    const now = new Date(2026, 10, 17, 14, 0).getTime();
    expect(resetLine(now + (2 * 60 + 10) * 60000, now, false)).toBe('in 2h 10m · 4:10 PM');
    expect(resetLine(new Date(2026, 10, 17, 21, 0).getTime(), now, true)).toBe('Today 9:00 PM · in 7h');
    expect(resetLine(new Date(2026, 10, 19, 4, 0).getTime(), now, true)).toBe('Thu 4:00 AM · in 1d 14h');
    expect(resetLine(now - 1, now, false)).toBe('Resetting now');
    expect(resetLine(null, now, false)).toBe('Starts with your next message');
  });

  it('keeps the spotlight on the app it was on until another app is in front (Alt+Tab, the desktop)', () => {
    const a = { key: 'a', front: false, windows: [1] };
    const b = { key: 'b', front: false, windows: [2] };
    expect(spotlightOn([{ ...a, front: true }, b], null)).toBe('a');
    // Nothing in front (Alt+Tab): still on a.
    expect(spotlightOn([a, b], 'a')).toBe('a');
    // b comes to the front: it moves.
    expect(spotlightOn([a, { ...b, front: true }], 'a')).toBe('b');
    // a closed: nowhere.
    expect(spotlightOn([{ ...a, windows: [] }, b], 'a')).toBeNull();
  });

  it('turns styles on and off together, in their order', () => {
    expect(toggleStyle(['rise'], 'glide')).toEqual(['rise', 'glide']);
    expect(toggleStyle(['glide', 'rise'], 'spotlight')).toEqual(['rise', 'glide', 'spotlight']);
    expect(toggleStyle(['rise'], 'rise')).toEqual([]);
  });

  it('reads the styles saved, or the one style saved before they mixed', () => {
    expect(barStyles({ styles: ['spotlight', 'nope'], names: {} })).toEqual(['spotlight']);
    expect(barStyles({ style: 'spotlight' })).toEqual(['spotlight']);
    expect(barStyles({})).toEqual(['rise']);
    expect(barStyles({ styles: [] })).toEqual([]);
  });

  it('keeps the names for a bar saved with Glide before Names was its own style', () => {
    expect(barStyles({ styles: ['glide', 'nope', 'spotlight'] })).toEqual(['glide', 'spotlight', 'names']);
    // Saved since: what was saved, Names off included.
    expect(barStyles({ styles: ['glide'], names: { font: 'serif' } })).toEqual(['glide']);
    expect(barStyles({ styles: ['rise', 'names'], names: {} })).toEqual(['rise', 'names']);
  });

  it('cleans the names look, falling back to System in a bubble', () => {
    expect(cleanNames(undefined)).toEqual({ font: 'system', look: 'bubble', bold: false });
    expect(cleanNames({ font: 'serif', look: 'outline', bold: true })).toEqual({ font: 'serif', look: 'outline', bold: true });
    expect(cleanNames({ font: 'comic', look: 'neon', bold: 'yes' })).toEqual({ font: 'system', look: 'bubble', bold: false });
  });

  it('only blends or auto-hides at the bottom while Windows\' taskbar is hidden', () => {
    const t = { edge: true, autoHide: true, hideWindows: false, side: 'bottom' as const };
    expect(barEdge(t)).toBe(false);
    expect(barAutoHide(t)).toBe(false);
    expect(barEdge({ ...t, hideWindows: true })).toBe(true);
    expect(barAutoHide({ ...t, hideWindows: true })).toBe(true);
    // Off the bottom, Windows' taskbar is not in the way.
    expect(barEdge({ ...t, side: 'left' })).toBe(true);
    expect(barAutoHide({ ...t, side: 'top' })).toBe(true);
    expect(barEdge({ ...t, edge: false, hideWindows: true })).toBe(false);
  });

  it('melts each end from the top corner down to the edge, its rim along the same outline', () => {
    const { left, right } = meltEnds(72, 34);
    const svg = (url: string) => decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2));
    // The foot (72px out along the edge, flat there), up the bar's side, round its 18px corner.
    expect(left.width).toBe(90);
    expect(svg(left.fill)).toContain("d='M0 52A72 34 0 0 0 72 18L72 18A18 18 0 0 1 90 0L90 52Z'");
    expect(svg(right.fill)).toContain("d='M90 52A72 34 0 0 1 18 18L18 18A18 18 0 0 0 0 0L0 52Z'");
    // The rim: the same outline, open and stroked.
    expect(svg(left.rim)).toContain("d='M0 52A72 34 0 0 0 72 18L72 18A18 18 0 0 1 90 0' fill='none' stroke='#000' stroke-width='2'");
    // Never higher than where the top corner starts.
    expect(svg(meltEnds(40, 50).left.fill)).toContain('A40 34 0 0 0 40 18');
  });
});
