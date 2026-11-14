// Control Center arranged from a phone (src/remote/grid-edit.ts): the phone's working copy, arranged
// in place with the island's own actions, what Done sends, and what the island takes from it.

import { describe, expect, it } from 'vitest';
import type { SheetView, Tile } from '../src/core/sheet';
import { draftAct, draftLayout, draftOf, draftView, gridSetAllowed, layoutOf, MAX_GRID_KEYS, pagesOf, rebaseDraft, shownGridKeys, shownGridSizes, withoutTray } from '../src/remote/grid-edit';
import { readPhoneMsg } from '../src/remote/protocol';

const ALL: Array<[number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2]];
const stat = (key: string, page: number, row: number, col: number, sizes: Array<[number, number]> = ALL): Tile => ({
  key, page, row, col, w: 1, h: 1, sizes, body: { k: 'stat' as const, icon: 'x', label: key, value: '' },
});
const grid = (items: Tile[], tray: Tile[] = [{ key: 'h', sizes: ALL, body: { k: 'stat', icon: 'x', label: 'h', value: '' } }]): SheetView => ({
  key: 'island/grid',
  width: 380,
  blocks: [{ t: 'tiles', key: 'grid', cols: 4, rows: 2, pages: 2, cell: 80, items, tray }],
});
const view = grid([stat('c', 1, 0, 0), stat('b', 0, 1, 0, [[1, 1]]), stat('a', 0, 0, 2)]);
const tilesOf = (v: SheetView) => {
  const b = v.blocks[0];
  if (b.t !== 'tiles') throw new Error('no grid');
  return b;
};
const at = (v: SheetView, key: string) => {
  const t = tilesOf(v).items.find((x) => x.key === key);
  return t && { page: t.page, col: t.col, row: t.row, w: t.w, h: t.h };
};

