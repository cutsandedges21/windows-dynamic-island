import { describe, expect, it } from 'vitest';

import { activityMatches, CATALOG } from '../src/activities/catalog';

describe('Activities search', () => {
  const music = CATALOG.find((a) => a.id === 'music')!;

  it('matches the name, what it does, or an option, in any case', () => {
    expect(activityMatches(music, '')).toBe(true);
    expect(activityMatches(music, 'MUS')).toBe(true);
    expect(activityMatches(music, 'lyrics')).toBe(true);
    expect(activityMatches(music, 'zzz-nothing')).toBe(false);
  });

  it('needs every word to match', () => {
    expect(activityMatches(music, 'music lyrics')).toBe(true);
    expect(activityMatches(music, 'music zzz')).toBe(false);
  });

  it('finds at least one activity for each one’s own name', () => {
    for (const a of CATALOG) expect(CATALOG.filter((x) => activityMatches(x, a.name)).map((x) => x.id)).toContain(a.id);
  });
});
