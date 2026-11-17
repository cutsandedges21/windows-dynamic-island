// The island on the phone, drawn by the island's own renderers exactly as Duplicate mode's copy
// (src/core/mirror.ts runMirror) draws it: PillRenderer for the pill, BorderGlow on its edge,
// BubbleView for the bot beside it (above it, upright), and SheetRenderer for the card or Control Center under it,
// riding the pill's springs. The differences are a phone's: the pill is laid out for the
// phone's width (pill-fit.ts), it always sits at the top, a hidden island shows faintly instead
// of leaving (there is no edge to wake it from), and holding a tile arranges the phone's own copy
// of Control Center in place (src/remote/grid-edit.ts GridDraft); Done sends it to the PC.
// Holding the pill grows the PC's hover card out of it (SheetView.morph, its content held still).

import { setReducedMotion } from '../../../src/core/animator';
import { BubbleView } from '../../../src/core/bubble';
import { applyGlass } from '../../../src/core/glass';
import { BorderGlow } from '../../../src/core/glow';
import type { Rect } from '../../../src/core/layout';
import type { MirrorFrame } from '../../../src/core/mirror';
import { PillRenderer, type PillCover } from '../../../src/core/renderer';
import type { Tone } from '../../../src/core/segments';
import { SheetRenderer, type SheetView } from '../../../src/core/sheet';
import { springs } from '../../../src/core/spring';
import { draftAct, draftLayout, draftOf, draftView, rebaseDraft, type GridDraft, type PhoneLayout } from '../../../src/remote/grid-edit';
import type { BotState } from '../../../src/remote/protocol';
import { maxPillWidth, phonePill, placePill } from './pill-fit';
import { isTap, type Point } from './tap';

export type ActionSink = (action: string, arg: unknown, source: HTMLElement) => void;

/** A card is this far from the screen's sides. */
export const CARD_MARGIN = 6;

/** How long a finger rests on the pill before it is held, not tapped (about an iPhone's long press). */
export const HOLD_MS = 450;
/** A swipe across the held card: this far sideways (CSS px), mostly sideways, within this long. */
const SWIPE_PX = 40;
const SWIPE_MS = 700;
/** How long after a held finger lifts its click is still the hold's (not a tap). */
const HOLD_CLICK_MS = 600;
/**
 * After a hold the pill comes back from its press (PillRenderer's 97 %) in the first frame its
 * content is out of sight under the card, at once, so it is never seen growing back; or, when no
 * card came to cover it, this long after the finger lifted, on its usual spring.
 */
