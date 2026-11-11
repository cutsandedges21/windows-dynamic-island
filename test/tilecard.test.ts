import { describe, expect, it } from 'vitest';
import { defaultSettings, growsOf, migrate } from '../src/core/settings';
import { tileCard } from '../src/core/tilecard';

describe('grows', () => {
  it('grows into a card by default; an activity can override the island default', () => {
    expect(defaultSettings().island.defaultGrows).toBe('card');
    expect(growsOf(undefined, 'card')).toBe('card');
    expect(growsOf({}, 'wide')).toBe('wide');
    expect(growsOf({ grows: 'card' }, 'wide')).toBe('card');
    expect(growsOf({ grows: 'wide' }, 'card')).toBe('wide');
  });

  it('an old or broken default grows is put right', () => {
    expect(migrate({ island: { defaultGrows: 'sideways' } }).island.defaultGrows).toBe('card');
    expect(migrate({ island: { defaultGrows: 'wide' } }).island.defaultGrows).toBe('wide');
  });

  it('survives a save and reload, and junk is dropped', () => {
    const s = migrate({ activities: { config: { weather: { grows: 'card' }, battery: { grows: 'sideways' } } } });
    expect(s.activities.config.weather.grows).toBe('card');
    expect(s.activities.config.battery.grows).toBeUndefined();
  });
});

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
