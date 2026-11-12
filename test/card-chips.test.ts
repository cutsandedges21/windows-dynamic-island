import { describe, expect, it } from 'vitest';
import { cardChips } from '../src/core/priority';

// A card grown out of the pill carries the other activities as chips, picked the way the pill picks them.
describe('the chips on a grown card', () => {
  const land = (id: string) => id === 'land';

  it("Land's icon always comes, last, and only the others fold into +N", () => {
    expect(cardChips(['music', 'system', 'land'], land, 2)).toEqual({ shown: ['music', 'system', 'land'], folded: 0 });
    expect(cardChips(['music', 'land', 'system', 'timer'], land, 2)).toEqual({ shown: ['music', 'system', 'land'], folded: 1 });
  });

  it('without a chip-only activity, two and then +N, as before', () => {
    expect(cardChips(['music', 'system', 'timer'], land, 2)).toEqual({ shown: ['music', 'system'], folded: 1 });
    expect(cardChips([], land, 2)).toEqual({ shown: [], folded: 0 });
  });
});
