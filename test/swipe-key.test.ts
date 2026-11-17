// A swipe across the held card on a phone: the hover key it asks with (protocol.ts swipeKey).

import { describe, expect, it } from 'vitest';
import { readSwipe, swipeKey } from '../src/remote/protocol';

describe('swipe keys', () => {
  it('count the steps from the key first held, either way', () => {
    const one = swipeKey('music/title', 1);
    expect(readSwipe(one)).toEqual({ steps: 1, base: 'music/title' });
    const two = swipeKey(one, 1);
    expect(readSwipe(two)).toEqual({ steps: 2, base: 'music/title' });
    expect(readSwipe(swipeKey(two, -1))).toEqual({ steps: 1, base: 'music/title' });
    // Held on nothing in particular: from whatever has the pill.
    expect(readSwipe(swipeKey(null, -1))).toEqual({ steps: -1, base: null });
  });

  it('leave every other key alone', () => {
    expect(readSwipe('chip/claude')).toBeNull();
    expect(readSwipe(null)).toBeNull();
    expect(readSwipe('swipe:x:music')).toBeNull();
  });

  it('stay short enough to send', () => {
    expect(swipeKey('k'.repeat(300), 1).length).toBeLessThanOrEqual(128);
  });
});
