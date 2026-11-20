// Cursor's agent chats for the island. Hooks say what happens the moment it happens (a request
// sent, Cursor's answer, a turn ending, the chat closing), with the Cursor process that runs
// the chat (the hook's grandparent: island-hook ← powershell ← Cursor). Cursor's transcripts
// (transcript.ts) fill in the rest and remember chats from before Island started or without
// hooks: titles, last answers, what it ran. A chat lives in Cursor's window: it is open while
// that Cursor runs, and closed when Cursor says so (sessionEnd) or its process is gone.

import { clip } from '../../core/format';
import { native, type CursorEnv, type CursorTranscript } from '../../core/native';
import type { AgentTracker } from '../agent/engine';
import type { HookEvent } from '../claude/hooks';
import { ProcessProbe } from '../claude/procinfo';
import { projectName, statusLabel, statusTone, type Status } from '../claude/status';
import type { ClosedView, SessionView, TrackerEvent } from '../claude/tracker';
import { folderOf, parseLines, summarize, type TranscriptSummary } from './transcript';

/** Transcripts written this recently are read; older ones are history Island doesn't need. */
const FILES_MAX_AGE_MS = 2 * 86_400_000;
/** The transcript folders are listed this often (hooks name a live chat's file at once). */
const LIST_EVERY_MS = 10_000;
/** Without hooks, a chat whose transcript moved this recently counts as open (while Cursor runs). */
const RECENT_MS = 10 * 60_000;
/** Closed chats are listed this long. */
const CLOSED_MS = 24 * 3_600_000;
/** A hook-live chat whose Cursor process is unknown stays open this long after its last hook. */
const HOOK_IDLE_MS = 30 * 60_000;
/** At most this many transcripts are read per poll; the rest wait for the next. */
const READS_PER_POLL = 8;
/** Transcripts past this size aren't read (Island would only show their last lines anyway). */
const READ_MAX = 4 * 1024 * 1024;
const CURSOR_EXE = 'cursor.exe';
/** A Mac: Cursor's processes carry its bundle's name (mac/procs.rs). */
const CURSOR_APP = 'cursor.app';

/** The events Island's Cursor hooks send (Cursor's own names). */
export type CursorEvent = 'sessionStart' | 'sessionEnd' | 'beforeSubmitPrompt' | 'afterAgentResponse' | 'stop' | 'beforeShellExecution' | 'beforeMCPExecution';

/** A Cursor hook event as it arrives: Cursor's fields on top of the relay's. */
export interface CursorHook extends HookEvent {
  conversation_id?: string;
  workspace_roots?: string[];
  cursor_version?: string;
  status?: string;
  reason?: string;
  text?: string;
  command?: string;
  mcp_server_name?: string;
}

/** What hooks said about a chat. */
interface Live {
  sessionId: string;
  pid: number;
  /** The hook's grandparent and parent: Cursor is the first named Cursor.exe (normally the grandparent, under PowerShell). */
  candidates: number[];
  cwd: string;
  transcript: string | null;
  lastHookAt: number;
  turnOpen: boolean;
  turnStartMs: number | null;
  aborted: boolean;
  errored: boolean;
  prompt: string | null;
  lastAssistant: string | null;
  ended: boolean;
  model: string | null;
}

interface FileState {
  path: string;
  size: number;
  mtimeMs: number;
  folder: string | null;
  summary: TranscriptSummary | null;
}

export class CursorTracker implements AgentTracker {
  readonly probe = new ProcessProbe();
  private readonly live = new Map<string, Live>();
  /** Transcripts by chat id. */
  private readonly files = new Map<string, FileState>();
  private listedAt = 0;
  private sessions: SessionView[] = [];
  private closed: ClosedView[] = [];
  private wasLive = new Map<string, SessionView>();

  constructor(private readonly env: CursorEnv) {}

  // ---------------------------------------------------------------- hooks

  /** The chat a hook belongs to: Cursor sends its id as conversation_id (and session_id). */
  static chatOf(ev: CursorHook): string {
    return (ev.conversation_id || ev.session_id || '').toLowerCase();
  }

