// Control Center's hold menus (Justin's iPhone screenshots): holding the Wi-Fi pill lists the
// networks in reach, holding Bluetooth the paired devices. What each menu says, that every press
// in it reaches System Controls, and what a phone may press in it.

import { describe, expect, it } from 'vitest';
import { bluetoothMenu, hubTile, wifiMenu, type HubState } from '../src/activities/control-hub';
import type { BtDevice, WifiList } from '../src/core/native';
import { mapActions, type HubMenu, type TileBody } from '../src/core/sheet';
import { mayPress, PC_ONLY, pressables, stripActions } from '../src/remote/views';

const nets: WifiList = {
  denied: false,
  networks: [
    { ssid: 'DIRECT-8A-HP OfficeJet Pro 6970', secure: true, connected: false, known: false, signal: 40 },
    { ssid: 'cafe', secure: false, connected: false, known: true, signal: 60 },
    { ssid: 'zwift', secure: true, connected: true, known: true, signal: 90 },
  ],
};
const devices: BtDevice[] = [
  { id: 'aa', name: 'AirPods Pro de Justin', connected: false, audio: true },
  { id: 'bb', name: 'Microsoft Bluetooth Mouse', connected: true, audio: false },
];

const state = (over: Partial<HubState> = {}): HubState => ({
  radios: { wifi: true, bluetooth: true, network: 'zwift' },
  btDevices: 1,
  networks: nets,
  paired: devices,
  volume: 0.5,
  muted: false,
  brightness: 60,
  saver: false,
  ...over,
});

const hub = (body: TileBody | undefined) => {
  if (body?.k !== 'hub') throw new Error('not the hub tile');
  return body;
};

describe('the Wi-Fi menu', () => {
  it('lists every network with the Wi-Fi icon, a lock when it needs a password and a check by the one it is on', () => {
    const m = wifiMenu(true, nets, true);
    expect(m.rows.map((r) => [r.label, r.icon, r.lock ?? false, r.check ?? false])).toEqual([
      ['DIRECT-8A-HP OfficeJet Pro 6970', 'wifi', true, false],
      ['cafe', 'wifi', false, false],
      ['zwift', 'wifi', true, true],
    ]);
    expect(m.more).toMatchObject({ label: 'Wi-Fi Settings…', action: 'wifi-settings' });
    expect(m.open).toBe('wifi-menu');
    expect(m.empty).toBeUndefined();
  });

  it('a tap joins a network by name; the one it is on does nothing', () => {
    const m = wifiMenu(true, nets, true);
    expect(m.rows.map((r) => [r.action, r.arg])).toEqual([
      ['wifi-join', 'DIRECT-8A-HP OfficeJet Pro 6970'],
      ['wifi-join', 'cafe'],
      [undefined, undefined],
    ]);
  });

  it('says why there are no rows: Wi-Fi off, Location off, nothing in reach, or still looking', () => {
    expect(wifiMenu(false, nets, true)).toMatchObject({ rows: [], empty: 'Wi-Fi is off', open: undefined });
    expect(wifiMenu(true, { networks: [], denied: true }, true).empty).toBe('Turn on Location in Windows to see networks');
    expect(wifiMenu(true, { networks: [], denied: false }, true).empty).toBe('No networks in reach');
    expect(wifiMenu(true, null, true).empty).toBe('Looking for networks…');
  });

  it('only says how it is when the screen may not press anything', () => {
    const m = wifiMenu(true, nets, false);
    expect(m.rows.every((r) => r.action === undefined && r.arg === undefined)).toBe(true);
    expect(m.more?.action).toBeUndefined();
    expect(m.open).toBeUndefined();
  });
});

