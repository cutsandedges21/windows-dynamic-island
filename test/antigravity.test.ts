// Antigravity in the island: its transcripts read, its conversations tracked from hooks and
// transcripts, and the shared engine's cards and reply window for its hook events (their names
// and camelCase fields as its docs give them). The native layer is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({
  native: h.native,
  on: async (event: string, cb: (p: unknown) => void) => {
    let set = h.bus.get(event);
    if (!set) h.bus.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
  emitLocal: () => {},
}));

import type { ActivityContext, SheetEnv } from '../src/core/activity';
import type { AntigravityEnv, ProcRow } from '../src/core/native';
import type { Block, SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { AntigravityActivity } from '../src/activities/antigravity';
import { AntigravityTracker, productOf, type AgHook } from '../src/activities/antigravity/tracker';
import { chatMessages, folderOf, parseSteps, summarize } from '../src/activities/antigravity/transcript';
import type { SessionView } from '../src/activities/claude/tracker';

const T0 = Date.parse('2026-10-30T22:00:00Z');
const CID = 'ec33ebf9-0cba-4100-8142-c61503f6c587';
const ENV: AntigravityEnv = { home: 'C:\\Users\\x\\.gemini', appExe: 'C:\\ag\\Antigravity.exe', ideExe: null, cliExe: null, hookExe: 'C:\\island-hook.exe', hookReady: true };
const FILE = `C:\\Users\\x\\.gemini\\antigravity\\brain\\${CID}\\.system_generated\\logs\\transcript.jsonl`;

/** A conversation as Antigravity logs it: a request, an answer that runs a command, the final answer. */
const TRANSCRIPT = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-30T21:50:00Z', content: 'fix the failing tests' },
  { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-30T21:50:05Z', content: 'Running the tests first.', thinking: 'hmm', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', Cwd: 'C:\\code\\app' } }] },
  { step_index: 2, source: 'SYSTEM', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-10-30T21:50:20Z', content: '2 passed' },
  { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-30T21:50:30Z', content: 'Fixed: the parser skipped empty lines.' },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

/** The app (700) and its language server (750) that runs the agent and its hooks. */
const PROCS: ProcRow[] = [
  [700, 1, 'Antigravity.exe', T0 - 3_600_000],
  [750, 700, 'language_server.exe', T0 - 3_500_000],
];

const hook = (over: Partial<AgHook>): AgHook => ({
  hook_event_name: 'SessionStart', agent: 'antigravity', conversationId: CID, workspacePaths: ['C:\\code\\app'], transcriptPath: FILE, modelName: 'gemini-3-pro',
  hook_pid: 900, hook_ppid: 800, hook_gppid: 750, ...over,
} as AgHook);

describe('Antigravity transcripts', () => {
  it('reads the request, the last answer, what it ran, and when the turn ended', () => {
    const s = summarize(parseSteps(TRANSCRIPT));
    expect(s).toMatchObject({ title: 'fix the failing tests', lastPrompt: 'fix the failing tests', lastAssistant: 'Fixed: the parser skipped empty lines.', turnOpen: false, error: false, lastTool: 'Ran npm test', lastActivityMs: Date.parse('2026-10-30T21:50:30Z') });
  });

  it('an answer that still calls a tool leaves the turn open; a failed step says so', () => {
    const open = TRANSCRIPT.split('\n').slice(0, 2).join('\n');
    expect(summarize(parseSteps(open))).toMatchObject({ turnOpen: true, lastTool: 'Ran npm test' });
    const failed = `${open}\n${JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'RUN_COMMAND', status: 'ERROR', created_at: '2026-10-30T21:51:00Z' })}`;
    expect(summarize(parseSteps(failed)).error).toBe(true);
  });

  it('gives the phone the messages and what it ran', () => {
    expect(chatMessages(parseSteps(TRANSCRIPT), 10).map((m) => [m.kind, m.text])).toEqual([
      ['you', 'fix the failing tests'],
      ['claude', 'Running the tests first.'],
      ['tool', 'Ran npm test'],
      ['claude', 'Fixed: the parser skipped empty lines.'],
    ]);
  });

  it('knows which Antigravity wrote a transcript, and reads its folders', () => {
    expect(productOf(FILE)).toBe('app');
    expect(productOf('C:\\Users\\x\\.gemini\\antigravity-cli\\brain\\a\\.system_generated\\logs\\transcript.jsonl')).toBe('cli');
    expect(productOf('C:/Users/x/.gemini/antigravity-ide/brain/a/x.jsonl')).toBe('ide');
    expect(folderOf('/c:/code/my%20app')).toBe('c:\\code\\my app');
    expect(folderOf('C:\\code\\app')).toBe('C:\\code\\app');
    expect(folderOf('file:///c:/code/app')).toBe('c:\\code\\app');
  });
});

function setNative(over: Record<string, unknown> = {}) {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    procSnapshot: vi.fn(async () => PROCS),
    antigravityTranscripts: vi.fn(async () => []),
    statMany: vi.fn(async (paths: string[]) => paths.map(() => null)),
    readText: vi.fn(async () => null),
    antigravityEnv: vi.fn(async () => null),
    hookReply: vi.fn(async () => true),
    foregroundPid: vi.fn(async () => 0),
    clipboardSetText: vi.fn(async () => true),
    claudeInject: vi.fn(async () => ({ ok: true, error: null })),
    allowForeground: vi.fn(async () => undefined),
    winEnum: vi.fn(async () => []),
    activate: vi.fn(async () => true),
    antigravityOpen: vi.fn(async () => true),
    termList: vi.fn(async () => []),
    ...over,
  });
}

