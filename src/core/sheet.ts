// The sheet: a card hanging off the pill on the side it grows towards (below a
// top pill, above a bottom one, beside a side one). It holds what one row
// can't: a chat's last message with a reply box, a question and its options,
// sessions and limits, and the grid of everything that is switched on.
//
// Blocks are keyed like segments. A block whose description did not change is
// left alone; inputs, meters and countdowns are patched in place (typing and
// running animations survive); anything else is rebuilt. The card's height
// springs to fit its content and its position rides the pill's springs every
// frame, so the two move as one. Every string from an activity goes in through
// textContent; only icons.ts markup is set as HTML.

import { SpringSet, reducedMotion } from './animator';
import { icon } from './icons';
import type { Anchor, Area, Rect } from './layout';
import { springAnimate } from './renderer';
import type { Tone } from './segments';
import { springs } from './spring';

export type ButtonStyle = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface SheetButton {
  key: string;
  label?: string;
  icon?: string;
  action: string;
  arg?: unknown;
  style?: ButtonStyle;
  tip?: string;
}

export interface SheetRow {
  key: string;
  icon?: string;
  dot?: Tone;
  pulse?: boolean;
  title: string;
  detail?: string;
  badge?: string;
  tone?: Tone;
  action?: string;
  arg?: unknown;
  tip?: string;
  /** A small button at the row's end (shown on hover), e.g. hide. */
  button?: SheetButton;
}

export interface Choice {
  key: string;
  label: string;
  detail?: string;
  selected?: boolean;
  action: string;
  arg?: unknown;
}

export type Block =
  | { t: 'head'; key: string; icon?: string; tone?: Tone; title: string; sub?: string; buttons?: SheetButton[] }
  /** Wrapped text. `bubble` scrolls after `lines` lines (default 8). */
  | { t: 'text'; key: string; text: string; tone?: Tone; size?: 'sm' | 'md'; bubble?: boolean; lines?: number }
  | { t: 'code'; key: string; text: string }
  | { t: 'buttons'; key: string; items: SheetButton[]; align?: 'start' | 'end' | 'fill' }
  /** Never focused on its own: clicking it engages it (`engage` fires), Enter sends `action` with the text. */
  | { t: 'input'; key: string; placeholder: string; action: string; engage?: string; hint?: string }
  | { t: 'meter'; key: string; label: string; value: number; pace?: number | null; text: string; sub?: string; tone?: Tone; tip?: string }
  | { t: 'rows'; key: string; items: SheetRow[] }
  | { t: 'choices'; key: string; items: Choice[] }
  | { t: 'stats'; key: string; items: Array<{ key: string; label: string; value: string; tone?: Tone; tip?: string }> }
  /** A thin bar draining until `until` (epoch ms) out of `total` ms. */
  | { t: 'countdown'; key: string; until: number; total: number; tone?: Tone }
  /**
   * The Control Center grid. `items` already know where they sit (the island
   * packed them); `tray` holds the ones taken off the grid, shown while editing.
   */
  | { t: 'tiles'; key: string; items: Tile[]; tray?: Tile[]; cols: number; rows: number; pages: number; cell: number; editing?: boolean };

/** One cell of the open island's grid (Control Center style). */
export interface Tile {
  key: string;
  /** Default size the activity asks for: columns (1 or 2) and rows (1 or 2). */
  span?: 1 | 2;
  rows?: 1 | 2;
  /** Where the island packed it: page and 0-based cell, with its size in cells. */
  page?: number;
  col?: number;
  row?: number;
  w?: number;
  h?: number;
  tone?: Tone;
  /** Tapping the tile itself. */
  action?: string;
  arg?: unknown;
  tip?: string;
  /** Taken off the grid by the user: only shown while editing, to be put back. */
  hidden?: boolean;
  /** Size label for the resize button while editing ("2×1"). */
  sizeLabel?: string;
  body: TileBody;
}

export type TileBody =
  | { k: 'stat'; icon: string; label: string; value: string; sub?: string; progress?: number | null }
  | { k: 'battery'; pct: number; charging: boolean; head: string; sub: string }
  | { k: 'media'; art?: string | null; title: string; artist: string; playing: boolean; progress?: number | null; buttons: SheetButton[] }
  | { k: 'week'; title: string; sub: string; days: Array<{ label: string; num: number; today: boolean; busy: number }> }
  | { k: 'dots'; label: string; pct: number; sub?: string }
  | { k: 'forecast'; icon: string; temp: string; label: string; hours: Array<{ t: string; icon: string; temp: string }> }
  | { k: 'actions'; icon?: string; label: string; sub?: string; buttons: SheetButton[] }
  | { k: 'list'; icon: string; label: string; rows: SheetRow[]; empty?: string };

export interface SheetView {
  /** What the card is about. A different key cross-fades the content. */
  key: string;
  blocks: Block[];
  /** The grid: a wider card. */
  wide?: boolean;
  /** The view knows how wide it wants to be (the grid sizes itself from its cells). */
  width?: number;
}

export type SheetAction = (action: string, arg: unknown, source: HTMLElement) => void;

