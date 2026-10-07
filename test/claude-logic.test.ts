// Usage Clip's unit tests (status, format, procinfo, transcript, tokens, usage,
// desktop chats), carried over with the same assertions to show the copied
// logic behaves the same inside Island.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', async () => await import('./fake-native'));

import * as F from '../src/core/format';
import { chatStatus, chatUrl, conversationsFromCache, decodeBlob, DesktopChats, deserialize, snappyDecompress } from '../src/activities/claude/desktop';
import { classifyAncestry, ProcessProbe, ticksMatch } from '../src/activities/claude/procinfo';
import { classify, deriveStatus, formatModel, pendingBlockReason, refineWithNative, statusLabel, type RawStatus } from '../src/activities/claude/status';
import { parseLines, promptDisplay, TranscriptReader } from '../src/activities/claude/transcript';
import { parseStatusLine, parseUsage, UsageClient, WeeklyTokens, weekWindowStart } from '../src/activities/claude/usage';
import { fake, native as fakeNative } from './fake-native';
import { assistant, tempRoot, toolResult, transcriptFile, user, uuid, writeLines } from './helpers';

const base: RawStatus = { alive: true, hasTranscript: true, hasActivity: true, ageSeconds: 5, processAgeSeconds: 100 };

describe('status (status.test.js)', () => {
  it('classify: structural states', () => {
    expect(classify({ alive: false, hasTranscript: false })).toBe('completed');
    expect(classify({ alive: true, hasTranscript: false })).toBe('new');
    expect(classify({ ...base, lastEntryKind: 'user_interrupt', pendingTool: true })).toBe('interrupted');
    expect(classify({ ...base, lastEntryKind: 'api_error' })).toBe('errored');
    expect(classify({ ...base, turnPredatesProcess: true, pendingTool: true })).toBe('awaiting_input');
    expect(classify({ ...base, pendingTool: true, pendingBlocking: true })).toBe('awaiting_permission');
    expect(classify({ ...base, pendingTool: true, pendingBlocking: false })).toBe('working');
    expect(classify({ ...base, lastEntryKind: 'assistant', lastStopReason: 'end_turn' })).toBe('awaiting_input');
    expect(classify({ ...base, lastEntryKind: 'local_command' })).toBe('awaiting_input');
    expect(classify({ ...base, lastEntryKind: 'user_text' })).toBe('working');
    expect(classify({ ...base, lastEntryKind: 'tool_result' })).toBe('working');
    expect(classify({ ...base, lastEntryKind: 'assistant', lastStopReason: 'tool_use' })).toBe('working');
  });

  it('refineWithNative: registry wins except for definitive states', () => {
    expect(refineWithNative('awaiting_input', 'busy', null)).toBe('working');
    expect(refineWithNative('working', 'waiting', 'permission')).toBe('awaiting_permission');
    expect(refineWithNative('working', 'waiting', null)).toBe('working');
    expect(refineWithNative('working', 'idle', null)).toBe('awaiting_input');
    expect(refineWithNative('awaiting_permission', 'busy', null)).toBe('awaiting_permission');
    expect(refineWithNative('interrupted', 'busy', null)).toBe('interrupted');
    expect(refineWithNative('errored', 'idle', null)).toBe('errored');
    expect(refineWithNative('new', 'busy', null)).toBe('new');
    expect(refineWithNative('working', null, null)).toBe('working');
  });

  it('pendingBlockReason: dialogs, modes, children, stalls', () => {
    const p = (extra: Partial<RawStatus>) => pendingBlockReason({ alive: true, hasTranscript: true, pendingTool: true, ageSeconds: 1, childCount: 0, ...extra });
    expect(p({ lastToolName: 'AskUserQuestion', permissionMode: 'bypassPermissions', childCount: 2 })).toBe('dialog');
    expect(p({ lastToolName: 'Bash', permissionMode: 'default' })).toBe('prompt');
    expect(p({ lastToolName: 'Bash', permissionMode: 'default', childCount: 1 })).toBe(null);
    expect(p({ lastToolName: 'Edit', permissionMode: 'acceptEdits' })).toBe(null);
    expect(p({ lastToolName: 'Bash', permissionMode: 'acceptEdits' })).toBe('prompt');
    expect(p({ lastToolName: 'Task', permissionMode: 'default' })).toBe(null);
    expect(p({ lastToolName: 'Bash', permissionMode: 'auto', ageSeconds: 60 })).toBe(null);
    expect(p({ lastToolName: 'Bash', permissionMode: 'auto', ageSeconds: 95 })).toBe('stalled');
    expect(p({ lastToolName: 'WebFetch', permissionMode: 'bypassPermissions', ageSeconds: 299 })).toBe(null);
    expect(p({ lastToolName: 'WebFetch', permissionMode: 'bypassPermissions', ageSeconds: 301 })).toBe('stalled');
    expect(pendingBlockReason({ alive: true, hasTranscript: true, pendingTool: false })).toBe(null);
  });

  it('deriveStatus: reopened session and permission prompt end to end', () => {
    expect(deriveStatus({ ...base, ageSeconds: 7200, processAgeSeconds: 60, pendingTool: true, lastToolName: 'Bash', permissionMode: 'default' })).toBe('awaiting_input');
    expect(deriveStatus({ ...base, pendingTool: true, lastToolName: 'Bash', permissionMode: 'default', nativeStatus: 'busy' })).toBe('awaiting_permission');
  });

  it('labels and model names', () => {
    expect(statusLabel('awaiting_permission')).toBe('Needs you');
    expect(statusLabel('awaiting_input')).toBe('Your turn');
    expect(statusLabel('errored', { alive: true, hasTranscript: true, apiErrorKind: 'rate_limit' })).toBe('Hit limit');
    expect(statusLabel('errored', { alive: true, hasTranscript: true, apiErrorStatus: 429 })).toBe('Hit limit');
    expect(statusLabel('errored', { alive: true, hasTranscript: true, apiErrorKind: 'server_error' })).toBe('Error');
    expect(statusLabel('completed')).toBe('Closed');
    expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(formatModel('claude-opus-4-8[1m]')).toBe('Opus 4.8 1M');
    expect(formatModel(null)).toBe(null);
  });
});

