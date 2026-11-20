import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/menu', () => ({ CheckMenuItem: {}, Menu: {}, MenuItem: {}, PredefinedMenuItem: {}, Submenu: {} }));

import { cleanFolders, dockSlots, foldApps, folderKey, moveSlot, unfoldApp, type DockApp, type DockFolder } from '../src/core/dock';
import { cleanDockFolders } from '../src/core/settings';

const app = (key: string, pinned: boolean, windows: number[] = []): DockApp => ({ key, name: key.toUpperCase(), icon: null, windows, front: false, pinned });
const pin = (key: string) => ({ name: key.toUpperCase(), target: key });
const keys = (list: Array<{ target: string }> | null | undefined) => list?.map((p) => p.target) ?? null;
const folder = (id: string, ...apps: string[]): DockFolder => ({ id, name: 'Folder', apps });

describe('taskbar folders', () => {
  it('shows a folder where its first app would be, holding its apps', () => {
    const apps = [app('a', true), app('b', true), app('c', true), app('d', true), app('x', false, [1])];
    const slots = dockSlots(apps, [folder('f', 'c', 'b')]);
    expect(slots.map((s) => s.key)).toEqual(['a', folderKey('f'), 'd', 'x']);
    const f = slots[1];
    expect(f.kind === 'folder' && f.apps.map((a) => a.key)).toEqual(['c', 'b']);
  });

  it('leaves out folders with none of their apps on the dock, and apps not pinned', () => {
    const apps = [app('a', true), app('x', false, [1])];
    expect(dockSlots(apps, [folder('f', 'gone', 'x')]).map((s) => s.key)).toEqual(['a', 'x']);
  });

  it('keeps folders to pinned apps, each in one folder, none empty', () => {
    const pins = [pin('a'), pin('b'), pin('c')];
    expect(cleanFolders([folder('f', 'a', 'gone'), folder('g', 'a', 'b'), folder('h', 'zz')], pins)).toEqual([folder('f', 'a'), folder('g', 'b')]);
  });

  it('drops one app onto another: a new folder in its place, both pinned', () => {
    const pins = [pin('a'), pin('b'), pin('c')];
    const apps = [app('a', true), app('b', true), app('c', true), app('x', false, [1])];
    const c = foldApps(pins, apps, [], 'a', 'c', 'n')!;
    expect(keys(c.pins)).toEqual(['b', 'c', 'a']);
    expect(c.folders).toEqual([{ id: 'n', name: 'Folder', apps: ['c', 'a'] }]);
    // An open app dropped onto another open one: both get pinned, the folder after the pins.
    const d = foldApps(pins, [...apps, app('y', false, [2])], [], 'y', 'x', 'n')!;
    expect(keys(d.pins)).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(d.folders?.[0].apps).toEqual(['x', 'y']);
  });

  it('drops an app onto a folder: in it, its pin after the folder\'s last', () => {
    const pins = [pin('a'), pin('b'), pin('c'), pin('d')];
    const apps = pins.map((p) => app(p.target, true));
    const c = foldApps(pins, apps, [folder('f', 'b', 'c')], 'a', folderKey('f'), 'n')!;
    expect(keys(c.pins)).toEqual(['b', 'c', 'a', 'd']);
    expect(c.folders).toEqual([folder('f', 'b', 'c', 'a')]);
    // From another folder: out of it (that one, left with one, is undone).
    const d = foldApps(pins, apps, [folder('f', 'a', 'b'), folder('g', 'c', 'd')], 'a', folderKey('g'), 'n')!;
    expect(d.folders).toEqual([folder('g', 'c', 'd', 'a')]);
  });

  it('does not fold an app onto itself, a folder onto anything, or into its own folder', () => {
    const pins = [pin('a'), pin('b')];
    const apps = [app('a', true), app('b', true)];
    expect(foldApps(pins, apps, [], 'a', 'a', 'n')).toBeNull();
    expect(foldApps(pins, apps, [folder('f', 'a', 'b')], folderKey('f'), 'a', 'n')).toBeNull();
    expect(foldApps(pins, apps, [folder('f', 'a', 'b')], 'a', folderKey('f'), 'n')).toBeNull();
  });

  it('takes an app out: right after the folder, a folder of one undone', () => {
    const pins = [pin('x'), pin('k'), pin('m'), pin('n'), pin('y')];
    const c = unfoldApp(pins, [folder('f', 'k', 'm', 'n')], 'k')!;
    expect(keys(c.pins)).toEqual(['x', 'm', 'n', 'k', 'y']);
    expect(c.folders).toEqual([folder('f', 'm', 'n')]);
    const d = unfoldApp(pins, [folder('f', 'k', 'm')], 'm')!;
    expect(d.pins).toBeNull();
    expect(d.folders).toEqual([]);
    expect(unfoldApp(pins, [], 'k')).toBeNull();
  });

  it('moves a folder with all its apps', () => {
    const pins = [pin('a'), pin('b'), pin('c'), pin('d')];
    const apps = pins.map((p) => app(p.target, true));
    const c = moveSlot(pins, apps, [folder('f', 'b', 'c')], folderKey('f'), 2);
    expect(keys(c.pins)).toEqual(['a', 'd', 'b', 'c']);
    expect(keys(moveSlot(pins, apps, [folder('f', 'b', 'c')], 'd', 0).pins)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves an open app among the other open ones', () => {
    const pins = [pin('a')];
    const apps = [app('a', true), app('x', false, [1]), app('y', false, [2]), app('z', false, [3])];
    expect(moveSlot(pins, apps, [], 'z', 1)).toEqual({ pins: null, open: ['z', 'x', 'y'] });
    expect(moveSlot(pins, apps, [], 'x', 3)).toEqual({ pins: null, open: ['y', 'z', 'x'] });
    expect(moveSlot(pins, apps, [], 'x', 0)).toEqual({ pins: [{ name: 'X', target: 'x' }, pin('a')] });
    expect(moveSlot(pins, apps, [], 'y', 2)).toEqual({ pins: null, open: null });
  });

  it('reads folders from saved settings, dropping what is not one', () => {
    expect(cleanDockFolders([{ id: 'f', name: ' Work ', apps: ['A', 'b', 3] }, { id: 'f', name: 'dup', apps: ['c'] }, { name: 'x' }, 'nope'])).toEqual([{ id: 'f', name: 'Work', apps: ['a', 'b'] }]);
    expect(cleanDockFolders(undefined)).toEqual([]);
    expect(cleanDockFolders([{ id: 'g', name: '', apps: ['a'] }])).toEqual([{ id: 'g', name: 'Folder', apps: ['a'] }]);
  });
});

describe('Start menu folders', () => {
  it('folds, moves and takes out pinned apps as the taskbar does, keeping their own paths', async () => {
    const { startApps } = await import('../src/core/startmenu');
    const pins = [{ name: 'Spotify', target: 'C:/Apps/Spotify.exe' }, { name: 'Discord', target: 'C:/Apps/Discord.exe' }, { name: 'Notion', target: 'C:/Apps/Notion.exe' }];
    const apps = startApps(pins);
    expect(apps.map((a) => a.key)).toEqual(['c:/apps/spotify.exe', 'c:/apps/discord.exe', 'c:/apps/notion.exe']);
    const c = foldApps(pins, apps, [], 'c:/apps/notion.exe', 'c:/apps/spotify.exe', 'n')!;
    expect(c.pins?.map((p) => p.target)).toEqual(['C:/Apps/Spotify.exe', 'C:/Apps/Notion.exe', 'C:/Apps/Discord.exe']);
    expect(dockSlots(startApps(c.pins!), c.folders!).map((s) => s.key)).toEqual([folderKey('n'), 'c:/apps/discord.exe']);
    const back = unfoldApp(c.pins!, c.folders!, 'c:/apps/notion.exe')!;
    expect(back.folders).toEqual([]);
  });
});
