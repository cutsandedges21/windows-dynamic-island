// The animation engine: one requestAnimationFrame loop for every spring in the
// window. It knows nothing about what it animates (a pill, a chip, a card being
// dragged); it steps springs and hands their values to a write callback, which
// is expected to touch only transform / opacity / filter or the shell's size.
// The loop stops when everything is at rest, so an idle island costs no frames.

import { Spring, springs, type SpringConfig } from './spring';

export interface Tickable {
  /** Advance by dt seconds; return true while still moving. */
  tick(dt: number): boolean;
}

let reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Reduced motion: every spring jumps straight to its target. */
export function setReducedMotion(on: boolean): void {
  reduced = on;
}
export function reducedMotion(): boolean {
  return reduced;
}

const raf: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

/** The display's frame time to start from, before the animator has measured it (60 Hz). */
const FIRST_PERIOD = 1 / 60;

/**
 * One frame's time step, from the time since the last frame (`raw`, seconds) and the display's
 * frame time measured so far (`period`). Every frame is shown one vsync after the last, so a step
 * near a whole number of frames is taken as exactly that many: the browser's frame clock jitters
 * by a millisecond or two, and stepping springs by that jitter moved them unevenly (a little
 * shimmer at the pill's edges). A step far from any whole number (a dropped, late frame) stays as
 * it was. Short, steady frames teach the display's real rate (120 and 144 Hz screens included).
 */
export function frameStep(raw: number, period: number): { dt: number; period: number } {
  const r = Math.min(0.064, Math.max(0, raw));
  let p = period;
  if (r > 1 / 250 && r < p * 1.5) p += (r - p) * 0.1;
  const n = Math.max(1, Math.round(r / p));
  const dt = Math.abs(r - n * p) < p * 0.25 ? Math.min(0.064, n * p) : r;
  return { dt, period: p };
}

class Animator {
  private items = new Set<Tickable>();
  private frame = 0;
  private last = 0;
  /** The loop's first frame after a rest: it has no frame of its own to measure from. */
  private fresh = true;
  private period = FIRST_PERIOD;

  add(item: Tickable): void {
    this.items.add(item);
    if (!this.frame) {
      this.fresh = true;
      this.frame = raf(this.loop);
    }
  }

  remove(item: Tickable): void {
    this.items.delete(item);
  }

  get busy(): boolean {
    return this.items.size > 0;
  }

  private loop = (t: number): void => {
    // The first frame after a rest moves by one whole frame: the time since the click or event
    // that started it is a fraction of one (often 0, since the frame clock runs ahead of the event
    // clock), so that frame stood still and the next jumped, a hitch at the start of every motion.
    // A long gap (tab hidden, debugger) must not fling springs: frameStep caps it.
    let dt = this.period;
    if (!this.fresh) {
      const step = frameStep((t - this.last) / 1000, this.period);
      dt = step.dt;
      this.period = step.period;
    }
    this.fresh = false;
    this.last = t;
    for (const item of [...this.items]) {
      let alive = false;
      try {
        alive = item.tick(dt);
      } catch (err) {
        console.error('animation step failed', err);
      }
      if (!alive) this.items.delete(item);
    }
    this.frame = this.items.size ? raf(this.loop) : 0;
  };
}

export const animator = new Animator();

type Values<K extends string> = Record<K, number>;
type Configs<K extends string> = SpringConfig | Partial<Record<K, SpringConfig>>;

/**
 * Named springs that move together and are written to the DOM in one callback
 * per frame (batched writes, no layout reads).
 */
export class SpringSet<K extends string> implements Tickable {
  readonly springs: Record<K, Spring>;
  private restCallbacks: Array<() => void> = [];
  private active = false;

  constructor(
    initial: Values<K>,
    private write: (values: Values<K>) => void,
    config: SpringConfig = springs.content,
    precision: Partial<Record<K, number>> = {},
  ) {
    const map = {} as Record<K, Spring>;
    for (const key of Object.keys(initial) as K[]) map[key] = new Spring(initial[key], config, precision[key] ?? 0.01);
    this.springs = map;
    write(this.values());
  }

  values(): Values<K> {
    const out = {} as Values<K>;
    for (const key of Object.keys(this.springs) as K[]) out[key] = this.springs[key].value;
    return out;
  }

  get(key: K): number {
    return this.springs[key].value;
  }

  target(key: K): number {
    return this.springs[key].target;
  }

  get settled(): boolean {
    return (Object.values(this.springs) as Spring[]).every((s) => s.settled);
  }

  set(targets: Partial<Values<K>>, opts: { config?: Configs<K>; immediate?: boolean } = {}): this {
    const immediate = opts.immediate || reduced;
    let moved = false;
    for (const key of Object.keys(targets) as K[]) {
      const value = targets[key];
      if (value === undefined || !Number.isFinite(value)) continue;
      const s = this.springs[key];
      const cfg = opts.config && 'response' in opts.config ? (opts.config as SpringConfig) : (opts.config as Partial<Record<K, SpringConfig>> | undefined)?.[key];
      if (immediate) {
        if (s.value !== value || !s.settled) moved = true;
        s.jump(value);
      } else {
        s.setTarget(value, cfg);
        if (!s.settled) moved = true;
      }
    }
    if (immediate) {
      this.write(this.values());
      if (this.settled) this.flushRest();
    } else if (moved) {
      this.start();
    }
    return this;
  }

  impulse(key: K, velocity: number): void {
    if (reduced) return;
    this.springs[key].impulse(velocity);
    this.start();
  }

  /** Runs once, the next time every spring is at rest (now, if already). */
  onRest(cb: () => void): void {
    if (this.settled && !this.active) cb();
    else this.restCallbacks.push(cb);
  }

  stop(): void {
    animator.remove(this);
    this.active = false;
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    animator.add(this);
  }

  tick(dt: number): boolean {
    let moving = false;
    for (const s of Object.values(this.springs) as Spring[]) if (s.step(dt)) moving = true;
    this.write(this.values());
    if (!moving) {
      this.active = false;
      this.flushRest();
    }
    return moving;
  }

  private flushRest(): void {
    const cbs = this.restCallbacks;
    this.restCallbacks = [];
    for (const cb of cbs) cb();
  }
}
