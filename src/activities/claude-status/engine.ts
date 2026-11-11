// Claude Status's engine: every Claude session as the Claude Sessions widget
// (~/.claude/claude-status) showed it, worked out inside Island so nothing else
// has to run. Claude Code sessions come from Island's own tracker (Claude Code's
// session registry, the process table and the transcripts) plus the transcript's
// task list and shell commands; the Claude app and Chrome come from UI
// Automation and the notifications Windows keeps. Then the widget's rules:
// purple background shells, workflow agents, unread dots, progress estimates,
// dismissing, order. Times are in seconds, like the widget's.

import { native, type WindowRow } from '../../core/native';
import { focusSession, selectWindow } from '../claude/focus';
import { joinPath, type Status } from '../claude/status';
import { SessionTracker, type SessionView } from '../claude/tracker';
import { ChatWatcher, type ChatRecord } from './chats';
import { BAR_AFTER, CHAT_PRIOR, CODE_PRIOR, estimate, fmtLeft, SHELL_BAR_MIN, bashCommand, shellKey, shellSamples } from './estimate';
import { WorkReader, type Prog, type ShellCall, type Work } from './work';

/** shell: a shell Claude started is still running (Claude Code's "1 shell"). */
export type StatusState = 'running' | 'shell' | 'input' | 'done' | 'failed' | 'idle';

/** One row, as the activity draws it. */
export interface StatusRow {
  id: string;
  label: string;
  /** Where the session runs (Terminal); for a shell row, the session it belongs to. */
  where: string;
  tag: string;
  state: StatusState;
  /** A background shell's own row (purple): the id of the session that started it. */
  parent?: string;
  word: string;
  since: number;
  grey: boolean;
  unread: boolean;
  hidden: boolean;
  progress: { value: number; text: string; method: string } | null;
  /** You stopped it (Esc): red like a failure, but nothing pops up. */
  stopped?: boolean;
}

/** What a row knows while the rules run (the widget's session dict). */
export interface Item {
  id: string;
  source: 'code' | 'app' | 'chrome';
  title: string;
  project: string;
  host: string;
  state: StatusState;
  since: number;
  runStarted: number | null;
  prog: Prog | null;
  unread: boolean;
  visible: boolean;
  label: string;
  /** A shell row: its background shells (purple). */
  shell?: { cmd: string; desc: string; created: number; count: number };
  /** A shell row: the session that started it. */
  parent?: { id: string; label: string };
  /** The command Claude is waiting on: its bar is closer than the run's. */
  command?: { cmd: string; desc: string; created: number };
  /** You pressed Esc mid-turn. */
  stopped?: boolean;
  view?: SessionView;
  /** A Claude Code session's task list and shell calls, from its transcript. */
  work?: Work;
  chat?: ChatRecord;
}

const WORDS: Record<StatusState, string> = { running: 'running', shell: 'shell', input: 'needs you', done: 'done', failed: 'failed', idle: 'idle' };
/** Orange (needs you) and red (failed or stopped) first, then running; grey ones (idle, or done a while) sink to the bottom. */
const ORDER: Record<StatusState, number> = { input: 0, failed: 1, running: 2, shell: 2, done: 3, idle: 4 };
const DIMMED = 5;

/** Claude Code's status (Island's tracker) in the widget's words. A session nobody has prompted yet isn't listed. */
const CODE_STATE: Partial<Record<Status, StatusState>> = {
  working: 'running',
  awaiting_permission: 'input',
  awaiting_input: 'done',
  completed: 'done',
  errored: 'failed',
  // Esc mid-turn: red, like the turn ended badly (Claude Code fires no hook for it).
  interrupted: 'failed',
  unknown: 'idle',
};

export const DONE_DIM_AFTER = 10 * 60;
/** Inactive rows (done, failed, idle) leave after this, as if dismissed. */
const AUTO_DISMISS_AFTER = 20 * 60;
const WORKFLOW_STALE_MS = 15 * 60_000;
const SHELL_EXES = new Set(['bash.exe', 'sh.exe', 'zsh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe']);
/** Quicker commands never change the dot. */
const SHELL_MIN_AGE = 3;

