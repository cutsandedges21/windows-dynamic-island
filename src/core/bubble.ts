// The bot's bubble: a round shape beside the pill with the bot inside (the bloub engine in
// src/fx/bot, dressed in the user's accent) and, over it, the costume of whatever it reacts to.
// It has its own springs. The island places it beside the pill's resting spot, so it stays on
// screen when the idle pill tucks away. Its eyes rest in the middle; a pointer close to the bot
// pulls them a little (src/core/gaze.ts), and now and then it glances to one side.

import { BotAvatar, botColors, type BotState } from '../fx';
import { SpringSet } from './animator';
import { gazeToward, REST_GAZE } from './gaze';
import type { Rect } from './layout';
import { springs } from './spring';

/** Between two idle glances, and how long one lasts. */
const GLANCE_MIN_MS = 8000;
const GLANCE_MAX_MS = 20000;
const GLANCE_HOLD_MS = 1300;

export interface BubbleOptions {
  /** The island's bubble takes clicks; a Duplicate copy only looks. */
  interactive: boolean;
  onClick?: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class BubbleView {
  readonly el: HTMLElement;
  /** Breathes, and later carries the motion of a mood or moment. */
  readonly life: HTMLElement;
  /** Headphones, notes, zzz…: drawn over the bot, free to spill past the bubble. */
  readonly costume: HTMLElement;
  private readonly avatar: BotAvatar;
  private readonly set: SpringSet<'x' | 'y' | 'd' | 'o' | 's'>;
  private target: Rect | null = null;
  private accent = '';
  private pointerNear = false;
  private gaze: { yaw: number; pitch: number } | null = null;
  private state: BotState = 'idle';
  private glanceTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(stage: HTMLElement, opts: BubbleOptions) {
    this.el = document.createElement('div');
    this.el.className = 'bubble';
    const bg = document.createElement('div');
    bg.className = 'bubble-bg';
    this.life = document.createElement('div');
    this.life.className = 'bubble-life';
    const bot = document.createElement('div');
    bot.className = 'bubble-bot';
    this.costume = document.createElement('div');
    this.costume.className = 'bubble-costume';
    this.life.append(bot, this.costume);
    this.el.append(bg, this.life);
    if (!opts.interactive) this.el.classList.add('passive');
    else if (opts.onClick) {
      const click = opts.onClick;
      this.el.addEventListener('click', (e) => {
        e.stopPropagation();
        click();
      });
    }
    stage.append(this.el);

    const { body, eye } = botColors('#6aa6e8');
    this.avatar = new BotAvatar(bot, { size: 28, state: 'idle', color: body, eye });
    this.set = new SpringSet(
      { x: 0, y: 0, d: 36, o: 0, s: 0.6 },
      (v) => {
        const st = this.el.style;
        st.width = `${v.d}px`;
        st.height = `${v.d}px`;
        st.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`;
        st.opacity = String(clamp(v.o, 0, 1));
      },
      springs.shell,
      { o: 0.002, s: 0.0005 },
    );
    this.avatar.look(REST_GAZE);
    this.scheduleGlance();
  }

  /** Where the bubble rests; null takes it away. Coming back from away, it jumps to its spot and grows there. */
  place(rect: Rect | null, opts: { immediate?: boolean } = {}): void {
    const appearing = rect !== null && this.target === null;
    this.target = rect;
    if (!rect) {
      this.set.set({ o: 0, s: 0.6 }, { config: { o: springs.fade, s: springs.snappy }, immediate: opts.immediate });
      return;
    }
    if (appearing) this.set.set({ x: rect.x, y: rect.y, d: rect.w }, { immediate: true });
    this.set.set({ x: rect.x, y: rect.y, d: rect.w, o: 1, s: 1 }, { config: { x: springs.shell, y: springs.shell, d: springs.shell, o: springs.fade, s: springs.bouncy }, immediate: opts.immediate });
  }

  /**
   * Where the bubble takes clicks: its resting spot (not the springs' current one, so it is
   * clickable as soon as it is placed, before it has grown in), or null while it is away.
   */
  get hitRect(): Rect | null {
    return this.target ? { ...this.target } : null;
  }

  get visible(): boolean {
    return this.target !== null;
  }

  /** The user's accent (as the pill draws it: a white accent is dark on a white pill). */
  colour(accent: string): void {
    if (accent === this.accent) return;
    this.accent = accent;
    const { body, eye } = botColors(accent);
    this.avatar.setSkin({ color: body, eye });
  }

  setState(state: BotState): void {
    if (state === this.state) return;
    this.state = state;
    this.avatar.setState(state);
    if (!this.pointerNear) this.rest();
  }

  /** The pointer in window coordinates while it is near the island, or null once it has gone. */
  lookAt(point: { x: number; y: number } | null): void {
    if (this.destroyed) return;
    const d = this.set.get('d');
    const gaze = point && this.target ? gazeToward(point.x - (this.set.get('x') + d / 2), point.y - (this.set.get('y') + d / 2)) : null;
    if (!gaze) {
      if (this.pointerNear) {
        this.pointerNear = false;
        this.gaze = null;
        this.rest();
        this.scheduleGlance();
      }
      return;
    }
    this.pointerNear = true;
    clearTimeout(this.glanceTimer);
    // Small moves are not worth a new ease: the eyes would only tremble.
    if (this.gaze && Math.abs(gaze.yaw - this.gaze.yaw) < 1 && Math.abs(gaze.pitch - this.gaze.pitch) < 1) return;
    this.gaze = gaze;
    this.avatar.look(gaze);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.glanceTimer);
    this.avatar.destroy();
    this.set.stop();
    this.el.remove();
  }

  /** Where the eyes go with no pointer near: at you when idle, the pose's own gaze otherwise. */
  private rest(): void {
    this.avatar.look(this.state === 'idle' ? REST_GAZE : null);
  }

  /** With no pointer near, a look to one side now and then, and back. */
  private scheduleGlance(): void {
    clearTimeout(this.glanceTimer);
    if (this.destroyed) return;
    this.glanceTimer = setTimeout(() => {
      if (this.destroyed || this.pointerNear) return;
      const side = Math.random() < 0.5 ? -1 : 1;
      this.avatar.look({ yaw: side * (8 + Math.random() * 7), pitch: REST_GAZE.pitch - 3 + Math.random() * 7 });
      this.glanceTimer = setTimeout(() => {
        if (this.destroyed || this.pointerNear) return;
        this.rest();
        this.scheduleGlance();
      }, GLANCE_HOLD_MS);
    }, GLANCE_MIN_MS + Math.random() * (GLANCE_MAX_MS - GLANCE_MIN_MS));
  }
}
