// What a Codex session file says about its chat. Codex writes one JSON line per event to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl; codex_rollout_scan (fsx.rs)
// hands over the lines that matter, a piece at a time, and foldRollout adds them to what
// was known: the chat's id and folder, its first and last prompt, Codex's last answer,
// whether a turn is running, how long turns took, how full the context is, the tokens of
// every request, and the plan's limits as of the newest reading.
// Format seen with Codex 0.158 (2026-10-30); older files said user_message/agent_message.

import { clip } from '../../core/format';
import type { RolloutLine } from '../../core/native';
import type { ChatMessage } from '../claude/transcript';

/** A prompt or a reply on the phone, at most this many characters. */
const CHAT_TEXT_MAX = 2000;
/** Finished turns kept for "done in about…". */
const TURNS_KEPT = 8;
/** Token readings kept per chat, for the week's total. */
const TOKENS_KEPT = 4000;

export interface RolloutSummary {
  id: string | null;
  cwd: string | null;
  /** Who wrote it: "Codex Desktop" (the app), the CLI's or the editor extension's name. */
  originator: string | null;
  source: string | null;
  version: string | null;
  /** The first thing the user asked, as the chat's title. */
  title: string | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
  lastAssistant: string | null;
  /** The newest line's time (ms). */
  lastActivityMs: number;
  turnOpen: boolean;
  turnStartMs: number | null;
  /** The last turn was interrupted. */
  aborted: boolean;
  /** An error the last turn ran into. */
  error: string | null;
  /** How long finished turns took (ms), oldest first. */
  turns: number[];
  context: { used: number; window: number } | null;
  /** The plan's limits as Codex last read them, and when. */
  limits: { at: number; raw: unknown } | null;
  /** Every model request's tokens. */
  tokens: Array<{ at: number; input: number; cached: number; output: number }>;
  /** The last command or tool Codex ran. */
  lastTool: { name: string; detail: string } | null;
}

