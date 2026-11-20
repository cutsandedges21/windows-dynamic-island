import { describe, expect, it } from 'vitest';
import { fixDeclarations, topLevel, twinOf, withoutColorMix } from '../src/mac/colormix';

// The engine's colour reading, as a canvas gives it, for the few literals the styles use.
const channels = (css: string): string | null =>
  ({ '#e8845f': '232, 132, 95', '#040405': '4, 4, 5', 'rgb(60, 62, 68)': '60, 62, 68', white: '255, 255, 255', 'rgba(30, 30, 36, 0.9)': '30, 30, 36' } as Record<string, string>)[css.trim()] ?? null;

describe('color-mix() for Safari before 16.2', () => {
  it('splits arguments at the top level only', () => {
    expect(topLevel('in srgb, var(--a) 20%, color-mix(in srgb, red, blue)')).toEqual(['in srgb', 'var(--a) 20%', 'color-mix(in srgb, red, blue)']);
  });

  it('a tint over transparent is the colour at that share, through its variable\'s twin', () => {
    expect(withoutColorMix('background: color-mix(in srgb, var(--accent) 18%, transparent);', channels)).toBe('background: rgba(var(--accent-rgb), 0.18);');
    expect(withoutColorMix('color-mix(in srgb, transparent, var(--wc) 30%)', channels)).toBe('rgba(var(--wc-rgb), 0.3)');
    expect(withoutColorMix('color-mix(in srgb, var(--wc, var(--accent)) 12%, transparent)', channels)).toBe('rgba(var(--wc-rgb), 0.12)');
  });

  it('nested mixes and literal colours come out drawable', () => {
    expect(withoutColorMix('border-color: color-mix(in srgb, var(--fg) 14%, color-mix(in srgb, var(--pill) 40%, transparent));', channels)).toBe('border-color: rgba(var(--fg-rgb), 0.14);');
    expect(withoutColorMix('color-mix(in srgb, #e8845f 45%, white)', channels)).toBe('rgba(232, 132, 95, 0.45)');
    expect(withoutColorMix('box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 50%, var(--line)), inset 0 0 0 1px red;', channels)).toBe('box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.5), inset 0 0 0 1px red;');
  });

  it('colour variables get their twin: channels, or the twin of the variable they name', () => {
    expect(twinOf('#e8845f', channels)).toBe('232, 132, 95');
    expect(twinOf('var(--fg)', channels)).toBe('var(--fg-rgb)');
    expect(twinOf('12px', channels)).toBeNull();
    const out = fixDeclarations('--accent: #e8845f; --tint: var(--fg); background: color-mix(in srgb, var(--accent) 10%, transparent);', channels)!;
    expect(out).toContain('--accent-rgb: 232, 132, 95;');
    expect(out).toContain('--tint-rgb: var(--fg-rgb);');
    expect(out).toContain('background: rgba(var(--accent-rgb), 0.1);');
    expect(out).not.toContain('color-mix(');
    // A rule with nothing to change is left alone.
    expect(fixDeclarations('padding: 4px;', channels)).toBeNull();
  });
});