describe('format (format.test.js)', () => {
  const NOW = Date.parse('2026-09-28T12:00:00Z');
  it('token formatting', () => {
    expect(F.tokens(950)).toBe('950');
    expect(F.tokens(9500)).toBe('9.5k');
    expect(F.tokens(182000)).toBe('182k');
    expect(F.tokens(999600)).toBe('1.0M');
    expect(F.tokens(4100000)).toBe('4.1M');
    expect(F.tokens(182000000)).toBe('182M');
    expect(F.tokens(1.2e9)).toBe('1.2B');
  });
  it('reset countdowns and ages', () => {
    expect(F.resetsIn(NOW + (2 * 60 + 14) * 60000, NOW)).toBe('resets in 2h 14m');
    expect(F.resetsIn(NOW + 14 * 60000 + 5000, NOW)).toBe('resets in 14m');
    expect(F.resetsIn(NOW + 30000, NOW)).toBe('resets in under a minute');
    expect(F.resetsIn(null, NOW)).toBe('not started');
    expect(F.resetsOn(NOW + 3 * 86400000, NOW)).toMatch(/^resets [A-Z][a-z]{2} \d{1,2}:\d{2}\s[AP]M$/);
    expect(F.age(5000)).toBe('now');
    expect(F.age(125000)).toBe('2m');
    expect(F.age(3 * 3600000)).toBe('3h');
  });
  it('pace tick is the elapsed fraction of the window', () => {
    const w = F.SESSION_WINDOW_MS;
    expect(F.pace(NOW + w / 2, w, NOW)).toBe(0.5);
    expect(F.pace(NOW + w * 2, w, NOW)).toBe(0);
    expect(F.pace(NOW - 1000, w, NOW)).toBe(1);
    expect(F.pace(null, w, NOW)).toBe(null);
  });
  it('session count text', () => {
    const s = (alive: boolean, needsYou = false) => ({ alive, needsYou });
    expect(F.sessionCount([s(true, true), s(true), s(true), s(false)])).toEqual({ text: '3 running', needs: 1 });
    expect(F.sessionCount([s(false)])).toEqual({ text: '1 closed', needs: 0 });
  });
});

