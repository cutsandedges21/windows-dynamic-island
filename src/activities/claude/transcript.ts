// Transcript reading, ported from Usage Clip's transcript.js. The newest turn's
// state comes from the file's tail (re-parsed only when it grows); title and
// permission mode come from an incremental scan that Rust runs from the last
// offset (fsx.rs: claude_transcript_meta), so only small results cross IPC.

import { native, type FileStat } from '../../core/native';
import type { EntryKind } from './status';

const TAIL_ESCALATION = [262144, 262144 * 8, 262144 * 64];
const TITLE_MAX = 80;
const SYNTHETIC_MODEL = '<synthetic>';
const INTERRUPT_MARKER = '[Request interrupted by user';
const LOCAL_COMMAND_MARKERS = ['<local-command-stdout>', '<local-command-stderr>'];
const TURN_TYPES = new Set(['assistant', 'user', 'system']);
const HOUSEKEEPING_COMMANDS = new Set(['/clear']);

const WRAPPER_TAGS = [
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'system-reminder', 'ide_opened_file', 'ide_selection', 'ide_diagnostics',
  'command-name', 'command-message', 'command-args', 'command-contents',
];
const WRAPPER_RE = new RegExp(WRAPPER_TAGS.map((t) => `<${t}>[\\s\\S]*?</${t}>`).join('|'), 'g');
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

type Json = Record<string, unknown>;

function load(line: string): Json | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

function leadingText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as Json).type === 'text') return typeof (b as Json).text === 'string' ? ((b as Json).text as string) : null;
    }
  }
  return null;
}

function startsWithAny(content: unknown, prefixes: string[]): boolean {
  const text = leadingText(content);
  if (typeof text !== 'string') return false;
  const s = text.trimStart();
  return prefixes.some((p) => s.startsWith(p));
}