// Where Claude Code runs, from its parent processes (the widget's winutil.find_host).
const HOSTS = new Map([
  ['windowsterminal.exe', 'Terminal'], ['code.exe', 'VS Code'], ['code - insiders.exe', 'VS Code'], ['cursor.exe', 'Cursor'],
  ['windsurf.exe', 'Windsurf'], ['netbeans64.exe', 'NetBeans'], ['netbeans.exe', 'NetBeans'], ['idea64.exe', 'IntelliJ'],
  ['pycharm64.exe', 'PyCharm'], ['webstorm64.exe', 'WebStorm'], ['rider64.exe', 'Rider'], ['clion64.exe', 'CLion'],
  ['goland64.exe', 'GoLand'], ['phpstorm64.exe', 'PhpStorm'], ['studio64.exe', 'Android Studio'], ['mintty.exe', 'Git Bash'],
  ['java.exe', 'Java IDE'], ['javaw.exe', 'Java IDE'],
]);
const PASS_THROUGH = new Set([
  'python.exe', 'pythonw.exe', 'py.exe', 'bash.exe', 'sh.exe', 'zsh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe',
  'openconsole.exe', 'node.exe', 'winpty-agent.exe', 'wsl.exe', 'wslhost.exe', 'uv.exe', 'bun.exe', 'git.exe',
]);

export function hostOf(ancestors: string[], kind: string): string {
  if (kind === 'bg') return 'Background';
  for (const exe of ancestors) {
    if (exe === 'claude.exe') return 'Claude App'; // the desktop app's Code tab
    if (exe === 'explorer.exe') return 'Console';
    const h = HOSTS.get(exe);
    if (h) return h;
    if (!PASS_THROUGH.has(exe)) return exe.replace(/\.exe$/, '').replace(/^./, (c) => c.toUpperCase());
  }
  return 'Console';
}

export function sourceTag(x: Pick<Item, 'source' | 'host'>): string {
  if (x.source === 'app') return 'APP CHAT';
  if (x.source === 'chrome') return 'CHROME';
  return x.host === 'Claude App' ? 'APP CODE' : (x.host || 'CODE').toUpperCase().slice(0, 10);
}

export function sourceName(x: Pick<Item, 'source' | 'host'>): string {
  if (x.source === 'app') return 'Claude app';
  if (x.source === 'chrome') return 'Chrome';
  return x.host === 'Claude App' ? 'Claude app (Code)' : x.host || 'Claude Code';
}

const shellsText = (n: number) => `${n} shell${n === 1 ? '' : 's'}`;

export function stateWord(x: Pick<Item, 'state' | 'shell' | 'stopped'>): string {
  if (x.state === 'shell') return shellsText(x.shell?.count ?? 1);
  if (x.stopped && x.state === 'failed') return 'stopped';
  return WORDS[x.state];
}

/** Grey rows: idle, or finished a while ago. */
export function isStale(x: Pick<Item, 'state' | 'since'>, now: number): boolean {
  return x.state === 'idle' || (x.state === 'done' && now - x.since > DONE_DIM_AFTER);
}

export function rank(x: Item, now: number): [number, string] {
  return [isStale(x, now) ? DIMMED : ORDER[x.state] ?? 9, x.label.toLowerCase()];
}

/** Greens you haven't read yet (pink dot) lead the greens, newest finished first. */
function unreadDone(x: Item, rk: number): boolean {
  return rk === ORDER.done && x.unread;
}

function compareItems(a: Item, b: Item, now: number): number {
  const [ra, la] = rank(a, now);
  const [rb, lb] = rank(b, now);
  if (ra !== rb) return ra - rb;
  const ua = unreadDone(a, ra);
  const ub = unreadDone(b, rb);
  if (ua !== ub) return ua ? -1 : 1;
  if (ua && a.since !== b.since) return b.since - a.since;
  return la < lb ? -1 : la > lb ? 1 : 0;
}

export function sortItems(items: Item[], now: number): Item[] {
  return items.sort((a, b) => compareItems(a, b, now));
}

/**
 * Sessions in order with each shell row right under its session; the pair sorts by
 * whichever of the two comes first (a server still running keeps a finished session
 * up with the running ones). A shell whose session is dismissed or gone stands alone.
 */
export function orderWithShells(sessions: Item[], shells: Item[], now: number): Item[] {
  const shellOf = new Map(shells.map((s) => [s.parent?.id, s]));
  const groups = sessions.map((x) => {
    const sh = shellOf.get(x.id);
    shellOf.delete(x.id);
    return sh ? [x, sh] : [x];
  });
  for (const sh of shellOf.values()) groups.push([sh]);
  const lead = (g: Item[]) => g.reduce((a, b) => (compareItems(b, a, now) < 0 ? b : a));
  return groups.sort((a, b) => compareItems(lead(a), lead(b), now)).flat();
}

/** Name rows by title, else folder; two with the same name get a short id. */
export function labelItems(items: Item[]): void {
  const counts = new Map<string, number>();
  for (const x of items) counts.set(x.title || x.project, (counts.get(x.title || x.project) ?? 0) + 1);
  for (const x of items) {
    const base = x.title || x.project;
    x.label = counts.get(base) === 1 ? base : `${base} · ${x.id.slice(0, 4)}`;
  }
}

