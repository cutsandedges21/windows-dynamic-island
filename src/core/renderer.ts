// The rendered pill. One shell element whose position and size are springs,
// and one keyed node per segment. A segment whose key survives a layout change
// slides and resizes to its new place; new ones blur-fade in, old ones blur-fade
// out. Content is positioned relative to the pill's fixed point (centre for
// top/bottom, the pinned edge for left/right), so growth reveals content instead
// of shoving it. Per frame only transform, opacity, filter and the shell's size
// are written; nothing is read back from layout.

import { SpringSet, reducedMotion } from './animator';
import { icon } from './icons';
import { contentOrigin, fixedPointX, innerPadding, type Anchor, type Orientation, type Rect } from './layout';
import { springEasing, springs, type SpringConfig } from './spring';
import type { Placed, Seg } from './segments';

export type ActionHandler = (action: string, arg: unknown, source: HTMLElement) => void;

type NodeKeys = 'x' | 'w' | 'o' | 's' | 'b';

interface SegNode {
  key: string;
  seg: Seg;
  el: HTMLElement;
  set: SpringSet<NodeKeys>;
  sizable: boolean;
  leaving: boolean;
  fill?: SpringSet<'v'>;
}

const ENTER = { o: 0, s: 0.82, b: 7 };
const args = new WeakMap<HTMLElement, unknown>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html; // static icon markup only
  return e;
}

/** Fire-and-forget compositor animation with a spring curve. */
export function springAnimate(target: Element, keyframes: Keyframe[], cfg: SpringConfig = springs.content, extra: KeyframeAnimationOptions = {}): Animation | null {
  if (!target.animate) return null;
  if (reducedMotion()) return target.animate(keyframes, { duration: 1, fill: extra.fill });
  const { easing, duration } = springEasing(cfg);
  return target.animate(keyframes, { duration, easing, ...extra });
}

export class PillRenderer {
  readonly pill: HTMLElement;
  private readonly content: HTMLElement;
  private readonly shell: SpringSet<'x' | 'y' | 'w' | 'h' | 's' | 'dx' | 'dy'>;
  private readonly nodes = new Map<string, SegNode>();
  private anchor: Anchor = 'top';
  private orientation: Orientation = 'horizontal';
  private onShellFrame: ((r: Rect) => void) | null = null;
  private focusInput: HTMLInputElement | null = null;