describe('a phone arranging Control Center in place', () => {
  it('starts from the grid in reading order, with the tray taken off', () => {
    expect(layoutOf(view)).toEqual({ order: ['a', 'b', 'c'], hidden: ['h'] });
    expect(layoutOf(null)).toEqual({ order: [], hidden: [] });
    expect(draftOf({ key: 'land/card', blocks: [] })).toBeNull();
  });

  it('keeps every tile where the PC put it, empty cells and pages included', () => {
    expect(pagesOf(tilesOf(view).items, 4)).toEqual([[null, null, 'a', null, 'b'], ['c']]);
    const v = draftView(draftOf(view)!, true);
    expect(at(v, 'a')).toEqual({ page: 0, col: 2, row: 0, w: 1, h: 1 });
    expect(at(v, 'b')).toEqual({ page: 0, col: 0, row: 1, w: 1, h: 1 });
    expect(at(v, 'c')).toEqual({ page: 1, col: 0, row: 0, w: 1, h: 1 });
  });

  it('draws the edit mode the PC draws: every row open, the tray, Reset layout and Done', () => {
    const v = draftView(draftOf(view)!, true);
    const b = tilesOf(v);
    expect(b.editing).toBe(true);
    expect(b.rows).toBe(4);
    expect(b.tray?.map((t) => [t.key, t.hidden])).toEqual([['h', true]]);
    const buttons = v.blocks[1];
    expect(buttons.t === 'buttons' && buttons.items.map((x) => [x.label, x.action])).toEqual([
      ['Reset layout', 'island:grid-reset'],
      ['Done', 'island:grid-done'],
    ]);
    expect(draftView(draftOf(view)!, false).blocks).toHaveLength(1);
  });

  it('Done unchanged sends the layout as it was, and the island takes it', () => {
    const d = draftOf(view)!;
    expect(draftAct(d, 'island:grid-done', null)).toBe('done');
    const l = draftLayout(d);
    expect(l).toEqual({ order: ['a', 'b', 'c'], hidden: ['h'], pages: [[null, null, 'a', null, 'b'], ['c']] });
    expect(gridSetAllowed(shownGridKeys(view), l, shownGridSizes(view))).toBe(true);
  });

  it('takes tiles off with the minus and puts them back with the plus', () => {
    const d = draftOf(view)!;
    draftAct(d, 'island:grid-hide', 'b');
    draftAct(d, 'island:grid-show', 'h');
    const v = draftView(d, true);
    expect(tilesOf(v).tray?.map((t) => t.key)).toEqual(['b']);
    expect(at(v, 'h')).toBeTruthy();
    const l = draftLayout(d);
    expect(l.hidden).toEqual(['b']);
    expect([...l.order].sort()).toEqual(['a', 'c', 'h']);
    expect(gridSetAllowed(shownGridKeys(view), l, shownGridSizes(view))).toBe(true);
  });

  it('drags a tile to another cell and page, and resizes it by its corner', () => {
    const d = draftOf(view)!;
    draftAct(d, 'island:grid-lift', 'c');
    draftAct(d, 'island:grid-move', { key: 'c', page: 0, col: 0, row: 0 });
    expect(at(draftView(d, true), 'c')).toMatchObject({ page: 0, col: 0, row: 0 });
    draftAct(d, 'island:grid-drop', 'c');
    draftAct(d, 'island:grid-lift', 'a');
    draftAct(d, 'island:grid-move', { key: 'a', page: 0, col: 2, row: 0, w: 2, h: 2 });
    draftAct(d, 'island:grid-drop', 'a');
    const v = draftView(d, true);
    expect(at(v, 'a')).toEqual({ page: 0, col: 2, row: 0, w: 2, h: 2 });
    expect(tilesOf(v).pages).toBe(1);
    const l = draftLayout(d);
    expect(l.sizes).toEqual({ a: '2x2' });
    expect(l.pages).toHaveLength(1);
    expect(readPhoneMsg({ t: 'grid-set', ...l })).toEqual({ t: 'grid-set', ...l });
    expect(gridSetAllowed(shownGridKeys(view), l, shownGridSizes(view))).toBe(true);
  });

  it('never gives a tile a size it was not offered', () => {
    const d = draftOf(view)!;
    draftAct(d, 'island:grid-lift', 'b');
    draftAct(d, 'island:grid-move', { key: 'b', page: 0, col: 0, row: 1, w: 2, h: 1 });
    draftAct(d, 'island:grid-drop', 'b');
    expect(at(draftView(d, true), 'b')).toMatchObject({ w: 1, h: 1 });
    expect(draftLayout(d).sizes).toBeUndefined();
  });

  it('a cancelled drag changes nothing; Reset layout is for the PC to do', () => {
    const d = draftOf(view)!;
    draftAct(d, 'island:grid-lift', 'a');
    draftAct(d, 'island:grid-move', { key: 'a', page: 1, col: 3, row: 3 });
    draftAct(d, 'island:grid-cancel', 'a');
    expect(at(draftView(d, true), 'a')).toMatchObject({ page: 0, col: 2, row: 0 });
    expect(draftAct(d, 'island:grid-reset', null)).toBe('reset');
    expect(draftAct(d, 'island:app', 'x')).toBeNull();
  });

  it('follows the PC while arranging: new tiles join, gone ones are left out, other cards end it', () => {
    const d = draftOf(view)!;
    draftAct(d, 'island:grid-hide', 'a');
    const next = grid([stat('a', 0, 0, 2), stat('b', 0, 1, 0, [[1, 1]]), stat('n', 0, 1, 1)]);
    expect(rebaseDraft(d, next)).toBe(true);
    const l = draftLayout(d);
    expect(l.hidden).toEqual(['h', 'a']);
    expect([...l.order].sort()).toEqual(['b', 'n']);
    expect(gridSetAllowed(shownGridKeys(next), l, shownGridSizes(next))).toBe(true);
    expect(rebaseDraft(d, { key: 'land/card', blocks: [] })).toBe(false);
  });
});

