// Cursor's agent transcripts: ~/.cursor/projects/<folder slug>/agent-transcripts/<chat id>/<chat id>.jsonl.
// One line per message, {role, message: {content: [{type: 'text', text} | {type: 'tool_use', name, input}]}},
// and {type: 'turn_ended', status: 'success' | 'error'} when a turn ends. Lines carry no time: the
// file's own time is the chat's last activity. A user's text is wrapped in <user_query> (with a
// <timestamp> before it now and then); hidden thinking shows as "[REDACTED]".

import { clip } from '../../core/format';
import type { ChatMessage } from '../claude/transcript';

export interface CursorLine {
  role?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
  type?: string;
  status?: string;
}

export interface TranscriptSummary {
  /** The chat's first request, as the user typed it. */
  title: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  /** A request after the last turn ended: Cursor is (or was, when it stopped writing) working on it. */
  turnOpen: boolean;
  /** The last turn ended with an error. */
  error: boolean;
  /** What the agent last did, e.g. "Ran npm test". */
  lastTool: string | null;
  turns: number;
}

const CHAT_TEXT_MAX = 2000;

export function parseLines(text: string): CursorLine[] {
  const out: CursorLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object') out.push(v as CursorLine);
    } catch {
      /* a line being written */
    }
  }
  return out;
}

/** What the user typed, without Cursor's wrapping. */
export function userText(raw: string): string {
  const text = raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  const query = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(text);
  return (query ? query[1] : text).trim();
}

function texts(line: CursorLine): string[] {
  return (line.message?.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!.trim());
}

function said(line: CursorLine): string {
  return texts(line)
    .filter((t) => t && t !== '[REDACTED]')
    .join('\n\n')
    .trim();
}

/** "Ran npm test", "Read island.ts", "Used Glob". */
export function toolLine(name: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
  if (name === 'Shell' && s('command')) return `Ran ${clip(s('command').replace(/\s+/g, ' '), 80)}`;
  if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'StrReplace') && s('path')) return `${name === 'Read' ? 'Read' : 'Edited'} ${base(s('path'))}`;
  return `Used ${name}`;
}

export function summarize(lines: CursorLine[]): TranscriptSummary {
  const s: TranscriptSummary = { title: null, lastPrompt: null, lastAssistant: null, turnOpen: false, error: false, lastTool: null, turns: 0 };
  for (const line of lines) {
    if (line.type === 'turn_ended') {
      s.turnOpen = false;
      s.error = line.status === 'error';
      s.turns++;
      continue;
    }
    if (line.role === 'user') {
      const text = userText(texts(line).join('\n'));
      if (!text) continue;
      const one = clip(text.replace(/\s+/g, ' '), 300);
      s.title ??= one;
      s.lastPrompt = one;
      s.turnOpen = true;
      s.error = false;
      s.lastTool = null;
    } else if (line.role === 'assistant') {
      const t = said(line);
      if (t) s.lastAssistant = t;
      for (const c of line.message?.content ?? []) if (c.type === 'tool_use' && c.name) s.lastTool = toolLine(c.name, c.input);
    }
  }
  return s;
}

/** The chat's messages for the phone's chat view, oldest first, the last `max`. */
export function chatMessages(lines: CursorLine[], max: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  lines.forEach((line, n) => {
    if (line.type === 'turn_ended') {
      if (line.status === 'error') out.push({ key: `${n}`, kind: 'note', text: 'Cursor ran into an error.', at: 0 });
      return;
    }
    if (line.role === 'user') {
      const text = userText(texts(line).join('\n'));
      if (text) out.push({ key: `${n}`, kind: 'you', text: clip(text, CHAT_TEXT_MAX), at: 0 });
    } else if (line.role === 'assistant') {
      const text = said(line);
      if (text) out.push({ key: `${n}`, kind: 'claude', text: clip(text, CHAT_TEXT_MAX), at: 0 });
      (line.message?.content ?? []).forEach((c, i) => {
        if (c.type === 'tool_use' && c.name) out.push({ key: `${n}:${i}`, kind: 'tool', text: toolLine(c.name, c.input), at: 0 });
      });
    }
  });
  return out.slice(-max);
}

/** The chat id of a transcript path (its file name). */
export function idFromPath(path: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/** Cursor's workspace_roots entries are URI paths ("/c:/Users/me/app"): a Windows path from one. */
export function folderOf(root: string | undefined | null): string {
  if (!root) return '';
  let p = root;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* already plain */
  }
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\');
  return p;
}
