// Edge cases for synced lyrics: odd LRC, odd HTTP answers, the cache cap.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import { lineAt, LyricsLoader, parseLrc } from '../src/activities/lyrics';
import type { MediaState } from '../src/core/native';

const track = (over: Partial<MediaState> = {}): MediaState =>
  ({ available: true, app: 'Spotify', appId: null, title: 'Song', artist: 'Band', album: 'Album', status: 'playing', position: 0, duration: 200, updatedAt: Date.now(), canPlay: true, ...over }) as MediaState;

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  for (const k of Object.keys(h.native)) delete h.native[k];
});

describe('parseLrc edges', () => {
  it('handles CRLF, no fraction, one-digit fraction, offset tags and empty text', () => {
    expect(parseLrc('[offset:+500]\r\n[01:02]x\r\n[00:01.5] y \r\n')).toEqual([
      { at: 1.5, text: 'y' },
      { at: 62, text: 'x' },
    ]);
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('just words\n[bad]\n')).toEqual([]);
  });
  it('lineAt on no lines and negative time', () => {
    expect(lineAt([], 5)).toBeNull();
    expect(lineAt(parseLrc('[00:00.00]a'), -1)).toBeNull();
    expect(lineAt(parseLrc('[00:00.00]a'), 0)).toBe('a');
  });
});

describe('loader edges', () => {
  it('a 200 marked instrumental is none, without a search', async () => {
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify({ instrumental: true, syncedLyrics: null }) }));
    const l = new LyricsLoader();
    l.lines(track(), true);
    await flush();
    expect(l.lines(track(), true)).toBeNull();
    expect(h.native.httpGet).toHaveBeenCalledTimes(1);
  });

  it('a garbled body or a non-list search is none, not a crash', async () => {
    h.native.httpGet = vi.fn(async (u: string) => (u.includes('/api/get') ? { status: 200, body: '<html>' } : { status: 200, body: '{"x":1}' }));
    const l = new LyricsLoader();
    l.lines(track(), true);
    await flush();
    expect(l.lines(track(), true)).toBeNull();
    expect(h.native.httpGet).toHaveBeenCalledTimes(2);
    l.lines(track(), true);
    await flush();
    expect(h.native.httpGet).toHaveBeenCalledTimes(2);
  });

  it('a throwing httpGet counts as a network failure', async () => {
    h.native.httpGet = vi.fn(async () => {
      throw new Error('boom');
    });
    const l = new LyricsLoader();
    l.lines(track(), true);
    await flush();
    l.lines(track(), true);
    expect(h.native.httpGet).toHaveBeenCalledTimes(1);
  });

  it('search skips results whose length is off or missing', async () => {
    h.native.httpGet = vi.fn(async (u: string) =>
      u.includes('/api/get') ? { status: 404, body: '' } : { status: 200, body: JSON.stringify([{ syncedLyrics: '[00:01.00]nolen' }, { duration: 204, syncedLyrics: '[00:01.00]off' }]) },
    );
    const l = new LyricsLoader();
    l.lines(track(), true);
    await flush();
    expect(l.lines(track(), true)).toBeNull();
  });

  it('keeps at most 50 songs', async () => {
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]hi' }) }));
    const l = new LyricsLoader();
    for (let i = 0; i < 51; i++) {
      l.lines(track({ title: `S${i}` }), true);
      await flush();
    }
    expect(h.native.httpGet).toHaveBeenCalledTimes(51);
    l.lines(track({ title: 'S50' }), true);
    expect(h.native.httpGet).toHaveBeenCalledTimes(51);
    l.lines(track({ title: 'S0' }), true);
    expect(h.native.httpGet).toHaveBeenCalledTimes(52);
  });

  it('a song the user skipped away from and back to still loads', async () => {
    const waits: Array<(v: unknown) => void> = [];
    h.native.httpGet = vi.fn(() => new Promise((r) => waits.push(r)));
    const l = new LyricsLoader();
    l.lines(track(), true);
    l.lines(track({ title: 'Next' }), true);
    waits[0]({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]old' }) });
    await flush();
    l.lines(track(), true);
    expect(h.native.httpGet).toHaveBeenCalledTimes(3);
  });
});

describe('the player gets the line', () => {
  it('puts the sung line on the PlayerBlock from the live position, and none when off', async () => {
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]one\n[00:05.00]five' }) }));
    const { MusicActivity } = await import('../src/activities/music');
    let opts: Record<string, unknown> = {};
    const act = new MusicActivity() as any;
    act.ctx = { options: () => opts, update: () => {}, surface: () => {}, settings: () => ({}) };
    act.hoverPlayer = () => true;
    const now = Date.now();
    act.m = track({ position: 4, updatedAt: now - 2000 });
    const env = { reason: 'hover', interactive: true, now } as any;
    const find = (v: any) => JSON.stringify(v).match(/"lyric":("[^"]*"|null)/)?.[1];
    act.sheet(env);
    await flush();
    expect(find(act.sheet(env))).toBe('"five"');
    opts = { lyrics: false };
    expect(find(act.sheet(env))).toBe('null');
  });
});
