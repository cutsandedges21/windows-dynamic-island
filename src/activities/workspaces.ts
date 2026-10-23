// Workspaces on the pill: a restore as it goes (which item, how far), the question a restore
// asks before running a command or opening an "ask me first" item, and the result; in Control
// Center, favorites (or, with Notice what I work on, where you left off) to restore with a tap.
// The restoring itself is src/workspaces/engine.ts, which runs whether or not this activity is
// on. With "Notice what I work on" on, it also knows which workspace you're in (notice.ts):
// a restore takes the pill first, what it noticed otherwise.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { native } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { Block, SheetRow, SheetView, Tile } from '../core/sheet';
import { workspaceEngine } from '../workspaces/engine';
import { contentsText, displayName, KIND_META, sortWorkspaces } from '../workspaces/model';
import { jobSummary, type Answer, type Job, type JobStep } from '../workspaces/restore';
import { NoticeActivity } from './notice';

/** How long a finished restore stays on the pill. */
const SHOW_DONE_MS = 8000;
const FINAL = new Set(['done', 'skipped', 'failed', 'cancelled']);

const STATE_WORDS: Record<JobStep['state'], string> = {
  waiting: 'Waiting',
  asking: 'Asks first',
  opening: 'Opening…',
  done: 'Done',
  skipped: 'Skipped',
  failed: "Didn't open",
  cancelled: 'Stopped',
};
const STATE_TONE: Partial<Record<JobStep['state'], Tone>> = { done: 'good', failed: 'bad', skipped: 'muted', cancelled: 'muted', asking: 'info', opening: 'accent' };

export class WorkspacesActivity extends NoticeActivity {
  private surfacedEnd: string | null = null;
  private surfacedStart: string | null = null;
  private error: string | null = null;

  constructor() {
    super('workspaces');
  }

  protected override async init(): Promise<void> {
    await super.init();
    this.onDispose(workspaceEngine().subscribe(() => this.changed()));
    // The finished result leaves the pill on its own.
    this.every(1000, () => {
      const job = workspaceEngine().job;
      if (job && job.state !== 'running' && job.endedAt && Date.now() - job.endedAt < SHOW_DONE_MS + 1500) this.ctx.update();
    });
  }

  private changed(): void {
    const job = workspaceEngine().job;
    if (job?.state === 'running' && this.surfacedStart !== job.id) {
      this.surfacedStart = job.id;
      this.error = null;
      this.ctx.surface({ key: `ws-start:${job.id}`, ms: 2500, level: 'expanded' });
    }
    if (job && job.state !== 'running' && this.surfacedEnd !== job.id) {
      this.surfacedEnd = job.id;
      this.ctx.surface({ key: `ws-end:${job.id}`, ms: 6000, level: 'expanded' });
      this.saw(job.state === 'done' ? 'good-news' : job.state === 'cancelled' ? 'info' : 'warning', `workspaces:${job.id}`);
    }
    this.ctx.update();
  }

  /** The job worth showing: running, or finished a moment ago. */
  private shown(): Job | null {
    const job = workspaceEngine().job;
    if (!job) return null;
    if (job.state === 'running') return job;
    return job.endedAt && Date.now() - job.endedAt < SHOW_DONE_MS ? job : null;
  }

  private asking(job: Job): JobStep | null {
    return job.asking ? job.steps.find((s) => s.id === job.asking) ?? null : null;
  }

  override status(): ActivityStatus {
    const job = this.shown();
    if (!job) return super.status();
    const running = job.state === 'running';
    const finished = job.steps.filter((s) => FINAL.has(s.state)).length;
    return {
      active: true,
      weight: 'foreground',
      urgent: job.asking ? { key: `ws-ask:${job.id}:${job.asking}`, level: 'expanded' } : null,
      summary: running ? `Restoring ${job.name} · ${jobSummary(job)}` : `${job.name}: ${jobSummary(job)}`,
      beam: running ? { tone: 'accent', motion: job.asking ? 'pulse' : 'progress', value: job.steps.length ? finished / job.steps.length : 0 } : null,
    };
  }

