// Talking to Claude from Island's phone app: Claude's card on a phone (the chats, one chat, a new
// chat), where a message goes (messageChat's four cases), following a chat started in an Island
// terminal, and reading a chat's last messages from its transcript. Rust is faked; a stub tracker
// supplies the chats and their process chains.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), native: {} as Record<string, any>, files: new Map<string, string[]>() }));

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
import { defaultSettings } from '../src/core/settings';
import type { Block, SheetView } from '../src/core/sheet';
import { ClaudeActivity } from '../src/activities/claude';
import { claudeArgs, oneLine, recentFolders, routeFor, routeHint, terminalFor, type ChatTarget } from '../src/activities/claude/phonechat';
import { toolDone } from '../src/activities/claude/status';
import type { ClosedView, SessionView } from '../src/activities/claude/tracker';
import { chatMessages } from '../src/activities/claude/transcript';
import { PhoneError } from '../src/remote/hub';
import type { TermInfo } from '../src/remote/protocol';
import { assistant, iso, toolResult, user } from './helpers';

const T0 = Date.parse('2026-10-28T15:00:00Z');
const VSCODE = '9ef06229-3953-4aea-95ce-2d36bbbaf580';
const CLI = '1b2c3d4e-0000-4aea-95ce-2d36bbbaf581';
const ISLAND = '7a7a7a7a-1111-4aea-95ce-2d36bbbaf582';
const COPY = '5c5c5c5c-2222-4aea-95ce-2d36bbbaf583';

function resetNative() {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  h.files.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    log: vi.fn(async () => undefined),
    claudeEnv: vi.fn(async () => null),
    hookReply: vi.fn(async () => true),
    foregroundPid: vi.fn(async () => 0),
    procSnapshot: vi.fn(async () => []),
    claudeInject: vi.fn(async () => ({ ok: true, error: null })),
    termWrite: vi.fn(async () => ({ ok: true, value: null })),
    termOpen: vi.fn(async () => ({ ok: true, value: { id: 'c0ffee01', pid: 700 } })),
    termKill: vi.fn(async () => ({ ok: true, value: null })),
    termList: vi.fn(async () => []),
    openUrl: vi.fn(async () => true),
    allowForeground: vi.fn(async () => undefined),
    winEnum: vi.fn(async () => []),
    activate: vi.fn(async () => true),
    statMany: vi.fn(async (paths: string[]) => paths.map((p) => (h.files.has(p) ? { size: h.files.get(p)!.join('\n').length, mtimeMs: T0, dir: false } : null))),
    readTail: vi.fn(async (p: string) => (h.files.has(p) ? { size: h.files.get(p)!.join('\n').length, mtimeMs: T0, lines: h.files.get(p)! } : null)),
  });
}

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot() {
  const act = new ClaudeActivity();
  const settings = defaultSettings();
  const ctx: ActivityContext = {
    id: 'claude',
    config: () => settings.activities.config.claude,
    options: () => ({}) as never,
    settings: () => settings,
    update: () => {},
    surface: () => {},
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: () => {},
    openCard: vi.fn(),
    cardOpen: () => true,
  };
  await act.start(ctx);
  await tick(0);
  return { act, ctx };
}

const session = (over: Partial<SessionView>): SessionView =>
  ({
    id: CLI, sessionId: CLI, pid: 100, cwd: 'C:\\code\\app', name: '', kind: 'interactive', entrypoint: 'cli', alive: true,
    status: 'awaiting_input', label: 'Your turn', tone: 'turn', needsYou: false, title: null, displayTitle: 'Fix the parser', project: 'app', host: 'Terminal',
    editorHost: null, hostKind: 'terminal', model: 'Opus 5.5', permissionMode: 'default', gitBranch: 'main', lastActivityMs: T0, lastAliveAt: T0,
    slot: 1, tool: null, operation: null, turnStartMs: T0 - 60_000, lastAssistantText: null, transcript: null, version: null,
    ...over,
  }) as SessionView;

