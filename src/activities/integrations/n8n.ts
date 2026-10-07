// n8n: a workflow execution that fails (and, if you ask for it, one that succeeds), with the
// failing node and its message. The poll (src-tauri/src/integrations.rs) calls your own n8n
// instance with an API key from the Credential Manager, so the instance URL is a setting here.

import { agoText, clip } from '../../core/format';
import type { Tone } from '../../core/segments';
import type { SheetRow } from '../../core/sheet';
import { IntegrationActivity, type TileContent } from './base';
import { isRecent, MINUTE, oneLine, parseTime, type Change, type Glance } from './util';

export interface Execution {
  id: string;
  status: string;
  workflowId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** Only the newest finished and failed executions are named. */
  workflow?: string;
  /** The failing node and its message, or where the data ended up. */
  note?: string | null;
}

export interface N8nSnapshot {
  /** Newest first. */
  executions: Execution[];
  baseUrl: string;
}

export type ExecState = 'ok' | 'failed' | 'running' | 'stopped';

/** An execution that shows up already finished is news only when it finished lately. */
const RECENT_MS = 5 * MINUTE;

export function execState(status: string): ExecState {
  switch (status) {
    case 'success':
      return 'ok';
    case 'error':
    case 'crashed':
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'stopped';
    default:
      return 'running'; // running, waiting, new
  }
}

export function executionUrl(baseUrl: string, e: Execution): string {
  return e.workflowId ? `${baseUrl}/workflow/${encodeURIComponent(e.workflowId)}/executions/${encodeURIComponent(e.id)}` : `${baseUrl}/executions`;
}

const nameOf = (e: Execution) => e.workflow || 'Workflow';

/** Executions that finished since the last poll. Successes only count when `showSuccess` is on. */
export function compareN8n(prev: N8nSnapshot, next: N8nSnapshot, now: number, showSuccess: boolean): Change[] {
  const before = new Map(prev.executions.map((e) => [e.id, e]));
  const changes: Change[] = [];
  for (const e of next.executions) {
    const state = execState(e.status);
    if (state !== 'failed' && !(state === 'ok' && showSuccess)) continue;
    const was = before.get(e.id);
    const finishedNow = was ? execState(was.status) === 'running' : isRecent(e.stoppedAt ?? e.startedAt, now, RECENT_MS);
    if (!finishedNow) continue;
    const url = executionUrl(next.baseUrl, e);
    changes.push(
      state === 'failed'
        ? { key: `n8n:${e.id}:failed`, tone: 'bad', icon: 'code', title: `${nameOf(e)} failed`, detail: clip(oneLine(e.note), 80) || undefined, url }
        : { key: `n8n:${e.id}:ok`, tone: 'good', icon: 'code', title: `${nameOf(e)} ran`, detail: clip(oneLine(e.note), 80) || undefined, url, level: 'compact' },
    );
  }
  return changes;
}

const TONE: Record<ExecState, Tone> = { ok: 'good', failed: 'bad', running: 'info', stopped: 'muted' };
const WORD: Record<ExecState, string> = { ok: 'ran', failed: 'failed', running: 'running', stopped: 'stopped' };

export function n8nGlance(s: N8nSnapshot): Glance | null {
  const e = s.executions[0];
  if (!e) return null;
  const state = execState(e.status);
  return { icon: 'code', tone: TONE[state], title: `${nameOf(e)} ${WORD[state]}`, detail: clip(oneLine(e.note), 80) || undefined, url: executionUrl(s.baseUrl, e) };
}

export function n8nTile(s: N8nSnapshot, now: number): TileContent {
  const rows: SheetRow[] = s.executions.slice(0, 3).map((e) => {
    const state = execState(e.status);
    const at = parseTime(e.stoppedAt ?? e.startedAt);
    return {
      key: e.id,
      dot: TONE[state],
      pulse: state === 'running',
      title: e.workflow || `Execution ${e.id}`,
      detail: [WORD[state], at === null ? '' : agoText(now - at)].filter(Boolean).join(' · '),
      action: 'open',
      arg: executionUrl(s.baseUrl, e),
      tip: oneLine(e.note) || undefined,
    };
  });
  const failing = s.executions[0] && execState(s.executions[0].status) === 'failed';
  return { span: 2, rows: 2, tone: failing ? 'bad' : 'muted', body: { k: 'list', icon: 'code', label: 'n8n', rows, empty: 'No executions yet' } };
}

export class N8nActivity extends IntegrationActivity<N8nSnapshot> {
  constructor() {
    super('n8n', { secret: 'n8n.key', everyMs: 15_000, home: 'https://n8n.io' });
  }

  /** The instance address, tidied the way the poller tidies it. */
  private instance(): string {
    const url = this.ctx.options<{ url?: string }>().url;
    return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  }

  protected override pollOptions(): Record<string, unknown> {
    return { url: this.instance() };
  }

  /** Links into the user's own instance may be plain http, as a home server often is. */
  protected override origin(): string | undefined {
    return this.instance() || undefined;
  }

  protected override landing(): string {
    return this.instance() || 'https://n8n.io';
  }

  protected compare(prev: N8nSnapshot, next: N8nSnapshot, now: number): Change[] {
    return compareN8n(prev, next, now, this.ctx.options<{ showSuccess?: boolean }>().showSuccess === true);
  }

  protected headline(s: N8nSnapshot): Glance | null {
    return n8nGlance(s);
  }

  protected tileFor(s: N8nSnapshot, now: number): TileContent {
    return n8nTile(s, now);
  }
}
