// Answering Claude Code from the island: the reply window (Stop hook), permission
// and question cards, notifications, the hover card, and the helpers behind them.
// The native layer is faked; a stub tracker supplies sessions and process chains.

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
import { plainText } from '../src/core/format';
import { mapActions, type Block, type SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { ClaudeActivity } from '../src/activities/claude';
import { HookState, questionsOf } from '../src/activities/claude/hooks';
import type { SessionView } from '../src/activities/claude/tracker';

const T0 = Date.parse('2026-10-01T15:00:00Z');

function resetNative() {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    claudeEnv: vi.fn(async () => null),
    hookReply: vi.fn(async () => true),
    foregroundPid: vi.fn(async () => 0),
    procSnapshot: vi.fn(async () => []),
    clipboardSetText: vi.fn(async () => true),
    claudeInject: vi.fn(async () => ({ ok: true })),
    claudeResume: vi.fn(async () => true),
    openUrl: vi.fn(async () => true),
    allowForeground: vi.fn(async () => undefined),
    winEnum: vi.fn(async () => []),
    activate: vi.fn(async () => true),
  });
}

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

type Calls = { surface: Array<{ key?: string; ms?: number; level?: string }>; log: unknown[][] };

async function boot(options: Record<string, unknown> = {}, tweak: (s: ReturnType<typeof defaultSettings>) => void = () => {}) {
  const act = new ClaudeActivity();
  const settings = defaultSettings();
  tweak(settings);
  const calls: Calls = { surface: [], log: [] };
  const ctx: ActivityContext = {
    id: 'claude',
    config: () => settings.activities.config.claude,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: (o) => void calls.surface.push(o ?? {}),
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: (...a) => void calls.log.push(a),
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls };
}

const session = (over: Partial<SessionView>): SessionView => ({
  id: 'S1', sessionId: 'S1', pid: 100, cwd: 'C:\\code\\app', name: '', kind: 'interactive', entrypoint: 'cli', alive: true,
  status: 'awaiting_input', label: 'Your turn', tone: 'turn', needsYou: false, title: null, displayTitle: 'Fix the parser', project: 'app', host: 'Terminal',
  editorHost: null, hostKind: 'terminal', model: 'Opus 5.5', permissionMode: 'default', gitBranch: 'main', lastActivityMs: T0, lastAliveAt: T0,
  slot: 1, tool: null, operation: null, turnStartMs: T0 - 60_000, lastAssistantText: null, transcript: null, version: null,
  ...over,
} as SessionView);

/**
 * Sessions plus their process chains: `chains[pid]` lists the ancestors of a
 * Claude Code process, nearest first (its terminal or editor, then the rest).
 */
function stubTracker(act: ClaudeActivity, sessions: SessionView[], chains: Record<number, number[]>) {
  const probe = {
    table: new Map<number, unknown>(Object.keys(chains).map((k) => [Number(k), {}])),
    ancestors: (pid: number) => (chains[pid] ?? []).map((p) => ({ pid: p, name: 'host.exe' })),
    load: vi.fn(),
  };
  (act as unknown as { tracker: unknown }).tracker = {
    probe,
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    getClosed: () => null,
    poll: async () => ({ sessions, closed: [], events: [] }),
  };
  act.sessions = sessions;
}

const senv = (reason: SheetEnv['reason'], over: Partial<SheetEnv> = {}): SheetEnv => ({
  reason, now: Date.now(), width: 480, vertical: false, interactive: true, surfaced: null, ...over,
});

const block = <T extends Block['t']>(view: SheetView | null | undefined, t: T, key?: string) =>
  view?.blocks.find((b) => b.t === t && (key === undefined || b.key === key)) as Extract<Block, { t: T }> | undefined;

const lastReply = () => h.native.hookReply.mock.calls.at(-1);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNative();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- reply window