describe('the allow-list for a layout from a phone', () => {
  const shown = shownGridKeys(view);
  const sizes = shownGridSizes(view);

  it('is every tile it was shown, grid and tray, with the sizes each was offered', () => {
    expect([...shown].sort()).toEqual(['a', 'b', 'c', 'h']);
    expect(shownGridKeys({ key: 'land/card', blocks: [] }).size).toBe(0);
    expect([...sizes.get('b')!]).toEqual(['1x1']);
    expect(sizes.get('h')?.has('2x2')).toBe(true);
  });

  it('takes exactly those tiles, each once', () => {
    expect(gridSetAllowed(shown, { order: ['c', 'a'], hidden: ['b', 'h'] })).toBe(true);
    expect(gridSetAllowed(shown, { order: ['a', 'b', 'c', 'h', 'x'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(shown, { order: ['a', 'b', 'c'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(shown, { order: ['a', 'a', 'b', 'c'], hidden: [] })).toBe(false);
    expect(gridSetAllowed(new Set(), { order: [], hidden: [] })).toBe(false);
  });

  it('takes pages naming exactly the tiles on the grid', () => {
    const l = { order: ['a', 'b', 'c'], hidden: ['h'] };
    expect(gridSetAllowed(shown, { ...l, pages: [['a', null, 'b'], ['c']] }, sizes)).toBe(true);
    expect(gridSetAllowed(shown, { ...l, pages: [['a', 'b']] }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, pages: [['a', 'b'], ['c', 'h']] }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, pages: [['a', 'b', 'a'], ['c']] }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, pages: [['a', 'b', 'x']] }, sizes)).toBe(false);
  });

  it('takes only sizes a tile on the grid was offered', () => {
    const l = { order: ['a', 'b', 'c'], hidden: ['h'] };
    expect(gridSetAllowed(shown, { ...l, sizes: { a: '2x2', c: '2x1' } }, sizes)).toBe(true);
    expect(gridSetAllowed(shown, { ...l, sizes: { b: '2x1' } }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, sizes: { h: '1x1' } }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, sizes: { x: '1x1' } }, sizes)).toBe(false);
    expect(gridSetAllowed(shown, { ...l, sizes: { a: '2x2' } })).toBe(false);
  });

  it('strips the tray before working out what may be pressed', () => {
    const b = withoutTray(view)!.blocks[0];
    expect(b.t === 'tiles' && b.tray).toEqual([]);
  });
});

describe('phone lines for Sleep and Control Center', () => {
  it('reads sleep and grid-set, with pages, sizes and reset', () => {
    expect(readPhoneMsg({ t: 'sleep' })).toEqual({ t: 'sleep' });
    expect(readPhoneMsg({ t: 'grid-set', order: ['a'], hidden: ['b'] })).toEqual({ t: 'grid-set', order: ['a'], hidden: ['b'] });
    expect(readPhoneMsg({ t: 'grid-set', order: ['a', 'c'], hidden: [], pages: [['a', null], ['c']], sizes: { a: '2x1' } })).toEqual({
      t: 'grid-set', order: ['a', 'c'], hidden: [], pages: [['a', null], ['c']], sizes: { a: '2x1' },
    });
    expect(readPhoneMsg({ t: 'grid-set', order: ['a'], hidden: [], reset: true })).toEqual({ t: 'grid-set', order: ['a'], hidden: [], reset: true });
    expect(readPhoneMsg({ t: 'grid-set', order: ['a'], hidden: [], reset: false })).toEqual({ t: 'grid-set', order: ['a'], hidden: [] });
  });

  it('refuses a malformed or oversized layout', () => {
    expect(readPhoneMsg({ t: 'grid-set', order: 'a', hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: [1], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: [''], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: ['x'.repeat(129)], hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: Array.from({ length: MAX_GRID_KEYS + 1 }, (_, i) => `k${i}`), hidden: [] })).toBeNull();
    expect(readPhoneMsg({ t: 'grid-set', order: ['a'], hidden: [], reset: 'yes' })).toBeNull();
  });

  it('refuses unknown sizes and malformed pages', () => {
    const base = { t: 'grid-set', order: ['a'], hidden: [] };
    expect(readPhoneMsg({ ...base, sizes: { a: '3x3' } })).toBeNull();
    expect(readPhoneMsg({ ...base, sizes: { a: 'toString' } })).toBeNull();
    expect(readPhoneMsg({ ...base, sizes: { a: 2 } })).toBeNull();
    expect(readPhoneMsg({ ...base, sizes: ['2x1'] })).toBeNull();
    expect(readPhoneMsg({ ...base, sizes: null })).toBeNull();
    expect(readPhoneMsg({ ...base, sizes: { '': '1x1' } })).toBeNull();
    expect(readPhoneMsg({ ...base, pages: ['a'] })).toBeNull();
    expect(readPhoneMsg({ ...base, pages: [[1]] })).toBeNull();
    expect(readPhoneMsg({ ...base, pages: [Array.from({ length: 33 }, () => null)] })).toBeNull();
    expect(readPhoneMsg({ ...base, pages: Array.from({ length: 17 }, () => ['a']) })).toBeNull();
  });
});