/** Tab and window titles carry a leading status glyph (spinner, ✳). */
export function normTitle(t: string | null | undefined): string {
  return (t || '').replace(/^[^\p{L}\p{N}_]+/u, '').trim().toLowerCase();
}

export interface Dismissal {
  at: number;
  state: StatusState;
}

/** Hidden until the session changes state after you dismissed it. */
export function isDismissed(x: Pick<Item, 'since' | 'source' | 'state'>, d: Dismissal | undefined): boolean {
  if (!d) return false;
  if (x.since <= d.at) return true;
  // The app/Chrome watcher restarts its clock with Island, so for those rows
  // "same state as when dismissed" is what counts.
  return x.source !== 'code' && x.state === d.state;
}

/** A shell row's state never changes, so its dismissal lasts until its session's state does. */
export function shellDismissed(sh: Pick<Item, 'since' | 'source' | 'state'>, session: Pick<Item, 'since'>, d: Dismissal | undefined): boolean {
  return !!d && session.since <= d.at && isDismissed(sh, d);
}

/** A tool shell Claude started, alive right now. */
export interface LiveShell {
  created: number;
  cmd: string;
  desc: string;
  /** Not a command Claude is waiting on: Claude Code counts it as "1 shell". */
  bg: boolean;
}

/** A shell row's name: what Claude called the command, else the command itself. */
function shellName(sh: { cmd: string; desc: string }): string {
  const name = sh.desc || shellKey(sh.cmd) || 'Shell';
  return name.length <= 48 ? name : name.slice(0, 47).trimEnd() + '…';
}

/**
 * The widget's apply_shells, with background shells on a row of their own: the
 * session keeps its colour (blue, green, orange) and its shells get a purple row
 * under it, returned here. A command Claude waits on is no shell: the row stays
 * blue, its bar can follow that command, and an allowed prompt stops being orange
 * once the command starts.
 */
export function applyShells(x: Item, shells: LiveShell[], now: number, timed: (cmd: string) => boolean): Item | null {
  const live = shells.filter((sh) => now - sh.created >= SHELL_MIN_AGE);
  if (!live.length) return null;
  const state = x.state;
  const waitedOn = live.filter((sh) => !sh.bg && (state === 'running' || sh.created > x.since));
  if (waitedOn.length && (state === 'running' || state === 'input')) {
    const sh = waitedOn.reduce((a, b) => (b.created > a.created ? b : a));
    if (state === 'input') {
      x.state = 'running';
      x.since = sh.created;
    }
    x.command = { cmd: sh.cmd, desc: sh.desc, created: sh.created };
  }
  const bg = live.filter((sh) => sh.bg);
  if (!bg.length) return null;
  // The row (and its bar) follows the shell we can time, else the newest.
  const pool = bg.filter((sh) => timed(sh.cmd));
  const sh = (pool.length ? pool : bg).reduce((a, b) => (b.created > a.created ? b : a));
  return {
    id: `${x.id}:shell`,
    source: x.source,
    title: x.title,
    project: x.project,
    host: x.host,
    state: 'shell',
    since: sh.created,
    runStarted: null,
    prog: null,
    unread: false,
    visible: x.visible,
    label: shellName(sh),
    shell: { cmd: sh.cmd, desc: sh.desc, created: sh.created, count: bg.length },
    parent: { id: x.id, label: x.label || x.title || x.project },
    view: x.view,
  };
}

/** The workflow agents a session started: still working after its turn ended. */
export interface Workflow {
  started: number;
  finished: number;
  first: number;
}

export function applyWorkflow(x: Item, wf: Workflow | undefined): void {
  if (!wf || !['done', 'idle', 'running'].includes(x.state)) return;
  const prog: Prog = { total: wf.started, done: wf.finished, baseDone: 0, kind: 'workflow', countStart: wf.first, lastDoneAt: wf.first };
  if (x.state === 'running') {
    // Already running: show the workflow's progress unless it has a task list.
    if (!x.prog?.total) x.prog = prog;
    return;
  }
  x.state = 'running';
  x.since = wf.first;
  x.runStarted = wf.first;
  x.prog = prog;
  x.unread = false;
}

export type Bar = [number, string, string];

