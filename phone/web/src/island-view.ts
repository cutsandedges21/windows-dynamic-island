// The island on the phone, drawn by the island's own renderers exactly as Duplicate mode's copy
// (src/core/mirror.ts runMirror) draws it: PillRenderer for the pill, BorderGlow on its edge,
// BubbleView for the bot beside it (above it, upright), and SheetRenderer for the card or Control Center under it,
// riding the pill's springs. The differences are a phone's: the pill is laid out for the
// phone's width (pill-fit.ts), it always sits at the top, a hidden island shows faintly instead
// of leaving (there is no edge to wake it from), and holding a tile never starts arranging.

import { setReducedMotion } from '../../../src/core/animator';
import { BubbleView } from '../../../src/core/bubble';
import { BorderGlow } from '../../../src/core/glow';
import type { Rect } from '../../../src/core/layout';
import type { MirrorFrame } from '../../../src/core/mirror';
import { PillRenderer } from '../../../src/core/renderer';
import type { Tone } from '../../../src/core/segments';
import { SheetRenderer, type SheetView } from '../../../src/core/sheet';
import { springs } from '../../../src/core/spring';
import type { BotState } from '../../../src/remote/protocol';
import { maxPillWidth, phonePill, placePill } from './pill-fit';

export type ActionSink = (action: string, arg: unknown, source: HTMLElement) => void;

/** A card is this far from the screen's sides. */
export const CARD_MARGIN = 6;
/** Holding a tile this long would start arranging the grid on the PC (450 ms): it is cut off first. */
const HOLD_CUTOFF_MS = 380;

export class IslandView {
  readonly stage: HTMLElement;
  private readonly renderer: PillRenderer;
  private readonly sheet: SheetRenderer;
  private readonly glow: BorderGlow;
  private readonly cardGlow: BorderGlow;
  private readonly bubble: BubbleView;
  private frame: MirrorFrame | null = null;
  private sig = '';
  private pillAt: Rect = { x: 0, y: 6, w: 0, h: 36 };
  private view: SheetView | null = null;
  private urgent: Tone | null = null;
  private room = { width: 390, height: 700 };
  /** Kept free under the card (the Back button). */
  private reserve = 0;
  private lookTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where the card is drawn, every frame it moves (null once it is gone). */
  onCard: (r: Rect | null) => void = () => {};

  constructor(host: HTMLElement, onAction: ActionSink) {
    this.stage = document.createElement('div');
    this.stage.className = 'ph-stage';
    host.append(this.stage);
    // The island's order: pill, card, the pill's light, the bot, the card's light.
    this.renderer = new PillRenderer(this.stage, onAction);
    this.sheet = new SheetRenderer(this.stage, onAction, () => this.cardMoved());
    this.glow = new BorderGlow(this.stage);
    this.bubble = new BubbleView(this.stage, { interactive: false });
    this.cardGlow = new BorderGlow(this.stage, 24);
    this.renderer.onFrame((r) => {
      this.glow.place(r);
      this.sheet.follow(r);
    });
    this.stage.addEventListener('pointerdown', (e) => this.lookAt(e), { passive: true });
    this.guardHold();
    this.measure();
  }

  /** The pill's resting rect (where taps land). */
  get pillRect(): Rect {
    return this.pillAt;
  }

  get cardShown(): boolean {
    return this.sheet.visible;
  }

  /** Re-reads the stage's size (rotation, a new window size) and lays everything out again. */
  measure(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const changed = Math.abs(r.width - this.room.width) > 0.5 || Math.abs(r.height - this.room.height) > 0.5;
    this.room = { width: r.width, height: r.height };
    if (changed && this.frame) {
      this.sig = this.sig ? 'resized' : '';
      this.layoutPill(this.frame, true);
    }
    if (changed) this.showView(true);
  }

  /** Room under the card for the phone's own controls. */
  setReserve(px: number): void {
    if (px === this.reserve) return;
    this.reserve = px;
    this.showView(false);
  }

