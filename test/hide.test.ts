// Hiding the island for a while: when it comes back, how that reads, and how it is saved.

import { describe, expect, it } from 'vitest';
import { backAt, defaultSettings, HIDE_CHOICES, HIDE_UNTIL_SHOWN, hiddenNow, hideUntil, migrate } from '../src/core/settings';

/** Local time, so the morning rule is checked the way the user sees the clock. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

describe('hiding the island', () => {
  it('offers five lengths, in order', () => {
    expect(HIDE_CHOICES.map((c) => c.id)).toEqual(['30m', '1h', '3h', 'morning', 'shown']);
  });

  it('comes back after the time picked', () => {
    const now = at(2026, 10, 13, 15, 12);
    expect(hideUntil('30m', now)).toBe(now + 30 * MIN);
    expect(hideUntil('1h', now)).toBe(now + 60 * MIN);
    expect(hideUntil('3h', now)).toBe(now + 180 * MIN);
    expect(hideUntil('shown', now)).toBe(HIDE_UNTIL_SHOWN);
  });

  it('"until tomorrow morning" is the next 6 AM at least an hour away', () => {
    expect(hideUntil('morning', at(2026, 10, 13, 15, 0))).toBe(at(2026, 10, 14, 6));
    // Past midnight, this morning's 6 AM is still to come.
    expect(hideUntil('morning', at(2026, 10, 14, 1, 30))).toBe(at(2026, 10, 14, 6));
    // Half an hour before 6 AM: the next day's.
    expect(hideUntil('morning', at(2026, 10, 14, 5, 30))).toBe(at(2026, 10, 15, 6));
  });

  it('says when it comes back in words', () => {
    const now = at(2026, 10, 13, 15, 12);
    expect(backAt(now + 60 * MIN, now)).toBe('at 4:12 PM');
    expect(backAt(at(2026, 10, 14, 6), now)).toBe('tomorrow at 6:00 AM');
    expect(backAt(at(2026, 10, 16, 6), now)).toBe('Friday at 6:00 AM');
    expect(backAt(HIDE_UNTIL_SHOWN, now)).toBeNull();
  });

  it('is hidden only until then', () => {
    const now = at(2026, 10, 13, 15, 12);
    expect(hiddenNow({ hiddenUntil: 0 }, now)).toBe(false);
    expect(hiddenNow({ hiddenUntil: now + 1 }, now)).toBe(true);
    expect(hiddenNow({ hiddenUntil: now }, now)).toBe(false);
    expect(hiddenNow({ hiddenUntil: HIDE_UNTIL_SHOWN }, now)).toBe(true);
  });

  it('keeps a saved hide across restarts and drops junk', () => {
    expect(defaultSettings().island.hiddenUntil).toBe(0);
    const saved = (v: unknown) => {
      const raw = defaultSettings() as unknown as Record<string, any>;
      raw.island.hiddenUntil = v;
      return migrate(raw).island.hiddenUntil;
    };
    expect(saved(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(saved(HIDE_UNTIL_SHOWN)).toBe(HIDE_UNTIL_SHOWN);
    expect(saved(Number.MAX_VALUE)).toBe(HIDE_UNTIL_SHOWN);
    expect(saved(-5)).toBe(0);
    expect(saved(Number.NaN)).toBe(0);
    expect(saved('soon')).toBe(0);
  });
});
