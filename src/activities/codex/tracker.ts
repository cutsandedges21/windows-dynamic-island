// Codex's chats for the island. Hooks say what happens the moment it happens (a prompt sent,
// a turn ending, the chat closing), with the codex.exe that runs the chat (the hook's
// grandparent: island-hook ← powershell ← codex). Codex's session files fill in the rest and
// remember chats from before Island started or without hooks: titles, last answers, turns,
// context, tokens and the plan's limits (rollout.ts). The process table says where a chat
// lives (the Codex app, an editor, a terminal) and whether its Codex is still running.

import { clip } from '../../core/format';
import { native, type CodexEnv, type DirEntry } from '../../core/native';
import type { AgentTracker } from '../agent/engine';
import type { ContextFill } from '../claude/estimate';
import type { HookEvent } from '../claude/hooks';
import { classifyAncestry, ProcessProbe } from '../claude/procinfo';
import { projectName, statusLabel, statusTone, type Status } from '../claude/status';
import type { ClosedView, SessionView, TrackerEvent } from '../claude/tracker';
import type { UsageData } from '../claude/usage';
import { codexLimits } from './limits';
import { emptySummary, foldRollout, weekTokens, type RolloutSummary } from './rollout';

/** Session files touched this recently are read; older ones are history Island already knows or doesn't need. */
const FILES_MAX_AGE_MS = 2 * 86_400_000;
/** Without hooks, a chat whose file moved this recently counts as open. */
const RECENT_MS = 10 * 60_000;
/** Closed chats are listed this long. */
const CLOSED_MS = 24 * 3_600_000;
/** A hook-live chat whose Codex process is unknown stays open this long after its last hook (Codex ends idle chats at 30 min). */
const HOOK_IDLE_MS = 30 * 60_000;
/** At most this many session files are read per poll; the rest wait for the next. */
const SCANS_PER_POLL = 12;
const CODEX_EXE = 'codex.exe';
/** The Codex desktop app's own process names: an app-server under one of them is the app's. */
const APP_NAMES = new Set(['codex.exe', 'chatgpt.exe']);

/** What hooks said about a chat. */
interface Live {
  sessionId: string;
  pid: number;
  /** The hook's grandparent and parent: Codex is the first named codex.exe (normally the grandparent, under PowerShell). */
  candidates: number[];
  cwd: string;
  transcript: string | null;
  lastHookAt: number;
  turnOpen: boolean;
  turnStartMs: number | null;
  aborted: boolean;
  prompt: string | null;
  lastAssistant: string | null;
  ended: boolean;
  model: string | null;
  permissionMode: string | null;
}

interface FileState {
  path: string;
  offset: number;
  size: number;
  summary: RolloutSummary;
}

interface Place {
  host: string;
  hostKind: string | null;
  editorHost: string | null;
  entrypoint: 'codex-app' | 'codex-editor' | 'codex-cli';
}

export class CodexTracker implements AgentTracker {
  readonly probe = new ProcessProbe();
  private readonly live = new Map<string, Live>();
  /** Session files by path. */
  private readonly files = new Map<string, FileState>();
  /** Thread names from session_index.jsonl, and its size when read. */
  private names = new Map<string, string>();
  private namesSize = -1;
  private sessions: SessionView[] = [];
  private closed: ClosedView[] = [];
  private wasLive = new Map<string, SessionView>();

  constructor(private readonly env: CodexEnv) {}

  // ---------------------------------------------------------------- hooks

