// Sound, a part of System Controls: a volume flyout when the volume or mute changes, a note
// when the default output device changes (headphones connecting), and the Speakers tile with
// − and + volume buttons.

import type { RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type AudioState } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import type { Flash, Host, Part } from './system-controls';

type View = { kind: 'volume' | 'device'; at: number; ms: number };

export const HEADSET = /head|bud|pod|airpod|bluetooth|hands-free/i;
const VOLUME_MS = 1600;
const DEVICE_MS = 3500;
const STEP = 0.05;

export class Sound implements Part {
  private a: AudioState | null = null;
  private view: View | null = null;

  constructor(private host: Host) {}

  start(): void {
    this.host.listen<AudioState>('audio', (a) => this.apply(a));
    // The first state (Rust sends one at startup) is the baseline, not news.
    void native.audioState().then((a) => {
      if (a && !this.a) this.a = a;
    });
  }

  /** The volume and the output now (null until Rust said). */
  state(): AudioState | null {
    return this.a;
  }

  private apply(a: AudioState): void {
    const prev = this.a;
    this.a = a;
    if (!prev) return;
    if (a.deviceId && a.deviceId !== prev.deviceId) {
      // Options › Audio device off: no note, but the tile still follows the new output.
      if (!this.host.on('device')) return this.host.update();
      this.show('device', DEVICE_MS);
      this.host.saw('audio-device', 'sound:device');
    } else if (a.muted !== prev.muted || Math.abs(a.volume - prev.volume) >= 0.005) {
      if (!this.host.on('volume')) return this.host.update();
      this.show('volume', VOLUME_MS);
      // One key for all of it, so holding a volume key is one long reaction; a bigger step bounces higher.
      const step = a.volume - prev.volume;
      if (a.muted && !prev.muted) this.host.saw('muted', 'sound:volume');
      else this.host.saw(step > 0 || (prev.muted && !a.muted) ? 'volume-up' : 'volume-down', 'sound:volume', Math.min(1, 0.2 + Math.abs(step) * 8));
    }
  }

  private show(kind: View['kind'], ms: number): void {
    this.view = { kind, at: Date.now(), ms };
    this.host.show(kind, ms);
  }

  flash(): Flash | null {
    return this.view && this.a ? this.view : null;
  }

  summary(): string {
    const a = this.a;
    if (!a) return '';
    return this.view?.kind === 'device' ? `Audio: ${a.device ?? 'device'}` : a.muted ? 'Muted' : `Volume ${Math.round(a.volume * 100)}%`;
  }

  /** The volume and where it goes; tapping the cell mutes and unmutes, − and + step the volume. */
  tile(env: SheetEnv): Tile | null {
    const a = this.a;
    if (!a) return null;
    const pct = Math.round(a.volume * 100);
    const off = a.muted || pct === 0;
    return {
      key: 'sound',
      tone: off ? 'muted' : 'accent',
      action: env.interactive ? 'mute' : undefined,
      tip: env.interactive ? (a.muted ? 'Unmute' : 'Mute') : undefined,
      body: {
        k: 'stat',
        icon: off ? 'speaker-mute' : a.volume < 0.5 ? 'speaker-low' : 'speaker',
        label: clip(a.device ?? 'Audio output', 24),
        value: a.muted ? 'Muted' : `${pct}%`,
        progress: pct / 100,
        buttons: env.interactive
          ? [
              { key: 'down', icon: 'minus', action: 'vol-down', style: 'secondary', tip: 'Volume down' },
              { key: 'up', icon: 'plus', action: 'vol-up', style: 'secondary', tip: 'Volume up' },
            ]
          : undefined,
      },
    };
  }

  render(env: RenderEnv): Seg[] {
    const a = this.a;
    const v = this.view;
    if (!a || !v) return [];
    const compact = env.level === 'compact' || env.level === 'idle';

    if (v.kind === 'device') {
      const name = a.device ?? 'Audio device';
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: HEADSET.test(name) ? 'headphones' : 'speaker', tone: 'accent', prio: 0 },
        { t: 'text', key: 'name', text: name, weight: 'semibold', prio: 0 },
      ];
      if (!compact && !env.vertical) segs.splice(1, 0, { t: 'text', key: 'state', text: 'Connected', tone: 'muted', prio: 4 });
      return segs;
    }

    const pct = Math.round(a.volume * 100);
    const off = a.muted || pct === 0;
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: off ? 'speaker-mute' : a.volume < 0.5 ? 'speaker-low' : 'speaker', tone: off ? 'muted' : 'default', prio: 0 },
    ];
    if (compact) {
      segs.push({ t: 'text', key: 'pct', text: a.muted ? 'Muted' : `${pct}%`, weight: 'semibold', prio: 0 });
      return segs;
    }
    segs.push(
      { t: 'progress', key: 'bar', value: a.volume, tone: off ? 'muted' : 'default', w: env.level === 'maximum' ? 170 : 110, side: 'center', prio: 3 },
      { t: 'text', key: 'pct', text: a.muted ? 'Muted' : `${pct}%`, weight: 'semibold', side: 'end', prio: 0 },
    );
    if (env.level === 'maximum') {
      segs.push(
        { t: 'button', key: 'down', icon: 'minus', action: 'vol-down', style: 'ghost', side: 'end', prio: 2, tip: 'Volume down' },
        { t: 'button', key: 'mute', icon: a.muted ? 'speaker' : 'speaker-mute', action: 'mute', style: 'secondary', side: 'end', prio: 1, tip: a.muted ? 'Unmute' : 'Mute' },
        { t: 'button', key: 'up', icon: 'plus', action: 'vol-up', style: 'ghost', side: 'end', prio: 2, tip: 'Volume up' },
      );
    }
    return segs;
  }

  /** Volume up, down and mute; false for an action that isn't Sound's. */
  async action(name: string): Promise<boolean> {
    if (name !== 'vol-up' && name !== 'vol-down' && name !== 'mute') return false;
    const a = this.a ?? (await native.audioState());
    if (!a) return true;
    if (name === 'mute') await native.audioSet(null, !a.muted);
    else {
      const next = Math.min(1, Math.max(0, Math.round((a.volume + (name === 'vol-up' ? STEP : -STEP)) * 100) / 100));
      await native.audioSet(next, name === 'vol-up' && a.muted ? false : null);
    }
    // Rust's poll reports the change within 300 ms; reading now makes the buttons feel instant.
    const now = await native.audioState();
    if (now && this.host.alive()) this.apply(now);
    return true;
  }
}
