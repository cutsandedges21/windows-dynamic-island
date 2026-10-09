// Where the bot's bubble sits: beside the pill on the top and bottom edges, above it on the sides,
// always a gap away, lined up with the screen edge the pill is pinned to.

import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP, CHAT_BAR_H, bubbleRect, bubbleSize, chatBarRect, chatCardRect, heightFor, orientationFor, pillRect, pillSize, normalizeWidths, type Anchor, type Level, type Rect } from '../src/core/layout';

const area = { width: 1536, height: 816 };
const widths = normalizeWidths(null);
const edge = 8;

function pillAt(anchor: Anchor, level: Level): Rect {
  const size = pillSize(area, widths, level, edge, 'medium', orientationFor(anchor));
  return pillRect(area, anchor, size.w, size.h, edge);
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('the bubble', () => {
  it('is as tall as the compact pill, for every size', () => {
    expect(bubbleSize('medium')).toBe(heightFor('compact', 'medium'));
    expect(bubbleSize('small')).toBe(heightFor('compact', 'small'));
    expect(bubbleSize('large')).toBe(heightFor('compact', 'large'));
  });

  for (const anchor of ['top', 'bottom', 'left', 'right'] as const) {
    for (const level of ['idle', 'compact', 'maximum'] as const) {
      it(`${anchor}, ${level}: beside the pill, a gap away, on screen`, () => {
        const pill = pillAt(anchor, level);
        const d = bubbleSize('medium');
        const b = bubbleRect(pill, anchor, d);
        expect(b.w).toBe(d);
        expect(b.h).toBe(d);
        expect(overlaps(b, pill)).toBe(false);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(area.width);
        expect(b.y + b.h).toBeLessThanOrEqual(area.height);
        if (anchor === 'top' || anchor === 'bottom') {
          expect(pill.x - (b.x + b.w)).toBe(BUBBLE_GAP);
          if (anchor === 'top') expect(b.y).toBe(pill.y);
          else expect(b.y + b.h).toBe(pill.y + pill.h);
        } else {
          expect(pill.y - (b.y + b.h)).toBe(BUBBLE_GAP);
          if (anchor === 'left') expect(b.x).toBe(pill.x);
          else expect(b.x + b.w).toBe(pill.x + pill.w);
        }
      });
    }
  }
});

describe('the chat bar', () => {
  for (const anchor of ['top', 'bottom', 'left', 'right'] as const) {
    it(`${anchor}: clear of the bot and the pill, a gap away`, () => {
      const pill = pillAt(anchor, 'compact');
      const bot = bubbleRect(pill, anchor, bubbleSize('medium'));
      const bar = chatBarRect(anchor, bot, pill);
      expect(bar.h).toBe(CHAT_BAR_H);
      expect(overlaps(bar, pill)).toBe(false);
      expect(overlaps(bar, bot)).toBe(false);
      if (anchor === 'top' || anchor === 'bottom') {
        // From the bot's left edge to the pill's right edge (Moss's option A).
        expect(bar.x).toBe(bot.x);
        expect(bar.x + bar.w).toBe(pill.x + pill.w);
        if (anchor === 'top') expect(bar.y).toBe(Math.max(bot.y + bot.h, pill.y + pill.h) + BUBBLE_GAP);
        else expect(bar.y + bar.h).toBe(Math.min(bot.y, pill.y) - BUBBLE_GAP);
      } else {
        // On a side the bar reaches inward from beside the bot, centred on it.
        expect(bar.y + bar.h / 2).toBe(bot.y + bot.h / 2);
        if (anchor === 'left') expect(bar.x).toBe(bot.x + bot.w + BUBBLE_GAP);
        else expect(bar.x + bar.w).toBe(bot.x - BUBBLE_GAP);
      }
      const card = chatCardRect(anchor, bar, 120);
      expect(card.x).toBe(bar.x);
      expect(card.w).toBe(bar.w);
      expect(overlaps(card, bar)).toBe(false);
      if (anchor === 'bottom') expect(card.y + card.h).toBe(bar.y - BUBBLE_GAP);
      else expect(card.y).toBe(bar.y + bar.h + BUBBLE_GAP);
    });
  }
});
