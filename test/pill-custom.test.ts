// Pill colour › Custom: the colour is kept clean when saved, light ones get dark text, and the
// taskbar, widgets and border that follow the island take the colour with them.

import { describe, expect, it } from 'vitest';
import { CUSTOM_DEFAULT, hexIsLight, pillHex } from '../src/core/glass';
import { accentColor, defaultSettings, migrate } from '../src/core/settings';
import { lookOf } from '../src/core/widgets';

describe('custom pill colour', () => {
  it('saves only #rrggbb, lower case', () => {
    expect(pillHex('#AABBCC')).toBe('#aabbcc');
    expect(pillHex('red')).toBe(CUSTOM_DEFAULT);
    expect(pillHex('#abc')).toBe(CUSTOM_DEFAULT);
    expect(pillHex(undefined)).toBe(CUSTOM_DEFAULT);
  });

  it('knows light colours from dark ones', () => {
    expect(hexIsLight('#ffffff')).toBe(true);
    expect(hexIsLight('#f5d76e')).toBe(true);
    expect(hexIsLight('#000000')).toBe(false);
    expect(hexIsLight(CUSTOM_DEFAULT)).toBe(false);
  });

  it('survives a save and load, and a bad colour falls back', () => {
    const s = defaultSettings();
    s.island.color = 'custom';
    s.island.custom = '#ff8800';
    const back = migrate(JSON.parse(JSON.stringify(s)));
    expect(back.island.color).toBe('custom');
    expect(back.island.custom).toBe('#ff8800');
    expect(migrate({ island: { color: 'custom', custom: 'nope' } }).island.custom).toBe(CUSTOM_DEFAULT);
  });

  it('a white accent turns dark on a light custom pill', () => {
    const s = defaultSettings();
    s.island.accent = 'white';
    s.island.color = 'custom';
    s.island.custom = '#fafafa';
    expect(accentColor(s.island)).toBe('#1c1c1e');
    s.island.custom = '#102030';
    expect(accentColor(s.island)).toBe('#ffffff');
  });

  it('things that follow the island take its custom colour', () => {
    const island = { color: 'custom' as const, glass: 10, custom: '#123456' };
    expect(lookOf({ color: 'island', glass: 10 }, island)).toEqual({ color: 'custom', glass: 10, custom: '#123456' });
    expect(lookOf({ color: 'black', glass: 10 }, island).custom).toBeUndefined();
  });
});

describe('icons on the small pill', () => {
  it('come always, at the right, as before; bad saved values fall back', () => {
    expect(defaultSettings().island.compactIcons).toEqual({ show: 'always', side: 'end' });
    const s = defaultSettings();
    s.island.compactIcons = { show: 'hover', side: 'start' };
    expect(migrate(JSON.parse(JSON.stringify(s))).island.compactIcons).toEqual({ show: 'hover', side: 'start' });
    expect(migrate({ island: { compactIcons: { show: 'x', side: 'y' } } }).island.compactIcons).toEqual({ show: 'always', side: 'end' });
  });
});
