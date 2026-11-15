// System Controls: the volume, the screen's brightness and Caps Lock / Num Lock flash on the pill as
// they change, each part with its own switch (Volume, Audio device, Brightness, Caps Lock, Num
// Lock). Its card and Control Center add Screenshot and Record through Snipping Tool, and whether
// battery saver is on, with a button that switches Energy saver. Sound came from Justin's fork,
// Brightness and the lock keys from Moss's; they were three activities until the forks merged
// (settings.ts carries their settings over). Each part lives in its own file: sound.ts,
// brightness.ts, keys.ts.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type BtDevice, type PowerState, type RadiosState, type WifiList } from '../core/native';
import type { MomentId } from '../core/pet';
import { platform } from '../core/platform';
import type { Seg } from '../core/segments';
import type { Block, SheetButton, SheetRow, SheetView, Tile } from '../core/sheet';
import { PhoneError } from '../remote/hub';
import { BaseActivity } from './base';
import { Brightness } from './brightness';
import { BT_SETTINGS, hubTile, saverTip, sliderPct, WIFI_LIST, WIFI_SETTINGS } from './control-hub';
import { Keys } from './keys';
import { Sound } from './sound';

/** When a part's flash began, and how long it shows. */
export type Flash = { at: number; ms: number };

/** What a part gets from the activity. */
export interface Host {
  listen<T>(event: string, cb: (payload: T) => void): void;
  /** Its switch in Options is on (they all are unless turned off). */
  on(option: string): boolean;
  /** Flash on the pill for `ms`; a newer flash with the same key replaces it. */
  show(key: string, ms: number): void;
  saw(id: MomentId, key: string, strength?: number): void;
  /** Something the tiles show changed, with nothing to flash. */
  update(): void;
  alive(): boolean;
}

export interface Part {
  start(): void;
  /** Its latest flash, or null before the first. */
  flash(): Flash | null;
  /** The pill's one line while its flash shows. */
  summary(): string;
  render(env: RenderEnv): Seg[];
}

type Options = { volume: boolean; device: boolean; brightness: boolean; caps: boolean; num: boolean };

/**
 * The card closes first and Snipping Tool's overlay comes this much later: a screenshot freezes
 * the screen as it is, and the island's card shouldn't be in the picture.
 */
export const CAPTURE_DELAY_MS = 350;

/** Windows Settings › Energy saver: offered (on the PC only) when Island couldn't switch it itself. */
export const SAVER_SETTINGS = 'ms-settings:batterysaver';

/** Why Energy saver didn't switch shows on its button this long, with a button to Settings beside it. */
export const SAVER_NOTE_MS = 6000;

/** Snipping Tool is Windows'; a Mac has its own (Cmd+Shift+5). */
const CAPTURE_HERE = platform !== 'macos';

/** Wi-Fi and Bluetooth are read this often, and only while Control Center was drawn lately (the tile is up). */
export const RADIOS_POLL_MS = 5000;

export class SystemControlsActivity extends BaseActivity {
  private readonly host: Host = {
    listen: <T>(event: string, cb: (payload: T) => void) => this.listen<T>(event, cb),
    on: (option) => this.ctx.options<Partial<Options>>()[option as keyof Options] !== false,
    show: (key, ms) => {
      this.ctx.surface({ key, ms, level: 'expanded' });
      this.ctx.update();
    },
    saw: (id, key, strength) => this.saw(id, key, strength),
    update: () => this.ctx.update(),
    alive: () => this.alive,
  };
  private readonly sound = new Sound(this.host);
  private readonly brightness = new Brightness(this.host);
  private readonly keys = new Keys(this.host);
  private power: PowerState | null = null;
  private radios: RadiosState | null = null;
  private btDevices: number | null = null;
  /** What the Wi-Fi and Bluetooth hold menus list, read with the radios. */
  private networks: WifiList | null = null;
  private paired: BtDevice[] | null = null;
  /** Why Energy saver last didn't switch, while it shows (SAVER_NOTE_MS). */
  private saverNote: string | null = null;
  private saverNoteAt = 0;
  /** When the tiles were last asked for: the radios are polled only while Control Center is up. */
  private tilesAt = 0;
  private radiosAt = 0;

