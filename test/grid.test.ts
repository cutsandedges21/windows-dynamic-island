// The Control Center's grid: tiles pack into fixed pages of cells, can sit anywhere
// (empty cells hold the gaps the user left), move the way icons do on a phone's
// home screen, and push each other along when one grows.

import { describe, expect, it } from 'vitest';

import {
  hiddenTest,
  leadFirst,
  moveTile,
  packGrid,
  pageCount,
  rowsUsed,
  settle,
  sizeOf,
  unhide,
  withNew,
  type GridDims,
  type GridItem,
  type GridPages,
  type GridSlot,
} from '../src/core/grid';

const item = (key: string, w = 1, h = 1): GridItem => ({ key, w, h });
/** "key@page:col,row" for every slot, in order. */
const map = (slots: GridSlot[]) => slots.map((s) => `${s.key}@${s.page}:${s.col},${s.row}`);
const at = (slots: GridSlot[], key: string) => {
  const s = slots.find((x) => x.key === key);
  return s ? `${s.page}:${s.col},${s.row}` : 'none';
};
/** Every key 1x1 unless listed; keys in `absent` are not on the grid right now. */
const dimsOf = (sizes: Record<string, [number, number]> = {}, absent: string[] = []): GridDims => (k) =>
  absent.includes(k) ? null : sizes[k] ? { w: sizes[k][0], h: sizes[k][1] } : { w: 1, h: 1 };
const keys = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const one = { w: 1, h: 1 };

