import { describe, expect, it } from 'vitest';
import { PEEK_REST_MS, PEEK_STILL_PX, PEEK_SWITCH_MS, PeekRest, peekOrder } from '../src/core/dock';

describe('taskbar previews wait for the pointer to rest', () => {
  it('waits PEEK_REST_MS from where the pointer came to rest', () => {
    const r = new PeekRest();
    expect(r.move(10, 10, 1000, false)).toBe(1000 + PEEK_REST_MS);
  });

  it('keeps the wait while the pointer only trembles', () => {
    const r = new PeekRest();
    r.move(10, 10, 1000, false);
    expect(r.move(10 + PEEK_STILL_PX - 1, 10, 1200, false)).toBeNull();
    expect(r.due).toBe(1000 + PEEK_REST_MS);
  });

  it('starts again when the pointer sweeps on, so a sweep shows none', () => {
    const r = new PeekRest();
    r.move(10, 10, 1000, false);
    expect(r.move(40, 10, 1100, false)).toBe(1100 + PEEK_REST_MS);
  });

  it('switches quickly once previews are up', () => {
    const r = new PeekRest();
    expect(r.move(10, 10, 1000, true)).toBe(1000 + PEEK_SWITCH_MS);
  });
});

describe("a window's preview pointed at doesn't swap places (Justin's recording, 11-21)", () => {
  it('keeps the order they came up in when pointing at one brings its window in front', () => {
    // 1.png, tinted-compare, blue-egyptian; pointing at tinted-compare brings it in front.
    expect(peekOrder([1, 2, 3], [2, 1, 3])).toEqual([1, 2, 3]);
    // Then back, or another in front: still the same.
    expect(peekOrder([1, 2, 3], [3, 2, 1])).toEqual([1, 2, 3]);
  });

  it('opens front first, a closed one goes, a new one comes after', () => {
    expect(peekOrder([], [2, 1, 3])).toEqual([2, 1, 3]);
    expect(peekOrder([1, 2, 3], [3, 1])).toEqual([1, 3]);
    expect(peekOrder([1, 2], [4, 2, 1])).toEqual([1, 2, 4]);
  });
});
