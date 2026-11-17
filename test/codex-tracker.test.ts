// Codex's chats as the island lists them: live from hooks the moment they happen, filled in
// and remembered from Codex's session files, closed when Codex says so or its process is gone.

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));
vi.mock('../src/core/native', () => ({ native: h.native }));

import type { CodexEnv, ProcRow, RolloutLine } from '../src/core/native';
import { CodexTracker } from '../src/activities/codex/tracker';
import type { HookEvent } from '../src/activities/claude/hooks';

const T0 = Date.parse('2026-10-30T21:30:00Z');
const ENV: CodexEnv = {
  home: 'C:\\Users\\x\\.codex', sessionsDir: 'C:\\Users\\x\\.codex\\sessions', archivedDir: 'C:\\Users\\x\\.codex\\archived_sessions',
  indexPath: 'C:\\Users\\x\\.codex\\session_index.jsonl', codexExe: 'C:\\codex.exe', hookExe: 'C:\\island-hook.exe', hookReady: true,
};
const FIXTURE = path.join(__dirname, '..', 'src-tauri', 'src', 'testdata', 'codex-rollout.jsonl');
const ROLLOUT = 'C:\\Users\\x\\.codex\\sessions\\2026\\10\\30\\rollout-2026-10-30T17-25-24-01a18eb4-0570-7f92-b87d-4917403176d2.jsonl';
const fixtureLines = (): RolloutLine[] => fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SID = '01a18eb4-0570-7f92-b87d-4917403176d2';

/** A terminal running Codex (500) through PowerShell; the Codex app (650) hosting an app-server (700). */
const PROCS: ProcRow[] = [
  [300, 1, 'windowsterminal.exe', T0 - 3_600_000],
  [400, 300, 'pwsh.exe', T0 - 3_000_000],
  [500, 400, 'codex.exe', T0 - 2_000_000],
  [650, 1, 'codex.exe', T0 - 3_600_000],
  [700, 650, 'codex.exe', T0 - 3_500_000],
];

function setNative(over: Record<string, unknown> = {}) {
  for (const k of Object.keys(h.native)) delete h.native[k];
  Object.assign(h.native, {
    procSnapshot: vi.fn(async () => PROCS),
    listFiles: vi.fn(async () => []),
    codexRolloutScan: vi.fn(async () => null),
    statMany: vi.fn(async () => [null]),
    readText: vi.fn(async () => null),
    ...over,
  });
}

const hook = (over: Partial<HookEvent>): HookEvent => ({ hook_event_name: 'SessionStart', agent: 'codex', session_id: 'T1', cwd: 'C:\\code\\app', hook_gppid: 500, ...over });

/** One session file, touched `ago` ms before T0, read whole on the first scan. */
function withRollout(ago: number) {
  const lines = fixtureLines();
  setNative({
    listFiles: vi.fn(async () => [{ name: path.basename(ROLLOUT), path: ROLLOUT, dir: false, size: 13530, mtimeMs: T0 - ago }]),
    codexRolloutScan: vi.fn(async (_p: string, offset: number) => (offset === 0 ? { offset: 13530, size: 13530, lines } : { offset: 13530, size: 13530, lines: [] })),
    statMany: vi.fn(async () => [{ size: 120, mtimeMs: T0, dir: false }]),
    readText: vi.fn(async () => `{"id":"${SID}","thread_name":"Probe chat","updated_at":"2026-10-30T21:25:30Z"}\n`),
  });
}

beforeEach(() => setNative());