function parseTimestamp(ts: unknown): number | null {
  if (typeof ts !== 'string' || !ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

export interface TailState {
  lastToolId: string | null;
  lastToolName: string | null;
  /** Island addition: the newest tool call's input, to say what Claude is doing. */
  lastToolInput: unknown;
  lastStopReason: string | null;
  lastTimestamp: string | null;
  lastTimestampMs: number | null;
  lastEntryKind: EntryKind | null;
  apiErrorKind: string | null;
  apiErrorStatus: number | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  entrypoint: string | null;
  anyParsed: boolean;
  pendingTool: boolean;
  /** Island addition: when the current turn's prompt was sent. */
  turnStartMs: number | null;
  /** Island addition: the newest assistant text, for "what it did". */
  lastAssistantText: string | null;
}

/** Status state from a window of lines (the tail). */
export function parseLines(lines: string[]): TailState {
  const resolved = new Set<string>();
  const st: TailState = {
    lastToolId: null, lastToolName: null, lastToolInput: null, lastStopReason: null, lastTimestamp: null, lastTimestampMs: null,
    lastEntryKind: null, apiErrorKind: null, apiErrorStatus: null, model: null, version: null, gitBranch: null, cwd: null,
    entrypoint: null, anyParsed: false, pendingTool: false, turnStartMs: null, lastAssistantText: null,
  };

  for (const line of lines) {
    const entry = load(line);
    if (!entry) continue;
    st.anyParsed = true;
    if (entry.isSidechain === true || entry.isMeta === true) continue;

    const type = entry.type;
    if (typeof entry.timestamp === 'string' && TURN_TYPES.has(type as string)) st.lastTimestamp = entry.timestamp;
    if (typeof entry.version === 'string' && entry.version) st.version = entry.version;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) st.gitBranch = entry.gitBranch;
    if (typeof entry.cwd === 'string' && entry.cwd) st.cwd = entry.cwd;
    if (typeof entry.entrypoint === 'string' && entry.entrypoint) st.entrypoint = entry.entrypoint;

    const message = entry.message && typeof entry.message === 'object' ? (entry.message as Json) : null;
    const content = message ? message.content : null;

    if (type === 'assistant' && message) {
      if (entry.isApiErrorMessage === true) {
        st.lastEntryKind = 'api_error';
        st.lastStopReason = (message.stop_reason as string) ?? null;
        st.apiErrorKind = typeof entry.error === 'string' && entry.error ? entry.error : null;
        const status = entry.apiErrorStatus;
        st.apiErrorStatus = Number.isInteger(status)
          ? (status as number)
          : typeof status === 'string' && /^\s*\d+\s*$/.test(status)
            ? parseInt(status, 10)
            : null;
      } else {
        st.lastEntryKind = 'assistant';
        st.apiErrorKind = null;
        st.apiErrorStatus = null;
        st.lastStopReason = (message.stop_reason as string) ?? null;
        if (typeof message.model === 'string' && message.model && message.model !== SYNTHETIC_MODEL) st.model = message.model;
        if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            const block = b as Json;
            if (block.type === 'tool_use') {
              st.lastToolId = (block.id as string) ?? null;
              st.lastToolName = (block.name as string) ?? null;
              st.lastToolInput = block.input ?? null;
            } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              texts.push(block.text.trim());
            }
          }
          if (texts.length) st.lastAssistantText = clip(texts.join(' ').replace(/\s+/g, ' '), 240);
        }
      }
    } else if (type === 'user') {
      const isInterrupt = startsWithAny(content, [INTERRUPT_MARKER]);
      const isLocal = !isInterrupt && startsWithAny(content, LOCAL_COMMAND_MARKERS);
      st.lastEntryKind = isInterrupt ? 'user_interrupt' : isLocal ? 'local_command' : 'user_text';
      st.apiErrorKind = null;
      st.apiErrorStatus = null;
      let toolResult = false;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === 'object' && (b as Json).type === 'tool_result') {
            toolResult = true;
            if (!isInterrupt && !isLocal) st.lastEntryKind = 'tool_result';
            const id = (b as Json).tool_use_id;
            if (typeof id === 'string') resolved.add(id);
          }
        }
      }
      if (st.lastEntryKind === 'user_text' && !toolResult) st.turnStartMs = parseTimestamp(entry.timestamp) ?? st.turnStartMs;
    } else if (type === 'system' && entry.subtype === 'local_command') {
      st.lastEntryKind = 'local_command';
      st.apiErrorKind = null;
      st.apiErrorStatus = null;
    }
  }

  st.pendingTool = st.lastToolId != null && !resolved.has(st.lastToolId);
  st.lastTimestampMs = parseTimestamp(st.lastTimestamp);
  return st;
}

/** Display text of a prompt: [text, isHousekeeping]. Works on the prompt's leading text. */
export function promptText(text: string | null): [string | null, boolean] {
  if (typeof text !== 'string') return [null, false];
  const cmd = COMMAND_NAME_RE.exec(text);
  if (cmd && cmd[1].trim()) {
    const name = cmd[1].trim();
    const argsMatch = COMMAND_ARGS_RE.exec(text);
    const args = argsMatch ? argsMatch[1].split(/\s+/).filter(Boolean).join(' ') : '';
    return [clip(args ? `${name} ${args}` : name, TITLE_MAX), HOUSEKEEPING_COMMANDS.has(name)];
  }
  const cleaned = text.replace(WRAPPER_RE, '').split(/\s+/).filter(Boolean).join(' ');
  if (!cleaned) return [null, false];
  return [clip(cleaned, TITLE_MAX), false];
}

/** Usage Clip's promptDisplay(entry), for tests and parity: tool results have no prompt. */
export function promptDisplay(entry: Json): [string | null, boolean] {
  const message = entry.message && typeof entry.message === 'object' ? (entry.message as Json) : null;
  const content = message ? message.content : null;
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if ((b as Json).type === 'tool_result') return [null, false];
      if (text === null && (b as Json).type === 'text') text = (b as Json).text as string;
    }
  }
  return promptText(text);
}

interface Scan {
  consumed: number;
  aiTitle: string | null;
  customTitle: string | null;
  firstPrompt: string | null;
  firstCommand: string | null;
  permissionMode: string | null;
}