  constructor() {
    super('system-controls');
  }

  protected init(): void {
    for (const p of this.parts()) p.start();
    this.listen<PowerState>('power', (p) => {
      const was = this.power?.saver;
      this.power = p;
      if (was !== p.saver) this.ctx.update();
    });
    void native.powerState().then((p) => {
      if (p && !this.power) this.power = p;
    });
    this.every(RADIOS_POLL_MS, () => {
      if (Date.now() - this.tilesAt < RADIOS_POLL_MS * 2) void this.readRadios();
    });
  }

  /**
   * Wi-Fi, Bluetooth, the network, how many Bluetooth devices are connected, and what the hold
   * menus list (the networks in reach, the paired devices); redraws on a change.
   */
  private async readRadios(): Promise<void> {
    this.radiosAt = Date.now();
    let r: RadiosState | null;
    let bt: Array<{ connected: boolean }>;
    let networks: WifiList | null;
    let paired: BtDevice[] | null;
    try {
      [r, bt, networks, paired] = await Promise.all([native.radiosState(), native.btBatteries(), native.wifiNetworks(), native.btDevices()]);
    } catch {
      return;
    }
    if (!this.alive) return;
    const devices = bt.filter((d) => d.connected).length;
    const now = [r, devices, networks, paired];
    const changed = JSON.stringify(now) !== JSON.stringify([this.radios, this.btDevices, this.networks, this.paired]);
    this.radios = r;
    this.btDevices = devices;
    this.networks = networks;
    this.paired = paired;
    if (changed) this.ctx.update();
  }

  private parts(): Part[] {
    return [this.sound, this.brightness, this.keys];
  }

  /** The part that flashed last: the pill shows it (a volume key right after Caps Lock takes over). */
  private latest(): { part: Part; flash: Flash } | null {
    let best: { part: Part; flash: Flash } | null = null;
    for (const part of this.parts()) {
      const flash = part.flash();
      if (flash && (!best || flash.at >= best.flash.at)) best = { part, flash };
    }
    return best;
  }

  status(): ActivityStatus {
    const l = this.latest();
    if (!l || Date.now() - l.flash.at >= l.flash.ms) return { active: false };
    return { active: true, weight: 'foreground', summary: l.part.summary() };
  }

  render(env: RenderEnv): Seg[] {
    return this.latest()?.part.render(env) ?? [];
  }

  /** Battery saver as Windows says it is; null on a computer without a battery (or a Mac). */
  private saver(): boolean | null {
    const p = this.power;
    return p?.hasBattery ? p.saver : null;
  }

  /**
   * Screenshot and Record (with buttons on), and battery saver's state. `labels`: worded, for the
   * card; the tile has room for icons only.
   */
  private buttons(interactive: boolean, labels: boolean): SheetButton[] {
    const out: SheetButton[] = [];
    if (CAPTURE_HERE && interactive) {
      out.push(
        { key: 'shot', icon: 'screenshot', label: labels ? 'Screenshot' : undefined, action: 'screenshot', style: 'secondary', tip: 'Drag an area to capture it (Snipping Tool)' },
        { key: 'record', icon: 'record', label: labels ? 'Record' : undefined, action: 'record', style: 'secondary', tip: 'Drag an area to record it, the desktop too (Snipping Tool)' },
      );
    }
    const saver = this.saver();
    if (saver != null) {
      // The button switches Energy saver the way Settings does (power_saver_set, src-tauri/src/system.rs);
      // when Windows won't, it says why for a moment and offers Settings › Energy saver beside it.
      // With buttons off it only says how it is.
      const note = this.note();
      out.push({
        key: 'saver',
        icon: 'leaf',
        label: labels ? `Energy saver ${saver ? 'on' : 'off'}` : undefined,
        action: 'saver',
        style: saver ? 'primary' : 'secondary',
        disabled: interactive ? undefined : true,
        tip: saverTip(saver, interactive, note),
      });
      if (note && interactive) {
        out.push({ key: 'saver-settings', icon: 'leaf', label: labels ? 'Energy saver settings' : undefined, action: 'saver-settings', style: 'secondary', tip: 'Open Settings › Energy saver' });
      }
    }
    return out;
  }