const closedChat = (over: Partial<ClosedView>): ClosedView => ({
  id: VSCODE, sessionId: VSCODE, cwd: 'C:\\code\\island', entrypoint: 'claude-vscode', displayTitle: 'Island phone app', title: 'Island phone app', project: 'island',
  model: null, closedAt: T0 - 3_600_000, source: 'history', ...over,
});

const term = (over: Partial<TermInfo>): TermInfo => ({ id: 'aaaa0001', title: 'PowerShell', cwd: 'C:\\code', shell: 'powershell', pid: 500, started: T0 - 60_000, exit: null, attached: 0, claude: false, ...over });

/**
 * Chats plus their process chains: `chains[pid]` lists a Claude Code process's ancestors,
 * nearest first. `live` is what the tracker sees now; change it and poll again.
 */
function stubTracker(act: ClaudeActivity, sessions: SessionView[], closed: ClosedView[], chains: Record<number, number[]>) {
  const state = { sessions, closed };
  const probe = {
    table: new Map<number, unknown>(Object.keys(chains).map((k) => [Number(k), {}])),
    ancestors: (pid: number) => (chains[pid] ?? []).map((p) => ({ pid: p, name: 'host.exe' })),
    load: vi.fn(),
    runningEditor: () => 'VS Code',
  };
  (act as unknown as { tracker: unknown }).tracker = {
    probe,
    get: (id: string) => state.sessions.find((s) => s.id === id) ?? null,
    getClosed: (id: string) => state.closed.find((c) => c.id === id) ?? null,
    poll: async () => ({ sessions: state.sessions, closed: state.closed, events: [] }),
    closedList: () => state.closed,
  };
  act.sessions = sessions;
  act.closed = closed;
  return state;
}

/** The activity's poll, as its timer runs it. */
const poll = (act: ClaudeActivity) => (act as unknown as { pollSessions(): Promise<void> }).pollSessions();

const env = (over: Partial<SheetEnv> = {}): SheetEnv => ({ reason: 'open', now: Date.now(), width: 362, vertical: false, interactive: true, surfaced: null, ...over });
const block = <T extends Block['t']>(view: SheetView | null | undefined, t: T, key?: string) =>
  view?.blocks.find((b) => b.t === t && (key === undefined || b.key === key)) as Extract<Block, { t: T }> | undefined;