/** The widget's progress(): [fraction, text, how it was worked out] for a run past a minute. */
export function runProgress(x: Item, now: number, history: number[], chatHistory: number[], barMax: Map<string, number>, times: Record<string, number[]>): Bar | null {
  const keep = (start: number, frac: number) => {
    const key = `${x.id}:${Math.round(start)}`;
    const v = Math.max(barMax.get(key) ?? 0, Math.min(0.97, frac)); // never moves backwards
    barMax.set(key, v);
    return v;
  };
  const shellBar = (sh: { cmd: string; desc: string; created: number } | undefined): Bar | null => {
    if (!sh) return null;
    const samples = shellSamples(times, sh.cmd);
    if (!samples.length || Math.max(...samples) < SHELL_BAR_MIN) return null;
    const [frac, left] = estimate(samples, now - sh.created);
    const name = sh.desc || shellKey(sh.cmd);
    const method = name.length <= 24 ? name : name.slice(0, 23).trimEnd() + '…';
    return [keep(sh.created, frac), fmtLeft(left), method];
  };
  if (x.state === 'shell') return shellBar(x.shell);
  if (x.state === 'running' && x.command) {
    const bar = shellBar(x.command);
    if (bar) return bar;
  }
  if (x.state !== 'running') return null;
  const start = x.runStarted ?? x.since;
  const elapsed = now - start;
  if (elapsed < BAR_AFTER) return null;
  const isCode = x.source === 'code';
  const real = isCode ? history : chatHistory;
  const [hFrac, hLeft] = estimate([...(isCode ? CODE_PRIOR : CHAT_PRIOR), ...real], elapsed);
  const prog = x.prog;
  const total = prog?.total ?? 0;
  let frac: number;
  let text: string;
  let method: string;
  if (prog && total && prog.kind === 'workflow') {
    // Agents run in parallel, so per-agent time can't be multiplied out:
    // the bar is agents finished, the time comes from history.
    const done = Math.min(prog.done, total);
    frac = Math.max(done / total, Math.min(0.9, hFrac) / total);
    text = `${done}/${total} agents · ${fmtLeft(hLeft)}`;
    method = 'workflow · est. time';
  } else if (prog && total) {
    const done = Math.min(prog.done, total);
    const doneNow = done - (prog.baseDone ?? 0);
    let left: number;
    if (doneNow <= 0) {
      // No step finished yet this run: lean on run history for time.
      frac = Math.max(done / total, (hFrac * (total - done)) / total);
      left = hLeft;
    } else {
      const last = prog.lastDoneAt ?? start;
      const avg = Math.max(5, (last - (prog.countStart ?? start)) / doneNow);
      const cur = now - last;
      frac = (done + Math.min(0.9, cur / avg)) / total;
      left = Math.max(0, avg * (total - done) - cur);
    }
    text = `${done}/${total} · ${fmtLeft(left)}`;
    // Until a step finishes this run, the time part is a history guess.
    method = doneNow > 0 ? 'task list' : 'task list · est. time';
  } else {
    // No task list: from how long your runs take.
    frac = hFrac;
    text = fmtLeft(hLeft);
    method = real.length >= 3 ? 'history est.' : 'rough est.';
  }
  return [keep(start, frac), text, method];
}

// ------------------------------------------------------------------ persistence

const KEY = 'island.claudeStatus.';

function load<T>(name: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + name) ?? 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function save(name: string, value: unknown): void {
  try {
    localStorage.setItem(KEY + name, JSON.stringify(value));
  } catch {
    // full or unavailable: the next save tries again
  }
}

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []);

// ------------------------------------------------------------------ engine

interface ShellProc {
  owner: number;
  sid: string;
  created: number;
  tool: boolean;
  lineCmd: string;
  call: ShellCall | null;
}

export class StatusEngine {
  private readonly projectsDir: string;
  private readonly tracker: SessionTracker;
  private readonly work = new WorkReader();
  private readonly chats: ChatWatcher;
  private chatRows: ChatRecord[] = [];
  private uiBusy = false;
  private uiChecked = 0;
  private history = numbers(load('history', []));
  private chatHistory = numbers(load('chatHistory', []));
  private shellTimes = load<Record<string, number[]>>('shellTimes', {});
  private seen: Record<string, number> | null = load<Record<string, number> | null>('seen', null);
  private dismissed = load<Record<string, Dismissal>>('dismissed', {});
  private readonly barMax = new Map<string, number>();
  /**
   * Each Claude Code session's state and since when, kept across restarts like
   * the widget's session files: the transcript alone can't say when a turn
   * ended (Claude Code writes an "away summary" into an idle one later).
   */
  private readonly codeStates = new Map(Object.entries(load<Record<string, { state: StatusState; since: number }>>('codeStates', {})));
  /** Sessions this run of Island watched change: only their runs go into the history. */
  private readonly watched = new Set<string>();
  private readonly shellProcs = new Map<number, ShellProc>();
  private shellLive = new Map<string, LiveShell[]>();
  private workflows = new Map<string, Workflow>();
  private wfChecked = 0;
  private notifAfter: number;
  private notifChecked = 0;
  private readonly appEvents = new Map<string, [number, 'done' | 'input']>();
  private chromeEvents: number[] = [];
  private lastFg = 0;
  private lastSeenCheck = 0;
  /** Claude Code sessions looked at before, so only the first look can count a finish as old news. */
  private readonly codeSeenOnce = new Set<string>();
  /** The last rows built, by id, for jumping. */
  private items = new Map<string, Item>();

