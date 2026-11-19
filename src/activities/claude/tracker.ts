// The session list: registry + process probe + transcript → status, with stable
// slot numbers 1–9 (first appearance). A chat that closes leaves the live list
// at once and moves to the closed list (kept a day, newest first). Ported from
// Usage Clip's registry.js, tracker.js and history.js.

import { native, type FileStat } from '../../core/native';
import { contextFill, type ContextFill } from './estimate';
import { ProcessProbe, type ProbeResult } from './procinfo';
import { deriveStatus, describeTool, formatModel, isUuid, cwdToSlug, joinPath, projectName, statusLabel, statusTone, type RawStatus, type Status } from './status';
import { TranscriptReader, type TranscriptInfo } from './transcript';

const CLOSED_KEEP_MS = 24 * 3600000;
const MAX_CLOSED = 15;
const MAX_SLOTS = 9;
const HISTORY_FILES = 25;

// ------------------------------------------------------------------ registry

export interface RegistryRecord {
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  kind: string;
  entrypoint: string | null;
  nativeStatus: string | null;
  waitingFor: string | null;
  jobId: string | null;
  /** The background job this chat was parked into: its terminal tab now shows that job. */
  parkedJobId: string | null;
  procStart: bigint | null;
  startedAt: number | null;
  version: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseProcStart(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const ticks = BigInt(value);
    return ticks > 0n ? ticks : null;
  }
  return null;
}

export function normalize(data: unknown): RegistryRecord | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const { sessionId, pid, cwd } = d;
  if (!str(sessionId) || !Number.isInteger(pid) || (pid as number) <= 0 || !str(cwd)) return null;
  return {
    sessionId: sessionId as string,
    pid: pid as number,
    cwd: cwd as string,
    name: str(d.name) || (sessionId as string).slice(0, 8),
    kind: str(d.kind) || 'interactive',
    entrypoint: str(d.entrypoint),
    nativeStatus: str(d.status),
    waitingFor: str(d.waitingFor),
    jobId: str(d.jobId),
    parkedJobId: str(d.parkedJobId),
    procStart: parseProcStart(d.procStart),
    startedAt: typeof d.startedAt === 'number' && d.startedAt > 0 ? d.startedAt : null,
    version: str(d.version),
  };
}

// Last good record per registry file: Claude Code rewrites these in place on
// every status change, so a read can land mid-write.
const lastGood = new Map<string, RegistryRecord>();

