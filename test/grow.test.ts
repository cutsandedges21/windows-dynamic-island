import { describe, expect, it } from 'vitest';
import { carryCurve, carryFades, slideCurve, chatView, closeCurve, contentLeft, flatView, growCurve, handOff, hoverGrows, hoverView, snapSpan, tweenShape } from '../src/core/grow';
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

  it("Claude's finished and needs-you cards, and its sessions card, grow out of the pill when it grows into a card (or a card with more)", () => {
    for (const key of ['claude/done:s1', 'claude/note:s1:5', 'claude/reply:r1', 'claude/status']) {
      expect(chatView('claude', 'card', { key, blocks: [] }).morph).toBe(true);
      expect(chatView('claude', 'more', { key, blocks: [] }).morph).toBe(true);
      expect(chatView('claude', 'below', { key, blocks: [] }).morph).toBeUndefined();
      expect(chatView('claude', 'wide', { key, blocks: [] }).morph).toBeUndefined();
    }
    // A permission or a question always hangs below; other activities' cards are left as they are.
    expect(chatView('claude', 'card', { key: 'claude/perm:1', blocks: [] }).morph).toBeUndefined();
    expect(chatView('claude', 'more', { key: 'claude/ask:1', blocks: [] }).morph).toBeUndefined();
    expect(chatView('land', 'card', { key: 'land/done:x', blocks: [] }).morph).toBeUndefined();
  });

  it("Card with more grows Claude's own card out of the pill (its ⌄ is in the card); with no card, nothing", () => {
    expect(hoverView('more', stats, weatherTile)).toMatchObject({ key: 'claude/hover', morph: true });
    expect(hoverView('more', null, weatherTile)).toBeNull();
  });

  it('clicking any grown card opens the island in one motion, the same card carrying on', () => {
    // Pointed at Weather (no card of its own): its tile's card grows out of the pill.
    const grown = hoverView('card', null, weatherTile)!;
    expect(grown.morph).toBe(true);
    // A click opens the island: Control Center is an ordinary card, and the grown one turns into it.
    expect(handOff({ shown: true, morph: true, closing: false }, false, false)).toBe('unmorph');
    // Without motion (reduce motion, a jump) it is simply replaced.
    expect(handOff({ shown: true, morph: true, closing: false }, false, true)).toBe('replace');
    // An ordinary card turning into a grown one (the island closing with the pointer on the pill)
    // carries on back into it; without motion it is replaced.
    expect(handOff({ shown: true, morph: false, closing: false }, true, false)).toBe('remorph');
    expect(handOff({ shown: true, morph: false, closing: false }, true, true)).toBe('replace');
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
  it("'below' and 'more' are offered only by Claude, and 'more' is its default", () => {
    expect(growsChoices('claude')).toEqual(['wide', 'card', 'below', 'more']);
    for (const id of ['music', 'weather', 'battery', 'system']) expect(growsChoices(id)).toEqual(['wide', 'card']);
    expect(growsOf(undefined, 'card', 'claude')).toBe('more');
    expect(growsOf({}, 'wide', 'claude')).toBe('more');
    expect(growsOf({ grows: 'card' }, 'wide', 'claude')).toBe('card');
    expect(growsOf({ grows: 'below' }, 'wide', 'claude')).toBe('below');
    expect(growsOf(undefined, 'card', 'weather')).toBe('card');
    expect(growsOf({ grows: 'below' }, 'wide', 'weather')).toBe('wide');
    expect(growsOf({ grows: 'more' }, 'wide', 'weather')).toBe('wide');
    const s = defaultSettings();
    expect(growsOf(s.activities.config.claude, s.island.defaultGrows, 'claude')).toBe('more');
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
    expect(growsOf(s.activities.config.claude, s.island.defaultGrows, 'claude')).toBe('more');
    expect(growsOf(s.activities.config.music, s.island.defaultGrows, 'music')).toBe('card');
  });

  it("keeps Claude's Below and Card with more, and drops them anywhere else", () => {
    const s = migrate({ activities: { config: { claude: { grows: 'below' }, music: { grows: 'below' }, weather: { grows: 'more' } } } });
    expect(s.activities.config.claude.grows).toBe('below');
    expect(s.activities.config.music.grows).toBeUndefined();
    expect(s.activities.config.weather.grows).toBeUndefined();
    expect(migrate({ activities: { config: { claude: { grows: 'more' } } } }).activities.config.claude.grows).toBe('more');
  });
});

