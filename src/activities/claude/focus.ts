// Switching: raise the window hosting a session, focus its editor tab or
// Windows Terminal tab, or resume a closed session. Copied from Usage Clip's
// focus.js; the Win32 calls go through the Rust bridge instead of koffi.

import { native, type WindowRow } from '../../core/native';
import { platform } from '../../core/platform';
import { IGNORED_ANCESTOR_NAMES, TERMINAL_WINDOW_OWNERS, type ProcessProbe } from './procinfo';
import { isUuid, projectName } from './status';

const MIN_TERMINAL_TITLE = 3;
export const EDITOR_SCHEMES = new Map([
  ['VS Code', 'vscode'],
  ['VS Code Insiders', 'vscode-insiders'],
  ['VSCodium', 'vscodium'],
  ['Cursor', 'cursor'],
  ['Windsurf', 'windsurf'],
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** First candidate (nearest first) owning windows wins; prefer a title naming the project. */
export function selectWindow(windows: WindowRow[], candidatePids: number[], project: string | null): number | null {
  const needle = String(project || '').toLowerCase();
  for (const pid of candidatePids) {
    const owned = windows.filter((w) => w.pid === pid);
    if (!owned.length) continue;
    if (needle) {
      const hit = owned.find((w) => w.title.toLowerCase().includes(needle));
      if (hit) return hit.hwnd;
    }
    return owned[0].hwnd;
  }
  return null;
}

/** A terminal/console-host window whose title contains the session title. */
export function selectTerminalWindow(windows: WindowRow[], ownerName: (pid: number) => string | null, titles: Array<string | null>): number | null {
  for (const raw of titles) {
    const needle = String(raw || '').trim().toLowerCase();
    if (needle.length < MIN_TERMINAL_TITLE) continue;
    const hit = windows.find((w) => TERMINAL_WINDOW_OWNERS.has(ownerName(w.pid) ?? '') && w.title.toLowerCase().includes(needle));
    if (hit) return hit.hwnd;
  }
  return null;
}

/**
 * The chats a window's title names. A terminal's title is its showing tab's, and Claude Code
 * titles its tab with the chat's title after a status mark ("✳ Fix the parser"). Only the longest
 * title found counts, so a chat called "Island" is not taken for one called "Island plan B".
 */
export function chatsShownIn<T extends { title: string | null; name: string }>(windowTitle: string, chats: T[]): T[] {
  const hay = windowTitle.toLowerCase();
  let best = 0;
  let shown: T[] = [];
  for (const chat of chats) {
    const found = [chat.title, chat.name].map((t) => String(t || '').trim().toLowerCase()).filter((t) => t.length >= MIN_TERMINAL_TITLE && hay.includes(t));
    const len = Math.max(0, ...found.map((t) => t.length));
    if (!len || len < best) continue;
    if (len > best) shown = [];
    best = len;
    shown.push(chat);
  }
  return shown;
}

type Parkable = { id: string; kind: string; alive: boolean; jobId?: string | null; parkedJobId?: string | null };

/**
 * The chat whose terminal shows this background job: Claude Code runs a chat sent to the
 * background (or parked) as a job of its own, with no window, and the chat it was parked from
 * says so (its parkedJobId) while its tab shows the job's work. Null for anything else.
 */
export function viewerOf<T extends Parkable>(s: T | null | undefined, sessions: T[]): T | null {
  if (s?.kind !== 'bg') return null;
  const job = s.jobId || s.id.slice(0, 8);
  return sessions.find((x) => x.id !== s.id && x.kind !== 'bg' && x.alive && x.parkedJobId === job) ?? null;
}

/**
 * The Claude Code extension's own deep link. With `prompt`, the chat opens
 * with that prompt (how Continue Session reaches editor chats).
 */
export function deepLink(host: string | null, sessionId: string, prompt?: string): string | null {
  if (!isUuid(sessionId)) return null;
  const scheme = EDITOR_SCHEMES.get(host ?? '') || 'vscode';
  const base = `${scheme}://anthropic.claude-code/open?session=${sessionId.toLowerCase()}`;
  return prompt ? `${base}&prompt=${encodeURIComponent(prompt)}` : base;
}

export interface FocusTarget {
  sessionId: string;
  pid: number;
  cwd: string;
  title: string | null;
  name: string;
  entrypoint: string | null;
  host: string | null;
}

/** Raise a live session's window and focus its tab. */
export async function focusSession(session: FocusTarget, probe: ProcessProbe, log: (...p: unknown[]) => void): Promise<boolean> {
  probe.load(await native.procSnapshot());
  const candidates = [session.pid, ...probe.ancestors(session.pid).filter((a) => !IGNORED_ANCESTOR_NAMES.has(a.name)).map((a) => a.pid)];
  const windows = await native.winEnum();
  const titles = [session.title, session.name];

  let hwnd = selectWindow(windows, candidates, projectName(session.cwd));
  if (hwnd == null) hwnd = selectTerminalWindow(windows, (pid) => probe.processName(pid), titles);

  const target = windows.find((w) => w.hwnd === hwnd);
  const owner = target ? probe.processName(target.pid) : null;
  let focused = hwnd != null && (await native.activate(hwnd));
  log('focus', { session: session.sessionId, window: target ? target.title : null, owner, activated: focused });

  if (session.entrypoint === 'claude-vscode') {
    const url = deepLink(session.host, session.sessionId);
    if (url) {
      if (focused) await sleep(300);
      await native.allowForeground();
      if (await native.openUrl(url)) focused = true;
    }
    return focused;
  }

  // A Mac: the chat's Terminal or iTerm tab, found by the chat's terminal device.
  if (platform === 'macos') return (await native.macFocusChat(session.pid)) || focused;

  // Windows Terminal shows only the active tab's title, so the session's tab
  // may be hidden behind another. Pick it by name (best effort).
  const wtRunning = probe.isRunning('windowsterminal.exe');
  if (owner === 'windowsterminal.exe' || (hwnd == null && wtRunning)) {
    for (const title of titles) {
      if (!title) continue;
      const tabWindow = await native.selectTerminalTab(title);
      if (tabWindow) {
        if (hwnd == null) focused = await native.activate(tabWindow);
        break;
      }
    }
  }
  return focused;
}

/** Waits (briefly) until Alt/Shift are released, so a hotkey's target is not activated with modifiers held. */
export async function afterModifiersReleased(maxMs = 800): Promise<void> {
  const start = Date.now();
  while ((await native.modifiersDown()) && Date.now() - start < maxMs) await sleep(20);
}
