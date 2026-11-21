// A taskbar on every screen, each with its own place (Moss, 11-20), and the now playing section filled
// with the album's colour, black on a light one.

import { describe, expect, it } from 'vitest';
import { luminance, songFill, vividColour } from '../src/core/artcolor';
import { migrate } from '../src/core/settings';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pixels = (...runs: Array<[number, [number, number, number]]>) => runs.flatMap(([n, [r, g, b]]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());

describe('taskbar on every screen: settings', () => {
  it('shows on every screen unless told the main one only', () => {
    expect(migrate({ island: { taskbar: {} } }).island.taskbar.screens).toBe('all');
    expect(migrate({ island: { taskbar: { screens: 'main' } } }).island.taskbar.screens).toBe('main');
    expect(migrate({ island: { taskbar: { screens: 'nonsense' } } }).island.taskbar.screens).toBe('all');
  });

  it("keeps each other screen's place, 0..1, and drops junk", () => {
    const t = migrate({ island: { taskbar: { centre: 0.3, centres: { '\\\\.\\DISPLAY2': 0.75, '\\\\.\\DISPLAY3': 4, '': 0.5, x: 'no' } } } }).island.taskbar;
    expect(t.centre).toBe(0.3);
    expect(t.centres).toEqual({ '\\\\.\\DISPLAY2': 0.75 });
    expect(migrate({ island: { taskbar: {} } }).island.taskbar.centres).toEqual({});
  });
});

describe('now playing in the album colour', () => {
  it("reads the art's own lightness, not a fixed middle", () => {
    const pale = vividColour(pixels([100, [250, 230, 140]]))!;
    const deep = vividColour(pixels([100, [120, 20, 30]]))!;
    expect(pale[2]).toBeGreaterThan(0.7);
    expect(deep[2]).toBeLessThan(0.35);
  });

  it('a light colour gets black buttons, a dark or strong one white', () => {
    // Pale yellow, mint, white-ish pink: black.
    expect(songFill([52, 0.9, 0.78]).light).toBe(true);
    expect(songFill([150, 0.6, 0.8]).light).toBe(true);
    // Deep red, navy, a strong blue: white.
    expect(songFill([355, 0.7, 0.28]).light).toBe(false);
    expect(songFill([225, 0.6, 0.3]).light).toBe(false);
    expect(songFill([220, 0.9, 0.5]).light).toBe(false);
  });

  it('never muddy nor glaring', () => {
    expect(songFill([20, 0.1, 0.05]).fill).toBe('hsl(20 35% 30%)');
    expect(songFill([20, 1, 0.99]).fill).toBe('hsl(20 90% 80%)');
  });

  it('luminance runs from black to white', () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([0, 0, 1])).toBeCloseTo(1, 5);
    // Yellow looks far brighter than blue at the same lightness.
    expect(luminance([60, 1, 0.5])).toBeGreaterThan(luminance([240, 1, 0.5]) * 5);
  });
});

describe("the taskbar's song box looks like the island's music card", () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8');
  const rule = (sel: string) => css.split(/\r?\n/).find((l) => l.startsWith(`${sel} {`)) ?? '';

  it("takes the card's see-through wash, never a solid fill (Justin, 11-21: \"why is it back\")", () => {
    const box = rule('.dock .dk-song.dk-tint');
    expect(box).toContain('color-mix(in srgb, var(--song-fill) 46%, transparent), color-mix(in srgb, var(--song-fill) 12%, transparent) 70%');
    // The card's own wash, the same numbers.
    expect(css).toContain('color-mix(in srgb, var(--card-tint, transparent) 46%, transparent), color-mix(in srgb, var(--card-tint, transparent) 12%, transparent) 70%');
    // No opaque colour of its own, and the bar's text colour stays.
    expect(box).not.toMatch(/linear-gradient\(150deg, var\(--song-fill\)/);
    expect(box).not.toMatch(/(^|[ ;{])color:/);
  });

  it('is drawn in the same colour as the card (barColour), not a fill of its own', () => {
    const dock = readFileSync(resolve(__dirname, '../src/core/dock.ts'), 'utf8');
    expect(dock).toContain("song.style.setProperty('--song-fill', songColour)");
    expect(dock).not.toContain('songFill(');
  });
});
