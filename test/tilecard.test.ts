import { describe, expect, it } from 'vitest';
import { tileCard } from '../src/core/tilecard';

describe('tile card', () => {
  it('a stat with progress becomes a heading and a bar', () => {
    const blocks = tileCard({ key: 'k', body: { k: 'stat', icon: 'wifi', label: 'Ping', value: '23 ms', progress: 0.4 } }, 'Network', 'wifi');
    expect(blocks.map((b) => b.t)).toEqual(['head', 'meter']);
    expect(blocks[0]).toMatchObject({ title: '23 ms', sub: 'Ping' });
  });

  it('a list keeps its rows, or says it is empty', () => {
    const rows = [{ key: 'a', title: 'One' }];
    expect(tileCard({ key: 'k', body: { k: 'list', icon: 'x', label: 'Things', rows } }, 'N', 'x')[1]).toMatchObject({ t: 'rows', items: rows });
    expect(tileCard({ key: 'k', body: { k: 'list', icon: 'x', label: 'Things', rows: [], empty: 'All quiet' } }, 'N', 'x')[1]).toMatchObject({ t: 'text', text: 'All quiet' });
  });

  it('media becomes a player, and a forecast lists its hours', () => {
    expect(tileCard({ key: 'k', body: { k: 'media', title: 'Song', artist: 'Band', playing: true, buttons: [] } }, 'N', 'x')[0].t).toBe('player');
    const f = tileCard({ key: 'k', body: { k: 'forecast', icon: 'sun', temp: '18°', label: 'Sunny', hours: [{ t: '3 PM', icon: 'sun', temp: '19°' }] } }, 'N', 'x');
    expect(f.map((b) => b.t)).toEqual(['head', 'stats']);
  });
});
