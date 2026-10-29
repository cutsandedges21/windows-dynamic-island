import { describe, expect, it } from 'vitest';
import type { TermInfo } from '../src/remote/protocol';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, SHELLS, barKey, clampFont, dragLines, endedLine, folderName, isShell, pickTerm, readFont, shellLabel, tabOrder, tabTitle, termSize, withCtrl } from '../phone/web/src/term';

const info = (id: string, started: number, exit: number | null, more: Partial<TermInfo> = {}): TermInfo => ({
  id,
  title: '',
  cwd: 'C:\\Users\\Moss',
  shell: 'powershell',
  pid: 100,
  started,
  exit,
  attached: 0,
  claude: false,
  ...more,
});

describe("the terminal's key bar", () => {
  it('sends Esc, Tab and ^C as a PC keyboard does', () => {
    expect(barKey('esc')).toBe('\x1b');
    expect(barKey('tab')).toBe('\t');
    expect(barKey('ctrl-c')).toBe('\x03');
    // Ctrl with them changes nothing.
    expect(barKey('esc', { ctrl: true })).toBe('\x1b');
    expect(barKey('tab', { ctrl: true })).toBe('\t');
  });

  it('sends the arrows in the mode the program asked for', () => {
    expect([barKey('up'), barKey('down'), barKey('right'), barKey('left')]).toEqual(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
    // Application cursor keys (vim, less): ESC O.
    expect([barKey('up', { appCursor: true }), barKey('down', { appCursor: true }), barKey('right', { appCursor: true }), barKey('left', { appCursor: true })]).toEqual(['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD']);
  });

  it('sends Ctrl+arrow as a PC keyboard does, in either mode', () => {
    expect(barKey('up', { ctrl: true })).toBe('\x1b[1;5A');
    expect(barKey('left', { ctrl: true, appCursor: true })).toBe('\x1b[1;5D');
    expect(barKey('right', { ctrl: true })).toBe('\x1b[1;5C');
    expect(barKey('down', { ctrl: true })).toBe('\x1b[1;5B');
  });

  it('puts the sticky Ctrl on the next letter typed', () => {
    expect(withCtrl('c')).toBe('\x03');
    expect(withCtrl('C')).toBe('\x03');
    expect(withCtrl('a')).toBe('\x01');
    expect(withCtrl('d')).toBe('\x04');
    expect(withCtrl('l')).toBe('\x0c');
    expect(withCtrl('r')).toBe('\x12');
    expect(withCtrl('z')).toBe('\x1a');
  });

  it('and on the marks and digits that have a control code', () => {
    expect(withCtrl('[')).toBe('\x1b');
    expect(withCtrl('3')).toBe('\x1b');
    expect(withCtrl('\\')).toBe('\x1c');
    expect(withCtrl(']')).toBe('\x1d');
    expect(withCtrl('^')).toBe('\x1e');
    expect(withCtrl('_')).toBe('\x1f');
    expect(withCtrl('/')).toBe('\x1f');
    expect(withCtrl('@')).toBe('\x00');
    expect(withCtrl(' ')).toBe('\x00');
    expect(withCtrl('?')).toBe('\x7f');
  });

  it('leaves alone what Ctrl means nothing for', () => {
    expect(withCtrl('\r')).toBe('\r');
    expect(withCtrl('1')).toBe('1');
    expect(withCtrl('é')).toBe('é');
    // A word the keyboard put in at once, an emoji (two UTF-16 units), a paste.
    expect(withCtrl('hello')).toBe('hello');
    expect(withCtrl('😀')).toBe('😀');
    expect(withCtrl('')).toBe('');
  });
});

describe("the terminal's sizes", () => {
  it('keeps the text size within its range', () => {
    expect(readFont(null)).toBe(FONT_DEFAULT);
    expect(FONT_DEFAULT).toBe(12);
    expect(readFont('')).toBe(FONT_DEFAULT);
    expect(readFont('huge')).toBe(FONT_DEFAULT);
    expect(readFont('14')).toBe(14);
    expect(readFont('13.6')).toBe(14);
    expect(readFont('3')).toBe(FONT_MIN);
    expect(readFont('99')).toBe(FONT_MAX);
    expect(clampFont(FONT_MAX + 1)).toBe(FONT_MAX);
    expect(clampFont(FONT_MIN - 1)).toBe(FONT_MIN);
  });

  it('tells the PC whole columns and rows from 1 to 500', () => {
    expect(termSize(44, 30)).toEqual({ cols: 44, rows: 30 });
    expect(termSize(44.9, 30.2)).toEqual({ cols: 44, rows: 30 });
    expect(termSize(9000, 9000)).toEqual({ cols: 500, rows: 500 });
    expect(termSize(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
    expect(termSize(0, NaN)).toEqual({ cols: 80, rows: 24 });
  });

  it('turns a finger drag into whole lines, carrying the rest', () => {
    // Down by two and a bit rows: two lines up (older output), the bit kept.
    expect(dragLines(35, 16)).toEqual({ lines: -2, rest: 3 });
    expect(dragLines(-20, 16)).toEqual({ lines: 1, rest: -4 });
    expect(dragLines(10, 16)).toEqual({ lines: 0, rest: 10 });
    expect(dragLines(-10, 16)).toEqual({ lines: 0, rest: -10 });
    expect(dragLines(50, 0)).toEqual({ lines: 0, rest: 0 });
    // Carried rests add up to the next line.
    const a = dragLines(12, 16);
    expect(dragLines(a.rest + 12, 16)).toEqual({ lines: -1, rest: 8 });
  });
});

describe('which terminal shows', () => {
  const items = [info('old', 1, null), info('new', 3, null), info('done', 5, 0)];

  it('the one this phone showed last, while it is there', () => {
    expect(pickTerm(items, 'old')).toBe('old');
    expect(pickTerm(items, 'done')).toBe('done');
  });

  it('else the newest still running, else the newest', () => {
    expect(pickTerm(items, null)).toBe('new');
    expect(pickTerm(items, 'gone')).toBe('new');
    expect(pickTerm([info('a', 1, 0), info('b', 2, 1)], null)).toBe('b');
    expect(pickTerm([], 'gone')).toBeNull();
  });

  it('lists tabs in the order they were opened', () => {
    expect(tabOrder([info('b', 2, null), info('a', 1, null), info('c', 2, null)]).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe("the terminal's words", () => {
  it("names the shells by their Windows names, a Mac's as they are", () => {
    expect(SHELLS.map((s) => s.label)).toEqual(['PowerShell', 'Command Prompt', 'Git Bash']);
    expect(shellLabel('powershell')).toBe('PowerShell');
    expect(shellLabel('cmd')).toBe('Command Prompt');
    expect(shellLabel('bash')).toBe('Git Bash');
    expect(shellLabel('bash', 'macos')).toBe('bash');
    expect(shellLabel('zsh', 'macos')).toBe('zsh');
    expect(isShell('cmd')).toBe(true);
    expect(isShell('zsh')).toBe(false);
  });

  it("gives a folder's name from a Windows or a Unix path", () => {
    expect(folderName('C:\\Users\\Moss\\Projects\\island')).toBe('island');
    expect(folderName('C:\\Users\\Moss\\Projects\\island\\')).toBe('island');
    expect(folderName('/Users/moss/code/app')).toBe('app');
    expect(folderName('C:\\')).toBe('C:\\');
    expect(folderName('/')).toBe('/');
    expect(folderName('~')).toBe('~');
  });

  it("titles a tab by the terminal's title, else its folder, else its shell", () => {
    expect(tabTitle({ title: 'npm test', cwd: 'C:\\x\\y', shell: 'cmd' })).toBe('npm test');
    expect(tabTitle({ title: '  ', cwd: 'C:\\x\\island', shell: 'cmd' })).toBe('island');
    expect(tabTitle({ title: '', cwd: '', shell: 'cmd' })).toBe('Command Prompt');
    expect(tabTitle({ title: '', cwd: '', shell: '' })).toBe('Terminal');
  });

  it('says when a program ended, on a line of its own', () => {
    expect(endedLine(0)).toBe('\r\n\x1b[0;2m[Ended, exit code 0]\x1b[0m\r\n');
    expect(endedLine(null)).toBe('\r\n\x1b[0;2m[Ended]\x1b[0m\r\n');
  });
});
