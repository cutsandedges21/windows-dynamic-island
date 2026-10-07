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
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class Animator {
  private items = new Set<Tickable>();
  private frame = 0;
  private last = 0;

  add(item: Tickable): void {
    this.items.add(item);
    if (!this.frame) {
      this.last = now();
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
    // A long gap (tab hidden, debugger) must not fling springs.
    const dt = Math.min(0.064, Math.max(0, (t - this.last) / 1000));
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
