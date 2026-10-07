// The Control Center's packing: tiles fill gaps, overflow onto pages, and moving
// one shuffles the others the way dropping a box on a shelf would.

import { describe, expect, it } from 'vitest';

import { dropBefore, hiddenTest, leadFirst, moveBefore, packGrid, pageCount, rowsUsed, sizeOf, unhide, type GridItem } from '../src/core/grid';

const item = (key: string, w = 1, h = 1): GridItem => ({ key, w, h });
/** "key@page:col,row" for every slot, in order. */
const map = (slots: ReturnType<typeof packGrid>) => slots.map((s) => `${s.key}@${s.page}:${s.col},${s.row}`);

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
    const many = Array.from({ length: 20 }, (_, i) => item(`t${i}`));
    const slots = packGrid(many, 4, 4);
    expect(pageCount(slots)).toBe(2);
    expect(slots.filter((s) => s.page === 0)).toHaveLength(16);
    expect(map(slots).at(-1)).toBe('t19@1:3,0');
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

describe('moving a tile', () => {
  const order = ['a', 'b', 'c', 'd'];
  const slots = packGrid(order.map((k) => item(k)), 4, 4);

  it('dropping on a tile ahead takes its place', () => {
    // 'a' dragged onto 'c' (cell 2,0) lands in front of 'd'.
    const before = dropBefore(slots, order, 'a', 0, 2, 0);
    expect(before).toBe('d');
    expect(moveBefore(order, 'a', before)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('dropping on a tile behind pushes that one along', () => {
    const before = dropBefore(slots, order, 'd', 0, 1, 0);
    expect(before).toBe('b');
    expect(moveBefore(order, 'd', before)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('dropping on empty space puts it after the last tile before that spot', () => {
    expect(dropBefore(slots, order, 'a', 0, 3, 2)).toBeNull();
    expect(moveBefore(order, 'a', null)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('dropping a tile back on itself changes nothing', () => {
    const before = dropBefore(slots, order, 'b', 0, 1, 0);
    expect(moveBefore(order, 'b', before)).toEqual(order);
  });

  it('dropping past the last tile on a later page sends it to the end', () => {
    const many = Array.from({ length: 18 }, (_, i) => `t${i}`);
    const packed = packGrid(many.map((k) => item(k)), 4, 4);
    // Page 1 holds t16 and t17; cell (2,0) is the empty space after them.
    const before = dropBefore(packed, many, 't0', 1, 2, 0);
    expect(before).toBeNull();
    expect(moveBefore(many, 't0', before).slice(-3)).toEqual(['t16', 't17', 't0']);
    // Dropped on t16 (the first tile of that page), it slots in between t16 and t17.
    expect(dropBefore(packed, many, 't0', 1, 0, 0)).toBe('t17');
    expect(moveBefore(many, 't0', 't17').slice(-3)).toEqual(['t16', 't0', 't17']);
  });

  it('moveBefore leaves an unknown tile alone', () => {
    expect(moveBefore(order, 'zz', 'a')).toEqual(order);
  });
});

describe('sizes', () => {
  it('reads back as the label the settings store', () => {
    expect([sizeOf(1, 1), sizeOf(2, 1), sizeOf(1, 2), sizeOf(2, 2)]).toEqual(['1x1', '2x1', '1x2', '2x2']);
    expect(sizeOf(5, 0)).toBe('2x1');
  });

  it('a resized tile pushes the ones after it', () => {
    const order = ['a', 'b', 'c'];
    const small = packGrid(order.map((k) => item(k)), 4, 4);
    expect(small.every((s) => s.row === 0)).toBe(true);
    const grown = packGrid([item('a', 2, 2), item('b'), item('c')], 4, 4);
    expect(map(grown)).toEqual(['a@0:0,0', 'b@0:2,0', 'c@0:3,0']);
    // Three wide tiles no longer share a row.
    const wide = packGrid([item('a', 2), item('b', 2), item('c', 2)], 4, 4);
    expect(map(wide)).toEqual(['a@0:0,0', 'b@0:2,0', 'c@0:0,1']);
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
    const many = Array.from({ length: 20 }, (_, i) => item(`t${i}`));
    expect(rowsUsed(packGrid(many, 4, 4))).toBe(4);
  });
});
