import { describe, expect, it } from 'vitest';
import { addPaths, shelfSummary } from '../src/activities/shelf';
import { bubbleRect, shelfPanelRect, shelfRect } from '../src/core/layout';

describe('the Shelf', () => {
  it('adds new paths once, newest last, dropping the oldest past the limit', () => {
    expect(addPaths(['a', 'b'], ['c', 'a'])).toEqual(['b', 'c', 'a']);
    expect(addPaths(['a', 'b', 'c'], ['d'], 3)).toEqual(['b', 'c', 'd']);
    expect(addPaths([], [])).toEqual([]);
  });

  it('says how many files and how big', () => {
    expect(shelfSummary([], 0)).toMatch(/Drop files/);
    expect(shelfSummary([{ size: 0, error: null }], 0)).toBe('1 file');
    expect(shelfSummary([{ size: 2048, error: null }, { size: 0, error: 'gone' }], 0)).toMatch(/^2 files · /);
    expect(shelfSummary([{ size: 1, error: null }], 1)).toBe('1 selected');
  });
});

describe("the Shelf's circle", () => {
  const pill = { x: 800, y: 10, w: 200, h: 36 };

  it('sits opposite the bot', () => {
    const bot = bubbleRect(pill, 'top', 36);
    const shelf = shelfRect(pill, 'top', 36);
    expect(bot.x + bot.w).toBeLessThanOrEqual(pill.x);
    expect(shelf.x).toBeGreaterThanOrEqual(pill.x + pill.w);
    expect(shelf.y).toBe(pill.y);
    expect(shelfRect(pill, 'bottom', 36).y + 36).toBe(pill.y + pill.h);
    expect(shelfRect({ x: 0, y: 400, w: 36, h: 200 }, 'left', 36).y).toBeGreaterThanOrEqual(600);
  });

  it('opens away from the edge and stays on screen', () => {
    const area = { width: 1536, height: 864 };
    const c = shelfRect(pill, 'top', 36);
    const p = shelfPanelRect(c, 'top', 300, 132, area);
    expect(p).toEqual({ x: c.x, y: c.y, w: 300, h: 132 });
    const bottom = shelfPanelRect({ x: c.x, y: 820, w: 36, h: 36 }, 'bottom', 300, 132, area);
    expect(bottom.y + bottom.h).toBe(856);
    const edge = shelfPanelRect({ x: 1500, y: 10, w: 36, h: 36 }, 'top', 300, 132, area);
    expect(edge.x + edge.w).toBeLessThanOrEqual(area.width - 8);
  });
});

describe("the Shelf's tile", () => {
  it('says how many files wait, and a tap opens its card', async () => {
    const { ShelfActivity } = await import('../src/activities/shelf');
    const { defaultSettings } = await import('../src/core/settings');
    const settings = defaultSettings();
    let cards = 0;
    const act = new ShelfActivity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (act as any).ctx = { options: () => ({}), settings: () => settings, update: () => {}, setOptions: () => {}, openCard: () => void cards++ };
    const env = { reason: 'open' as const, now: Date.now(), width: 400, vertical: false, interactive: true, surfaced: null };
    expect(act.tile(env)).toMatchObject({ key: 'shelf', action: 'card', body: { k: 'stat', label: 'Shelf', value: 'Empty', sub: 'Drop on the island' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (act as any).items = [{ path: 'C:/a.png', name: 'a.png', size: 2048, dir: false, files: 1, error: null }, { path: 'C:/b', name: 'b', size: 0, dir: false, files: 1, error: 'gone' }];
    expect(act.tile(env)).toMatchObject({ tone: 'accent', body: { value: '2 files', sub: '2.0 KB' } });
    await act.action('card');
    expect(cards).toBe(1);
  });
});
