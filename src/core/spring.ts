// Damped springs, solved exactly (no integration error, stable at any frame
// time). Configured like SwiftUI: `response` is the period in seconds of the
// undamped oscillation, `damping` is the damping fraction (1 = critical, no
// overshoot; below 1 = a little bounce). Retargeting keeps the current velocity,
// which is what makes an interrupted animation look physical.

export interface SpringConfig {
  response: number;
  damping: number;
}

export const springs = {
  /** The island's shape: quick, with a hint of overshoot. */
  shell: { response: 0.48, damping: 0.8 },
  /** Travelling to another edge of the screen. */
  travel: { response: 0.7, damping: 0.84 },
  /** Content sliding to a new slot. */
  content: { response: 0.42, damping: 0.88 },
  snappy: { response: 0.26, damping: 0.92 },
  bouncy: { response: 0.42, damping: 0.6 },
  gentle: { response: 0.65, damping: 1 },
  fade: { response: 0.28, damping: 1 },
  /** Following a finger or cursor. */
  drag: { response: 0.14, damping: 0.95 },
} satisfies Record<string, SpringConfig>;

/** Displacement and velocity of a spring `t` seconds after (x0, v0), relative to its target. */
export function solve(x0: number, v0: number, cfg: SpringConfig, t: number): [number, number] {
  const w0 = (2 * Math.PI) / Math.max(cfg.response, 1e-3);
  const z = Math.max(0, cfg.damping);
  if (Math.abs(z - 1) < 1e-3) {
    const e = Math.exp(-w0 * t);
    const b = v0 + w0 * x0;
    return [e * (x0 + b * t), e * (b - w0 * (x0 + b * t))];
  }
  if (z < 1) {
    const a = z * w0;
    const wd = w0 * Math.sqrt(1 - z * z);
    const e = Math.exp(-a * t);
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t);
    const c2 = (v0 + a * x0) / wd;
    return [e * (x0 * c + c2 * s), e * ((-a * x0 + wd * c2) * c + (-a * c2 - wd * x0) * s)];
  }
  const root = Math.sqrt(z * z - 1);
  const r1 = -w0 * (z - root);
  const r2 = -w0 * (z + root);
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = Math.exp(r1 * t);
  const e2 = Math.exp(r2 * t);
  return [c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2];
}

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  config: SpringConfig;
  /** Below this distance and speed the spring snaps to rest. */
  precision: number;
  private resting = true;

  constructor(value: number, config: SpringConfig = springs.content, precision = 0.01) {
    this.value = value;
    this.target = value;
    this.config = config;
    this.precision = precision;
  }

  get settled(): boolean {
    return this.resting;
  }

  setTarget(target: number, config?: SpringConfig): void {
    if (config) this.config = config;
    if (target === this.target && this.resting) return;
    this.target = target;
    this.resting = false;
  }

  /** Teleport: no motion, no velocity. */
  jump(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.resting = true;
  }

  /** Adds velocity (a flick or a nudge) without changing the target. */
  impulse(velocity: number): void {
    this.velocity += velocity;
    this.resting = false;
  }

  step(dt: number): boolean {
    if (this.resting) return false;
    const [x, v] = solve(this.value - this.target, this.velocity, this.config, dt);
    this.value = this.target + x;
    this.velocity = v;
    if (Math.abs(x) < this.precision && Math.abs(v) < this.precision * 10) {
      this.value = this.target;
      this.velocity = 0;
      this.resting = true;
    }
    return !this.resting;
  }
}

const easingCache = new Map<string, { easing: string; duration: number }>();

/**
 * A spring sampled into a CSS `linear()` easing, for fire-and-forget animations
 * that the compositor can run on its own (enter, exit, text roll). The curve
 * runs 0 → 1 and may overshoot, exactly like the JS spring with the same config.
 */
export function springEasing(cfg: SpringConfig): { easing: string; duration: number } {
  const id = `${cfg.response}:${cfg.damping}`;
  const hit = easingCache.get(id);
  if (hit) return hit;
  // Settle time: first moment after which the displacement stays under 0.1%.
  const step = 1 / 240;
  let t = 0;
  let lastLoud = 0;
  for (; t < 3; t += step) {
    const [x, v] = solve(-1, 0, cfg, t);
    if (Math.abs(x) > 0.001 || Math.abs(v) > 0.01) lastLoud = t;
    if (t - lastLoud > 0.25) break;
  }
  const duration = Math.max(0.12, Math.min(2.5, lastLoud + step));
  const samples = Math.min(80, Math.max(24, Math.round(duration * 60)));
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const [x] = solve(-1, 0, cfg, (duration * i) / samples);
    points.push((i === samples ? 1 : 1 + x).toFixed(4).replace(/\.?0+$/, '') || '0');
  }
  const out = { easing: `linear(${points.join(', ')})`, duration: Math.round(duration * 1000) };
  easingCache.set(id, out);
  return out;
}
