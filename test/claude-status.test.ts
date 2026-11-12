import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', async () => await import('./fake-native'));

import type { UiChat, UiScan } from '../src/core/native';
import { ChatWatcher, chatKey, renameLike } from '../src/activities/claude-status/chats';
import { applyShells, applyWorkflow, hostOf, isDismissed, isStale, shellDismissed, labelItems, normTitle, orderWithShells, runProgress, sortItems, sourceTag, stateWord, type Item } from '../src/activities/claude-status/engine';
import { bashCommand, estimate, fmtLeft, shellKey, shellSamples } from '../src/activities/claude-status/estimate';
import { age, toneOf, type StatusRow } from '../src/activities/claude-status';
import { emptyWork, fold } from '../src/activities/claude-status/work';

const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  id: 'a',
  label: 'claude widget',
  where: 'Terminal',
  tag: 'TERMINAL',
  state: 'running',
  word: 'running',
  since: 0,
  grey: false,
  unread: false,
  hidden: false,
  progress: null,
  ...over,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: 'abcd1234',
  source: 'code',
  title: 'Fix the build',
  project: 'island',
  host: 'Terminal',
  state: 'running',
  since: 1000,
  runStarted: 1000,
  prog: null,
  unread: false,
  visible: true,
  label: 'Fix the build',
  ...over,
});

const chat = (over: Partial<UiChat> = {}): UiChat => ({
  source: 'app', hwnd: 7, title: 'Plan the trip', ord: 0, state: 'running', open: true, unread: false, chat: '', step: null, steps: null, ...over,
});
const scan = (chats: UiChat[], sidebarOpen = true): UiScan => ({ chats, sidebarOpen, app: true });

describe('Claude Status: drawing', () => {
  it("uses the widget's colours, and grey wins", () => {
    expect(toneOf(row())).toBe('info');
    expect(toneOf(row({ state: 'input' }))).toBe('warn');
    expect(toneOf(row({ state: 'done' }))).toBe('good');
    expect(toneOf(row({ state: 'failed' }))).toBe('bad');
    expect(toneOf(row({ state: 'shell' }))).toBe('purple');
    expect(toneOf(row({ state: 'done', grey: true }))).toBe('dim');
  });

  it('formats ages like the widget', () => {
    expect(age(42)).toBe(''); // no ticking seconds
    expect(age(240)).toBe('4m');
    expect(age(3900)).toBe('1h 5m');
  });
});

describe('Claude Status: estimates (widget.pyw)', () => {
  it('estimates from the runs that went longer', () => {
    expect(estimate([100, 200, 300], 150)).toEqual([0.5, 150]); // the middle of the longer runs, [200, 300] → 300
    const [frac, left] = estimate([], 100);
    expect(left).toBe(60);
    expect(frac).toBeCloseTo(100 / 160);
    expect(fmtLeft(30)).toBe('almost done');
    expect(fmtLeft(150)).toBe('~3 min left');
  });

  it('keys commands without cd, pipes and redirections', () => {
    expect(shellKey('cd "C:/x y" && npm run build 2>&1 | tail -5')).toBe('npm run build');
    expect(shellKey('cargo check > /dev/null')).toBe('cargo check');
    expect(shellKey('a || b')).toBe('a || b');
    expect(bashCommand(`bash -c 'source snap && eval '\\''npm test'\\'' < /dev/null'`)).toBe('');
    expect(bashCommand(`eval 'npm run '\\''x'\\''' < /dev/null`)).toBe("npm run 'x'");
    expect(shellSamples({ 'npm run build': [40] }, 'npm run build -- --watch')).toEqual([40]);
    expect(shellSamples({ 'npm run build': [40] }, 'cargo test')).toEqual([]);
  });
});

