// The pill's content model. Activities describe what they want to show as a
// flat list of keyed segments; this module measures them (canvas text metrics,
// no DOM layout) and fits them into the space budget: shrink text first, then
// drop the least important segments, never grow the pill.

import type { BotMood } from '../fx/bot/catalog';
import type { IconName } from './icons';

export type Tone = 'default' | 'muted' | 'dim' | 'accent' | 'claude' | 'good' | 'warn' | 'bad' | 'info' | 'violet';
export type Side = 'start' | 'center' | 'end';

interface Base {
  /** Stable identity: the same key in two layouts is the same object, morphed. */
  key: string;
  /** 0 is never dropped; higher numbers are dropped first when space runs out. Default 5. */
  prio?: number;
  side?: Side;
  tip?: string;
}

export type Seg =
  | (Base & { t: 'icon'; icon: IconName; tone?: Tone; anim?: 'pulse' | 'spin' | 'bob'; size?: 'sm' | 'md' | 'lg' })
  | (Base & { t: 'dot'; tone: Tone; pulse?: boolean })
  | (Base & {
      t: 'text';
      text: string;
      tone?: Tone;
      weight?: 'regular' | 'medium' | 'semibold' | 'bold';
      size?: 'xs' | 'sm' | 'md' | 'lg';
      /** Narrowest the text may be squeezed to before it is dropped instead. */
      min?: number;
      /** Widest it may get, even with room to spare. */
      max?: number;
    })
  | (Base & { t: 'progress'; value: number | null; pace?: number | null; tone?: Tone; w: number })
  | (Base & { t: 'bars'; active: boolean; tone?: Tone })
  | (Base & {
      t: 'button';
      label?: string;
      icon?: IconName;
      action: string;
      arg?: unknown;
      style?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'good';
    })
  | (Base & {
      t: 'chip';
      label: string;
      action?: string;
      arg?: unknown;
      tone?: Tone;
      dot?: Tone;
      pulse?: boolean;
      icon?: IconName;
      badge?: string;
      selected?: boolean;
      max?: number;
    })
  | (Base & { t: 'input'; placeholder: string; action: string; cancel?: string; value?: string; min?: number })
  | (Base & { t: 'art'; src: string | null; icon?: IconName; round?: boolean })
  /** The bot avatar. Its mood can change in place: the renderer keeps one avatar per key and morphs it. */
  | (Base & { t: 'bot'; mood: BotMood })
  | (Base & { t: 'sep' })
  | (Base & { t: 'meter'; label: string; value: number; pace: number | null; text: string; tone?: Tone; w?: number })
  | (Base & { t: 'gap'; w: number });

export interface Placed {
  seg: Seg;
  /** Start along the pill in inner-area coordinates (left edge, or top edge when vertical). */
  x: number;
  /** Element width (along the pill when horizontal, across it when vertical). */
  w: number;
  /** Element height along a vertical pill. */
  h?: number;
}

export const GAP = 8;

// ------------------------------------------------------------------ fonts

export const FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
const SIZE_PX = { xs: 11, sm: 12, md: 13, lg: 15 } as const;
const WEIGHT = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

export function textFont(seg: { size?: keyof typeof SIZE_PX; weight?: keyof typeof WEIGHT }): string {
  return `${WEIGHT[seg.weight ?? 'medium']} ${SIZE_PX[seg.size ?? 'md']}px ${FONT_FAMILY}`;
}
export const CHIP_FONT = `500 12px ${FONT_FAMILY}`;
export const BUTTON_FONT = `600 12px ${FONT_FAMILY}`;
export const BADGE_FONT = `600 10.5px ${FONT_FAMILY}`;
export const METER_FONT = `500 11px ${FONT_FAMILY}`;

export type Measure = (text: string, font: string) => number;

let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