  constructor(stage: HTMLElement, private readonly onAction: ActionHandler) {
    this.pill = el('div', 'pill');
    this.pill.append(el('div', 'pill-glow'), el('div', 'pill-bg'));
    this.content = el('div', 'pill-content');
    this.pill.append(this.content);
    stage.append(this.pill);

    this.shell = new SpringSet(
      { x: 0, y: -60, w: 120, h: 30, s: 1, dx: 0, dy: 0 },
      (v) => {
        const p = this.pill.style;
        p.transform = `translate3d(${v.x + v.dx}px, ${v.y + v.dy}px, 0) scale(${v.s})`;
        p.width = `${v.w}px`;
        p.height = `${v.h}px`;
        p.borderRadius = `${v.h / 2}px`;
        const o = contentOrigin(this.anchor, this.orientation, v.w, v.h);
        this.content.style.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
        this.onShellFrame?.({ x: v.x + v.dx, y: v.y + v.dy, w: v.w, h: v.h });
      },
      springs.shell,
      { s: 0.0005, dx: 0.05, dy: 0.05 },
    );

    this.pill.addEventListener('click', (e) => this.handleClick(e));
    this.pill.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onAction('island:menu', null, this.pill);
    });
    this.pill.addEventListener('wheel', (e) => this.onAction('island:wheel', Math.sign(e.deltaY || e.deltaX), this.pill), { passive: true });
    this.pill.addEventListener('pointerenter', () => this.onAction('island:hover', true, this.pill));
    this.pill.addEventListener('pointerleave', () => this.onAction('island:hover', false, this.pill));
    // Which segment the pointer rests on: hovering a chip asks that activity for its card.
    this.pill.addEventListener('pointerover', (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key ?? null;
      this.onAction('island:hover-key', key, this.pill);
    });
    this.pill.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('input')) return;
      this.shell.set({ s: 0.972 }, { config: springs.snappy });
    });
    const release = () => this.shell.set({ s: 1 }, { config: springs.bouncy });
    this.pill.addEventListener('pointerup', release);
    this.pill.addEventListener('pointercancel', release);
  }

  /** Called on every shell frame with the drawn rect (for hit testing). */
  onFrame(cb: (r: Rect) => void): void {
    this.onShellFrame = cb;
  }

  get rect(): Rect {
    return { x: this.shell.get('x'), y: this.shell.get('y'), w: this.shell.get('w'), h: this.shell.get('h') };
  }

  get targetRect(): Rect {
    return { x: this.shell.target('x'), y: this.shell.target('y'), w: this.shell.target('w'), h: this.shell.target('h') };
  }

  get moving(): boolean {
    return !this.shell.settled;
  }

  /** Horizontal ⇄ vertical: the content dissolves while the shell reshapes, then re-forms. */
  setOrientation(orientation: Orientation): void {
    if (orientation === this.orientation) return;
    for (const node of [...this.nodes.values()]) this.remove(node, true);
    this.orientation = orientation;
    this.content.classList.toggle('vertical', orientation === 'vertical');
  }

  setAnchor(anchor: Anchor): void {
    if (anchor === this.anchor) return;
    if (this.orientation === 'vertical') {
      this.anchor = anchor;
      return;
    }
    // Keep every node where it is on screen while the reference point changes.
    const w = this.shell.get('w');
    const shift = fixedPointX(this.anchor, w) - fixedPointX(anchor, w);
    this.anchor = anchor;
    for (const n of this.nodes.values()) {
      const x = n.set.get('x') + shift;
      n.set.springs.x.value = x;
      n.set.springs.x.target += shift;
    }
  }

  setShell(r: Rect, opts: { config?: SpringConfig; immediate?: boolean } = {}): void {
    this.shell.set({ x: r.x, y: r.y, w: r.w, h: r.h }, { config: opts.config ?? springs.shell, immediate: opts.immediate });
  }

  /** A sideways wobble: the island shaking its head (alerts, failed actions). */
  shake(strength = 1): void {
    const wobble = { response: 0.3, damping: 0.24 };
    if (this.anchor === 'left' || this.anchor === 'right') {
      this.shell.set({ dy: 0 }, { config: wobble });
      this.shell.impulse('dy', 230 * strength);
    } else {
      this.shell.set({ dx: 0 }, { config: wobble });
      this.shell.impulse('dx', 230 * strength);
    }
  }

  /** A short nod towards the screen: something new arrived. */
  bump(): void {
    const v = this.anchor === 'top' ? 1 : this.anchor === 'bottom' ? -1 : 0;
    const h = this.anchor === 'left' ? 1 : this.anchor === 'right' ? -1 : 0;
    if (v) this.shell.impulse('dy', 140 * v);
    if (h) this.shell.impulse('dx', 140 * h);
    this.shell.set({ s: 1 }, { config: springs.bouncy });
    this.shell.impulse('s', 0.6);
  }

  glow(tone: string): void {
    const g = this.pill.querySelector<HTMLElement>('.pill-glow');
    if (!g) return;
    g.dataset.tone = tone;
    springAnimate(g, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { response: 1.4, damping: 1 }, { duration: 1400, easing: 'ease-out' });
  }

  /**
   * Lays out `placed` for a pill of size (w, h). `swap` means the content is a
   * different activity: leaving nodes go first and new ones arrive a beat later.
   */
  render(placed: Placed[], w: number, h: number, opts: { swap?: boolean; immediate?: boolean } = {}): void {
    const vert = this.orientation === 'vertical';
    const pad = innerPadding(vert ? w : h);
    const fx = vert ? h / 2 : fixedPointX(this.anchor, w);
    const seen = new Set<string>();
    let entering = 0;
    for (const p of placed) {
      const key = p.seg.key;
      seen.add(key);
      const x = pad + p.x - fx;
      let node = this.nodes.get(key);
      if (node && (node.leaving || node.seg.t !== p.seg.t)) {
        this.remove(node, true);
        node = undefined;
      }
      if (!node) {
        node = this.create(p.seg, x, p.w);
        const delay = opts.immediate ? 0 : (opts.swap ? 90 : 30) + Math.min(entering, 6) * 22;
        entering += 1;
        if (opts.immediate) node.set.set({ o: 1, s: 1, b: 0 }, { immediate: true });
        else setTimeout(() => node && !node.leaving && node.set.set({ o: 1, s: 1, b: 0 }, { config: { x: springs.content, w: springs.content, o: springs.fade, s: springs.bouncy, b: springs.fade } }), delay);
      } else {
        this.patch(node, p.seg);
        node.set.set({ x, w: p.w }, { config: springs.content, immediate: opts.immediate });
      }
    }
    for (const node of this.nodes.values()) if (!seen.has(node.key) && !node.leaving) this.remove(node, !opts.immediate);
  }

  focusedInput(): HTMLInputElement | null {
    return this.focusInput && this.focusInput.isConnected ? this.focusInput : null;
  }

  // ---------------------------------------------------------------- nodes

  private create(seg: Seg, x: number, w: number): SegNode {
    const elem = this.build(seg);
    elem.dataset.key = seg.key;
    this.content.append(elem);
    const vert = this.orientation === 'vertical';
    const sizable = seg.t !== 'icon' && seg.t !== 'dot' && seg.t !== 'bars' && (vert || seg.t !== 'sep');
    const node: SegNode = {
      key: seg.key,
      seg,
      el: elem,
      sizable,
      leaving: false,
      set: new SpringSet<NodeKeys>(
        { x, w, ...ENTER },
        (v) => {
          const st = elem.style;
          st.transform = vert ? `translate3d(-50%, ${v.x}px, 0) scale(${v.s})` : `translate3d(${v.x}px, -50%, 0) scale(${v.s})`;
          st.opacity = String(Math.max(0, Math.min(1, v.o)));
          st.filter = v.b > 0.08 ? `blur(${v.b.toFixed(2)}px)` : '';
          if (sizable) st.width = `${Math.max(0, v.w)}px`;
        },
        springs.content,
        { o: 0.002, s: 0.0005, b: 0.02 },
      ),
    };
    this.applyFill(node, seg, true);
    this.nodes.set(seg.key, node);
    return node;
  }

  private remove(node: SegNode, animate: boolean): void {
    node.leaving = true;
    this.nodes.delete(node.key);
    node.el.style.pointerEvents = 'none';
    if (node.el.querySelector('input') === this.focusInput) this.focusInput = null;
    if (!animate) {
      node.set.stop();
      node.el.remove();
      return;
    }
    node.set.set({ o: 0, s: 0.86, b: 6 }, { config: { o: springs.fade, s: springs.snappy, b: springs.fade } });
    node.set.onRest(() => node.el.remove());
  }

  private build(seg: Seg): HTMLElement {
    let e: HTMLElement;
    switch (seg.t) {
      case 'icon':
        e = el('span', `seg seg-icon sz-${seg.size ?? 'md'}`, icon(seg.icon));
        break;
      case 'dot':
        e = el('span', 'seg seg-dot', '<i class="ring"></i><i class="core"></i>');
        break;
      case 'text':
        e = el('span', 'seg seg-text');
        e.append(el('span', 't'));
        break;
      case 'progress':
        e = el('span', 'seg seg-progress', '<i class="track"></i><i class="fill"></i><i class="pace"></i>');
        break;
      case 'bars':
        e = el('span', 'seg seg-bars', '<i></i><i></i><i></i><i></i>');
        break;
      case 'button':
        e = el('button', 'seg seg-btn');
        (e as HTMLButtonElement).type = 'button';
        break;
      case 'chip':
        e = el('button', 'seg seg-chip');
        (e as HTMLButtonElement).type = 'button';
        break;
      case 'input': {
        e = el('span', 'seg seg-input');
        const input = el('input', '');
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        const send = el('button', 'send', icon('enter'));
        send.type = 'button';
        e.append(input, send);
        input.addEventListener('keydown', (ev) => {
          const s = this.nodes.get(seg.key)?.seg ?? seg;
          if (s.t !== 'input') return;
          if (ev.key === 'Enter' && input.value.trim()) {
            ev.preventDefault();
            this.onAction(s.action, input.value.trim(), e);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            this.onAction(s.cancel ?? 'island:cancel-input', null, e);
          }
        });
        send.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const s = this.nodes.get(seg.key)?.seg ?? seg;
          if (s.t === 'input' && input.value.trim()) this.onAction(s.action, input.value.trim(), e);
        });
        this.focusInput = input;
        break;
      }
      case 'art':
        e = el('span', 'seg seg-art');
        break;
      case 'sep':
        e = el('span', 'seg seg-sep');
        break;
      case 'meter':
        e = el('span', 'seg seg-meter', '<span class="ml"></span><span class="mb"><i class="fill"></i><i class="pace"></i></span><span class="mv"></span>');
        break;
      case 'gap':
        e = el('span', 'seg seg-gap');
        break;
    }
    this.patchInto(e, seg, null);
    return e;
  }

  private patch(node: SegNode, seg: Seg): void {
    const prev = node.seg;
    node.seg = seg;
    this.patchInto(node.el, seg, prev);
    this.applyFill(node, seg, false);
  }

  /** Brings an element in line with its segment. `prev` is null on creation. */
  private patchInto(e: HTMLElement, seg: Seg, prev: Seg | null): void {
    const tone = 'tone' in seg && seg.tone ? seg.tone : 'default';
    if (seg.tip) e.title = seg.tip;
    else e.removeAttribute('title');
    switch (seg.t) {
      case 'icon': {
        e.className = `seg seg-icon sz-${seg.size ?? 'md'} tone-${tone}${seg.anim ? ` anim-${seg.anim}` : ''}`;
        if (!prev || (prev.t === 'icon' && prev.icon !== seg.icon)) {
          e.innerHTML = icon(seg.icon);
          if (prev) springAnimate(e.firstElementChild!, [{ transform: 'scale(0.5) rotate(-30deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], springs.bouncy);
        }
        break;
      }
      case 'dot':
        e.className = `seg seg-dot tone-${seg.tone}${seg.pulse ? ' pulse' : ''}`;
        if (prev && prev.t === 'dot' && prev.tone !== seg.tone) {
          springAnimate(e.querySelector('.core')!, [{ transform: 'scale(1.9)' }, { transform: 'scale(1)' }], springs.bouncy);
        }
        break;
      case 'text': {
        e.className = `seg seg-text sz-${seg.size ?? 'md'} w-${seg.weight ?? 'medium'} tone-${tone}`;
        const current = e.querySelector<HTMLElement>('.t:not(.out)')!;
        if (current.textContent !== seg.text) {
          // Clocks, timers and counters just tick in place; only wording changes roll.
          if (!prev || prev.t !== 'text' || (timeLike(current.textContent ?? '') && timeLike(seg.text))) current.textContent = seg.text;
          else this.rollText(e, current, seg.text);
        }
        break;
      }
      case 'progress': {
        e.className = `seg seg-progress tone-${tone}${seg.value == null ? ' indeterminate' : ''}`;
        const pace = e.querySelector<HTMLElement>('.pace')!;
        pace.style.opacity = seg.pace == null ? '0' : '1';
        if (seg.pace != null) pace.style.left = `${seg.pace * 100}%`;
        break;
      }
      case 'bars':
        e.className = `seg seg-bars tone-${tone}${seg.active ? ' active' : ''}`;
        break;
      case 'button': {
        e.className = `seg seg-btn style-${seg.style ?? 'secondary'}${seg.label ? '' : ' icon-only'}`;
        const html = `${seg.icon ? icon(seg.icon) : ''}${seg.label ? `<span class="bl"></span>` : ''}`;
        if (!prev || prev.t !== 'button' || prev.icon !== seg.icon || Boolean(prev.label) !== Boolean(seg.label)) e.innerHTML = html;
        const bl = e.querySelector('.bl');
        if (bl) bl.textContent = seg.label ?? '';
        e.dataset.action = seg.action;
        args.set(e, seg.arg);
        break;
      }
      case 'chip': {
        e.className = `seg seg-chip tone-${tone}${seg.selected ? ' selected' : ''}${seg.action ? '' : ' passive'}`;
        const sig = `${seg.dot ?? ''}|${seg.icon ?? ''}|${seg.badge ?? ''}|${seg.pulse ? 1 : 0}`;
        if (e.dataset.sig !== sig) {
          e.dataset.sig = sig;
          e.innerHTML = `${seg.dot ? `<span class="cd tone-${seg.dot}${seg.pulse ? ' pulse' : ''}"><i class="ring"></i><i class="core"></i></span>` : ''}${seg.icon ? icon(seg.icon) : ''}<span class="cl"></span>${seg.badge ? '<span class="cb"></span>' : ''}`;
        }
        e.querySelector('.cl')!.textContent = seg.label;
        const cb = e.querySelector('.cb');
        if (cb) cb.textContent = seg.badge ?? '';
        if (seg.action) e.dataset.action = seg.action;
        else delete e.dataset.action;
        args.set(e, seg.arg);
        break;
      }
      case 'input': {
        const input = e.querySelector('input')!;
        input.placeholder = seg.placeholder;
        if (seg.value !== undefined && !prev) input.value = seg.value;
        break;
      }
      case 'art': {
        e.className = `seg seg-art${seg.round ? ' round' : ''}`;
        const src = seg.src ?? '';
        if (e.dataset.src !== src || !prev) {
          e.dataset.src = src;
          if (src) {
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.src = src;
            e.replaceChildren(img);
          } else {
            e.innerHTML = icon(seg.icon ?? 'music');
          }
          if (prev && e.firstElementChild) springAnimate(e.firstElementChild, [{ opacity: 0, transform: 'scale(0.86)' }, { opacity: 1, transform: 'none' }], springs.content);
        }
        break;
      }
      case 'meter': {
        e.className = `seg seg-meter tone-${tone}`;
        e.querySelector('.ml')!.textContent = seg.label;
        e.querySelector('.mv')!.textContent = seg.text;
        const pace = e.querySelector<HTMLElement>('.pace')!;
        pace.style.opacity = seg.pace == null ? '0' : '1';
        if (seg.pace != null) pace.style.left = `${seg.pace * 100}%`;
        break;
      }
      default:
        break;
    }
  }

  /** Progress-like fills spring from their old value (scaleX, composited). */
  private applyFill(node: SegNode, seg: Seg, fresh: boolean): void {
    const value = seg.t === 'progress' ? seg.value : seg.t === 'meter' ? seg.value : undefined;
    if (value === undefined) return;
    const fillEl = node.el.querySelector<HTMLElement>('.fill');
    if (!fillEl) return;
    if (value == null) {
      fillEl.style.transform = '';
      return;
    }
    const v = Math.max(0, Math.min(1, value));
    if (!node.fill) {
      node.fill = new SpringSet({ v: fresh ? 0 : v }, (s) => {
        fillEl.style.transform = `scaleX(${Math.max(0, s.v)})`;
      }, springs.gentle, { v: 0.0005 });
    }
    node.fill.set({ v });
  }

  /** The old text slides up and out while the new one rises in. */
  private rollText(e: HTMLElement, current: HTMLElement, text: string): void {
    const next = el('span', 't');
    next.textContent = text;
    current.classList.add('out');
    e.append(next);
    springAnimate(current, [{ transform: 'translateY(0)', opacity: 1, filter: 'blur(0px)' }, { transform: 'translateY(-70%)', opacity: 0, filter: 'blur(3px)' }], springs.snappy, { fill: 'forwards' })?.finished
      .then(() => current.remove(), () => current.remove());
    springAnimate(next, [{ transform: 'translateY(70%)', opacity: 0, filter: 'blur(3px)' }, { transform: 'translateY(0)', opacity: 1, filter: 'blur(0px)' }], springs.content);
    if (reducedMotion()) current.remove();
  }

  private handleClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target && this.pill.contains(target)) {
      e.stopPropagation();
      springAnimate(target, [{ transform: getComputedTransform(target, 0.9) }, { transform: getComputedTransform(target, 1) }], springs.bouncy);
      this.onAction(target.dataset.action!, args.get(target), target);
      return;
    }
    if ((e.target as HTMLElement).closest('input')) return;
    this.onAction('island:tap', null, this.pill);
  }
}

/** Times, counts and percentages: "0:52", "12m 43s", "84%", "4.1M", "9:41 PM". */
export function timeLike(text: string): boolean {
  return /\d/.test(text) && /^[\d\s:./%,+\-–hmsdkKMBGTAP]+$/.test(text);
}

/** The element's own translate with a different scale, for a press pulse. */
function getComputedTransform(e: HTMLElement, scale: number): string {
  const t = e.style.transform || '';
  const base = t.replace(/scale\([^)]*\)/, '').trim();
  return `${base} scale(${scale})`;
}