describe('procinfo (procinfo.test.js)', () => {
  const START = Date.parse('2026-09-28T19:16:43.880Z');
  const filetime = (ms: number) => (BigInt(ms) + 11644473600000n) * 10000n;
  const dotnetLocal = (ms: number) => (BigInt(ms - new Date(ms).getTimezoneOffset() * 60000) + 62135596800000n) * 10000n;
  const probeWith = (procs: Record<number, [number, string, number]>) => {
    const p = new ProcessProbe();
    p.load(Object.entries(procs).map(([pid, [ppid, name, start]]) => [Number(pid), ppid, name, start]));
    return p;
  };

  it('procStart matches FILETIME and .NET local ticks within 10s', () => {
    expect(ticksMatch(filetime(START), START)).toBe(true);
    expect(ticksMatch(filetime(START + 9000), START)).toBe(true);
    expect(ticksMatch(filetime(START + 11000), START)).toBe(false);
    expect(ticksMatch(dotnetLocal(START + 2000), START)).toBe(true);
    expect(ticksMatch(134350966038804384n, 1790623003880)).toBe(true);
    expect(ticksMatch(null, START)).toBe(false);
  });

  it('host classification from ancestors', () => {
    expect(classifyAncestry(['cursor.exe', 'cursor.exe', 'explorer.exe'])).toEqual({ host: 'Cursor', hostKind: 'editor', viaCli: false });
    expect(classifyAncestry(['pwsh.exe', 'windowsterminal.exe'])).toEqual({ host: 'Terminal', hostKind: 'terminal', viaCli: true });
    expect(classifyAncestry(['bash.exe', 'code.exe'])).toEqual({ host: 'VS Code', hostKind: 'editor', viaCli: true });
    expect(classifyAncestry(['cmd.exe', 'explorer.exe'])).toEqual({ host: 'Command Prompt', hostKind: 'shell', viaCli: true });
    expect(classifyAncestry([])).toEqual({ host: null, hostKind: null, viaCli: false });
  });

  it('probe: alive, host, helper and conhost children ignored, tool child counted', () => {
    const probe = probeWith({
      1: [0, 'explorer.exe', START - 100000],
      2: [1, 'windowsterminal.exe', START - 50000],
      3: [2, 'pwsh.exe', START - 20000],
      10: [3, 'claude.exe', START],
      11: [10, 'conhost.exe', START + 50],
      12: [10, 'node.exe', START + 3000],
      13: [10, 'bash.exe', START + 60000],
      14: [13, 'git.exe', START + 60100],
    });
    const info = probe.probe(10, filetime(START));
    expect(info.alive).toBe(true);
    expect(info.host).toBe('Terminal');
    expect(info.viaCli).toBe(true);
    expect(info.childCount).toBe(2);
    expect(info.ancestors.map((a) => a.name)).toEqual(['pwsh.exe', 'windowsterminal.exe', 'explorer.exe']);
  });

  it('probe: recycled PID and missing process are not alive', () => {
    const probe = probeWith({ 10: [0, 'claude.exe', START + 3600000] });
    expect(probe.probe(10, filetime(START)).alive).toBe(false);
    expect(probe.probe(99, null).alive).toBe(false);
  });

  it('probe: ancestor walk stops at a parent younger than its child', () => {
    const probe = probeWith({ 5: [0, 'code.exe', START + 999999], 10: [5, 'claude.exe', START] });
    const info = probe.probe(10, null);
    expect(info.alive).toBe(true);
    expect(info.ancestors.length).toBe(0);
    expect(info.host).toBe(null);
  });
});

