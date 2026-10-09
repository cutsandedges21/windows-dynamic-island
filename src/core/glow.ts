// The border glow: light along the pill's edge (or a card's) that says what kind
// of thing is happening, in the colour of the activity doing it. Orange is
// Claude's alone; the others pick their own tone.
//
//   orbit     a comet with a fading tail circling the edge: busy (Claude thinking)
//   pulse     the whole edge breathing: something is waiting on you
//   progress  the edge filling up from the top: a timer, charging
//
// How it is drawn matters as much as how it looks. The island is a see-through
// window the size of the screen, and anything that *repaints* inside it makes
// Windows blend that whole window again, every frame: the first version of this
// cost about 40% of a processor core. So nothing here repaints while it moves.
// The comet is a cone of colour on a square layer that the GPU simply turns
// (`rotate`), seen through a ring-shaped mask cut to the pill's outline. The
// breath is an opacity fade, which the GPU also does by itself. JavaScript only
// writes where the pill is, and only when it moves.

import { reducedMotion } from './animator';
import type { Rect } from './layout';
import type { Tone } from './segments';

export type GlowMotion = 'orbit' | 'pulse' | 'progress';
export type GlowSpeed = 'off' | 'slow' | 'medium' | 'fast';

export interface GlowSpec {
  tone: Tone;
  motion: GlowMotion;
  /** progress: 0..1 of the edge lit. */
  value?: number;
  /** A brisker orbit or pulse (one notch faster than the user's speed). */
  fast?: boolean;
}

/** Seconds per lap (orbit) and per breath (pulse) for each speed setting. */
export const GLOW_PACE: Record<Exclude<GlowSpeed, 'off'>, { lap: number; breath: number }> = {
  slow: { lap: 8, breath: 3.2 },
  medium: { lap: 5, breath: 2.4 },
  fast: { lap: 3, breath: 1.6 },
};

/** Ring thickness and how far the halo reaches past the pill, in px. */
const CORE_W = 1.6;
const HALO_W = 5;

export class BorderGlow {
  private readonly el: HTMLElement;
  /** The lit ring, and a softer wider one around it for the halo. */
  private readonly core: HTMLElement;
  private readonly halo: HTMLElement;
  private spec: GlowSpec | null = null;
  /** The size last written to the ring. */
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private pace = GLOW_PACE.medium;

  /** `layer`: where the light is drawn (the stage); `radius`: corner radius, or null for a fully rounded pill. */
  constructor(
    layer: HTMLElement,
    private readonly radius: number | null = null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'glow';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.display = 'none';
    this.halo = this.ring('halo', HALO_W);
    this.core = this.ring('core', CORE_W);
    this.el.append(this.halo, this.core);
    layer.append(this.el);
  }

  /** One ring: a masked frame with a turning cone of colour inside it. */
  private ring(name: string, width: number): HTMLElement {
    const ring = document.createElement('div');
    ring.className = `ring ${name}`;
    ring.style.setProperty('--w', `${width}px`);
    const spin = document.createElement('i');
    ring.append(spin);
    return ring;
  }

  /** How fast it moves (the user's setting). */
  setSpeed(speed: Exclude<GlowSpeed, 'off'>): void {
    this.pace = GLOW_PACE[speed] ?? GLOW_PACE.medium;
    this.applyPace();
  }

  private applyPace(): void {
    const brisk = this.spec?.fast ? 0.65 : 1;
    this.el.style.setProperty('--lap', `${this.pace.lap * brisk}s`);
    this.el.style.setProperty('--breath', `${this.pace.breath * brisk}s`);
  }

  /**
   * Where the host is drawn, in the layer's CSS px. Called on every pill frame,
   * so it writes one transform and touches the rest only when the size changes.
   */
  place(rect: Rect): void {
    this.el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    // Measured against the size last written, not the last frame: a spring's tail moves
    // a fraction of a pixel per frame, and comparing frame to frame froze the ring short
    // of the pill on the side it grows toward.
    if (Math.abs(rect.w - this.rect.w) < 0.1 && Math.abs(rect.h - this.rect.h) < 0.1) return;
    this.rect = rect;
    const { w, h } = rect;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.el.style.setProperty('--r', `${Math.max(0, Math.min(this.radius ?? Math.min(w, h) / 2, w / 2, h / 2))}px`);
    // The cone has to cover the pill from its centre however the pill is turned.
    this.el.style.setProperty('--d', `${Math.ceil(Math.hypot(w, h)) + 8}px`);
  }

  /** Shows `spec` (null fades the glow out). The same spec again changes nothing. */
  set(spec: GlowSpec | null): void {
    const prev = this.spec;
    if (prev && spec && prev.tone === spec.tone && prev.motion === spec.motion && prev.fast === spec.fast) {
      if (spec.motion === 'progress' && spec.value !== prev.value) this.drawProgress(spec.value ?? 0);
      this.spec = spec;
      return;
    }
    if (!prev && !spec) return;
    this.spec = spec;
    clearTimeout(this.hideTimer);
    if (!spec) {
      this.el.classList.remove('on');
      // Out of sight it leaves the page entirely: nothing to animate, nothing to blend.
      this.hideTimer = setTimeout(() => {
        if (this.spec) return;
        this.el.dataset.motion = '';
        this.el.style.display = 'none';
      }, 500);
      return;
    }
    const color = tone(spec.tone);
    this.el.style.setProperty('--c', color);
    this.el.style.setProperty('--hot', `color-mix(in srgb, ${color} 45%, white)`);
    this.el.style.display = '';
    this.applyPace();
    this.el.dataset.motion = reducedMotion() && spec.motion !== 'progress' ? 'still' : spec.motion;
    if (spec.motion === 'progress') this.drawProgress(spec.value ?? 0);
    this.el.classList.add('on');
  }

  destroy(): void {
    clearTimeout(this.hideTimer);
    this.el.remove();
  }

  /** How much of the ring is lit, from the top, clockwise. */
  private drawProgress(value: number): void {
    this.el.style.setProperty('--p', `${Math.max(0, Math.min(1, value)) * 360}deg`);
  }
}

function tone(name: Tone): string {
  return name === 'default' ? 'var(--fg)' : `var(--${name})`;
}
