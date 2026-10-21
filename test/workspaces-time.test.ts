import { describe, expect, it } from 'vitest';
import { newWorkspace, type Workspace } from '../src/workspaces/model';
import { averageDay, CHART_COLORS, dayName, daysBegun, familyOf, hm, midnights, OTHER_COLOR, seriesMs, seriesOf, shares, shareText, weekLabel, weekOf, weekStart, type WsSpan } from '../src/workspaces/time';

// Local times, so the tests hold in any time zone. 2026-10-20 is a Tuesday.
const at = (month: number, day: number, h = 0, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const NOW = at(10, 20, 13);
const MIN = 60_000;
const ws = (id: string, color = '', name = id): Workspace => ({ ...newWorkspace({ name, color }), id });

describe('the week', () => {
  it('starts on the Sunday before, at midnight', () => {
    expect(weekStart(NOW)).toBe(at(10, 18));
    expect(weekStart(NOW, 1)).toBe(at(10, 11));
    // Sunday itself starts its own week.
    expect(weekStart(at(10, 18, 0, 0))).toBe(at(10, 18));
    expect(weekStart(at(10, 17, 23, 59))).toBe(at(10, 11));
  });

  it('has eight local midnights, also across a daylight saving change', () => {
    const m = midnights(at(11, 1));
    expect(m).toHaveLength(8);
    for (const t of m) expect(new Date(t).getHours()).toBe(0);
    expect(new Date(m[7]).getDate()).toBe(8);
  });

  it('adds each day up per workspace, splitting a span over midnight', () => {
    const spans: WsSpan[] = [
      [at(10, 18, 9), at(10, 18, 10), 'a'],
      [at(10, 18, 23, 30), at(10, 19, 0, 30), 'b'],
      [at(10, 19, 14), at(10, 19, 14, 20), 'a'],
      // Before the week and after it: not counted.
      [at(10, 17, 9), at(10, 17, 10), 'a'],
      [at(10, 25, 9), at(10, 25, 10), 'a'],
    ];
    const w = weekOf(spans, weekStart(NOW));
    expect(w.days[0].get('a')).toBe(60 * MIN);
    expect(w.days[0].get('b')).toBe(30 * MIN);
    expect(w.days[1].get('b')).toBe(30 * MIN);
    expect(w.days[1].get('a')).toBe(20 * MIN);
    expect(w.byWs.get('a')).toBe(80 * MIN);
    expect(w.total).toBe(140 * MIN);
    expect(w.days.slice(2).every((d) => d.size === 0)).toBe(true);
  });

  it('averages over the days begun (today counts), all seven for a past week', () => {
    const w = weekOf([[at(10, 18, 9), at(10, 18, 12), 'a']], weekStart(NOW));
    expect(daysBegun(w, NOW)).toBe(3);
    expect(averageDay(w, NOW)).toBe(60 * MIN);
    const last = weekOf([[at(10, 12, 9), at(10, 12, 16), 'a']], weekStart(NOW, 1));
    expect(daysBegun(last, NOW)).toBe(7);
    expect(averageDay(last, NOW)).toBe(60 * MIN);
    expect(averageDay(weekOf([], weekStart(NOW)), NOW)).toBe(0);
  });
});

describe('who gets which colour', () => {
  it('keeps a workspace in its colour family; the accent stands in for none', () => {
    expect(familyOf('sky', '#e8845f')).toBe('sky');
    expect(familyOf('', '#e8845f')).toBe('ember');
    expect(familyOf('', '#62C99A')).toBe('mint');
    // A colour of the user's own: the nearest family.
    expect(familyOf('', '#3060ff')).toBe('sky');
    expect(familyOf('', '#ff2050')).toBe('rose');
    // White has no hue to keep.
    expect(familyOf('white', '#e8845f')).toBeNull();
    expect(familyOf('', '#ffffff')).toBeNull();
    expect(familyOf('', 'var(--accent)')).toBeNull();
  });

  it('ranks by time; two wanting one colour, the first in the user\'s order keeps it', () => {
    const list = [ws('a', 'sky', 'School'), ws('b', 'sky', 'Island'), ws('c', 'ember', 'Music')];
    const w = weekOf([[at(10, 18, 9), at(10, 18, 10), 'a'], [at(10, 18, 10), at(10, 18, 13), 'b'], [at(10, 19, 9), at(10, 19, 11), 'c']], weekStart(NOW));
    const s = seriesOf(w, list, '#e8845f');
    expect(s.map((x) => x.name)).toEqual(['Island', 'Music', 'School']);
    expect(s.find((x) => x.key === 'a')!.color).toBe(CHART_COLORS.sky);
    expect(s.find((x) => x.key === 'c')!.color).toBe(CHART_COLORS.ember);
    // b wanted sky too: the first free family (ember is taken by c).
    expect(s.find((x) => x.key === 'b')!.color).toBe(CHART_COLORS.mint);
  });

  it('colours follow the workspace, not its rank', () => {
    const list = [ws('a', 'violet'), ws('b', 'gold')];
    const first = seriesOf(weekOf([[at(10, 18, 9), at(10, 18, 12), 'a'], [at(10, 18, 12), at(10, 18, 13), 'b']], weekStart(NOW)), list, '#e8845f');
    const flipped = seriesOf(weekOf([[at(10, 18, 9), at(10, 18, 10), 'a'], [at(10, 18, 12), at(10, 18, 16), 'b']], weekStart(NOW)), list, '#e8845f');
    const colour = (s: typeof first, id: string) => s.find((x) => x.key === id)!.color;
    expect(first[0].key).toBe('a');
    expect(flipped[0].key).toBe('b');
    expect(colour(first, 'a')).toBe(colour(flipped, 'a'));
    expect(colour(first, 'b')).toBe(colour(flipped, 'b'));
  });

  it('shows six at most: five and the rest as Others; deleted workspaces are left out', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const list = ids.map((id) => ws(id));
    const spans: WsSpan[] = ids.map((id, i) => [at(10, 19, 8 + i), at(10, 19, 8 + i, 50 - i * 5), id]);
    spans.push([at(10, 19, 20), at(10, 19, 22), 'gone']);
    const s = seriesOf(weekOf(spans, weekStart(NOW)), list, '#e8845f');
    expect(s).toHaveLength(6);
    expect(s.slice(0, 5).map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s[5]).toMatchObject({ key: 'other', name: 'Others (2)', color: OTHER_COLOR, ids: ['f', 'g'], ms: 45 * MIN });
    expect(new Set(s.slice(0, 5).map((x) => x.color)).size).toBe(5);
    // Exactly six fit without folding.
    expect(seriesOf(weekOf(spans.slice(0, 6), weekStart(NOW)), list, '#e8845f').map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const w = weekOf(spans, weekStart(NOW));
    expect(seriesMs(w.days[1], s[5])).toBe(45 * MIN);
  });
});

describe('the words', () => {
  it('reads times like the screenshot', () => {
    expect(hm(0)).toBe('0m');
    expect(hm(20_000)).toBe('<1m');
    expect(hm(10 * MIN)).toBe('10m');
    expect(hm(404 * MIN)).toBe('6h 44m');
    expect(hm(120 * MIN)).toBe('2h');
  });

  it('percentages add up to 100, and a sliver says so', () => {
    expect(shares([404, 10])).toEqual([98, 2]);
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([1000, 1])).toEqual([100, 0]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(shareText(0, 5)).toBe('<1%');
    expect(shareText(0, 0)).toBe('0%');
    expect(shareText(98, 404)).toBe('98%');
  });

  it('names weeks and days', () => {
    expect(weekLabel(weekStart(NOW), NOW)).toBe('This week');
    expect(weekLabel(weekStart(NOW, 1), NOW)).toBe('Last week');
    expect(weekLabel(weekStart(NOW, 2), NOW)).toBe('Oct 4 – 10');
    expect(weekLabel(weekStart(NOW, 3), NOW)).toBe('Sep 27 – Oct 3');
    expect(dayName(at(10, 20), NOW)).toBe('Today');
    expect(dayName(at(10, 19), NOW)).toBe('Yesterday');
    expect(dayName(at(10, 18), NOW)).toBe('Sunday');
  });
});
