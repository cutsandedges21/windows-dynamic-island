// Codex in the island: the shared engine's cards and reply window for Codex's hooks, its limits,
// and where opening, continuing and messaging a Codex chat goes. The native layer is faked; a
// stub tracker supplies chats and process chains.

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
import type { Block, SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { CodexActivity } from '../src/activities/codex';
import { chatRoute, codexArgs, openRoute, threadUrl } from '../src/activities/codex/open';
import type { ClosedView, SessionView } from '../src/activities/claude/tracker';

const T0 = Date.parse('2026-10-30T22:00:00Z');
const SID = '01a18eb4-0570-7f92-b87d-4917403176d2';

function resetNative() {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    codexEnv: vi.fn(async () => null),
    hookReply: vi.fn(async () => true),
    foregroundPid: vi.fn(async () => 0),
    procSnapshot: vi.fn(async () => []),
    clipboardSetText: vi.fn(async () => true),
    claudeInject: vi.fn(async () => ({ ok: true, error: null })),
    codexResume: vi.fn(async () => true),
    openUrl: vi.fn(async () => true),
    allowForeground: vi.fn(async () => undefined),
    winEnum: vi.fn(async () => []),
    activate: vi.fn(async () => true),
    termList: vi.fn(async () => []),
  });
}

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot(options: Record<string, unknown> = {}) {
  const act = new CodexActivity();
  const settings = defaultSettings();
  const ctx: ActivityContext = {
    id: 'codex',
    config: () => settings.activities.config.codex,
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
    id: SID, sessionId: SID, pid: 500, cwd: 'C:\\code\\app', name: '', kind: 'interactive', entrypoint: 'codex-cli', alive: true,
    status: 'awaiting_input', label: 'Your turn', tone: 'turn', needsYou: false, title: 'Fix the parser', displayTitle: 'Fix the parser', project: 'app', host: 'Terminal',
    editorHost: null, hostKind: 'terminal', model: null, permissionMode: 'default', gitBranch: null, lastActivityMs: T0, lastAliveAt: T0,
    slot: null, tool: null, operation: null, turnStartMs: null, lastAssistantText: 'Done.', transcript: null, version: null,
    ...over,
  }) as SessionView;

function stubTracker(act: CodexActivity, sessions: SessionView[], closed: ClosedView[] = [], chains: Record<number, number[]> = {}) {
  const probe = {
    table: new Map<number, unknown>(Object.keys(chains).map((k) => [Number(k), {}])),
    ancestors: (pid: number) => (chains[pid] ?? []).map((p) => ({ pid: p, name: 'host.exe' })),
    load: vi.fn(),
    runningEditor: () => 'Cursor',
  };
  (act as unknown as { tracker: unknown }).tracker = {
    probe,
    noteHook: vi.fn(),
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    getClosed: (id: string) => closed.find((c) => c.id === id) ?? null,
    poll: async () => ({ sessions, closed, events: [] }),
    limits: () => ({ data: null, asOf: null }),
    weekTokens: () => ({ fresh: 0, cached: 0, output: 0 }),
    transcriptOf: () => null,
  };
  act.sessions = sessions;
  act.closed = closed;
}

const senv = (reason: SheetEnv['reason']): SheetEnv => ({ reason, now: Date.now(), width: 480, vertical: false, interactive: true, surfaced: null });
const block = <T extends Block['t']>(view: SheetView | null | undefined, t: T, key?: string) =>
  view?.blocks.find((b) => b.t === t && (key === undefined || b.key === key)) as Extract<Block, { t: T }> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNative();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Codex hooks in the island', () => {
  it('a command Codex asks about gets the card, and Allow answers Codex', async () => {
    const act = await boot();
    stubTracker(act, [session({})], [], { 500: [400] });
    emit('hook', { hook_event_name: 'PermissionRequest', agent: 'codex', session_id: SID, request_id: 'p1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(h.native.hookReply).toHaveBeenCalledWith('p1', 'ack');
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'head')?.title).toBe('Run this command?');
    expect(block(card, 'code')?.text).toBe('npm test');
    expect(block(card, 'input')?.placeholder).toBe('Or tell Codex what to do instead…');
    await act.action!('allow', 'p1');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('p1', 'allow');
  });

  it("Claude's hooks are not Codex's", async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    emit('hook', { hook_event_name: 'PermissionRequest', agent: 'claude', session_id: SID, request_id: 'c1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: SID, request_id: 'c2', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await tick(0);
    expect(h.native.hookReply).not.toHaveBeenCalled();
  });

  it('a finished turn waits for a reply typed in the island, which becomes its next message', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})], [], { 500: [400] });
    emit('hook', { hook_event_name: 'Stop', agent: 'codex', session_id: SID, request_id: 'r1', last_assistant_message: 'Tests pass now.' });
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r1', 'ack:45000');
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'text', 'msg')?.text).toBe('Tests pass now.');
    await act.action!('reply:r1', 'now commit it');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('r1', JSON.stringify({ kind: 'reply', text: 'now commit it' }));
  });

  it('the hook reaches the tracker before the cards', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    const ev = { hook_event_name: 'UserPromptSubmit', agent: 'codex', session_id: SID, prompt: 'go' };
    emit('hook', ev);
    expect((act as unknown as { tracker: { noteHook: ReturnType<typeof vi.fn> } }).tracker.noteHook).toHaveBeenCalledWith(ev);
  });

  it('says Codex on the pill', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    expect(act.status().summary).toBe('Codex · Your turn');
  });
});

