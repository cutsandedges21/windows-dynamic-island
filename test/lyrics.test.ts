// Synced lyrics: LRC parsing, the line at a time, and the LRCLIB loader against a fake native layer.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import { lineAt, LyricsLoader, parseLrc } from '../src/activities/lyrics';
import type { MediaState } from '../src/core/native';

const track = (over: Partial<MediaState> = {}): MediaState =>
  ({ available: true, app: 'Spotify', appId: null, title: 'Song', artist: 'Band', album: 'Album', status: 'playing', position: 0, duration: 200, updatedAt: Date.now(), canPlay: true, ...over }) as MediaState;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('parseLrc', () => {
  it('reads stamps, skips tags, keeps blank lines as gaps', () => {
    const lines = parseLrc('[ar:Band]\n[ti:Song]\n[00:01.50] one\n[00:03.250]two\n\n[00:05.00]\n[00:07.10][00:02.00] both\n');
    expect(lines).toEqual([
      { at: 1.5, text: 'one' },
      { at: 2, text: 'both' },
      { at: 3.25, text: 'two' },
      { at: 5, text: '' },
      { at: 7.1, text: 'both' },
    ]);
  });
});

describe('lineAt', () => {
  const lines = parseLrc('[00:01.00]a\n[00:02.00]\n[00:03.00]b');
  it('is null before the first line and in a gap', () => {
    expect(lineAt(lines, 0.99)).toBeNull();
    expect(lineAt(lines, 1)).toBe('a');
    expect(lineAt(lines, 2.5)).toBeNull();
    expect(lineAt(lines, 99)).toBe('b');
  });
});

describe('LyricsLoader', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.native)) delete h.native[k];
  });

  it('fetches once per track and caches', async () => {
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]hi' }) }));
    const changed = vi.fn();
    const l = new LyricsLoader(changed);
    expect(l.lines(track(), true)).toBeNull();
    expect(l.lines(track(), true)).toBeNull();
    await flush();
    expect(l.lines(track(), true)).toEqual([{ at: 1, text: 'hi' }]);
    expect(h.native.httpGet).toHaveBeenCalledTimes(1);
    expect(String(h.native.httpGet.mock.calls[0][0])).toContain('/api/get?');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does nothing when off or nothing plays', () => {
    h.native.httpGet = vi.fn();
    const l = new LyricsLoader();
    expect(l.lines(track(), false)).toBeNull();
    expect(l.lines(track({ status: 'stopped' }), true)).toBeNull();
    expect(l.lines(null, true)).toBeNull();
    expect(h.native.httpGet).not.toHaveBeenCalled();
  });

  it('falls back to search on 404 and caches none', async () => {
    h.native.httpGet = vi.fn(async (url: string) =>
      url.includes('/api/get') ? { status: 404, body: '' } : { status: 200, body: JSON.stringify([{ duration: 150, syncedLyrics: '[00:01.00]far' }, { duration: 201.4, syncedLyrics: '[00:01.00]near' }]) },
    );
    const l = new LyricsLoader();
    l.lines(track(), true);
    await flush();
    await flush();
    expect(l.lines(track(), true)).toEqual([{ at: 1, text: 'near' }]);

    h.native.httpGet = vi.fn(async () => ({ status: 404, body: '' }));
    l.lines(track({ title: 'Other' }), true);
    await flush();
    await flush();
    expect(l.lines(track({ title: 'Other' }), true)).toBeNull();
    expect(h.native.httpGet).toHaveBeenCalledTimes(2);
  });

  it('ignores a result that lands after the track changed', async () => {
    const waits: Array<(v: unknown) => void> = [];
    h.native.httpGet = vi.fn(() => new Promise((r) => waits.push(r)));
    const changed = vi.fn();
    const l = new LyricsLoader(changed);
    l.lines(track(), true);
    l.lines(track({ title: 'Next' }), true);
    waits[0]({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]old' }) });
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });

  it('asks again seconds after LRCLIB is busy, then less and less often', async () => {
    // LRCLIB answers 503 "The server is busy, please retry in a moment" in busy spells (seen 2026-10-27).
    let busy = true;
    h.native.httpGet = vi.fn(async () => (busy ? { status: 503, body: '{"message":"The server is busy, please retry in a moment"}' } : { status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]hi' }) }));
    const l = new LyricsLoader();
    const t0 = Date.now();
    l.lines(track(), true, t0);
    await flush();
    l.lines(track(), true, t0 + 2_000);
    expect(h.native.httpGet).toHaveBeenCalledTimes(1);
    l.lines(track(), true, t0 + 5_000);
    await flush();
    expect(h.native.httpGet).toHaveBeenCalledTimes(2);
    // Busy twice: the next try waits 15 s from the last one.
    l.lines(track(), true, t0 + 15_000);
    expect(h.native.httpGet).toHaveBeenCalledTimes(2);
    busy = false;
    l.lines(track(), true, t0 + 20_000);
    await flush();
    expect(h.native.httpGet).toHaveBeenCalledTimes(3);
    expect(l.lines(track(), true, t0 + 21_000)).toEqual([{ at: 1, text: 'hi' }]);
  });

  it('never waits more than a minute between tries', async () => {
    h.native.httpGet = vi.fn(async () => null);
    const l = new LyricsLoader();
    let t = Date.now();
    for (let i = 0; i < 6; i++) {
      l.lines(track(), true, t);
      await flush();
      t += 60_000;
    }
    expect(h.native.httpGet).toHaveBeenCalledTimes(6);
  });
});