export async function listSessions(sessionsDir: string): Promise<RegistryRecord[]> {
  const entries = await native.readDir(sessionsDir);
  if (!entries) return [];
  const files = entries.filter((e) => !e.dir && e.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  const present = new Set<string>();
  const out: RegistryRecord[] = [];
  const texts = await Promise.all(files.map((f) => native.readText(f.path, 256 * 1024)));
  files.forEach((f, i) => {
    present.add(f.path);
    let rec: RegistryRecord | null = null;
    try {
      rec = normalize(JSON.parse(texts[i] ?? ''));
    } catch {
      rec = null;
    }
    if (rec) lastGood.set(f.path, rec);
    else rec = lastGood.get(f.path) ?? null;
    if (rec) out.push(rec);
  });
  for (const file of [...lastGood.keys()]) if (!present.has(file)) lastGood.delete(file);
  return out;
}

// ------------------------------------------------------------------ Auto model's own runs

/**
 * Auto model (src-tauri/model-router, installed in ~/.claude/model-router) asks Claude about every
 * prompt and every finished chat with `claude -p`: router.mjs before a prompt runs (a few seconds),
 * review.mjs after a turn or a compaction. Each is a session of its own in Claude Code's registry
 * that starts and ends at once, so it showed as a chat finishing ("done" for a split second) every
 * time the user sent a prompt. They are told apart by their process, not their title: a
 * non-interactive run (entrypoint "sdk-…") whose command line, or its parent's (node running
 * router.mjs or review.mjs), names the model-router folder. The user's own `claude -p` names
 * neither, and still shows.
 */
export const isSdkRun = (entrypoint: string | null): boolean => !!entrypoint && entrypoint.startsWith('sdk');

const MODEL_ROUTER = /[\\/]model-router[\\/]/i;

/** From the run's own command line and its parent's (null: could not be read). */
export function isAutoModelRun(own: string | null | undefined, parent: string | null | undefined): boolean {
  return MODEL_ROUTER.test(own ?? '') || MODEL_ROUTER.test(parent ?? '');
}

/** What router.mjs's prompt starts with: the title its run gets, for when no command line can be read. */
const ROUTER_PROMPT = /^Current model: \S+, effort: /;

// ------------------------------------------------------------------ transcripts on disk

const transcriptCache = new Map<string, string>();

/** projects/<slug>/<id>.jsonl, else search projects/*\/<id>.jsonl (drive-letter case can differ). */
export async function findTranscript(projectsDir: string, sessionId: string, cwd: string): Promise<string | null> {
  if (!isUuid(sessionId)) return null;
  const cached = transcriptCache.get(sessionId);
  if (cached) return cached;
  const file = `${sessionId}.jsonl`;
  const expected = joinPath(projectsDir, cwdToSlug(cwd || ''), file);
  const [st] = await native.statMany([expected]);
  if (st) {
    transcriptCache.set(sessionId, expected);
    return expected;
  }
  const dirs = (await native.readDir(projectsDir)) ?? [];
  const candidates = dirs.filter((d) => d.dir).map((d) => joinPath(d.path, file));
  const stats = await native.statMany(candidates);
  const hit = candidates.find((_, i) => stats[i]);
  if (hit) transcriptCache.set(sessionId, hit);
  return hit ?? null;
}

// ------------------------------------------------------------------ sessions

export interface SessionView {
  id: string;
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  kind: string;
  entrypoint: string | null;
  alive: boolean;
  status: Status;
  label: string;
  tone: string;
  needsYou: boolean;
  title: string | null;
  displayTitle: string;
  project: string;
  host: string;
  editorHost: string | null;
  hostKind: string | null;
  model: string | null;
  permissionMode: string | null;
  gitBranch: string | null;
  lastActivityMs: number;
  lastAliveAt: number;
  slot: number | null;
  /** Island additions. */
  tool: string | null;
  operation: string | null;
  turnStartMs: number | null;
  lastAssistantText: string | null;
  transcript: string | null;
  version: string | null;
  /** How full the chat's context is (estimate.ts); null until a reply since the last compaction. */
  context?: ContextFill | null;
  /** How long its recent finished turns took, oldest first, for "done in". */
  turns?: number[];
  /** A background job's id (Claude Code's jobId). */
  jobId?: string | null;
  /** The background job this chat was parked into: its terminal tab shows that job now. */
  parkedJobId?: string | null;
}

export interface ClosedView {
  id: string;
  sessionId: string;
  cwd: string;
  entrypoint: string | null;
  kind?: string;
  displayTitle: string;
  title: string | null;
  project: string;
  host?: string;
  editorHost?: string | null;
  model: string | null;
  closedAt: number;
  source: 'live' | 'history';
}

export type TrackerEvent = { type: 'needs-you'; session: SessionView } | { type: 'closed'; session: ClosedView } | { type: 'finished'; session: SessionView };

export function hostLabel(info: { host: string | null; hostKind: string | null }, entrypoint: string | null, kind: string): string {
  if (kind === 'bg') return 'Background';
  if (entrypoint === 'claude-vscode') return info.hostKind === 'editor' && info.host ? info.host : 'VS Code';
  if (info.hostKind === 'editor') return `${info.host} terminal`;
  return info.host || 'Terminal';
}

function closedView(s: SessionView, closedAt: number): ClosedView {
  return {
    id: s.id, sessionId: s.sessionId, cwd: s.cwd, entrypoint: s.entrypoint, kind: s.kind, displayTitle: s.displayTitle, title: s.title,
    project: s.project, host: s.host, editorHost: s.editorHost, model: s.model, closedAt, source: 'live',
  };
}

export class SessionTracker {
  readonly probe = new ProcessProbe();
  private readonly transcripts = new TranscriptReader();
  private known = new Map<string, SessionView>();
  private closed = new Map<string, ClosedView>();
  private slots = new Map<string, number>();
  private order = new Map<string, number>();
  private seq = 0;
  /** Non-interactive runs looked at, by session: whether each is one of Auto model's (isAutoModelRun). */
  private readonly helperRuns = new Map<string, boolean>();
  latestVersion: string | null = null;
  private busy: Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }> | null = null;

  constructor(
    private readonly sessionsDir: string,
    private readonly projectsDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  poll(): Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }> {
    if (!this.busy) this.busy = this.doPoll().finally(() => (this.busy = null));
    return this.busy;
  }

  private async doPoll() {
    const now = this.now();
    const [rows, records] = await Promise.all([native.procSnapshot(), listSessions(this.sessionsDir)]);
    this.probe.load(rows);
    const events: TrackerEvent[] = [];
    const current = new Map<string, SessionView>();
    const activeFiles = new Set<string>();

    let live: Array<{ rec: RegistryRecord; info: ProbeResult }> = [];
    for (const rec of records) {
      const info = this.probe.probe(rec.pid, rec.procStart);
      if (info.alive && !live.some((l) => l.rec.sessionId === rec.sessionId)) live.push({ rec, info });
    }
    live = await this.withoutHelperRuns(live);
    const files = await Promise.all(live.map(({ rec }) => findTranscript(this.projectsDir, rec.sessionId, rec.cwd)));
    const stats = await native.statMany(files.map((f) => f ?? ''));
    const infos: TranscriptInfo[] = await Promise.all(live.map((_, i) => this.transcripts.read(files[i], files[i] ? (stats[i] as FileStat | null) : null)));

    live.forEach(({ rec, info }, i) => {
      const file = files[i];
      if (file) activeFiles.add(file);
      const t = infos[i];
      if (isSdkRun(rec.entrypoint) && !this.helperRuns.has(rec.sessionId) && ROUTER_PROMPT.test(t.title ?? '')) return;
      const prev = this.known.get(rec.sessionId);
      const lastActivityMs = t.lastTimestampMs ?? (t.hasTranscript ? t.mtimeMs : null);
      const processStartMs = rec.startedAt ?? info.startMs;
      const raw: RawStatus = {
        alive: true,
        hasTranscript: t.hasTranscript,
        hasActivity: t.lastTimestampMs != null,
        lastEntryKind: t.lastEntryKind,
        lastStopReason: t.lastStopReason,
        pendingTool: t.pendingTool,
        lastToolName: t.lastToolName,
        permissionMode: t.permissionMode,
        apiErrorKind: t.apiErrorKind,
        apiErrorStatus: t.apiErrorStatus,
        childCount: info.childCount,
        nativeStatus: rec.nativeStatus,
        waitingFor: rec.waitingFor,
        ageSeconds: lastActivityMs != null ? Math.max(0, (now - lastActivityMs) / 1000) : null,
        processAgeSeconds: processStartMs != null ? Math.max(0, (now - processStartMs) / 1000) : null,
      };
      const status = deriveStatus(raw);
      if (t.version || rec.version) this.latestVersion = rec.version || t.version;
      const op = status === 'working' && t.pendingTool ? describeTool(t.lastToolName, t.lastToolInput) : null;
      const view: SessionView = {
        id: rec.sessionId,
        sessionId: rec.sessionId,
        pid: rec.pid,
        cwd: rec.cwd,
        name: rec.name,
        kind: rec.kind,
        entrypoint: rec.entrypoint,
        alive: true,
        status,
        label: statusLabel(status, raw),
        tone: statusTone(status),
        needsYou: status === 'awaiting_permission',
        title: t.title || null,
        displayTitle: t.title || rec.name || 'New session',
        project: projectName(rec.cwd),
        host: hostLabel(info, rec.entrypoint, rec.kind),
        editorHost: info.hostKind === 'editor' ? info.host : null,
        hostKind: info.hostKind,
        model: formatModel(t.model),
        permissionMode: t.permissionMode,
        gitBranch: t.gitBranch,
        lastActivityMs: lastActivityMs ?? processStartMs ?? now,
        lastAliveAt: now,
        slot: null,
        tool: t.pendingTool ? t.lastToolName : null,
        operation: op ? (op.detail ? `${op.verb} · ${op.detail}` : op.verb) : null,
        turnStartMs: t.turnStartMs,
        lastAssistantText: t.lastAssistantText,
        transcript: file,
        version: rec.version || t.version,
        context: contextFill(t.model, t.ctx),
        turns: t.turns,
        jobId: rec.jobId,
        parkedJobId: rec.parkedJobId,
      };
      if (prev && prev.alive && !prev.needsYou && view.needsYou) events.push({ type: 'needs-you', session: view });
      if (prev && prev.status === 'working' && view.status === 'awaiting_input') events.push({ type: 'finished', session: view });
      current.set(rec.sessionId, view);
    });

    // Live last poll, gone now: it just closed.
    for (const [id, prev] of this.known) {
      if (current.has(id)) continue;
      const c = closedView(prev, now);
      this.closed.set(id, c);
      events.push({ type: 'closed', session: c });
    }
    for (const id of current.keys()) this.closed.delete(id);
    for (const [id, c] of this.closed) if (now - c.closedAt > CLOSED_KEEP_MS) this.closed.delete(id);

    for (const id of [...this.slots.keys()]) if (!current.has(id)) this.slots.delete(id);
    for (const id of [...this.order.keys()]) if (!current.has(id)) this.order.delete(id);
    for (const id of current.keys()) if (!this.order.has(id)) this.order.set(id, this.seq++);
    const used = new Set(this.slots.values());
    for (const id of [...current.keys()].sort((a, b) => this.order.get(a)! - this.order.get(b)!)) {
      if (this.slots.has(id)) continue;
      for (let n = 1; n <= MAX_SLOTS; n++) {
        if (!used.has(n)) {
          this.slots.set(id, n);
          used.add(n);
          break;
        }
      }
    }

    this.known = current;
    this.transcripts.prune(activeFiles);
    const sessions = [...current.values()]
      .map((s) => ({ ...s, slot: this.slots.get(s.id) ?? null }))
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || this.order.get(a.id)! - this.order.get(b.id)!);
    return { sessions, closed: this.closedList(), events };
  }

  /**
   * The live sessions without Auto model's own `claude -p` runs: no row, no dot, no finish, no
   * "closed". Each non-interactive run's command lines are read once, the first poll it shows in.
   */
  private async withoutHelperRuns<T extends { rec: RegistryRecord }>(live: T[]): Promise<T[]> {
    const ids = new Set(live.map((l) => l.rec.sessionId));
    for (const id of [...this.helperRuns.keys()]) if (!ids.has(id)) this.helperRuns.delete(id);
    const fresh = live.filter((l) => isSdkRun(l.rec.entrypoint) && !this.helperRuns.has(l.rec.sessionId));
    if (fresh.length) {
      const lines = await native.claudeStatusCmdlines(fresh.flatMap(({ rec }) => [rec.pid, this.probe.table.get(rec.pid)?.ppid ?? 0]));
      fresh.forEach(({ rec }, i) => {
        const [own, parent] = [lines[2 * i], lines[2 * i + 1]];
        // Neither readable: asked again next poll; meanwhile the router's title gives it away.
        if (own || parent) this.helperRuns.set(rec.sessionId, isAutoModelRun(own, parent));
      });
    }
    return live.filter((l) => !this.helperRuns.get(l.rec.sessionId));
  }

  /** Merge chats found closed in transcripts (ones that ended before we saw them). */
  addHistory(entries: ClosedView[]): void {
    const now = this.now();
    for (const e of entries) {
      if (this.known.has(e.id)) continue;
      const have = this.closed.get(e.id);
      if (have && have.source === 'live') {
        if (e.title && e.title !== have.title) this.closed.set(e.id, { ...have, title: e.title, displayTitle: e.title });
        continue;
      }
      if (now - e.closedAt > CLOSED_KEEP_MS) continue;
      this.closed.set(e.id, { ...have, ...e });
    }
  }

  closedList(): ClosedView[] {
    return [...this.closed.values()].sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_CLOSED);
  }

  getClosed(id: string): ClosedView | null {
    return this.closed.get(id) ?? null;
  }

  bySlot(n: number): SessionView | null {
    for (const [id, slot] of this.slots) if (slot === n) return this.known.get(id) ?? null;
    return null;
  }

  firstNeedingYou(): SessionView | null {
    const list = [...this.known.values()].filter((s) => s.needsYou);
    list.sort((a, b) => (this.slots.get(a.id) ?? 99) - (this.slots.get(b.id) ?? 99));
    return list[0] ?? null;
  }

  get(id: string): SessionView | null {
    return this.known.get(id) ?? null;
  }

  liveIds(): Set<string> {
    return new Set(this.known.keys());
  }
}