describe('the reply window', () => {
  it('holds a chat the user is not looking at, shows its message, and a reply goes through the hook', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50, 10] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1', last_assistant_message: '## Done\n**Parser fixed.** See `parse.ts`.' });
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r1', 'ack:45000');
    expect(act.status().urgent?.key).toBe('reply:r1');

    const card = act.sheet!(senv('urgent'));
    expect(card?.key).toBe('reply:r1');
    expect(block(card, 'text')?.text).toBe('Done\nParser fixed. See parse.ts.');
    const input = block(card, 'input');
    expect(input?.action).toBe('reply:r1');
    expect(input?.engage).toBe('hold:r1');
    expect(block(card, 'countdown')?.total).toBe(45_000);

    await act.action!('reply:r1', 'now add tests');
    expect(lastReply()).toEqual(['r1', JSON.stringify({ kind: 'reply', text: 'now add tests' })]);
    expect(act.status().urgent ?? null).toBeNull();
    expect(act.sheet!(senv('urgent'))).toBeNull();
  });

  it('lets go at once when the chat is in front, and shows no card for it', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50, 10] });
    h.native.foregroundPid.mockResolvedValue(50);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1', last_assistant_message: 'Done.' });
    await tick(0);
    expect(lastReply()).toEqual(['r1', 'pass']);
    expect(act.status().urgent ?? null).toBeNull();
    expect(act.sheet!(senv('surfaced', { surfaced: 'done:S1' }))).toBeNull();
  });

  it('with two chats in one window, only the one last prompted counts as watched', async () => {
    const { act } = await boot();
    stubTracker(act, [session({ id: 'S1', sessionId: 'S1', pid: 100 }), session({ id: 'S2', sessionId: 'S2', pid: 200, displayTitle: 'Other' })], { 100: [50], 200: [50] });
    h.native.foregroundPid.mockResolvedValue(50);
    emit('hook', { hook_event_name: 'UserPromptSubmit', session_id: 'S1' });
    await tick(1000);
    emit('hook', { hook_event_name: 'UserPromptSubmit', session_id: 'S2' });
    await tick(1000);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1', last_assistant_message: 'One' });
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r1', 'ack:45000');
    emit('hook', { hook_event_name: 'Stop', session_id: 'S2', request_id: 'r2', last_assistant_message: 'Two' });
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r2', 'pass');
  });

  it('passes when the reply window is off or quiet mode is on', async () => {
    const off = await boot({ replyWindowSeconds: 0 });
    stubTracker(off.act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    expect(lastReply()).toEqual(['r1', 'pass']);

    resetNative();
    const quiet = await boot({}, (s) => (s.general.dnd = true));
    stubTracker(quiet.act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r2' });
    await tick(0);
    expect(lastReply()).toEqual(['r2', 'pass']);
  });

  it('switching to the chat window releases the chat', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50, 10] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    emit('foreground', { pid: 777 });
    expect(act.status().urgent?.key).toBe('reply:r1');
    emit('foreground', { pid: 50 });
    expect(lastReply()).toEqual(['r1', 'pass']);
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('tapping away releases the chat', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    act.dismiss!('reply:r1');
    expect(lastReply()).toEqual(['r1', 'pass']);
  });

  it('clicking the reply box keeps the chat waiting, never past the ceiling', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(10_000);
    await act.action!('hold:r1', null);
    expect(lastReply()).toEqual(['r1', 'hold:240000']);
    expect(block(act.sheet!(senv('urgent')), 'input')?.hint).toMatch(/waits while you type/);
    // A second click changes nothing.
    await act.action!('hold:r1', null);
    expect(h.native.hookReply.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('hold:'))).toHaveLength(1);

    resetNative();
    const late = await boot();
    stubTracker(late.act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r2' });
    await tick(40_000);
    // The window is 45 s, so it is still open; the ceiling is 270 s after the Stop.
    await late.act.action!('hold:r2', null);
    expect(lastReply()).toEqual(['r2', 'hold:230000']);
  });

  it('a reply after the window closed goes the next best way (typed into the terminal)', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    h.native.hookReply.mockResolvedValue(false);
    await act.action!('reply:r1', 'try again');
    expect(h.native.claudeInject).toHaveBeenCalledWith(100, 'try again');
  });

  it('an editor chat gets the reply on the clipboard and the chat opened', async () => {
    const { act } = await boot();
    const id = '3e3f9b2f-847d-4b0f-a1f4-0884b78a7433';
    stubTracker(act, [session({ id, sessionId: id, entrypoint: 'claude-vscode', host: 'Cursor', editorHost: 'Cursor' })], { 100: [50] });
    (act as unknown as { tracker: { probe: Record<string, unknown> } }).tracker.probe.runningEditor = () => 'Cursor';
    await act.action!(`continue:${id}`, 'ship it');
    expect(h.native.clipboardSetText).toHaveBeenCalledWith('ship it');
    expect(h.native.openUrl).toHaveBeenCalledWith(`cursor://anthropic.claude-code/open?session=${id}&prompt=ship%20it`);
  });

  it('windows the pipe closed without telling us do not linger', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    await tick(48_000);
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('hook-expired takes the card down', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    emit('hook-expired', { request_id: 'r1' });
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('a new prompt in the chat ends its old reply window', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    h.native.foregroundPid.mockResolvedValue(999);
    emit('hook', { hook_event_name: 'Stop', session_id: 'S1', request_id: 'r1' });
    await tick(0);
    emit('hook', { hook_event_name: 'UserPromptSubmit', session_id: 'S1', prompt: 'typed in the chat' });
    expect(act.status().urgent ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------- permission and question cards

describe('permission and question cards', () => {
  it('shows the full command and can deny with a reason', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'p1', tool_name: 'Bash', tool_input: { command: 'rm -rf build && npm run build', description: 'Clean build' } });
    expect(h.native.hookReply).toHaveBeenCalledWith('p1', 'ack');
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'head')?.title).toBe('Run this command?');
    expect(block(card, 'code')?.text).toBe('rm -rf build && npm run build');
    await act.action!('deny-with:p1', 'keep the build folder');
    expect(lastReply()).toEqual(['p1', JSON.stringify({ kind: 'deny', message: 'keep the build folder' })]);
  });

  it('Allow and Deny send the plain words; tapping away hands the prompt back', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'p1', tool_name: 'Edit', tool_input: { file_path: 'C:\\code\\app\\a.ts' } });
    await act.action!('allow', 'p1');
    expect(lastReply()).toEqual(['p1', 'allow']);
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'p2', tool_name: 'Edit', tool_input: { file_path: 'C:\\code\\app\\b.ts' } });
    act.dismiss!('perm:p2');
    expect(lastReply()).toEqual(['p2', 'decline']);
  });

  it('a single question is answered with one tap', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    const questions = [{ question: 'Which scope?', header: 'Scope', multiSelect: false, options: [{ label: 'Account-wide', description: 'Everywhere' }, { label: 'This laptop' }] }];
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'q1', tool_name: 'AskUserQuestion', tool_input: { questions } });
    const card = act.sheet!(senv('urgent'));
    expect(card?.key).toBe('ask:q1');
    const choices = block(card, 'choices');
    expect(choices?.items.map((c) => c.label)).toEqual(['Account-wide', 'This laptop']);
    await act.action!('pick', choices!.items[1].arg);
    const [rid, reply] = lastReply();
    expect(rid).toBe('q1');
    expect(JSON.parse(reply)).toEqual({ kind: 'answer', updatedInput: { questions, answers: { 'Which scope?': 'This laptop' } } });
  });

  it('several questions wait for every answer; typed text answers the next open one', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    const questions = [
      { question: 'Framework?', options: [{ label: 'Vite' }, { label: 'Next' }] },
      { question: 'Extras?', multiSelect: true, options: [{ label: 'Tests' }, { label: 'Lint' }] },
    ];
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'q2', tool_name: 'AskUserQuestion', tool_input: { questions } });
    await act.action!('pick', { requestId: 'q2', q: 0, label: 'Vite' });
    expect(h.native.hookReply.mock.calls.some((c: unknown[]) => c[0] === 'q2' && c[1] !== 'ack')).toBe(false);
    await act.action!('pick', { requestId: 'q2', q: 1, label: 'Tests' });
    await act.action!('pick', { requestId: 'q2', q: 1, label: 'Lint' });
    expect(block(act.sheet!(senv('urgent')), 'choices', 'o1')?.items.every((c) => c.selected)).toBe(true);
    await act.action!('answer', 'q2');
    expect(JSON.parse(lastReply()[1]).updatedInput.answers).toEqual({ 'Framework?': 'Vite', 'Extras?': 'Tests, Lint' });

    emit('hook', { hook_event_name: 'PermissionRequest', session_id: 'S1', request_id: 'q3', tool_name: 'AskUserQuestion', tool_input: { questions } });
    await act.action!('pick', { requestId: 'q3', q: 0, label: 'Next' });
    await act.action!('answer-text:q3', 'Only formatting');
    expect(JSON.parse(lastReply()[1]).updatedInput.answers).toEqual({ 'Framework?': 'Next', 'Extras?': 'Only formatting' });
  });
});

