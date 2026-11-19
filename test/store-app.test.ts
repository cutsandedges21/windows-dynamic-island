import { describe, expect, it } from 'vitest';
import { dockApps, startName } from '../src/core/dock';
import { packageFamily, storeTargets } from '../src/core/store-app';

const TERMINAL_EXE = 'c:\\program files\\windowsapps\\microsoft.windowsterminal_1.25.3131.0_x64__8wekyb3d8bbwe\\windowsterminal.exe';
const win = (hwnd: number, exe: string, extra: Partial<{ className: string; appId: string; appName: string; title: string }> = {}) => ({
  hwnd,
  pid: hwnd,
  className: extra.className ?? 'Window',
  rect: { x: 0, y: 0, width: 10, height: 10 },
  state: 'normal' as const,
  monitor: 'm',
  dpi: 96,
  exe,
  title: extra.title ?? 'A window',
  appId: extra.appId ?? '',
  appName: extra.appName ?? '',
});

describe('Store apps and File Explorer on the taskbar', () => {
  it("tells a Store app's package from its Start id or its program's path", () => {
    expect(packageFamily('shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App')).toBe('microsoft.windowsterminal_8wekyb3d8bbwe');
    expect(packageFamily(TERMINAL_EXE)).toBe('microsoft.windowsterminal_8wekyb3d8bbwe');
    expect(packageFamily('C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.310.2586.0_x64__zpdnekdrzrea0\\Spotify.exe')).toBe('spotifyab.spotifymusic_zpdnekdrzrea0');
    expect(packageFamily('c:\\program files\\google\\chrome\\application\\chrome.exe')).toBeNull();
    expect(packageFamily('shell:AppsFolder\\Microsoft.Windows.Explorer')).toBeNull();
  });

  it("keeps a Store app saved by its program's path by Start's id and name instead", () => {
    const installed = [
      { name: 'Terminal', target: 'shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
      { name: 'Spotify', target: 'shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
    ];
    const saved = [
      { name: 'chrome', target: 'c:\\program files\\google\\chrome\\application\\chrome.exe' },
      { name: 'WindowsTerminal', target: TERMINAL_EXE },
    ];
    expect(storeTargets(saved, installed)).toEqual([saved[0], { name: 'Terminal', target: 'shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }]);
    // Nothing to change, or not in Start's list: left as it is.
    expect(storeTargets([saved[0]], installed)).toBeNull();
    expect(storeTargets(saved, [])).toBeNull();
  });

  it("puts File Explorer's windows on its pinned icon, and not the shell's other windows", () => {
    const pins = [{ name: 'File Explorer', target: 'shell:AppsFolder\\Microsoft.Windows.Explorer' }];
    const wins = [win(1, 'C:\\Windows\\explorer.exe', { className: 'CabinetWClass', title: 'Downloads' }), win(2, 'C:\\Windows\\explorer.exe', { className: 'Shell_Dialog' })];
    const apps = dockApps(pins, wins, 1, new Map());
    expect(apps.map((a) => [a.name, a.windows, a.front])).toEqual([['File Explorer', [1], true]]);
  });

  it("finds a Store app's windows for a pin kept by its program's path", () => {
    const pins = [{ name: 'WindowsTerminal', target: TERMINAL_EXE }];
    const wins = [win(7, TERMINAL_EXE, { appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', appName: 'Terminal' })];
    const apps = dockApps(pins, wins, 0, new Map());
    // One place, the pinned one, with the window: not a second icon beside it.
    expect(apps.map((a) => [a.pinned, a.windows])).toEqual([[true, [7]]]);
  });

  it('names an app as Start does when all it has is its file name', () => {
    const chrome = String.raw`c:\program files\google\chrome\application\chrome.exe`;
    const start = [
      { name: 'Google Chrome', target: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` },
      { name: 'Claude', target: String.raw`C:\Users\me\AppData\Local\AnthropicClaude\claude.exe` },
    ];
    expect(startName('chrome', chrome, start)).toBe('Google Chrome');
    // Its pin points into a versioned folder: the only Start entry with that file name.
    expect(startName('claude', String.raw`c:\users\me\appdata\local\anthropicclaude\app-6.6395.0\claude.exe`, start)).toBe('Claude');
    // A name of its own stays; one Start doesn't know stays.
    expect(startName('My browser', chrome, start)).toBe('My browser');
    expect(startName('netbeans64', String.raw`c:\x\netbeans64.exe`, start)).toBe('netbeans64');
  });
});
