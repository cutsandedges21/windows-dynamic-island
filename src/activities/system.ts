// System stats: CPU, memory and GPU. Quiet until something spikes, unless
// "Always show" is on.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv } from '../core/activity';
import { bytes } from '../core/format';
import { native, type SysSample } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Options = { always: boolean; cpuSpike: number; memSpike: number };

const SLOW_MS = 5000;
const FAST_MS = 2000;
const SPIKE_MS = 6000;
/** Samples in a row at or above the threshold before it counts as a spike. */
const SPIKE_SAMPLES = 3;

export class SystemActivity extends BaseActivity {
  private s: SysSample | null = null;
  private lastAt = 0;
  private busy = false;
  private streak = 0;
  private spiking = false;
  private memHigh = false;
  private event: { kind: 'cpu' | 'mem'; at: number } | null = null;

  constructor() {
    super('system');
  }

  protected init(): void {
    // One 1 s clock; the sampling interval (5 s, or 2 s when it matters) is decided per tick.
    this.every(1000, () => void this.tick(), true);
  }

  private opts(): Options {
    const o = this.ctx.options<Partial<Options>>();
    return { always: o.always === true, cpuSpike: Number(o.cpuSpike) || 90, memSpike: Number(o.memSpike) || 92 };
  }

  private async tick(): Promise<void> {
    const o = this.opts();
    const every = o.always || this.streak > 0 || this.spiking ? FAST_MS : SLOW_MS;
    if (this.busy || Date.now() - this.lastAt < every - 50) return;
    this.busy = true;
    // The busiest process needs two readings to compare, so ask for it as soon as the CPU runs hot.
    const s = await native.sysSample(this.streak > 0 || this.spiking);
    this.busy = false;
    if (!s || !this.alive) return;
    this.lastAt = Date.now();
    this.s = s;

    const hot = s.cpu >= o.cpuSpike || (this.spiking && s.cpu >= o.cpuSpike - 10);
    this.streak = hot ? this.streak + 1 : 0;
    if (!hot) this.spiking = false;
    else if (this.streak >= SPIKE_SAMPLES && !this.spiking) {
      this.spiking = true;
      this.announce('cpu');
    }

    const mem = s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;
    if (mem >= o.memSpike && !this.memHigh) {
      this.memHigh = true;
      this.announce('mem');
    } else if (mem < o.memSpike - 3) this.memHigh = false;
    this.ctx.update();
  }

  private announce(kind: 'cpu' | 'mem'): void {
    this.event = { kind, at: Date.now() };
    this.ctx.surface({ key: kind, ms: SPIKE_MS, level: 'expanded' });
    this.saw(kind === 'cpu' ? 'cpu-spike' : 'ram-spike', `system:${kind}`);
  }

  /** The CPU running hot: the bot overheats (memory can stay high for hours, so it does not count). */
  override pet(): PetSignal {
    return { mood: this.spiking ? 'overheated' : null, moment: this.petMoment };
  }

  private spike(now: number): 'cpu' | 'mem' | null {
    return this.event && now - this.event.at < SPIKE_MS ? this.event.kind : null;
  }

  status(): ActivityStatus {
    const s = this.s;
    if (!s) return { active: false };
    const kind = this.spike(Date.now());
    if (!kind && !this.opts().always) return { active: false };
    return {
      active: true,
      weight: kind ? 'foreground' : 'background',
      summary: kind === 'mem' ? `RAM ${this.memPct(s)}%` : `CPU ${Math.round(s.cpu)}%`,
    };
  }

  chip(): ChipView | null {
    const s = this.s;
    if (!s) return null;
    return { icon: 'cpu', label: `${Math.round(s.cpu)}%`, tone: this.spike(Date.now()) ? 'bad' : 'muted' };
  }

  private memPct(s: SysSample): number {
    return s.memTotal > 0 ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  }

  /** CPU as the number, memory underneath; red while the CPU is past the spike threshold. */
  tile(): Tile | null {
    const s = this.s;
    if (!s) return null;
    const cpu = Math.round(s.cpu);
    return {
      key: 'cpu',
      tone: cpu >= this.opts().cpuSpike ? 'bad' : undefined,
      body: { k: 'stat', icon: 'cpu', label: 'CPU', value: `${cpu}%`, sub: `RAM ${this.memPct(s)}%`, progress: Math.min(1, Math.max(0, cpu / 100)) },
    };
  }

  render(env: RenderEnv): Seg[] {
    const s = this.s;
    if (!s) return [];
    const compact = env.level === 'compact' || env.level === 'idle';
    const kind = this.spike(env.now);
    const cpu = Math.round(s.cpu);
    const mem = this.memPct(s);
    const o = this.opts();

    if (kind) {
      const isMem = kind === 'mem';
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: isMem ? 'memory' : 'cpu', tone: 'bad', anim: 'pulse', prio: 0 },
        { t: 'text', key: 'main', text: env.vertical ? `${isMem ? mem : cpu}%` : isMem ? `RAM ${mem}%` : `CPU ${cpu}%`, tone: 'bad', weight: 'semibold', prio: 0 },
      ];
      if (!compact && !env.vertical) {
        const detail = isMem ? `${bytes(s.memUsed)} of ${bytes(s.memTotal)}` : s.top ? `${s.top.name} ${Math.round(s.top.cpu)}%` : '';
        if (detail) segs.push({ t: 'text', key: 'detail', text: detail, tone: 'muted', prio: 3 });
      }
      return segs;
    }

    const icon: Seg = { t: 'icon', key: 'icon', icon: 'cpu', tone: 'accent', prio: 0 };
    if (compact) return [icon, { t: 'text', key: 'cpu', text: env.vertical ? `${cpu}%` : `CPU ${cpu}%`, weight: 'semibold', prio: 0 }];

    if (env.level === 'maximum') {
      const segs: Seg[] = [
        icon,
        { t: 'meter', key: 'cpu', label: 'CPU', value: s.cpu / 100, pace: null, text: `${cpu}%`, tone: cpu >= o.cpuSpike ? 'bad' : 'accent', w: 120, prio: 0 },
        { t: 'meter', key: 'mem', label: 'RAM', value: mem / 100, pace: null, text: env.vertical ? `${mem}%` : bytes(s.memUsed), tone: mem >= o.memSpike ? 'bad' : 'accent', w: 130, prio: 1 },
      ];
      if (s.gpu !== null) segs.push({ t: 'meter', key: 'gpu', label: 'GPU', value: s.gpu / 100, pace: null, text: `${Math.round(s.gpu)}%`, tone: 'accent', w: 120, prio: 2 });
      return segs;
    }

    const segs: Seg[] = [icon, { t: 'text', key: 'cpu', text: env.vertical ? `${cpu}%` : `CPU ${cpu}%`, weight: 'semibold', prio: 0 }];
    if (!env.vertical) segs.push({ t: 'text', key: 'mem', text: `RAM ${bytes(s.memUsed)}`, tone: 'muted', prio: 3 });
    if (s.gpu !== null && !env.vertical) segs.push({ t: 'text', key: 'gpu', text: `GPU ${Math.round(s.gpu)}%`, tone: 'muted', prio: 4 });
    return segs;
  }
}