  constructor(
    configDir: string,
    private readonly log: (...p: unknown[]) => void = () => {},
  ) {
    this.projectsDir = joinPath(configDir, 'projects');
    this.tracker = new SessionTracker(joinPath(configDir, 'sessions'), this.projectsDir);
    this.chats = new ChatWatcher((secs) => this.addRun('chatHistory', secs));
    // Notification finishes count only from now on.
    this.notifAfter = Date.now();
  }

  /**
   * Someone who ran the Claude Sessions widget keeps what it learned: how long
   * runs, chats and commands take. Once, and only into an empty history.
   */
  async importWidget(configDir: string): Promise<void> {
    if (load('imported', false)) return;
    save('imported', true);
    const dir = joinPath(configDir, 'claude-status');
    const read = async (name: string): Promise<unknown> => {
      try {
        return JSON.parse((await native.readText(joinPath(dir, name), 1024 * 1024)) ?? 'null');
      } catch {
        return null;
      }
    };
    const [history, chatHistory, shellTimes] = await Promise.all([read('history.json'), read('chat_history.json'), read('shell_times.json')]);
    if (!this.history.length && numbers(history).length) save('history', (this.history = numbers(history).slice(-50)));
    if (!this.chatHistory.length && numbers(chatHistory).length) save('chatHistory', (this.chatHistory = numbers(chatHistory).slice(-50)));
    if (!Object.keys(this.shellTimes).length && shellTimes && typeof shellTimes === 'object' && !Array.isArray(shellTimes)) {
      for (const [k, v] of Object.entries(shellTimes)) if (numbers(v).length) this.shellTimes[k] = numbers(v).slice(-10);
      save('shellTimes', this.shellTimes);
    }
  }

  private addRun(which: 'history' | 'chatHistory', seconds: number): void {
    if (seconds <= 60) return;
    const list = [...this[which], Math.round(seconds)].slice(-50);
    this[which] = list;
    save(which, list);
  }

  // ---------------------------------------------------------------- sources

  /** Claude Code sessions, in the widget's words. */
  private async codeItems(now: number): Promise<Item[]> {
    const { sessions } = await this.tracker.poll();
    const out: Item[] = [];
    const files = new Set<string>();
    let changed = false;
    for (const v of sessions) {
      const state = CODE_STATE[v.status];
      if (!state) continue;
      if (v.transcript) files.add(v.transcript);
      const w: Work = await this.work.read(v.transcript);
      const turnStart = v.turnStartMs != null ? v.turnStartMs / 1000 : null;
      // A turn's end is its turn_duration line, not the transcript's last write
      // (Claude Code adds an "away summary" to an idle chat later).
      const exact = w.stoppedAt != null && w.stoppedAt >= (w.runStarted ?? 0);
      const ended = exact ? w.stoppedAt! : v.lastActivityMs / 1000;
      const prev = this.codeStates.get(v.id);
      let since: number;
      // A known turn end is exact, also for a quick turn that ran between two looks.
      if (exact && (state === 'done' || state === 'failed')) since = Math.min(now, ended);
      else if (prev && prev.state === state) since = prev.since;
      else if (state === 'running') since = w.runStarted ?? turnStart ?? now;
      else if (state === 'input') since = prev ? now : ended;
      else since = Math.min(now, ended);
      const stopped = v.status === 'interrupted';
      // A run you stopped says nothing about how long runs take.
      if (prev && prev.state === 'running' && (state === 'done' || state === 'failed') && !stopped && this.watched.has(v.id)) {
        const started = w.runStarted ?? turnStart;
        if (started != null) this.addRun('history', since - started);
      }
      this.watched.add(v.id);
      if (!prev || prev.state !== state || prev.since !== since) changed = true;
      this.codeStates.set(v.id, { state, since });
      const ancestors = this.tracker.probe.ancestors(v.pid).map((a) => a.name);
      out.push({
        id: v.id, source: 'code', title: v.title ?? '', project: v.project || v.displayTitle, host: hostOf(ancestors, v.kind),
        state, since, runStarted: w.runStarted ?? turnStart, prog: w.prog ? { ...w.prog } : null, unread: false, visible: true, label: '', stopped, view: v, work: w,
      });
    }
    for (const id of [...this.codeStates.keys()]) {
      if (sessions.some((s) => s.id === id)) continue;
      this.codeStates.delete(id);
      this.watched.delete(id);
      changed = true;
    }
    if (changed) save('codeStates', Object.fromEntries(this.codeStates));
    this.work.prune(files);
    return out;
  }

