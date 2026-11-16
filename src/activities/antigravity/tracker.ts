// Antigravity's conversations for the island, from its app, its IDE and its CLI (agy): one agent
// behind all three. Hooks say when a conversation starts, when a turn starts (the first model
// call) and ends, with the process running it (the hook's grandparent: island-hook ← cmd ←
// language_server or agy). The transcripts (transcript.ts) give titles, requests and answers,
// and remember conversations from before Island started or without hooks.

import { native, type AgTranscript, type AntigravityEnv } from '../../core/native';
import type { AgentTracker } from '../agent/engine';
import type { HookEvent } from '../claude/hooks';
import { classifyAncestry, ProcessProbe } from '../claude/procinfo';
import { projectName, statusLabel, statusTone, type Status } from '../claude/status';
import type { ClosedView, SessionView, TrackerEvent } from '../claude/tracker';
import { folderOf, parseSteps, summarize, type AgSummary } from './transcript';

const FILES_MAX_AGE_MS = 2 * 86_400_000;
const LIST_EVERY_MS = 10_000;
/** Without hooks, a conversation whose transcript moved this recently counts as open (while Antigravity runs). */
const RECENT_MS = 10 * 60_000;
const CLOSED_MS = 24 * 3_600_000;
const HOOK_IDLE_MS = 30 * 60_000;
const READS_PER_POLL = 8;
const READ_MAX = 8 * 1024 * 1024;
/** The processes that run Antigravity's agent: its language server (app, IDE) and the CLI. */
const AGENT_NAMES = new Set(['language_server.exe', 'language_server_windows_x64.exe', 'agy.exe']);
const APP = 'antigravity.exe';
const IDE = 'antigravity ide.exe';

/** The events Island's Antigravity hooks send (Antigravity's names; the relay adds hook_event_name). */
export type AgEvent = 'SessionStart' | 'PreInvocation' | 'PostToolUse' | 'PreToolUse' | 'Stop';

/** An Antigravity hook event as it arrives: its camelCase fields on top of the relay's. */
export interface AgHook extends HookEvent {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  modelName?: string;
  invocationNum?: number;
  toolCall?: { name?: string; args?: Record<string, unknown> };
  terminationReason?: string;
  error?: string;
  fullyIdle?: boolean;
}

export type Product = 'app' | 'ide' | 'cli';

interface Live {
  sessionId: string;
  pid: number;
  candidates: number[];
  cwd: string;
  transcript: string | null;
  lastHookAt: number;
  turnOpen: boolean;
  turnStartMs: number | null;
  errored: boolean;
  ended: boolean;
  model: string | null;
}

interface FileState {
  path: string;
  size: number;
  mtimeMs: number;
  product: Product;
  summary: AgSummary | null;
}