describe('transcript (transcript.test.js)', () => {
  const T = Date.parse('2026-09-28T12:00:00Z');
  const lines = (entries: unknown[]) => entries.map((e) => JSON.stringify(e));
  const statOf = (f: string) => {
    const st = fs.statSync(f);
    return { size: st.size, mtimeMs: st.mtimeMs, dir: false };
  };

  it('end_turn assistant is the newest turn', () => {
    const st = parseLines(lines([user('hi', T), assistant(T + 1000)]));
    expect(st.lastEntryKind).toBe('assistant');
    expect(st.lastStopReason).toBe('end_turn');
    expect(st.pendingTool).toBe(false);
    expect(st.model).toBe('claude-opus-5-5');
    expect(st.lastTimestampMs).toBe(T + 1000);
  });

  it('unresolved tool_use is pending, a tool_result resolves it', () => {
    const pending = parseLines(lines([user('go', T), assistant(T + 1, { stop: 'tool_use', tools: [['t1', 'Bash']] })]));
    expect(pending.pendingTool).toBe(true);
    expect(pending.lastToolName).toBe('Bash');
    const resolved = parseLines(lines([user('go', T), assistant(T + 1, { stop: 'tool_use', tools: [['t1', 'Bash']] }), toolResult('t1', T + 2)]));
    expect(resolved.pendingTool).toBe(false);
    expect(resolved.lastEntryKind).toBe('tool_result');
  });

  it('interrupt marker, local command output and system local_command', () => {
    expect(parseLines(lines([user('[Request interrupted by user for tool use]', T)])).lastEntryKind).toBe('user_interrupt');
    expect(parseLines(lines([user('<local-command-stdout>ok</local-command-stdout>', T)])).lastEntryKind).toBe('local_command');
    expect(parseLines(lines([{ type: 'system', subtype: 'local_command', timestamp: new Date(T).toISOString() }])).lastEntryKind).toBe('local_command');
  });

  it('API error turn carries its error token; synthetic model is ignored', () => {
    const st = parseLines(lines([assistant(T, { model: 'claude-sonnet-4-5' }), assistant(T + 1, { model: '<synthetic>', extra: { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 } })]));
    expect(st.lastEntryKind).toBe('api_error');
    expect(st.apiErrorKind).toBe('rate_limit');
    expect(st.apiErrorStatus).toBe(429);
    expect(st.model).toBe('claude-sonnet-4-5');
  });

  it('sidechain and isMeta entries do not drive state', () => {
    const st = parseLines(lines([assistant(T), { ...user('subagent prompt', T + 5), isSidechain: true }, { ...user('caveat', T + 6), isMeta: true }]));
    expect(st.lastEntryKind).toBe('assistant');
  });

  it('prompt display strips wrappers, clips, and flags /clear', () => {
    expect(promptDisplay(user('<system-reminder>x</system-reminder>  Fix   the\nlogin redirect', T))[0]).toBe('Fix the login redirect');
    const [long] = promptDisplay(user('a'.repeat(200), T));
    expect(long!.length).toBe(80);
    expect(long!.endsWith('…')).toBe(true);
    expect(promptDisplay(user('<command-name>/clear</command-name><command-args></command-args>', T))).toEqual(['/clear', true]);
    expect(promptDisplay(user('<command-name>/review</command-name><command-args>#12\n now</command-args>', T))[0]).toBe('/review #12 now');
  });

  it('reader: title precedence, permission mode, incremental append, partial line', async () => {
    const root = tempRoot();
    const file = transcriptFile(root, 'C:\\work\\app', uuid());
    writeLines(file, [user('<command-name>/clear</command-name>', T), { ...user('Add schedule export', T + 1), permissionMode: 'default' }, assistant(T + 2)]);
    const reader = new TranscriptReader();
    let st = await reader.read(file, statOf(file));
    expect(st.title).toBe('Add schedule export');
    expect(st.permissionMode).toBe('default');

    writeLines(file, [{ type: 'ai-title', aiTitle: 'Schedule export' }], true);
    expect((await reader.read(file, statOf(file))).title).toBe('Schedule export');

    writeLines(file, [{ type: 'custom-title', customTitle: 'My rename' }, { type: 'permission-mode', permissionMode: 'acceptEdits' }], true);
    fs.appendFileSync(file, '{"type":"assistant","timestamp":"2026-09-28T12:00:09Z","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"x","name":"Edit"}]');
    st = await reader.read(file, statOf(file));
    expect(st.title).toBe('My rename');
    expect(st.permissionMode).toBe('acceptEdits');
    expect(st.lastEntryKind).toBe('assistant');
    expect(st.pendingTool).toBe(false);
    fs.appendFileSync(file, '}}\n');
    st = await reader.read(file, statOf(file));
    expect(st.pendingTool).toBe(true);
    expect(st.lastToolName).toBe('Edit');
  });

  it('reader: missing file has no transcript', async () => {
    expect((await new TranscriptReader().read(null, null)).hasTranscript).toBe(false);
  });
});