describe('Codex limits', () => {
  it('shows the bars, and says how old they are', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    act.usageState = { data: { fiveHour: { pct: 42, resetsAt: T0 + 3_600_000 }, sevenDay: { pct: 17, resetsAt: T0 + 86_400_000 }, models: [] }, error: null, source: null, fetchedAt: T0 - 20 * 60_000 };
    (act as unknown as { limitsAsOf: number }).limitsAsOf = T0 - 20 * 60_000;
    const hover = act.sheet!(senv('hover'));
    expect(block(hover, 'meter', 'limit-s')?.text).toBe('42%');
    expect(block(hover, 'meter', 'limit-w')?.text).toBe('17%');
    expect(block(hover, 'text', 'limits-age')?.text).toMatch(/^As of 20m ago/);
  });

  it('without a plan, says when they would show', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    const hover = act.sheet!(senv('hover'));
    expect(block(hover, 'text', 'limits-none')?.text).toMatch(/ChatGPT plan/);
  });
});

describe('opening and continuing a Codex chat', () => {
  it('routes by where the chat lives', () => {
    const chat = { sessionId: SID, cwd: 'C:\\code\\app', entrypoint: 'codex-cli', pid: 500, alive: true };
    expect(openRoute(chat)).toBe('terminal');
    expect(openRoute({ ...chat, alive: false, pid: 0 })).toBe('resume');
    expect(openRoute({ ...chat, entrypoint: 'codex-app' })).toBe('app');
    expect(openRoute({ ...chat, entrypoint: 'codex-editor' })).toBe('editor');
    expect(threadUrl(SID)).toBe(`codex://threads/${SID}`);
    expect(threadUrl('not-an-id')).toBeNull();
  });

  it('a reply to a terminal chat is typed into it', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    await act.action!(`continue:${SID}`, 'add a test');
    expect(h.native.claudeInject).toHaveBeenCalledWith(500, 'add a test');
  });

  it('a reply to a Codex app chat opens it there, with the text copied', async () => {
    const act = await boot();
    stubTracker(act, [session({ entrypoint: 'codex-app', host: 'Codex app' })]);
    await act.action!(`continue:${SID}`, 'add a test');
    expect(h.native.clipboardSetText).toHaveBeenCalledWith('add a test');
    expect(h.native.openUrl).toHaveBeenCalledWith(`codex://threads/${SID}`);
  });

  it('a reply to a closed chat resumes it with the reply', async () => {
    const act = await boot();
    const closed: ClosedView = { id: SID, sessionId: SID, cwd: 'C:\\code\\app', entrypoint: 'codex-cli', displayTitle: 'Fix the parser', title: null, project: 'app', model: null, closedAt: T0 - 60_000, source: 'history' };
    stubTracker(act, [], [closed]);
    await act.action!(`continue:${SID}`, 'and push');
    expect(h.native.codexResume).toHaveBeenCalledWith(SID, 'C:\\code\\app', 'and push', true);
  });

  it('a phone message to a chat the app holds continues as a copy in an Island terminal', () => {
    const chat = { sessionId: SID, cwd: 'C:\\code\\app', entrypoint: 'codex-app', pid: 700, alive: true };
    const route = chatRoute(chat, null);
    expect(route).toEqual({ how: 'fork', sessionId: SID, cwd: 'C:\\code\\app' });
    expect(codexArgs(route, '-v please')).toEqual(['fork', SID, ' -v please']);
    expect(chatRoute({ ...chat, entrypoint: 'codex-cli' }, null)).toEqual({ how: 'inject', pid: 700 });
    expect(chatRoute({ ...chat, alive: false, pid: 0 }, null)).toEqual({ how: 'resume', sessionId: SID, cwd: 'C:\\code\\app' });
    expect(chatRoute(chat, { id: 't1' })).toEqual({ how: 'term', term: 't1' });
  });
});
