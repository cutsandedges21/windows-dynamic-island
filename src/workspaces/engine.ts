// The island window's side of Workspaces: it restores (the island lives as long as Island runs,
// so closing the Activities window doesn't stop a restore), holds the questions a restore asks
// ("Run npm run dev?") until the pill or the Activities window answers, records each restore in
// the workspace's history, and tells every window how the job goes ('ws-job'). It runs whether
// or not the Workspaces activity is on: the activity only shows it on the pill.

import { native, type LaunchItem, type Tried } from '../core/native';
import { platform } from '../core/platform';
import { checkWorkspace } from './checks';
import { HISTORY_MAX, itemTitle, type Resource, type Workspace } from './model';
import { Restorer, runRecord, type Answer, type Job } from './restore';
import { createStore, type WorkspaceStore } from './store';
import type { NoticeActivity } from '../activities/notice';

/** A question nobody answers is skipped after this long. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;

export function launchItem(r: Resource): LaunchItem | null {
  switch (r.kind) {
    case 'app':
      return { kind: 'app', path: r.path, args: r.args, cwd: r.cwd };
    case 'file':
      return { kind: 'file', path: r.path, openWith: r.openWith };
    case 'folder':
      return { kind: 'folder', path: r.path };
    case 'command':
      return { kind: 'command', id: r.id, command: r.command, shell: r.shell, host: r.host, cwd: r.cwd, title: itemTitle(r) };
    case 'url':
      return null;
  }
}

export class WorkspaceEngine {
  readonly store: WorkspaceStore;
  private readonly restorer: Restorer;
  private readonly asks = new Map<string, (a: Answer) => void>();
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  /** The Workspaces activity while it runs: what it noticed ("today", "spans", "forget"). */
  notice: NoticeActivity | null = null;

  constructor() {
    this.store = createStore('island', (m) => void native.log(`workspaces: ${m}`));
    this.store.subscribe(() => this.emit());
    this.loaded = this.store.load();
    this.restorer = new Restorer(
      {
        check: (ws) => checkWorkspace(ws),
        launch: async (r, ws) => {
          const item = launchItem(r);
          return item ? native.wsLaunch(item, ws.cwd) : { ok: false, error: 'Nothing to start.' };
        },
        openUrl: (url) => native.openUrl(url),
        running: (r, ws) => native.wsRunning(r.path, ws.cwd),
        focus: (hwnd) => native.activate(hwnd),
        windows: () => native.wsWindows(),
        monitors: () => native.monitors(),
        place: (places) => native.wsPlace(places),
        ask: (_job, step) =>
          new Promise<Answer>((resolve) => {
            const timer = setTimeout(() => this.answer(step.id, 'skip'), ASK_TIMEOUT_MS);
            this.asks.set(step.id, (a) => {
              clearTimeout(timer);
              this.asks.delete(step.id);
              resolve(a);
            });
          }),
        sleep: (ms, signal) =>
          new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('stopped'))), { once: true });
          }),
        now: () => Date.now(),
        fileManager: platform === 'macos' ? 'Finder' : 'Explorer',
      },
      (job) => {
        void native.broadcast('ws-job', structuredClone(job));
        this.emit();
      },
    );
  }

  get job(): Job | null {
    return this.restorer.job;
  }

  get busy(): boolean {
    return this.restorer.busy;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  answer(step: string, a: Answer): void {
    this.asks.get(step)?.(a);
  }

  cancel(): void {
    this.restorer.cancel();
  }

  /** Starts restoring; says why not when it can't (another restore running, a workspace gone). */
  async restore(id: string, only?: string[]): Promise<Tried<string>> {
    await this.loaded;
    const ws = this.store.get(id);
    if (!ws) return { ok: false, error: 'That workspace is gone.' };
    if (this.restorer.busy) return { ok: false, error: `Already restoring ${this.restorer.job!.name}. Wait for it, or stop it first.` };
    void this.runJob(ws, only);
    // run() makes the job before its first await.
    return { ok: true, value: this.restorer.job!.id };
  }

  /** Tries again what failed in the last restore (and the windows, if those failed). */
  retryFailed(): Promise<Tried<string>> {
    const job = this.restorer.job;
    if (!job || job.state === 'running') return Promise.resolve({ ok: false, error: 'Nothing to try again.' });
    const only = job.steps.filter((s) => s.state === 'failed' || s.state === 'cancelled').map((s) => s.id);
    if (!only.length) return Promise.resolve({ ok: false, error: 'Nothing failed.' });
    return this.restore(job.ws, only);
  }

  private async runJob(ws: Workspace, only?: string[]): Promise<void> {
    try {
      const job = await this.restorer.run(ws, only);
      const run = runRecord(job);
      const fresh = this.store.get(ws.id);
      const history = [run, ...(fresh?.history ?? [])].slice(0, HISTORY_MAX);
      await this.store.update(ws.id, { lastOpenedAt: run.at, history });
      void native.log(`workspaces: restored ${ws.id}: ${run.outcome} (${run.steps.map((s) => s.status[0]).join('')}) in ${run.ms} ms`);
    } catch (err) {
      void native.log(`workspaces: restore failed: ${String(err)}`);
    }
  }

  /** Requests from the Activities window (src/core/island.ts routes target 'workspaces' here). */
  async command(cmd: string, arg: unknown): Promise<unknown> {
    const a = (arg ?? {}) as { id?: string; only?: string[]; step?: string; answer?: Answer };
    switch (cmd) {
      case 'restore':
        return this.restore(String(a.id ?? ''), Array.isArray(a.only) ? a.only : undefined);
      case 'retry':
        return this.retryFailed();
      case 'cancel':
        this.cancel();
        return true;
      case 'answer':
        if (a.step && (a.answer === 'yes' || a.answer === 'skip' || a.answer === 'stop')) this.answer(a.step, a.answer);
        return true;
      case 'job':
        return this.restorer.job;
      default:
        return this.notice?.noticeCommand(cmd, arg) ?? null;
    }
  }
}

let engine: WorkspaceEngine | null = null;

/** The island window's engine (made on first use). */
export function workspaceEngine(): WorkspaceEngine {
  return (engine ??= new WorkspaceEngine());
}