  /** App and Chrome chats: one UI Automation pass a second, never two at once. */
  private async chatItems(now: number): Promise<Item[]> {
    if (!this.uiBusy && now - this.uiChecked >= 1) {
      this.uiBusy = true;
      this.uiChecked = now;
      try {
        const scan = await native.claudeStatusUiScan();
        if (scan) this.chatRows = this.chats.update(scan, Date.now() / 1000);
      } catch (err) {
        this.log('ui scan', String(err));
      } finally {
        this.uiBusy = false;
      }
    }
    return this.chatRows.map((c) => ({
      id: c.id, source: c.source, title: c.title, project: c.title, host: '', state: c.state, since: c.since,
      runStarted: null, prog: c.prog, unread: c.unread, visible: c.visible, label: '', chat: c,
    }));
  }

  /** Finishes the frozen app screen can't show: the app posts a notification even minimized. */
  private async applyNotifications(items: Item[], now: number): Promise<void> {
    if (now - this.notifChecked > 2) {
      this.notifChecked = now;
      for (const n of await native.claudeStatusNotifications(this.notifAfter)) {
        this.notifAfter = Math.max(this.notifAfter, n.at);
        const t = n.at / 1000;
        const msg = n.message.toLowerCase();
        if (n.source === 'chrome') this.chromeEvents.push(t);
        else if (msg.includes('waiting for your input')) continue; // an idle reminder, not a new state
        else this.appEvents.set(normTitle(n.title), [t, msg.includes('needs your input') ? 'input' : 'done']);
      }
      this.chromeEvents = this.chromeEvents.filter((t) => now - t < 3600);
    }
    for (const x of items) {
      if (x.source === 'code' || (x.state !== 'running' && x.state !== 'input')) continue;
      const ev = this.appEvents.get(normTitle(x.title));
      if (ev && ev[0] > x.since && ev[1] !== x.state) {
        x.state = ev[1];
        x.since = ev[0];
        x.unread = ev[1] === 'done';
      }
    }
    // "Claude responded" (through Chrome, also for desktop-app chats) doesn't name
    // the chat: only trust it when exactly one chat was running. A Chrome chat in a
    // background tab never updates its tree, so it stays "running" for good: when
    // that is the only Chrome chat running, a desktop-app chat running beside it
    // doesn't make the event ambiguous (the app names its own finishes).
    const running = items.filter((x) => x.source !== 'code' && x.state === 'running');
    for (const t of [...this.chromeEvents].sort((a, b) => a - b)) {
      const open = running.filter((x) => x.state === 'running' && x.since < t);
      const chrome = open.filter((x) => x.source === 'chrome');
      const candidates = open.length === 1 ? open : chrome.length === 1 ? chrome : [];
      if (candidates.length === 1) {
        const x = candidates[0];
        x.state = 'done';
        x.since = t;
        x.unread = true;
      } else if (open.length > 1) this.log('chrome finish not matched', `${open.length} chats running: ${open.map((x) => `${x.source}:${x.title}`).join(' | ')}`);
    }
  }

  private async applyWorkflows(items: Item[], now: number): Promise<void> {
    const code = items.filter((x) => x.source === 'code');
    if (now - this.wfChecked > 3) {
      this.wfChecked = now;
      const runs = code.length ? await native.claudeWorkflows(this.projectsDir, code.map((x) => x.id), WORKFLOW_STALE_MS) : [];
      this.workflows = new Map(runs.map((r) => [r.session, { started: r.started, finished: r.finished, first: r.firstMs / 1000 }]));
    }
    for (const x of code) applyWorkflow(x, this.workflows.get(x.id));
  }