export function emptySummary(): RolloutSummary {
  return {
    id: null, cwd: null, originator: null, source: null, version: null, title: null, lastPrompt: null, lastPromptAt: null, lastAssistant: null,
    lastActivityMs: 0, turnOpen: false, turnStartMs: null, aborted: false, error: null, turns: [], context: null, limits: null, tokens: [], lastTool: null,
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Codex hands the model some context as user messages (the environment, AGENTS.md, skills):
 * not what the user typed. Its tags have an underscore or a space in the name
 * (<environment_context>, <permissions instructions>); a prompt starting with <div> is the user's.
 */
export function isContextText(text: string): boolean {
  const t = text.trimStart();
  return /^<[a-z]+(_[a-z]+)+>|^<[a-z]+ [a-z]+>/i.test(t) || t.startsWith('# AGENTS.md instructions');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The text of a response_item message (its text parts, joined). */
function messageText(payload: Obj): string {
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => str(obj(c)?.text) ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** What a tool call did, in a few words: the command for a shell, else the tool's name. */
function toolDetail(payload: Obj): { name: string; detail: string } | null {
  const name = str(payload.name);
  if (!name) return null;
  let args: Obj | null = null;
  try {
    args = obj(JSON.parse(str(payload.arguments) ?? 'null'));
  } catch {
    args = null;
  }
  const cmd = args?.cmd ?? args?.command;
  const detail = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.filter((x) => typeof x === 'string').join(' ') : name;
  return { name, detail: clip(oneLine(detail), 200) };
}

function prompt(s: RolloutSummary, text: string, at: number): RolloutSummary {
  const t = text.trim();
  if (!t || isContextText(t)) return s;
  return { ...s, title: s.title ?? clip(oneLine(t), 120), lastPrompt: clip(oneLine(t), 300), lastPromptAt: at };
}

/** `s` with these lines added (lines in the order Codex wrote them). */
export function foldRollout(start: RolloutSummary, lines: RolloutLine[]): RolloutSummary {
  let s = start;
  for (const line of lines) {
    const p = obj(line.payload);
    if (!p) continue;
    const at = Date.parse(line.timestamp ?? '') || 0;
    const type = str(p.type);
    let used = true;
    if (line.type === 'session_meta') {
      s = { ...s, id: str(p.id) ?? s.id, cwd: str(p.cwd) ?? s.cwd, originator: str(p.originator) ?? s.originator, source: str(p.source) ?? s.source, version: str(p.cli_version) ?? s.version };
    } else if (line.type === 'event_msg') {
      if (type === 'task_started') {
        const started = num(p.started_at);
        s = { ...s, turnOpen: true, turnStartMs: started ? started * 1000 : at, aborted: false, error: null };
      } else if (type === 'task_complete') {
        const ms = num(p.duration_ms) || (s.turnStartMs ? Math.max(0, at - s.turnStartMs) : 0);
        const said = str(p.last_agent_message);
        s = { ...s, turnOpen: false, turns: ms ? [...s.turns, ms].slice(-TURNS_KEPT) : s.turns, lastAssistant: said?.trim() ? said.trim() : s.lastAssistant };
      } else if (type === 'turn_aborted') {
        s = { ...s, turnOpen: false, aborted: true };
      } else if (type === 'error') {
        s = { ...s, error: str(p.message) ?? 'Codex ran into an error' };
      } else if (type === 'token_count') {
        const info = obj(p.info);
        const last = obj(info?.last_token_usage);
        let next = s;
        if (last) {
          const reading = { at, input: num(last.input_tokens), cached: num(last.cached_input_tokens), output: num(last.output_tokens) };
          const window = num(info?.model_context_window);
          next = { ...next, tokens: [...next.tokens, reading].slice(-TOKENS_KEPT), context: window ? { used: num(last.total_tokens), window } : next.context };
        }
        if (p.rate_limits && typeof p.rate_limits === 'object') next = { ...next, limits: { at, raw: p.rate_limits } };
        s = next;
      } else if (type === 'user_message') {
        s = prompt(s, str(p.message) ?? '', at);
      } else if (type === 'agent_message') {
        const said = str(p.message)?.trim();
        if (said) s = { ...s, lastAssistant: said };
      } else used = false;
    } else if (line.type === 'response_item') {
      if (type === 'message' && p.role === 'user') s = prompt(s, messageText(p), at);
      else if (type === 'message' && p.role === 'assistant') {
        const said = messageText(p);
        if (said) s = { ...s, lastAssistant: said };
      } else if (type === 'function_call') s = { ...s, lastTool: toolDetail(p) ?? s.lastTool };
      else used = false;
    } else used = false;
    if (used && at > s.lastActivityMs) s = { ...s, lastActivityMs: at };
  }
  return s;
}

/** Tokens since `since` (ms) across chats: fresh (input not read from cache, plus output), cache reads, output. */
export function weekTokens(chats: RolloutSummary[], since: number): { fresh: number; cached: number; output: number } {
  const out = { fresh: 0, cached: 0, output: 0 };
  for (const c of chats) {
    for (const t of c.tokens) {
      if (t.at < since) continue;
      out.fresh += Math.max(0, t.input - t.cached) + t.output;
      out.cached += t.cached;
      out.output += t.output;
    }
  }
  return out;
}

/**
 * The last `max` messages of a chat, oldest first: what the user typed, what Codex answered,
 * and one line per command. Older files said the same thing twice (a message and an event):
 * the events count only when a file has no messages.
 */
export function chatMessages(lines: RolloutLine[], max: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  const hasItems = lines.some((l) => l.type === 'response_item' && obj(l.payload)?.type === 'message');
  lines.forEach((line, n) => {
    const p = obj(line.payload);
    if (!p) return;
    const at = Date.parse(line.timestamp ?? '') || 0;
    const key = `${n}:${at}`;
    const type = str(p.type);
    let kind: ChatMessage['kind'] | null = null;
    let text = '';
    if (line.type === 'response_item' && type === 'message') {
      text = messageText(p);
      kind = p.role === 'user' ? (isContextText(text) ? null : 'you') : p.role === 'assistant' ? 'claude' : null;
    } else if (line.type === 'response_item' && type === 'function_call') {
      const tool = toolDetail(p);
      if (tool) {
        kind = 'tool';
        text = tool.detail === tool.name ? `Used ${tool.name}` : `Ran ${tool.detail}`;
      }
    } else if (!hasItems && line.type === 'event_msg' && (type === 'user_message' || type === 'agent_message')) {
      text = str(p.message) ?? '';
      kind = type === 'user_message' ? 'you' : 'claude';
    } else if (line.type === 'event_msg' && type === 'error') {
      kind = 'note';
      text = clip(str(p.message) ?? 'Codex ran into an error.', 200);
    }
    if (kind && text.trim()) out.push({ key, kind, text: clip(text.trim(), CHAT_TEXT_MAX), at });
  });
  return out.slice(-max);
}