  /** A Codex hook event, before the engine handles it: the chat is live at once. */
  noteHook(ev: HookEvent, now = Date.now()): void {
    const sid = ev.session_id ?? '';
    if (!sid) return;
    let l = this.live.get(sid);
    if (!l) {
      l = { sessionId: sid, pid: 0, candidates: [], cwd: ev.cwd ?? '', transcript: null, lastHookAt: now, turnOpen: false, turnStartMs: null, aborted: false, prompt: null, lastAssistant: null, ended: false, model: null, permissionMode: null };
      this.live.set(sid, l);
    }
    l.lastHookAt = now;
    if (ev.cwd) l.cwd = ev.cwd;
    if (typeof ev.transcript_path === 'string' && ev.transcript_path) l.transcript = ev.transcript_path;
    const candidates = [Number(ev.hook_gppid), Number(ev.hook_ppid)].filter((pid) => pid > 0);
    if (candidates.length) {
      l.candidates = candidates;
      l.pid = candidates[0];
    }
    if (ev.model) l.model = ev.model;
    if (ev.permission_mode) l.permissionMode = ev.permission_mode;
    switch (ev.hook_event_name) {
      case 'SessionStart':
        l.ended = false;
        break;
      case 'UserPromptSubmit':
        l.ended = false;
        l.turnOpen = true;
        l.aborted = false;
        l.turnStartMs = now;
        if (ev.prompt?.trim()) l.prompt = clip(ev.prompt.replace(/\s+/g, ' ').trim(), 300);
        break;
      case 'PreToolUse':
      case 'PermissionRequest':
      case 'PostToolUse':
        if (!l.turnOpen) {
          l.turnOpen = true;
          l.turnStartMs = l.turnStartMs ?? now;
        }
        break;
      case 'Stop':
        l.turnOpen = false;
        if (ev.last_assistant_message?.trim()) l.lastAssistant = ev.last_assistant_message.trim();
        break;
      case 'Interrupt':
        l.turnOpen = false;
        l.aborted = true;
        break;
      case 'SessionEnd':
        l.ended = true;
        l.turnOpen = false;
        break;
    }
  }

  // ---------------------------------------------------------------- polling

