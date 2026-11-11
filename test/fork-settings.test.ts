// Both forks' whole saved settings files, loaded with every migration the merged branches added:
// System Controls (Sound, Brightness, Caps Lock), System Stats' priority and "On the pill",
// hover-cards' Grows, the timer's Quiet clean-up and the Glass slider. Each fixture is that fork's
// defaultSettings() with a user's changes on top (Moss's 0.4.2 at 9bf7ae2, Justin's 0.2.11 at 28ea7ab).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/activities/catalog';
import { parseOrder, pickedStats } from '../src/activities/system';
import { GLASS_DEFAULT } from '../src/core/glass';
import { hoverGrows } from '../src/core/grow';
import { growsOf, migrate, SETTINGS_VERSION, type Settings } from '../src/core/settings';

const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const grows = (s: Settings, id: string) => growsOf(s.activities.config[id], s.island.defaultGrows, id);

describe("Moss's 0.4.2 settings file", () => {
  const s = migrate(load('settings-moss-0.4.2.json'));

  it('keeps the island as it was, with the glass it had', () => {
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.general).toMatchObject({ dnd: true, onboarded: true, toggleHotkey: 'Alt+Shift+Space' });
    expect(s.island).toMatchObject({ color: 'glass', glass: GLASS_DEFAULT, hoverCard: 'claude', glow: 'medium', defaultGrows: 'card' });
    expect(s.island.menu).toMatchObject({ quiet: true, hide: true });
  });

  it('Sound, Brightness and Caps Lock become System Controls, in Sound\'s place', () => {
    const sc = s.activities.config['system-controls'];
    expect(sc).toMatchObject({ enabled: true, priority: 'medium', interactive: true, options: { volume: true, device: true, brightness: false, caps: true, num: false } });
    expect(sc.grows).toBeUndefined();
    for (const id of ['sound', 'brightness', 'keys']) {
      expect(s.activities.config[id]).toBeUndefined();
      expect(s.activities.order).not.toContain(id);
    }
    expect(s.activities.order.indexOf('system-controls')).toBe(s.activities.order.indexOf('battery') + 1);
    expect(s.activities.order).toHaveLength(CATALOG.length);
  });

  it('Control Center keeps its tiles, renamed, and their sizes', () => {
    expect(s.island.grid.pages).toEqual([['music/music', 'system-controls/sound', 'system-controls/brightness', null, 'timer/timer']]);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1', 'timer/timer': '1x1' });
    // Caps Lock never had a tile: hiding it hides nothing now.
    expect(s.island.grid.hidden).toEqual([]);
  });

  it('System Stats keeps the stats picked for the pill, in the default priority', () => {
    const o = s.activities.config.system.options;
    expect(s.activities.config.system.enabled).toBe(true);
    expect(o.show).toEqual(['cpu', 'ram']);
    expect(pickedStats(o.show, parseOrder(o.order))).toEqual(['cpu', 'mem']);
    expect(o.hoverCard).toBe(true);
  });

  it("keeps the timer's lengths and the flag the timer clears Quiet with", () => {
    expect(s.activities.config.timer.options).toMatchObject({ focusMinutes: 50, breakMinutes: 5, quietByFocus: true });
  });

  it('nothing saved how it grows: Claude Code hangs below, the rest grow into a card', () => {
    expect(grows(s, 'claude')).toBe('below');
    expect(grows(s, 'weather')).toBe('card');
    expect(grows(s, 'system-controls')).toBe('card');
    // This music had "Player on hover" off: pointing at it widens the pill.
    expect(s.activities.config.music.options.hoverPlayer).toBe(false);
    expect(hoverGrows('music', grows(s, 'music'), s.activities.config.music.options)).toBe('wide');
  });

  it('loading it again changes nothing', () => {
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("Justin's 0.2.11 settings file", () => {
  const s = migrate(load('settings-justin-0.2.11.json'));

  it('keeps his glass, and Sideways as what pointing does', () => {
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.island).toMatchObject({ color: 'glass', glass: 40, defaultGrows: 'wide', hoverCard: 'pointer' });
    // Moss's settings he never had start at their defaults.
    expect(s.island.menu).toMatchObject({ quiet: true, hide: true });
    expect(s.island.hiddenUntil).toBe(0);
  });

  it("Sound becomes System Controls with its switch, buttons, priority and Grows; the parts he didn't have start on", () => {
    const sc = s.activities.config['system-controls'];
    expect(sc).toMatchObject({ enabled: true, priority: 'high', interactive: false, grows: 'card', options: { volume: true, device: true, brightness: true, caps: true, num: true } });
    expect(s.activities.config.sound).toBeUndefined();
    expect(s.activities.order.indexOf('system-controls')).toBe(s.activities.order.indexOf('battery') + 1);
    expect(s.island.grid.pages).toEqual([['music/music', 'system-controls/sound', null, 'battery/battery', 'timer/timer']]);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1' });
  });

  it('System Stats keeps his priority, expanded switches and hover card, with nothing picked for the pill', () => {
    const o = s.activities.config.system.options;
    expect(parseOrder(o.order)).toEqual(['gpu', 'cpu', 'mem']);
    expect(o).toMatchObject({ expandedCpu: true, expandedRam: true, expandedGpu: false, hoverCard: false });
    expect(pickedStats(o.show, parseOrder(o.order))).toEqual([]);
  });

  it("keeps the timer dial's length", () => {
    expect(s.activities.config.timer.options).toMatchObject({ timerSeconds: 5430, focusMinutes: 25 });
  });

  it('keeps how each activity grows; anything else follows his Sideways', () => {
    expect(grows(s, 'music')).toBe('card');
    expect(hoverGrows('music', grows(s, 'music'), s.activities.config.music.options)).toBe('card');
    expect(grows(s, 'claude')).toBe('wide');
    expect(grows(s, 'system-controls')).toBe('card');
    expect(grows(s, 'weather')).toBe('wide');
  });

  it('loading it again changes nothing', () => {
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