// ---------------------------------------------------------------- notifications and hover

describe('notifications and the hover card', () => {
  it('a notification surfaces the chat with what it says', async () => {
    const { act, calls } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'Notification', session_id: 'S1', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    expect(calls.surface.some((s) => s.key === 'note:S1')).toBe(true);
    expect(act.status().urgent?.key).toBe('note:S1');
    expect(block(act.sheet!(senv('urgent')), 'text')?.text).toBe('Claude needs your permission to use Bash');
    // The chat moved on: nothing waits any more.
    emit('hook', { hook_event_name: 'PostToolUse', session_id: 'S1', tool_name: 'Bash' });
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('a question seen only in PreToolUse is shown read-only with Open', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], { 100: [50] });
    emit('hook', { hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship now?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'head')?.title).toBe('Claude is asking');
    expect(block(card, 'rows')?.items.map((r) => r.title)).toEqual(['Yes', 'No']);
    expect(block(card, 'buttons')?.items[0].action).toBe('switch');
  });

  it('hovering shows both limits with pace, this week’s tokens and every chat', async () => {
    const { act } = await boot();
    stubTracker(act, [session({}), session({ id: 'S2', sessionId: 'S2', pid: 200, displayTitle: 'Docs', status: 'working', slot: 2 })], { 100: [50], 200: [60] });
    act.usageState = { data: { fiveHour: { pct: 41, resetsAt: T0 + 3 * 3600_000 }, sevenDay: { pct: 79, resetsAt: T0 + 5 * 86400_000 }, models: [] }, error: null, source: 'api', fetchedAt: T0 } as never;
    act.tokenTotals = { fresh: 4_100_000, cached: 182_000_000, output: 900_000 };
    const card = act.sheet!(senv('hover'))!;
    const meters = card.blocks.filter((b) => b.t === 'meter') as Array<Extract<Block, { t: 'meter' }>>;
    expect(meters.map((m) => m.text)).toEqual(['41%', '79%']);
    expect(meters.every((m) => typeof m.pace === 'number')).toBe(true);
    expect(meters[1].tone).toBe('warn');
    expect(block(card, 'stats')?.items.find((s) => s.key === 'fresh')?.value).toBe('4.1M');
    const rows = block(card, 'rows', 'sessions')!.items;
    expect(rows.map((r) => r.title)).toEqual(['Fix the parser', 'Docs']);
    expect(rows.every((r) => r.action === 'switch')).toBe(true);
  });

  it('the grid tile lists the chats with both limits in its label, and is absent without Claude Code', async () => {
    const { act } = await boot();
    stubTracker(act, [session({}), session({ id: 'S2', sessionId: 'S2', pid: 200 })], { 100: [50], 200: [60] });
    act.usageState = { data: { fiveHour: { pct: 12, resetsAt: T0 + 3600_000 }, sevenDay: { pct: 60, resetsAt: T0 + 86400_000 }, models: [] }, error: null, source: 'api', fetchedAt: T0 } as never;
    expect(act.tile!(senv('open'))).toBeNull();
    (act as unknown as { env: unknown }).env = { configDir: 'C:\\Users\\t\\.claude' };
    const tile = act.tile!(senv('open'))!;
    expect(tile.span).toBe(2);
    expect(tile.rows).toBe(2);
    expect(tile.body.k === 'list' && tile.body.label).toBe('Claude Code · S 12% · W 60%');
  });
});

