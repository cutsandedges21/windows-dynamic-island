import { describe, expect, it } from 'vitest';
import { chatView, closeCurve, flatView, growCurve, handOff, hoverGrows, hoverView } from '../src/core/grow';
import { defaultSettings, growsChoices, growsOf, migrate } from '../src/core/settings';
import type { SheetView } from '../src/core/sheet';
import { tileCard } from '../src/core/tilecard';

const player: SheetView = { key: 'music/player', morph: true, blocks: [] };
const stats: SheetView = { key: 'claude/hover', blocks: [] };
const weatherTile = (): SheetView => ({ key: 'weather/tile-card', blocks: tileCard({ key: 'weather', body: { k: 'stat', icon: 'sun', label: 'Sunny', value: '18°' } }, 'Weather', 'sun') });

describe('growing out of the pill', () => {
  it('grows and closes in a fixed time, on one curve played both ways, with no overshoot', () => {
    expect(growCurve(0)).toBe(0);
    expect(growCurve(1)).toBe(1);
    let last = 0;
    for (let u = 0.05; u <= 1; u += 0.05) {
      const q = growCurve(u);
      expect(q).toBeGreaterThanOrEqual(last);
      expect(q).toBeLessThanOrEqual(1);
      last = q;
    }
    // Fast out, eased in: past halfway at a third of the time.
    expect(growCurve(1 / 3)).toBeGreaterThan(0.5);
    for (const u of [0, 0.2, 0.5, 0.8, 1]) expect(closeCurve(u)).toBeCloseTo(1 - growCurve(1 - u), 10);
    // The close starts gently and lands fast: the mirror image.
    expect(closeCurve(1 / 3)).toBeLessThan(0.5);
  });

  it('pointed at, a card-growing activity grows its own card, or one made from its tile', () => {
    expect(hoverView('card', stats, weatherTile)).toMatchObject({ key: 'claude/hover', morph: true });
    expect(hoverView('card', null, weatherTile)).toMatchObject({ key: 'weather/tile-card', morph: true });
    expect(hoverView('card', null, () => null)).toBeNull();
  });

  it('Sideways widens the pill: a card that only grows out of it goes, one that hangs below stays', () => {
    let asked = false;
    expect(hoverView('wide', player, () => ((asked = true), weatherTile()))).toBeNull();
    expect(hoverView('wide', stats, weatherTile)).toBe(stats);
    expect(hoverView('wide', null, weatherTile)).toBeNull();
    expect(asked).toBe(false);
  });

  it("Music with Player on hover off widens the pill instead of growing its tile's card; with it on, its Grows stands", () => {
    const musicTile = (): SheetView => ({ key: 'music/tile-card', blocks: [] });
    for (const grows of ['card', 'wide'] as const) {
      expect(hoverGrows('music', grows, { hoverPlayer: false })).toBe('wide');
      expect(hoverGrows('music', grows, { hoverPlayer: true })).toBe(grows);
      expect(hoverGrows('music', grows, {})).toBe(grows);
      expect(hoverGrows('music', grows, undefined)).toBe(grows);
    }
    // Player off: Music has no card of its own, and Sideways never asks for the tile's.
    let asked = false;
    expect(hoverView(hoverGrows('music', 'card', { hoverPlayer: false }), null, () => ((asked = true), musicTile()))).toBeNull();
    expect(asked).toBe(false);
    // Player on: it grows into the player as before.
    expect(hoverView(hoverGrows('music', 'card', { hoverPlayer: true }), player, musicTile)).toMatchObject({ key: 'music/player', morph: true });
    // Only Music: another activity's options don't change how it grows.
    expect(hoverGrows('weather', 'card', { hoverPlayer: false })).toBe('card');
    expect(hoverGrows('claude', 'below', { hoverPlayer: false })).toBe('below');
  });

  it('Below hangs the card under the pill (Claude Code)', () => {
    expect(hoverView('below', stats, weatherTile)!.morph).toBeUndefined();
    expect(hoverView('below', player, weatherTile)!.morph).toBeUndefined();
  });

  it("Claude Code's finished and needs-you cards grow out of the pill only when it grows into a card", () => {
    for (const key of ['claude/done:s1', 'claude/note:s1:5', 'claude/reply:r1']) {
      expect(chatView('claude', 'card', { key, blocks: [] }).morph).toBe(true);
      expect(chatView('claude', 'below', { key, blocks: [] }).morph).toBeUndefined();
    }
    // A permission or a question always hangs below; other activities' cards are left as they are.
    expect(chatView('claude', 'card', { key: 'claude/perm:1', blocks: [] }).morph).toBeUndefined();
    expect(chatView('land', 'card', { key: 'land/done:x', blocks: [] }).morph).toBeUndefined();
  });

  it("Claude Status's finished and needs-you card grows out of the pill when it grows into a card", () => {
    expect(chatView('claudeStatus', 'card', { key: 'claudeStatus/claudeStatus', blocks: [] }).morph).toBe(true);
    expect(chatView('claudeStatus', 'wide', { key: 'claudeStatus/claudeStatus', blocks: [] }).morph).toBeUndefined();
  });

  it('clicking any grown card opens the island in one motion, the same card carrying on', () => {
    // Pointed at Weather (no card of its own): its tile's card grows out of the pill.
    const grown = hoverView('card', null, weatherTile)!;
    expect(grown.morph).toBe(true);
    // A click opens the island: Control Center is an ordinary card, and the grown one turns into it.
    expect(handOff({ shown: true, morph: true, closing: false }, false, false)).toBe('unmorph');
    // Without motion (reduce motion, a jump) it is simply replaced.
    expect(handOff({ shown: true, morph: true, closing: false }, false, true)).toBe('replace');
    // An ordinary card turning into a grown one starts afresh from the pill.
    expect(handOff({ shown: true, morph: false, closing: false }, true, false)).toBe('replace');
    expect(handOff({ shown: true, morph: true, closing: false }, true, false)).toBe('update');
  });

  it('pointed at again on its way back, the card grows again from where it is', () => {
    expect(handOff({ shown: false, morph: true, closing: true }, true, false)).toBe('regrow');
    expect(handOff({ shown: false, morph: false, closing: false }, true, false)).toBe('grow');
    expect(handOff({ shown: false, morph: false, closing: false }, false, false)).toBe('appear');
  });

  it('the phone never gets a grown card', () => {
    expect(flatView(player).morph).toBeUndefined();
    expect(flatView(hoverView('card', null, weatherTile)!).morph).toBeUndefined();
  });
});

