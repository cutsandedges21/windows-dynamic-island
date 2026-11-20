import { describe, expect, it } from 'vitest';
import { beforeLonePipe, cloneData } from '../src/mac/compat';

describe('Mac compat (Safari 15)', () => {
  it('cuts at the first lone pipe exactly like the lookbehind regex it replaces on a Mac', () => {
    const regex = (s: string) => s.split(/(?<!\|)\|(?!\|)/)[0];
    const samples = [
      '', '|', '||', '|||', '||||', 'a|b', 'a || b', 'a || b | c', 'npm test | tee out.txt', 'x ||| y', 'a|||b|c', '|a', 'a|',
      'grep foo || true | wc -l', 'echo "a|b" | sort', 'a||b||c', 'a| |b', ' | ', 'cmd1 |& cmd2', 'é|ü',
    ];
    for (const s of samples) expect(beforeLonePipe(s), JSON.stringify(s)).toBe(regex(s));
    // Every string of pipes and letters up to length 6.
    const alphabet = ['a', '|', ' '];
    let all = [''];
    for (let n = 0; n < 6; n++) all = all.flatMap((s) => alphabet.map((c) => s + c));
    for (const s of all) expect(beforeLonePipe(s), JSON.stringify(s)).toBe(regex(s));
  });

  it('copies plain data deeply, as structuredClone does', () => {
    const src = { a: 1, b: [1, { c: 'x' }], d: new Date(5), m: new Map([['k', { v: 1 }]]), s: new Set([1, 2]), n: null, u: undefined };
    const copy = cloneData(src);
    expect(copy).toEqual(structuredClone(src));
    expect(copy.b).not.toBe(src.b);
    expect(copy.b[1]).not.toBe(src.b[1]);
    expect(copy.m.get('k')).not.toBe(src.m.get('k'));
    const loop: { self?: unknown } = {};
    loop.self = loop;
    const again = cloneData(loop);
    expect(again.self).toBe(again);
  });
});