  /** The island's pill and its bot, from `{t:'pill'}`. */
  drawPill(frame: MirrorFrame, bot: BotState | null): void {
    const root = document.documentElement;
    root.style.setProperty('--accent', frame.accent);
    root.dataset.pill = frame.color;
    const reduce = frame.reduce || matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduce);
    root.classList.toggle('reduce', reduce);
    this.bubble.colour(frame.accent);
    if (bot) this.bubble.show(bot.look, bot.play, bot.strength);
    this.layoutPill(frame, false);
    if (frame.speed === 'off' || frame.hidden || !frame.glow) this.glow.set(null);
    else {
      this.glow.setSpeed(frame.speed);
      this.glow.set(frame.glow);
    }
  }

  private layoutPill(frame: MirrorFrame, immediate: boolean): void {
    const first = this.frame === null;
    this.frame = frame;
    const botD = frame.bot?.d ?? null;
    // Upright the bot sits above the pill; sideways beside it.
    const stacked = this.room.height > this.room.width;
    const fit = phonePill(frame, maxPillWidth(this.room.width, botD, stacked));
    const at = placePill(this.room.width, fit.w, fit.h, botD, stacked);
    const moved = at.pill.y + at.pill.h !== this.pillAt.y + this.pillAt.h;
    this.pillAt = at.pill;
    this.renderer.setOrientation('horizontal');
    this.renderer.setAnchor('top');
    this.renderer.setShell(at.pill, { config: springs.shell, immediate: first || immediate });
    this.bubble.place(at.bot, { immediate: first || immediate });
    if (fit.sig !== this.sig) {
      this.renderer.render(fit.placed, fit.w, fit.h, { swap: frame.swap && !first, immediate: first || immediate });
      this.sig = fit.sig;
    }
    if (frame.bump && !frame.hidden) this.renderer.bump();
    // Hidden on the PC (idle tucked away, hidden for a while): here it stays, faint, to tap.
    this.renderer.pill.classList.toggle('ph-tucked', frame.hidden);
    if (moved && this.view) this.showView(false);
  }

  /** What goes under the pill, from `{t:'view'}`; `urgent` lights its edge in the tone given. */
  drawView(view: SheetView | null, urgent: Tone | null): void {
    this.view = view;
    this.urgent = view ? urgent : null;
    this.showView(false);
  }

  private showView(immediate: boolean): void {
    const v = this.view;
    const width = Math.max(200, Math.min(v?.width ?? Infinity, this.room.width - CARD_MARGIN * 2));
    const top = this.pillAt.y + this.pillAt.h + 8;
    const room = Math.max(160, this.room.height - top - this.reserve - CARD_MARGIN);
    // The card's tallest is 72 % of the area it is given (sheet.ts fit): give it what is left under the pill.
    this.sheet.show(v, { anchor: 'top', area: { width: this.room.width, height: room / 0.72 }, width, immediate });
    this.cardGlow.set(v && this.urgent ? { tone: this.urgent, motion: 'orbit' } : null);
    this.stage.classList.toggle('ph-urgent', Boolean(v && this.urgent));
    this.tuneInputs();
  }

  private cardMoved(): void {
    const r = this.sheet.rect;
    if (r) this.cardGlow.place(r);
    this.onCard(this.sheet.visible ? r : null);
  }

  /** The phone keyboard: Return says Send, and nothing autocorrects a command. */
  private tuneInputs(): void {
    for (const input of this.stage.querySelectorAll<HTMLInputElement>('input:not([enterkeyhint])')) {
      input.setAttribute('enterkeyhint', 'send');
      input.setAttribute('autocapitalize', 'sentences');
    }
  }

  /** A finger near the bot: its eyes follow it for a moment. */
  private lookAt(e: PointerEvent): void {
    const s = this.stage.getBoundingClientRect();
    this.bubble.lookAt({ x: e.clientX - s.left, y: e.clientY - s.top });
    clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(() => this.bubble.lookAt(null), 1400);
  }

  /**
   * Holding a tile arranges the grid on the PC (sheet.ts wireGrid): never on a phone. The hold is
   * cut off just before it would start, so the press stays a tap or a scroll.
   */
  private guardHold(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.stage.addEventListener(
      'pointerdown',
      (e) => {
        const grid = (e.target as HTMLElement).closest<HTMLElement>('.sb-tiles');
        clearTimeout(timer);
        if (!grid) return;
        timer = setTimeout(() => grid.dispatchEvent(new PointerEvent('pointercancel', { pointerId: e.pointerId, bubbles: true })), HOLD_CUTOFF_MS);
      },
      { capture: true },
    );
    for (const ev of ['pointerup', 'pointercancel']) this.stage.addEventListener(ev, () => clearTimeout(timer), { capture: true });
  }

  destroy(): void {
    clearTimeout(this.lookTimer);
    this.bubble.destroy();
    this.glow.destroy();
    this.cardGlow.destroy();
    this.stage.remove();
  }
}
