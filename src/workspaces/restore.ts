// Restoring a workspace: its switched-on items in order (asking first where it should, skipping
// what can't open and saying why, waiting where told), then its windows back in place, as a job
// every window can watch. One job at a time. Only the order and the decisions live here; the
// native side is passed in (RestoreDeps), so the tests drive it with fakes.

import type { LiveWindow, Launched, MonitorInfo, Tried, WinPlaced } from '../core/native';
import type { WorkspaceCheck } from './checks';
import { programNames, planPlacement } from './layout';
import { itemDetail, itemTitle, newId, type AppItem, type Resource, type RestoreRun, type RunOutcome, type StepStatus, type Workspace } from './model';

export type StepState = 'waiting' | 'asking' | 'opening' | 'done' | 'skipped' | 'failed' | 'cancelled';
export type Answer = 'yes' | 'skip' | 'stop';

export interface JobStep {
  /** The item's id, or 'layout' for putting windows back. */
  id: string;
  label: string;
  kind: Resource['kind'] | 'layout';
  state: StepState;
  /** What happened, in words. */
  why: string;
  /** Its path, address or command (shown when it asks). */
  detail: string;
}

export interface Job {
  id: string;
  ws: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  state: 'running' | RunOutcome;
  steps: JobStep[];
  /** The step waiting for a yes. */
  asking: string | null;
}

export interface RestoreDeps {
  check(ws: Workspace): Promise<WorkspaceCheck>;
  launch(item: Resource, ws: Workspace): Promise<Tried<Launched>>;
  openUrl(url: string): Promise<boolean>;
  running(item: AppItem, ws: Workspace): Promise<{ pid: number; hwnd: number | null } | null>;
  focus(hwnd: number): Promise<boolean>;
  windows(): Promise<Tried<LiveWindow[]>>;
  monitors(): Promise<MonitorInfo[]>;
  place(places: Array<{ hwnd: number; rect: { x: number; y: number; width: number; height: number }; state: string }>): Promise<Tried<WinPlaced[]>>;
  ask(job: Job, step: JobStep): Promise<Answer>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** "Explorer" or "Finder". */
  fileManager: string;
}

/** How long apps just started get to show their windows before they're placed. */
export const WINDOW_WAIT_MS = 15000;

const FINAL: StepState[] = ['done', 'skipped', 'failed', 'cancelled'];

export function outcomeOf(steps: JobStep[]): RunOutcome {
  if (steps.some((s) => s.state === 'cancelled')) return 'cancelled';
  const failed = steps.filter((s) => s.state === 'failed').length;
  const tried = steps.filter((s) => s.state !== 'skipped').length;
  if (!failed) return 'done';
  return failed === tried ? 'failed' : 'partial';
}

export function runRecord(job: Job): RestoreRun {
  const status = (s: StepState): StepStatus => (s === 'done' || s === 'skipped' || s === 'failed' ? s : 'cancelled');
  return {
    id: job.id,
    at: job.startedAt,
    ms: Math.max(0, (job.endedAt ?? job.startedAt) - job.startedAt),
    outcome: job.state === 'running' ? 'cancelled' : job.state,
    steps: job.steps.map((s) => ({ resource: s.id, label: s.label, status: status(s.state), why: s.why })),
  };
}

/** One line for a finished job: "All 6 opened", "5 of 6 opened; 1 didn't". */
export function jobSummary(job: Job): string {
  const done = job.steps.filter((s) => s.state === 'done').length;
  const failed = job.steps.filter((s) => s.state === 'failed').length;
  const skipped = job.steps.filter((s) => s.state === 'skipped').length;
  if (job.state === 'running') return `${job.steps.filter((s) => FINAL.includes(s.state)).length} of ${job.steps.length}`;
  if (job.state === 'cancelled') return `Stopped after ${done} of ${job.steps.length}`;
  if (!failed) return skipped ? `${done} opened, ${skipped} skipped` : job.steps.length === 1 ? 'Opened' : `All ${done} opened`;
  return `${done} of ${job.steps.length} opened; ${failed} didn't`;
}

