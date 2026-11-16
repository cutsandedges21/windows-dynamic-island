// Where a Codex chat is opened, continued and messaged, by where it lives: the Codex app
// (codex://threads/<id>, OpenAI's documented link), an editor's Codex panel (no link to a chat
// exists: the editor comes forward and the text goes on the clipboard), or a terminal (typed
// into while it runs, `codex resume <id>` once it is closed).

import type { ChatRoute } from '../claude/phonechat';

export type OpenRoute = 'app' | 'editor' | 'terminal' | 'resume';

export interface CodexChat {
  sessionId: string;
  cwd: string;
  entrypoint: string | null;
  /** Its codex.exe while it runs; 0 when closed or unknown. */
  pid: number;
  alive: boolean;
}

export function openRoute(chat: CodexChat): OpenRoute {
  if (chat.entrypoint === 'codex-app') return 'app';
  if (chat.entrypoint === 'codex-editor') return 'editor';
  return chat.alive && chat.pid > 0 ? 'terminal' : 'resume';
}

/** The Codex app's link to one of its chats. */
export function threadUrl(sessionId: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? `codex://threads/${sessionId.toLowerCase()}` : null;
}

/**
 * Where a phone's message goes. `island`: the Island terminal it runs in, if any. A chat the
 * app or an editor holds continues as a copy in an Island terminal (`codex fork`), so the two
 * never write over each other; a closed one is resumed as it is.
 */
export function chatRoute(chat: CodexChat, island: { id: string } | null): ChatRoute {
  if (chat.alive && island) return { how: 'term', term: island.id };
  const route = openRoute(chat);
  if (route === 'terminal') return { how: 'inject', pid: chat.pid };
  if (chat.alive) return { how: 'fork', sessionId: chat.sessionId, cwd: chat.cwd };
  return { how: 'resume', sessionId: chat.sessionId, cwd: chat.cwd };
}

/** A phone's text as one argument: a leading dash would read as one of codex's own options. */
function asArgument(text: string): string {
  return text.startsWith('-') ? ` ${text}` : text;
}

/** What an Island terminal runs (after the codex program) for a route; null: nothing to start. */
export function codexArgs(route: ChatRoute, text: string): string[] | null {
  switch (route.how) {
    case 'fork':
      return ['fork', route.sessionId, asArgument(text)];
    case 'resume':
      return ['resume', route.sessionId, asArgument(text)];
    case 'new':
      return [asArgument(text)];
    default:
      return null;
  }
}

/** The line under a phone's chat box. */
export function codexRouteHint(route: ChatRoute): string {
  switch (route.how) {
    case 'term':
      return 'Goes straight into the chat on your PC.';
    case 'inject':
      return 'Types it into its terminal on your PC.';
    case 'fork':
      return 'Continues on your PC in the background (a copy of the chat)';
    case 'resume':
      return 'Reopens the chat on your PC in the background';
    case 'new':
      return 'Starts Codex in this folder on your PC, in the background';
  }
}
