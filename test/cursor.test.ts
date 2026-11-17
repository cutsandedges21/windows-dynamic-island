// Cursor in the island: its transcripts read, its chats tracked from hooks and transcripts, and the
// shared engine's cards and reply window for Cursor's own hook events (their names and shapes as
// Cursor 3.27 sends them). The native layer is faked.

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
import type { CursorEnv, ProcRow } from '../src/core/native';
import type { Block, SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { CursorActivity } from '../src/activities/cursor';
import { CursorTracker, type CursorHook } from '../src/activities/cursor/tracker';
import { chatMessages, folderOf, parseLines, summarize, userText } from '../src/activities/cursor/transcript';
import type { SessionView } from '../src/activities/claude/tracker';

const T0 = Date.parse('2026-10-30T22:00:00Z');
const CID = '9a84f2ca-ba84-4f61-92f3-405d00225933';
const ENV: CursorEnv = { home: 'C:\\Users\\x\\.cursor', projectsDir: 'C:\\Users\\x\\.cursor\\projects', cursorExe: 'C:\\cursor\\Cursor.exe', hookExe: 'C:\\island-hook.exe', hookReady: true };
const FILE = `C:\\Users\\x\\.cursor\\projects\\c-code-app\\agent-transcripts\\${CID}\\${CID}.jsonl`;

/** A chat as Cursor writes it: a request, an answer with a command, the turn's end. */
const TRANSCRIPT = [
  { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Thursday, Oct 30</timestamp>\n<user_query>\nfix the failing tests\n</user_query>' }] } },
  { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm test', working_directory: 'C:\\code\\app' } }] } },
  { role: 'assistant', message: { content: [{ type: 'text', text: 'Fixed: the parser skipped empty lines.' }] } },
  { type: 'turn_ended', status: 'success' },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

/** The Cursor window's processes: its main process (600) and the one that runs hooks (650). */
const PROCS: ProcRow[] = [
  [600, 1, 'Cursor.exe', T0 - 3_600_000],
  [650, 600, 'Cursor.exe', T0 - 3_500_000],
];

/** What island-hook forwards for a Cursor hook (Cursor's fields, the relay's on top). */
const hook = (over: Partial<CursorHook>): CursorHook => ({
  hook_event_name: 'sessionStart', agent: 'cursor', conversation_id: CID, session_id: CID, generation_id: '', model: 'claude-4.5-sonnet',
  cursor_version: '3.27.22', workspace_roots: ['/c:/code/app'], transcript_path: FILE, hook_pid: 900, hook_ppid: 800, hook_gppid: 650,
  ...over,
} as CursorHook);

describe('Cursor transcripts', () => {
  it('reads the request as typed, the last answer, what it ran and how the turn ended', () => {
    expect(userText('<timestamp>x</timestamp>\n<user_query>\n  add a test\n</user_query>')).toBe('add a test');
    expect(userText('plain words')).toBe('plain words');
    const s = summarize(parseLines(TRANSCRIPT));
    expect(s).toMatchObject({ title: 'fix the failing tests', lastPrompt: 'fix the failing tests', lastAssistant: 'Fixed: the parser skipped empty lines.', turnOpen: false, error: false, lastTool: 'Ran npm test', turns: 1 });
  });

  it('a request after the last turn ended is a turn under way; an error ends it badly', () => {
    const more = `${TRANSCRIPT}\n${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>now commit</user_query>' }] } })}`;
    expect(summarize(parseLines(more))).toMatchObject({ turnOpen: true, lastPrompt: 'now commit', title: 'fix the failing tests' });
    const failed = `${more}\n${JSON.stringify({ type: 'turn_ended', status: 'error' })}`;
    expect(summarize(parseLines(failed))).toMatchObject({ turnOpen: false, error: true });
  });

  it('gives the phone the messages without hidden thinking', () => {
    const msgs = chatMessages(parseLines(TRANSCRIPT), 10);
    expect(msgs.map((m) => [m.kind, m.text])).toEqual([
      ['you', 'fix the failing tests'],
      ['tool', 'Ran npm test'],
      ['claude', 'Fixed: the parser skipped empty lines.'],
    ]);
  });

  it("turns Cursor's workspace roots into folders", () => {
    expect(folderOf('/c:/code/my%20app')).toBe('c:\\code\\my app');
    expect(folderOf('/home/me/app')).toBe('/home/me/app');
    expect(folderOf(undefined)).toBe('');
  });
});

function setNative(over: Record<string, unknown> = {}) {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    procSnapshot: vi.fn(async () => PROCS),
    cursorTranscripts: vi.fn(async () => []),
    statMany: vi.fn(async (paths: string[]) => paths.map(() => null)),
    readText: vi.fn(async () => null),
    cursorEnv: vi.fn(async () => null),
    hookReply: vi.fn(async () => true),
    foregroundPid: vi.fn(async () => 0),
    clipboardSetText: vi.fn(async () => true),
    allowForeground: vi.fn(async () => undefined),
    winEnum: vi.fn(async () => []),
    activate: vi.fn(async () => true),
    cursorOpen: vi.fn(async () => true),
    termList: vi.fn(async () => []),
    ...over,
  });
}

describe('Cursor chats', () => {
  beforeEach(() => setNative());

  it('a request makes a chat live and working, held by the Cursor that ran the hook', async () => {
    const t = new CursorTracker(ENV);
    t.noteHook(hook({}), T0);
    t.noteHook(hook({ hook_event_name: 'beforeSubmitPrompt', prompt: 'fix the failing tests' }), T0 + 1000);
    const r = await t.poll(T0 + 2000);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ id: CID, pid: 650, status: 'working', displayTitle: 'fix the failing tests', cwd: 'c:\\code\\app', project: 'app', host: 'Cursor', model: 'claude-4.5-sonnet' });
  });

  it("a new window's empty chat isn't listed", async () => {
    const t = new CursorTracker(ENV);
    t.noteHook(hook({ transcript_path: null }), T0);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed).toHaveLength(0);
  });

  it("stop makes it your turn with Cursor's last answer; sessionEnd closes it", async () => {
    const t = new CursorTracker(ENV);
    t.noteHook(hook({ hook_event_name: 'beforeSubmitPrompt', prompt: 'fix it' }), T0);
    t.noteHook(hook({ hook_event_name: 'afterAgentResponse', text: 'Fixed and tested.' }), T0 + 4000);
    t.noteHook(hook({ hook_event_name: 'stop', status: 'completed' }), T0 + 5000);
    let r = await t.poll(T0 + 6000);
    expect(r.sessions[0]).toMatchObject({ status: 'awaiting_input', label: 'Your turn', lastAssistantText: 'Fixed and tested.' });
    expect(t.lastWords(CID)).toBe('Fixed and tested.');
    t.noteHook(hook({ hook_event_name: 'sessionEnd', reason: 'user_close' }), T0 + 7000);
    r = await t.poll(T0 + 8000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed.map((c) => c.id)).toEqual([CID]);
    expect(r.events.map((e) => e.type)).toContain('closed');
  });

  it('a stopped turn says so', async () => {
    const t = new CursorTracker(ENV);
    t.noteHook(hook({ hook_event_name: 'beforeSubmitPrompt', prompt: 'go' }), T0);
    t.noteHook(hook({ hook_event_name: 'stop', status: 'aborted' }), T0 + 2000);
    const r = await t.poll(T0 + 3000);
    expect(r.sessions[0]).toMatchObject({ status: 'interrupted' });
  });

  it('a chat whose Cursor is gone is closed', async () => {
    const t = new CursorTracker(ENV);
    t.noteHook(hook({ hook_gppid: 999, hook_ppid: 998, hook_event_name: 'beforeSubmitPrompt', prompt: 'hi' }), T0);
    const r = await t.poll(T0 + 1000);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed.map((c) => c.id)).toEqual([CID]);
  });

  it('a transcript written minutes ago is an open chat while Cursor runs, read once', async () => {
    setNative({
      cursorTranscripts: vi.fn(async () => [{ path: FILE, id: CID, size: TRANSCRIPT.length, mtimeMs: T0 - 2 * 60_000, folder: 'C:\\code\\app' }]),
      readText: vi.fn(async () => TRANSCRIPT),
    });
    const t = new CursorTracker(ENV);
    let r = await t.poll(T0);
    expect(r.sessions[0]).toMatchObject({ id: CID, displayTitle: 'fix the failing tests', status: 'awaiting_input', lastAssistantText: 'Fixed: the parser skipped empty lines.', cwd: 'C:\\code\\app', transcript: FILE });
    r = await t.poll(T0 + 3000);
    expect(h.native.readText).toHaveBeenCalledTimes(1);
    expect(t.transcriptOf(CID)).toBe(FILE);
  });

  it('an older transcript is a chat closed recently; with Cursor gone, a fresh one is too', async () => {
    setNative({
      cursorTranscripts: vi.fn(async () => [{ path: FILE, id: CID, size: 10, mtimeMs: T0 - 3 * 3_600_000, folder: null }]),
      readText: vi.fn(async () => TRANSCRIPT),
    });
    let r = await new CursorTracker(ENV).poll(T0);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed[0]).toMatchObject({ id: CID, displayTitle: 'fix the failing tests', closedAt: T0 - 3 * 3_600_000 });
    setNative({
      procSnapshot: vi.fn(async () => []),
      cursorTranscripts: vi.fn(async () => [{ path: FILE, id: CID, size: 10, mtimeMs: T0 - 60_000, folder: null }]),
      readText: vi.fn(async () => TRANSCRIPT),
    });
    r = await new CursorTracker(ENV).poll(T0);
    expect(r.sessions).toHaveLength(0);
    expect(r.closed).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ in the island

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot(options: Record<string, unknown> = {}) {
  const act = new CursorActivity();
  const settings = defaultSettings();
  const ctx: ActivityContext = {
    id: 'cursor',
    config: () => settings.activities.config.cursor,
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
    id: CID, sessionId: CID, pid: 650, cwd: 'C:\\code\\app', name: '', kind: 'interactive', entrypoint: 'cursor', alive: true,
    status: 'awaiting_input', label: 'Your turn', tone: 'turn', needsYou: false, title: 'Fix the parser', displayTitle: 'Fix the parser', project: 'app', host: 'Cursor',
    editorHost: 'Cursor', hostKind: 'editor', model: null, permissionMode: null, gitBranch: null, lastActivityMs: T0, lastAliveAt: T0,
    slot: null, tool: null, operation: null, turnStartMs: null, lastAssistantText: 'Done.', transcript: null, version: null,
    ...over,
  }) as SessionView;

function stubTracker(act: CursorActivity, sessions: SessionView[], words: string | null = null) {
  const probe = { table: new Map<number, unknown>([[650, {}], [600, {}]]), ancestors: (pid: number) => (pid === 650 ? [{ pid: 600, name: 'Cursor.exe' }] : []), load: vi.fn(), runningEditor: () => 'Cursor' };
  (act as unknown as { tracker: unknown }).tracker = {
    probe,
    noteHook: vi.fn(),
    lastWords: () => words,
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

describe('Cursor in the island', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setNative();
  });
  afterEach(() => vi.useRealTimers());

  it("a finished turn waits for a reply typed in the island, with Cursor's last answer", async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})], 'Tests pass now.');
    emit('hook', hook({ hook_event_name: 'stop', status: 'completed', request_id: 'r1' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r1', 'ack:45000');
    expect(block(act.sheet!(senv('urgent')), 'text', 'msg')?.text).toBe('Tests pass now.');
    await act.action!('reply:r1', 'now commit it');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('r1', JSON.stringify({ kind: 'reply', text: 'now commit it' }));
  });

  it('a stopped or failed turn lets its stop go at once', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'stop', status: 'aborted', request_id: 'r2' }));
    emit('hook', hook({ hook_event_name: 'stop', status: 'error', request_id: 'r3' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r2', 'pass');
    expect(h.native.hookReply).toHaveBeenCalledWith('r3', 'pass');
    expect(h.native.hookReply).not.toHaveBeenCalledWith('r2', expect.stringMatching(/^ack/));
  });

  it('while Cursor is in front, a finished turn goes by without holding it', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})]);
    h.native.foregroundPid = vi.fn(async () => 600);
    emit('hook', hook({ hook_event_name: 'stop', status: 'completed', request_id: 'r4' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('r4', 'pass');
  });

  it('commands go through untouched unless asked for', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'beforeShellExecution', command: 'npm test', cwd: 'C:\\code\\app', request_id: 'p0' }));
    await tick(0);
    expect(h.native.hookReply).toHaveBeenCalledWith('p0', 'pass');
    expect(act.sheet!(senv('urgent'))?.key).not.toBe('perm:p0');
  });

  it('asked for, a command gets the card: Allow lets it through, dismissing hands it back to Cursor', async () => {
    const act = await boot({ askBeforeCommands: true });
    stubTracker(act, [session({})]);
    emit('hook', hook({ hook_event_name: 'beforeShellExecution', command: 'npm test', cwd: 'C:\\code\\app', request_id: 'p1' }));
    expect(h.native.hookReply).toHaveBeenCalledWith('p1', 'ack');
    const card = act.sheet!(senv('urgent'));
    expect(block(card, 'head')?.title).toBe('Run this command?');
    expect(block(card, 'code')?.text).toBe('npm test');
    expect(block(card, 'input')?.placeholder).toBe('Or tell Cursor what to do instead…');
    await act.action!('allow', 'p1');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('p1', 'allow');

    emit('hook', hook({ hook_event_name: 'beforeMCPExecution', tool_name: 'query', tool_input: '{"sql":"select 1"}', mcp_server_name: 'db', request_id: 'p2' }));
    act.dismiss!('perm:p2');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('p2', 'decline');
  });

  it("Claude's and Codex's hooks are not Cursor's", async () => {
    const act = await boot({ askBeforeCommands: true });
    stubTracker(act, [session({})]);
    emit('hook', { hook_event_name: 'PermissionRequest', agent: 'codex', session_id: CID, request_id: 'x1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    emit('hook', { hook_event_name: 'Stop', session_id: CID, request_id: 'x2' });
    await tick(0);
    expect(h.native.hookReply).not.toHaveBeenCalled();
  });

  it('a phone reaches a chat only while it waits for a reply', async () => {
    const act = await boot({ replyWindowSeconds: 45 });
    stubTracker(act, [session({})]);
    await expect(act.messageChat(CID, 'hello')).rejects.toThrow(/isn't waiting/);
    await expect(act.messageChat(null, 'start', 'C:\\code\\app')).rejects.toThrow(/in Cursor on your PC/);
    emit('hook', hook({ hook_event_name: 'stop', status: 'completed', request_id: 'r5' }));
    await tick(0);
    await act.messageChat(CID, 'and the docs');
    expect(h.native.hookReply).toHaveBeenLastCalledWith('r5', JSON.stringify({ kind: 'reply', text: 'and the docs' }));
    expect(act.recentFolders()).toEqual([]);
  });

  it('a reply too late goes on the clipboard and Cursor comes up', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    h.native.winEnum = vi.fn(async () => [{ hwnd: 77, pid: 600, title: 'app - Cursor' }]);
    await (act as unknown as { continueSession(id: string, t: string): Promise<void> }).continueSession(CID, 'one more thing');
    expect(h.native.clipboardSetText).toHaveBeenCalledWith('one more thing');
  });

  it('says Cursor on the pill, with no limits to show', async () => {
    const act = await boot();
    stubTracker(act, [session({})]);
    expect(act.status().summary).toBe('Cursor · Your turn');
    expect(block(act.sheet!(senv('hover')), 'meter')).toBeUndefined();
  });
});
