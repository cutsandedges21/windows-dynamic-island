// Session status classification, ported from Usage Clip's status.js (itself
// from agent-monitor-for-claude, MIT): classify, refineWithNative,
// pendingBlockReason, turnPredatesProcess, labels and model names.

const DIALOG_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const PROMPTING_MODES = new Set(['default', 'acceptEdits']);
const AUTO_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// Subagent tools run inside the session process and never prompt, so a pending
// one is work, not a permission dialog.
const IN_PROCESS_TOOLS = new Set(['Task', 'Agent']);
const STALLED_PENDING_SECONDS = 300;
const AUTO_STALLED_PENDING_SECONDS = 90;
const PROCESS_START_SLACK_SECONDS = 5;

export type Status = 'awaiting_permission' | 'working' | 'awaiting_input' | 'interrupted' | 'errored' | 'new' | 'completed' | 'unknown';
export type EntryKind = 'assistant' | 'api_error' | 'user_interrupt' | 'local_command' | 'user_text' | 'tool_result';

export interface RawStatus {
  alive: boolean;
  hasTranscript: boolean;
  hasActivity?: boolean;
  lastEntryKind?: EntryKind | null;
  lastStopReason?: string | null;
  pendingTool?: boolean;
  lastToolName?: string | null;
  permissionMode?: string | null;
  apiErrorKind?: string | null;
  apiErrorStatus?: number | null;
  childCount?: number;
  nativeStatus?: string | null;
  waitingFor?: string | null;
  ageSeconds?: number | null;
  processAgeSeconds?: number | null;
}

export function pendingIsBlocking(toolName: string | null | undefined, mode: string | null | undefined): boolean {
  if (toolName && DIALOG_TOOLS.has(toolName)) return true;
  if (!mode || !PROMPTING_MODES.has(mode)) return false;
  if (mode === 'acceptEdits') return !AUTO_EDIT_TOOLS.has(toolName ?? '');
  return true;
}

function stalledWindow(mode: string | null | undefined): number {
  return mode === 'auto' ? AUTO_STALLED_PENDING_SECONDS : STALLED_PENDING_SECONDS;
}

/** Why a pending tool_use blocks the user ('dialog' | 'prompt' | 'stalled'), or null. */
export function pendingBlockReason(raw: RawStatus): 'dialog' | 'prompt' | 'stalled' | null {
  if (!raw.pendingTool) return null;
  if (raw.lastToolName && DIALOG_TOOLS.has(raw.lastToolName)) return 'dialog';
  if ((raw.childCount || 0) > 0 || (raw.lastToolName && IN_PROCESS_TOOLS.has(raw.lastToolName))) return null;
  if (pendingIsBlocking(raw.lastToolName, raw.permissionMode)) return 'prompt';
  const age = Number(raw.ageSeconds);
  return Number.isFinite(age) && age >= stalledWindow(raw.permissionMode) ? 'stalled' : null;
}

/** The newest turn was written before the current process started (session reopened). */
export function turnPredatesProcess(raw: RawStatus): boolean {
  if (!raw.hasActivity) return false;
  const age = raw.ageSeconds == null ? NaN : Number(raw.ageSeconds);
  const processAge = raw.processAgeSeconds == null ? NaN : Number(raw.processAgeSeconds);
  return Number.isFinite(age) && Number.isFinite(processAge) && age - processAge > PROCESS_START_SLACK_SECONDS;
}

export function classify(raw: RawStatus & { pendingBlocking?: boolean; turnPredatesProcess?: boolean }): Status {
  if (!raw.alive) return 'completed';
  if (!raw.hasTranscript) return 'new';
  if (raw.lastEntryKind === 'user_interrupt') return 'interrupted';
  if (raw.lastEntryKind === 'api_error') return 'errored';
  if (raw.turnPredatesProcess) return 'awaiting_input';
  if (raw.pendingTool) return raw.pendingBlocking ? 'awaiting_permission' : 'working';
  if (raw.lastEntryKind === 'assistant' && raw.lastStopReason === 'end_turn') return 'awaiting_input';
  if (raw.lastEntryKind === 'local_command') return 'awaiting_input';
  if (raw.lastEntryKind === 'user_text' || raw.lastEntryKind === 'tool_result') return 'working';
  if (raw.lastEntryKind === 'assistant') return 'working';
  if (raw.hasActivity || raw.lastStopReason != null) return 'awaiting_input';
  return 'unknown';
}

export function refineWithNative(status: Status, nativeStatus: string | null | undefined, waitingFor: string | null | undefined): Status {
  if (status === 'awaiting_permission' || status === 'interrupted' || status === 'errored' || nativeStatus == null) return status;
  if (nativeStatus === 'busy' && status !== 'new') return 'working';
  if (nativeStatus === 'waiting' && waitingFor && status !== 'new') return 'awaiting_permission';
  if (nativeStatus === 'idle' && status !== 'new') return 'awaiting_input';
  return status;
}