  /** A Cursor hook event, before the engine handles it: the chat is live at once. */
  noteHook(ev: CursorHook, now = Date.now()): void {
    const sid = CursorTracker.chatOf(ev);
    if (!sid) return;
    let l = this.live.get(sid);
    if (!l) {
      l = { sessionId: sid, pid: 0, candidates: [], cwd: '', transcript: null, lastHookAt: now, turnOpen: false, turnStartMs: null, aborted: false, errored: false, prompt: null, lastAssistant: null, ended: false, model: null };
      this.live.set(sid, l);
    }
    l.lastHookAt = now;
    const folder = folderOf(ev.workspace_roots?.[0]);
    if (folder) l.cwd = folder;
    else if (!l.cwd && ev.cwd) l.cwd = ev.cwd;
    if (typeof ev.transcript_path === 'string' && ev.transcript_path) l.transcript = ev.transcript_path;
    const candidates = [Number(ev.hook_gppid), Number(ev.hook_ppid)].filter((pid) => pid > 0);
    if (candidates.length) {
      l.candidates = candidates;
      l.pid = candidates[0];
    }
    if (ev.model && ev.model !== 'unknown' && ev.model !== 'default') l.model = ev.model;
    switch (ev.hook_event_name as CursorEvent) {
      case 'sessionStart':
        l.ended = false;
        break;
      case 'beforeSubmitPrompt':
        l.ended = false;
        l.turnOpen = true;
        l.aborted = false;
        l.errored = false;
        l.turnStartMs = now;
        if (ev.prompt?.trim()) l.prompt = clip(ev.prompt.replace(/\s+/g, ' ').trim(), 300);
        break;
      case 'beforeShellExecution':
      case 'beforeMCPExecution':
        if (!l.turnOpen) {
          l.turnOpen = true;
          l.turnStartMs = l.turnStartMs ?? now;
        }
        break;
      case 'afterAgentResponse':
        if (ev.text?.trim() && ev.text.trim() !== '[REDACTED]') l.lastAssistant = ev.text.trim();
        break;
      case 'stop':
        l.turnOpen = false;
        l.aborted = ev.status === 'aborted';
        l.errored = ev.status === 'error';
        break;
      case 'sessionEnd':
        l.ended = true;
        l.turnOpen = false;
        break;
    }
  }

  /** What Cursor said last in a chat (its afterAgentResponse, else its transcript). */
  lastWords(id: string): string | null {
    return this.live.get(id)?.lastAssistant ?? this.files.get(id)?.summary?.lastAssistant ?? null;
  }

  // ---------------------------------------------------------------- polling

