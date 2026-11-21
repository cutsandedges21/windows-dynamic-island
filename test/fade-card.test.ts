// Settings › Behavior › Fade the island: what the right-click menu's Fade card shows, and Fade
// fading at once when both of its settings rows are off.

import { describe, expect, it } from 'vitest';
import { fadesAtOnce, fadeSheet, FULL_FADE, normalizeFadeShown } from '../src/core/fade-menu';
import { defaultSettings, migrate } from '../src/core/settings';

const rows = (shown = FULL_FADE, faded = false) => {
  const block = fadeSheet({ faded, peekUntilBack: false, smartFade: false, shown }).blocks.find((b) => b.t === 'choices') as { items: Array<{ key: string }> };
  return block.items.map((i) => i.key);
};

describe('Fade card', () => {
  it('shows all three rows as it came', () => {
    expect(defaultSettings().island.fadeCard).toEqual(FULL_FADE);
    expect(rows()).toEqual(['fade', 'lasts', 'smart']);
  });

  it('leaves out the rows turned off', () => {
    expect(rows({ now: true, peek: false, smart: true })).toEqual(['fade', 'smart']);
    expect(rows({ now: false, peek: true, smart: false })).toEqual(['lasts']);
  });

  it('keeps Show while faded, whatever is off', () => {
    expect(rows({ now: false, peek: true, smart: true }, true)).toEqual(['show', 'lasts', 'smart']);
  });

  it('fades at once with both settings off', () => {
    expect(fadesAtOnce({ now: true, peek: false, smart: false })).toBe(true);
    expect(fadesAtOnce({ now: false, peek: false, smart: false })).toBe(true);
    expect(fadesAtOnce({ now: true, peek: true, smart: false })).toBe(false);
  });

  it('saves and loads, bad values falling back to on', () => {
    const s = defaultSettings();
    s.island.fadeCard = { now: true, peek: false, smart: false };
    expect(migrate(JSON.parse(JSON.stringify(s))).island.fadeCard).toEqual({ now: true, peek: false, smart: false });
    expect(normalizeFadeShown({ peek: 'x' })).toEqual(FULL_FADE);
  });
});