describe('Antigravity conversations', () => {
  beforeEach(() => setNative());

  it('the first model call makes a conversation live and working, held by the app', async () => {
    setNative({ readText: vi.fn(async () => TRANSCRIPT.split('\n')[0]), statMany: vi.fn(async (paths: string[]) => paths.map(() => ({ size: 120, mtimeMs: T0, dir: false }))) });
    const t = new AntigravityTracker(ENV);
    t.noteHook(hook({}), T0);
    t.noteHook(hook({ hook_event_name: 'PreInvocation', invocationNum: 0 }), T0 + 1000);
    const r = await t.poll(T0 + 2000);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ id: CID, pid: 750, status: 'working', displayTitle: 'fix the failing tests', cwd: 'C:\\code\\app', host: 'Antigravity', entrypoint: 'antigravity-app', model: 'gemini-3-pro' });
  });

  it("Stop makes it your turn with the transcript's last answer; a gone process closes it", async () => {
    setNative({ readText: vi.fn(async () => TRANSCRIPT) });
    const t = new AntigravityTracker(ENV);
    t.noteHook(hook({ hook_event_name: 'PreInvocation', invocationNum: 0 }), T0);
    t.noteHook(hook({ hook_event_name: 'Stop', terminationReason: 'model_stop', fullyIdle: true }), T0 + 5000);
    expect((await t.refresh(CID))?.lastAssistant).toBe('Fixed: the parser skipped empty lines.');
    let r = await t.poll(T0 + 6000);
    expect(r.sessions[0]).toMatchObject({ status: 'awaiting_input', lastAssistantText: 'Fixed: the parser skipped empty lines.' });
    h.native.procSnapshot = vi.fn(async () => []);
    r = await t.poll(T0 + 8000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed.map((c) => c.id)).toEqual([CID]);
  });

  it('a transcript from minutes ago is open while Antigravity runs; an older one is closed', async () => {
    setNative({
      antigravityTranscripts: vi.fn(async () => [{ path: FILE, id: CID, size: TRANSCRIPT.length, mtimeMs: T0 - 2 * 60_000 }]),
      readText: vi.fn(async () => TRANSCRIPT),
    });
    let r = await new AntigravityTracker(ENV).poll(T0);
    expect(r.sessions[0]).toMatchObject({ id: CID, displayTitle: 'fix the failing tests', status: 'awaiting_input', host: 'Antigravity' });
    setNative({
      antigravityTranscripts: vi.fn(async () => [{ path: FILE, id: CID, size: 10, mtimeMs: T0 - 3 * 3_600_000 }]),
      readText: vi.fn(async () => TRANSCRIPT),
    });
    r = await new AntigravityTracker(ENV).poll(T0);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed[0]).toMatchObject({ id: CID, displayTitle: 'fix the failing tests' });
  });
});

// ------------------------------------------------------------------ in the island

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot(options: Record<string, unknown> = {}) {
  const act = new AntigravityActivity();
  const settings = defaultSettings();
  const ctx: ActivityContext = {
    id: 'antigravity',
    config: () => settings.activities.config.antigravity,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: () => {},
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    push: () => {},
    log: () => {},
  };
  await act.start(ctx);
  await tick(0);
  return act;
}

