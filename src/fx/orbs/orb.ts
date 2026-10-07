// ThinkingOrb: a dotted 3D "thinking" orb drawn into a <canvas> it creates inside a host element.
//
// Follows thinking-orbs' ThinkingOrb.tsx: one shared clock (performance.now) keeps every orb in
// phase, the canvas is devicePixelRatio aware, and reduced-motion users get one static frame.
// Each orb runs its own requestAnimationFrame loop, parked while the canvas is detached, off
// screen or the page is hidden, and woken again when it can be seen.

import { MODE_DRAWS } from './registry';
import { resolvePreset, STATE_TO_MODE, type Resolved } from './presets';
import { presetSizeFor, type OrbState, type OrbTheme } from './states';
import { VisibilityGate } from '../visibility';

export interface ThinkingOrbOptions {
  state: OrbState;
  /** Width and height in CSS px. Any size works; dot tuning comes from the closest of 20 or 64. */
  size: number;
  /** 'dark' (default) draws light dots for a dark background, 'light' dark dots. */
  theme?: OrbTheme;
}

const DEFAULT_SIZE = 24;
/** Retina is plenty for dots this small; more only costs fill rate. */
const MAX_PIXEL_RATIO = 2;
/** Where reduced-motion users freeze the animation (seconds on the orb clock), as upstream does. */
const STILL_TIME = 0.6;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const LABELS: Record<OrbState, string> = {
  working: 'Working',
  searching: 'Searching',
  solving: 'Solving',
  listening: 'Listening',
  connecting: 'Connecting',
  weaving: 'Weaving',
  composing: 'Composing',
  breathing: 'Thinking',
  shaping: 'Shaping',
};

export class ThinkingOrb {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly gate: VisibilityGate;
  private readonly motionQuery: MediaQueryList | null;
  private readonly size: number;
  private readonly dark: boolean;

  private state: OrbState;
  private preset: Resolved;
  private reduceMotion: boolean;
  private pixelRatio = 0;
  private frameRequest = 0;
  private destroyed = false;

  constructor(host: HTMLElement, opts: ThinkingOrbOptions) {
    this.size = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : DEFAULT_SIZE;
    this.dark = (opts.theme ?? 'dark') === 'dark';
    this.state = isOrbState(opts.state) ? opts.state : 'working';
    this.preset = resolvePreset(this.state, presetSizeFor(this.size));

    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', LABELS[this.state]);
    this.canvas.style.cssText = `display:block;width:${this.size}px;height:${this.size}px`;
    this.context = this.canvas.getContext('2d');

    this.motionQuery = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION) : null;
    this.reduceMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotionPreferenceChange);

    host.appendChild(this.canvas);
    this.gate = new VisibilityGate(this.canvas, this.onGateChange);
    this.draw();
    this.wake();
  }

  /** Switches to another animation at once. Unknown or unchanged states are ignored. */
  setState(state: OrbState): void {
    if (this.destroyed || state === this.state || !isOrbState(state)) return;
    this.state = state;
    this.preset = resolvePreset(state, presetSizeFor(this.size));
    this.canvas.setAttribute('aria-label', LABELS[state]);
    this.draw();
  }

  /** Stops the loop and removes the canvas. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.gate.destroy();
    this.motionQuery?.removeEventListener('change', this.onMotionPreferenceChange);
    this.canvas.remove();
  }

  private wake(): void {
    if (this.destroyed || this.reduceMotion || this.frameRequest !== 0 || !this.gate.open) return;
    this.frameRequest = requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (): void => {
    this.frameRequest = 0;
    if (this.destroyed || !this.gate.open) return;
    this.draw();
    this.frameRequest = requestAnimationFrame(this.onFrame);
  };

  private draw(): void {
    const { context, size } = this;
    if (!context) return;
    const ratio = Math.min(MAX_PIXEL_RATIO, devicePixelRatio || 1);
    // Follows the island across monitors with different scaling without any extra listener.
    if (ratio !== this.pixelRatio) this.resizeBackingStore(ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    const time = this.reduceMotion ? STILL_TIME : (performance.now() / 1000) * this.preset.speed;
    MODE_DRAWS[this.preset.mode](context, size, time, this.dark, this.preset.opts);
  }

  private resizeBackingStore(ratio: number): void {
    this.pixelRatio = ratio;
    // Assigning width or height also clears the canvas and resets its transform.
    this.canvas.width = Math.round(this.size * ratio);
    this.canvas.height = Math.round(this.size * ratio);
  }

  private readonly onGateChange = (open: boolean): void => {
    if (open) {
      this.draw();
      this.wake();
    }
  };

  private readonly onMotionPreferenceChange = (): void => {
    const reduce = this.motionQuery?.matches ?? false;
    if (this.destroyed || reduce === this.reduceMotion) return;
    this.reduceMotion = reduce;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.draw();
    this.wake();
  };
}

function isOrbState(value: string): value is OrbState {
  return Object.prototype.hasOwnProperty.call(STATE_TO_MODE, value);
}
