// The album's colour over the screen border, its notches, the island, the bot and the taskbar (Moss,
// 11-20): which art has a colour, how it fades between songs, and what the border will take.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { songFade, SONG_FADE_MS, vividColour } from '../src/core/artcolor';
import { safeColour } from '../src/core/frame';

/** RGBA pixels: `n` of each colour given. */
const pixels = (...runs: Array<[number, [number, number, number]]>) => runs.flatMap(([n, [r, g, b]]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());

/** A stand-in for the page's root: only its inline style. */
function fakeRoot() {
  const props = new Map<string, string>();
  return { style: { setProperty: (k: string, v: string) => void props.set(k, v), getPropertyValue: (k: string) => props.get(k) ?? '' }, props } as unknown as HTMLElement & { props: Map<string, string> };
}

afterEach(() => vi.useRealTimers());

describe('album colour', () => {
  it('pale art with a little colour in it has one (Korn: See You on the Other Side)', () => {
    // Mostly pale grey, a few strong reds: under the old cut-off this was grey.
    const c = vividColour(pixels([92, [200, 200, 205]], [8, [200, 40, 40]]));
    expect(c).not.toBeNull();
    expect(Math.min(c![0], 360 - c![0])).toBeLessThan(20);
  });

  it('grey art has its grey: while a song plays there is always a colour', () => {
    const c = vividColour(pixels([50, [40, 40, 40]], [50, [210, 210, 210]]));
    expect(c).not.toBeNull();
    expect(c![1]).toBe(0);
  });

  it('fades out before the classes that draw it go, and between songs straight to the next', () => {
    vi.useFakeTimers();
    const root = fakeRoot();
    const again = vi.fn();
    expect(songFade(root, '--x', null, again)).toBe(false);
    expect(songFade(root, '--x', 'hsl(227 55% 60%)', again)).toBe(true);
    // The song ends: still drawn while it fades to clear.
    expect(songFade(root, '--x', null, again)).toBe(true);
    expect(root.props.get('--x')).toBe('transparent');
    // The next song's colour comes before the fade is over: straight to it, no second call.
    expect(songFade(root, '--x', 'hsl(27 55% 60%)', again)).toBe(true);
    vi.advanceTimersByTime(SONG_FADE_MS + 10);
    expect(again).not.toHaveBeenCalled();
    // It ends for good: once faded, it is redrawn without it.
    songFade(root, '--x', null, again);
    vi.advanceTimersByTime(SONG_FADE_MS + 10);
    expect(again).toHaveBeenCalledTimes(1);
    expect(songFade(root, '--x', null, again)).toBe(false);
  });

  it('the border takes only a colour, nothing that could break out of its style', () => {
    expect(safeColour('hsl(227 55% 60%)')).toBe('hsl(227 55% 60%)');
    expect(safeColour('#123abc')).toBe('#123abc');
    expect(safeColour('red; background: url(x)')).toBeNull();
    expect(safeColour(null)).toBeNull();
  });
});