/** Rewrites every action in a view (the island namespaces them per activity). */
export function mapActions(blocks: Block[], fn: (action: string) => string): Block[] {
  const btn = (b: SheetButton): SheetButton => ({ ...b, action: fn(b.action) });
  const row = (r: SheetRow): SheetRow => (r.action ? { ...r, action: fn(r.action) } : r);
  const body = (b: TileBody): TileBody => {
    if (b.k === 'media' || b.k === 'actions') return { ...b, buttons: b.buttons.map(btn) };
    if (b.k === 'list') return { ...b, rows: b.rows.map(row) };
    return b;
  };
  return blocks.map((b): Block => {
    switch (b.t) {
      case 'head':
        return b.buttons ? { ...b, buttons: b.buttons.map(btn) } : b;
      case 'buttons':
        return { ...b, items: b.items.map(btn) };
      case 'input':
        return { ...b, action: fn(b.action), engage: b.engage ? fn(b.engage) : undefined };
      case 'rows':
        return { ...b, items: b.items.map(row) };
      case 'choices':
        return { ...b, items: b.items.map((c) => ({ ...c, action: fn(c.action) })) };
      case 'tiles':
        return { ...b, items: b.items.map((t) => ({ ...t, action: t.action ? fn(t.action) : undefined, body: body(t.body) })) };
      default:
        return b;
    }
  });
}

const GAP = 8;
/** The card grows out of a sliver about the size of a resting pill. */
const SLIVER = 26;
const EDGE = 8;

const args = new WeakMap<HTMLElement, unknown>();
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconEl(name: string, cls: string): HTMLElement {
  const e = make('span', cls);
  e.innerHTML = icon(name); // static markup from icons.ts
  return e;
}

interface BlockNode {
  t: Block['t'];
  sig: string;
  el: HTMLElement;
  spec: Block;
}

export class SheetRenderer {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private readonly springs: SpringSet<'h' | 'o' | 's' | 'b' | 'w'>;
  private readonly nodes = new Map<string, BlockNode>();
  private readonly tileSigs = new WeakMap<HTMLElement, string>();
  private viewKey: string | null = null;
  /** A long-press just opened edit mode: the click that ends it must not run the tile's action. */
  private swallowClick = false;
  private swallowTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tile being dragged right now, if any. */
  private drag: { key: string; el: HTMLElement; host: HTMLElement; pointer: number } | null = null;
  private shown = false;
  private anchor: Anchor = 'top';
  private area: Area = { width: 1280, height: 720 };
  private pill: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private width = 380;
  private drawn: Rect | null = null;
  private engagedInput: HTMLInputElement | null = null;
  /** The spring set writes once while it is being built; nothing to place yet. */
  private ready = false;