/** Canvas text width, cached. Falls back to an estimate where there is no canvas (tests). */
export const measureText: Measure = (raw, font) => {
  // The pill draws digits tabular (all as wide as 0), so measure them that way:
  // exact widths, and a ticking clock never changes size.
  const text = raw.replace(/[0-9]/g, '0');
  const key = `${font}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx) {
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  }
  let w: number;
  if (ctx) {
    ctx.font = font;
    w = Math.ceil(ctx.measureText(text).width) + 1;
  } else {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 13);
    w = Math.ceil(text.length * px * 0.56);
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, w);
  return w;
};

// ------------------------------------------------------------------ sizes

const ICON_SIZE = { sm: 15, md: 18, lg: 22 } as const;
export const CHIP_H = 24;
export const BUTTON_H = 26;

/** The bot grows with the pill like album art (22 px compact, 28 expanded), but stays an icon, never a picture. */
export function botSize(pillH: number): number {
  return Math.max(18, Math.min(30, pillH - 14));
}

export function naturalWidth(seg: Seg, measure: Measure, pillH: number): number {
  switch (seg.t) {
    case 'icon':
      return ICON_SIZE[seg.size ?? 'md'];
    case 'dot':
      return 10;
    case 'text': {
      const w = measure(seg.text, textFont(seg));
      return seg.max ? Math.min(seg.max, w) : w;
    }
    case 'progress':
      return seg.w;
    case 'bars':
      return 23;
    case 'button': {
      const label = seg.label ? measure(seg.label, BUTTON_FONT) : 0;
      if (!seg.label) return BUTTON_H;
      return label + 22 + (seg.icon ? 19 : 0);
    }
    case 'chip': {
      let w = measure(seg.label, CHIP_FONT) + 20;
      if (seg.max) w = Math.min(w, seg.max);
      if (seg.dot) w += 13;
      if (seg.icon) w += 19;
      if (seg.badge) w += measure(seg.badge, BADGE_FONT) + 12;
      return w;
    }
    case 'input':
      return seg.min ?? 180;
    case 'art':
      return Math.max(20, pillH - 14);
    case 'bot':
      return botSize(pillH);
    case 'sep':
      return 1;
    case 'meter':
      return seg.w ?? 150;
    case 'gap':
      return seg.w;
  }
}

/** How far a segment can shrink before it has to go instead. */
function minWidth(seg: Seg, natural: number): number {
  if (seg.t === 'text') return Math.min(natural, seg.min ?? 44);
  if (seg.t === 'chip') return Math.min(natural, 64 + (seg.dot ? 13 : 0) + (seg.icon ? 19 : 0) + (seg.badge ? 24 : 0));
  if (seg.t === 'input') return Math.min(natural, 120);
  if (seg.t === 'meter') return Math.min(natural, 110);
  return natural;
}

const shrinkable = (seg: Seg) => seg.t === 'text' || seg.t === 'chip' || seg.t === 'meter';

/**
 * Fits segments into `inner` px. Returns placed segments (x is relative to the
 * inner area's left edge). Order within each side is preserved.
 */
type Item = { seg: Seg; w: number; min: number; prio: number };

export function fitSegments(segs: Seg[], inner: number, pillH: number, measure: Measure = measureText): Placed[] {
  let items: Item[] = segs.map((seg) => {
    const w = naturalWidth(seg, measure, pillH);
    return { seg, w, min: minWidth(seg, w), prio: seg.prio ?? 5 };
  });
  const total = () => {
    let t = 0;
    items.forEach((it, idx) => {
      t += it.w + (idx > 0 ? gapBetween(items[idx - 1].seg, it.seg) : 0);
    });
    return t;
  };

  let guard = 200;
  while (total() > inner && guard-- > 0) {
    const over = total() - inner;
    // Strict priority order: the least important segment gives way first,
    // squeezed if it is text with room to spare, otherwise dropped. Prio 0 is
    // only ever squeezed, never dropped.
    const roomy = (i: Item) => shrinkable(i.seg) && i.w > i.min;
    const pick = items
      .filter((i) => roomy(i) || i.prio > 0)
      .sort((a, b) => b.prio - a.prio || Number(roomy(b)) - Number(roomy(a)) || b.w - a.w)[0];
    if (!pick) break;
    if (roomy(pick)) pick.w = Math.max(pick.min, pick.w - over);
    else items = tidySeparators(items.filter((i) => i !== pick), (i) => i.seg);
  }

  // An input takes whatever room is left.
  const input = items.find((i) => i.seg.t === 'input');
  if (input) input.w += Math.max(0, inner - total());

  const start = items.filter((i) => (i.seg.side ?? 'start') === 'start');
  const end = items.filter((i) => i.seg.side === 'end');
  const center = items.filter((i) => i.seg.side === 'center');
  const run = (group: Item[]) => group.reduce((a, i, idx) => a + i.w + (idx > 0 ? gapBetween(group[idx - 1].seg, i.seg) : 0), 0);
  const out: Placed[] = [];

  let x = 0;
  start.forEach((i, idx) => {
    if (idx > 0) x += gapBetween(start[idx - 1].seg, i.seg);
    out.push({ seg: i.seg, x, w: i.w });
    x += i.w;
  });
  const startEnd = x;

  const endW = run(end);
  let ex = inner - endW;
  const endStart = ex;
  end.forEach((i, idx) => {
    if (idx > 0) ex += gapBetween(end[idx - 1].seg, i.seg);
    out.push({ seg: i.seg, x: ex, w: i.w });
    ex += i.w;
  });

  if (center.length) {
    const cw = run(center);
    // Centre on the pill when there is room, else in the space between the sides.
    let cx = (inner - cw) / 2;
    const lo = start.length ? startEnd + GAP : 0;
    const hi = end.length ? endStart - GAP - cw : inner - cw;
    if (cx < lo || cx > hi) cx = Math.max(lo, Math.min(hi, (lo + hi) / 2));
    center.forEach((i, idx) => {
      if (idx > 0) cx += gapBetween(center[idx - 1].seg, i.seg);
      out.push({ seg: i.seg, x: cx, w: i.w });
      cx += i.w;
    });
  }
  return out;
}

/** Separators sit a little further from their neighbours than other gaps. */
function gapBetween(a: Seg, b: Seg): number {
  return a.t === 'sep' || b.t === 'sep' ? GAP + 2 : GAP;
}

/** Separators never lead, trail or double up after a drop. */
function tidySeparators<T>(items: T[], seg: (i: T) => Seg): T[] {
  const out: T[] = [];
  for (const i of items) {
    const isSep = seg(i).t === 'sep';
    if (isSep && (out.length === 0 || seg(out[out.length - 1]).t === 'sep')) continue;
    out.push(i);
  }
  while (out.length && seg(out[out.length - 1]).t === 'sep') out.pop();
  return out;
}

/** Cheap structural signature: identical segments produce identical strings. */
export function signature(placed: Placed[]): string {
  return JSON.stringify(placed.map((p) => [p.seg, Math.round(p.x * 2) / 2, Math.round(p.w * 2) / 2]), (_k, v) =>
    typeof v === 'function' ? undefined : v,
  );
}

// ------------------------------------------------------------------ vertical pills

export const VGAP = 6;
const LINE_H = { xs: 15, sm: 16, md: 18, lg: 20 } as const;

/** A segment in a vertical pill: its height along the pill and its width across it. */
export function verticalBox(seg: Seg, measure: Measure, crossMax: number): { len: number; cross: number } {
  switch (seg.t) {
    case 'icon': {
      const s = ICON_SIZE[seg.size ?? 'md'];
      return { len: s, cross: s };
    }
    case 'dot':
      return { len: 10, cross: 10 };
    case 'text':
      return { len: LINE_H[seg.size ?? 'md'], cross: Math.min(crossMax, measure(seg.text, textFont(seg))) };
    case 'progress':
      return { len: 4, cross: crossMax };
    case 'bars':
      return { len: 14, cross: 23 };
    case 'button':
      return seg.icon ? { len: BUTTON_H, cross: BUTTON_H } : { len: BUTTON_H, cross: Math.min(crossMax, naturalWidth(seg, measure, 0)) };
    case 'chip':
      return { len: CHIP_H, cross: Math.min(crossMax, naturalWidth(seg, measure, 0)) };
    case 'input':
      return { len: 30, cross: crossMax };
    case 'art': {
      const s = Math.max(20, Math.min(crossMax, 40));
      return { len: s, cross: s };
    }
    case 'bot': {
      const s = Math.max(18, Math.min(crossMax, 26));
      return { len: s, cross: s };
    }
    case 'sep':
      return { len: 1, cross: Math.round(crossMax * 0.6) };
    case 'meter':
      return { len: 24, cross: crossMax };
    case 'gap':
      return { len: seg.w, cross: 1 };
  }
}

/**
 * Fits segments down a vertical pill. `x` of each result is its top edge along
 * the pill (inner coordinates) and `w` its width across; `h` is its height.
 * Text does not shrink along the pill, so space runs out by dropping the least
 * important segments; long text is cut to the pill's width instead.
 */
export function fitVertical(segs: Seg[], innerLen: number, crossMax: number, measure: Measure = measureText): Placed[] {
  type VItem = { seg: Seg; len: number; cross: number; prio: number };
  let items: VItem[] = segs.map((seg) => ({ seg, ...verticalBox(seg, measure, crossMax), prio: seg.prio ?? 5 }));
  const total = () => items.reduce((a, i, idx) => a + i.len + (idx > 0 ? VGAP : 0), 0);
  let guard = 200;
  while (total() > innerLen && guard-- > 0) {
    const drop = items.filter((i) => i.prio > 0).sort((a, b) => b.prio - a.prio)[0];
    if (!drop) break;
    items = tidySeparators(items.filter((i) => i !== drop), (i) => i.seg);
  }
  const start = items.filter((i) => (i.seg.side ?? 'start') === 'start');
  const end = items.filter((i) => i.seg.side === 'end');
  const center = items.filter((i) => i.seg.side === 'center');
  const run = (g: VItem[]) => g.reduce((a, i, idx) => a + i.len + (idx > 0 ? VGAP : 0), 0);
  const out: Placed[] = [];
  let y = 0;
  for (const i of start) {
    out.push({ seg: i.seg, x: y, w: i.cross, h: i.len });
    y += i.len + VGAP;
  }
  const startEnd = start.length ? y - VGAP : 0;
  let ey = innerLen - run(end);
  const endStart = ey;
  for (const i of end) {
    out.push({ seg: i.seg, x: ey, w: i.cross, h: i.len });
    ey += i.len + VGAP;
  }
  if (center.length) {
    const ch = run(center);
    let cy = (innerLen - ch) / 2;
    const lo = start.length ? startEnd + VGAP : 0;
    const hi = end.length ? endStart - VGAP - ch : innerLen - ch;
    if (cy < lo || cy > hi) cy = Math.max(lo, Math.min(hi, (lo + hi) / 2));
    for (const i of center) {
      out.push({ seg: i.seg, x: cy, w: i.cross, h: i.len });
      cy += i.len + VGAP;
    }
  }
  return out;
}
