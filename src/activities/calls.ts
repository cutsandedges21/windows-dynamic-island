// Mic & Camera: which apps are using the microphone or camera right now, with
// a system-wide microphone mute.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type AudioState, type PrivacyState } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

export class CallsActivity extends BaseActivity {
  private mic: string[] = [];
  private cam: string[] = [];
  private muted: boolean | null = null;

  constructor() {
    super('calls');
  }

  protected init(): void {
    this.listen<PrivacyState>('privacy', (p) => this.apply(p));
    this.listen<AudioState>('audio', (a) => this.setMuted(a.micMuted));
    void native.audioState().then((a) => a && this.setMuted(a.micMuted));
  }

  private setMuted(muted: boolean | null): void {
    if (muted === this.muted) return;
    if (muted === true && this.muted === false && this.mic.length) this.saw('mic-muted', 'calls:mute');
    this.muted = muted;
    this.ctx.update();
  }

  /** The mic or camera in use: the bot is on air. */
  override pet(): PetSignal {
    return { mood: this.mic.length || this.cam.length ? 'on-air' : null, moment: this.petMoment };
  }

  private apply(p: PrivacyState): void {
    const before = new Set([...this.mic, ...this.cam]);
    this.mic = Array.isArray(p.mic) ? p.mic : [];
    this.cam = Array.isArray(p.cam) ? p.cam : [];
    // A new app starting to listen or watch is the moment worth a nod.
    if ([...this.mic, ...this.cam].some((n) => !before.has(n))) {
      this.ctx.surface({ key: 'start', ms: 3000, level: 'expanded' });
      this.saw('call-start', 'calls:start');
    }
    this.ctx.update();
  }

  private names(): string[] {
    return [...new Set([...this.mic, ...this.cam])];
  }

  status(): ActivityStatus {
    const names = this.names();
    if (!names.length) return { active: false };
    const what = this.mic.length && this.cam.length ? 'Mic + camera' : this.cam.length ? 'Camera' : 'Mic';
    // A steady ring while anything listens or watches: red for the mic, green for the camera alone.
    return { active: true, weight: 'foreground', summary: `${what}: ${clip(names.join(', '), 30)}`, beam: { tone: this.mic.length ? 'bad' : 'good', motion: 'progress', value: 1 } };
  }

  chip(): ChipView | null {
    const names = this.names();
    if (!names.length) return null;
    const icon = !this.mic.length ? 'video' : this.muted ? 'mic-off' : 'mic';
    return { icon, label: clip(names[0], 14), tone: 'bad', dot: 'bad', pulse: true };
  }

  /** Only while an app has the mic or the camera. With the mic in use, tapping the cell mutes it. */
  tile(env: SheetEnv): Tile | null {
    const names = this.names();
    if (!names.length) return null;
    const micUse = this.mic.length > 0;
    const camUse = this.cam.length > 0;
    const muted = this.muted === true && micUse;
    const canMute = env.interactive && micUse && this.muted !== null; // some machines have no microphone to mute
    return {
      key: 'calls',
      tone: muted ? 'warn' : 'bad',
      action: canMute ? 'mute' : undefined,
      tip: canMute ? (muted ? 'Unmute microphone' : 'Mute microphone') : undefined,
      body: {
        k: 'stat',
        icon: micUse ? (muted ? 'mic-off' : 'mic') : 'video',
        label: clip(names.join(', '), 24),
        value: micUse ? (muted ? 'Muted' : 'Mic on') : 'Camera on',
        sub: micUse && camUse ? 'Camera on' : undefined,
      },
    };
  }

  render(env: RenderEnv): Seg[] {
    const names = this.names();
    if (!names.length) return [];
    const micUse = this.mic.length > 0;
    const camUse = this.cam.length > 0;
    const muted = this.muted === true && micUse;

    const segs: Seg[] = [];
    if (micUse) segs.push({ t: 'icon', key: 'mic', icon: muted ? 'mic-off' : 'mic', tone: muted ? 'warn' : 'bad', anim: muted ? undefined : 'pulse', prio: 0 });
    if (camUse) segs.push({ t: 'icon', key: 'cam', icon: 'video', tone: 'bad', prio: 0 });
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const canMute = this.muted !== null; // some machines have no microphone to mute
    if (env.vertical) {
      if (roomy && canMute) segs.push(this.muteButton(env));
      return segs;
    }
    if (!roomy) {
      segs.push({ t: 'text', key: 'apps', text: names.length === 1 ? clip(names[0], 14) : `${names.length} apps`, weight: 'semibold', prio: 0 });
      return segs;
    }
    segs.push({ t: 'text', key: 'apps', text: clip(names.join(', '), 30), weight: 'semibold', prio: 2, min: 60 });
    if (muted) segs.push({ t: 'text', key: 'muted', text: 'Muted', tone: 'warn', prio: 3 });
    if (canMute) segs.push(this.muteButton(env));
    return segs;
  }

  private muteButton(env: RenderEnv): Seg {
    const muted = this.muted === true;
    return {
      t: 'button',
      key: 'mute',
      icon: muted ? 'mic' : 'mic-off',
      label: env.level === 'maximum' && !env.vertical ? (muted ? 'Unmute' : 'Mute') : undefined,
      action: 'mute',
      style: muted ? 'primary' : 'secondary',
      side: 'end',
      prio: 1,
      tip: muted ? 'Unmute microphone' : 'Mute microphone',
    };
  }

  async action(name: string): Promise<void> {
    if (name !== 'mute') return;
    const next = this.muted !== true;
    if (await native.micSetMute(next)) {
      this.muted = next;
      this.ctx.update();
    }
  }
}