describe('packing', () => {
  it('lays tiles left to right, then down', () => {
    const slots = packGrid([item('a', 2), item('b'), item('c'), item('d', 2, 2)], 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:2,0', 'c@0:3,0', 'd@0:0,1']);
  });

  it('lets a small tile backfill the gap a big one left', () => {
    // The 2x2 cannot start at column 3, so it drops to the next row and the 1x1 fills the hole.
    const slots = packGrid([item('wide', 3), item('big', 2, 2), item('small')], 4, 4);
    expect(map(slots)).toEqual(['wide@0:0,0', 'big@0:0,1', 'small@0:3,0']);
  });

  it('starts a new page when one is full, and counts pages', () => {
    const slots = packGrid(keys(20).map((k) => item(k)), 4, 4);
    expect(pageCount(slots)).toBe(2);
    expect(slots.filter((s) => s.page === 0)).toHaveLength(16);
    expect(map(slots).at(-1)).toBe('t19@1:3,0');
  });

  it('holds six 2x1 or twelve 1x1 tiles on a four by three page', () => {
    expect(pageCount(packGrid(keys(6).map((k) => item(k, 2)), 4, 3))).toBe(1);
    expect(pageCount(packGrid(keys(7).map((k) => item(k, 2)), 4, 3))).toBe(2);
    expect(pageCount(packGrid(keys(12).map((k) => item(k)), 4, 3))).toBe(1);
  });

  it('never lets a tile exceed the grid', () => {
    const [slot] = packGrid([item('huge', 9, 9)], 4, 4);
    expect([slot.w, slot.h]).toEqual([4, 4]);
  });

  it('is stable: the same items pack the same way', () => {
    const items = [item('a', 2, 2), item('b'), item('c', 2), item('d')];
    expect(map(packGrid(items, 4, 4))).toEqual(map(packGrid(items, 4, 4)));
  });
});

describe('settling the saved layout', () => {
  it('keeps an empty cell where the user left one', () => {
    const { slots } = settle([['a', null, null, 'b']], dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:3,0']);
  });

  it('drops empty cells after the last tile and pages with no tile', () => {
    const { pages, slots } = settle([['a', null, null], [null, null], ['b']], dimsOf(), 4, 4);
    expect(pages).toEqual([['a'], ['b']]);
    expect(at(slots, 'b')).toBe('1:0,0');
  });

  it('sends what a page has no room for to the front of the next page', () => {
    const page0 = keys(16);
    const { pages, slots } = settle([[...page0, 'x'], ['y']], dimsOf(), 4, 4);
    expect(pages[1]).toEqual(['x', 'y']);
    expect([at(slots, 'x'), at(slots, 'y')]).toEqual(['1:0,0', '1:1,0']);
  });

  it('opens a new page at the end when the last one overflows', () => {
    const { pages, slots } = settle([[...keys(16), 'x']], dimsOf(), 4, 4);
    expect(pages).toHaveLength(2);
    expect(at(slots, 'x')).toBe('1:0,0');
  });

  it('a tile with nothing to show takes no cell but keeps its place for later', () => {
    const away = settle([['a', 'music', 'b']], dimsOf({}, ['music']), 4, 4);
    expect(map(away.slots)).toEqual(['a@0:0,0', 'b@0:1,0']);
    expect(away.pages).toEqual([['a', 'music', 'b']]);
    const back = settle(away.pages, dimsOf(), 4, 4);
    expect(map(back.slots)).toEqual(['a@0:0,0', 'music@0:1,0', 'b@0:2,0']);
  });

  it('a page holding only absent tiles goes, and they join the page before it', () => {
    const { pages, slots } = settle([['a'], ['music']], dimsOf({}, ['music']), 4, 4);
    expect(pages).toEqual([['a', 'music']]);
    expect(pageCount(slots)).toBe(1);
  });

  it('is idempotent', () => {
    const first = settle([['a', null, 'b', null], [null, 'c']], dimsOf({ b: [2, 2] }), 4, 4);
    expect(settle(first.pages, dimsOf({ b: [2, 2] }), 4, 4)).toEqual(first);
  });
});

describe('moving a tile', () => {
  const row = (): GridPages => [['a', 'b', 'c', 'd']];

  it('dropping on a tile ahead takes its place; the ones between shift back', () => {
    const { slots } = moveTile(row(), 'a', { page: 0, col: 2, row: 0 }, one, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['b@0:0,0', 'c@0:1,0', 'a@0:2,0', 'd@0:3,0']);
  });

  it('dropping on a tile behind pushes that one along', () => {
    const { slots } = moveTile(row(), 'd', { page: 0, col: 1, row: 0 }, one, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'd@0:1,0', 'b@0:2,0', 'c@0:3,0']);
  });

  it('dropping on empty space puts it exactly there, and its old spot closes up', () => {
    const { pages, slots } = moveTile(row(), 'a', { page: 0, col: 3, row: 2 }, one, dimsOf(), 4, 4);
    expect(at(slots, 'a')).toBe('0:3,2');
    expect(map(slots).slice(0, 3)).toEqual(['b@0:0,0', 'c@0:1,0', 'd@0:2,0']);
    // Eight empty cells hold it in the corner: the rest of row 0, row 1, the start of row 2.
    expect(pages[0].filter((e) => e === null)).toHaveLength(8);
  });

  it('dropping a tile back where it was changes nothing', () => {
    const start = settle([['a', null, 'b', 'c'], ['d']], dimsOf(), 4, 4);
    for (const s of start.slots) {
      const again = moveTile(start.pages, s.key, s, s, dimsOf(), 4, 4);
      expect(again).toEqual(start);
    }
  });

  it('dropping onto an empty cell takes it without pushing anything', () => {
    const start = settle([['a', null, null, 'x'], ['b', 'c']], dimsOf(), 4, 4);
    const { slots } = moveTile(start.pages, 'c', { page: 0, col: 1, row: 0 }, one, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'c@0:1,0', 'x@0:3,0', 'b@1:0,0']);
  });

  it('moving into the empty cell beside it trades places with the empty cell', () => {
    const start = settle([['x', 'a', null, 'b']], dimsOf(), 4, 4);
    const { pages, slots } = moveTile(start.pages, 'a', { page: 0, col: 2, row: 0 }, one, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['x@0:0,0', 'a@0:2,0', 'b@0:3,0']);
    expect(pages[0]).toEqual(['x', null, 'a', 'b']);
  });

  it('moves to another page, landing on the cell it was dropped on', () => {
    const start = settle([keys(18)], dimsOf(), 4, 4);
    const past = moveTile(start.pages, 't0', { page: 1, col: 2, row: 0 }, one, dimsOf(), 4, 4);
    expect([at(past.slots, 't16'), at(past.slots, 't17'), at(past.slots, 't0')]).toEqual(['1:0,0', '1:1,0', '1:2,0']);
    // Page 0 closed up behind it.
    expect(at(past.slots, 't1')).toBe('0:0,0');
    const onto = moveTile(start.pages, 't0', { page: 1, col: 0, row: 0 }, one, dimsOf(), 4, 4);
    expect([at(onto.slots, 't0'), at(onto.slots, 't16'), at(onto.slots, 't17')]).toEqual(['1:0,0', '1:1,0', '1:2,0']);
  });

  it('a page one past the last is a new page', () => {
    const { pages, slots } = moveTile(row(), 'c', { page: 1, col: 1, row: 1 }, one, dimsOf(), 4, 4);
    expect(pages).toHaveLength(2);
    expect(at(slots, 'c')).toBe('1:1,1');
    // Pages further out than that are not made up.
    expect(at(moveTile(row(), 'c', { page: 5, col: 0, row: 0 }, one, dimsOf(), 4, 4).slots, 'c')).toBe('1:0,0');
  });

  it('a page the tile leaves empty goes away', () => {
    const start = settle([['a', 'b'], ['c']], dimsOf(), 4, 4);
    const { pages, slots } = moveTile(start.pages, 'c', { page: 0, col: 3, row: 0 }, one, dimsOf(), 4, 4);
    expect(pages).toHaveLength(1);
    expect(at(slots, 'c')).toBe('0:3,0');
  });

  it('dropping on a full page pushes its last tile onto the next page', () => {
    const start = settle([keys(16), ['x']], dimsOf(), 4, 4);
    const { slots } = moveTile(start.pages, 'x', { page: 0, col: 0, row: 0 }, one, dimsOf(), 4, 4);
    expect(at(slots, 'x')).toBe('0:0,0');
    expect(at(slots, 't15')).toBe('1:0,0');
    expect(pageCount(slots)).toBe(2);
  });

  it('a big tile dropped on small ones goes first; they flow after it', () => {
    const start = settle([keys(8), ['q']], dimsOf({ q: [2, 2] }), 4, 4);
    const { slots } = moveTile(start.pages, 'q', { page: 0, col: 0, row: 0 }, { w: 2, h: 2 }, dimsOf({ q: [2, 2] }), 4, 4);
    expect(map(slots).slice(0, 5)).toEqual(['q@0:0,0', 't0@0:2,0', 't1@0:3,0', 't2@0:2,1', 't3@0:3,1']);
    expect(pageCount(slots)).toBe(1);
  });

  it('a wide tile dropped at the last column moves left until it fits', () => {
    const { slots } = moveTile([['w', 'a']], 'w', { page: 0, col: 3, row: 1 }, { w: 2, h: 1 }, dimsOf({ w: [2, 1] }), 4, 4);
    expect(at(slots, 'w')).toBe('0:2,1');
  });

  it('a tile with nothing to show keeps its place in the list through a move', () => {
    const dims = dimsOf({}, ['music']);
    const start = settle([['a', 'music', 'b', 'c']], dims, 4, 4);
    const moved = moveTile(start.pages, 'c', { page: 0, col: 0, row: 0 }, one, dims, 4, 4);
    expect(moved.pages[0]).toEqual(['c', 'a', 'music', 'b']);
    // When it comes back, it is next to the tile it was next to.
    expect(map(settle(moved.pages, dimsOf(), 4, 4).slots)).toEqual(['c@0:0,0', 'a@0:1,0', 'music@0:2,0', 'b@0:3,0']);
  });
});