describe('Claude Status: transcript work (hook.py)', () => {
  it('counts the task list and starts fresh after a finished one', () => {
    const w = emptyWork();
    fold(w, { k: 'prompt', at: 1000_000 });
    fold(w, { k: 'todo', at: 1010_000, total: 3, done: 0 });
    fold(w, { k: 'todo', at: 1040_000, total: 3, done: 1 });
    expect(w.runStarted).toBe(1000);
    expect(w.prog).toMatchObject({ total: 3, done: 1, lastDoneAt: 1040 });
    fold(w, { k: 'prompt', at: 1100_000 });
    expect(w.prog).toMatchObject({ baseDone: 1, lastDoneAt: 1100 });
    fold(w, { k: 'todo', at: 1200_000, total: 3, done: 3 });
    fold(w, { k: 'prompt', at: 1300_000 });
    expect(w.prog).toBeNull();
  });

  it('follows TaskCreate and TaskUpdate', () => {
    const w = emptyWork();
    fold(w, { k: 'taskCreate', at: 1 });
    fold(w, { k: 'taskCreate', at: 2 });
    fold(w, { k: 'taskCreate', at: 3 });
    fold(w, { k: 'taskUpdate', at: 4000, id: '1', status: 'completed' });
    fold(w, { k: 'taskUpdate', at: 5000, id: '1', status: 'completed' });
    fold(w, { k: 'taskUpdate', at: 6000, id: '3', status: 'deleted' });
    expect(w.prog).toMatchObject({ total: 2, done: 1, lastDoneAt: 4 });
  });

  it("remembers when the last turn ended", () => {
    const w = emptyWork();
    fold(w, { k: 'prompt', at: 1000_000 });
    fold(w, { k: 'stop', at: 1090_000 });
    expect([w.runStarted, w.stoppedAt]).toEqual([1000, 1090]);
  });

  it('marks shell calls ended or backgrounded', () => {
    const w = emptyWork();
    fold(w, { k: 'shell', at: 1000, id: 't1', cmd: 'npm test', desc: 'Run tests', bg: false });
    fold(w, { k: 'shell', at: 2000, id: 't2', cmd: 'npm run dev', desc: '', bg: true });
    fold(w, { k: 'result', at: 3000, id: 't1', task: null });
    fold(w, { k: 'result', at: 4000, id: 't2', task: 'b123' });
    expect(w.shells.map((c) => [c.id, c.end, c.task])).toEqual([
      ['t1', 3, undefined],
      ['t2', undefined, 'b123'],
    ]);
  });
});

describe('Claude Status: app and Chrome chats (ui_watcher.ps1)', () => {
  it('lists a chat only once it runs', () => {
    const w = new ChatWatcher();
    expect(w.update(scan([chat({ state: 'done' })]), 10)).toEqual([]);
    const [r] = w.update(scan([chat()]), 11);
    expect(r).toMatchObject({ state: 'running', since: 11, title: 'Plan the trip' });
    // Waiting on you only counts for a chat seen running.
    expect(w.update(scan([chat({ title: 'Other', state: 'input' })]), 12).map((x) => x.title)).not.toContain('Other');
  });

  it('keeps its row across renames', () => {
    const w = new ChatWatcher();
    w.update(scan([chat({ title: 'Plan the…', chat: '' })]), 1);
    const [r] = w.update(scan([chat({ title: 'Plan the trip to Gaspé' })]), 2);
    expect(r.since).toBe(1);
    expect(w.known.size).toBe(1);
    // Same chat id under a whole new title: still the same row.
    w.update(scan([chat({ title: 'A', chat: 'c1' })]), 3);
    const rows = w.update(scan([chat({ title: 'Totally new', chat: 'c1' })]), 4);
    expect(rows.filter((x) => x.gone == null).map((x) => x.title)).toEqual(['Totally new']);
  });

  it('a chat leaving the screen is done if the sidebar would show it, else hidden', () => {
    const runs: number[] = [];
    const w = new ChatWatcher((s) => runs.push(s));
    w.update(scan([chat({ title: 'App chat' }), chat({ source: 'chrome', hwnd: 9, title: 'Tab chat' })]), 100);
    const rows = w.update(scan([], true), 200);
    expect(rows.find((x) => x.title === 'App chat')).toMatchObject({ state: 'done', since: 200, visible: true });
    expect(rows.find((x) => x.title === 'Tab chat')).toMatchObject({ state: 'running', visible: false });
    expect(runs).toEqual([100]);
  });

  it('ids are stable and renames are judged by words', () => {
    expect(chatKey(chat())).toBe(chatKey(chat()));
    expect(chatKey(chat())).not.toBe(chatKey(chat({ ord: 1 })));
    expect(renameLike('Source files access', 'Project source files access')).toBe(true);
    expect(renameLike('Source files', 'Lunch plans')).toBe(false);
    expect(renameLike('New chat', 'Anything')).toBe(true);
    expect(renameLike('go to API key', 'API key')).toBe(true);
  });

  it('a Chrome chat whose title gets trimmed keeps one row, not a stuck running one', () => {
    const w = new ChatWatcher();
    const tab = (title: string, state: 'running' | 'done' = 'running') => chat({ source: 'chrome', hwnd: 9, chat: '', title, state });
    w.update(scan([tab('go to API key')]), 1);
    w.update(scan([tab('API key')]), 2);
    const rows = w.update(scan([tab('API key', 'done')]), 3);
    expect(rows.map((x) => [x.title, x.state])).toEqual([['API key', 'done']]);
  });
});

