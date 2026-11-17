import { describe, expect, it } from 'vitest';
import { defaultSettings, migrate, SYNTH_STYLES, soundStyleKnown } from '../src/core/settings';
import { length, notes, soundLevel, styleChoices, type ChimeKind } from '../src/core/sounds';

const KINDS: ChimeKind[] = ['done', 'attention'];

describe('chime styles', () => {
  it('Soft is the chime Island always had', () => {
    expect(notes('soft', 'done').map((n) => [n.f, n.at, n.len, n.peak])).toEqual([
      [880, 0, 0.5, 0.12],
      [1174.7, 0.14, 0.5, 0.12],
    ]);
    expect(notes('soft', 'attention').map((n) => n.f)).toEqual([659.3, 880]);
  });

  for (const style of SYNTH_STYLES) {
    for (const kind of KINDS) {
      it(`${style} ${kind} is short, audible and not too loud`, () => {
        const list = notes(style, kind);
        expect(list.length).toBeGreaterThan(0);
        for (const n of list) {
          expect(n.f).toBeGreaterThan(100);
          expect(n.f).toBeLessThan(8000);
          if (n.to) expect(n.to).toBeLessThan(8000);
          expect(n.at).toBeGreaterThanOrEqual(0);
          expect(n.len).toBeGreaterThan(0.02);
          expect(n.peak).toBeGreaterThan(0);
          expect(n.peak).toBeLessThanOrEqual(0.2);
        }
        expect(length(list)).toBeLessThanOrEqual(1.8);
      });
    }

    it(`${style} sounds different for done and needs you`, () => {
      expect(notes(style, 'done')).not.toEqual(notes(style, 'attention'));
    });
  }

  it('offers every synthesized style, then your own last', () => {
    const ids = styleChoices().map(([id]) => id);
    for (const s of SYNTH_STYLES) expect(ids).toContain(s);
    expect(ids[ids.length - 1]).toBe('custom');
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(soundStyleKnown(id)).toBe(true);
  });
});

describe('sound volume', () => {
  it('maps 0 to 100 onto 0 to 1, clamped', () => {
    expect(soundLevel(0)).toBe(0);
    expect(soundLevel(50)).toBe(0.5);
    expect(soundLevel(100)).toBe(1);
    expect(soundLevel(250)).toBe(1);
    expect(soundLevel(-5)).toBe(0);
    expect(soundLevel(Number.NaN)).toBe(0.5);
  });
});

describe('sound settings', () => {
  it('default to the Soft chime at its first loudness, with no files', () => {
    expect(defaultSettings().general.sound).toEqual({ style: 'soft', volume: 50, done: '', attention: '', rev: 0 });
  });

  it('come through a save, and settings from before them get the defaults', () => {
    const s = defaultSettings();
    s.general.sound = { style: 'custom', volume: 80, done: 'ding.mp3', attention: 'hey.wav', rev: 3 };
    expect(migrate(JSON.parse(JSON.stringify(s))).general.sound).toEqual(s.general.sound);

    const old = JSON.parse(JSON.stringify(defaultSettings())) as { general: Record<string, unknown> };
    delete old.general.sound;
    expect(migrate(old).general.sound).toEqual(defaultSettings().general.sound);
  });

  it('drop an unknown style and clamp the volume', () => {
    const s = JSON.parse(JSON.stringify(defaultSettings()));
    s.general.sound.style = 'gone-pack';
    s.general.sound.volume = 140.4;
    const out = migrate(s).general.sound;
    expect(out.style).toBe('soft');
    expect(out.volume).toBe(100);
  });
});