export function deriveStatus(raw: RawStatus): Status {
  let status = classify({
    alive: raw.alive,
    hasTranscript: raw.hasTranscript,
    lastEntryKind: raw.lastEntryKind,
    lastStopReason: raw.lastStopReason,
    pendingTool: raw.pendingTool,
    pendingBlocking: pendingBlockReason(raw) !== null,
    hasActivity: raw.hasActivity,
    turnPredatesProcess: turnPredatesProcess(raw),
  });
  if (raw.alive) status = refineWithNative(status, raw.nativeStatus, raw.waitingFor);
  return status;
}

export const LABELS: Record<Status, string> = {
  awaiting_permission: 'Needs you',
  working: 'Working',
  awaiting_input: 'Your turn',
  interrupted: 'Stopped',
  errored: 'Error',
  new: 'New',
  completed: 'Closed',
  unknown: 'Idle',
};

const TONES: Partial<Record<Status, string>> = {
  awaiting_permission: 'needs',
  working: 'working',
  awaiting_input: 'turn',
  errored: 'error',
};

function isUsageLimitError(raw: RawStatus): boolean {
  const kind = typeof raw.apiErrorKind === 'string' ? raw.apiErrorKind.trim().toLowerCase() : '';
  return raw.apiErrorStatus === 429 || kind === 'rate_limit' || kind === 'rate_limit_error';
}

export function statusLabel(status: Status, raw: RawStatus = { alive: false, hasTranscript: false }): string {
  if (status === 'errored' && isUsageLimitError(raw)) return 'Hit limit';
  return LABELS[status] || 'Idle';
}

/** Usage Clip's tone names: needs | working | turn | error | muted. */
export function statusTone(status: Status): string {
  return TONES[status] || 'muted';
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5". */
export function formatModel(id: string | null | undefined): string | null {
  if (!id || typeof id !== 'string') return null;
  let base = id;
  let bracket = '';
  if (base.endsWith(']') && base.includes('[')) {
    const open = base.lastIndexOf('[');
    bracket = ' ' + base.slice(open + 1, -1).toUpperCase();
    base = base.slice(0, open);
  }
  if (base.startsWith('claude-')) base = base.slice(7);
  const words: string[] = [];
  const numbers: string[] = [];
  for (const part of base.split('-')) {
    if (/^[a-zA-Z]+$/.test(part)) words.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
    else if (/^\d+$/.test(part) && part.length < 4) numbers.push(part);
  }
  if (!words.length) return id;
  return words.join(' ') + (numbers.length ? ' ' + numbers.join('.') : '') + bracket;
}

// ------------------------------------------------------------------ paths

const NON_ALNUM = /[^A-Za-z0-9]/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Every non-alphanumeric char becomes one hyphen; runs are never collapsed. */
export function cwdToSlug(cwd: string): string {
  return String(cwd).replace(NON_ALNUM, '-');
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function projectName(cwd: string | null | undefined): string {
  const parts = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || String(cwd || '');
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\');
}

// ------------------------------------------------------------------ what Claude is doing

/** A short, human description of a tool call: "Running npm test", "Editing App.tsx". */
export function describeTool(tool: string | null | undefined, input: unknown): { verb: string; detail: string | null } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  const base = (p: string | null) => (p ? projectName(p) : null);
  const short = (s: string | null, n = 60) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return { verb: 'Running command', detail: short(str('description') ?? str('command')) };
    case 'BashOutput':
    case 'KillShell':
      return { verb: 'Checking a command', detail: null };
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Editing', detail: base(str('file_path')) };
    case 'Write':
      return { verb: 'Writing', detail: base(str('file_path')) };
    case 'NotebookEdit':
      return { verb: 'Editing notebook', detail: base(str('notebook_path')) };
    case 'Read':
      return { verb: 'Reading', detail: base(str('file_path')) };
    case 'Glob':
    case 'Grep':
      return { verb: 'Searching code', detail: short(str('pattern'), 40) };
    case 'WebSearch':
      return { verb: 'Searching the web', detail: short(str('query'), 50) };
    case 'WebFetch': {
      const url = str('url');
      let host: string | null = null;
      try {
        host = url ? new URL(url).hostname : null;
      } catch {
        host = null;
      }
      return { verb: 'Reading the web', detail: host };
    }
    case 'Task':
    case 'Agent':
      return { verb: 'Running an agent', detail: short(str('description'), 50) };
    case 'TodoWrite':
      return { verb: 'Planning', detail: null };
    case 'AskUserQuestion':
      return { verb: 'Asking you', detail: null };
    case 'ExitPlanMode':
      return { verb: 'Plan ready', detail: null };
    default:
      if (tool && tool.startsWith('mcp__')) {
        const [, server, name] = tool.split('__');
        return { verb: `Using ${server ?? 'a tool'}`, detail: name ?? null };
      }
      return { verb: tool ? `Using ${tool}` : 'Thinking', detail: null };
  }
}