export class Restorer {
  job: Job | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly deps: RestoreDeps,
    private readonly changed: (job: Job) => void,
  ) {}

  get busy(): boolean {
    return this.job?.state === 'running';
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Restores `ws` (only the items in `only`, and 'layout', when given: a retry). */
  async run(ws: Workspace, only?: string[]): Promise<Job> {
    if (this.busy) throw new Error(`Already restoring ${this.job!.name}.`);
    const abort = new AbortController();
    this.abort = abort;
    const items = ws.resources.filter((r) => r.enabled && (!only || only.includes(r.id)));
    const wantLayout = Boolean(ws.prefs.placeWindows && ws.layout?.windows.some((w) => w.enabled)) && (!only || only.includes('layout'));
    const steps: JobStep[] = items.map((r) => ({ id: r.id, label: itemTitle(r), kind: r.kind, state: 'waiting', why: '', detail: itemDetail(r) }));
    if (wantLayout) steps.push({ id: 'layout', label: 'Windows back in place', kind: 'layout', state: 'waiting', why: '', detail: '' });
    const job: Job = { id: newId('run'), ws: ws.id, name: ws.name.trim() || 'Untitled workspace', startedAt: this.deps.now(), endedAt: null, state: 'running', steps, asking: null };
    this.job = job;
    const emit = () => this.changed(job);
    emit();

    const check = await this.deps.check(ws);
    let started = false;
    for (const step of steps) {
      if (abort.signal.aborted) {
        step.state = 'cancelled';
        continue;
      }
      if (step.kind === 'layout') {
        step.state = 'opening';
        emit();
        await this.layout(ws, step, started, abort.signal);
        emit();
        continue;
      }
      const item = ws.resources.find((r) => r.id === step.id)!;
      const problem = check.items.get(item.id)?.problem;
      if (problem) {
        step.state = 'failed';
        step.why = problem;
        emit();
        continue;
      }
      if (item.mode === 'ask') {
        step.state = 'asking';
        job.asking = step.id;
        emit();
        const answer = await Promise.race([
          this.deps.ask(job, step),
          new Promise<Answer>((resolve) => abort.signal.addEventListener('abort', () => resolve('stop'), { once: true })),
        ]);
        job.asking = null;
        if (answer === 'skip') {
          step.state = 'skipped';
          step.why = 'You skipped it.';
          emit();
          continue;
        }
        if (answer === 'stop') {
          abort.abort();
          step.state = 'cancelled';
          continue;
        }
      }
      step.state = 'opening';
      emit();
      started = (await this.open(item, ws, step)) || started;
      emit();
      if ((step.state as StepState) === 'done' && item.wait > 0 && !abort.signal.aborted) await this.deps.sleep(item.wait * 1000, abort.signal).catch(() => {});
    }
    job.state = outcomeOf(steps);
    job.endedAt = this.deps.now();
    this.abort = null;
    emit();
    return job;
  }

  /** Opens one item; true when something was started (its window may still be coming). */
  private async open(item: Resource, ws: Workspace, step: JobStep): Promise<boolean> {
    const done = (why: string) => {
      step.state = 'done';
      step.why = why;
    };
    const failed = (why: string) => {
      step.state = 'failed';
      step.why = why;
    };
    if (item.kind === 'url') {
      if (await this.deps.openUrl(item.url.trim())) done('Opened in your browser.');
      else failed("Couldn't open it. Island opens web addresses and app links like vscode:.");
      return false;
    }
    if (item.kind === 'app' && item.reuse) {
      const running = await this.deps.running(item, ws);
      if (running) {
        if (running.hwnd) await this.deps.focus(running.hwnd);
        done(running.hwnd ? 'Already running: brought to the front.' : 'Already running.');
        return false;
      }
    }
    const r = await this.deps.launch(item, ws);
    if (!r.ok) {
      failed(r.error);
      return false;
    }
    const said: Record<Resource['kind'], string> = {
      app: 'Started.',
      file: 'Opened.',
      folder: `Opened in ${this.deps.fileManager}.`,
      url: 'Opened.',
      command: item.kind === 'command' && item.host === 'terminal' ? 'Running in Windows Terminal.' : 'Running in its own window.',
    };
    done(r.value.note ?? said[item.kind]);
    return true;
  }

  /** Puts the saved windows back: after giving apps just started time to show theirs. */
  private async layout(ws: Workspace, step: JobStep, started: boolean, signal: AbortSignal): Promise<void> {
    const layout = ws.layout!;
    const monitors = await this.deps.monitors();
    const until = this.deps.now() + (started ? WINDOW_WAIT_MS : 0);
    let plan = null;
    for (;;) {
      const live = await this.deps.windows();
      if (!live.ok) {
        step.state = 'failed';
        step.why = live.error;
        return;
      }
      plan = planPlacement(layout, live.value, monitors);
      if (!plan.missing.length || this.deps.now() >= until || signal.aborted) break;
      await this.deps.sleep(800, signal).catch(() => {});
    }
    if (signal.aborted) {
      step.state = 'cancelled';
      return;
    }
    const total = plan.places.length + plan.missing.length;
    if (!plan.places.length) {
      step.state = 'failed';
      step.why = `None of its windows are open (${programNames(plan.missing)}).`;
      return;
    }
    const placed = await this.deps.place(plan.places.map((p) => ({ hwnd: p.hwnd, rect: p.rect, state: p.state })));
    if (!placed.ok) {
      step.state = 'failed';
      step.why = placed.error;
      return;
    }
    const ok = placed.value.filter((p) => p.ok).length;
    const refused = placed.value.find((p) => !p.ok)?.why;
    const parts = [`Put ${ok} of ${total} windows back.`];
    if (plan.missing.length) parts.push(`Not open: ${programNames(plan.missing)}.`);
    if (refused) parts.push(refused);
    parts.push(...plan.notes);
    step.state = ok ? 'done' : 'failed';
    step.why = parts.join(' ');
  }
}