  /** Speakers (volume with − and +), Brightness, and a cell with the buttons; each only once it has something. */
  tiles(env: SheetEnv): Tile[] {
    const out: Tile[] = [];
    this.tilesAt = Date.now();
    if (Date.now() - this.radiosAt >= RADIOS_POLL_MS) void this.readRadios();
    const a = this.sound.state();
    const hub = hubTile({ radios: this.radios, btDevices: this.btDevices, networks: this.networks, paired: this.paired, volume: a?.volume ?? null, muted: a?.muted ?? false, brightness: this.brightness.state(), saver: this.saver(), saverNote: this.note() }, env.interactive);
    if (hub) out.push(hub);
    const sound = this.sound.tile(env);
    if (sound) out.push(sound);
    const brightness = this.brightness.tile();
    if (brightness) out.push(brightness);
    // Energy saver sits in the Wi-Fi tile when there is one: not twice (Justin).
    const inHub = hub?.body.k === 'hub' && hub.body.buttons.some((b) => b.key === 'saver');
    const buttons = this.buttons(env.interactive, false).filter((b) => !inHub || (b.key !== 'saver' && b.key !== 'saver-settings'));
    if (buttons.length) {
      const saver = this.saver();
      out.push({
        key: 'controls',
        span: 2,
        action: env.interactive ? 'card' : undefined,
        tip: env.interactive ? 'System Controls' : undefined,
        body: { k: 'actions', icon: 'sliders', label: 'System Controls', sub: saver == null ? undefined : `Battery saver ${saver ? 'on' : 'off'}`, buttons },
      });
    }
    return out;
  }

  /** Pointed at or opened: the volume and brightness with their bars, and every button. A flash itself has no card. */
  sheet(env: SheetEnv): SheetView | null {
    if (env.reason !== 'hover' && env.reason !== 'open') return null;
    const a = this.sound.state();
    const level = this.brightness.state();
    const rows: SheetRow[] = [];
    if (a) {
      const pct = Math.round(a.volume * 100);
      rows.push({
        key: 'sound',
        icon: a.muted || pct === 0 ? 'speaker-mute' : 'speaker',
        title: clip(a.device ?? 'Audio output', 40),
        meter: { value: a.muted ? 0 : a.volume, text: a.muted ? 'Muted' : `${pct}%`, tone: 'accent' },
        button: env.interactive ? { key: 'mute', icon: a.muted ? 'speaker' : 'speaker-mute', action: 'mute', style: 'ghost', tip: a.muted ? 'Unmute' : 'Mute' } : undefined,
      });
    }
    if (level != null) rows.push({ key: 'brightness', icon: level < 50 ? 'sun-low' : 'sun', title: 'Brightness', meter: { value: level / 100, text: `${level}%`, tone: 'accent' } });
    const buttons = this.buttons(env.interactive, true);
    if (!rows.length && !buttons.length) return null;
    const blocks: Block[] = [{ t: 'head', key: 'head', icon: 'sliders', title: 'System Controls' }];
    if (rows.length) blocks.push({ t: 'rows', key: 'levels', items: rows });
    if (a && env.interactive) {
      blocks.push({
        t: 'buttons',
        key: 'volume',
        align: 'start',
        items: [
          { key: 'down', icon: 'minus', label: 'Volume', action: 'vol-down', style: 'secondary', tip: 'Volume down' },
          { key: 'up', icon: 'plus', label: 'Volume', action: 'vol-up', style: 'secondary', tip: 'Volume up' },
        ],
      });
    }
    if (buttons.length) blocks.push({ t: 'buttons', key: 'controls', align: 'start', items: buttons });
    return { key: 'system-controls', blocks };
  }