  /** Each Claude Code session's tool shells, among its Claude process's children; times the ones that ended. */
  private async scanShells(items: Item[], now: number): Promise<void> {
    const table = this.tracker.probe.table;
    const live = new Map<string, LiveShell[]>();
    const owners = new Map<number, Item>();
    for (const x of items) if (x.view && x.view.alive) owners.set(x.view.pid, x);
    const fresh: Array<[number, ShellProc]> = [];
    for (const [pid, p] of table) {
      const x = owners.get(p.ppid);
      if (!x || !SHELL_EXES.has(p.name)) continue;
      const info = this.shellProcs.get(pid);
      if (!info || info.owner !== p.ppid) fresh.push([pid, { owner: p.ppid, sid: x.id, created: p.start != null ? p.start / 1000 : now, tool: false, lineCmd: '', call: null }]);
    }
    if (fresh.length) {
      const lines = await native.claudeStatusCmdlines(fresh.map(([pid]) => pid));
      fresh.forEach(([pid, info], i) => {
        const line = lines[i] ?? '';
        // Claude's tools, not its hooks: the Bash tool sources a shell snapshot,
        // the PowerShell tool passes $__claudeCodeScript.
        info.tool = line.includes('shell-snapshots') || line.includes('__claudeCodeScript');
        info.lineCmd = bashCommand(line);
        this.shellProcs.set(pid, info);
      });
    }
    for (const [pid, info] of this.shellProcs) {
      const x = owners.get(info.owner);
      if (!x || !info.tool || table.get(pid)?.ppid !== info.owner) continue;
      const calls = x.work?.shells ?? [];
      // The call that started it: the last one made before it began. Once placed, kept.
      const before = calls.filter((c) => c.at <= info.created + 1 && (c.end ?? now) >= info.created - 1);
      if (before.length) info.call = before[before.length - 1];
      const call = info.sid === x.id ? info.call : null;
      // Only a call still waiting on its answer is in the foreground; one we can't
      // place is a background one.
      (live.get(x.id) ?? live.set(x.id, []).get(x.id)!).push({
        created: info.created,
        cmd: call?.cmd || info.lineCmd,
        desc: call?.desc ?? '',
        bg: !call || call.task != null || call.end != null,
      });
    }
    // Shells that are gone: remember how long their command took.
    let changed = false;
    for (const [pid, info] of [...this.shellProcs]) {
      if (table.get(pid)?.ppid === info.owner) continue;
      this.shellProcs.delete(pid);
      const cmd = info.call?.cmd || info.lineCmd;
      const took = now - info.created;
      if (!info.tool || !cmd || took < SHELL_MIN_AGE) continue;
      // A background shell counts only if it ran to the end, not if it was stopped.
      if (info.call?.task && !(await native.claudeTaskFinished(info.sid, info.call.task))) continue;
      const key = shellKey(cmd);
      this.shellTimes[key] = [...(this.shellTimes[key] ?? []), Math.round(took * 10) / 10].slice(-10);
      const keys = Object.keys(this.shellTimes);
      for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete this.shellTimes[k];
      changed = true;
    }
    if (changed) save('shellTimes', this.shellTimes);
    this.shellLive = live;
  }

  // ---------------------------------------------------------------- unread

  private windowFor(x: Item, windows: WindowRow[]): number | null {
    const v = x.view;
    if (!v) return x.chat?.hwnd ?? null;
    const candidates = [v.pid, ...this.tracker.probe.ancestors(v.pid).filter((a) => a.name !== 'explorer.exe').map((a) => a.pid)];
    return selectWindow(windows, candidates, v.project);
  }

  /** Is this what you're looking at? Windows Terminal: its title is the active tab's. */
  private isOpen(x: Item, fg: number, windows: WindowRow[]): boolean {
    if (!fg) return false;
    if (x.source === 'chrome') return fg === x.chat?.hwnd;
    if (x.host === 'Terminal') {
      const w = windows.find((r) => r.hwnd === fg);
      return !!w && this.tracker.probe.processName(w.pid) === 'windowsterminal.exe' && normTitle(w.title) === normTitle(x.view?.title || x.view?.name);
    }
    return fg === this.windowFor(x, windows);
  }

  private markSeen(x: Item, now: number): void {
    if (!this.seen) this.seen = {};
    this.seen[x.id] = now;
    for (const [k, t] of Object.entries(this.seen)) if (now - t > 2 * 86400) delete this.seen[k];
    save('seen', this.seen);
    x.unread = false;
  }