const PRESS_KEEP_MS = 900;
/** Out of sight: the pill's content is at most this opaque. */
const UNSEEN = 0.02;

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
  /** Control Center arranged here: Done (or Reset layout) sends this to the PC. */
  onSaveGrid: (l: PhoneLayout) => void = () => {};
  /** Control Center being arranged (a tile was held), drawn instead of the PC's grid until Done. */
  private draft: GridDraft | null = null;
  /** Reset layout was sent: the next grid from the PC is the new starting point. */
  private rebase = false;
  private redrawQueued = false;
  /** The finger now down began on a tile while arranging: the page must not scroll under it. */
  private onTile = false;
  /** The pill was held (`key`: the segment under the finger, null for none): its hover card is asked for. */
  onHold: (key: string | null) => void = () => {};
  /** A tap away from the held card (not on it, not on the pill): it closes. */
  onAway: () => void = () => {};
  /** Whether the held card shows (or is asked for). */
  holding: () => boolean = () => false;
  /** A swipe across the held card (1: to the left, the next activity; -1: back), as over the PC's card. */
  onSwipe: (dir: 1 | -1) => void = () => {};
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** The finger on the pill that may become a hold. */
  private holdDown: (Point & { id: number }) | null = null;
  /** A held finger is down (Infinity) or lifted until then: its click is swallowed. */
  private swallowUntil = 0;
  /** The pill keeps its press after a hold till its content is out of sight under the card (letPressGo). */
  private pressKept = false;
  private pressFrame = 0;
  /** When the held finger lifted (null: still down). */
  private liftedAt: number | null = null;
  /** A finger that went down away from the held card. */
  private awayDown: (Point & { id: number }) | null = null;
  /** The pill's light, kept while a card grown out of the pill covers it. */
  private pillGlow: Parameters<BorderGlow['set']>[0] = null;
  private covered = false;
  /** Takes the window's listeners away with the view. */
  private readonly gone = new AbortController();

  constructor(host: HTMLElement, onAction: ActionSink) {
    this.stage = document.createElement('div');
    this.stage.className = 'ph-stage';
    host.append(this.stage);
    // The island's order: pill, card, the pill's light, the bot, the card's light.
    this.renderer = new PillRenderer(this.stage, onAction);
    // The grid's arranging actions stay on the phone (its draft); every other action goes to the PC.
    this.sheet = new SheetRenderer(
      this.stage,
      (action, arg, source) => (action.startsWith('island:grid-') ? this.gridAction(action, arg) : onAction(action, arg, source)),
      () => this.cardMoved(),
      (cover) => this.coverPill(cover),
      { still: true },
    );
    this.glow = new BorderGlow(this.stage);
    this.bubble = new BubbleView(this.stage, { interactive: false });
    this.cardGlow = new BorderGlow(this.stage, 24);
    this.renderer.onFrame((r) => {
      this.glow.place(r);
      this.sheet.follow(r);
    });
    this.stage.addEventListener('pointerdown', (e) => this.lookAt(e), { passive: true });
    this.guardScroll();
    this.watchHold();
    this.watchSwipe();
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
    applyGlass(root, frame.glass);
    const reduce = frame.reduce || matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduce);
    root.classList.toggle('reduce', reduce);
    this.bubble.colour(frame.accent);
    if (bot) this.bubble.show(bot.look, bot.play, bot.strength);
    this.layoutPill(frame, false);
    if (frame.speed === 'off' || frame.hidden || !frame.glow) this.pillGlow = null;
    else {
      this.glow.setSpeed(frame.speed);
      this.pillGlow = frame.glow;
    }
    this.glow.set(this.covered ? null : this.pillGlow);
  }

  /** A card grown out of the pill stands in for it: the pill fades under it and its light goes till it is back. */
  private coverPill(cover: PillCover): void {
    this.renderer.setCover(cover);
    this.covered = cover !== 'off';
    this.glow.set(this.covered ? null : this.pillGlow);
  }

  /** A held pill's press goes (see PRESS_KEEP_MS): looked for every frame from when the finger lifts. */
  private letPressGo(): void {
    cancelAnimationFrame(this.pressFrame);
    const step = () => {
      const lifted = this.liftedAt;
      if (!this.pressKept || lifted === null) return;
      const content = this.renderer.pill.querySelector<HTMLElement>('.pill-content');
      const unseen = content !== null && Number(getComputedStyle(content).opacity) <= UNSEEN;
      if (unseen || performance.now() - lifted >= PRESS_KEEP_MS) {
        this.pressKept = false;
        this.liftedAt = null;
        this.renderer.unpress(unseen);
        return;
      }
      this.pressFrame = requestAnimationFrame(step);
    };
    step();
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
    if (this.draft) {
      if (this.rebase) {
        // After Reset layout: arranging goes on from the PC's fresh layout.
        this.rebase = false;
        this.draft = draftOf(view);
      } else if (!rebaseDraft(this.draft, view)) this.draft = null;
    }
    this.urgent = view ? urgent : null;
    this.showView(false);
  }

  private showView(immediate: boolean): void {
    const v = this.draft ? draftView(this.draft, true) : this.view;
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

  /** Whether Control Center is being arranged. */
  get arranging(): boolean {
    return this.draft !== null;
  }

  /**
   * The grid's own arranging (sheet.ts wireGrid and its edit controls), run on the phone's draft as
   * the island runs it on its grid: holding a tile starts it, Done sends the layout, Reset layout
   * asks the PC for its default one.
   */
  private gridAction(action: string, arg: unknown): void {
    if (action === 'island:grid-edit' && !this.draft) {
      if (this.view?.key !== 'island/grid') return;
      this.draft = draftOf(this.view);
      this.rebase = false;
      this.redraw();
      return;
    }
    const d = this.draft;
    if (!d) return;
    const did = draftAct(d, action, arg);
    if (did === 'done') {
      const layout = draftLayout(d);
      this.draft = null;
      // Shown as arranged until the PC's saved layout comes back.
      this.view = draftView(d, false);
      this.onSaveGrid(layout);
    } else if (did === 'reset') {
      // Back to how it was before this edit: the PC's layout, which the phone has not changed yet.
      this.draft = draftOf(this.view);
    }
    if (did) this.redraw();
  }

  /** The grid redrawn on the next frame, as the island redraws after an action (a drop lands on it). */
  private redraw(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.showView(false);
    });
  }

  /**
   * While arranging, a finger that went down on a tile carries it (or its corner resizes it): the
   * card must not scroll or swipe pages under it, or the browser would take the touch away
   * (pointercancel). The hold that starts arranging is covered too: its next moves carry the tile.
   */
  private guardScroll(): void {
    this.stage.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as HTMLElement;
        this.onTile = Boolean(t.closest('.sb-tiles .tile:not(.hidden-tile)')) && !t.closest('.tile-x, .tile-add');
      },
      { capture: true, passive: true },
    );
    this.stage.addEventListener(
      'touchmove',
      (e) => {
        if (this.draft && this.onTile && e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
    for (const ev of ['pointerup', 'pointercancel']) this.stage.addEventListener(ev, () => (this.onTile = false), { capture: true, passive: true });
  }

  /**
   * Holding the pill: a finger that rests on it for HOLD_MS without travelling asks for its hover
   * card (onHold), and the click that ends it is not a tap. While the card shows, a tap anywhere
   * but on it closes it (onAway); a tap on it, or on the pill, is the pill's (island:tap closes it).
   */
  private watchHold(): void {
    const pill = this.renderer.pill;
    const signal = this.gone.signal;
    pill.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input')) return;
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key ?? null;
      this.holdDown = { x: e.clientX, y: e.clientY, id: e.pointerId };
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.holdDown = null;
        this.swallowUntil = Infinity;
        this.pressKept = true;
        this.liftedAt = null;
        this.onHold(key);
      }, HOLD_MS);
    });
    // The pill's press (PillRenderer: pressed in on the way down, back out on the way up) stays in
    // after a hold, till the card has covered it: let go of at once, the pill content grew back by
    // some pixels while it was still fading under the card.
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      this.stage.addEventListener(
        type,
        (e) => {
          if (this.pressKept && e.isTrusted && pill.contains(e.target as Node)) e.stopPropagation();
        },
        { capture: true, signal },
      );
    }
    window.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as HTMLElement;
        this.awayDown = this.holding() && !this.sheet.el.contains(t) && !pill.contains(t) ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
      },
      { capture: true, signal },
    );
    window.addEventListener(
      'pointermove',
      (e) => {
        const d = this.holdDown;
        if (d && d.id === e.pointerId && !isTap(d, { x: e.clientX, y: e.clientY })) this.stopHold();
      },
      { capture: true, signal },
    );
    window.addEventListener(
      'pointerup',
      (e) => {
        this.stopHold();
        const away = this.awayDown;
        this.awayDown = null;
        if (away && away.id === e.pointerId && isTap(away, { x: e.clientX, y: e.clientY }) && this.holding()) this.onAway();
      },
      { capture: true, signal },
    );
    window.addEventListener(
      'pointercancel',
      () => {
        this.stopHold();
        this.awayDown = null;
      },
      { capture: true, signal },
    );
    // The click that ends a hold (on the pill, or on the card that grew over it) is no tap.
    this.stage.addEventListener(
      'click',
      (e) => {
        if (performance.now() >= this.swallowUntil) return;
        this.swallowUntil = 0;
        e.stopPropagation();
        e.preventDefault();
      },
      { capture: true, signal },
    );
  }

  /**
   * A finger swiped sideways across the held card: the next activity's card (Justin), as a
   * sideways swipe over the PC's card steps through them. Touch events, so the browser's own
   * scrolling of the card never cancels it; not from the scrubber, a slider or the lyrics' line.
   */
  private watchSwipe(): void {
    const el = this.sheet.el;
    const signal = this.gone.signal;
    let start: (Point & { at: number }) | null = null;
    el.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0];
        const on = e.target as HTMLElement;
        start = e.touches.length === 1 && this.holding() && !on.closest('.pl-scrub, .pl-ly-grip, .hs, input, textarea') ? { x: t.clientX, y: t.clientY, at: performance.now() } : null;
      },
      { passive: true, signal },
    );
    el.addEventListener(
      'touchend',
      (e) => {
        const s = start;
        start = null;
        const t = e.changedTouches[0];
        if (!s || !t || !this.holding()) return;
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5 || performance.now() - s.at > SWIPE_MS) return;
        // The click a swipe would end in is no tap.
        this.swallowUntil = performance.now() + 400;
        this.onSwipe(dx < 0 ? 1 : -1);
      },
      { passive: true, signal },
    );
    el.addEventListener('touchcancel', () => (start = null), { passive: true, signal });
  }

  /** The finger on the pill lifted or travelled: no hold now; a held one's click is still swallowed for a moment. */
  private stopHold(): void {
    clearTimeout(this.holdTimer);
    this.holdDown = null;
    if (this.swallowUntil !== Infinity) return;
    this.swallowUntil = performance.now() + HOLD_CLICK_MS;
    this.liftedAt = performance.now();
    this.letPressGo();
  }

  destroy(): void {
    clearTimeout(this.lookTimer);
    clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.pressFrame);
    this.gone.abort();
    this.bubble.destroy();
    this.glow.destroy();
    this.cardGlow.destroy();
    this.stage.remove();
  }
}