  async action(name: string, arg?: unknown): Promise<void> {
    if (name === 'vol-set') {
      const pct = sliderPct(arg);
      // Dragging the volume up unmutes, as the iPhone does.
      if (pct != null) await native.audioSet(pct / 100, pct > 0 && this.sound.state()?.muted ? false : null);
      return;
    }
    if (name === 'bright-set') {
      const pct = sliderPct(arg);
      if (pct != null) await native.brightnessSet(pct);
      return;
    }
    if (name === 'wifi' || name === 'bluetooth') {
      const on = this.radios?.[name];
      if (on == null) return;
      // Shown switched at once; the next read says how Windows left it.
      this.radios = { ...this.radios!, [name]: !on, ...(name === 'wifi' && on ? { network: null } : {}) };
      this.ctx.update();
      await native.radioSet(name, !on);
      this.later(1500, () => void this.readRadios());
      return;
    }
    if (await this.menuAction(name, arg)) return;
    if (await this.sound.action(name)) return;
    if (name === 'card') this.ctx.openCard?.();
    else if ((name === 'screenshot' || name === 'record') && CAPTURE_HERE) {
      this.ctx.close();
      this.later(CAPTURE_DELAY_MS, () => void native.screenCapture(name === 'record' ? 'video' : 'image'));
    } else if (name === 'saver' && this.saver() != null) {
      await this.toggleSaver();
    } else if (name === 'saver-settings' && this.saver() != null) {
      // Settings › Energy saver opens in front; the island gets out of its way. Never from a phone (PC_ONLY).
      this.ctx.close();
      await native.open(SAVER_SETTINGS);
    }
  }

  /**
   * The Wi-Fi and Bluetooth hold menus: opening one reads them again (Wi-Fi asks Windows for a
   * fresh scan first), and their rows join a network or connect a device. True when it was one.
   */
  private async menuAction(name: string, arg: unknown): Promise<boolean> {
    switch (name) {
      case 'wifi-menu':
        void native.wifiScan();
        void this.readRadios();
        // A scan takes a few seconds; the list fills in as it comes.
        this.later(2500, () => void this.readRadios());
        this.later(6000, () => void this.readRadios());
        return true;
      case 'bt-menu':
        void this.readRadios();
        return true;
      case 'wifi-join': {
        const net = typeof arg === 'string' ? this.networks?.networks.find((n) => n.ssid === arg) : undefined;
        if (!net || net.connected) return true;
        if (net.known && (await native.wifiJoin(net.ssid))) {
          this.later(1500, () => void this.readRadios());
          this.later(4000, () => void this.readRadios());
          return true;
        }
        // New to Windows: its password goes in Windows' own network list, in front on the PC.
        this.ctx.close();
        await native.open(WIFI_LIST);
        throw new PhoneError(`Type the password for ${net.ssid} on the PC`);
      }
      case 'bt-device': {
        const dev = typeof arg === 'string' ? this.paired?.find((d) => d.id === arg) : undefined;
        if (!dev) return true;
        if (dev.audio) {
          const want = !dev.connected;
          // Shown as asked at once; the next reads say how it went (connecting takes a few seconds).
          if (await native.btConnect(dev.id, want)) {
            this.paired = (this.paired ?? []).map((d) => (d.id === dev.id ? { ...d, connected: want } : d));
            this.ctx.update();
            for (const ms of [2000, 5000, 9000]) this.later(ms, () => void this.readRadios());
            return true;
          }
        }
        // Only Windows' own settings connect a mouse, a keyboard or a phone.
        this.ctx.close();
        await native.open(BT_SETTINGS);
        throw new PhoneError(`Connect ${dev.name} from Bluetooth settings on the PC`);
      }
      case 'wifi-settings':
      case 'bt-settings':
        this.ctx.close();
        await native.open(name === 'wifi-settings' ? WIFI_SETTINGS : BT_SETTINGS);
        return true;
    }
    return false;
  }

  /** Why Energy saver last didn't switch, while that still shows. */
  private note(): string | null {
    return this.saverNote && Date.now() - this.saverNoteAt < SAVER_NOTE_MS ? this.saverNote : null;
  }

  /**
   * Switches Energy saver and shows it as Windows reports it. When Windows won't, the button says
   * why for a moment, and a phone that pressed it gets it as a toast (the PhoneError).
   */
  private async toggleSaver(): Promise<void> {
    const want = !this.saver();
    const r = await native.powerSaverSet(want);
    if (r.ok) {
      this.saverNote = null;
      if (this.power) this.power = { ...this.power, saver: r.value };
      this.ctx.update();
      return;
    }
    this.saverNote = r.error;
    this.saverNoteAt = Date.now();
    this.ctx.update();
    this.later(SAVER_NOTE_MS, () => this.ctx.update());
    throw new PhoneError(r.error);
  }
}
