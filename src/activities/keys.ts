// Caps Lock and Num Lock: the pill flashes when one turns on or off, like an iPhone's
// silent switch. Rust reads both every 100 ms and says when one changes ('lock-keys').

import type { ActivityStatus, RenderEnv } from '../core/activity';
import { native, type LockKeys } from '../core/native';
import type { Seg } from '../core/segments';
import { BaseActivity } from './base';

type Key = 'caps' | 'num';
type Flash = { key: Key; on: boolean; at: number };
type Options = { caps: boolean; num: boolean };

export const FLASH_MS = 1400;
const NAME: Record<Key, string> = { caps: 'Caps Lock', num: 'Num Lock' };

export class KeysActivity extends BaseActivity {
  private last: LockKeys | null = null;
  private flash: Flash | null = null;

  constructor() {
    super('keys');
  }

  protected init(): void {
    this.listen<LockKeys>('lock-keys', (k) => this.apply(k));
    // How the keys are at startup is the baseline, not news.
    void native.lockKeys().then((k) => {
      if (k && !this.last) this.last = k;
    });
  }

  private apply(k: LockKeys): void {
    const prev = this.last;
    this.last = k;
    if (!prev) return;
    const o = this.ctx.options<Partial<Options>>();
    // Both at once (a keyboard that sets Num Lock with Caps Lock): Caps Lock is the one people look for.
    const key: Key | null = k.caps !== prev.caps && o.caps !== false ? 'caps' : k.num !== prev.num && o.num !== false ? 'num' : null;
    if (!key) return;
    this.flash = { key, on: k[key], at: Date.now() };
    // One key for both ways, so pressing it twice in a row is one flash that changes its word.
    this.ctx.surface({ key, ms: FLASH_MS, level: 'expanded' });
    this.ctx.update();
  }

  status(): ActivityStatus {
    const f = this.flash;
    if (!f || Date.now() - f.at >= FLASH_MS) return { active: false };
    return { active: true, weight: 'foreground', summary: `${NAME[f.key]} ${f.on ? 'on' : 'off'}` };
  }

  render(env: RenderEnv): Seg[] {
    const f = this.flash;
    if (!f) return [];
    const tone = f.on ? 'accent' : 'muted';
    const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: f.key === 'caps' ? 'capslock' : 'numlock', tone, prio: 0 }];
    if (env.vertical) return [...segs, { t: 'text', key: 'state', text: f.on ? 'On' : 'Off', tone, weight: 'semibold', prio: 0 }];
    if (env.level === 'compact' || env.level === 'idle') return [...segs, { t: 'text', key: 'name', text: `${NAME[f.key]} ${f.on ? 'on' : 'off'}`, tone: f.on ? 'default' : 'muted', weight: 'semibold', prio: 0 }];
    return [
      ...segs,
      { t: 'text', key: 'name', text: NAME[f.key], weight: 'semibold', prio: 0 },
      { t: 'text', key: 'state', text: f.on ? 'On' : 'Off', tone, weight: 'semibold', side: 'end', prio: 0 },
    ];
  }
}