  private async markUnread(items: Item[], now: number): Promise<void> {
    if (this.seen == null) {
      // First run: don't flag everything that finished before Island looked.
      this.seen = Object.fromEntries(items.map((x) => [x.id, now]));
      save('seen', this.seen);
    }
    for (const x of items) {
      // A Claude Code session finished before Island started is old news.
      if (x.source === 'code' && !(x.id in this.seen) && x.state === 'done' && x.since < now - 5 && !this.codeSeenOnce.has(x.id)) this.seen[x.id] = now;
      if (x.source === 'code') this.codeSeenOnce.add(x.id);
      // The desktop app tracks this itself ("Unread response").
      if (x.source === 'app') x.unread = x.unread && x.state === 'done';
      else x.unread = x.state === 'done' && x.since > (this.seen[x.id] ?? 0);
    }
    if (!items.some((x) => x.unread)) return;
    const fg = await native.foreground();
    if (fg === this.lastFg && now - this.lastSeenCheck <= 2) return;
    this.lastFg = fg;
    this.lastSeenCheck = now;
    const windows = await native.winEnum();
    for (const x of items) if (x.unread && x.source !== 'app' && this.isOpen(x, fg, windows)) this.markSeen(x, now);
  }

  // ---------------------------------------------------------------- dismissing

  dismiss(id: string): void {
    const x = this.items.get(id);
    if (!x) return;
    const now = Date.now() / 1000;
    this.dismissed[id] = { at: now, state: x.state };
    // Forget dismissals after two days.
    for (const [k, d] of Object.entries(this.dismissed)) if (now - d.at > 2 * 86400) delete this.dismissed[k];
    save('dismissed', this.dismissed);
  }

  // ---------------------------------------------------------------- the rows

  async poll(): Promise<StatusRow[]> {
    const now = Date.now() / 1000;
    const [code, chats] = await Promise.all([this.codeItems(now), this.chatItems(now)]);
    const all = [...code, ...chats];

    // A dismissal lasts until the session changes state.
    let changed = false;
    for (const x of all) {
      const d = this.dismissed[x.id];
      if (d && x.state !== d.state) {
        delete this.dismissed[x.id];
        changed = true;
      }
    }
    if (changed) save('dismissed', this.dismissed);
    let items = all.filter((x) => !isDismissed(x, this.dismissed[x.id]));
    labelItems(items);

    await this.applyNotifications(items, now);
    await this.applyWorkflows(items, now);
    await this.markUnread(items, now);
    // Every session's shells, dismissed ones too: a server outlives the session row you put away.
    try {
      await this.scanShells(all, now);
    } catch (err) {
      this.shellLive = new Map();
      this.log('shells', String(err));
    }
    const timed = (cmd: string) => shellSamples(this.shellTimes, cmd).length > 0;
    const shells: Item[] = [];
    for (const x of all) {
      const sh = applyShells(x, this.shellLive.get(x.id) ?? [], now, timed);
      if (sh && !shellDismissed(sh, x, this.dismissed[sh.id])) shells.push(sh);
    }

    // Inactive a while: gone, as if dismissed.
    const stale = items.filter((x) => (x.state === 'done' || x.state === 'failed' || x.state === 'idle') && now - x.since > AUTO_DISMISS_AFTER);
    for (const x of stale) {
      this.items.set(x.id, x);
      this.dismiss(x.id);
    }
    items = orderWithShells(sortItems(items.filter((x) => !stale.includes(x)), now), shells, now);
    this.items = new Map(items.map((x) => [x.id, x]));

    return items.map((x) => {
      const bar = runProgress(x, now, this.history, this.chatHistory, this.barMax, this.shellTimes);
      return {
        id: x.id,
        label: x.label,
        where: x.parent ? x.parent.label : sourceName(x),
        tag: sourceTag(x),
        state: x.state,
        ...(x.parent ? { parent: x.parent.id } : {}),
        word: stateWord(x),
        since: x.since,
        grey: isStale(x, now),
        unread: x.unread,
        hidden: !x.visible,
        progress: bar ? { value: Math.round(bar[0] * 1000) / 1000, text: bar[1], method: bar[2] } : null,
        ...(x.stopped && x.state === 'failed' ? { stopped: true } : {}),
      };
    });
  }

  // ---------------------------------------------------------------- jumping

  /** Raise the session's window: its Terminal tab or editor, or the app chat or Chrome tab. */
  async jump(id: string): Promise<boolean> {
    const x = this.items.get(id);
    if (!x) return false;
    if (x.unread && x.source !== 'app') this.markSeen(x, Date.now() / 1000);
    await native.allowForeground();
    if (x.view) {
      const v = x.view;
      return focusSession(
        { sessionId: v.sessionId, pid: v.pid, cwd: v.cwd, title: v.title, name: v.name, entrypoint: v.entrypoint, host: v.editorHost || v.host },
        this.tracker.probe,
        this.log,
      );
    }
    const c = x.chat;
    if (!c) return false;
    const ok = c.hwnd ? await native.activate(c.hwnd) : false;
    // App chats: open that conversation by pressing its sidebar row.
    if (c.source === 'app') return (await native.claudeStatusOpenChat(c.title, c.ord)) || ok;
    return ok;
  }
}