describe('tokens + usage (tokens-usage.test.js)', () => {
  const NOW = Date.parse('2026-09-28T12:00:00Z');
  const DAY = 86400000;
  const usage = (i: number, cc: number, o: number, cr: number) => ({ input_tokens: i, cache_creation_input_tokens: cc, output_tokens: o, cache_read_input_tokens: cr });

  it('weekly tokens: dedupe by message.id + requestId (max), window filter, incremental', async () => {
    const root = tempRoot();
    const file = transcriptFile(root, 'C:\\p', uuid());
    writeLines(file, [
      assistant(NOW - 1000, { id: 'm1', requestId: 'r1', usage: usage(10, 100, 5, 1000) }),
      assistant(NOW - 999, { id: 'm1', requestId: 'r1', usage: usage(10, 100, 40, 1000) }),
      assistant(NOW - 998, { id: 'm1', requestId: 'r1', usage: usage(10, 100, 20, 1000) }),
      assistant(NOW - 2 * DAY, { id: 'm2', requestId: 'r2', usage: usage(1, 2, 3, 4) }),
      assistant(NOW - 7.5 * DAY, { id: 'm0', requestId: 'r0', usage: usage(1000, 1000, 1000, 1000) }),
    ]);
    const sub = path.join(path.dirname(file), 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    writeLines(path.join(sub, 'agent-a1.jsonl'), [assistant(NOW - 500, { id: 'm3', requestId: 'r3', usage: usage(7, 0, 3, 50), extra: { isSidechain: true } })]);

    const wt = new WeeklyTokens(path.join(root, 'projects'), () => NOW);
    await wt.scan();
    let t = wt.totals(NOW - 7 * DAY);
    expect(t).toEqual({ fresh: 10 + 100 + 40 + (1 + 2 + 3) + (7 + 0 + 3), cached: 1000 + 4 + 50, output: 40 + 3 + 3 });
    writeLines(file, [assistant(NOW, { id: 'm4', requestId: 'r4', usage: usage(1, 1, 1, 1) })], true);
    await wt.scan();
    t = wt.totals(NOW - 7 * DAY);
    expect(t.fresh).toBe(166 + 3);
    expect(wt.totals(NOW - DAY).fresh).toBe(150 + 10 + 3);
  });

  it('week window start: reset time minus 7 days, else rolling', () => {
    expect(weekWindowStart(NOW + DAY, NOW)).toBe(NOW - 6 * DAY);
    expect(weekWindowStart(null, NOW)).toBe(NOW - 7 * DAY);
  });

  it('parseUsage: session, weekly and model-scoped limits', () => {
    const data = parseUsage({
      five_hour: { utilization: 58, resets_at: '2026-09-28T14:14:00Z' },
      seven_day: { utilization: 22.4, resets_at: '2026-10-01T21:00:00Z' },
      seven_day_opus: { utilization: 31, resets_at: '2026-10-01T21:00:00Z' },
      seven_day_oauth_apps: null,
      limits: [
        { kind: 'session', group: 'session', percent: 58, scope: null },
        { kind: 'weekly_model', group: 'weekly', percent: 12, resets_at: '2026-10-01T21:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    });
    expect(data.fiveHour!.pct).toBe(58);
    expect(data.fiveHour!.resetsAt).toBe(Date.parse('2026-09-28T14:14:00Z'));
    expect(data.sevenDay!.pct).toBe(22.4);
    expect(data.models.map((m) => [m.name, m.pct])).toEqual([['Fable', 12], ['Opus', 31]]);
  });

  const creds = (root: string) => fs.writeFileSync(path.join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'abc' } }));

  it('usage client: version, success, 401, 429 backoff, no token', async () => {
    const root = tempRoot();
    fake.configDir = root;
    let clock = NOW;
    fake.usageReply = { status: 200, retryAfter: null, body: { five_hour: { utilization: 40, resets_at: null }, seven_day: { utilization: 10, resets_at: null } } };
    const client = new UsageClient({ configDir: root, usageClipCache: null, getVersion: () => '2.1.283', getActivity: () => String(clock), now: () => clock });

    let s = await client.poll();
    expect(s.error).toBe('no_token');
    creds(root);
    s = await client.poll();
    expect(fake.lastVersion).toBe('2.1.283');
    expect(s.data!.fiveHour!.pct).toBe(40);
    expect(client.due()).toBe(false);
    clock += 20000;
    expect(client.due()).toBe(true);

    fake.usageReply = { status: 401, retryAfter: null, body: {} };
    s = await client.poll();
    expect(s.error).toBe('expired');
    expect(s.message).toBe('Use Claude Code once to refresh it');
    expect(s.data!.fiveHour!.pct).toBe(40);

    fake.usageReply = { status: 429, retryAfter: 600, body: {} };
    s = await client.poll();
    expect(s.error).toBe('rate_limited');
    expect(client.nextAt).toBe(clock + 600000);

    fake.usageReply = { status: 429, retryAfter: null, body: {} };
    await client.poll();
    expect(client.nextAt - clock).toBeGreaterThanOrEqual(60000);
    fake.usageReply = { status: 200, retryAfter: null, body: { five_hour: { utilization: 41 }, seven_day: { utilization: 10 } } };
    await client.poll();
    expect(client.nextAt).toBe(clock + 80000);
  });

  it('usage polling: 20 s while active, 60 s when idle, widens after 429, relaxes later', async () => {
    const root = tempRoot();
    fake.configDir = root;
    creds(root);
    let clock = NOW;
    let activity = 1;
    fake.usageReply = { status: 200, retryAfter: null, body: { five_hour: { utilization: 5 }, seven_day: { utilization: 1 } } };
    const client = new UsageClient({ configDir: root, usageClipCache: null, getVersion: () => null, getActivity: () => String(activity), now: () => clock });
    expect(client.due()).toBe(true);
    await client.poll();
    clock += 20000;
    expect(client.due()).toBe(false);
    activity = 2;
    expect(client.due()).toBe(true);
    await client.poll();
    clock += 59000;
    expect(client.due()).toBe(false);
    clock += 1000;
    expect(client.due()).toBe(true);

    fake.usageReply = { status: 429, retryAfter: 300, body: {} };
    await client.poll();
    expect(client.interval).toBe(40000);
    expect(client.nextAt).toBe(clock + 300000);
    expect(client.rateLimited()).toBe(true);

    fake.usageReply = { status: 200, retryAfter: null, body: { five_hour: { utilization: 6 }, seven_day: { utilization: 1 } } };
    clock += 300000;
    activity = 3;
    await client.poll();
    expect(client.nextAt).toBe(clock + 40000);
    clock += 60 * 60000;
    activity = 4;
    await client.poll();
    expect(client.interval).toBe(40000);
    clock += 1.5 * 3600000;
    activity = 5;
    await client.poll();
    expect(client.interval).toBe(20000);
  });

  it('a fresh Usage Clip reading is reused instead of calling the API', async () => {
    const root = tempRoot();
    fake.configDir = root;
    creds(root);
    const shared = path.join(root, 'usage-clip-cache.json');
    fs.writeFileSync(shared, JSON.stringify({ data: { fiveHour: { pct: 33, resetsAt: null }, sevenDay: null, models: [] }, fetchedAt: NOW - 5000 }));
    const before = fake.usageCalls;
    const client = new UsageClient({ configDir: root, usageClipCache: shared, getVersion: () => null, getActivity: () => '1', now: () => NOW });
    const s = await client.poll();
    expect(s.source).toBe('usage-clip');
    expect(s.data!.fiveHour!.pct).toBe(33);
    expect(fake.usageCalls).toBe(before);
  });

  it('statusLine fallback file', () => {
    const s = parseStatusLine({ rate_limits: { five_hour: { used_percentage: 71, resets_at: 1790629800 }, seven_day: { used_percentage: 30, resets_at: '2026-10-01T21:00:00Z' } } });
    expect(s!.fiveHour!.pct).toBe(71);
    expect(s!.fiveHour!.resetsAt).toBe(1790629800000);
    expect(s!.sevenDay!.pct).toBe(30);
  });
});

describe('desktop chats (desktop.test.js)', () => {
  function snappyLiterals(data: Buffer): Buffer {
    const parts: Buffer[] = [];
    let n = data.length;
    const len: number[] = [];
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      len.push(b);
    } while (n);
    parts.push(Buffer.from(len));
    for (let i = 0; i < data.length; i += 60000) {
      const chunk = data.subarray(i, i + 60000);
      const l = chunk.length - 1;
      parts.push(l < 60 ? Buffer.from([l << 2]) : Buffer.from([61 << 2, l & 0xff, l >> 8]), chunk);
    }
    return Buffer.concat(parts);
  }
  const blob = (value: unknown) => Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), snappyLiterals(v8.serialize(value))]);
  const conv = (uuid: string, name: string, updated: string, extra: Record<string, unknown> = {}) => ({
    uuid, name, updated_at: updated, created_at: updated, is_archived: false, is_temporary: false,
    project: extra.project === undefined ? { name: 'Summit', uuid: '99999999-9999-4999-8999-999999999999' } : extra.project,
    live_status: null, needs_input: null, latest_assistant_output_at: null, last_read_at: null, ...extra,
  });
  const cacheWith = (pages: unknown[], extraQueries: unknown[] = []) => ({
    buster: '', timestamp: Date.now(),
    clientState: { mutations: [], queries: [{ queryKey: ['current_account'], state: { data: { uuid: 'x' } } }, { queryKey: ['chat_conversation_list', { orgUuid: 'o' }, 'infinite', {}], state: { data: { pages, pageParams: [null] } } }, ...extraQueries] },
  });

  it('V8 deserializer reads what V8 writes', () => {
    const value = { s: 'plain', u: 'naïve 🚀 日本', n: 42, neg: -7, big: 2 ** 40, d: 3.25, t: true, f: false, z: null, arr: [1, 'two', { three: 3 }, [4]], nested: { a: { b: { c: 'deep' } } }, when: new Date('2026-09-29T20:05:36Z'), map: new Map([['k', 1]]), set: new Set(['x']) };
    const out = deserialize(new Uint8Array(v8.serialize(value))) as any;
    expect(out.s).toBe('plain');
    expect(out.u).toBe('naïve 🚀 日本');
    expect(out.n).toBe(42);
    expect(out.neg).toBe(-7);
    expect(out.big).toBe(2 ** 40);
    expect(out.d).toBe(3.25);
    expect(out.t).toBe(true);
    expect(out.f).toBe(false);
    expect(out.z).toBe(null);
    expect(out.arr).toEqual([1, 'two', { three: 3 }, [4]]);
    expect(out.nested.a.b.c).toBe('deep');
    expect(out.when).toBe(Date.parse('2026-09-29T20:05:36Z'));
    expect(out.map.get('k')).toBe(1);
    expect(out.set.has('x')).toBe(true);
  });

  it('shared references come back as the same object', () => {
    const shared = { id: 1 };
    const out = deserialize(new Uint8Array(v8.serialize({ a: shared, b: shared }))) as any;
    expect(out.a).toBe(out.b);
  });

  it('snappy + IndexedDB wrapper; corrupt input throws', () => {
    const value = { hello: 'x'.repeat(200000) };
    expect(decodeBlob(new Uint8Array(blob(value)))).toEqual(value);
    expect(() => snappyDecompress(new Uint8Array([10, (0x02 << 2) | 1, 0xff]))).toThrow();
    expect(() => deserialize(new Uint8Array([0x41, 0xff, 0xff, 0xff, 0x7f]))).toThrow(/array length/);
  });

  it('conversation list: pages and plain lists, deduped by uuid (newest wins)', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const cache = cacheWith([[conv(a, 'Old name', '2026-09-29T10:00:00Z')], { data: [conv(b, 'B', '2026-09-29T11:00:00Z')] }], [{ queryKey: ['chat_conversation_list', { starred: true }], state: { data: { data: [conv(a, 'New name', '2026-09-29T12:00:00Z')], has_more: false } } }]);
    const list = conversationsFromCache(cache)!;
    expect(list.length).toBe(2);
    expect(list.find((c) => c.uuid === a)!.name).toBe('New name');
    expect(conversationsFromCache({ nope: true })).toBe(null);
  });

  it('status fields map to statuses; empty fields mean no signal', () => {
    expect(chatStatus(conv('x', 'n', 't', { needs_input: true })).label).toBe('Needs you');
    expect(chatStatus(conv('x', 'n', 't', { live_status: 'generating' })).label).toBe('Working');
    expect(chatStatus(conv('x', 'n', 't', { live_status: 'idle' })).status).toBe('idle');
    expect(chatStatus(conv('x', 'n', 't', { latest_assistant_output_at: '2026-09-29T12:00:00Z', last_read_at: '2026-09-29T11:00:00Z' })).label).toBe('Your turn');
    expect(chatStatus(conv('x', 'n', 't', { latest_assistant_output_at: '2026-09-29T12:00:00Z', last_read_at: '2026-09-29T12:05:00Z' })).status).toBe('idle');
    expect(chatStatus(conv('x', 'n', 't')).label).toBe(null);
  });

  it('reader: newest valid blob wins, skips junk, filters, re-reads only on change', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-desk-'));
    fs.mkdirSync(path.join(dir, '4', '16'), { recursive: true });
    const now = Date.parse('2026-09-29T21:00:00Z');
    const recent = '33333333-3333-4333-8333-333333333333';
    const cache = cacheWith([[
      conv(recent, 'Recent chat', '2026-09-29T20:00:00Z'),
      conv('44444444-4444-4444-8444-444444444444', 'Archived', '2026-09-29T20:30:00Z', { is_archived: true }),
      conv('55555555-5555-4555-8555-555555555555', 'Temp', '2026-09-29T20:40:00Z', { is_temporary: true }),
      conv('66666666-6666-4666-8666-666666666666', 'Last month', '2026-08-01T00:00:00Z'),
      conv('77777777-7777-4777-8777-777777777777', 'No project', '2026-09-29T19:00:00Z', { project: null }),
    ]]);
    const good = path.join(dir, '4', '16', '16a7');
    fs.writeFileSync(good, blob(cache));
    fs.utimesSync(good, new Date(now - 60000), new Date(now - 60000));
    fs.writeFileSync(path.join(dir, '4', '16', '16a8'), Buffer.from('not a blob at all, just bytes'));

    const reader = new DesktopChats([dir], 24 * 3600000, 6, () => now);
    expect(await reader.poll()).toBe(true);
    expect(reader.chats.map((c) => [c.displayTitle, c.project])).toEqual([['Recent chat', 'Summit'], ['No project', null]]);
    expect(reader.chats[0].id).toBe(`desktop:${recent}`);
    expect(await reader.poll()).toBe(false);

    fs.writeFileSync(good, blob(cacheWith([[conv(recent, 'Renamed', '2026-09-29T20:59:00Z', { live_status: 'streaming' })]])));
    fs.utimesSync(good, new Date(now), new Date(now));
    expect(await reader.poll()).toBe(true);
    expect(reader.chats.map((c) => [c.displayTitle, c.label])).toEqual([['Renamed', 'Working']]);
  });

  it('reader: missing folders just mean no chats', async () => {
    const reader = new DesktopChats([path.join(os.tmpdir(), 'island-does-not-exist-xyz')]);
    await reader.poll();
    expect(reader.chats).toEqual([]);
  });

  it('chat links are validated UUIDs', () => {
    expect(chatUrl('3E4B7A8C-1D2F-4A5B-9C6D-7E8F9A0B1C2D')).toBe('claude://claude.ai/chat/3e4b7a8c-1d2f-4a5b-9c6d-7e8f9a0b1c2d');
    expect(chatUrl('../../etc')).toBe(null);
    expect(chatUrl('3e4b7a8c-1d2f-4a5b-9c6d-7e8f9a0b1c2d?x=1')).toBe(null);
  });
});

void fakeNative;