const newScan = (): Scan => ({ consumed: 0, aiTitle: null, customTitle: null, firstPrompt: null, firstCommand: null, permissionMode: null });

export function scanTitle(scan: Pick<Scan, 'customTitle' | 'aiTitle' | 'firstPrompt' | 'firstCommand'>): string | null {
  return scan.customTitle || scan.aiTitle || scan.firstPrompt || scan.firstCommand || null;
}

export interface TranscriptInfo {
  hasTranscript: boolean;
  lastEntryKind: EntryKind | null;
  lastStopReason: string | null;
  pendingTool: boolean;
  lastToolName: string | null;
  lastToolInput: unknown;
  lastTimestampMs: number | null;
  apiErrorKind: string | null;
  apiErrorStatus: number | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  entrypoint: string | null;
  title: string | null;
  permissionMode: string | null;
  mtimeMs: number;
  turnStartMs: number | null;
  lastAssistantText: string | null;
}

const NONE: TranscriptInfo = {
  hasTranscript: false, lastEntryKind: null, lastStopReason: null, pendingTool: false, lastToolName: null, lastToolInput: null,
  lastTimestampMs: null, apiErrorKind: null, apiErrorStatus: null, model: null, version: null, gitBranch: null, cwd: null,
  entrypoint: null, title: null, permissionMode: null, mtimeMs: 0, turnStartMs: null, lastAssistantText: null,
};

export class TranscriptReader {
  private cache = new Map<string, { size: number; tail: TailState | null; scan: Scan }>();

  async read(file: string | null, stat: FileStat | null): Promise<TranscriptInfo> {
    if (!file || !stat) return NONE;
    let c = this.cache.get(file);
    if (!c) {
      c = { size: -1, tail: null, scan: newScan() };
      this.cache.set(file, c);
    }
    if (stat.size !== c.size) {
      if (stat.size < c.scan.consumed) c.scan = newScan();
      const scan = c.scan;
      const meta = await native.transcriptMeta(file, scan.consumed, scan.firstPrompt === null);
      if (meta) {
        if (meta.aiTitle) scan.aiTitle = meta.aiTitle;
        if (meta.customTitle) scan.customTitle = meta.customTitle;
        if (meta.permissionMode) scan.permissionMode = meta.permissionMode;
        if (scan.firstPrompt === null) {
          for (const raw of meta.userTexts) {
            const [text, housekeeping] = promptText(raw);
            if (!text) continue;
            if (housekeeping) {
              if (scan.firstCommand === null) scan.firstCommand = text;
            } else {
              scan.firstPrompt = text;
              break;
            }
          }
        }
        scan.consumed = meta.consumed;
      }
      let tail: TailState | null = null;
      for (const max of TAIL_ESCALATION) {
        const t = await native.readTail(file, max);
        if (!t) break;
        tail = parseLines(t.lines);
        if (tail.anyParsed || t.size <= max) break;
      }
      if (tail) c.tail = tail;
      else if (!c.tail) return NONE;
      c.size = stat.size;
    }
    const t = c.tail;
    return {
      hasTranscript: true,
      lastEntryKind: t?.lastEntryKind ?? null,
      lastStopReason: t?.lastStopReason ?? null,
      pendingTool: Boolean(t?.pendingTool),
      lastToolName: t?.lastToolName ?? null,
      lastToolInput: t?.lastToolInput ?? null,
      lastTimestampMs: t?.lastTimestampMs ?? null,
      apiErrorKind: t?.apiErrorKind ?? null,
      apiErrorStatus: t?.apiErrorStatus ?? null,
      model: t?.model ?? null,
      version: t?.version ?? null,
      gitBranch: t?.gitBranch ?? null,
      cwd: t?.cwd ?? null,
      entrypoint: t?.entrypoint ?? null,
      title: scanTitle(c.scan),
      permissionMode: c.scan.permissionMode,
      mtimeMs: stat.mtimeMs,
      turnStartMs: t?.turnStartMs ?? null,
      lastAssistantText: t?.lastAssistantText ?? null,
    };
  }

  prune(active: Set<string>): void {
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
  }
}