// ---------------------------------------------------------------- limits reset

describe('limits reset', () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a window past its reset time reads 0% at once, and the user is told once', async () => {
    const { act, calls } = await boot();
    const notes: unknown[][] = [];
    (act as unknown as { ctx: { notify: (...a: unknown[]) => void } }).ctx.notify = (...a) => void notes.push(a);
    stubTracker(act, [session({})], { 100: [50] });
    act.usageState = { data: { fiveHour: { pct: 100, resetsAt: T0 + 60_000 }, sevenDay: { pct: 88, resetsAt: T0 + 5 * 86400_000 }, models: [] }, error: null, source: 'cache', fetchedAt: T0 } as never;
    expect(block(act.sheet!(senv('hover')), 'meter', 'limit-s')?.text).toBe('100%');

    await tick(61_000);
    (act as unknown as { checkResets(): void }).checkResets();
    const meter = block(act.sheet!(senv('hover')), 'meter', 'limit-s');
    expect(meter?.text).toBe('0%');
    expect(meter?.sub).toMatch(/^Reset/);
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe('Session limit reset');
    expect(calls.surface.some((s) => s.key === 'notice')).toBe(true);

    // Only once, even across another check (and a restart, through storage).
    await tick(5_000);
    (act as unknown as { checkResets(): void }).checkResets();
    expect(notes).toHaveLength(1);
    expect(JSON.parse(memory.get('island.claude.resetSeen')!).session).toBe(T0 + 60_000);
  });

  it('a reset long ago is recorded quietly', async () => {
    const { act } = await boot();
    const notes: unknown[][] = [];
    (act as unknown as { ctx: { notify: (...a: unknown[]) => void } }).ctx.notify = (...a) => void notes.push(a);
    act.usageState = { data: { fiveHour: { pct: 40, resetsAt: T0 - 2 * 86400_000 }, sevenDay: null, models: [] }, error: null, source: 'cache', fetchedAt: T0 } as never;
    await tick(2_000);
    (act as unknown as { checkResets(): void }).checkResets();
    expect(notes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- helpers

describe('helpers', () => {
  it('questionsOf keeps only well-formed questions and options', () => {
    expect(questionsOf(null)).toEqual([]);
    expect(questionsOf({ questions: 'nope' })).toEqual([]);
    expect(questionsOf({ questions: [{ question: 'A?', options: [{ label: 'x' }, { nope: 1 }, null] }, { header: 'no question' }] })).toEqual([
      { question: 'A?', header: undefined, multiSelect: false, options: [{ label: 'x', description: undefined }] },
    ]);
  });

  it('HookState keeps the final message and forgets a chat that moved on', () => {
    const s = new HookState();
    s.holds.push({ requestId: 'old', sessionId: 'S1', message: '', at: 0, until: 1, total: 1, held: false });
    s.apply({ hook_event_name: 'Stop', session_id: 'S1', last_assistant_message: '  done  ' }, 10);
    expect(s.lastMessage.get('S1')).toEqual({ text: 'done', at: 10 });
    expect(s.holds).toHaveLength(0);
    s.apply({ hook_event_name: 'Notification', session_id: 'S1', message: 'waiting', notification_type: 'idle_prompt' }, 20);
    s.apply({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } }, 30);
    expect(s.notes.get('S1')?.kind).toBe('idle_prompt');
    expect(s.asks.get('S1')?.questions[0].question).toBe('Q?');
    s.apply({ hook_event_name: 'UserPromptSubmit', session_id: 'S1' }, 40);
    expect(s.notes.has('S1')).toBe(false);
    expect(s.asks.has('S1')).toBe(false);
  });

  it('plainText turns Markdown into readable text', () => {
    expect(plainText('# Title\n\n**Bold** and `code`, see [the docs](https://x.y).\n- one\n  * two\n> quoted')).toBe('Title\n\nBold and code, see the docs.\n• one\n  • two\nquoted');
    expect(plainText('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('mapActions reaches every action in every block and tile', () => {
    const blocks: Block[] = [
      { t: 'head', key: 'h', title: 't', buttons: [{ key: 'b', action: 'open' }] },
      { t: 'buttons', key: 'bs', items: [{ key: 'x', action: 'go' }] },
      { t: 'input', key: 'i', placeholder: '', action: 'send', engage: 'hold' },
      { t: 'rows', key: 'r', items: [{ key: 'a', title: 'a', action: 'pick' }, { key: 'b', title: 'b' }] },
      { t: 'choices', key: 'c', items: [{ key: 'c', label: 'c', action: 'choose' }] },
      {
        t: 'tiles',
        key: 'g',
        items: [
          { key: 't1', action: 'tap', body: { k: 'actions', label: 'l', buttons: [{ key: 'b', action: 'start' }] } },
          { key: 't2', body: { k: 'list', icon: 'x', label: 'l', rows: [{ key: 'r', title: 'r', action: 'row' }] } },
          { key: 't3', body: { k: 'media', title: '', artist: '', playing: true, buttons: [{ key: 'p', action: 'play' }] } },
          { key: 't4', action: 'island:app', body: { k: 'stat', icon: 'x', label: 'l', value: 'v' } },
        ],
      },
    ];
    const out = JSON.stringify(mapActions(blocks, (a) => (a.startsWith('island:') ? a : `act:x:${a}`)));
    for (const a of ['open', 'go', 'send', 'hold', 'pick', 'choose', 'tap', 'start', 'row', 'play']) expect(out).toContain(`"act:x:${a}"`);
    expect(out).toContain('"island:app"');
    expect(out).not.toMatch(/"action":"(?!act:|island:)/);
  });
});