const texts = (view: SheetView | null | undefined) => (view?.blocks ?? []).filter((b): b is Extract<Block, { t: 'text' }> => b.t === 'text').map((b) => b.text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNative();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- the card on a phone

describe("Claude's card on a phone", () => {
  it('lists the limits, every chat (live, then closed: 8 at most), and a new chat in up to 4 recent folders', async () => {
    const { act } = await boot();
    const live = [
      session({ id: CLI, sessionId: CLI, status: 'working', label: 'Working', displayTitle: 'Fix the parser', cwd: 'C:\\code\\app', project: 'app', lastActivityMs: T0 }),
      session({ id: VSCODE, sessionId: VSCODE, entrypoint: 'claude-vscode', needsYou: true, status: 'awaiting_permission', label: 'Needs you', tone: 'needs', displayTitle: 'Phone app', cwd: 'C:\\code\\island', project: 'island', lastActivityMs: T0 - 5000 }),
    ];
    const closed = Array.from({ length: 9 }, (_, i) => closedChat({ id: `c${i}`, sessionId: `c${i}`, displayTitle: `Old ${i}`, cwd: i < 3 ? `C:\\code\\old${i}` : 'c:\\CODE\\app\\', project: `old${i}`, closedAt: T0 - (i + 1) * 3_600_000 }));
    stubTracker(act, live, closed, {});
    act.usageState = { data: { fiveHour: { pct: 41, resetsAt: T0 + 3_600_000 }, sevenDay: { pct: 60, resetsAt: T0 + 86_400_000 }, models: [] }, error: null, source: 'api', fetchedAt: T0 } as never;

    const view = act.sheet!(env());
    expect(view?.key).toBe('chats');
    expect(block(view, 'meter', 'limit-s')?.text).toBe('41%');
    expect(block(view, 'meter', 'limit-w')?.text).toBe('60%');
    const rows = block(view, 'rows', 'chats')!.items;
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.title).slice(0, 3)).toEqual(['Fix the parser', 'Phone app', 'Old 0']);
    expect(rows[0]).toMatchObject({ action: 'chat', arg: CLI, detail: 'Working… · app' });
    expect(rows[1]).toMatchObject({ action: 'chat', arg: VSCODE, detail: 'Needs you · island', pulse: true });
    expect(rows[2]).toMatchObject({ action: 'chat', arg: 'c0', detail: 'Closed 1h ago · old0', icon: 'history' });
    // Folders: newest first, the same folder once whatever its spelling, four at most.
    const folders = block(view, 'buttons', 'new')!.items;
    expect(folders.map((b) => b.arg)).toEqual(['C:\\code\\app', 'C:\\code\\island', 'C:\\code\\old0', 'C:\\code\\old1']);
    expect(folders.map((b) => b.label)).toEqual(['app', 'island', 'old0', 'old1']);
    expect(folders.every((b) => b.action === 'chat-new')).toBe(true);
    // Hello carries six.
    expect(act.recentFolders(6)).toEqual(['C:\\code\\app', 'C:\\code\\island', 'C:\\code\\old0', 'C:\\code\\old1', 'C:\\code\\old2']);
  });

  it('opens a chat on the phone that tapped, with its last 12 messages, oldest first', async () => {
    const { act, ctx } = await boot();
    const file = 'C:\\claude\\projects\\app\\chat.jsonl';
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(JSON.stringify(user(`Prompt ${i}`, T0 - 100_000 + i * 1000)), JSON.stringify({ ...assistant(T0 - 99_000 + i * 1000), uuid: `a${i}`, message: { content: [{ type: 'text', text: `**Answer** ${i}` }], stop_reason: 'end_turn' } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: 'tool', timestamp: iso(T0 - 1000), message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\code\\app\\island.ts' } }] } }));
    lines.push(JSON.stringify(toolResult('t1', T0 - 900)));
    h.files.set(file, lines);
    stubTracker(act, [session({ status: 'working', label: 'Working', transcript: file })], [], {});

    await act.action!('chat', CLI);
    expect(ctx.openCard).toHaveBeenCalledTimes(1);
    const view = act.sheet!(env());
    expect(view?.key).toBe(`chat:${CLI}`);
    expect(block(view, 'head')).toMatchObject({ title: 'Fix the parser', sub: 'app · Working…', buttons: [{ action: 'chat-back' }] });
    const said = texts(view);
    // The last 12 of 17 (8 prompts, 8 answers, the edit), oldest first; the tool result is not a message.
    expect(said.slice(0, 2)).toEqual(['Answer 2', 'You: Prompt 3']);
    expect(said).toContain('Edited island.ts');
    expect(said.filter((t) => t.startsWith('You: ') || t.startsWith('Answer') || t.startsWith('Edited'))).toHaveLength(12);
    const answer = view!.blocks.find((b) => b.t === 'text' && b.text === 'Answer 7') as Extract<Block, { t: 'text' }>;
    expect(answer).toMatchObject({ bubble: true, lines: 9 });
    expect(said.at(-1)).toBe('Claude is working…');
    // The box, always there, and where a message goes.
    const input = block(view, 'input', 'say')!;
    expect(input).toMatchObject({ placeholder: 'Message Claude…', action: `say:${CLI}`, hint: 'Types it into its terminal on your PC.' });

    await act.action!('chat-back', null);
    expect(act.sheet!(env())?.key).toBe('chats');
  });

  it("says when a permission card waits for this chat, and a VS Code chat's hint says it continues as a copy", async () => {
    const { act } = await boot();
    stubTracker(act, [session({ id: VSCODE, sessionId: VSCODE, entrypoint: 'claude-vscode', host: 'VS Code' })], [], {});
    emit('hook', { hook_event_name: 'PermissionRequest', session_id: VSCODE, request_id: 'p1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await act.action!('chat', VSCODE);
    const view = act.sheet!(env());
    expect(texts(view)).toContain('Claude waits for your OK: its card has Allow and Deny.');
    expect(block(view, 'input', 'say')?.hint).toBe('Continues on your PC in the background (a copy of the VS Code chat)');
  });

  it('starts a new chat in a folder: its own head and box', async () => {
    const { act, ctx } = await boot();
    stubTracker(act, [session({})], [], {});
    await act.action!('chat-new', 'C:\\code\\app');
    expect(ctx.openCard).toHaveBeenCalledTimes(1);
    const view = act.sheet!(env());
    expect(view?.key).toBe('new:C:\\code\\app');
    expect(block(view, 'head')).toMatchObject({ title: 'New chat in app', sub: 'C:\\code\\app' });
    expect(block(view, 'input', 'say')).toMatchObject({ placeholder: 'What should Claude do?', action: 'say:new:C:\\code\\app', hint: 'Starts Claude in this folder on your PC, in the background' });
  });

  it('a chat that is gone shows the list', async () => {
    const { act } = await boot();
    stubTracker(act, [session({})], [], {});
    await act.action!('chat', 'not-a-chat');
    expect(act.sheet!(env())?.key).toBe('chats');
  });
});

// ---------------------------------------------------------------- where a message goes

describe('messageChat', () => {
  it('1. a chat in an Island terminal: the text, then Enter on its own', async () => {
    const { act } = await boot();
    stubTracker(act, [session({ id: ISLAND, sessionId: ISLAND, pid: 501 })], [], { 501: [500, 4] });
    emit('term-changed', [term({ id: 'aaaa0001', pid: 500 })]);
    const sending = act.messageChat(ISLAND, 'now add\ntests');
    await tick(200);
    expect(await sending).toEqual({ how: 'term', term: 'aaaa0001' });
    expect(h.native.termWrite.mock.calls).toEqual([
      ['aaaa0001', 'now add tests'],
      ['aaaa0001', '\r'],
    ]);
    expect(h.native.claudeInject).not.toHaveBeenCalled();
    expect(h.native.termOpen).not.toHaveBeenCalled();
  });

  it("2. a live terminal chat of its own: typed into its console", async () => {
    const { act } = await boot();
    stubTracker(act, [session({ pid: 100 })], [], { 100: [50] });
    emit('term-changed', [term({ pid: 500 })]);
    expect(await act.messageChat(CLI, 'run the tests')).toEqual({ how: 'inject', pid: 100 });
    expect(h.native.claudeInject).toHaveBeenCalledWith(100, 'run the tests');
    expect(h.native.termWrite).not.toHaveBeenCalled();
  });

  it('3. a VS Code chat still open: a copy goes on in an Island terminal (--fork-session)', async () => {
    const { act } = await boot();
    stubTracker(act, [session({ id: VSCODE, sessionId: VSCODE, pid: 300, entrypoint: 'claude-vscode', cwd: 'C:\\code\\island', displayTitle: 'Phone app' })], [], { 300: [30] });
    expect((await act.messageChat(VSCODE, 'keep going')).how).toBe('fork');
    expect(h.native.termOpen).toHaveBeenCalledWith({ cwd: 'C:\\code\\island', shell: null, program: 'claude', args: ['--resume', VSCODE, '--fork-session', 'keep going'], cols: 120, rows: 36, title: 'Phone app', claude: true });
  });

  it('3. a closed chat, VS Code or terminal: reopened as it is (no --fork-session)', async () => {
    const { act } = await boot();
    stubTracker(act, [], [closedChat({}), closedChat({ id: CLI, sessionId: CLI, entrypoint: 'cli', cwd: 'C:\\code\\app' })], {});
    expect((await act.messageChat(VSCODE, 'what was left?')).how).toBe('resume');
    expect(h.native.termOpen.mock.calls[0][0]).toMatchObject({ cwd: 'C:\\code\\island', program: 'claude', args: ['--resume', VSCODE, 'what was left?'], claude: true });
    await act.messageChat(CLI, 'and here?');
    expect(h.native.termOpen.mock.calls[1][0].args).toEqual(['--resume', CLI, 'and here?']);
  });

  it('4. a new chat: `claude <text>` in that folder, the text one argument (a leading dash is not an option)', async () => {
    const { act } = await boot();
    stubTracker(act, [], [], {});
    expect((await act.messageChat(null, 'Write the README', 'C:\\code\\app')).how).toBe('new');
    expect(h.native.termOpen.mock.calls[0][0]).toMatchObject({ cwd: 'C:\\code\\app', program: 'claude', args: ['Write the README'], title: 'Write the README', claude: true });
    await act.action!('say:new:C:\\code\\app', '--dangerously-skip-permissions');
    expect(h.native.termOpen.mock.calls[1][0].args).toEqual([' --dangerously-skip-permissions']);
  });

  it('says on the phone what went wrong (a PhoneError the hub shows as a toast)', async () => {
    const { act } = await boot();
    stubTracker(act, [], [closedChat({})], {});
    h.native.termOpen.mockResolvedValueOnce({ ok: false, error: 'claude is not installed' });
    const failed = act.action!(`say:${VSCODE}`, 'hello');
    await expect(failed).rejects.toBeInstanceOf(PhoneError);
    await expect(failed).rejects.toThrow("Couldn't start Claude: claude is not installed");
    await expect(act.messageChat('gone', 'hi')).rejects.toThrow('That chat is gone');
    h.native.claudeInject.mockResolvedValueOnce({ ok: false, error: 'mintty' });
    stubTracker(act, [session({})], [], {});
    await expect(act.messageChat(CLI, 'hi')).rejects.toThrow("Couldn't type it into its terminal: mintty");
  });

  it('follows the copy once the tracker sees it in the terminal, then types into it', async () => {
    const { act } = await boot();
    const vs = session({ id: VSCODE, sessionId: VSCODE, pid: 300, entrypoint: 'claude-vscode', cwd: 'C:\\code\\island', displayTitle: 'Phone app' });
    const state = stubTracker(act, [vs], [], { 300: [30] });
    await act.action!('chat', VSCODE);
    await act.action!(`say:${VSCODE}`, 'keep going');
    // Until the copy shows up, the box gives way to a line (a second message would start a second copy).
    let view = act.sheet!(env());
    expect(texts(view)).toEqual(expect.arrayContaining(['You: keep going', 'Starting Claude on your PC…']));
    expect(block(view, 'input', 'say')).toBeUndefined();

    // The terminal runs claude.exe as pid 700; its chat registers as COPY.
    h.native.termList.mockResolvedValue([term({ id: 'c0ffee01', pid: 700, claude: true, title: 'Phone app' })]);
    state.sessions = [vs, session({ id: COPY, sessionId: COPY, pid: 700, cwd: 'C:\\code\\island', displayTitle: 'Phone app' })];
    (act as unknown as { tracker: { probe: { ancestors: (pid: number) => unknown[] } } }).tracker.probe.ancestors = (pid: number) => (pid === 700 ? [{ pid: 9, name: 'island.exe' }] : [{ pid: 30, name: 'code.exe' }]);
    await poll(act);
    await tick(0);
    await poll(act);
    await tick(0);
    expect(act.forks.get(VSCODE)).toBe(COPY);
    view = act.sheet!(env());
    expect(view?.key).toBe(`chat:${COPY}`);
    expect(texts(view)).toContain('You: keep going');
    expect(block(view, 'input', 'say')).toMatchObject({ action: `say:${COPY}`, hint: 'Goes straight into the chat on your PC.' });
    // The copy is a chat in an Island terminal now: the next message is typed into it.
    expect(act.sessions.find((s) => s.id === COPY)?.host).toBe('Island');
    const typing = act.messageChat(COPY, 'and the docs');
    await tick(200);
    expect(await typing).toEqual({ how: 'term', term: 'c0ffee01' });
    expect(h.native.termWrite.mock.calls).toEqual([
      ['c0ffee01', 'and the docs'],
      ['c0ffee01', '\r'],
    ]);
  });

  it('says so on the card when Claude stopped before the chat began', async () => {
    const { act } = await boot();
    stubTracker(act, [], [], {});
    await act.action!('chat-new', 'C:\\code\\app');
    await act.messageChat(null, 'Write the README', 'C:\\code\\app');
    h.native.termList.mockResolvedValue([term({ id: 'c0ffee01', pid: 700, claude: true, exit: 1 })]);
    await poll(act);
    await tick(10);
    await poll(act);
    const view = act.sheet!(env());
    expect(texts(view)).toContain('Claude stopped on your PC before the chat began (exit code 1). Its terminal shows why.');
    expect(block(view, 'input', 'say')?.action).toBe('say:new:C:\\code\\app');
  });
});

// ---------------------------------------------------------------- on the PC

describe('a chat in an Island terminal, on the PC', () => {
  it('Open moves it to VS Code: its Claude ends in the terminal, the deep link opens it', async () => {
    const { act } = await boot();
    stubTracker(act, [session({ id: ISLAND, sessionId: ISLAND, pid: 501 })], [], { 501: [500] });
    emit('term-changed', [term({ id: 'aaaa0001', pid: 500, claude: true })]);
    const opening = act.switchTo(ISLAND);
    await tick(1000);
    expect(await opening).toBe(true);
    expect(h.native.termKill).toHaveBeenCalledWith('aaaa0001');
    expect(h.native.openUrl).toHaveBeenCalledWith(`vscode://anthropic.claude-code/open?session=${ISLAND}`);
  });
});

// ---------------------------------------------------------------- the pure parts

describe('routing, folders and the command line', () => {
  const chain = (pid: number) => (pid === 501 ? [501, 500, 4] : [pid, 1]);
  const live = (over: Partial<ChatTarget> = {}): ChatTarget => ({ sessionId: CLI, cwd: 'C:\\code\\app', entrypoint: 'cli', pid: 501, alive: true, ...over });

  it("finds the running Island terminal a process is in", () => {
    const terms = [term({ id: 'old', pid: 500, exit: 0 }), term({ id: 'run', pid: 500 })];
    expect(terminalFor(501, terms, chain)?.id).toBe('run');
    expect(terminalFor(77, terms, chain)).toBeNull();
    expect(terminalFor(0, terms, chain)).toBeNull();
  });

  it('routes by where the chat lives', () => {
    const island = term({ id: 'run', pid: 500 });
    expect(routeFor(live(), island)).toEqual({ how: 'term', term: 'run' });
    expect(routeFor(live(), null)).toEqual({ how: 'inject', pid: 501 });
    expect(routeFor(live({ entrypoint: 'claude-vscode' }), null)).toEqual({ how: 'fork', sessionId: CLI, cwd: 'C:\\code\\app' });
    expect(routeFor(live({ alive: false, pid: 0 }), null)).toEqual({ how: 'resume', sessionId: CLI, cwd: 'C:\\code\\app' });
    expect(routeHint({ how: 'resume', sessionId: CLI, cwd: '' })).toBe('Reopens the chat on your PC in the background');
  });

  it("builds claude's arguments with the text as one argument", () => {
    expect(claudeArgs({ how: 'fork', sessionId: 'S', cwd: 'C:\\x' }, 'a "quoted" & piped | text')).toEqual(['--resume', 'S', '--fork-session', 'a "quoted" & piped | text']);
    expect(claudeArgs({ how: 'resume', sessionId: 'S', cwd: 'C:\\x' }, '-p')).toEqual(['--resume', 'S', ' -p']);
    expect(claudeArgs({ how: 'term', term: 't' }, 'x')).toBeNull();
    expect(oneLine('  one\r\ntwo \n three ')).toBe('one two three');
  });

  it('keeps the newest of each folder', () => {
    const items = [
      { cwd: 'C:\\code\\app', at: 1 },
      { cwd: 'c:\\code\\APP\\', at: 5 },
      { cwd: '', at: 9 },
      { cwd: 'C:\\code\\island', at: 3 },
    ];
    expect(recentFolders(items, 6)).toEqual(['c:\\code\\APP\\', 'C:\\code\\island']);
    expect(recentFolders(items, 1)).toEqual(['c:\\code\\APP\\']);
  });
});

describe("a chat's last messages, from its transcript", () => {
  it('keeps prompts, Claude\'s text, one line per tool call and API errors; drops tool results, interrupts, side chains and meta', () => {
    const lines = [
      JSON.stringify(user('<command-name>/clear</command-name>', T0 - 9000)),
      JSON.stringify({ ...user('Fix   the\nparser', T0 - 8000), uuid: 'u1' }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: iso(T0 - 7000), message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\nnpm run lint', description: 'Run the tests' } }] } }),
      JSON.stringify(toolResult('t1', T0 - 6000)),
      JSON.stringify(user('[Request interrupted by user]', T0 - 5000)),
      JSON.stringify({ ...user('a subagent prompt', T0 - 4000), isSidechain: true }),
      JSON.stringify({ ...user('<local-command-stdout>ok</local-command-stdout>', T0 - 3500) }),
      JSON.stringify({ ...user('caveat', T0 - 3200), isMeta: true }),
      JSON.stringify({ type: 'assistant', uuid: 'e1', isApiErrorMessage: true, timestamp: iso(T0 - 3000), message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }),
      'not json',
    ];
    const got = chatMessages(lines, 12);
    expect(got.map((m) => [m.kind, m.text])).toEqual([
      ['you', '/clear'],
      ['you', 'Fix the parser'],
      ['claude', 'Looking.'],
      ['tool', 'Ran npm test'],
      ['note', 'API Error: 529 Overloaded'],
    ]);
    expect(got[2].key).toBe('a1:0');
    expect(got[2].at).toBe(T0 - 7000);
    expect(chatMessages(lines, 2).map((m) => m.kind)).toEqual(['tool', 'note']);
  });

  it('says what each tool did, done', () => {
    expect(toolDone('Edit', { file_path: 'C:\\code\\src\\island.ts' })).toBe('Edited island.ts');
    expect(toolDone('Write', { file_path: '/x/README.md' })).toBe('Wrote README.md');
    expect(toolDone('Read', { file_path: 'C:\\a\\b.ts' })).toBe('Read b.ts');
    expect(toolDone('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Ran npm test');
    expect(toolDone('Bash', {})).toBe('Ran a command');
    expect(toolDone('Grep', { pattern: 'TODO' })).toBe('Searched for TODO');
    expect(toolDone('Grep', {})).toBe('Searched');
    expect(toolDone('WebFetch', { url: 'https://docs.rs/iroh' })).toBe('Read docs.rs');
    expect(toolDone('TodoWrite', {})).toBe('Updated its plan');
    expect(toolDone('mcp__github__create_issue', {})).toBe('Used github create_issue');
    expect(toolDone('Frobnicate', {})).toBe('Used Frobnicate');
  });
});