describe('resizing a tile', () => {
  it('growing pushes the tiles after it along', () => {
    const start = settle([['a', 'b', 'c', 'd', 'e']], dimsOf(), 4, 4);
    const { slots } = moveTile(start.pages, 'a', { page: 0, col: 0, row: 0 }, { w: 2, h: 2 }, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:2,0', 'c@0:3,0', 'd@0:2,1', 'e@0:3,1']);
  });

  it('growing into an empty cell takes it without pushing anything', () => {
    const start = settle([['a', null, 'b']], dimsOf(), 4, 4);
    const { slots } = moveTile(start.pages, 'a', { page: 0, col: 0, row: 0 }, { w: 2, h: 1 }, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:2,0']);
  });

  it('growing at the right edge moves the tile left to make room', () => {
    const start = settle([['a', 'b', 'c', 'd']], dimsOf(), 4, 4);
    const { slots } = moveTile(start.pages, 'd', { page: 0, col: 3, row: 0 }, { w: 2, h: 1 }, dimsOf(), 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:1,0', 'd@0:2,0', 'c@0:0,1']);
  });

  it('shrinking lets the tiles after it flow back', () => {
    const big = dimsOf({ a: [2, 2] });
    const start = settle([['a', 'b', 'c', 'd', 'e']], big, 4, 4);
    const { slots } = moveTile(start.pages, 'a', { page: 0, col: 0, row: 0 }, one, big, 4, 4);
    expect(map(slots)).toEqual(['a@0:0,0', 'b@0:1,0', 'c@0:2,0', 'd@0:3,0', 'e@0:0,1']);
  });
});

describe('tiles that are not placed yet', () => {
  it('build the default layout in their own order', () => {
    const pages = withNew([], ['island/day', 'local', 'claude'], dimsOf());
    expect(pages).toEqual([['island/day', 'local', 'claude']]);
  });

  it('go in right after their neighbour in the activities order', () => {
    const pages = withNew([['c', 'a'], ['b']], ['a', 'music', 'b', 'c'], dimsOf());
    expect(pages).toEqual([['c', 'a', 'music'], ['b']]);
  });

  it('take up empty cells right behind that neighbour instead of pushing tiles', () => {
    const pages = withNew([['a', null, null, 'x']], ['a', 'm', 'x'], dimsOf());
    expect(pages).toEqual([['a', 'm', null, 'x']]);
    expect(map(settle(pages, dimsOf(), 4, 4).slots)).toEqual(['a@0:0,0', 'm@0:1,0', 'x@0:3,0']);
  });

  it('go in front of the next one when nothing before them is placed', () => {
    expect(withNew([['b']], ['a', 'b'], dimsOf())).toEqual([['a', 'b']]);
  });
});

describe('sizes', () => {
  it('reads back as the label the settings store', () => {
    expect([sizeOf(1, 1), sizeOf(2, 1), sizeOf(1, 2), sizeOf(2, 2)]).toEqual(['1x1', '2x1', '1x2', '2x2']);
    expect(sizeOf(5, 0)).toBe('2x1');
  });
});

describe('hidden tiles', () => {
  it('an entry hides one tile, or every tile of an activity', () => {
    const hidden = hiddenTest(['weather/weather', 'sound']);
    expect(hidden('weather/weather')).toBe(true);
    expect(hidden('sound/sound')).toBe(true);
    expect(hidden('claude/claude')).toBe(false);
    expect(hidden('soundboard/x')).toBe(false);
  });

  it('putting a tile back undoes either kind of entry', () => {
    expect(unhide(['weather/weather', 'sound', 'devices'], 'sound/sound')).toEqual(['weather/weather', 'devices']);
    expect(unhide(['weather/weather'], 'weather/weather')).toEqual([]);
  });
});

describe('the default layout', () => {
  it('opens with Local AI right after the day tile: top and centre on four columns', () => {
    expect(leadFirst(['claude', 'music', 'local', 'timer'])).toEqual(['local', 'claude', 'music', 'timer']);
    const slots = packGrid([item('island/day'), item('local', 2), item('claude', 2), item('music', 2, 2)], 4, 4);
    expect(map(slots).slice(0, 2)).toEqual(['island/day@0:0,0', 'local@0:1,0']);
  });

  it('leaves an order without Local AI as it is', () => {
    const order = ['claude', 'music'];
    expect(leadFirst(order)).toBe(order);
  });
});

describe('grid height', () => {
  it('is the rows the tiles reach down to, at least one', () => {
    expect(rowsUsed(packGrid([item('island/day'), item('local', 2)], 4, 4))).toBe(1);
    expect(rowsUsed(packGrid([item('island/day'), item('local', 2), item('music', 2, 2)], 4, 4))).toBe(3);
    expect(rowsUsed([])).toBe(1);
  });

  it('never passes a full page, however many pages there are', () => {
    expect(rowsUsed(packGrid(keys(20).map((k) => item(k)), 4, 4))).toBe(4);
  });

  it('reaches as far down as a tile the user put low', () => {
    const { slots } = moveTile([['a', 'b']], 'b', { page: 0, col: 0, row: 3 }, one, dimsOf(), 4, 4);
    expect(rowsUsed(slots)).toBe(4);
  });
});