/** Which Antigravity wrote a transcript, from its folder (~/.gemini/antigravity-cli/… is the CLI's). */
export function productOf(path: string): Product {
  const p = path.replace(/\//g, '\\').toLowerCase();
  if (p.includes('\\antigravity-cli\\')) return 'cli';
  if (p.includes('\\antigravity-ide\\')) return 'ide';
  return 'app';
}

export const PRODUCT_NAMES: Record<Product, string> = { app: 'Antigravity', ide: 'Antigravity IDE', cli: 'Antigravity CLI' };

export class AntigravityTracker implements AgentTracker {
  readonly probe = new ProcessProbe();
  private readonly live = new Map<string, Live>();
  private readonly files = new Map<string, FileState>();
  private listedAt = 0;
  private sessions: SessionView[] = [];
  private closed: ClosedView[] = [];
  private wasLive = new Map<string, SessionView>();

  constructor(private readonly env: AntigravityEnv) {}

  static chatOf(ev: AgHook): string {
    return (ev.conversationId || ev.session_id || '').toLowerCase();
  }

  noteHook(ev: AgHook, now = Date.now()): void {
    const sid = AntigravityTracker.chatOf(ev);
    if (!sid) return;
    let l = this.live.get(sid);
    if (!l) {
      l = { sessionId: sid, pid: 0, candidates: [], cwd: '', transcript: null, lastHookAt: now, turnOpen: false, turnStartMs: null, errored: false, ended: false, model: null };
      this.live.set(sid, l);
    }
    l.lastHookAt = now;
    const folder = folderOf(ev.workspacePaths?.[0]);
    if (folder) l.cwd = folder;
    if (typeof ev.transcriptPath === 'string' && ev.transcriptPath) l.transcript = ev.transcriptPath;
    const candidates = [Number(ev.hook_gppid), Number(ev.hook_ppid)].filter((pid) => pid > 0);
    if (candidates.length) {
      l.candidates = candidates;
      l.pid = candidates[0];
    }
    if (ev.modelName && ev.modelName !== 'auto') l.model = ev.modelName;
    switch (ev.hook_event_name as AgEvent) {
      case 'SessionStart':
        l.ended = false;
        break;
      case 'PreInvocation':
        if (!l.turnOpen) {
          l.turnOpen = true;
          l.errored = false;
          l.turnStartMs = now;
        }
        l.ended = false;
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        if (!l.turnOpen) {
          l.turnOpen = true;
          l.turnStartMs = l.turnStartMs ?? now;
        }
        break;
      case 'Stop':
        l.turnOpen = false;
        l.errored = ev.terminationReason === 'error';
        break;
    }
  }

  /** Reads a conversation's transcript now (a Stop is waiting on its last answer). */
  async refresh(id: string): Promise<AgSummary | null> {
    const path = this.transcriptOf(id);
    if (!path) return null;
    const text = await native.readText(path, READ_MAX);
    if (text === null) return null;
    const summary = summarize(parseSteps(text));
    const f = this.files.get(id);
    if (f) f.summary = summary;
    else this.files.set(id, { path, size: text.length, mtimeMs: Date.now(), product: productOf(path), summary });
    return summary;
  }

  async poll(now = Date.now()): Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }> {
    this.probe.load(await native.procSnapshot());
    for (const l of this.live.values()) l.pid = l.candidates.find((pid) => this.isAgent(pid)) ?? l.pid;
    await this.readFiles(now);
    const agentRuns = [...this.probe.table.values()].some((p) => AGENT_NAMES.has(p.name.toLowerCase()));
    const sessions: SessionView[] = [];
    const closed: ClosedView[] = [];
    for (const id of new Set([...this.live.keys(), ...this.files.keys()])) {
      const l = this.live.get(id) ?? null;
      const f = this.files.get(id) ?? null;
      if (!f?.summary?.lastPrompt && !l?.turnStartMs) continue;
      const s = this.view(id, l, f, now);
      if (this.isLive(l, f, agentRuns, now)) sessions.push(s);
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
        events.push({ type: 'finished', session: after });
      }
    }
    this.wasLive = nowLive;
    this.sessions = sessions;
    this.closed = closed;
    return { sessions, closed, events };
  }

  private isLive(l: Live | null, f: FileState | null, agentRuns: boolean, now: number): boolean {
    if (l) {
      if (l.ended) return false;
      if (l.pid > 0) return this.probe.table.has(l.pid);
      return now - l.lastHookAt < HOOK_IDLE_MS;
    }
    return agentRuns && f !== null && now - f.mtimeMs < RECENT_MS;
  }

  private async readFiles(now: number): Promise<void> {
    if (now - this.listedAt >= LIST_EVERY_MS || [...this.live.values()].some((l) => l.transcript && !this.files.has(l.sessionId))) {
      this.listedAt = now;
      const listed: AgTranscript[] = await native.antigravityTranscripts(FILES_MAX_AGE_MS);
      for (const t of listed) {
        const id = t.id.toLowerCase();
        const known = this.files.get(id);
        if (known) {
          if (known.size !== t.size) known.summary = null;
          Object.assign(known, { path: t.path, size: t.size, mtimeMs: t.mtimeMs });
        } else this.files.set(id, { path: t.path, size: t.size, mtimeMs: t.mtimeMs, product: productOf(t.path), summary: null });
      }
    }
    const liveFiles = [...this.live.values()].map((l) => (l.transcript ? { id: l.sessionId, path: l.transcript } : null)).filter((x): x is { id: string; path: string } => x !== null);
    if (liveFiles.length) {
      const stats = await native.statMany(liveFiles.map((x) => x.path));
      liveFiles.forEach(({ id, path }, i) => {
        const st = stats[i];
        if (!st) return;
        const known = this.files.get(id);
        if (!known) this.files.set(id, { path, size: st.size, mtimeMs: st.mtimeMs, product: productOf(path), summary: null });
        else if (known.size !== st.size) Object.assign(known, { size: st.size, mtimeMs: st.mtimeMs, summary: null });
      });
    }
    let reads = 0;
    for (const f of this.files.values()) {
      if (f.summary || reads >= READS_PER_POLL) continue;
      reads++;
      const text = f.size <= READ_MAX ? await native.readText(f.path, READ_MAX) : null;
      f.summary = summarize(parseSteps(text ?? ''));
    }
  }

  /** Where a conversation runs: the app, the IDE, or the CLI in a terminal. */
  private place(pid: number, product: Product | null): { host: string; hostKind: string; product: Product } {
    if (pid > 0 && this.probe.table.has(pid)) {
      const names = [this.probe.processName(pid) ?? '', ...this.probe.ancestors(pid).map((a) => a.name)].map((n) => n.toLowerCase());
      if (names.includes(IDE)) return { host: 'Antigravity IDE', hostKind: 'editor', product: 'ide' };
      if (names.includes(APP)) return { host: 'Antigravity', hostKind: 'app', product: 'app' };
      if (names[0] === 'agy.exe') {
        const cls = classifyAncestry(names.slice(1));
        return { host: cls.host ?? 'Terminal', hostKind: cls.hostKind ?? 'terminal', product: 'cli' };
      }
    }
    const p = product ?? 'app';
    return { host: PRODUCT_NAMES[p], hostKind: p === 'cli' ? 'terminal' : p === 'ide' ? 'editor' : 'app', product: p };
  }

  private view(id: string, l: Live | null, f: FileState | null, now: number): SessionView {
    const sum = f?.summary ?? null;
    const fileAt = Math.max(sum?.lastActivityMs ?? 0, f?.mtimeMs ?? 0);
    const hookNewer = l !== null && (!f || l.lastHookAt >= fileAt);
    const turnOpen = hookNewer ? l!.turnOpen : (sum?.turnOpen ?? false);
    const errored = hookNewer ? l!.errored : (sum?.error ?? false);
    const status: Status = turnOpen ? 'working' : errored ? 'errored' : 'awaiting_input';
    const cwd = l?.cwd || '';
    const place = this.place(l?.pid ?? 0, f?.product ?? (l?.transcript ? productOf(l.transcript) : null));
    const title = sum?.title ?? null;
    const lastActivityMs = Math.max(l?.lastHookAt ?? 0, fileAt);
    return {
      id, sessionId: id, pid: l?.pid ?? 0, cwd, name: '', kind: 'interactive', entrypoint: `antigravity-${place.product}`,
      alive: true, status, label: statusLabel(status), tone: statusTone(status), needsYou: false,
      title, displayTitle: title ?? (cwd ? projectName(cwd) : 'Antigravity chat'), project: cwd ? projectName(cwd) : '',
      host: place.host, editorHost: place.hostKind === 'editor' ? place.host : null, hostKind: place.hostKind, model: l?.model ?? null, permissionMode: null,
      gitBranch: null, lastActivityMs, lastAliveAt: now, slot: null, tool: null,
      operation: turnOpen && sum?.lastTool ? sum.lastTool : null,
      turnStartMs: turnOpen ? (l?.turnStartMs ?? sum?.turnStartMs ?? null) : null,
      lastAssistantText: sum?.lastAssistant ?? null,
      transcript: f?.path ?? l?.transcript ?? null, version: null, context: null, turns: [],
    };
  }

  get(id: string): SessionView | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  getClosed(id: string): ClosedView | null {
    return this.closed.find((c) => c.id === id) ?? null;
  }

  transcriptOf(id: string): string | null {
    return this.live.get(id)?.transcript ?? this.files.get(id)?.path ?? null;
  }

  /** Is this a process that runs Antigravity's agent? */
  isAgent(pid: number): boolean {
    return AGENT_NAMES.has((this.probe.processName(pid) ?? '').toLowerCase());
  }

  get environment(): AntigravityEnv {
    return this.env;
  }
}

function closedView(s: SessionView): ClosedView {
  return {
    id: s.id, sessionId: s.sessionId, cwd: s.cwd, entrypoint: s.entrypoint, kind: s.kind, displayTitle: s.displayTitle, title: s.title,
    project: s.project, host: s.host, editorHost: s.editorHost, model: s.model, closedAt: s.lastActivityMs, source: 'history',
  };
}
