// Quick Actions: icon buttons on the open, idle island: mute, screen snip,
// Bluetooth and Wi-Fi settings, focus settings and lock.

import type { ActivityStatus, SheetEnv } from '../core/activity';
import { native, type AudioState } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetButton, Tile } from '../core/sheet';
import { BaseActivity } from './base';

export class QuickActivity extends BaseActivity {
  private muted = false;

  constructor() {
    super('quick');
  }

  protected init(): void {
    // Only so the mute button shows the current state.
    this.listen<AudioState>('audio', (a) => this.setMuted(a.muted));
    void native.audioState().then((a) => a && this.setMuted(a.muted));
  }

  private setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.ctx.update();
  }

  /** Nothing to show while the island is busy with something else: these live on the home view. */
  status(): ActivityStatus {
    return { active: false };
  }

  render(): Seg[] {
    return [];
  }

  home(): Seg[] {
    const button = (key: string, icon: string, tip: string, prio: number): Seg => ({ t: 'button', key, icon, action: key, style: 'ghost', prio, tip });
    return [
      button('mute', this.muted ? 'speaker-mute' : 'speaker', this.muted ? 'Unmute sound' : 'Mute sound', 3),
      button('snip', 'screenshot', 'Screen snip', 3),
      button('lock', 'lock', 'Lock this PC', 4),
      button('wifi', 'wifi', 'Wi-Fi settings', 5),
      button('bluetooth', 'bluetooth', 'Bluetooth settings', 5),
      button('focus', 'focus', 'Focus settings', 6),
    ];
  }

  /** The same buttons as the home row. With buttons switched off there is nothing here to show. */
  tile(env: SheetEnv): Tile | null {
    if (!env.interactive) return null;
    const buttons = this.home().flatMap((s): SheetButton[] => (s.t === 'button' ? [{ key: s.key, icon: s.icon, action: s.action, style: 'secondary', tip: s.tip }] : []));
    return { key: 'quick', span: 2, body: { k: 'actions', icon: this.meta.icon, label: 'Quick actions', buttons } };
  }

  async action(name: string): Promise<void> {
    switch (name) {
      case 'mute': {
        const a = await native.audioState();
        if (a) await native.audioSet(null, !a.muted);
        return; // stay open: the icon flips as the audio event arrives
      }
      case 'snip':
        await native.snip();
        break;
      case 'bluetooth':
        await native.open('ms-settings:bluetooth');
        break;
      case 'wifi':
        await native.open('ms-settings:network-wifi');
        break;
      case 'focus':
        await native.open('ms-settings:quiethours'); // the Focus page; there is no ms-settings:focus
        break;
      case 'lock':
        await native.lock();
        break;
      default:
        return;
    }
    this.ctx.close();
  }
}