  async poll(now = Date.now()): Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }> {
    this.probe.load(await native.procSnapshot());
    for (const l of this.live.values()) l.pid = l.candidates.find((pid) => this.isCodex(pid)) ?? l.pid;
    await this.readNames();
    await this.readFiles();
    const byId = new Map<string, FileState>();
    for (const f of this.files.values()) {
      const id = f.summary.id ?? idFromPath(f.path);
      if (id) byId.set(id, f);
    }
    const sessions: SessionView[] = [];
    const closed: ClosedView[] = [];
    const ids = new Set([...this.live.keys(), ...byId.keys()]);
    for (const id of ids) {
      const l = this.live.get(id) ?? null;
      const f = (l?.transcript ? this.files.get(l.transcript) : null) ?? byId.get(id) ?? null;
      const s = this.view(id, l, f?.summary ?? null, f?.path ?? l?.transcript ?? null, now);
      if (this.isLive(l, f?.summary ?? null, now)) sessions.push(s);
      else if (now - s.lastActivityMs < CLOSED_MS) closed.push(closedView(s));
    }
    sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    closed.sort((a, b) => b.closedAt - a.closedAt);

    const events: TrackerEvent[] = [];
    const nowLive = new Map(sessions.map((s) => [s.id, s]));
    for (const [id, before] of this.wasLive) {
      const after = nowLive.get(id);
      if (!after) {
        const c = closed.find((x) => x.id === id);
        if (c) events.push({ type: 'closed', session: c });
      } else if (before.status === 'working' && after.status !== 'working' && !this.live.has(id)) {
        // Hooks announce their own chats; this is for chats seen only in their files.
        events.push({ type: 'finished', session: after });
      }
    }
    this.wasLive = nowLive;
    this.sessions = sessions;
    this.closed = closed;
    return { sessions, closed, events };
  }

  private isLive(l: Live | null, f: RolloutSummary | null, now: number): boolean {
    if (l) {
      if (l.ended) return false;
      if (l.pid > 0) return this.probe.table.has(l.pid);
      return now - l.lastHookAt < HOOK_IDLE_MS;
    }
    return f !== null && now - f.lastActivityMs < RECENT_MS;
  }

  /** session_index.jsonl: one line per name given (the newest wins). Read again only when it changed. */
  private async readNames(): Promise<void> {
    const [st] = await native.statMany([this.env.indexPath]);
    const size = st?.size ?? 0;
    if (size === this.namesSize) return;
    this.namesSize = size;
    const text = size ? await native.readText(this.env.indexPath, 4 * 1024 * 1024) : null;
    const names = new Map<string, string>();
    for (const line of (text ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof o.id === 'string' && typeof o.thread_name === 'string' && o.thread_name.trim()) names.set(o.id, o.thread_name.trim());
      } catch {
        /* a line being written */
      }
    }
    this.names = names;
  }

  /** Reads what is new in the session files that moved (and in the ones hooks point at). */
  private async readFiles(): Promise<void> {
    const listed: DirEntry[] = await native.listFiles(this.env.sessionsDir, true, '.jsonl', FILES_MAX_AGE_MS);
    const todo: Array<{ path: string; size: number }> = [];
    for (const e of listed) {
      if (e.dir) continue;
      const known = this.files.get(e.path);
      if (!known || known.size !== e.size) todo.push({ path: e.path, size: e.size });
    }
    for (const l of this.live.values()) {
      if (l.transcript && !this.files.has(l.transcript) && !todo.some((t) => t.path === l.transcript)) todo.push({ path: l.transcript, size: -1 });
    }
    for (const { path, size } of todo.slice(0, SCANS_PER_POLL)) {
      const known = this.files.get(path) ?? { path, offset: 0, size: 0, summary: emptySummary() };
      const scan = await native.codexRolloutScan(path, known.offset);
      if (!scan) continue;
      // Rewritten from the start: what was known of it no longer holds.
      const base = scan.size < known.offset ? emptySummary() : known.summary;
      this.files.set(path, { path, offset: scan.offset, size: size >= 0 ? size : scan.size, summary: foldRollout(base, scan.lines) });
    }
  }

  // ---------------------------------------------------------------- views

  private place(pid: number, originator: string | null): Place {
    if (pid > 0 && this.probe.table.has(pid)) {
      const ancestors = this.probe.ancestors(pid).map((a) => a.name.toLowerCase());
      if (ancestors.some((n) => APP_NAMES.has(n))) return { host: 'Codex app', hostKind: 'app', editorHost: null, entrypoint: 'codex-app' };
      const cls = classifyAncestry(ancestors);
      if (cls.hostKind === 'editor' && !cls.viaCli) return { host: cls.host!, hostKind: 'editor', editorHost: cls.host, entrypoint: 'codex-editor' };
      if (cls.host) return { host: cls.hostKind === 'editor' ? `${cls.host} terminal` : cls.host, hostKind: cls.hostKind, editorHost: null, entrypoint: 'codex-cli' };
    }
    const o = (originator ?? '').toLowerCase();
    if (o.includes('desktop')) return { host: 'Codex app', hostKind: 'app', editorHost: null, entrypoint: 'codex-app' };
    if (o.includes('vscode')) {
      const editor = this.probe.runningEditor() ?? 'VS Code';
      return { host: editor, hostKind: 'editor', editorHost: editor, entrypoint: 'codex-editor' };
    }
    return { host: 'Terminal', hostKind: 'terminal', editorHost: null, entrypoint: 'codex-cli' };
  }

  private view(id: string, l: Live | null, f: RolloutSummary | null, file: string | null, now: number): SessionView {
    // Whichever spoke last knows best whether a turn runs: a hook, or the file.
    const hookNewer = l !== null && (!f || l.lastHookAt >= f.lastActivityMs);
    const turnOpen = hookNewer ? l!.turnOpen : (f?.turnOpen ?? false);
    const aborted = hookNewer ? l!.aborted : (f?.aborted ?? false);
    const prompted = Boolean(l?.prompt || f?.lastPrompt);
    const status: Status = turnOpen ? 'working' : aborted ? 'interrupted' : f?.error && !hookNewer ? 'errored' : prompted ? 'awaiting_input' : 'new';
    const cwd = l?.cwd || f?.cwd || '';
    const place = this.place(l?.pid ?? 0, f?.originator ?? null);
    const title = this.names.get(id) ?? f?.title ?? l?.prompt ?? null;
    const lastActivityMs = Math.max(l?.lastHookAt ?? 0, f?.lastActivityMs ?? 0);
    const ctx = f?.context;
    const context: ContextFill | null = ctx && ctx.window ? { used: ctx.used, window: ctx.window, share: Math.min(1, ctx.used / ctx.window), fullIn: null } : null;
    return {
      id, sessionId: id, pid: l?.pid ?? 0, cwd, name: '', kind: 'interactive', entrypoint: place.entrypoint,
      alive: true, status, label: statusLabel(status), tone: statusTone(status), needsYou: false,
      title, displayTitle: title ?? (cwd ? projectName(cwd) : 'Codex chat'), project: cwd ? projectName(cwd) : '',
      host: place.host, editorHost: place.editorHost, hostKind: place.hostKind, model: l?.model ?? null, permissionMode: l?.permissionMode ?? null,
      gitBranch: null, lastActivityMs, lastAliveAt: now, slot: null, tool: null,
      operation: turnOpen && f?.lastTool ? `Ran ${f.lastTool.detail}` : null,
      turnStartMs: turnOpen ? ((hookNewer ? l!.turnStartMs : f?.turnStartMs) ?? null) : null,
      lastAssistantText: (hookNewer ? l!.lastAssistant : null) ?? f?.lastAssistant ?? l?.lastAssistant ?? null,
      transcript: file, version: f?.version ?? null, context, turns: f?.turns ?? [],
    };
  }

  // ---------------------------------------------------------------- lookups

  get(id: string): SessionView | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  getClosed(id: string): ClosedView | null {
    return this.closed.find((c) => c.id === id) ?? null;
  }

  liveIds(): string[] {
    return this.sessions.map((s) => s.id);
  }

  /** The session file of a chat, for reading its messages. */
  transcriptOf(id: string): string | null {
    const l = this.live.get(id);
    if (l?.transcript) return l.transcript;
    for (const f of this.files.values()) if ((f.summary.id ?? idFromPath(f.path)) === id) return f.path;
    return null;
  }

  /** The plan's limits as of Codex's newest reading in any file, and when that was. */
  limits(): { data: UsageData | null; asOf: number | null } {
    let best: { at: number; raw: unknown } | null = null;
    for (const f of this.files.values()) if (f.summary.limits && (!best || f.summary.limits.at > best.at)) best = f.summary.limits;
    return best ? { data: codexLimits(best.raw), asOf: best.at } : { data: null, asOf: null };
  }

  /** Tokens since `since` (ms) in the chats read. */
  weekTokens(since: number): { fresh: number; cached: number; output: number } {
    return weekTokens([...this.files.values()].map((f) => f.summary), since);
  }

  /** Is this a codex.exe Island knows? */
  isCodex(pid: number): boolean {
    const name = (this.probe.processName(pid) ?? '').toLowerCase();
    // A Mac's codex has no .exe.
    return name === CODEX_EXE || name === 'codex';
  }
}

/** rollout-2026-10-30T17-25-24-<thread id>.jsonl → the thread id. */
function idFromPath(path: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

function closedView(s: SessionView): ClosedView {
  return {
    id: s.id, sessionId: s.sessionId, cwd: s.cwd, entrypoint: s.entrypoint, kind: s.kind, displayTitle: s.displayTitle, title: s.title,
    project: s.project, host: s.host, editorHost: s.editorHost, model: s.model, closedAt: s.lastActivityMs, source: 'history',
  };
}