describe('grows settings', () => {
  it("'below' is offered only by Claude Code, and is its default", () => {
    expect(growsChoices('claude')).toContain('below');
    for (const id of ['music', 'weather', 'battery', 'system']) expect(growsChoices(id)).toEqual(['wide', 'card']);
    expect(growsOf(undefined, 'card', 'claude')).toBe('below');
    expect(growsOf({}, 'wide', 'claude')).toBe('below');
    expect(growsOf({ grows: 'card' }, 'wide', 'claude')).toBe('card');
    expect(growsOf(undefined, 'card', 'weather')).toBe('card');
    expect(growsOf({ grows: 'below' }, 'wide', 'weather')).toBe('wide');
    const s = defaultSettings();
    expect(growsOf(s.activities.config.claude, s.island.defaultGrows, 'claude')).toBe('below');
    expect(growsOf(s.activities.config.music, s.island.defaultGrows, 'music')).toBe('card');
  });

  it("loads Justin's saved choices (v0.2.11)", () => {
    const s = migrate({
      version: 1,
      island: { anchor: 'top', defaultGrows: 'wide', hoverCard: 'pointer' },
      activities: { config: { music: { enabled: true, grows: 'card' }, battery: { grows: 'wide' }, weather: { grows: 'sideways' } } },
    });
    expect(s.island.defaultGrows).toBe('wide');
    expect(s.activities.config.music.grows).toBe('card');
    expect(s.activities.config.battery.grows).toBe('wide');
    expect(s.activities.config.weather.grows).toBeUndefined();
    expect(growsOf(s.activities.config.weather, s.island.defaultGrows, 'weather')).toBe('wide');
  });

  it("Moss's saved settings (v0.4.2, no grows yet) get the defaults", () => {
    const s = migrate({ island: { anchor: 'bottom', hoverCard: 'claude', hoverExpand: true }, activities: { config: { claude: { enabled: true }, music: { enabled: true } } } });
    expect(s.island.defaultGrows).toBe('card');
    expect(s.activities.config.claude.grows).toBeUndefined();
    expect(growsOf(s.activities.config.claude, s.island.defaultGrows, 'claude')).toBe('below');
    expect(growsOf(s.activities.config.music, s.island.defaultGrows, 'music')).toBe('card');
  });

  it("keeps Claude Code's Below, and drops it anywhere else", () => {
    const s = migrate({ activities: { config: { claude: { grows: 'below' }, music: { grows: 'below' } } } });
    expect(s.activities.config.claude.grows).toBe('below');
    expect(s.activities.config.music.grows).toBeUndefined();
  });
});