  override chip(): ChipView | null {
    const job = this.shown();
    if (!job) return super.chip();
    const finished = job.steps.filter((s) => FINAL.has(s.state)).length;
    return { icon: 'grid', label: job.state === 'running' ? `${finished}/${job.steps.length}` : job.name, tone: 'accent', pulse: Boolean(job.asking) };
  }

  override render(env: RenderEnv): Seg[] {
    const job = this.shown();
    if (!job) return super.render(env);
    const running = job.state === 'running';
    const total = job.steps.length;
    const finished = job.steps.filter((s) => FINAL.has(s.state)).length;
    const ask = this.asking(job);
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: 'grid', tone: 'accent', anim: ask ? 'pulse' : undefined, prio: 0 },
      { t: 'text', key: 'name', text: job.name, weight: 'semibold', prio: 1, min: 50 },
    ];
    const resultTone: Tone = job.state === 'done' ? 'good' : job.state === 'cancelled' ? 'muted' : 'warn';
    if (env.level === 'compact' || env.level === 'idle') {
      segs.push({ t: 'text', key: 'count', text: running ? `${finished}/${total}` : jobSummary(job), tone: running ? 'muted' : resultTone, side: 'end', prio: 0 });
      return segs;
    }
    if (ask && env.interactive) {
      segs.push({ t: 'text', key: 'ask', text: `${ask.kind === 'command' ? 'Run' : 'Open'} ${ask.label}?`, tone: 'muted', prio: 3, min: 60 });
      segs.push({ t: 'button', key: 'yes', label: ask.kind === 'command' ? 'Run' : 'Open', action: 'answer', arg: 'yes', style: 'primary', side: 'end', prio: 1 });
      segs.push({ t: 'button', key: 'skip', label: 'Skip', action: 'answer', arg: 'skip', style: 'secondary', side: 'end', prio: 2 });
      return segs;
    }
    if (running) {
      const now = job.steps.find((s) => s.state === 'opening' || s.state === 'asking');
      if (now && !env.vertical) segs.push({ t: 'text', key: 'now', text: now.label, tone: 'muted', prio: 4, min: 50 });
      segs.push({ t: 'progress', key: 'bar', value: total ? finished / total : null, tone: 'accent', w: env.level === 'maximum' ? 140 : 80, side: 'center', prio: 3 });
      segs.push({ t: 'text', key: 'count', text: `${finished}/${total}`, tone: 'muted', side: 'end', prio: 2 });
    } else segs.push({ t: 'text', key: 'result', text: jobSummary(job), tone: resultTone, side: 'end', prio: 2 });
    return segs;
  }

  override sheet(env: SheetEnv): SheetView | null {
    const job = this.shown();
    if (!job) return this.error ? { key: 'ws-error', blocks: [{ t: 'text', key: 'err', text: this.error, tone: 'warn' }] } : super.sheet(env);
    const ask = this.asking(job);
    const n = (s: JobStep) => job.steps.indexOf(s) + 1;
    if (ask) {
      const blocks: Block[] = [
        { t: 'head', key: 'head', icon: ask.kind === 'layout' ? 'window' : KIND_META[ask.kind].icon, title: ask.kind === 'command' ? 'Run this command?' : `Open ${ask.label}?`, sub: `${job.name} · ${n(ask)} of ${job.steps.length}` },
        ask.kind === 'command' ? { t: 'code', key: 'detail', text: ask.detail } : { t: 'text', key: 'detail', text: ask.detail, tone: 'muted', size: 'sm' },
      ];
      if (env.interactive) {
        blocks.push({
          t: 'buttons',
          key: 'answer',
          items: [
            { key: 'yes', label: ask.kind === 'command' ? 'Run it' : 'Open it', action: 'answer', arg: 'yes', style: 'primary' },
            { key: 'skip', label: 'Skip', action: 'answer', arg: 'skip', style: 'secondary' },
            { key: 'stop', label: 'Stop restoring', action: 'answer', arg: 'stop', style: 'ghost' },
          ],
        });
      }
      return { key: `ws-ask:${ask.id}`, blocks };
    }
    const running = job.state === 'running';
    const rows: SheetRow[] = job.steps.slice(0, 8).map((s) => ({
      key: s.id,
      icon: s.kind === 'layout' ? 'window' : KIND_META[s.kind].icon,
      title: s.label,
      detail: s.why || undefined,
      badge: STATE_WORDS[s.state],
      tone: STATE_TONE[s.state],
    }));
    if (job.steps.length > 8) rows.push({ key: '+more', title: `+${job.steps.length - 8} more` });
    const buttons = running
      ? [{ key: 'stop', label: 'Stop', action: 'cancel', style: 'ghost' as const }]
      : [
          ...(job.steps.some((s) => s.state === 'failed') ? [{ key: 'retry', label: 'Try again', action: 'retry', style: 'primary' as const }] : []),
          { key: 'open', label: 'Open Workspaces', action: 'open', style: 'secondary' as const },
        ];
    return {
      key: `ws-job:${job.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'grid', title: job.name, sub: running ? `Restoring · ${jobSummary(job)}` : jobSummary(job) },
        { t: 'rows', key: 'steps', items: rows },
        ...(env.interactive ? [{ t: 'buttons' as const, key: 'actions', items: buttons }] : []),
      ],
    };
  }

  /** Where you left off (with noticing on), else favorites (or the last opened), to restore with a tap. */
  tile(env: SheetEnv): Tile | null {
    const pickUp = this.pickUpTile(env);
    if (pickUp) return pickUp;
    const list = workspaceEngine().store.list.filter((w) => !w.archived);
    if (!list.length) return null;
    const favorites = list.filter((w) => w.favorite);
    const picks = (favorites.length ? favorites : sortWorkspaces(list, 'recent')).slice(0, 4);
    const busy = workspaceEngine().busy;
    return {
      key: 'workspaces',
      span: 2,
      rows: picks.length > 2 ? 2 : 1,
      body: {
        k: 'list',
        icon: 'grid',
        label: favorites.length ? 'Workspaces · favorites' : 'Workspaces',
        rows: picks.map((w) => ({
          key: w.id,
          icon: w.icon,
          title: displayName(w),
          detail: w.notes.next.trim() || contentsText(w),
          action: env.interactive && !busy ? 'restore' : undefined,
          arg: w.id,
          tip: busy ? 'A restore is running' : `Restore ${displayName(w)}`,
          ...this.inUseRow(w),
        })),
      },
    };
  }

  async action(name: string, arg: unknown): Promise<void> {
    const engine = workspaceEngine();
    const job = engine.job;
    if (name === 'answer' && job?.asking && (arg === 'yes' || arg === 'skip' || arg === 'stop')) engine.answer(job.asking, arg as Answer);
    else if (name === 'cancel') engine.cancel();
    else if (name === 'retry') await this.report(engine.retryFailed());
    else if (name === 'restore' && typeof arg === 'string') await this.report(engine.restore(arg));
    else if (name === 'open') {
      void native.openApp('workspaces');
      this.ctx.close();
    } else if (await this.noticeAction(name, arg)) return;
    this.ctx.update();
  }

  private async report(started: Promise<{ ok: true; value: string } | { ok: false; error: string }>): Promise<void> {
    const r = await started;
    if (r.ok) return;
    this.error = r.error;
    this.ctx.surface({ key: 'ws-error', ms: 4000, level: 'expanded' });
  }

  /** Tapping away a question skips that item, like declining a permission card. */
  override dismiss(key: string): void {
    const job = workspaceEngine().job;
    if (key.startsWith('ws-ask:') && job?.asking) workspaceEngine().answer(job.asking, 'skip');
    super.dismiss(key);
  }
}