describe('a card widening on whole device pixels (125%)', () => {
  const k = 1.25;
  const onPixel = (v: number) => Math.abs(v * k - Math.round(v * k)) < 1e-9;

  it('rounds each edge on its own, so a widening card never steps an edge back', () => {
    let left = Infinity;
    let right = -Infinity;
    for (let w = 372; w <= 576; w += 0.37) {
      const x = 640 - w / 2;
      const s = snapSpan(x, w, k);
      expect(onPixel(s.x) && onPixel(s.x + s.w)).toBe(true);
      expect(s.x).toBeLessThanOrEqual(left);
      expect(s.x + s.w).toBeGreaterThanOrEqual(right);
      left = s.x;
      right = s.x + s.w;
    }
  });

  it('keeps content of a fixed width at one spot on screen while the card around it widens', () => {
    const spots = new Set<number>();
    for (let w = 372; w <= 576; w += 0.37) {
      const x = 640 - w / 2;
      spots.add(snapSpan(x, w, k).x + contentLeft(x, w, 372, k));
    }
    expect(spots.size).toBe(1);
    // Where the grown card drew it: its own box, centred on the pill, on a whole device pixel.
    expect([...spots][0]).toBeCloseTo(Math.round((640 - 186) * k) / k, 9);
  });

  it('does not flip a spot on a half device pixel back and forth with spring noise', () => {
    // 454 CSS px is 567.5 device px at 125%.
    const a = snapSpan(454 + 1e-7, 372, k).x + contentLeft(454 + 1e-7, 372, 372, k);
    const b = snapSpan(454 - 1e-7, 372, k).x + contentLeft(454 - 1e-7, 372, 372, k);
    expect(a).toBe(b);
  });
});

describe('a grown card carried on into the open island (and back)', () => {
  it('moves width, height and m together, on one curve', () => {
    const from = { w: 372, h: 174, m: 1 };
    const to = { w: 576, h: 436, m: 0 };
    expect(tweenShape(from, to, 0)).toEqual(from);
    expect(tweenShape(from, to, 1)).toEqual(to);
    const half = tweenShape(from, to, 0.5);
    expect(half.w).toBeCloseTo(474);
    expect(half.h).toBeCloseTo(305);
    expect(half.m).toBeCloseTo(0.5);
  });

  it('carries a grow on from where it got to, without stopping, and lands on 1', () => {
    expect(carryCurve(0)).toBe(0);
    expect(carryCurve(1)).toBeCloseTo(1, 9);
    // From rest it is the grow's own curve.
    for (const u of [0.1, 0.3, 0.7]) expect(carryCurve(u)).toBeCloseTo(growCurve(u), 9);
    // Carried on mid-grow it is already moving at the start (the grow's speed, not a restart from rest).
    const dt = 0.01;
    expect(carryCurve(dt, 0.4) / dt).toBeGreaterThan(carryCurve(dt, 0) / dt);
    expect(carryCurve(1, 0.4)).toBeCloseTo(1, 9);
    let last = 0;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const r = carryCurve(u, 0.4);
      expect(r).toBeGreaterThanOrEqual(last - 1e-12);
      last = r;
    }
  });

  it('crosses the content over with no empty card and never both clearly there', () => {
    let minSum = 9;
    let both = 0;
    for (let r = 0; r <= 1.0001; r += 0.001) {
      const f = carryFades(r);
      minSum = Math.min(minSum, f.old + f.new);
      both = Math.max(both, Math.min(f.old, f.new));
    }
    expect(minSum).toBeGreaterThanOrEqual(0.8);
    expect(both).toBeLessThanOrEqual(0.5);
    expect(carryFades(0)).toEqual({ old: 1, new: 0, pill: 0, glass: 0 });
    expect(carryFades(1)).toEqual({ old: 0, new: 1, pill: 1, glass: 1 });
    // The pill's glass is gone on the click frame and back a little before its content.
    expect(carryFades(0.3).glass).toBe(0);
    expect(carryFades(0.6).glass).toBeGreaterThan(carryFades(0.6).pill);
    // The pill's content stays out until the card has mostly slid off it, and the old content is gone first.
    expect(carryFades(0.4).pill).toBe(0);
    expect(slideCurve(0.4)).toBeGreaterThan(0.85);
    expect(carryFades(0.5).old).toBe(0);
    // The bar's glass is never there on its own for long: its content is on its way in by the time the glass is a third back.
    for (let r = 0; r <= 1.0001; r += 0.01) if (carryFades(r).glass < 0.999) expect(carryFades(r).glass - carryFades(r).pill).toBeLessThan(0.4);
  });

  it('slides the carried card off the pill ahead of its size, done once the new content is in', () => {
    expect(slideCurve(0)).toBe(0);
    expect(slideCurve(1)).toBe(1);
    let last = 0;
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const m = slideCurve(r);
      expect(m).toBeGreaterThanOrEqual(r - 1e-9);
      expect(m).toBeGreaterThanOrEqual(last);
      last = m;
    }
    // Where the new content is all there (carryFades' `new` at 1), the card is where it stays.
    expect(carryFades(0.6).new).toBe(1);
    expect(slideCurve(0.6)).toBe(1);
  });
});
