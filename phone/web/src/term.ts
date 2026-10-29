// The terminal's pure parts (screens/terminal.ts draws it): what the keys on the bar above the
// keyboard send, Ctrl put on a typed key, the font size kept on this phone, which terminal to
// show, a finger's drag in lines, and the words for shells and folders. No DOM.

import type { TermInfo, TermShell } from '../../../src/remote/protocol';

/** The keys on the bar that send something to the PC. */
export type BarKey = 'esc' | 'tab' | 'up' | 'down' | 'right' | 'left' | 'ctrl-c';

const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' } as const;

/**
 * What a bar key sends. Arrows follow the cursor-keys mode the program asked for (`ESC O A` in
 * application mode, which vim and less ask for; `ESC [ A` otherwise); with Ctrl they are
 * `ESC [1;5A`, what a PC keyboard sends for Ctrl+↑.
 */
export function barKey(key: BarKey, mods: { ctrl?: boolean; appCursor?: boolean } = {}): string {
  switch (key) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'ctrl-c':
      return '\x03';
    default: {
      const c = ARROW[key];
      if (mods.ctrl) return `\x1b[1;5${c}`;
      return mods.appCursor ? `\x1bO${c}` : `\x1b[${c}`;
    }
  }
}

/** The marks and digits that have a control code of their own with Ctrl, as on a PC keyboard. */
const CTRL_MARKS: Record<string, number> = { '@': 0, ' ': 0, '2': 0, '[': 27, '3': 27, '\\': 28, '4': 28, ']': 29, '5': 29, '^': 30, '6': 30, '_': 31, '-': 31, '/': 31, '7': 31, '?': 127, '8': 127 };

/**
 * One typed key with Ctrl (the bar's sticky Ctrl): a letter becomes its control code (Ctrl+C is
 * 0x03), and so do the marks and digits that have one. Anything else (Enter, a word the keyboard
 * put in at once, an emoji) goes as it was typed.
 */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return String.fromCharCode(c & 0x1f);
  const mark = CTRL_MARKS[data];
  return mark === undefined ? data : String.fromCharCode(mark);
}

// ---------------------------------------------------------------- sizes

export const FONT_DEFAULT = 12;
export const FONT_MIN = 8;
export const FONT_MAX = 22;

export function clampFont(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

/** The font size kept in localStorage; the default for anything missing or broken. */
export function readFont(raw: string | null): number {
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? clampFont(n) : FONT_DEFAULT;
}

/** Columns and rows as the PC takes them: whole numbers from 1 to 500 (80×24 when not measured yet). */
export function termSize(cols: number | undefined, rows: number | undefined): { cols: number; rows: number } {
  const one = (v: number | undefined, dflt: number) => (v !== undefined && Number.isFinite(v) && v >= 1 ? Math.min(500, Math.floor(v)) : dflt);
  return { cols: one(cols, 80), rows: one(rows, 24) };
}

/**
 * Lines a finger's drag scrolls by: whole rows of `rowPx` in the distance dragged so far (`px`,
 * downward positive), and what is left over for the next move. Dragging down shows older lines,
 * so it scrolls up (negative).
 */
export function dragLines(px: number, rowPx: number): { lines: number; rest: number } {
  if (!(rowPx > 0) || !Number.isFinite(px)) return { lines: 0, rest: 0 };
  const n = Math.trunc(px / rowPx);
  return { lines: n === 0 ? 0 : -n, rest: px - n * rowPx };
}

// ---------------------------------------------------------------- which one, and its words

/**
 * The terminal to show when the screen opens or the one showing goes away: the one this phone
 * showed last if it is still there, else the newest still running, else the newest. Null: none.
 */
export function pickTerm(items: readonly TermInfo[], last: string | null): string | null {
  if (last && items.some((t) => t.id === last)) return last;
  const newest = (list: readonly TermInfo[]) => list.reduce<TermInfo | null>((best, t) => (!best || t.started > best.started ? t : best), null);
  return (newest(items.filter((t) => t.exit === null)) ?? newest(items))?.id ?? null;
}

/** Tabs in the order the terminals were opened. */
export function tabOrder(items: readonly TermInfo[]): TermInfo[] {
  return [...items].sort((a, b) => a.started - b.started || a.id.localeCompare(b.id));
}

export type ShellId = TermShell;

/** The shells the + sheet offers on a Windows PC. */
export const SHELLS: ReadonlyArray<{ id: ShellId; label: string }> = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'bash', label: 'Git Bash' },
];

export function isShell(v: unknown): v is ShellId {
  return v === 'powershell' || v === 'cmd' || v === 'bash';
}

/** A shell's name for people: Windows' by their own names, a Mac's as they are ("zsh"). */
export function shellLabel(shell: string, platform: 'windows' | 'macos' = 'windows'): string {
  if (platform === 'windows') {
    const known = SHELLS.find((s) => s.id === shell);
    if (known) return known.label;
  }
  return shell;
}

/** The last part of a path, Windows or Unix ("C:\Users\Moss\island" → "island"); a root as it is. */
export function folderName(path: string): string {
  const t = path.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  const name = i >= 0 ? t.slice(i + 1) : t;
  return name && !/^[A-Za-z]:$/.test(name) ? name : path;
}

/** A tab's words: the terminal's title, else its folder's name, else its shell's. */
export function tabTitle(t: Pick<TermInfo, 'title' | 'cwd' | 'shell'>, platform: 'windows' | 'macos' = 'windows'): string {
  return t.title.trim() || (t.cwd ? folderName(t.cwd) : '') || shellLabel(t.shell, platform) || 'Terminal';
}

/** Written into the terminal when its program ends, dimmed, on a line of its own. */
export function endedLine(code: number | null): string {
  return `\r\n\x1b[0;2m[Ended${code === null ? '' : `, exit code ${code}`}]\x1b[0m\r\n`;
}
