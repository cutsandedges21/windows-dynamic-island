// Phone: your phone's notifications on the island. Windows' Phone Link mirrors them
// (an iPhone over Bluetooth) and src-tauri/src/phonelink.rs hands each new one over.
// Island's own pushes (Settings › Notifications › Send to my phone) come back the same
// way, as the ntfy app's; those are skipped.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { native, type PhoneNote } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetView } from '../core/sheet';
import { BaseActivity } from './base';

const SHOW_MS = 6000;

/** A push Island sent itself, mirrored back from the phone's ntfy app. */
export function isEcho(note: Pick<PhoneNote, 'app'>): boolean {
  return note.app.trim().toLowerCase() === 'ntfy';
}

export class PhoneActivity extends BaseActivity {
  private note: (PhoneNote & { at: number }) | null = null;

  constructor() {
    super('phone');
  }

  protected async init(): Promise<void> {
    this.listen<PhoneNote>('phone-note', (n) => this.arrive(n));
    this.onDispose(() => void native.phoneLinkWatch(false));
    const access = await native.phoneLinkWatch(true);
    // Stopped while asking: the disposer's "off" may have landed before this "on".
    if (!this.alive) void native.phoneLinkWatch(false);
    else if (access !== 'allowed') this.ctx.log(`notification access: ${access}`);
  }

  private arrive(n: PhoneNote): void {
    if (isEcho(n)) return;
    this.note = { ...n, at: Date.now() };
    this.ctx.surface({ key: `phone:${n.id}`, ms: SHOW_MS, level: 'expanded' });
    this.saw('info', `phone:${n.id}`);
    this.later(SHOW_MS + 50, () => this.ctx.update());
    this.ctx.update();
  }

  private fresh(now: number): (PhoneNote & { at: number }) | null {
    return this.note && now - this.note.at < SHOW_MS ? this.note : null;
  }

  status(): ActivityStatus {
    const n = this.fresh(Date.now());
    if (!n) return { active: false };
    return { active: true, weight: 'foreground', summary: n.app ? `${n.app}: ${n.title}` : n.title };
  }

  render(env: RenderEnv): Seg[] {
    const n = this.fresh(env.now);
    if (!n) return [];
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: 'phone', prio: 3 },
      { t: 'text', key: 'who', text: n.title || n.app || 'Phone', weight: 'semibold', prio: 0 },
    ];
    if (env.level === 'compact' || env.level === 'idle' || env.vertical) return segs;
    if (n.body) segs.push({ t: 'text', key: 'body', text: n.body, tone: 'muted', prio: 2 });
    return segs;
  }

  /** The whole message, in the card under the pill while it is shown. */
  sheet(env: SheetEnv): SheetView | null {
    const n = this.fresh(env.now);
    if (!n || !n.body) return null;
    return {
      key: `phone:${n.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'phone', title: n.title || n.app || 'Phone', sub: n.app || undefined },
        { t: 'text', key: 'body', text: n.body, bubble: true, lines: 6 },
      ],
    };
  }
}
