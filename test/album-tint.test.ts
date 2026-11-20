import { describe, expect, it } from 'vitest';
import { migrate } from '../src/core/settings';

describe("the island in the album's colour", () => {
  it('is off until picked, the pill alone or all of it (Justin, 11-20)', () => {
    expect(migrate({}).island.albumTint).toBe('off');
    expect(migrate({ island: { albumTint: 'compact' } }).island.albumTint).toBe('compact');
    expect(migrate({ island: { albumTint: 'all' } }).island.albumTint).toBe('all');
    expect(migrate({ island: { albumTint: 'everything' } }).island.albumTint).toBe('off');
  });
});
