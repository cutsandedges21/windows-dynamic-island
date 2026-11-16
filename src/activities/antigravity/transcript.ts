// Antigravity's transcripts: ~/.gemini/<antigravity | antigravity-cli | antigravity-ide>/brain/<conversation id>/
// .system_generated/logs/transcript.jsonl. One step per line, as Antigravity's own docs describe it:
// step_index, source (USER_EXPLICIT | MODEL | SYSTEM), type (USER_INPUT is a request,
// PLANNER_RESPONSE the agent's answer and tool calls), status (DONE | ERROR), created_at (ISO),
// content, thinking, tool_calls; long fields are cut (truncated_fields), which is fine for Island.

import { clip } from '../../core/format';
import type { ChatMessage } from '../claude/transcript';

export interface AgStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  tool_calls?: unknown;
}

export interface AgSummary {
  title: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  /** A request without a final answer after it: Antigravity is (or was, when it stopped writing) on it. */
  turnOpen: boolean;
  /** The last step failed. */
  error: boolean;
  lastTool: string | null;
  /** The newest step's time (ms); 0 when no step has one. */
  lastActivityMs: number;
  turnStartMs: number | null;
}

const CHAT_TEXT_MAX = 2000;

export function parseSteps(text: string): AgStep[] {
  const out: AgStep[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object') out.push(v as AgStep);
    } catch {
      /* a line being written */
    }
  }
  return out;
}

/** A step's text: a string, or the text parts of a list. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n').trim();
  return '';
}

interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** Tool calls in whichever shape a step holds them ({name, args}, {tool_name, arguments}, {function: {…}}). */
export function callsOf(step: AgStep): Call[] {
  if (!Array.isArray(step.tool_calls)) return [];
  const out: Call[] = [];
  for (const raw of step.tool_calls) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const fn = c.function && typeof c.function === 'object' ? (c.function as Record<string, unknown>) : null;
    const name = [c.name, c.tool_name, fn?.name].find((x): x is string => typeof x === 'string' && x.length > 0);
    if (!name) continue;
    let args: unknown = c.args ?? c.arguments ?? c.input ?? fn?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        args = {};
      }
    }
    out.push({ name, args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {} });
  }
  return out;
}

/** "Ran npm test", "Read island.ts", "Used browser_open". */
export function toolLine(call: Call): string {
  const s = (k: string) => (typeof call.args[k] === 'string' ? (call.args[k] as string).trim() : '');
  const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
  if (call.name === 'run_command' && s('CommandLine')) return `Ran ${clip(s('CommandLine').replace(/\s+/g, ' '), 80)}`;
  const file = s('AbsolutePath') || s('TargetFile') || s('FilePath') || s('path');
  if (file && /^view_file|read/.test(call.name)) return `Read ${base(file)}`;
  if (file && /edit|write|replace|create/.test(call.name)) return `Edited ${base(file)}`;
  return `Used ${call.name}`;
}

const isRequest = (s: AgStep) => s.type === 'USER_INPUT' || (s.source === 'USER_EXPLICIT' && s.type !== 'PLANNER_RESPONSE');
const isAnswer = (s: AgStep) => s.type === 'PLANNER_RESPONSE';

export function summarize(steps: AgStep[]): AgSummary {
  const s: AgSummary = { title: null, lastPrompt: null, lastAssistant: null, turnOpen: false, error: false, lastTool: null, lastActivityMs: 0, turnStartMs: null };
  for (const step of steps) {
    const at = Date.parse(step.created_at ?? '') || 0;
    if (at > s.lastActivityMs) s.lastActivityMs = at;
    if (step.status === 'ERROR') s.error = true;
    if (isRequest(step)) {
      const text = textOf(step.content);
      if (!text) continue;
      const one = clip(text.replace(/\s+/g, ' '), 300);
      s.title ??= one;
      s.lastPrompt = one;
      s.turnOpen = true;
      s.error = step.status === 'ERROR';
      s.lastTool = null;
      s.turnStartMs = at || null;
    } else if (isAnswer(step)) {
      const text = textOf(step.content);
      const calls = callsOf(step);
      if (text) s.lastAssistant = text;
      if (calls.length) s.lastTool = toolLine(calls[calls.length - 1]);
      // An answer that calls no tool ends the turn.
      else if (text) s.turnOpen = false;
    }
  }
  return s;
}

/** The conversation's messages for the phone's chat view, oldest first, the last `max`. */
export function chatMessages(steps: AgStep[], max: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  steps.forEach((step, n) => {
    const at = Date.parse(step.created_at ?? '') || 0;
    const key = `${step.step_index ?? n}`;
    if (isRequest(step)) {
      const text = textOf(step.content);
      if (text) out.push({ key, kind: 'you', text: clip(text, CHAT_TEXT_MAX), at });
    } else if (isAnswer(step)) {
      const text = textOf(step.content);
      if (text) out.push({ key, kind: 'claude', text: clip(text, CHAT_TEXT_MAX), at });
      callsOf(step).forEach((c, i) => out.push({ key: `${key}:${i}`, kind: 'tool', text: toolLine(c), at }));
    }
    if (step.status === 'ERROR' && !isRequest(step)) out.push({ key: `${key}:err`, kind: 'note', text: 'Antigravity ran into an error.', at });
  });
  return out.slice(-max);
}

/** A workspace path from Antigravity (a plain path, or a URI-style "/c:/…" one) as a Windows folder. */
export function folderOf(p: string | undefined | null): string {
  if (!p) return '';
  let out = p.startsWith('file:///') ? p.slice(7) : p;
  try {
    out = decodeURIComponent(out);
  } catch {
    /* already plain */
  }
  if (/^\/[a-zA-Z]:[\\/]/.test(out)) out = out.slice(1);
  return /^[a-zA-Z]:\//.test(out) ? out.replace(/\//g, '\\') : out;
}