describe('live chats from hooks', () => {
  it('a prompt makes a chat live and working, in the terminal it runs in', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({}), T0);
    t.noteHook(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing tests' }), T0 + 1000);
    const r = await t.poll(T0 + 2000);
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s).toMatchObject({ id: 'T1', pid: 500, status: 'working', label: 'Working', displayTitle: 'fix the failing tests', host: 'Terminal', entrypoint: 'codex-cli', project: 'app', alive: true });
    expect(s.turnStartMs).toBe(T0 + 1000);
  });

  it('Stop makes it your turn with Codex’s last words; SessionEnd closes it', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }), T0);
    t.noteHook(hook({ hook_event_name: 'Stop', last_assistant_message: 'Fixed and tested.' }), T0 + 5000);
    let r = await t.poll(T0 + 6000);
    expect(r.sessions[0]).toMatchObject({ status: 'awaiting_input', label: 'Your turn', lastAssistantText: 'Fixed and tested.' });
    t.noteHook(hook({ hook_event_name: 'SessionEnd', reason: 'other' } as Partial<HookEvent>), T0 + 7000);
    r = await t.poll(T0 + 8000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed.map((c) => c.id)).toEqual(['T1']);
    expect(r.events.map((e) => e.type)).toContain('closed');
  });

  it('a chat whose Codex process is gone is closed', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ hook_gppid: 999, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), T0);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed.map((c) => c.id)).toEqual(['T1']);
  });

  it('an app-server inside the Codex app is the Codex app', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ hook_gppid: 700, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), T0);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions[0]).toMatchObject({ pid: 700, host: 'Codex app', entrypoint: 'codex-app' });
  });

  it('finds Codex as the hook’s parent too, when no shell sits between them', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ hook_gppid: 400, hook_ppid: 500, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), T0);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions[0]).toMatchObject({ pid: 500, host: 'Terminal' });
  });

  it('an interrupt stops the turn', async () => {
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }), T0);
    t.noteHook(hook({ hook_event_name: 'Interrupt' }), T0 + 2000);
    const r = await t.poll(T0 + 3000);
    expect(r.sessions[0]).toMatchObject({ status: 'interrupted', label: 'Stopped' });
  });
});

describe('chats from session files', () => {
  it('a file touched minutes ago is a live chat, named from session_index.jsonl', async () => {
    withRollout(2 * 60_000);
    const t = new CodexTracker(ENV);
    const r = await t.poll(T0);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ id: SID, displayTitle: 'Probe chat', status: 'awaiting_input', cwd: 'C:\\tmp\\codex-probe\\work', lastAssistantText: 'All done. Wrote probe.txt.', transcript: ROLLOUT });
    expect(r.sessions[0].context?.share).toBeCloseTo(1240 / 258400);
    expect(t.transcriptOf(SID)).toBe(ROLLOUT);
  });

  it('an older one is closed recently, and its file is read only once', async () => {
    withRollout(3 * 3_600_000);
    const t = new CodexTracker(ENV);
    // Three hours after the chat's last line.
    const later = Date.parse('2026-10-30T21:25:29.653Z') + 3 * 3_600_000;
    let r = await t.poll(later);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0]).toMatchObject({ id: SID, displayTitle: 'Probe chat', closedAt: Date.parse('2026-10-30T21:25:29.653Z') });
    r = await t.poll(later + 3000);
    expect(h.native.codexRolloutScan).toHaveBeenCalledTimes(1);
    expect(t.getClosed(SID)?.id).toBe(SID);
  });

  it('the plan’s limits and the week’s tokens come from the files', async () => {
    withRollout(60_000);
    const t = new CodexTracker(ENV);
    await t.poll(T0);
    const l = t.limits();
    expect(l.data?.fiveHour).toEqual({ pct: 42, resetsAt: 1793406329000 });
    expect(l.data?.sevenDay?.pct).toBe(17);
    expect(l.asOf).toBe(Date.parse('2026-10-30T21:25:29.303Z'));
    expect(t.weekTokens(0)).toEqual({ fresh: 3120, cached: 600, output: 120 });
  });

  it('hooks and the file agree on one chat', async () => {
    withRollout(60_000);
    const t = new CodexTracker(ENV);
    t.noteHook(hook({ session_id: SID, transcript_path: ROLLOUT, hook_event_name: 'UserPromptSubmit', prompt: 'one more thing' }), T0 + 500);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ id: SID, status: 'working', displayTitle: 'Probe chat', pid: 500 });
  });
});
