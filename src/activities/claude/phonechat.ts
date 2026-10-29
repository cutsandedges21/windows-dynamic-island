// Talking to Claude from Island's phone app: Claude's card on a phone lists the chats, shows one
// chat's last messages with a box to message it, or starts a new chat in a recent folder. A
// message goes where its chat lives (routeFor): typed into the Island terminal it runs in, or into
// its own terminal; a VS Code chat (nobody can press Enter there from a phone) or a closed chat
// continues in an Island terminal running `claude --resume`. The pure parts are here; the
// activity (index.ts) holds the state and calls Rust.
// Design: docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md, section 2.

import type { TermInfo } from '../../remote/protocol';

/** What Claude's card shows on a phone: every chat, one chat, or a new chat in a folder. */
export type ChatPane = { kind: 'list' } | { kind: 'chat'; id: string } | { kind: 'new'; folder: string };

/** A chat a message can go to, live (the tracker sees its process) or closed. */
export interface ChatTarget {
  sessionId: string;
  cwd: string;
  entrypoint: string | null;
  /** Its Claude Code process while it runs; 0 when closed. */
  pid: number;
  alive: boolean;
}

/** Where a message goes (the spec's four cases). */
export type ChatRoute =
  /** 1. The chat runs in an Island terminal: typed into it. */
  | { how: 'term'; term: string }
  /** 2. A live terminal chat of its own: typed into its console (claudeInject). */
  | { how: 'inject'; pid: number }
  /** 3. A VS Code chat whose panel still holds it: a copy continues in an Island terminal, so the two never write over each other. */
  | { how: 'fork'; sessionId: string; cwd: string }
  /** 3. A closed chat (VS Code or a terminal's): reopened as it is, in an Island terminal. */
  | { how: 'resume'; sessionId: string; cwd: string }
  /** 4. A new chat in a folder. */
  | { how: 'new'; cwd: string };

/** The running Island terminal a process runs in: the terminal's own child, or one of its ancestors. `chain` gives a pid and its ancestors. */
export function terminalFor(pid: number, terms: readonly TermInfo[], chain: (pid: number) => number[]): TermInfo | null {
  if (!pid) return null;
  const line = chain(pid);
  return terms.find((t) => t.exit === null && t.pid > 0 && line.includes(t.pid)) ?? null;
}

/** Where a message to `chat` goes; `island` is the running Island terminal it is in, if any. */
export function routeFor(chat: ChatTarget, island: TermInfo | null): ChatRoute {
  if (chat.alive && island) return { how: 'term', term: island.id };
  if (chat.alive && chat.entrypoint !== 'claude-vscode' && chat.pid) return { how: 'inject', pid: chat.pid };
  return chat.alive ? { how: 'fork', sessionId: chat.sessionId, cwd: chat.cwd } : { how: 'resume', sessionId: chat.sessionId, cwd: chat.cwd };
}

/** The one line under the chat's box: where a message goes. */
export function routeHint(route: ChatRoute): string {
  switch (route.how) {
    case 'term':
      return 'Goes straight into the chat on your PC.';
    case 'inject':
      return 'Types it into its terminal on your PC.';
    case 'fork':
      return 'Continues on your PC in the background (a copy of the VS Code chat)';
    case 'resume':
      return 'Reopens the chat on your PC in the background';
    case 'new':
      return 'Starts Claude in this folder on your PC, in the background';
  }
}

/** A phone's text as one argument: a leading dash would read as one of claude's own options, so it gets a space first. */
export function asArgument(text: string): string {
  return text.startsWith('-') ? ` ${text}` : text;
}

/** What an Island terminal runs for a route: `claude` with these arguments (no shell, so the text is never a command line). Null: no terminal to start. */
export function claudeArgs(route: ChatRoute, text: string): string[] | null {
  switch (route.how) {
    case 'fork':
      return ['--resume', route.sessionId, '--fork-session', asArgument(text)];
    case 'resume':
      return ['--resume', route.sessionId, asArgument(text)];
    case 'new':
      return [asArgument(text)];
    default:
      return null;
  }
}

/** Text typed into a terminal as one line: a line break would be Enter, and send it early. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** The distinct folders of these chats, newest first, `max` at most (same folder: same path, any case, any trailing slash). */
export function recentFolders(items: ReadonlyArray<{ cwd: string; at: number }>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of [...items].sort((a, b) => b.at - a.at)) {
    const cwd = typeof it.cwd === 'string' ? it.cwd.trim() : '';
    if (!cwd) continue;
    const key = cwd.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cwd);
    if (out.length >= max) break;
  }
  return out;
}

/** The same message, whatever its spacing: a message sent from the phone shows as sent once its chat's transcript has it. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
  return norm(a) === norm(b);
}
