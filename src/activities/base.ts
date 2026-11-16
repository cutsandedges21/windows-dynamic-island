// Shared plumbing for built-in activities: lifecycle, event subscriptions and
// timers that are torn down automatically when the activity stops.

import type { Activity, ActivityContext, ActivityStatus, RenderEnv } from '../core/activity';
import { on } from '../core/native';
import type { MomentId, PetMoment, PetSignal } from '../core/pet';
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

  // ---------------------------------------------------------------- the bot

  /** The latest moment this activity saw, for the bot (src/core/pet.ts). */
  protected petMoment: PetMoment | null = null;

  /**
   * Tells the bot something just happened here. Moments with the same `key` merge (holding a
   * volume key is one moment); `strength` 0..1 says how big.
   */
  protected saw(id: MomentId, key: string = `${this.meta.id}:${id}`, strength?: number): void {
    this.petMoment = { id, key, at: Date.now(), strength };
    this.ctx?.update();
  }

  /** What the bot hears from here: by default only moments; an activity with a mood overrides this. */
  pet(_now: number): PetSignal | null {
    return this.petMoment ? { moment: this.petMoment } : null;
  }
}

/** The chime, in the style and volume picked in Settings (src/core/sounds.ts). */
export { chime, playSound } from '../core/sounds';
