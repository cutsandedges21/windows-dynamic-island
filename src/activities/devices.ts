// Devices: USB drives and other storage plugged in or removed.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type DeviceEvent } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetRow, Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Moment = { ev: DeviceEvent; at: number; ms: number };
type Drive = { drive: string; label: string };

const ARRIVED_MS = 5000;
const REMOVED_MS = 2500;

export class DevicesActivity extends BaseActivity {
  private m: Moment | null = null;
  /** Removable drives plugged in while the island runs, by upper-case drive letter, oldest first. */
  private readonly drives = new Map<string, Drive>();

  constructor() {
    super('devices');
  }

  protected init(): void {
    this.listen<DeviceEvent>('device', (ev) => this.apply(ev));
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
    const m = this.m;
    if (!m || Date.now() - m.at >= m.ms) return { active: false };
    const { ev } = m;
    return { active: true, weight: 'foreground', summary: ev.action === 'arrived' ? `${clip(ev.label || 'USB drive', 20)} ${ev.drive}` : `${ev.drive} removed` };
  }

  /** The removable drives plugged in since the island started (newest first), each one tap from its folder. */
  tile(env: SheetEnv): Tile | null {
    const list = [...this.drives.values()].reverse();
    if (!list.length) return null;
    const row = (d: Drive): SheetRow => ({ key: d.drive, title: d.label || 'USB drive', badge: d.drive, action: env.interactive ? 'open' : undefined, arg: d.drive, tip: env.interactive ? `Open ${d.drive}` : undefined });
    const rows = list.length <= 3 ? list.map(row) : [...list.slice(0, 2).map(row), { key: 'more', title: `+${list.length - 2} more` }];
    return { key: 'drives', rows: rows.length > 1 ? 2 : 1, body: { k: 'list', icon: 'usb', label: 'Drives', rows } };
  }

  render(env: RenderEnv): Seg[] {
    const m = this.m;
    if (!m) return [];
    const { ev } = m;
    const compact = env.level === 'compact' || env.level === 'idle';

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
