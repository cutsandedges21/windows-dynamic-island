// System Controls' iPhone-style tile: what it shows for each state, its sliders' mapping, and that
// it joins saved grids next to System Controls' other tiles without breaking them.

import { describe, expect, it } from 'vitest';
import { bluetoothPill, hubTile, sliderPct, wifiPill, type HubState } from '../src/activities/control-hub';
import { withNew } from '../src/core/grid';
import { migrate } from '../src/core/settings';
import { sliderAt } from '../src/core/sheet';
import { mayPress, pressables } from '../src/remote/views';

const state = (over: Partial<HubState> = {}): HubState => ({
  radios: { wifi: true, bluetooth: true, network: 'Home' },
  btDevices: 0,
  volume: 0.5,
  muted: false,
  brightness: 60,
  saver: false,
  ...over,
});

describe('the hub tile', () => {
  it('Wi-Fi says the network when on, Off when off, and is left out without a radio', () => {
    expect(wifiPill({ wifi: true, bluetooth: null, network: 'Home' }, true)).toMatchObject({ label: 'Wi-Fi', sub: 'Home', on: true, icon: 'wifi', action: 'wifi' });
    expect(wifiPill({ wifi: true, bluetooth: null, network: '  ' }, true)).toMatchObject({ sub: 'Not connected', on: true });
    expect(wifiPill({ wifi: false, bluetooth: null, network: null }, true)).toMatchObject({ sub: 'Off', on: false, icon: 'wifi-off' });
    expect(wifiPill({ wifi: null, bluetooth: true, network: null }, true)).toBeNull();
    expect(wifiPill(null, true)).toBeNull();
    // Not interactive (the phone without control): it only says how it is.
    expect(wifiPill({ wifi: true, bluetooth: null, network: 'Home' }, false)?.action).toBeUndefined();
  });

  it('Bluetooth counts connected devices, else On or Off', () => {
    const r = (bluetooth: boolean | null) => ({ wifi: null, bluetooth, network: null });
    expect(bluetoothPill(r(true), 2, true)).toMatchObject({ sub: '2 Devices', on: true, action: 'bluetooth' });
    expect(bluetoothPill(r(true), 1, true)?.sub).toBe('1 Device');
    expect(bluetoothPill(r(true), 0, true)?.sub).toBe('On');
    expect(bluetoothPill(r(true), null, true)?.sub).toBe('On');
    expect(bluetoothPill(r(false), 3, true)).toMatchObject({ sub: 'Off', on: false });
    expect(bluetoothPill(r(null), 3, true)).toBeNull();
  });

  it('is a 2x2 tile with pills, brightness and volume sliders and the battery saver button', () => {
    const t = hubTile(state({ saver: true }), true)!;
    expect(t).toMatchObject({ key: 'hub', span: 2, rows: 2, sizes: [[2, 2]] });
    if (t.body.k !== 'hub') throw new Error('not a hub');
    expect(t.body.pills.map((p) => p.key)).toEqual(['wifi', 'bluetooth']);
    expect(t.body.sliders).toMatchObject([
      { key: 'brightness', value: 0.6, icon: 'sun', action: 'bright-set' },
      { key: 'volume', value: 0.5, icon: 'speaker', action: 'vol-set' },
    ]);
    expect(t.body.buttons).toMatchObject([{ key: 'saver', icon: 'leaf', action: 'saver', style: 'primary' }]);
  });

  it('muted shows an empty volume slider; a dim screen the small sun', () => {
    const t = hubTile(state({ muted: true, brightness: 20 }), true)!;
    if (t.body.k !== 'hub') throw new Error('not a hub');
    expect(t.body.sliders).toMatchObject([
      { key: 'brightness', icon: 'sun-low', value: 0.2 },
      { key: 'volume', icon: 'speaker-mute', value: 0 },
    ]);
  });

  it('leaves out what this computer lacks, and is gone with nothing to show', () => {
    const t = hubTile(state({ radios: null, brightness: null, saver: null }), false)!;
    if (t.body.k !== 'hub') throw new Error('not a hub');
    expect(t.body.pills).toEqual([]);
    expect(t.body.sliders.map((s) => [s.key, s.action])).toEqual([['volume', undefined]]);
    expect(t.body.buttons).toEqual([]);
    expect(hubTile(state({ radios: null, brightness: null, volume: null }), true)).toBeNull();
  });
});

describe('slider mapping', () => {
  it('the top of the track is 1, the bottom 0, clamped, in hundredths', () => {
    expect(sliderAt(100, 100, 200)).toBe(1);
    expect(sliderAt(300, 100, 200)).toBe(0);
    expect(sliderAt(200, 100, 200)).toBe(0.5);
    expect(sliderAt(151, 100, 200)).toBe(0.75);
    expect(sliderAt(20, 100, 200)).toBe(1);
    expect(sliderAt(900, 100, 200)).toBe(0);
    expect(sliderAt(150, 100, 0)).toBe(0);
  });

  it('a slider value becomes a whole percent; anything else is nothing', () => {
    expect(sliderPct(0.734)).toBe(73);
    expect(sliderPct(1.4)).toBe(100);
    expect(sliderPct(-1)).toBe(0);
    expect(sliderPct('50')).toBeNull();
    expect(sliderPct(Number.NaN)).toBeNull();
    expect(sliderPct(undefined)).toBeNull();
  });
});

describe('the hub in saved grids', () => {
  const dims = (key: string) => (key === 'system-controls/hub' ? { w: 2, h: 2 } : { w: 1, h: 1 });

  it('a grid saved before the hub existed still loads as it was', () => {
    const pages = [['music/now', 'system-controls/sound', 'system-controls/brightness', null, 'battery/battery']];
    const s = migrate({ version: 6, island: { grid: { order: [], sizes: { 'system-controls/sound': '2x1' }, hidden: ['weather'], pages } } });
    expect(s.island.grid.pages).toEqual(pages);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1' });
    expect(s.island.grid.hidden).toEqual(['weather']);
  });

  it('joins an existing grid in front of System Controls’ own tiles, keeping everything else in place', () => {
    const saved = [['music/now', 'system-controls/sound', 'system-controls/brightness', 'battery/battery']];
    const keys = ['music/now', 'system-controls/hub', 'system-controls/sound', 'system-controls/brightness', 'battery/battery'];
    expect(withNew(saved, keys, dims)).toEqual([['music/now', 'system-controls/hub', 'system-controls/sound', 'system-controls/brightness', 'battery/battery']]);
  });

  it('a new user gets it too (an empty layout takes every tile)', () => {
    const keys = ['system-controls/hub', 'system-controls/sound'];
    expect(withNew(migrate({}).island.grid.pages, keys, dims).flat()).toEqual(keys);
  });
});

describe('the hub on the phone', () => {
  it('its sliders may send any level, its pills only a plain press', () => {
    const shown = pressables([hubTile(state(), true)]);
    expect(mayPress(shown, 'vol-set', 0.42)).toBe(true);
    expect(mayPress(shown, 'bright-set', 0.9)).toBe(true);
    expect(mayPress(shown, 'wifi', null)).toBe(true);
    expect(mayPress(shown, 'wifi', 'x')).toBe(false);
    expect(mayPress(shown, 'saver', null)).toBe(true);
  });

  it('a view-only hub offers nothing to press', () => {
    const shown = pressables([hubTile(state({ saver: null }), false)]);
    expect(mayPress(shown, 'vol-set', 0.42)).toBe(false);
    expect(mayPress(shown, 'wifi', null)).toBe(false);
  });
});