describe('Claude Status: the rules (widget.pyw)', () => {
  it('a background shell gets its own purple row; the session keeps its colour', () => {
    const x = item({ state: 'done', since: 500 });
    const sh = applyShells(x, [{ created: 400, cmd: 'npm run dev', desc: 'Dev server', bg: true }], 1000, () => false);
    expect(x).toMatchObject({ state: 'done', since: 500 });
    expect(sh).toMatchObject({ id: 'abcd1234:shell', state: 'shell', since: 400, label: 'Dev server', parent: { id: 'abcd1234', label: 'Fix the build' }, shell: { count: 1 } });
    expect(stateWord(sh!)).toBe('1 shell');
    // No description: the command names it.
    expect(applyShells(item(), [{ created: 400, cmd: 'cd app && npm run dev 2>&1', desc: '', bg: true }], 1000, () => false)?.label).toBe('npm run dev');
  });

  it('while Claude works its row stays blue, with the shell beside it; an allowed command clears orange', () => {
    const x = item({ state: 'running' });
    const sh = applyShells(x, [{ created: 900, cmd: 'npm run dev', desc: '', bg: true }, { created: 950, cmd: 'npm run api', desc: '', bg: true }], 1000, () => false);
    expect(x.state).toBe('running');
    expect(stateWord(x)).toBe('running');
    expect(sh).toMatchObject({ state: 'shell', label: 'npm run api', shell: { count: 2 } }); // the newest
    expect(stateWord(sh!)).toBe('2 shells');
    const y = item({ state: 'input', since: 800 });
    expect(applyShells(y, [{ created: 900, cmd: 'npm test', desc: '', bg: false }], 1000, () => false)).toBeNull(); // waited on: no shell row
    expect(y).toMatchObject({ state: 'running', since: 900, command: { cmd: 'npm test' } });
    const z = item({ state: 'done' });
    expect(applyShells(z, [{ created: 999, cmd: 'npm test', desc: '', bg: true }], 1000, () => false)).toBeNull(); // under 3 s: never flashes
    expect(z.state).toBe('done');
  });

  it('each shell row sits under its session, the pair sorted by the one that ranks first', () => {
    const old = item({ id: 'old', title: 'a old', state: 'done', since: 0 }); // grey
    const run = item({ id: 'run', title: 'm running', state: 'running' });
    const ask = item({ id: 'ask', title: 'z asks', state: 'input' });
    const sessions = [old, run, ask];
    labelItems(sessions);
    const shellOld = applyShells(old, [{ created: 10, cmd: 'npm run dev', desc: '', bg: true }], 1000, () => false)!;
    const shellRun = applyShells(run, [{ created: 10, cmd: 'npm run api', desc: '', bg: true }], 1000, () => false)!;
    const orphan = { ...shellOld, id: 'gone:shell', parent: { id: 'gone', label: 'gone' }, label: 'b server' };
    const order = orderWithShells(sortItems(sessions, 1000), [shellRun, shellOld, orphan], 1000);
    // Orange first; then the running rows by name: "b server" alone, "m running" with its shell, and
    // the grey "a old" rides up with its server ("npm run dev") instead of sinking to the bottom.
    expect(order.map((x) => x.id)).toEqual(['ask', 'gone:shell', 'run', 'run:shell', 'old', 'old:shell']);
  });

  it('workflow agents keep a finished row running', () => {
    const x = item({ state: 'done', unread: true });
    applyWorkflow(x, { started: 4, finished: 1, first: 700 });
    expect(x).toMatchObject({ state: 'running', since: 700, unread: false, prog: { kind: 'workflow', total: 4, done: 1 } });
    const bar = runProgress(x, 900, [], [], new Map(), {});
    expect(bar?.[1]).toMatch(/^1\/4 agents · /);
    expect(bar?.[2]).toBe('workflow · est. time');
  });

  it('progress from the task list, never moving backwards', () => {
    const max = new Map<string, number>();
    const x = item({ runStarted: 0, prog: { total: 4, done: 2, baseDone: 0, lastDoneAt: 100 } });
    const a = runProgress(x, 120, [], [], max, {})!;
    expect(a[2]).toBe('task list');
    expect(a[0]).toBeCloseTo((2 + 0.4) / 4);
    expect(a[1]).toBe('2/4 · ~1 min left'); // 50 s a step: 2 left = 100 s, 20 s in
    x.prog = { total: 4, done: 1, baseDone: 0, lastDoneAt: 100 };
    expect(runProgress(x, 120, [], [], max, {})![0]).toBe(a[0]);
    expect(runProgress(item({ runStarted: 990 }), 1000, [], [], new Map(), {})).toBeNull(); // under a minute
    expect(runProgress(item({ runStarted: 0 }), 100, [200, 300, 400], [], new Map(), {})![2]).toBe('history est.');
  });

  it('a timed shell gets its own bar', () => {
    const x = item({ state: 'shell', shell: { cmd: 'npm run build', desc: 'Build', created: 100, count: 1 } });
    const bar = runProgress(x, 110, [], [], new Map(), { 'npm run build': [40, 40] })!;
    expect(bar).toEqual([0.25, 'almost done', 'Build']);
  });

  it('names hosts, tags, labels and order like the widget', () => {
    expect(hostOf(['openconsole.exe', 'windowsterminal.exe'], 'interactive')).toBe('Terminal');
    expect(hostOf(['cmd.exe', 'netbeans64.exe'], 'interactive')).toBe('NetBeans');
    expect(hostOf(['claude.exe'], 'interactive')).toBe('Claude App');
    expect(hostOf(['explorer.exe'], 'interactive')).toBe('Console');
    expect(hostOf([], 'bg')).toBe('Background');
    expect(sourceTag({ source: 'code', host: 'Claude App' })).toBe('APP CODE');
    expect(sourceTag({ source: 'chrome', host: '' })).toBe('CHROME');
    const items = [item({ id: 'aaaa1', state: 'done', since: 0 }), item({ id: 'bbbb2', title: 'Fix the build' }), item({ id: 'c', title: '', project: 'zeta', state: 'input' })];
    labelItems(items);
    expect(items.map((x) => x.label)).toEqual(['Fix the build · aaaa', 'Fix the build · bbbb', 'zeta']);
    expect(sortItems(items, 1000).map((x) => x.id)).toEqual(['c', 'bbbb2', 'aaaa1']); // orange first; done 1000 s ago is grey
    const mixed = [item({ id: 'run', state: 'running' }), item({ id: 'red', state: 'failed', stopped: true }), item({ id: 'ask', state: 'input' })];
    labelItems(mixed);
    expect(sortItems(mixed, 1000).map((x) => x.id)).toEqual(['ask', 'red', 'run']);
    // Unread greens (pink dot) come right under blue, the newest first; read greens follow by name.
    const greens = [
      item({ id: 'read', title: 'a read one', state: 'done', since: 990 }),
      item({ id: 'old', title: 'b unread', state: 'done', since: 900, unread: true }),
      item({ id: 'new', title: 'c unread', state: 'done', since: 950, unread: true }),
      item({ id: 'run', title: 'z running', state: 'running' }),
    ];
    labelItems(greens);
    expect(sortItems(greens, 1000).map((x) => x.id)).toEqual(['run', 'new', 'old', 'read']);
    expect(isStale(item({ state: 'done', since: 0 }), 601)).toBe(true);
    expect(normTitle('✳ Fix the build ')).toBe('fix the build');
  });

  it('a turn stopped with Esc says so', () => {
    expect(stateWord(item({ state: 'failed', stopped: true }))).toBe('stopped');
    expect(stateWord(item({ state: 'failed' }))).toBe('failed');
    expect(toneOf(row({ state: 'failed', word: 'stopped', stopped: true }))).toBe('bad');
  });

  it('a dismissal lasts until the session moves on', () => {
    const d = { at: 500, state: 'done' as const };
    expect(isDismissed({ since: 400, source: 'code', state: 'done' }, d)).toBe(true);
    expect(isDismissed({ since: 600, source: 'code', state: 'running' }, d)).toBe(false);
    expect(isDismissed({ since: 600, source: 'app', state: 'done' }, d)).toBe(true);
    expect(isDismissed({ since: 600, source: 'app', state: 'done' }, undefined)).toBe(false);
  });

  it('a dismissed shell row comes back once its session moves on', () => {
    const sh = { since: 100, source: 'code' as const, state: 'shell' as const };
    const d = { at: 500, state: 'shell' as const };
    expect(shellDismissed(sh, { since: 400 }, d)).toBe(true);
    expect(shellDismissed(sh, { since: 600 }, d)).toBe(false); // a new turn, or the turn ended
    expect(shellDismissed({ ...sh, since: 700 }, { since: 400 }, d)).toBe(false); // a newer shell
    expect(shellDismissed(sh, { since: 400 }, undefined)).toBe(false);
  });
});
