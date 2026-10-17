// Claude in the bot's chat (the bar's Claude switch, src/activities/local.ts): which backend
// answers, Claude Code (headless, on your own Claude login) or the Messages API (a key in the
// Credential Manager), chosen in Activities › Bot chat. src-tauri/src/chat.rs does the asking,
// so a key never reaches the webview and the question travels only to Claude.

import type { AskBackend, AskBackends, ChatTurn } from '../core/bridge';

export const NO_BACKEND = 'Install Claude Code, or add an Anthropic API key in Activities › Bot chat.';
/** Messages kept in a chat; the oldest go first. */
const MAX_HISTORY = 20;

/** The backend to use: the one chosen, or the other when it is the only one that works, or none. */
export function pickBackend(choice: unknown, have: AskBackends): AskBackend | null {
  const wanted: AskBackend = choice === 'api' ? 'api' : 'claude-code';
  const works = (b: AskBackend) => (b === 'api' ? have.api : have.claudeCode);
  if (works(wanted)) return wanted;
  const other: AskBackend = wanted === 'api' ? 'claude-code' : 'api';
  return works(other) ? other : null;
}

/** The chat with the newest messages kept, starting on a question. */
export function trimHistory(turns: ChatTurn[], max = MAX_HISTORY): ChatTurn[] {
  const kept = turns.slice(-max);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}
