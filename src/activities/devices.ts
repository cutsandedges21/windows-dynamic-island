// Devices: USB drives and other storage plugged in or removed, and the battery of Bluetooth earbuds and headphones.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type AudioState, type BtBattery, type DeviceEvent } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetRow, Tile } from '../core/sheet';
import { BaseActivity } from './base';
import { HEADSET } from './sound';

type Moment = { ev: DeviceEvent; at: number; ms: number };
type Drive = { drive: string; label: string };
type Flash = { bt: BtBattery; low: boolean; at: number };

const ARRIVED_MS = 5000;
const REMOVED_MS = 2500;
export const BT_FLASH_MS = 3500;
export const BT_POLL_MS = 60_000;
/** Windows reports a device's battery a moment after it connects. */
export const BT_SETTLE_MS = 3000;
const LOW = 20;
const REARM = 30;


export class DevicesActivity extends BaseActivity {
  private m: Moment | null = null;
  /** Removable drives plugged in while the island runs, by upper-case drive letter, oldest first. */
  private readonly drives = new Map<string, Drive>();
  /** Connected Bluetooth devices that report a battery, by name. */
  private bt = new Map<string, BtBattery>();
  private readonly low = new Set<string>();
  private polled = false;
  private dev: string | null | undefined;
  /** The sound output's name ("Headphones (Crusher ANC 2 Stereo)"), to tell headphones from phones and mice. */
  private out = '';
  private f: Flash | null = null;

  constructor() {
    super('devices');
  }

  protected init(): void {
    this.listen<DeviceEvent>('device', (ev) => this.apply(ev));
    this.listen<AudioState>('audio', (s) => {
      const was = this.dev;
      this.dev = s.deviceId;
      this.out = s.device ?? '';
      if (was !== undefined && s.deviceId && s.deviceId !== was) this.later(BT_SETTLE_MS, () => void this.poll());
    });
    this.every(BT_POLL_MS, () => void this.poll(), true);
  }

  private async poll(): Promise<void> {
    let list: BtBattery[];
    try {
      list = await native.btBatteries();
    } catch {
      return;
    }
    if (!this.alive) return;
    const first = !this.polled;
    this.polled = true;
    const next = new Map(list.filter((b) => b.connected).map((b) => [b.name, b] as const));
    for (const b of next.values()) {
      if (b.percent > REARM) this.low.delete(b.name);
      const low = b.percent <= LOW && !this.low.has(b.name);
      if (low) this.low.add(b.name);
      // Connecting only flashes for headphones: a phone or a watch comes and goes on its own all day.
      if (low || (!first && !this.bt.has(b.name) && this.audio(b.name))) this.flash(b, low);
    }
    this.bt = next;
    this.ctx.update();
  }

  /** Headphones by name, or the device the sound plays through. */
  private audio(name: string): boolean {
    return HEADSET.test(name) || (!!this.out && this.out.toLowerCase().includes(name.toLowerCase()));
  }

  private icon(name: string): 'headphones' | 'bluetooth' {
    return this.audio(name) ? 'headphones' : 'bluetooth';
  }

  private flash(bt: BtBattery, low: boolean): void {
    this.f = { bt, low, at: Date.now() };
    this.ctx.surface({ key: `bt:${low ? 'low' : 'in'}:${bt.name}`, ms: BT_FLASH_MS, level: 'expanded' });
    if (low) this.saw('battery-low', `devices:bt:${bt.name}`);
  }

  /** The battery flash, while it is the newest thing to show. */
  private live(): Flash | null {
    const f = this.f;
    if (!f || Date.now() - f.at >= BT_FLASH_MS) return null;
    const m = this.m;
    return m && Date.now() - m.at < m.ms && m.at > f.at ? null : f;
  }

  private apply(ev: DeviceEvent): void {
    if (ev.action !== 'arrived' && ev.action !== 'removed') return;
    // A removal says nothing reliable about the volume (removable is false by then), so it goes by letter alone.
    const letter = String(ev.drive).toUpperCase();
    if (ev.action === 'removed') this.drives.delete(letter);
    else if (ev.removable) this.drives.set(letter, { drive: ev.drive, label: ev.label });
    const ms = ev.action === 'arrived' ? ARRIVED_MS : REMOVED_MS;
    this.m = { ev, at: Date.now(), ms };
    this.ctx.surface({ key: `${ev.action}:${ev.drive}`, ms, level: 'expanded' });
    if (ev.action === 'removed' || ev.removable) this.saw(ev.action === 'arrived' ? 'usb-in' : 'usb-out', `devices:${letter}`);
    this.ctx.update();
  }

