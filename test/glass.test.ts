// The Glass pill's Clear ↔ Tinted slider: its curve, the layers it draws, how it is saved, and
// that Duplicate copies and phones hear about it.

import { describe, expect, it } from 'vitest';
import { GLASS_DEFAULT, glassStyle, glassTint } from '../src/core/glass';
import type { MirrorFrame } from '../src/core/mirror';
import { defaultSettings, migrate } from '../src/core/settings';
import { pillKey } from '../src/remote/hub';

const frame = (glass?: number): MirrorFrame => ({
  sig: 'a', swap: false, bump: false, placed: [], w: 300, h: 36, orient: 'horizontal', anchor: 'top', edge: 8, hidden: false, fsHide: false, fullscreen: null,
  glow: null, speed: 'medium', accent: '#6aa6e8', color: 'glass', glass, reduce: false, bot: null,
});

describe('the glass slider', () => {
  it('runs from clear to fully tinted, with a frosted glass in the middle', () => {
    expect(glassTint(0)).toBe(0);
    expect(glassTint(50)).toBeCloseTo(0.736);
    expect(glassTint(100)).toBe(1);
    // Not a straight line: the first half climbs faster than the second.
    expect(glassTint(25)).toBeGreaterThan(0.25);
    let last = -1;
    for (let v = 0; v <= 100; v += 5) {
      expect(glassTint(v)).toBeGreaterThan(last);
      last = glassTint(v);
    }
  });

  it('keeps to its ends, and takes anything else as the default', () => {
    expect(glassTint(-20)).toBe(0);
    expect(glassTint(400)).toBe(1);
    expect(glassTint(undefined)).toBe(glassTint(GLASS_DEFAULT));
    expect(glassTint(Number.NaN)).toBe(glassTint(GLASS_DEFAULT));
  });

  it('starts where the glass always was: a faint smoke and no frost', () => {
    const s = glassStyle(GLASS_DEFAULT);
    expect(Number(s['--glass-smoke'])).toBeCloseTo(0.18, 2);
    expect(Number(s['--glass-frost'])).toBeLessThan(0.01);
    expect(defaultSettings().island.glass).toBe(GLASS_DEFAULT);
  });

  it('clear thins the smoke; tinted fills in the frost instead of going black', () => {
    expect(glassStyle(0)).toEqual({ '--glass-smoke': '0.060', '--glass-frost': '0.000' });
    expect(glassStyle(100)).toEqual({ '--glass-smoke': '0.180', '--glass-frost': '1.000' });
    expect(Number(glassStyle(50)['--glass-frost'])).toBeCloseTo((0.736 - 0.16) / 0.84, 3);
  });
});

describe('the glass setting, saved', () => {
  it("keeps Justin's saved value (0.2.11 had the slider)", () => {
    const s = migrate({ version: 5, island: { anchor: 'top', color: 'glass', glass: 64, hoverCard: 'pointer' } });
    expect(s.island.color).toBe('glass');
    expect(s.island.glass).toBe(64);
  });

  it("gives Moss's saved settings (0.4.2, no slider yet) the glass they had", () => {
    const s = migrate({ version: 5, island: { anchor: 'bottom', color: 'glass', hiddenUntil: 0, menu: { position: true } } });
    expect(s.island.glass).toBe(GLASS_DEFAULT);
  });

  it('drops junk and keeps it between 0 and 100', () => {
    const saved = (v: unknown) => migrate({ island: { glass: v } }).island.glass;
    expect(saved(150)).toBe(100);
    expect(saved(-3)).toBe(0);
    expect(saved(Number.NaN)).toBe(GLASS_DEFAULT);
    expect(saved('40')).toBe(GLASS_DEFAULT);
    expect(saved(null)).toBe(GLASS_DEFAULT);
  });
});

describe('the glass on other screens', () => {
  it('a phone gets a new pill when the slider moves', () => {
    expect(pillKey(frame(11), null)).not.toBe(pillKey(frame(60), null));
  });

  it("a frame from an Island before the slider draws the glass's old look", () => {
    expect(glassStyle(frame().glass)).toEqual(glassStyle(GLASS_DEFAULT));
  });
});