/** Recently closed chats from transcripts touched in the last day that aren't running. */
export class ClosedHistory {
  private readonly reader = new TranscriptReader();

  constructor(
    private readonly projectsDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async scan(liveIds: Set<string>): Promise<ClosedView[]> {
    const all = await native.listFiles(this.projectsDir, true, '.jsonl', CLOSED_KEEP_MS);
    const root = this.projectsDir.replace(/[\\/]+$/, '').toLowerCase();
    const files = all
      .filter((f) => {
        // Only projects/<slug>/<uuid>.jsonl: subagent transcripts nest deeper.
        const rel = f.path.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]/);
        return rel.length === 2 && isUuid(f.name.slice(0, -6)) && !liveIds.has(f.name.slice(0, -6));
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, HISTORY_FILES);
    const out: ClosedView[] = [];
    for (const f of files) {
      const t = await this.reader.read(f.path, { size: f.size, mtimeMs: f.mtimeMs, dir: false });
      if (!t.hasTranscript || !t.title) continue; // opened and closed without a message
      if (t.entrypoint && t.entrypoint.startsWith('sdk')) continue; // automation, not a chat
      const sessionId = f.name.slice(0, -6);
      const cwd = t.cwd || '';
      out.push({
        id: sessionId,
        sessionId,
        cwd,
        entrypoint: t.entrypoint,
        displayTitle: t.title,
        title: t.title,
        project: cwd ? projectName(cwd) : '',
        model: formatModel(t.model),
        closedAt: t.lastTimestampMs ?? f.mtimeMs,
        source: 'history',
      });
    }
    this.reader.prune(new Set(files.map((f) => f.path)));
    void this.now;
    return out;
  }
}
