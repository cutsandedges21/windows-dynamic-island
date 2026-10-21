// The chat row's estimates (src/activities/claude/estimate.ts) and the turn marks they come from.

import { describe, expect, it } from 'vitest';
import { about, contextFill, contextWindow, turnLeft } from '../src/activities/claude/estimate';
import { foldMarks, newHistory } from '../src/activities/claude/transcript';

const MIN = 60_000;

describe('context window', () => {
  it('a million tokens for the Claude 5 models and anything seen past 200k, else 200k', () => {
    expect(contextWindow('claude-opus-5-5', 1000)).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-5', 1000)).toBe(1_000_000);
    expect(contextWindow('claude-fable-5-1', 1000)).toBe(1_000_000);
    expect(contextWindow('claude-haiku-5-5', 1000)).toBe(200_000);
    expect(contextWindow('claude-sonnet-4-6', 150_000)).toBe(200_000);
    expect(contextWindow('claude-sonnet-4-6', 250_000)).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-4-6[1m]', 10)).toBe(1_000_000);
    expect(contextWindow(null, 10)).toBe(200_000);
  });
});

describe('context fill', () => {
  it('nothing before the first reading', () => {
    expect(contextFill('claude-opus-5-5', [])).toBeNull();
  });

  it('the share of the window, and the time to full at the pace it grew while working', () => {
    // 100k tokens over 10 minutes of work: 10k a minute, 800k to go = 80 minutes.
    const ctx: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) ctx.push([i * MIN, 100_000 + i * 10_000]);
    const f = contextFill('claude-opus-5-5', ctx)!;
    expect(f.used).toBe(200_000);
    expect(f.window).toBe(1_000_000);
    expect(f.share).toBeCloseTo(0.2);
    expect(f.fullIn! / MIN).toBeCloseTo(80);
  });

  it('a long break between replies is not counted as slow work', () => {
    const ctx: Array<[number, number]> = [
      [0, 100_000],
      [1 * MIN, 110_000],
      [2 * MIN, 120_000],
      [3 * MIN, 130_000],
      [3 * MIN + 8 * 3600_000, 140_000], // the next morning
      [4 * MIN + 8 * 3600_000, 150_000],
    ];
    const f = contextFill('claude-opus-5-5', ctx)!;
    expect(f.fullIn! / MIN).toBeCloseTo(85); // 40k over 4 working minutes: 10k a minute, 850k to go
  });

  it('no pace from a minute of work, nor from a context that only shrank', () => {
    expect(contextFill('claude-opus-5-5', [[0, 100_000], [MIN, 120_000]])!.fullIn).toBeNull();
    expect(contextFill('claude-opus-5-5', [[0, 100_000], [3 * MIN, 90_000], [6 * MIN, 80_000]])!.fullIn).toBeNull();
  });
});

describe('turn left', () => {
  it('needs two finished turns to go by', () => {
    expect(turnLeft([], 0)).toBeNull();
    expect(turnLeft([5 * MIN], 0)).toBeNull();
  });

  it('the middle of the recent turns longer than this one has run so far, minus its time', () => {
    const turns = [16_000, 200_000, 709_000];
    expect(turnLeft(turns, 5_000)).toBe(195_000); // could be any of them: the middle one, 200 s
    expect(turnLeft(turns, 30_000)).toBe(454_500 - 30_000); // past the short one: 200 s or 709 s
    expect(turnLeft(turns, 300_000)).toBe(409_000); // only the long one is left
    expect(turnLeft(turns, 800_000)).toBe(Infinity); // longer than any of them
  });

  it('turns left waiting for hours do not count', () => {
    expect(turnLeft([60_000, 90_000, 5 * 3600_000], 0)).toBe(75_000);
  });
});

describe('about', () => {
  it('rounds to what a glance needs', () => {
    expect(about(20_000)).toBe('<1 min');
    expect(about(3.4 * MIN)).toBe('~3 min');
    expect(about(95 * MIN)).toBe('~2 h');
    expect(about(3 * 86400_000)).toBeNull();
    expect(about(Infinity)).toBeNull();
    expect(about(-1)).toBeNull();
  });
});

describe('turn marks', () => {
  it('a turn runs from the newest prompt to the reply that ends it; interrupts are not counted', () => {
    const h = newHistory();
    foldMarks(h, [
      ['p', 0, 0],
      ['u', 5_000, 10_000],
      ['e', 60_000, 0],
      ['p', 100_000, 0], // a local command that never reached Claude...
      ['p', 120_000, 0], // ...then the real prompt
      ['u', 130_000, 12_000],
      ['e', 150_000, 0],
      ['p', 200_000, 0],
      ['x', 210_000, 0], // interrupted
      ['e', 220_000, 0], // a reply with no prompt open: not a turn
    ]);
    expect(h.turns).toEqual([60_000, 30_000]);
    expect(h.ctx).toEqual([[5_000, 10_000], [130_000, 12_000]]);
    expect(h.promptAt).toBeNull();
  });

  it('a compaction starts the context over, and an open turn carries into the next scan', () => {
    const h = newHistory();
    foldMarks(h, [['u', 0, 500_000], ['c', 10_000, 0], ['p', 20_000, 0]]);
    expect(h.ctx).toEqual([]);
    expect(h.promptAt).toBe(20_000);
    foldMarks(h, [['u', 30_000, 40_000], ['e', 50_000, 0]]);
    expect(h.turns).toEqual([30_000]);
    expect(h.ctx).toEqual([[30_000, 40_000]]);
  });

  it('keeps the recent ones only', () => {
    const h = newHistory();
    const marks: Array<['p' | 'e' | 'x' | 'c' | 'u', number, number]> = [];
    for (let i = 0; i < 40; i++) marks.push(['p', i * 1000, 0], ['u', i * 1000 + 1, i], ['e', i * 1000 + 500 + i, 0]);
    foldMarks(h, marks);
    expect(h.turns.length).toBe(16);
    expect(h.turns.at(-1)).toBe(539);
    expect(h.ctx.at(-1)).toEqual([39_001, 39]);
  });
});
