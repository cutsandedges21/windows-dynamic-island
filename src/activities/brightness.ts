// Brightness: a flyout like the volume one when the screen's brightness changes.
// Rust says the new value ('brightness', 0-100) whenever Windows reports one;
// external monitors and Macs never do, so then there is nothing to show.

import type { ActivityStatus, RenderEnv } from '../core/activity';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

export const FLASH_MS = 1600;

const icon = (pct: number) => (pct < 50 ? 'sun-low' : 'sun');
// A whole percent 0-100, or null for anything that isn't a real number.
const pctOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null);

export class BrightnessActivity extends BaseActivity {
  private level: number | null = null;
  private at = 0;

  constructor() {
    super('brightness');
  }

  protected init(): void {
    this.listen<number>('brightness', (v) => this.apply(v));
    // The first value (Windows sends one at startup) is the baseline, not news.
    void native.brightnessGet().then((v) => {
      if (this.level == null) this.level = pctOf(v);
    });
  }

  private apply(v: unknown): void {
    const next = pctOf(v);
    if (next == null) return;
    const prev = this.level;
    this.level = next;
    if (prev == null || prev === next) return;
    this.at = Date.now();
    this.ctx.surface({ key: 'brightness', ms: FLASH_MS, level: 'expanded' });
    // One key for all of it, so holding a brightness key is one long reaction; a bigger step bounces higher.
    const step = next - prev;
    this.saw(step > 0 ? 'volume-up' : 'volume-down', 'brightness:level', Math.min(1, 0.2 + Math.abs(step) * 0.08));
    this.ctx.update();
  }

  status(): ActivityStatus {
    const pct = this.level;
    if (pct == null || !this.at || Date.now() - this.at >= FLASH_MS) return { active: false };
    return { active: true, weight: 'foreground', summary: `Brightness ${pct}%` };
  }

  /** The brightness as a stat; Island can't set it, so tapping does nothing. */
  tile(): Tile | null {
    const pct = this.level;
    if (pct == null) return null;
    return { key: 'brightness', tone: 'accent', body: { k: 'stat', icon: icon(pct), label: 'Brightness', value: `${pct}%`, progress: pct / 100 } };
  }

  render(env: RenderEnv): Seg[] {
    const pct = this.level;
    if (pct == null || !this.at) return [];
    const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: icon(pct), tone: 'default', prio: 0 }];
    if (env.vertical || env.level === 'compact' || env.level === 'idle') {
      segs.push({ t: 'text', key: 'pct', text: `${pct}%`, weight: 'semibold', prio: 0 });
      return segs;
    }
    segs.push(
      { t: 'progress', key: 'bar', value: pct / 100, tone: 'default', w: env.level === 'maximum' ? 170 : 110, side: 'center', prio: 3 },
      { t: 'text', key: 'pct', text: `${pct}%`, weight: 'semibold', side: 'end', prio: 0 },
    );
    return segs;
  }
}
