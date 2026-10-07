// Fake .claude trees and transcript lines for tests (Usage Clip's helpers.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(path.join(root, 'projects'));
  return root;
}

export const uuid = () => crypto.randomUUID();

export function transcriptFile(root: string, cwd: string, sessionId: string): string {
  const dir = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

export function writeLines(file: string, entries: unknown[], append = false): void {
  const text = entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
}

export const iso = (ms: number) => new Date(ms).toISOString();

export const user = (text: string, ts: number, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: text }, ...extra });

export const assistant = (
  ts: number,
  { stop = 'end_turn', model = 'claude-opus-5-5', tools = [] as Array<[string, string]>, usage, id, requestId, extra = {} as Record<string, unknown> }: { stop?: string; model?: string; tools?: Array<[string, string]>; usage?: unknown; id?: string; requestId?: string; extra?: Record<string, unknown> } = {},
) => ({
  type: 'assistant',
  timestamp: iso(ts),
  requestId,
  message: { id, model, stop_reason: stop, content: [{ type: 'text', text: 'ok' }, ...tools.map(([tid, name]) => ({ type: 'tool_use', id: tid, name, input: {} }))], usage },
  ...extra,
});

export const toolResult = (toolId: string, ts: number) => ({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }] } });
