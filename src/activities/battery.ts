// Battery: plugging in, unplugging and low charge. Quiet the rest of the time.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv } from '../core/activity';
import { duration } from '../core/format';
import { native, type PowerState } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Options = { lowAt: number; showCharging: boolean };

const EVENT_MS = 3000;
/** A low-battery warning stays urgent this long unless the user taps it away. */
const WARN_MS = 20000;
/** Below this the warning is "critical" (it also shakes), when the user's threshold is higher. */
const CRITICAL = 10;
/** Windows' estimate is only believable up to a couple of days. */
const MAX_LEFT_S = 48 * 3600;

/** "25 min left", "2 h 10 min left"; empty when the estimate is unknown or absurd. */
function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_LEFT_S) return '';
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min left` : `${h} h left`;
}

export class BatteryActivity extends BaseActivity {
  private p: PowerState | null = null;
  private event: { kind: 'plug' | 'unplug'; at: number } | null = null;
  private warn: { key: string; at: number } | null = null;
  /** Thresholds already warned about during this discharge: one warning per crossing. */
  private readonly warned = new Set<number>();

  constructor() {
    super('battery');
  }

  protected init(): void {
    this.listen<PowerState>('power', (p) => this.apply(p));
    void native.powerState().then((p) => p && this.apply(p));
  }

  private opts(): { lowAt: number; showCharging: boolean } {
    const o = this.ctx.options<Partial<Options>>();
    return { lowAt: Math.max(1, Math.round(Number(o.lowAt) || 20)), showCharging: o.showCharging === true };
  }

  /** The user's threshold, plus 10% as the critical one when that is lower. */
  private thresholds(): number[] {
    const { lowAt } = this.opts();
    return lowAt > CRITICAL ? [CRITICAL, lowAt] : [lowAt];
  }

  private onBattery(p: PowerState): boolean {
    return p.hasBattery && !p.ac && !p.charging;
  }

  private isLow(p: PowerState): boolean {
    return this.onBattery(p) && p.percent !== null && p.percent <= this.opts().lowAt;
  }

  reconfigure(): void {
    // A new threshold is not a crossing: start from where the charge is now.
    this.warned.clear();
    if (this.p) this.markWarned(this.p);
    this.ctx.update();
  }

  private markWarned(p: PowerState): void {
    if (!this.onBattery(p) || p.percent === null) return;
    for (const t of this.thresholds()) if (p.percent <= t) this.warned.add(t);
  }

  private apply(p: PowerState): void {
    const prev = this.p;
    this.p = p;
    if (!p.hasBattery) {
      this.ctx.update();
      return;
    }
    if (!prev) {
      this.markWarned(p); // what the charge already is at startup is not news
      this.ctx.update();
      return;
    }

    if (prev.hasBattery && prev.ac !== p.ac) {
      this.event = { kind: p.ac ? 'plug' : 'unplug', at: Date.now() };
      this.ctx.surface({ key: this.event.kind, ms: EVENT_MS, level: 'expanded' });
      this.saw(p.ac ? 'plugged' : 'unplugged', 'battery:power');
    }
    // Charged to the top while plugged in: the bot is proud of it.
    if (p.hasBattery && p.percent !== null && prev.percent !== null && p.percent >= 100 && prev.percent < 100 && (p.ac || p.charging)) this.saw('full', 'battery:full');

    if (!this.onBattery(p)) this.warned.clear();
    else if (p.percent !== null) {
      const hit = this.thresholds().filter((t) => p.percent !== null && p.percent <= t);
      const fresh = hit.filter((t) => !this.warned.has(t));
      for (const t of hit) this.warned.add(t);
      if (fresh.length) this.warnLow(Math.min(...fresh));
    }
    this.ctx.update();
  }

  private warnLow(threshold: number): void {
    const key = `low-${threshold}`;
    this.warn = { key, at: Date.now() };
    this.ctx.surface({ key, ms: WARN_MS, level: 'expanded' });
    this.ctx.alert('glow', 'bad');
    if (threshold <= CRITICAL) this.ctx.alert('shake');
    this.saw(threshold <= CRITICAL ? 'battery-critical' : 'battery-low', 'battery:low');
  }

  /** Charging, tired when low, drained when nearly empty. */
  override pet(): PetSignal {
    const p = this.p;
    let mood: PetSignal['mood'] = null;
    if (p?.hasBattery && p.charging) mood = 'charging';
    else if (p && this.onBattery(p) && p.percent !== null && p.percent <= CRITICAL) mood = 'drained';
    else if (p && this.isLow(p)) mood = 'tired';
    return { mood, moment: this.petMoment };
  }

  dismiss(key: string): void {
    if (this.warn?.key === key) this.warn = null;
  }

  status(): ActivityStatus {
    const p = this.p;
    if (!p?.hasBattery) return { active: false };
    const now = Date.now();
    const warn = this.warn && now - this.warn.at < WARN_MS && this.isLow(p) ? this.warn : null;
    const recent = this.event !== null && now - this.event.at < EVENT_MS;
    const keep = p.charging && this.opts().showCharging;
    if (!warn && !recent && !keep) return { active: false };
    return {
      active: true,
      weight: warn || recent ? 'foreground' : 'background',
      urgent: warn ? { key: warn.key, level: 'expanded' } : null,
      summary: `Battery ${Math.round(p.percent ?? 0)}%${p.charging ? ', charging' : ''}`,
      // Green edge filled to the charge while charging; a red breath when it runs low.
      beam: p.charging ? { tone: 'good', motion: 'progress', value: (p.percent ?? 0) / 100 } : warn ? { tone: 'bad', motion: 'pulse' } : null,
    };
  }

  chip(): ChipView | null {
    const p = this.p;
    if (!p?.hasBattery) return null;
    return { icon: p.charging ? 'bolt' : 'battery', label: `${Math.round(p.percent ?? 0)}%`, tone: p.charging ? 'good' : this.isLow(p) ? 'bad' : 'muted' };
  }

  /** Not on a desktop: no battery, no cell. */
  tile(): Tile | null {
    const p = this.p;
    if (!p?.hasBattery) return null;
    const pct = Math.round(p.percent ?? 0);
    const head = p.charging ? 'Charging' : p.ac ? 'Plugged in' : 'On battery';
    const sub = pct >= 100 && (p.ac || p.charging) ? 'Full' : p.secondsLeft !== null ? timeLeft(p.secondsLeft) : '';
    return { key: 'battery', span: 2, body: { k: 'battery', pct, charging: p.charging, head, sub } };
  }

  render(env: RenderEnv): Seg[] {
    const p = this.p;
    if (!p?.hasBattery) return [];
    const pct = Math.round(p.percent ?? 0);
    const low = this.isLow(p);
    const tone: Tone = p.charging ? 'good' : low ? 'bad' : 'default';
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: p.charging ? 'bolt' : 'battery', tone, anim: low ? 'pulse' : undefined, prio: 0 },
      { t: 'text', key: 'pct', text: `${pct}%`, tone: low ? 'bad' : 'default', weight: 'semibold', prio: 0 },
    ];
    if (env.level === 'compact' || env.level === 'idle') return segs;

    if (!env.vertical) {
      const label = low ? 'Battery low' : p.charging ? 'Charging' : p.ac ? 'Plugged in' : 'On battery';
      segs.push({ t: 'text', key: 'label', text: label, tone: low ? 'bad' : 'muted', prio: 4 });
    }
    segs.push({ t: 'progress', key: 'bar', value: pct / 100, tone, w: env.level === 'maximum' ? 150 : 90, side: 'center', prio: 5 });
    if (env.level === 'maximum' && !env.vertical && p.secondsLeft !== null) {
      segs.push({ t: 'text', key: 'left', text: `${duration(p.secondsLeft * 1000)} left`, tone: 'muted', size: 'sm', side: 'end', prio: 6 });
    }
    return segs;
  }
}