describe('the Bluetooth menu', () => {
  it('lists every paired device by name over Connected / Not Connected, with no icons', () => {
    const m = bluetoothMenu(true, devices, true);
    expect(m.rows.map((r) => [r.label, r.sub, r.icon, r.check])).toEqual([
      ['AirPods Pro de Justin', 'Not Connected', undefined, undefined],
      ['Microsoft Bluetooth Mouse', 'Connected', undefined, undefined],
    ]);
    expect(m.rows.map((r) => [r.action, r.arg])).toEqual([
      ['bt-device', 'aa'],
      ['bt-device', 'bb'],
    ]);
    expect(m.more).toMatchObject({ label: 'Bluetooth Settings…', action: 'bt-settings' });
    expect(m.open).toBe('bt-menu');
  });

  it('says Bluetooth is off, or that nothing is paired', () => {
    expect(bluetoothMenu(false, devices, true)).toMatchObject({ rows: [], empty: 'Bluetooth is off' });
    expect(bluetoothMenu(true, [], true).empty).toBe('No paired devices');
    expect(bluetoothMenu(true, null, true).empty).toBe('Looking for devices…');
  });
});

describe('the menus on the hub tile', () => {
  it('each pill carries its own menu', () => {
    const b = hub(hubTile(state(), true)?.body);
    expect(b.pills.map((p) => [p.key, p.menu?.more?.label])).toEqual([
      ['wifi', 'Wi-Fi Settings…'],
      ['bluetooth', 'Bluetooth Settings…'],
    ]);
  });

  it('every press in a menu carries its activity, as the island needs', () => {
    const t = hubTile(state(), true)!;
    const [b] = mapActions([{ t: 'tiles', key: 'g', items: [t], cols: 2, rows: 2, pages: 1, cell: 0 }], (a) => `act:system-controls:${a}`);
    const body = hub(b.t === 'tiles' ? b.items[0].body : undefined);
    const menus = body.pills.map((p) => p.menu as HubMenu);
    const actions = menus.flatMap((m) => [...m.rows.map((r) => r.action).filter(Boolean), m.more?.action, m.open]);
    expect(actions.length).toBe(2 + 2 + 2 + 2);
    for (const a of actions) expect(a).toMatch(/^act:system-controls:/);
    // The arguments stay as they were.
    expect(menus[0].rows[0].arg).toBe('DIRECT-8A-HP OfficeJet Pro 6970');
  });
});

describe('the menus on the phone', () => {
  const act = (a: string) => `act:system-controls:${a}`;
  const view = () => {
    const t = hubTile(state(), true)!;
    const blocks = mapActions([{ t: 'tiles', key: 'g', items: [t], cols: 2, rows: 2, pages: 1, cell: 0 }], act);
    return stripActions({ key: 'cc', blocks }, new Set(PC_ONLY));
  };

  it('a phone may open a menu and press a row as shown, nothing made up', () => {
    const shown = pressables(view());
    expect(mayPress(shown, act('wifi-menu'), null)).toBe(true);
    expect(mayPress(shown, act('bt-menu'), null)).toBe(true);
    expect(mayPress(shown, act('wifi-join'), 'cafe')).toBe(true);
    expect(mayPress(shown, act('wifi-join'), 'somewhere else')).toBe(false);
    expect(mayPress(shown, act('bt-device'), 'aa')).toBe(true);
    expect(mayPress(shown, act('bt-device'), 'zz')).toBe(false);
  });

  it('Wi-Fi Settings… and Bluetooth Settings… open Windows Settings at the PC: phones never get them', () => {
    const v = view();
    const b = v.blocks[0];
    const body = hub(b.t === 'tiles' ? b.items[0].body : undefined);
    expect(body.pills.map((p) => p.menu?.more)).toEqual([undefined, undefined]);
    // The rows themselves stay.
    expect(body.pills[0].menu?.rows.length).toBe(3);
    const shown = pressables(v);
    expect(mayPress(shown, act('wifi-settings'), null)).toBe(false);
    expect(mayPress(shown, act('bt-settings'), null)).toBe(false);
  });
});