  async poll(now = Date.now()): Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }> {
    this.probe.load(await native.procSnapshot());
    for (const l of this.live.values()) l.pid = l.candidates.find((pid) => this.isCursor(pid)) ?? l.pid;
    await this.readFiles(now);
    const cursorRuns = [...this.probe.table.values()].some((p) => p.name.toLowerCase() === CURSOR_EXE || p.name.toLowerCase() === CURSOR_APP);
    const sessions: SessionView[] = [];
    const closed: ClosedView[] = [];
    for (const id of new Set([...this.live.keys(), ...this.files.keys()])) {
      const l = this.live.get(id) ?? null;
      const f = this.files.get(id) ?? null;
      // A chat Cursor opened but nobody wrote in yet (every new Cursor window has one) isn't a chat yet.
      if (!l?.prompt && !f?.summary?.lastPrompt) continue;
      const s = this.view(id, l, f, now);
      if (this.isLive(l, f, cursorRuns, now)) sessions.push(s);
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
        // Hooks announce their own chats; this is for chats seen only in their transcripts.
        events.push({ type: 'finished', session: after });
      }
    }
    this.wasLive = nowLive;
    this.sessions = sessions;
    this.closed = closed;
    return { sessions, closed, events };
  }

  private isLive(l: Live | null, f: FileState | null, cursorRuns: boolean, now: number): boolean {
    if (l) {
      if (l.ended) return false;
      if (l.pid > 0) return this.probe.table.has(l.pid);
      return now - l.lastHookAt < HOOK_IDLE_MS;
    }
    return cursorRuns && f !== null && now - f.mtimeMs < RECENT_MS;
  }

  /** Lists the transcripts now and then; reads the ones that moved, and the ones hooks point at. */
  private async readFiles(now: number): Promise<void> {
    if (now - this.listedAt >= LIST_EVERY_MS || [...this.live.values()].some((l) => l.transcript && !this.files.has(l.sessionId))) {
      this.listedAt = now;
      const listed: CursorTranscript[] = await native.cursorTranscripts(FILES_MAX_AGE_MS);
      for (const t of listed) {
        const id = t.id.toLowerCase();
        const known = this.files.get(id);
        if (known) {
          if (known.size !== t.size) known.summary = null;
          Object.assign(known, { path: t.path, size: t.size, mtimeMs: t.mtimeMs, folder: t.folder ?? known.folder });
        } else this.files.set(id, { path: t.path, size: t.size, mtimeMs: t.mtimeMs, folder: t.folder, summary: null });
      }
    }
    // A live chat's transcript changes with every message: look at its size each poll.
    const liveFiles = [...this.live.values()].map((l) => (l.transcript ? { id: l.sessionId, path: l.transcript } : null)).filter((x): x is { id: string; path: string } => x !== null);
    if (liveFiles.length) {
      const stats = await native.statMany(liveFiles.map((x) => x.path));
      liveFiles.forEach(({ id, path }, i) => {
        const st = stats[i];
        if (!st) return;
        const known = this.files.get(id);
        if (!known) this.files.set(id, { path, size: st.size, mtimeMs: st.mtimeMs, folder: null, summary: null });
        else if (known.size !== st.size) Object.assign(known, { size: st.size, mtimeMs: st.mtimeMs, summary: null });
      });
    }
    let reads = 0;
    for (const f of this.files.values()) {
      if (f.summary || reads >= READS_PER_POLL) continue;
      reads++;
      const text = f.size <= READ_MAX ? await native.readText(f.path, READ_MAX) : null;
      f.summary = summarize(parseLines(text ?? ''));
    }
  }

  // ---------------------------------------------------------------- views

  private view(id: string, l: Live | null, f: FileState | null, now: number): SessionView {
    const sum = f?.summary ?? null;
    // Whichever spoke last knows best whether a turn runs: a hook, or the transcript.
    const hookNewer = l !== null && (!f || l.lastHookAt >= f.mtimeMs);
    const turnOpen = hookNewer ? l!.turnOpen : (sum?.turnOpen ?? false);
    const aborted = hookNewer ? l!.aborted : false;
    const errored = hookNewer ? l!.errored : (sum?.error ?? false);
    const status: Status = turnOpen ? 'working' : aborted ? 'interrupted' : errored ? 'errored' : 'awaiting_input';
    const cwd = l?.cwd || f?.folder || '';
    const title = sum?.title ?? l?.prompt ?? null;
    const lastActivityMs = Math.max(l?.lastHookAt ?? 0, f?.mtimeMs ?? 0);
    return {
      id, sessionId: id, pid: l?.pid ?? 0, cwd, name: '', kind: 'interactive', entrypoint: 'cursor',
      alive: true, status, label: statusLabel(status), tone: statusTone(status), needsYou: false,
      title, displayTitle: title ?? (cwd ? projectName(cwd) : 'Cursor chat'), project: cwd ? projectName(cwd) : '',
      host: 'Cursor', editorHost: 'Cursor', hostKind: 'editor', model: l?.model ?? null, permissionMode: null,
      gitBranch: null, lastActivityMs, lastAliveAt: now, slot: null, tool: null,
      operation: turnOpen && sum?.lastTool ? sum.lastTool : null,
      turnStartMs: turnOpen ? (l?.turnStartMs ?? null) : null,
      lastAssistantText: (hookNewer ? l!.lastAssistant : null) ?? sum?.lastAssistant ?? l?.lastAssistant ?? null,
      transcript: f?.path ?? l?.transcript ?? null, version: null, context: null, turns: [],
    };
  }

  // ---------------------------------------------------------------- lookups

  get(id: string): SessionView | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  getClosed(id: string): ClosedView | null {
    return this.closed.find((c) => c.id === id) ?? null;
  }

  /** The transcript of a chat, for reading its messages. */
  transcriptOf(id: string): string | null {
    return this.live.get(id)?.transcript ?? this.files.get(id)?.path ?? null;
  }

  /** Is this a Cursor.exe Island knows? */
  isCursor(pid: number): boolean {
    const name = (this.probe.processName(pid) ?? '').toLowerCase();
    return name === CURSOR_EXE || name === CURSOR_APP;
  }

  /** The Cursor program, for bringing a folder's window up. */
  get exe(): string | null {
    return this.env.cursorExe;
  }
}

function closedView(s: SessionView): ClosedView {
  return {
    id: s.id, sessionId: s.sessionId, cwd: s.cwd, entrypoint: s.entrypoint, kind: s.kind, displayTitle: s.displayTitle, title: s.title,
    project: s.project, host: s.host, editorHost: s.editorHost, model: s.model, closedAt: s.lastActivityMs, source: 'history',
  };
}
