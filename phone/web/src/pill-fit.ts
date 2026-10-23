// The pill on a phone. The island sends its pill as it lays it out on the PC (MirrorFrame); a
// phone is narrower, and its system font is wider than Segoe UI. So the phone lays the same
// segments out again with the island's own fitter (segments.ts), measured in the phone's font,
// into the room it has: text squeezes, the least important segments go first, chips that no
// longer fit fold into "+N", exactly as the island does when it runs out of room. A left or
// right island's standing pill is laid out lying down at the top. No DOM (the tests run it).

import type { MirrorFrame } from '../../../src/core/mirror';
import { BUBBLE_GAP, bubbleRect, innerPadding, type Rect } from '../../../src/core/layout';
import { fitSegments, measureText, signature, type Measure, type Placed, type Seg } from '../../../src/core/segments';

/** Room kept free on either side of the pill (and the bot), CSS px. */
export const PILL_MARGIN = 12;
/** The pill's top, under the safe area. */
export const PILL_TOP = 6;
/** The island's "+N more" chip. */
const MORE = 'island/more';

/** A standing pill's thickness (24/40/54/72 by level) as the height of a lying one (24/36/42/50). */
export function lyingHeight(thickness: number): number {
  const steps: Array<[number, number]> = [
    [24, 24],
    [40, 36],
    [54, 42],
    [72, 50],
  ];
  if (thickness <= steps[0][0]) return steps[0][1];
  for (let i = 1; i < steps.length; i++) {
    const [t1, h1] = steps[i];
    const [t0, h0] = steps[i - 1];
    if (thickness <= t1) return Math.round(h0 + ((thickness - t0) / (t1 - t0)) * (h1 - h0));
  }
  return Math.round(steps[steps.length - 1][1] * (thickness / steps[steps.length - 1][0]));
}

/** Between the bot and the pill under it, a phone held upright. */
export const BOT_GAP = 8;

/** The widest the pill may be on a screen `areaW` wide: the bot beside it takes its room, the bot above it doesn't. */
export function maxPillWidth(areaW: number, botD: number | null, stacked = false): number {
  return Math.max(100, Math.floor(areaW - PILL_MARGIN * 2 - (botD && !stacked ? botD + BUBBLE_GAP : 0)));
}

export interface PhonePill {
  placed: Placed[];
  w: number;
  h: number;
  /** Changes whenever what is drawn changes (the renderer only redraws then). */
  sig: string;
}

const isChip = (s: Seg) => s.key.startsWith('chip/');

/** The frame's segments laid out for a pill at most `maxW` wide. */
export function phonePill(frame: MirrorFrame, maxW: number, measure: Measure = measureText): PhonePill {
  const standing = frame.orient === 'vertical';
  const h = standing ? lyingHeight(frame.w) : frame.h;
  const natural = standing ? Math.max(150, Math.round(frame.h * 1.4)) : frame.w;
  const w = Math.max(60, Math.min(natural, maxW));
  const inner = Math.max(40, w - innerPadding(h) * 2);
  const more = frame.placed.find((p) => p.seg.key === MORE)?.seg ?? null;
  const segs = frame.placed.map((p) => p.seg).filter((s) => s.key !== MORE);
  let placed = fitSegments(segs, inner, h, measure);
  const already = more && more.t === 'chip' ? Number(/\d+/.exec(more.label)?.[0] ?? 0) : 0;
  const dropped = segs.filter(isChip).length - placed.filter((p) => isChip(p.seg)).length;
  if (already + dropped > 0) {
    const chip: Seg = {
      t: 'chip',
      key: MORE,
      label: `+${already + dropped}`,
      icon: 'more',
      action: 'island:overflow',
      side: 'end',
      prio: 1,
      tip: 'More activities',
    };
    placed = fitSegments([...segs, chip], inner, h, measure);
  }
  return { placed, w, h, sig: `${w}|${h}|${signature(placed)}` };
}

/**
 * Where the pill and the bot go. Upright (`stacked`; Moss, 2026-10-23: "make the bot separate,
 * above the pill, and center the pill") the bot is centred at the top and the pill centred under
 * it. Sideways the pill is centred at the top with the bot beside it, moved right only if the bot
 * would not fit.
 */
export function placePill(areaW: number, w: number, h: number, botD: number | null, stacked = false): { pill: Rect; bot: Rect | null } {
  if (stacked && botD) {
    const bot = { x: Math.round((areaW - botD) / 2), y: PILL_TOP, w: botD, h: botD };
    return { pill: { x: Math.round((areaW - w) / 2), y: PILL_TOP + botD + BOT_GAP, w, h }, bot };
  }
  const room = botD ? botD + BUBBLE_GAP : 0;
  let x = (areaW - w) / 2;
  if (x - room < PILL_MARGIN) x = Math.min(PILL_MARGIN + room, Math.max(PILL_MARGIN, areaW - PILL_MARGIN - w));
  const pill = { x: Math.round(x), y: PILL_TOP, w, h };
  return { pill, bot: botD ? bubbleRect(pill, 'top', botD) : null };
}
