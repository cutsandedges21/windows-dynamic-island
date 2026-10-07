// Shared plumbing for built-in activities: lifecycle, event subscriptions and
// timers that are torn down automatically when the activity stops.

import type { Activity, ActivityContext, ActivityStatus, RenderEnv } from '../core/activity';
import { on } from '../core/native';
import type { Seg } from '../core/segments';
import { CATALOG_BY_ID, type ActivityMeta } from './catalog';

export abstract class BaseActivity implements Activity {
  readonly meta: ActivityMeta;
  protected ctx!: ActivityContext;
  private disposers: Array<() => void> = [];
  private stopped = false;

  constructor(id: string) {
    const meta = CATALOG_BY_ID.get(id);
    if (!meta) throw new Error(`unknown activity ${id}`);
    this.meta = meta;
  }

  start(ctx: ActivityContext): void | Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    return this.init();
  }

  stop(): void {
    this.stopped = true;
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {
        /* already gone */
      }
    }
    this.dispose();
  }

  protected abstract init(): void | Promise<void>;
  protected dispose(): void {}
  abstract status(): ActivityStatus;
  abstract render(env: RenderEnv): Seg[];

  /** Subscribes to a native event for the activity's lifetime. */
  protected listen<T>(event: string, cb: (payload: T) => void): void {
    void on<T>(event, (p) => {
      if (!this.stopped) cb(p);
    }).then((un) => {
      if (this.stopped) un();
      else this.disposers.push(un);
    });
  }

  protected every(ms: number, fn: () => void, runNow = false): void {
    const t = setInterval(() => {
      if (!this.stopped) fn();
    }, ms);
    this.disposers.push(() => clearInterval(t));
    if (runNow) fn();
  }

  protected later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      if (!this.stopped) fn();
    }, ms);
    this.disposers.push(() => clearTimeout(t));
  }

  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  protected get alive(): boolean {
    return !this.stopped;
  }
}

/** Soft synthesized chime (no audio files), only when sounds are on. */
export function chime(kind: 'done' | 'attention' = 'done'): void {
  try {
    const ac = new AudioContext();
    const notes = kind === 'done' ? [880, 1174.7] : [659.3, 880];
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ac.currentTime + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.55);
    });
    setTimeout(() => void ac.close(), 1200);
  } catch {
    /* no audio device */
  }
}
