import { describe, expect, it } from 'vitest';
import { browserDataDir, dockApps, launchArgs, multiWindow, privateLabel, startName } from '../src/core/dock';
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

  it('offers New window only for apps that can have more than one window', () => {
    const none = new Set<string>();
    const spotify = 'shell:appsfolder\\spotifyab.spotifymusic_zpdnekdrzrea0!spotify';
    expect(multiWindow(String.raw`c:\program files\google\chrome\application\chrome.exe`, 1, none)).toBe(true);
    expect(multiWindow('shell:appsfolder\\microsoft.windows.explorer', 0, none)).toBe(true);
    expect(multiWindow('shell:appsfolder\\microsoft.windowsterminal_8wekyb3d8bbwe!app', 1, none)).toBe(true);
    expect(multiWindow('shell:appsfolder\\chrome._crx_cinhimbnkkghhklpknlkffjgod', 1, none)).toBe(true);
    // One that keeps to one window: no, unless it was seen with two (now, or before).
    expect(multiWindow(spotify, 1, none)).toBe(false);
    expect(multiWindow(spotify, 2, none)).toBe(true);
    expect(multiWindow(spotify, 0, new Set([spotify]))).toBe(true);
  });

  it("opens a browser's new window in the profile last used, so Chrome doesn't ask who is using it", () => {
    const chrome = String.raw`c:\program files\google\chrome\application\chrome.exe`;
    const edge = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
    const firefox = String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
    expect(launchArgs(chrome, 'new', 'Default')).toBe('--profile-directory="Default" --new-window');
    expect(launchArgs(chrome, undefined, 'Profile 2')).toBe('--profile-directory="Profile 2" --new-window');
    expect(launchArgs(chrome, 'private', 'Default')).toBe('--profile-directory="Default" --incognito');
    expect(launchArgs(edge, 'private', null)).toBe('--inprivate');
    expect(launchArgs(firefox, 'private', null)).toBe('-private-window');
    // A profile name that isn't a plain folder name stays off the command line.
    expect(launchArgs(chrome, 'new', '" --evil')).toBe('--new-window');
    // Other apps start as they are; they have no private window.
    expect(launchArgs('shell:AppsFolder\\Microsoft.Windows.Explorer', 'new', null)).toBe('');
    expect(launchArgs('shell:AppsFolder\\Microsoft.Windows.Explorer', 'private', null)).toBeNull();
    expect(privateLabel(chrome)).toBe('New Incognito window');
    expect(privateLabel(edge)).toBe('New InPrivate window');
    expect(privateLabel(String.raw`c:\x\spotify.exe`)).toBeNull();
    expect(browserDataDir(chrome)).toBe('Google\\Chrome');
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