  constructor(
    stage: HTMLElement,
    private readonly onAction: SheetAction,
    private readonly onMove: () => void,
  ) {
    this.el = make('div', 'sheet');
    this.el.append(make('div', 'sheet-bg'));
    this.inner = make('div', 'sheet-inner');
    this.el.append(this.inner);
    this.el.style.display = 'none';
    stage.append(this.el);

    this.springs = new SpringSet(
      { h: SLIVER, o: 0, s: 0.94, b: 8, w: this.width },
      (v) => this.place(v),
      springs.shell,
      { h: 0.3, o: 0.002, s: 0.0005, b: 0.02, w: 0.3 },
    );
    this.ready = true;

    this.el.addEventListener('click', (e) => {
      // The click that ends a long-press must not also press the tile under it.
      if (this.swallowClick && (e.target as HTMLElement).closest('.sb-tiles')) {
        this.swallowClick = false;
        e.stopPropagation();
        return;
      }
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target || !this.el.contains(target)) return;
      e.stopPropagation();
      springAnimate(target, [{ transform: 'scale(0.94)' }, { transform: 'none' }], springs.bouncy);
      this.onAction(target.dataset.action!, args.get(target), target);
    });
    this.el.addEventListener('pointerenter', () => this.onAction('island:sheet-hover', true, this.el));
    this.el.addEventListener('pointerleave', () => this.onAction('island:sheet-hover', false, this.el));
  }

  get visible(): boolean {
    return this.shown;
  }

  get key(): string | null {
    return this.shown ? this.viewKey : null;
  }

  /** Where the card is drawn right now (null while hidden). */
  get rect(): Rect | null {
    return this.drawn;
  }

  /** Where the card is drawn, plus the gap to the pill (so the cursor can cross it). */
  hitRect(): Rect | null {
    const d = this.drawn;
    if (!d || this.springs.get('o') < 0.05) return null;
    switch (this.anchor) {
      case 'top':
        return { x: d.x, y: d.y - GAP, w: d.w, h: d.h + GAP };
      case 'bottom':
        return { x: d.x, y: d.y, w: d.w, h: d.h + GAP };
      case 'left':
        return { x: d.x - GAP, y: d.y, w: d.w + GAP, h: d.h };
      case 'right':
        return { x: d.x, y: d.y, w: d.w + GAP, h: d.h };
    }
  }

  /** The input the user clicked into, if it is still on the card. */
  focusedInput(): HTMLInputElement | null {
    return this.engagedInput && this.engagedInput.isConnected ? this.engagedInput : null;
  }

  /** Called on every pill frame: the card stays attached to the moving pill. */
  follow(pill: Rect): void {
    this.pill = pill;
    if (this.shown || !this.springs.settled) this.place();
  }

  /**
   * Shows `view` (or hides the card when null). `width` is the card width;
   * the island picks it from the pill and the anchor.
   */
  show(view: SheetView | null, geo: { anchor: Anchor; area: Area; width: number; immediate?: boolean }): void {
    const anchorChanged = geo.anchor !== this.anchor;
    this.anchor = geo.anchor;
    this.area = geo.area;
    this.el.dataset.anchor = geo.anchor;
    if (!view) {
      this.hide(geo.immediate || anchorChanged);
      return;
    }
    this.width = Math.round(geo.width);
    this.inner.style.setProperty('--cols', this.width >= 520 ? '4' : '2');

    const appearing = !this.shown;
    if (appearing) {
      this.el.style.display = '';
      this.shown = true;
      this.springs.set({ h: SLIVER, o: 0, s: 0.94, b: 8, w: this.width }, { immediate: true });
    } else {
      // A new width (the hover card turning into the Control Center as the pill opens)
      // springs with the pill instead of jumping in one frame.
      this.springs.set({ w: this.width }, { config: springs.shell, immediate: geo.immediate });
    }
    let changed = false;
    if (view.key !== this.viewKey) {
      if (!appearing && this.viewKey !== null) this.crossFade();
      else this.clear();
      this.viewKey = view.key;
      changed = true;
    }
    this.pinInner(this.inner, this.width);
    changed = this.patch(view.blocks) || changed;
    if (changed || appearing) this.fit(geo.immediate === true);
    if (appearing) this.springs.set({ o: 1, s: 1, b: 0 }, { config: { o: springs.fade, s: springs.bouncy, b: springs.fade }, immediate: geo.immediate });
  }

  // ---------------------------------------------------------------- placement

  private hide(immediate: boolean): void {
    if (!this.shown) return;
    this.shown = false;
    this.viewKey = null;
    this.engagedInput = null;
    const done = () => {
      if (this.shown) return;
      this.el.style.display = 'none';
      this.clear();
      this.drawn = null;
      this.onMove();
    };
    if (immediate || reducedMotion()) {
      this.springs.set({ h: SLIVER, o: 0, s: 0.94, b: 8 }, { immediate: true });
      done();
      return;
    }
    this.springs.set({ h: SLIVER, o: 0, s: 0.95, b: 6 }, { config: { h: springs.snappy, o: springs.fade, s: springs.snappy, b: springs.fade } });
    this.springs.onRest(done);
  }

  /** Measures the content and springs the card's height to it. */
  private fit(immediate: boolean): void {
    const max = Math.max(160, Math.min(this.area.height * 0.72, 660));
    this.inner.style.maxHeight = `${max}px`;
    const h = Math.min(max, this.inner.scrollHeight);
    this.springs.set({ h }, { config: springs.shell, immediate });
  }

  /**
   * Lays content out at its final width, centred: while the card's width springs, the
   * card clips it instead of the text re-wrapping every frame. Content that is fading out
   * keeps the width it had, so it does not re-wrap either.
   */
  private pinInner(inner: HTMLElement, width: number): void {
    inner.style.width = `${width}px`;
    inner.style.left = `calc(50% - ${width / 2}px)`;
    inner.style.right = 'auto';
  }

  private place(v = this.springs.values()): void {
    if (!this.ready) return;
    const h = Math.max(0, v.h);
    const w = Math.max(0, Math.round(v.w));
    const p = this.pill;
    const { width: W, height: H } = this.area;
    const clampX = (x: number) => Math.max(EDGE, Math.min(W - w - EDGE, x));
    const clampY = (y: number) => Math.max(EDGE, Math.min(H - h - EDGE, y));
    let x: number;
    let y: number;
    switch (this.anchor) {
      case 'top':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = p.y + p.h + GAP;
        break;
      case 'bottom':
        x = clampX(p.x + p.w / 2 - w / 2);
        y = p.y - GAP - h;
        break;
      case 'left':
        x = p.x + p.w + GAP;
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
      case 'right':
        x = p.x - GAP - w;
        y = clampY(p.y + p.h / 2 - h / 2);
        break;
    }
    const st = this.el.style;
    st.transform = `translate3d(${x}px, ${y}px, 0) scale(${v.s})`;
    st.width = `${w}px`;
    st.height = `${h}px`;
    st.opacity = String(clamp01(v.o));
    st.filter = v.b > 0.08 ? `blur(${v.b.toFixed(2)}px)` : '';
    this.drawn = { x, y, w, h };
    this.onMove();
  }

  // ---------------------------------------------------------------- content

  private clear(): void {
    this.nodes.clear();
    this.inner.replaceChildren();
    this.engagedInput = null;
  }

  /** The old content blurs out in place while the new content builds up. */
  private crossFade(): void {
    const old = this.inner;
    old.classList.add('leaving');
    old.style.pointerEvents = 'none';
    const gone = () => old.remove();
    const anim = springAnimate(old, [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(5px)' }], springs.fade, { fill: 'forwards' });
    if (anim) anim.finished.then(gone, gone);
    else gone();
    this.inner = make('div', 'sheet-inner');
    this.inner.style.setProperty('--cols', this.width >= 520 ? '4' : '2');
    this.el.append(this.inner);
    springAnimate(this.inner, [{ opacity: 0, filter: 'blur(5px)' }, { opacity: 1, filter: 'blur(0px)' }], springs.content);
    this.nodes.clear();
    this.engagedInput = null;
  }

  /** Brings the DOM in line with `blocks`; true when anything changed. */
  private patch(blocks: Block[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    blocks.forEach((b, i) => {
      seen.add(b.key);
      const sig = JSON.stringify(b);
      let node = this.nodes.get(b.key);
      if (node && node.t === b.t && node.sig === sig) {
        node.spec = b;
      } else if (node && node.t === b.t && this.patchInPlace(node, b)) {
        node.sig = sig;
        node.spec = b;
        changed = true;
      } else {
        const el = this.build(b);
        el.dataset.k = b.key;
        if (node) node.el.replaceWith(el);
        node = { t: b.t, sig, el, spec: b };
        this.nodes.set(b.key, node);
        if (!this.inner.contains(el)) this.inner.append(el);
        changed = true;
      }
      // Keep DOM order without touching nodes already in place (a moved input loses focus).
      const at = this.inner.children[i];
      if (at !== node.el) this.inner.insertBefore(node.el, at ?? null);
    });
    for (const [key, node] of this.nodes) {
      if (seen.has(key)) continue;
      node.el.remove();
      this.nodes.delete(key);
      if (this.engagedInput && node.el.contains(this.engagedInput)) this.engagedInput = null;
      changed = true;
    }
    return changed;
  }

  /** Updates that must not rebuild the element. False means "rebuild it". */
  private patchInPlace(node: BlockNode, b: Block): boolean {
    const e = node.el;
    switch (b.t) {
      case 'input': {
        const input = e.querySelector('input')!;
        input.placeholder = b.placeholder;
        const hint = e.querySelector<HTMLElement>('.ih');
        if (b.hint && hint) hint.textContent = b.hint;
        else if (b.hint) e.append(make('div', 'ih', b.hint));
        else hint?.remove();
        return true;
      }
      case 'meter': {
        this.fillMeter(e, b);
        return true;
      }
      case 'countdown': {
        const prev = node.spec.t === 'countdown' ? node.spec : null;
        e.className = `sb sb-countdown tone-${b.tone ?? 'claude'}`;
        if (!prev || prev.until !== b.until || prev.total !== b.total) this.runCountdown(e.querySelector('.cf')!, b);
        return true;
      }
      case 'tiles': {
        this.patchTiles(e, b);
        return true;
      }
      default:
        return false;
    }
  }

  private bind(e: HTMLElement, action: string | undefined, arg: unknown): void {
    if (!action) return;
    e.dataset.action = action;
    args.set(e, arg);
  }

  private button(b: SheetButton): HTMLButtonElement {
    const e = make('button', `sbtn style-${b.style ?? 'secondary'}${b.label ? '' : ' icon-only'}`);
    e.type = 'button';
    if (b.icon) e.append(iconEl(b.icon, 'bi'));
    if (b.label) e.append(make('span', 'bl', b.label));
    if (b.tip) e.title = b.tip;
    this.bind(e, b.action, b.arg);
    return e;
  }

  private row(r: SheetRow): HTMLElement {
    // A row with its own button cannot itself be a <button>.
    const e = make(r.action && !r.button ? 'button' : 'div', `row${r.action ? ' act' : ''}`);
    if (e instanceof HTMLButtonElement) e.type = 'button';
    if (r.dot) {
      const d = make('span', `rd tone-${r.dot}${r.pulse ? ' pulse' : ''}`);
      d.append(make('i', 'ring'), make('i', 'core'));
      e.append(d);
    } else if (r.icon) e.append(iconEl(r.icon, `ri tone-${r.tone ?? 'muted'}`));
    const tx = make('span', 'rt');
    tx.append(make('span', 'r1', r.title));
    if (r.detail) tx.append(make('span', 'r2', r.detail));
    e.append(tx);
    if (r.badge) e.append(make('span', 'rb', r.badge));
    if (r.button) {
      const b = this.button(r.button);
      b.classList.add('rbtn');
      e.append(b);
    }
    if (r.tip) e.title = r.tip;
    this.bind(e, r.action, r.arg);
    return e;
  }

  private build(b: Block): HTMLElement {
    switch (b.t) {
      case 'head': {
        const e = make('div', 'sb sb-head');
        if (b.icon) e.append(iconEl(b.icon, `hi tone-${b.tone ?? 'default'}`));
        const tx = make('div', 'ht');
        tx.append(make('div', 'h1', b.title));
        if (b.sub) tx.append(make('div', 'h2', b.sub));
        e.append(tx);
        if (b.buttons?.length) {
          const bar = make('div', 'hb');
          for (const x of b.buttons) bar.append(this.button(x));
          e.append(bar);
        }
        return e;
      }
      case 'text': {
        const e = make('div', `sb sb-text sz-${b.size ?? 'md'} tone-${b.tone ?? 'default'}${b.bubble ? ' bubble' : ''}`);
        const tx = make('div', 'tx', b.text);
        tx.style.setProperty('--lines', String(b.lines ?? 8));
        e.append(tx);
        return e;
      }
      case 'code': {
        const e = make('div', 'sb sb-code');
        e.append(make('code', '', b.text));
        return e;
      }
      case 'buttons': {
        const e = make('div', `sb sb-buttons align-${b.align ?? 'end'}`);
        for (const x of b.items) e.append(this.button(x));
        return e;
      }
      case 'input':
        return this.buildInput(b);
      case 'meter': {
        const e = make('div', 'sb sb-meter');
        const top = make('div', 'mt');
        top.append(make('span', 'ml'), make('span', 'mv'));
        const bar = make('div', 'mb');
        bar.append(make('i', 'fill'), make('i', 'pace'));
        e.append(top, bar, make('div', 'ms'));
        this.fillMeter(e, b);
        return e;
      }
      case 'rows': {
        const e = make('div', 'sb sb-rows');
        for (const r of b.items) e.append(this.row(r));
        return e;
      }
      case 'choices': {
        const e = make('div', 'sb sb-choices');
        for (const c of b.items) {
          const btn = make('button', `choice${c.selected ? ' selected' : ''}`);
          btn.type = 'button';
          btn.append(make('span', 'c1', c.label));
          if (c.detail) btn.append(make('span', 'c2', c.detail));
          this.bind(btn, c.action, c.arg);
          e.append(btn);
        }
        return e;
      }
      case 'stats': {
        const e = make('div', 'sb sb-stats');
        for (const s of b.items) {
          const c = make('div', `stat tone-${s.tone ?? 'default'}`);
          c.append(make('div', 'sv', s.value), make('div', 'sl', s.label));
          if (s.tip) c.title = s.tip;
          e.append(c);
        }
        return e;
      }
      case 'countdown': {
        const e = make('div', `sb sb-countdown tone-${b.tone ?? 'claude'}`);
        const fill = make('i', 'cf');
        e.append(fill);
        this.runCountdown(fill, b);
        return e;
      }
      case 'tiles': {
        const e = make('div', 'sb sb-tiles');
        e.append(make('div', 'pages'), make('div', 'dots'), make('div', 'tray'));
        this.wireGrid(e);
        this.patchTiles(e, b);
        return e;
      }
    }
  }

  private buildInput(b: Extract<Block, { t: 'input' }>): HTMLElement {
    const e = make('div', 'sb sb-input');
    const box = make('div', 'ib');
    const input = make('input', '');
    input.type = 'text';
    input.spellcheck = true;
    input.autocomplete = 'off';
    input.placeholder = b.placeholder;
    const send = make('button', 'send');
    send.type = 'button';
    send.innerHTML = icon('enter');
    send.title = 'Send (Enter)';
    box.append(input, send);
    e.append(box);
    if (b.hint) e.append(make('div', 'ih', b.hint));
    const spec = () => {
      const n = this.nodes.get(b.key);
      return n && n.spec.t === 'input' ? n.spec : b;
    };
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.onAction(spec().action, text, e);
    };
    // Clicking is the only way in: the island takes the keyboard just for this.
    input.addEventListener('pointerdown', () => {
      this.engagedInput = input;
      this.onAction('island:sheet-engage', b.key, e);
    });
    input.addEventListener('focus', () => {
      const s = spec();
      if (s.engage) this.onAction(s.engage, null, e);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.onAction('island:sheet-escape', null, e);
      }
    });
    send.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submit();
    });
    return e;
  }

  private fillMeter(e: HTMLElement, b: Extract<Block, { t: 'meter' }>): void {
    e.className = `sb sb-meter tone-${b.tone ?? 'claude'}`;
    e.querySelector('.ml')!.textContent = b.label;
    e.querySelector('.mv')!.textContent = b.text;
    const sub = e.querySelector<HTMLElement>('.ms')!;
    sub.textContent = b.sub ?? '';
    sub.style.display = b.sub ? '' : 'none';
    e.querySelector<HTMLElement>('.fill')!.style.transform = `scaleX(${clamp01(b.value)})`;
    const pace = e.querySelector<HTMLElement>('.pace')!;
    pace.style.opacity = b.pace == null ? '0' : '1';
    if (b.pace != null) pace.style.left = `${clamp01(b.pace) * 100}%`;
    if (b.tip) e.title = b.tip;
    else e.removeAttribute('title');
  }

  private runCountdown(fill: HTMLElement, b: Extract<Block, { t: 'countdown' }>): void {
    for (const a of fill.getAnimations?.() ?? []) a.cancel();
    const left = Math.max(0, b.until - Date.now());
    const from = b.total > 0 ? clamp01(left / b.total) : 0;
    fill.style.transform = `scaleX(${from})`;
    if (left > 0 && fill.animate) fill.animate([{ transform: `scaleX(${from})` }, { transform: 'scaleX(0)' }], { duration: left, easing: 'linear', fill: 'forwards' });
  }

  // ---------------------------------------------------------------- tiles

  /** Everything about a tile except where it sits: position is patched, never rebuilt. */
  private tileSig(t: Tile, editing: boolean): string {
    const { page, col, row, ...rest } = t;
    return JSON.stringify(rest) + (editing ? '|edit' : '');
  }

  private placeTile(el: HTMLElement, t: Tile): void {
    el.style.gridArea = `${(t.row ?? 0) + 1} / ${(t.col ?? 0) + 1} / span ${t.h ?? 1} / span ${t.w ?? 1}`;
  }

  /**
   * Brings the grid in line with the layout the island packed. Elements are kept
   * and moved; only a tile whose content changed is rebuilt, and nothing is
   * rebuilt mid-drag. Tiles that end up somewhere new slide there.
   */
  private patchTiles(host: HTMLElement, b: Extract<Block, { t: 'tiles' }>): void {
    const editing = b.editing === true;
    host.classList.toggle('editing', editing);
    host.style.setProperty('--cols', String(b.cols));
    host.style.setProperty('--rows', String(b.rows));
    host.style.setProperty('--cell', `${b.cell}px`);
    const pagesEl = host.querySelector<HTMLElement>('.pages')!;
    const trayEl = host.querySelector<HTMLElement>('.tray')!;
    const dotsEl = host.querySelector<HTMLElement>('.dots')!;

    const pages = Math.max(1, b.pages);
    while (pagesEl.children.length < pages) pagesEl.append(make('div', 'page'));
    while (pagesEl.children.length > pages) pagesEl.lastElementChild!.remove();
    if (dotsEl.children.length !== pages || pages < 2) {
      dotsEl.replaceChildren();
      if (pages > 1) {
        for (let i = 0; i < pages; i++) {
          const dot = make('button', 'dot');
          dot.type = 'button';
          dot.title = `Page ${i + 1}`;
          dot.addEventListener('click', (e) => {
            e.stopPropagation();
            this.goToPage(host, i);
          });
          dotsEl.append(dot);
        }
      }
      this.markPage(host);
    }

    const existing = new Map<string, HTMLElement>();
    for (const el of host.querySelectorAll<HTMLElement>('.tile')) if (el.dataset.k) existing.set(el.dataset.k, el);
    const was = new Map<HTMLElement, { rect: DOMRect; page: Element | null }>();
    for (const el of existing.values()) was.set(el, { rect: el.getBoundingClientRect(), page: el.parentElement });

    const seen = new Set<string>();
    const render = (t: Tile, parent: HTMLElement, tray: boolean) => {
      seen.add(t.key);
      const sig = this.tileSig(t, editing) + (tray ? '|tray' : '');
      let el = existing.get(t.key);
      if (!el || (this.tileSigs.get(el) !== sig && !(this.drag && this.drag.key === t.key))) {
        if (el && this.tileSigs.get(el) === sig) {
          /* unchanged */
        } else if (el && this.patchTile(el, t)) {
          this.tileSigs.set(el, sig);
        } else {
          const next = this.tile(t, editing);
          next.dataset.k = t.key;
          this.tileSigs.set(next, sig);
          if (el) {
            el.replaceWith(next);
            // A rebuilt tile slides from where the old one was, like its neighbours.
            const before = was.get(el);
            if (before) was.set(next, before);
          } else springAnimate(next, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], springs.content);
          el = next;
        }
      }
      if (!tray) this.placeTile(el, t);
      else el.style.gridArea = '';
      if (el.parentElement !== parent) parent.append(el);
      existing.set(t.key, el);
    };

    for (const t of b.items) render(t, (pagesEl.children[t.page ?? 0] as HTMLElement) ?? pagesEl.firstElementChild as HTMLElement, false);
    trayEl.style.display = editing && b.tray?.length ? '' : 'none';
    for (const t of b.tray ?? []) if (editing) render(t, trayEl, true);

    for (const [key, el] of existing) {
      if (seen.has(key)) continue;
      el.remove();
      this.tileSigs.delete(el);
    }

    // Anything that moved slides from where it was drawn; the dragged tile stays on the pointer.
    for (const el of host.querySelectorAll<HTMLElement>('.tile')) {
      const before = was.get(el);
      if (!before || el === this.drag?.el) continue;
      // Moving to another page would fly the tile across the card: it fades in at its new place instead.
      if (before.page !== el.parentElement) {
        springAnimate(el, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], springs.content);
        continue;
      }
      const a = before.rect;
      const r = el.getBoundingClientRect();
      const dx = a.left - r.left;
      const dy = a.top - r.top;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) springAnimate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], springs.content);
    }
  }

  /** Remove (or put back) and resize, laid over a tile in edit mode. */
  private editControls(e: HTMLElement, t: Tile): void {
    const key = t.key;
    if (t.hidden) {
      const add = make('button', 'tile-add');
      add.type = 'button';
      add.innerHTML = icon('plus');
      add.title = 'Put back on the grid';
      this.bind(add, 'island:grid-show', key);
      e.append(add);
      return;
    }
    const x = make('button', 'tile-x');
    x.type = 'button';
    x.innerHTML = icon('minus');
    x.title = 'Take off the grid';
    this.bind(x, 'island:grid-hide', key);
    const size = make('button', 'tile-size', t.sizeLabel ?? '');
    size.type = 'button';
    size.title = 'Change size';
    this.bind(size, 'island:grid-size', key);
    e.append(x, size);
  }

  // ---------------------------------------------------------------- pages

  private pageWidth(host: HTMLElement): number {
    return host.querySelector<HTMLElement>('.pages')?.clientWidth || 1;
  }

  private goToPage(host: HTMLElement, i: number): void {
    const pages = host.querySelector<HTMLElement>('.pages');
    if (!pages) return;
    pages.scrollTo({ left: i * this.pageWidth(host), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  private markPage(host: HTMLElement): void {
    const pages = host.querySelector<HTMLElement>('.pages');
    const dots = host.querySelectorAll<HTMLElement>('.dot');
    if (!pages || !dots.length) return;
    const at = Math.round(pages.scrollLeft / this.pageWidth(host));
    dots.forEach((d, i) => d.classList.toggle('on', i === at));
  }

  // ---------------------------------------------------------------- long press and drag

  /**
   * Long-press a tile to edit the grid. While editing, dragging a tile pushes the
   * others out of its way; holding it at an edge turns the page.
   */
  private wireGrid(host: HTMLElement): void {
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    host.addEventListener('pointerdown', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
      if (!tile || e.button !== 0 || (e.target as HTMLElement).closest('.tile-x, .tile-size, .tile-add')) return;
      if (host.classList.contains('editing')) {
        if (!tile.classList.contains('hidden-tile')) this.dragTile(host, tile, e);
        return;
      }
      cancel();
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null;
          this.swallowClick = true;
          clearTimeout(this.swallowTimer);
          // If no click follows (the pointer was lifted elsewhere), stop swallowing.
          this.swallowTimer = setTimeout(() => (this.swallowClick = false), 700);
          this.onAction('island:grid-edit', tile.dataset.k ?? null, tile);
        }, 450),
      };
    });
    host.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) cancel();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) host.addEventListener(ev, cancel);
    host.querySelector('.pages')?.addEventListener('scroll', () => this.markPage(host), { passive: true });
    host.addEventListener(
      'wheel',
      (e) => {
        const pages = host.querySelector<HTMLElement>('.pages');
        if (!pages || pages.scrollWidth <= pages.clientWidth + 2) return;
        e.preventDefault();
        const at = Math.round(pages.scrollLeft / this.pageWidth(host));
        this.goToPage(host, Math.max(0, Math.min(pages.children.length - 1, at + Math.sign(e.deltaY || e.deltaX))));
      },
      { passive: false },
    );
  }

  /** The cell under the pointer, in the page it is over. */
  private cellAt(host: HTMLElement, x: number, y: number): { page: number; col: number; row: number } | null {
    const pagesEl = host.querySelector<HTMLElement>('.pages');
    if (!pagesEl) return null;
    const cols = Number(host.style.getPropertyValue('--cols')) || 4;
    const rows = Number(host.style.getPropertyValue('--rows')) || 4;
    for (let i = 0; i < pagesEl.children.length; i++) {
      const page = pagesEl.children[i] as HTMLElement;
      const r = page.getBoundingClientRect();
      if (x < r.left - 4 || x > r.right + 4 || y < r.top - 4 || y > r.bottom + 4) continue;
      const col = Math.max(0, Math.min(cols - 1, Math.floor(((x - r.left) / r.width) * cols)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor(((y - r.top) / r.height) * rows)));
      return { page: i, col, row };
    }
    return null;
  }

  private dragTile(host: HTMLElement, tile: HTMLElement, down: PointerEvent): void {
    const key = tile.dataset.k;
    if (!key) return;
    const startX = down.clientX;
    const startY = down.clientY;
    let moving = false;
    let edgeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCell = '';

    const follow = (ev: PointerEvent) => {
      // Measured with the transform cleared, so the tile stays under the pointer
      // even after the grid has re-packed around it.
      tile.style.transform = '';
      const r = tile.getBoundingClientRect();
      tile.style.transform = `translate(${ev.clientX - (r.left + r.width / 2)}px, ${ev.clientY - (r.top + r.height / 2)}px) scale(1.05)`;
    };

    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        moving = true;
        this.drag = { key, el: tile, host, pointer: ev.pointerId };
        host.setPointerCapture(ev.pointerId);
        tile.classList.add('dragging');
      }
      follow(ev);
      const cell = this.cellAt(host, ev.clientX, ev.clientY);
      if (cell) {
        const id = `${cell.page}:${cell.col}:${cell.row}`;
        if (id !== lastCell) {
          lastCell = id;
          this.onAction('island:grid-move', { key, ...cell }, tile);
        }
      }
      // Held near an edge: turn the page.
      const r = host.getBoundingClientRect();
      const near = ev.clientX < r.left + 36 ? -1 : ev.clientX > r.right - 36 ? 1 : 0;
      if (!near) {
        clearTimeout(edgeTimer);
        edgeTimer = undefined;
      } else if (!edgeTimer) {
        edgeTimer = setTimeout(() => {
          edgeTimer = undefined;
          const pagesEl = host.querySelector<HTMLElement>('.pages');
          if (!pagesEl) return;
          const at = Math.round(pagesEl.scrollLeft / this.pageWidth(host));
          this.goToPage(host, Math.max(0, Math.min(pagesEl.children.length - 1, at + near)));
        }, 450);
      }
    };

    const end = () => {
      clearTimeout(edgeTimer);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', end);
      host.removeEventListener('pointercancel', end);
      if (!moving) return;
      const from = tile.getBoundingClientRect();
      this.drag = null;
      tile.classList.remove('dragging');
      tile.style.transform = '';
      const to = tile.getBoundingClientRect();
      springAnimate(tile, [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.05)` }, { transform: 'none' }], springs.content);
      this.onAction('island:grid-drop', key, tile);
    };

    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
  }

  /**
   * Changes that should move rather than redraw (the battery bar sliding to the
   * new charge). False means "rebuild this tile".
   */
  private patchTile(el: HTMLElement, t: Tile): boolean {
    const b = t.body;
    if (b.k !== 'battery' || !el.classList.contains('k-battery')) return false;
    const was = this.tileSigs.get(el);
    const prev = was ? (JSON.parse(was.split('|')[0]) as Tile) : null;
    if (!prev || prev.body.k !== 'battery' || prev.body.charging !== b.charging) return false;
    el.querySelector('.bh span:last-child')!.textContent = b.head;
    el.querySelector('.bp')!.textContent = `${Math.round(b.pct)}%`;
    el.querySelector('.bs')!.textContent = b.sub;
    el.querySelector<HTMLElement>('.bb i')!.style.width = `${Math.max(3, Math.min(100, b.pct))}%`;
    el.classList.toggle('low', !b.charging && b.pct <= 20);
    return true;
  }

  private tile(t: Tile, editing = false): HTMLElement {
    const b = t.body;
    const live = Boolean(t.action) && !editing && !t.hidden;
    // The size classes follow the cells it actually got, not the size it asked for.
    const e = make(live ? 'button' : 'div', `tile k-${b.k} span-${t.w ?? t.span ?? 1} rows-${t.h ?? t.rows ?? 1}${live ? ' act' : ''}${t.hidden ? ' hidden-tile' : ''}`);
    if (e instanceof HTMLButtonElement) e.type = 'button';
    // Tone tints the tile's icon and accents only (a tone class would tint all its text).
    e.dataset.tone = t.tone ?? 'default';
    if (t.tip && !editing) e.title = t.tip;
    if (live) this.bind(e, t.action, t.arg);
    if (editing) this.editControls(e, t);
    switch (b.k) {
      case 'stat': {
        // Three rows that fit one cell: what it is, the number, and a detail (or a bar).
        const top = make('div', 'sh');
        top.append(iconEl(b.icon, 'ti'), make('span', 'tl', b.label));
        if (b.sub && b.progress != null) top.append(make('span', 'ts aside', b.sub));
        e.append(top, make('div', 'tv', b.value));
        if (b.progress != null) {
          const bar = make('div', 'tp');
          const f = make('i', '');
          f.style.transform = `scaleX(${clamp01(b.progress)})`;
          bar.append(f);
          e.append(bar);
        } else if (b.sub) e.append(make('div', 'ts', b.sub));
        break;
      }
      case 'battery': {
        const head = make('div', 'bh');
        head.append(iconEl(b.charging ? 'bolt' : 'battery', 'ti'), make('span', '', b.head));
        const big = make('div', 'bv');
        big.append(make('span', 'bp', `${Math.round(b.pct)}%`), make('span', 'bs', b.sub));
        const bar = make('div', 'bb');
        const f = make('i', '');
        f.style.width = `${Math.max(3, Math.min(100, b.pct))}%`;
        bar.append(f);
        const scale = make('div', 'bscale');
        scale.append(make('span', '', '0'), make('span', '', '50'), make('span', '', '100'));
        e.append(head, big, bar, scale);
        e.classList.toggle('charging', b.charging);
        e.classList.toggle('low', !b.charging && b.pct <= 20);
        break;
      }
      case 'media': {
        const art = make('div', 'ma');
        if (b.art) {
          const img = make('img', '');
          img.alt = '';
          img.decoding = 'async';
          img.src = b.art;
          art.append(img);
        } else art.innerHTML = icon('music');
        const meta = make('div', 'mm');
        meta.append(make('div', 'm1', b.title), make('div', 'm2', b.artist));
        const top = make('div', 'mtop');
        top.append(art, meta);
        e.append(top);
        if (b.progress != null) {
          const bar = make('div', 'tp');
          const f = make('i', '');
          f.style.transform = `scaleX(${clamp01(b.progress)})`;
          bar.append(f);
          e.append(bar);
        }
        const ctl = make('div', 'mc');
        for (const x of b.buttons) ctl.append(this.button(x));
        e.append(ctl);
        break;
      }
      case 'week': {
        const head = make('div', 'wh');
        head.append(make('span', 'w1', b.title), make('span', 'w2', b.sub));
        const strip = make('div', 'ws');
        for (const d of b.days) {
          const cell = make('div', `wd${d.today ? ' today' : ''}`);
          cell.append(make('span', 'wl', d.label), make('span', 'wn', String(d.num)));
          const dots = make('span', 'wb');
          for (let i = 0; i < Math.min(3, d.busy); i++) dots.append(make('i', ''));
          cell.append(dots);
          strip.append(cell);
        }
        e.append(head, strip);
        break;
      }
      case 'dots': {
        const head = make('div', 'dh');
        head.append(make('span', 'd1', b.label), make('span', 'd2', `${Math.round(b.pct)}%`));
        const grid = make('div', 'dg');
        const filled = Math.round((clamp01(b.pct / 100) * 24));
        for (let i = 0; i < 24; i++) grid.append(make('i', i < filled ? 'on' : ''));
        e.append(head, grid);
        if (b.sub) e.append(make('div', 'ts', b.sub));
        break;
      }
      case 'forecast': {
        const now = make('div', 'fn');
        now.append(iconEl(b.icon, 'ti'), make('span', 'ft', b.temp), make('span', 'fl', b.label));
        e.append(now);
        const hours = make('div', 'fh');
        for (const h of b.hours) {
          const c = make('div', 'fc');
          c.append(make('span', 'f1', h.t), iconEl(h.icon, 'fi'), make('span', 'f2', h.temp));
          hours.append(c);
        }
        e.append(hours);
        break;
      }
      case 'actions': {
        const head = make('div', 'ah');
        if (b.icon) head.append(iconEl(b.icon, 'ti'));
        const tx = make('div', 'at');
        tx.append(make('div', 'tl strong', b.label));
        if (b.sub) tx.append(make('div', 'ts', b.sub));
        head.append(tx);
        const bar = make('div', 'ab');
        for (const x of b.buttons) bar.append(this.button(x));
        e.append(head, bar);
        break;
      }
      case 'list': {
        const head = make('div', 'ah');
        head.append(iconEl(b.icon, 'ti'), make('div', 'tl strong', b.label));
        e.append(head);
        const rows = make('div', 'sb-rows');
        for (const r of b.rows) rows.append(this.row(r));
        if (!b.rows.length && b.empty) rows.append(make('div', 'ts', b.empty));
        e.append(rows);
        break;
      }
    }
    return e;
  }
}