  status(): ActivityStatus {
    const f = this.live();
    if (f) return { active: true, weight: 'foreground', summary: `${clip(f.bt.name, 20)} ${f.bt.percent}%` };
    const m = this.m;
    if (!m || Date.now() - m.at >= m.ms) return { active: false };
    const { ev } = m;
    return { active: true, weight: 'foreground', summary: ev.action === 'arrived' ? `${clip(ev.label || 'USB drive', 20)} ${ev.drive}` : `${ev.drive} removed` };
  }

  /** The removable drives plugged in since the island started (newest first), each one tap from its folder. */
  tile(env: SheetEnv): Tile | null {
    const drives = [...this.drives.values()].reverse();
    const bts = [...this.bt.values()];
    if (!drives.length && !bts.length) return null;
    const row = (d: Drive): SheetRow => ({ key: d.drive, title: d.label || 'USB drive', badge: d.drive, action: env.interactive ? 'open' : undefined, arg: d.drive, tip: env.interactive ? `Open ${d.drive}` : undefined });
    const btRow = (b: BtBattery): SheetRow => ({ key: `bt:${b.name}`, icon: this.icon(b.name), title: b.name, badge: `${b.percent}%`, tone: b.percent <= LOW ? 'warn' : undefined });
    const list = [...drives.map(row), ...bts.map(btRow)];
    const rows = list.length <= 3 ? list : [...list.slice(0, 2), { key: 'more', title: `+${list.length - 2} more` }];
    const label = drives.length && !bts.length ? 'Drives' : 'Devices';
    return { key: 'drives', rows: rows.length > 1 ? 2 : 1, body: { k: 'list', icon: drives.length ? 'usb' : this.icon(bts[0].name), label, rows } };
  }

  render(env: RenderEnv): Seg[] {
    const compact = env.level === 'compact' || env.level === 'idle';
    const f = this.live();
    if (f) {
      const { bt } = f;
      const low = f.low || bt.percent <= LOW;
      const pct = `${bt.percent}%`;
      if (env.vertical) return [{ t: 'icon', key: 'icon', icon: this.icon(bt.name), tone: low ? 'warn' : 'accent', prio: 0 }, { t: 'text', key: 'pct', text: pct, tone: low ? 'warn' : 'default', weight: 'semibold', prio: 0 }];
      return [
        { t: 'icon', key: 'icon', icon: this.icon(bt.name), tone: low ? 'warn' : 'accent', prio: 0 },
        { t: 'text', key: 'name', text: bt.name, weight: 'semibold', prio: compact ? 1 : 0, min: 60 },
        { t: 'text', key: 'pct', text: pct, tone: low ? 'warn' : 'muted', weight: low ? 'semibold' : undefined, prio: 0 },
      ];
    }
    const m = this.m;
    if (!m) return [];
    const { ev } = m;

    if (ev.action === 'removed') {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'drive', tone: 'muted', prio: 0 },
        { t: 'text', key: 'what', text: 'Removed', tone: 'muted', weight: 'semibold', prio: 0 },
      ];
      if (!compact) segs.push({ t: 'text', key: 'drive', text: ev.drive, tone: 'muted', prio: 3 });
      return segs;
    }

    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: 'usb', tone: 'accent', prio: 0 },
      { t: 'text', key: 'label', text: env.vertical ? ev.drive : ev.label || 'USB drive', weight: 'semibold', prio: 0, min: 60 },
    ];
    if (compact) return segs;
    if (!env.vertical) segs.push({ t: 'text', key: 'drive', text: ev.drive, tone: 'muted', prio: 3 });
    segs.push({ t: 'button', key: 'open', icon: 'folder', label: env.vertical ? undefined : 'Open', action: 'open', style: 'primary', side: 'end', prio: 1, tip: `Open ${ev.drive}` });
    return segs;
  }

  action(name: string, arg?: unknown): void {
    if (name !== 'open') return;
    // A tile row passes its drive letter (only one we know is plugged in); the card's button means the drive that just arrived.
    const ev = this.m?.ev;
    const drive = typeof arg === 'string' ? (this.drives.has(arg.toUpperCase()) ? arg : null) : ev?.action === 'arrived' ? ev.drive : null;
    if (!drive || !/^[A-Za-z]:$/.test(drive)) return;
    void native.open(`${drive}\\`);
    this.m = null;
    this.ctx.close();
    this.ctx.update();
  }
}
