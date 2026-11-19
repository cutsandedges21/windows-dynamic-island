// Auto model's own `claude -p` runs (router.mjs before every prompt, review.mjs after a turn) are
// sessions in Claude Code's registry too; the tracker leaves them out so they never show as a
// chat starting and finishing. The registry and transcripts are real files; processes are faked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', async () => await import('./fake-native'));

import { native } from '../src/core/native';
import { cwdToSlug } from '../src/activities/claude/status';
import { isAutoModelRun, SessionTracker } from '../src/activities/claude/tracker';

const CWD = 'C:\\Users\\justi';
const START = Date.now() - 60_000;
const ROUTER_LINE = 'claude -p --model haiku --effort low --setting-sources "" --strict-mcp-config --tools "" --system-prompt-file C:\\Users\\justi\\.claude\\model-router\\rubric.md';
const ROUTER_PARENT = '"C:\\Program Files\\nodejs\\node.exe" C:/Users/justi/.claude/model-router/router.mjs';

let dir = '';
const n = native as unknown as Record<string, unknown>;
let cmdlines: Record<number, string | null> = {};
let procs: Array<[number, number, string, number | null]> = [];

function register(pid: number, sessionId: string, entrypoint: string, prompt?: string) {
  fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: CWD, kind: 'interactive', entrypoint, name: `justi-${pid}` }));
  if (!prompt) return;
  const proj = path.join(dir, 'projects', cwdToSlug(CWD));
  fs.mkdirSync(proj, { recursive: true });
  const line = { type: 'user', sessionId, cwd: CWD, entrypoint, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } };
  fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), JSON.stringify(line) + '\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-tracker-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  cmdlines = {};
  procs = [];
  n.procSnapshot = async () => procs;
  n.claudeStatusCmdlines = vi.fn(async (pids: number[]) => pids.map((p) => cmdlines[p] ?? null));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete n.procSnapshot;
  delete n.claudeStatusCmdlines;
});

describe("Auto model's own runs are not chats", () => {
  it('a run started by router.mjs or review.mjs is told by its command line, or its parent node script', () => {
    expect(isAutoModelRun(ROUTER_LINE, null)).toBe(true);
    expect(isAutoModelRun(null, ROUTER_PARENT)).toBe(true);
    expect(isAutoModelRun('claude -p --model sonnet', 'node C:\\Users\\justi\\.claude\\model-router\\review.mjs --worker abc')).toBe(true);
    // The user's own `claude -p`, from a terminal or a script of theirs.
    expect(isAutoModelRun('claude -p "summarize this"', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(false);
    expect(isAutoModelRun(null, null)).toBe(false);
  });

  it('no row and no "closed" for the router\'s run; the user\'s own claude -p still shows', async () => {
    const tracker = new SessionTracker(path.join(dir, 'sessions'), path.join(dir, 'projects'));
    // A chat in a terminal (100), the router's run under it (200 < node 210 < 100), and the user's own `claude -p` (300 < pwsh 310).
    procs = [[100, 1, 'claude.exe', START], [210, 100, 'node.exe', START + 1000], [200, 210, 'claude.exe', START + 2000], [310, 1, 'powershell.exe', START], [300, 310, 'claude.exe', START + 3000]];
    cmdlines = { 200: ROUTER_LINE, 210: ROUTER_PARENT, 300: 'claude -p "summarize this"', 310: 'powershell.exe' };
    register(100, '0f1e2d3c-0000-4000-8000-000000000100', 'cli');
    // No transcript (review.mjs runs with --no-session-persistence): only its process tells.
    register(200, '0f1e2d3c-0000-4000-8000-000000000200', 'sdk-cli');
    register(300, '0f1e2d3c-0000-4000-8000-000000000300', 'sdk-cli');
    const first = await tracker.poll();
    expect(first.sessions.map((s) => s.id).sort()).toEqual(['0f1e2d3c-0000-4000-8000-000000000100', '0f1e2d3c-0000-4000-8000-000000000300']);
    // Only the non-interactive runs' command lines are read, once.
    await tracker.poll();
    expect(n.claudeStatusCmdlines).toHaveBeenCalledTimes(1);
    // The router's run ends: nothing closed.
    procs = procs.filter(([pid]) => pid !== 200);
    fs.rmSync(path.join(dir, 'sessions', '200.json'));
    const after = await tracker.poll();
    expect(after.events).toEqual([]);
    expect(after.closed).toEqual([]);
  });

  it("with no command line readable, the router's prompt as its title still gives it away", async () => {
    const tracker = new SessionTracker(path.join(dir, 'sessions'), path.join(dir, 'projects'));
    procs = [[200, 1, 'claude.exe', START], [300, 1, 'claude.exe', START]];
    register(200, '0f1e2d3c-0000-4000-8000-000000000200', 'sdk-cli', 'Current model: claude-sonnet-5-5, effort: medium\n\nPrevious assistant reply (end):\nDone.');
    register(300, '0f1e2d3c-0000-4000-8000-000000000300', 'sdk-cli', 'Current state of the build?');
    const { sessions } = await tracker.poll();
    expect(sessions.map((s) => s.id)).toEqual(['0f1e2d3c-0000-4000-8000-000000000300']);
  });
});
