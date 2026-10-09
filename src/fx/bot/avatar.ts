// BotAvatar: the bloub bot drawn as one <svg> inside a host element.
//
// The engine is a pure function of time, so the avatar only has to decide WHEN to ask for a
// frame. It asks only while something moves: a state change (the blend plus the new state's own
// animation), a body-shape morph, or a blink. In between, no animation frame is requested at
// all. It also stays quiet while the host is detached, off screen or the document hidden, and
// under prefers-reduced-motion it never animates: it draws each state's most legible pose.

import { BotEngine } from './engine';
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from './expressions';
import { RAYON } from './repere';
import { SHAPE_BY_ID } from './skins';
import { POSES, STATE_BY_ID } from './states';
import {
  BLINK_SECONDS,
  ISLAND_SKIN,
  motionSeconds,
  nextBlinkDelayMs,
  resolveSkin,
  type BotSkin,
  type BotState,
  type ResolvedSkin,
} from './catalog';
import { BotView } from './view';
import { VisibilityGate } from '../visibility';

export interface BotAvatarOptions extends BotSkin {
  /** Width and height of the svg in px. The resting body fills about 83% of it. */
  size: number;
  /** Starting state. Its entrance animation plays on creation. Default 'idle'. */
  state?: BotState;
}

const DEFAULT_SIZE = 24;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export class BotAvatar {
  private readonly view: BotView;
  private readonly gate: VisibilityGate;
  private readonly motionQuery: MediaQueryList | null;
  private readonly startedAt = performance.now();

  private engine: BotEngine;
  private skin: ResolvedSkin;
  private state: BotState;
  private reduceMotion: boolean;
  private destroyed = false;
  /** The resting face, one of bloub's expression ids. */
  private expression = DEFAULT_EXPRESSION;

  /** Pending animation frame, 0 when the loop is asleep. */
  private frameRequest = 0;
  private blinkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Until when (avatar clock, seconds) the current state keeps changing the picture. */
  private stateMotionUntil = 0;
  /** Until when a shape morph or blink keeps changing it. */
  private extraMotionUntil = 0;
  /** Whether the last frame had eyes: no point blinking a bot that has none. */
  private hasEyes = false;

  constructor(host: HTMLElement, opts: BotAvatarOptions) {
    this.skin = resolveSkin(opts, ISLAND_SKIN);
    this.state = opts.state !== undefined && STATE_BY_ID.has(opts.state) ? opts.state : 'idle';
    const size = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : DEFAULT_SIZE;
    this.view = new BotView(size, this.skin.color, this.skin.eye);
    this.engine = this.makeEngine();

    this.motionQuery = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION) : null;
    this.reduceMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotionPreferenceChange);

    host.appendChild(this.view.svg);
    this.gate = new VisibilityGate(this.view.svg, this.onGateChange);

    if (this.reduceMotion) {
      this.drawStill();
    } else {
      this.stateMotionUntil = motionSeconds(this.state);
      this.draw();
      this.wake();
      this.scheduleBlink();
    }
  }

  /** Switches state with a morph. Unknown or unchanged states are ignored. */
  setState(state: BotState): void {
    if (this.destroyed || state === this.state || !STATE_BY_ID.has(state)) return;
    this.state = state;
    if (this.reduceMotion) {
      this.drawStill();
      return;
    }
    const now = this.now();
    this.engine.setState(state, now);
    // Replaces, never extends: a looping state we are leaving must not keep the loop alive.
    this.stateMotionUntil = now + motionSeconds(state);
    this.wake();
  }

  /** Changes shape and/or colours; parts left out or invalid keep their current value. */
  setSkin(skin: BotSkin): void {
    if (this.destroyed) return;
    const next = resolveSkin(skin, this.skin);
    const shapeChanged = next.shape !== this.skin.shape;
    const colorsChanged = next.color !== this.skin.color || next.eye !== this.skin.eye;
    this.skin = next;
    if (colorsChanged) this.view.paint(next.color, next.eye);
    if (shapeChanged && !this.reduceMotion) {
      const now = this.now();
      this.engine.setShape(SHAPE_BY_ID.get(next.shape)!.radii, now);
      this.extraMotionUntil = Math.max(this.extraMotionUntil, now + BotEngine.SHAPE_MORPH);
    }
    // A still picture (or a sleeping loop) must show the new look right away.
    if (shapeChanged || colorsChanged) this.refresh();
  }

  /** The resting face: one of bloub's expressions by id (src/fx/bot/expressions.ts). It eases there. */
  setExpression(id: string): void {
    if (this.destroyed || id === this.expression || !EXPRESSION_BY_ID.has(id)) return;
    this.expression = id;
    if (this.reduceMotion) {
      this.drawStill();
      return;
    }
    const now = this.now();
    this.engine.setExpression(EXPRESSION_BY_ID.get(id)!, now);
    this.extraMotionUntil = Math.max(this.extraMotionUntil, now + BotEngine.SHAPE_MORPH);
    this.wake();
  }

  /**
   * Turns the eyes toward a direction (degrees: yaw > 0 looks right, pitch > 0 looks up), or
   * back to the pose's own gaze with null. The eyes ease there, so it is fine to call often.
   */
  look(gaze: { yaw: number; pitch: number } | null): void {
    if (this.destroyed || this.reduceMotion) return;
    const now = this.now();
    this.engine.setLook(gaze ? { yaw: gaze.yaw, pitch: gaze.pitch, mix: 1, spin: 0, wander: 0 } : null, now);
    this.extraMotionUntil = Math.max(this.extraMotionUntil, now + BotEngine.LOOK_MORPH);
    this.wake();
  }

  /** Stops everything and removes the svg. Safe to call twice; later calls do nothing. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    clearTimeout(this.blinkTimer);
    this.gate.destroy();
    this.motionQuery?.removeEventListener('change', this.onMotionPreferenceChange);
    this.view.svg.remove();
  }

  // --- time and the animation loop -----------------------------------------

  /** Seconds since the avatar was created; the engine's clock. */
  private now(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  private isMoving(): boolean {
    return this.now() < Math.max(this.stateMotionUntil, this.extraMotionUntil);
  }

  /** Starts the loop if the picture still has to change and nothing forbids drawing. */
  private wake(): void {
    if (this.destroyed || this.reduceMotion || this.frameRequest !== 0 || !this.gate.open) return;
    if (!this.isMoving()) return;
    this.frameRequest = requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (): void => {
    this.frameRequest = 0;
    // Parked, not dead: the gate wakes the loop again when the avatar can be seen.
    if (this.destroyed || !this.gate.open) return;
    this.draw();
    // The frame after the last change is drawn too, then the loop goes to sleep.
    if (this.isMoving()) this.frameRequest = requestAnimationFrame(this.onFrame);
  };

  private draw(): void {
    const frame = this.engine.sample(this.now());
    this.hasEyes = frame.eyes.length > 0;
    this.view.render(frame, this.skin.color, this.skin.eye);
  }

  /** Reduced motion: the state's most legible pose, on a fresh engine so nothing morphs. */
  private drawStill(): void {
    const frame = this.makeEngine().sample(POSES[this.state]);
    this.view.render(frame, this.skin.color, this.skin.eye);
  }

  /** Redraws now (for the current time), then lets the loop carry on if it has to. */
  private refresh(): void {
    if (this.destroyed) return;
    if (this.reduceMotion) {
      this.drawStill();
      return;
    }
    this.draw();
    this.wake();
  }

  private makeEngine(): BotEngine {
    const engine = new BotEngine(
      RAYON,
      this.state,
      SHAPE_BY_ID.get(this.skin.shape)!.radii,
      EXPRESSION_BY_ID.get(this.expression) ?? null,
    );
    // No drifting gaze or scheduled blinks: the face is still until blink() so the loop can sleep.
    engine.ambient = false;
    return engine;
  }

  // --- blinking --------------------------------------------------------------

  private scheduleBlink(): void {
    if (this.destroyed || this.reduceMotion) return;
    this.blinkTimer = setTimeout(this.onBlinkTimer, nextBlinkDelayMs());
  }

  private readonly onBlinkTimer = (): void => {
    if (this.destroyed || this.reduceMotion) return;
    if (this.hasEyes && this.gate.open) {
      const now = this.now();
      this.engine.blink(now);
      this.extraMotionUntil = Math.max(this.extraMotionUntil, now + BLINK_SECONDS);
      this.wake();
    }
    this.scheduleBlink();
  };

  // --- the world around us -----------------------------------------------------

  private readonly onGateChange = (open: boolean): void => {
    // A blink may have been cut in half while hidden: draw the current picture again.
    if (open) this.refresh();
  };

  private readonly onMotionPreferenceChange = (): void => {
    const reduce = this.motionQuery?.matches ?? false;
    if (this.destroyed || reduce === this.reduceMotion) return;
    this.reduceMotion = reduce;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    clearTimeout(this.blinkTimer);
    if (reduce) {
      this.drawStill();
      return;
    }
    // Back to live: start the current state's entrance from its beginning.
    this.engine = this.makeEngine();
    const now = this.now();
    this.engine.reset(this.state, now);
    this.stateMotionUntil = now + motionSeconds(this.state);
    this.extraMotionUntil = 0;
    this.refresh();
    this.scheduleBlink();
  };
}
