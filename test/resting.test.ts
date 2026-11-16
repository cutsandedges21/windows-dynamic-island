// A placed Control Center tile keeps its spot while its activity has nothing to show
// (src/core/resting.ts): its stand-in has the tile's size, so nothing around it moves.

import { describe, expect, it } from 'vitest';
import { settle, withNew, type GridDims } from '../src/core/grid';
import { restingTile } from '../src/core/resting';

const NARROW = new Set(['stat', 'actions', 'dots']);

describe('a resting tile', () => {
  it('has the size its tile last had, dimmed, with the activity name', () => {
    expect(restingTile('music/now', 'Music', 'music', { span: 2, rows: 2, kind: 'media' }, NARROW)).toMatchObject({
      key: 'music/now',
      span: 2,
      rows: 2,
      tone: 'dim',
      resting: true,
      body: { k: 'actions', icon: 'music', label: 'Music', sub: 'Nothing right now', buttons: [] },
    });
    expect(restingTile('timer/t', 'Timer', 'timer', { span: 1, rows: 1, kind: 'stat' }, NARROW)).toMatchObject({ span: 1, rows: 1 });
    // A kind that needs two columns keeps them even if it was saved narrow.
    expect(restingTile('dl/d', 'Downloads', 'download', { span: 1, rows: 2, kind: 'list' }, NARROW)).toMatchObject({ span: 2, rows: 2 });
    // Never seen yet: one cell.
    expect(restingTile('x/y', 'X', 'stack', undefined, NARROW)).toMatchObject({ span: 1, rows: 1 });
  });

  it('holds the place: the tiles after it stay where they were', () => {
    const dims = new Map([
      ['claude/c', { w: 2, h: 2 }],
      ['music/now', { w: 2, h: 1 }],
      ['timer/t', { w: 1, h: 1 }],
      ['land/l', { w: 1, h: 1 }],
    ]);
    const all: GridDims = (k) => dims.get(k) ?? null;
    const pages = [['claude/c', 'music/now', 'timer/t', 'land/l']];
    const where = (r: ReturnType<typeof settle>) => Object.fromEntries(r.slots.map((s) => [s.key, [s.page, s.col, s.row]]));
    const shown = where(settle(pages, all, 4, 4));
    // Music has nothing: gone, Timer and Land move into its spot.
    const without: GridDims = (k) => (k === 'music/now' ? null : all(k));
    expect(where(settle(pages, without, 4, 4))['timer/t']).not.toEqual(shown['timer/t']);
    // Its stand-in, the same size: everything stays.
    const rest = restingTile('music/now', 'Music', 'music', { span: 2, rows: 1, kind: 'media' }, NARROW);
    const withRest: GridDims = (k) => (k === 'music/now' ? { w: rest.span!, h: rest.rows! } : all(k));
    expect(where(settle(pages, withRest, 4, 4))).toEqual(shown);
  });

  it('a tile the user never placed goes after all of theirs, not between them', () => {
    const dims: GridDims = () => ({ w: 1, h: 1 });
    const theirs = [['claude/c', 'timer/t'], ['land/l']];
    // Downloads comes in between Claude and Timer in the activities' order.
    expect(withNew(theirs, ['claude/c', 'downloads/d', 'timer/t', 'land/l'], dims, true)).toEqual([['claude/c', 'timer/t'], ['land/l', 'downloads/d']]);
    // Before they ever arranged, new tiles still go next to their neighbours.
    expect(withNew(theirs, ['claude/c', 'downloads/d', 'timer/t', 'land/l'], dims)).toEqual([['claude/c', 'downloads/d', 'timer/t'], ['land/l']]);
  });
});
