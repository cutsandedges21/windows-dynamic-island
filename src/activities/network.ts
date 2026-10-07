// Network: drops and reconnects, VPN on and off, and (optionally) live speed.

import type { ActivityStatus, ChipView, RenderEnv } from '../core/activity';
import { bytes, clip, duration, rate } from '../core/format';
import { native, type NetSample } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Moment = { kind: 'online' | 'vpn-on' | 'vpn-off'; at: number; ms: number };

const SAMPLE_MS = 3000;
const OFFLINE_MS = 4000;
const ONLINE_MS = 3500;
const VPN_MS = 3000;

export class NetworkActivity extends BaseActivity {
  private s: NetSample | null = null;
  private known = false;
  private online = true;
  private vpn = false;
  private offlineAt = 0;
  /** Windows reports short dropouts while a network wakes up; offline counts after two samples in a row. */
  private offlineStreak = 0;
  private moment: Moment | null = null;

  constructor() {
    super('network');
  }

  protected init(): void {
    this.every(SAMPLE_MS, () => void this.sample(), true);
  }

  private always(): boolean {
    return this.ctx.options<{ always?: boolean }>().always === true;
  }

  private async sample(): Promise<void> {
    const s = await native.netSample();
    if (!s || !this.alive) return;
    this.s = s;
    const now = Date.now();
    const online = s.connected && s.internet;

    if (!this.known) {
      // The first sample is the starting point, not a transition.
      this.known = true;
      this.online = online;
      this.vpn = s.vpn;
      this.offlineAt = online ? 0 : now;
      this.ctx.update();
      return;
    }

    this.offlineStreak = online ? 0 : this.offlineStreak + 1;
    if (this.online && !online && this.offlineStreak >= 2) {
      this.online = false;
      this.offlineAt = now;
      this.ctx.surface({ key: 'offline', ms: OFFLINE_MS, level: 'expanded' });
    } else if (!this.online && online) {
      this.online = true;
      this.offlineAt = 0;
      this.show('online', ONLINE_MS);
    }
    if (s.vpn !== this.vpn) {
      this.vpn = s.vpn;
      this.show(s.vpn ? 'vpn-on' : 'vpn-off', VPN_MS);
    }
    this.ctx.update();
  }

  private show(kind: Moment['kind'], ms: number): void {
    this.moment = { kind, at: Date.now(), ms };
    this.ctx.surface({ key: kind, ms, level: 'expanded' });
  }

  private recent(now: number): Moment | null {
    return this.moment && now - this.moment.at < this.moment.ms ? this.moment : null;
  }

  status(): ActivityStatus {
    const s = this.s;
    if (!s) return { active: false };
    if (!this.online) return { active: true, weight: 'foreground', summary: 'Offline' };
    const m = this.recent(Date.now());
    if (m) return { active: true, weight: 'foreground', summary: m.kind === 'online' ? 'Back online' : m.kind === 'vpn-on' ? 'VPN on' : 'VPN off' };
    if (this.always()) return { active: true, weight: 'background', summary: `↓ ${rate(s.rxBps)} ↑ ${rate(s.txBps)}` };
    return { active: false };
  }

  chip(): ChipView | null {
    const s = this.s;
    if (!s) return null;
    if (!this.online) return { icon: 'wifi-off', label: 'Offline', tone: 'bad' };
    return { icon: s.wifi ? 'wifi' : 'globe', label: `↓ ${rate(s.rxBps)}`, tone: 'muted' };
  }

  /** Download speed with upload underneath; "Offline" with the network it is stuck on, if any. */
  tile(): Tile | null {
    const s = this.s;
    if (!s) return null;
    if (!this.online) {
      return { key: 'network', tone: 'bad', body: { k: 'stat', icon: 'wifi-off', label: 'Network', value: 'Offline', sub: s.name ? clip(s.name, 24) : undefined } };
    }
    return { key: 'network', body: { k: 'stat', icon: s.wifi ? 'wifi' : 'globe', label: 'Network', value: `↓ ${rate(s.rxBps)}`, sub: `↑ ${rate(s.txBps)}` } };
  }

  render(env: RenderEnv): Seg[] {
    const s = this.s;
    if (!s) return [];
    const compact = env.level === 'compact' || env.level === 'idle';
    const name = s.name ? clip(s.name, 24) : '';

    if (!this.online) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'wifi-off', tone: 'bad', prio: 0 },
        { t: 'text', key: 'main', text: 'Offline', tone: 'bad', weight: 'semibold', prio: 0 },
      ];
      if (!compact && !env.vertical && this.offlineAt) segs.push({ t: 'text', key: 'for', text: `for ${duration(env.now - this.offlineAt)}`, tone: 'muted', prio: 4 });
      return segs;
    }

    const m = this.recent(env.now);
    if (m) {
      const vpn = m.kind !== 'online';
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: vpn ? 'shield' : 'wifi', tone: m.kind === 'vpn-off' ? 'muted' : 'good', prio: 0 },
        { t: 'text', key: 'main', text: m.kind === 'online' ? 'Back online' : m.kind === 'vpn-on' ? 'VPN on' : 'VPN off', weight: 'semibold', prio: 0 },
      ];
      if (!compact && !env.vertical && name) segs.push({ t: 'text', key: 'name', text: name, tone: 'muted', prio: 4 });
      return segs;
    }

    // "Always show": live speed.
    const down = env.vertical ? bytes(s.rxBps) : `↓ ${rate(s.rxBps)}`;
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: s.wifi ? 'wifi' : 'globe', tone: 'accent', prio: 0 },
      { t: 'text', key: 'down', text: down, weight: 'semibold', prio: 0 },
    ];
    if (!compact && !env.vertical) segs.push({ t: 'text', key: 'up', text: `↑ ${rate(s.txBps)}`, weight: 'semibold', prio: 2 });
    if (env.level === 'maximum' && !env.vertical && name) segs.push({ t: 'text', key: 'name', text: name, tone: 'muted', size: 'sm', side: 'end', prio: 5 });
    return segs;
  }
}