const session = (over: Partial<SessionView>): SessionView =>
  ({
    id: CID, sessionId: CID, pid: 750, cwd: 'C:\\code\\app', name: '', kind: 'interactive', entrypoint: 'antigravity-app', alive: true,
    status: 'awaiting_input', label: 'Your turn', tone: 'turn', needsYou: false, title: 'Fix the parser', displayTitle: 'Fix the parser', project: 'app', host: 'Antigravity',
    editorHost: null, hostKind: 'app', model: null, permissionMode: null, gitBranch: null, lastActivityMs: T0, lastAliveAt: T0,
    slot: null, tool: null, operation: null, turnStartMs: null, lastAssistantText: 'Done.', transcript: null, version: null,
    ...over,
  }) as SessionView;

function stubTracker(act: AntigravityActivity, sessions: SessionView[], words: string | null = null) {
  const probe = { table: new Map<number, unknown>([[750, {}], [700, {}]]), ancestors: (pid: number) => (pid === 750 ? [{ pid: 700, name: 'Antigravity.exe' }] : []), load: vi.fn(), runningEditor: () => null };
  (act as unknown as { tracker: unknown }).tracker = {
    probe,
    noteHook: vi.fn(),
    refresh: vi.fn(async () => (words ? { lastAssistant: words } : null)),
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    getClosed: () => null,
    poll: async () => ({ sessions, closed: [], events: [] }),
    transcriptOf: () => null,
  };
  act.sessions = sessions;
}

const senv = (reason: SheetEnv['reason']): SheetEnv => ({ reason, now: Date.now(), width: 480, vertical: false, interactive: true, surfaced: null });
const block = <T extends Block['t']>(view: SheetView | null | undefined, t: T, key?: string) =>
  view?.blocks.find((b) => b.t === t && (key === undefined || b.key === key)) as Extract<Block, { t: T }> | undefined;

describe('Antigravity in the island', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setNative();
  });
  afterEach(() => vi.useRealTimers());

  it('a finished turn waits for a reply, showing the last answer from the transcript', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})], 'Tests pass now.');
    emit('hook', hook({ hook_event_name: 'Stop', terminationReason: 'model_stop', request_id: 'r1' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r1', 'ack:45000');
    expect(block(act.sheet!(senv('urgent')), 'text', 'msg')?.text).toBe('Tests pass now.');
    await act.action!('reply:r1', 'now commit it');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('r1', JSON.stringify({ kind: 'reply', text: 'now commit it' }));
  });

  it('a failed turn lets its Stop go at once', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'Stop', terminationReason: 'error', request_id: 'r2' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r2', 'pass');
    expect(h.native.hookReply).not.toHaveBeenCalledWith('r2', expect.stringMatching(/^ack/));
  });

  it('with "ask me here" off, a command hook hands the question back', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, request_id: 'p0' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('p0', 'decline');
  });

  it('with it on, a command gets the card and Allow answers it', async () => {
    const act = await boot({ askBeforeCommands: true });
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, request_id: 'p1' }));
    expect(h.native.hookReply).toHaveBeenCalledWith('p1', 'ack');
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'head')?.title).toBe('Run this command?');
    expect(block(card, 'code')?.text).toBe('npm test');
    await act.action!('allow', 'p1');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('p1', 'allow');
  });

  it('the first model call of a turn starts it; later ones are only noted', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    const t = (act as unknown as { tracker: { noteHook: ReturnType<typeof vi.fn> } }).tracker;
    emit('hook', hook({ hook_event_name: 'PreInvocation', invocationNum: 0 }));
    emit('hook', hook({ hook_event_name: 'PreInvocation', invocationNum: 3 }));
    expect(t.noteHook).toHaveBeenCalledTimes(2);
    expect((act as unknown as { hooks: { turnStart: Map<string, number> } }).hooks.turnStart.get(CID)).toBeDefined();
  });

  it('a phone reaches a conversation only while it waits for a reply', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})], 'ok');
    await expect(act.messageChat(CID, 'hello')).rejects.toThrow(/isn't waiting/);
    emit('hook', hook({ hook_event_name: 'Stop', terminationReason: 'model_stop', request_id: 'r5' }));
    await tick(0);
    await act.messageChat(CID, 'and the docs');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('r5', JSON.stringify({ kind: 'reply', text: 'and the docs' }));
  });

  it('says Antigravity on the pill, with no limits to show', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    expect(act.status().summary).toBe('Antigravity · Your turn');
    expect(block(act.sheet!(senv('hover')), 'meter')).toBeUndefined();
  });
});
