// Control Center arranged from a phone (src/remote/grid-edit.ts): the phone's edits, and what the
// island takes from it.

import { describe, expect, it } from 'vitest';
import type { SheetView } from '../src/core/sheet';
import { addKey, gridSetAllowed, layoutOf, MAX_GRID_KEYS, moveKey, removeKey, shownGridKeys, withoutTray } from '../src/remote/grid-edit';
import { readPhoneMsg } from '../src/remote/protocol';

const stat = (key: string, page: number, row: number, col: number) => ({ key, page, row, col, body: { k: 'stat' as const, icon: 'x', label: key, value: '' } });
const view: SheetView = {
  key: 'island/grid',
  blocks: [
    {
      t: 'tiles', key: 'grid', cols: 4, rows: 2, pages: 2, cell: 80,
      items: [stat('c', 1, 0, 0), stat('b', 0, 1, 0), stat('a', 0, 0, 2)],
      tray: [{ key: 'h', body: { k: 'stat', icon: 'x', label: 'h', value: '' } }],
    },
  ],
};

describe('a phone arranging Control Center', () => {
  it('starts from the grid in reading order, with the tray taken off', () => {
    expect(layoutOf(view)).toEqual({ order: ['a', 'b', 'c'], hidden: ['h'] });
    expect(layoutOf(null)).toEqual({ order: [], hidden: [] });
  });

  it('reorders, clamping at the ends', () => {
    const l = { order: ['a', 'b', 'c'], hidden: [] };
    expect(moveKey(l, 'c', 0).order).toEqual(['c', 'a', 'b']);
    expect(moveKey(l, 'a', 1).order).toEqual(['b', 'a', 'c']);
    expect(moveKey(l, 'a', 99).order).toEqual(['b', 'c', 'a']);
    expect(moveKey(l, 'a', -5).order).toEqual(['a', 'b', 'c']);
    expect(moveKey(l, 'zzz', 0)).toBe(l);
  });

  it('takes tiles off into the tray and puts them back at the end', () => {
    const off = removeKey({ order: ['a', 'b', 'c'], hidden: ['h'] }, 'b');
    expect(off).toEqual({ order: ['a', 'c'], hidden: ['h', 'b'] });
    expect(addKey(off, 'h')).toEqual({ order: ['a', 'c', 'h'], hidden: ['b'] });
    expect(removeKey(off, 'b')).toBe(off);
    expect(addKey(off, 'a')).toBe(off);
  });
});

describe('the allow-list for a layout from a phone', () => {
  const shown = shownGridKeys(view);

  it('is every tile it was shown, grid and tray', () => {
    expect([...shown].sort()).toEqual(['a', 'b', 'c', 'h']);
    expect(shownGridKeys({ key: 'land/card', blocks: [] }).size).toBe(0);
  });

  it('takes exactly those tiles, each once', () => {
    expect(gridSetAllowed(shown, { order: ['c', 'a'], hidden: ['b', 'h'] })).toBe(true);
    expect(gridSetAllowed(shown, { order: ['a', 'b', 'c', 'h', 'x'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(shown, { order: ['a', 'b', 'c'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(shown, { order: ['a', 'a', 'b', 'c'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(new Set(), { order: [], hidden: [] })).toBe(false);
  });

  it('strips the tray before working out what may be pressed', () => {
    const b = withoutTray(view)!.blocks[0];
    expect(b.t === 'tiles' && b.tray).toEqual([]);
  });
});

describe('phone lines for Sleep and Control Center', () => {
  it('reads sleep and grid-set', () => {
    expect(readPhoneMsg({ t: 'sleep' })).toEqual({ t: 'sleep' });
    expect(readPhoneMsg({ t: 'grid-set', order: ['a'], hidden: ['b'] })).toEqual({ t: 'grid-set', order: ['a'], hidden: ['b'] });
  });

  it('refuses a malformed or oversized layout', () => {
    expect(readPhoneMsg({ t: 'grid-set', order: 'a', hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: [1], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: [''], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: ['x'.repeat(129)], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: Array.from({ length: MAX_GRID_KEYS + 1 }, (_, i) => `k${i}`), hidden: [] })).toBeNull();
  });
});
