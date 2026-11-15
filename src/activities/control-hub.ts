// System Controls' iPhone-style tile: Wi-Fi and Bluetooth as wide pills, brightness and volume as
// tall sliders, battery saver as a round button, in one 2x2 tile. Pure: what the tile shows for a
// state (system-controls.ts gathers the state and does the actions).

import type { BtDevice, RadiosState, WifiList } from '../core/native';
import type { HubMenu, HubPill, HubSlider, SheetButton, Tile } from '../core/sheet';

export const HUB_KEY = 'hub';

export interface HubState {
  /** null: radios can't be read here (a Mac) or not yet. */
  radios: RadiosState | null;
  /** Connected Bluetooth devices, when known. */
  btDevices: number | null;
  /** The Wi-Fi networks in reach, for the Wi-Fi pill's hold menu; null until read (or on a Mac). */
  networks?: WifiList | null;
  /** The paired Bluetooth devices, for the Bluetooth pill's hold menu; null until read. */
  paired?: BtDevice[] | null;
  /** 0-1, with whether it is muted; null without an audio device. */
  volume: number | null;
  muted: boolean;
  /** 0-100; null where Windows never reports it (an external monitor). */
  brightness: number | null;
  /** Battery saver; null without a battery. */
  saver: boolean | null;
  /** Why Energy saver just didn't switch, while that shows. */
  saverNote?: string | null;
}

/** The battery saver button's tip: what a click does, or why it just didn't switch. */
export function saverTip(on: boolean, interactive: boolean, note: string | null = null): string {
  if (note) return `${note}. Energy saver is ${on ? 'on' : 'off'}.`;
  return interactive ? `Turn Energy saver ${on ? 'off' : 'on'}` : `Energy saver is ${on ? 'on' : 'off'}`;
}

/** Windows Settings › Wi-Fi and › Bluetooth & devices: the hold menus' last row (on the PC only). */
export const WIFI_SETTINGS = 'ms-settings:network-wifi';
export const BT_SETTINGS = 'ms-settings:bluetooth';
/** Windows' own list of networks (the Wi-Fi flyout), where a new network's password is typed. */
export const WIFI_LIST = 'ms-availablenetworks:';

/**
 * Holding the Wi-Fi pill (Justin's iPhone screenshot): every network in reach, its Wi-Fi icon with
 * a lock when it needs a password, a check by the one the computer is on, then Wi-Fi Settings….
 * A tap joins a network (the one it's on does nothing).
 */
export function wifiMenu(on: boolean, list: WifiList | null | undefined, interactive: boolean): HubMenu {
  const nets = on ? (list?.networks ?? []) : [];
  const empty = !on ? 'Wi-Fi is off' : list?.denied ? 'Turn on Location in Windows to see networks' : list ? 'No networks in reach' : 'Looking for networks…';
  return {
    rows: nets.map((n) => ({
      key: `net:${n.ssid}`,
      label: n.ssid,
      icon: 'wifi',
      lock: n.secure || undefined,
      check: n.connected || undefined,
      action: interactive && !n.connected ? 'wifi-join' : undefined,
      arg: interactive && !n.connected ? n.ssid : undefined,
    })),
    more: { key: 'more', label: 'Wi-Fi Settings…', action: interactive ? 'wifi-settings' : undefined },
    empty: nets.length ? undefined : empty,
    open: interactive && on ? 'wifi-menu' : undefined,
  };
}

/**
 * Holding the Bluetooth pill (Justin's iPhone screenshot): every paired device, its name over a
 * dim "Connected" / "Not Connected", no icons, then Bluetooth Settings…. A tap connects or
 * disconnects earbuds and speakers; anything else opens Bluetooth settings.
 */
export function bluetoothMenu(on: boolean, devices: BtDevice[] | null | undefined, interactive: boolean): HubMenu {
  const list = on ? (devices ?? []) : [];
  return {
    rows: list.map((d) => ({
      key: `bt:${d.id}`,
      label: d.name,
      sub: d.connected ? 'Connected' : 'Not Connected',
      action: interactive ? 'bt-device' : undefined,
      arg: interactive ? d.id : undefined,
    })),
    more: { key: 'more', label: 'Bluetooth Settings…', action: interactive ? 'bt-settings' : undefined },
    empty: list.length ? undefined : !on ? 'Bluetooth is off' : devices ? 'No paired devices' : 'Looking for devices…',
    open: interactive && on ? 'bt-menu' : undefined,
  };
}

/** "Wi-Fi · Home" on, "Wi-Fi · Off" off; null without a Wi-Fi radio. Held, it lists the networks. */
export function wifiPill(radios: RadiosState | null, interactive: boolean, networks?: WifiList | null): HubPill | null {
  const on = radios?.wifi;
  if (on == null) return null;
  const sub = on ? (radios?.network?.trim() || 'Not connected') : 'Off';
  return {
    key: 'wifi',
    icon: on ? 'wifi' : 'wifi-off',
    label: 'Wi-Fi',
    sub,
    on,
    action: interactive ? 'wifi' : undefined,
    tip: interactive ? `Turn Wi-Fi ${on ? 'off' : 'on'} (hold for networks)` : undefined,
    menu: wifiMenu(on, networks, interactive),
  };
}

/** "2 Devices" / "1 Device" / "On" / "Off"; null without a Bluetooth radio. Held, it lists the paired devices. */
export function bluetoothPill(radios: RadiosState | null, devices: number | null, interactive: boolean, paired?: BtDevice[] | null): HubPill | null {
  const on = radios?.bluetooth;
  if (on == null) return null;
  const sub = !on ? 'Off' : devices && devices > 0 ? `${devices} Device${devices === 1 ? '' : 's'}` : 'On';
  return {
    key: 'bluetooth',
    icon: 'bluetooth',
    label: 'Bluetooth',
    sub,
    on,
    action: interactive ? 'bluetooth' : undefined,
    tip: interactive ? `Turn Bluetooth ${on ? 'off' : 'on'} (hold for devices)` : undefined,
    menu: bluetoothMenu(on, paired, interactive),
  };
}

/** A slider's 0-1 value as the whole percent the native side takes. */
export function sliderPct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 100) : null;
}

/** The tile, or null when there is nothing on this computer for it to show. */
export function hubTile(s: HubState, interactive: boolean): Tile | null {
  const pills = [wifiPill(s.radios, interactive, s.networks), bluetoothPill(s.radios, s.btDevices, interactive, s.paired)].filter((p): p is HubPill => p != null);
  const sliders: HubSlider[] = [];
  if (s.brightness != null) {
    const v = Math.max(0, Math.min(100, s.brightness)) / 100;
    sliders.push({ key: 'brightness', icon: v < 0.5 ? 'sun-low' : 'sun', value: v, action: interactive ? 'bright-set' : undefined, tip: `Brightness ${Math.round(v * 100)}%` });
  }
  if (s.volume != null) {
    const v = s.muted ? 0 : Math.max(0, Math.min(1, s.volume));
    sliders.push({ key: 'volume', icon: v === 0 ? 'speaker-mute' : 'speaker', value: v, action: interactive ? 'vol-set' : undefined, tip: s.muted ? 'Muted' : `Volume ${Math.round(v * 100)}%` });
  }
  const buttons: SheetButton[] = [];
  if (s.saver != null) {
    buttons.push({
      key: 'saver',
      icon: 'leaf',
      action: 'saver',
      style: s.saver ? 'primary' : 'secondary',
      disabled: interactive ? undefined : true,
      tip: saverTip(s.saver, interactive, s.saverNote ?? null),
    });
  }
  if (!pills.length && !sliders.length) return null;
  return { key: HUB_KEY, span: 2, rows: 2, sizes: [[2, 2]], tone: 'accent', body: { k: 'hub', pills, sliders, buttons } };
}
