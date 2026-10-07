// Music: whatever Windows' media controls (GSMTC) report — Spotify, YouTube in
// a browser, Apple Music, local players — with play/pause and skip.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clock } from '../core/format';
import { emitLocal, native, type MediaState } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetButton, Tile } from '../core/sheet';
import { BaseActivity } from './base';

export class MusicActivity extends BaseActivity {
  private m: MediaState | null = null;
  private lastTrack = '';
  private pausedAt: number | null = null;

  constructor() {
    super('music');
  }

  protected init(): void {
    this.listen<MediaState>('media', (m) => this.apply(m));
    void native.mediaState().then((m) => m && this.apply(m, true));
    // Timelines drift between events; a slow poll keeps the bar honest.
    this.every(5000, () => void native.mediaState().then((m) => m && this.apply(m)));
    if (native.demo) this.demo();
  }

  private apply(m: MediaState, first = false): void {
    const prev = this.m;
    this.m = m;
    const playing = m.status === 'playing';
    if (playing) this.pausedAt = null;
    else if (prev?.status === 'playing') this.pausedAt = Date.now();
    else if (this.pausedAt === null && m.available && m.title) this.pausedAt = Date.now();

    const track = m.available && m.title ? `${m.title}\u0000${m.artist}` : '';
    if (track && track !== this.lastTrack) {
      this.lastTrack = track;
      if (!first && playing) this.ctx.surface({ key: `track:${track}`, ms: 3200 });
    } else if (!first && prev && prev.status !== m.status && track) {
      this.ctx.surface({ key: `state:${m.status}`, ms: 1800, bump: false });
    }
    this.ctx.update();
  }

  private keepPausedMs(): number {
    return (Number(this.ctx.options<{ pausedMinutes: number }>().pausedMinutes) || 0) * 60000;
  }

  status(): ActivityStatus {
    const m = this.m;
    if (!m || !m.available || !m.title) return { active: false };
    const playing = m.status === 'playing';
    if (!playing) {
      const since = this.pausedAt ?? Date.now();
      if (Date.now() - since > this.keepPausedMs()) return { active: false };
    }
    return { active: true, weight: playing ? 'foreground' : 'background', summary: `${m.title}${m.artist ? ` · ${m.artist}` : ''}` };
  }

  chip(): ChipView | null {
    if (!this.m?.title) return null;
    return { icon: 'music', label: this.m.title, tone: this.m.status === 'playing' ? 'accent' : 'muted' };
  }

  private position(now: number): number | null {
    const m = this.m;
    if (!m || m.position == null) return null;
    const p = m.status === 'playing' ? m.position + (now - m.updatedAt) / 1000 : m.position;
    return m.duration ? Math.min(m.duration, Math.max(0, p)) : Math.max(0, p);
  }

  render(env: RenderEnv): Seg[] {
    const m = this.m;
    if (!m) return [];
    const playing = m.status === 'playing';
    const showArt = this.ctx.options<{ showArt: boolean }>().showArt !== false;
    const art: Seg = showArt
      ? { t: 'art', key: 'art', src: m.thumbnail, icon: 'music', prio: 3 }
      : { t: 'icon', key: 'art', icon: 'music', tone: 'accent', prio: 3 };
    const bars: Seg = { t: 'bars', key: 'bars', active: playing, tone: 'accent', side: 'end', prio: 2 };
    const title: Seg = { t: 'text', key: 'title', text: m.title, weight: 'semibold', prio: 0, max: env.level === 'compact' ? 120 : undefined };

    if (env.level === 'compact' || env.level === 'idle') {
      return env.surfaced ? [art, title, bars] : [art, bars];
    }
    const segs: Seg[] = [art, title];
    if (m.artist) segs.push({ t: 'text', key: 'artist', text: m.artist, tone: 'muted', prio: 4, min: 40 });
    if (env.level === 'expanded') {
      segs.push(bars);
      return segs;
    }
    const pos = this.position(env.now);
    if (m.duration && pos != null) {
      segs.push(
        { t: 'progress', key: 'bar', value: pos / m.duration, tone: 'default', w: 120, prio: 6, side: 'end' },
        { t: 'text', key: 'time', text: env.vertical ? clock(pos * 1000) : `${clock(pos * 1000)} / ${clock(m.duration * 1000)}`, tone: 'muted', size: 'sm', prio: 7, side: 'end' },
      );
    }
    segs.push(
      { t: 'button', key: 'prev', icon: 'prev', action: 'prev', style: 'ghost', side: 'end', prio: 3, tip: 'Previous' },
      { t: 'button', key: 'toggle', icon: playing ? 'pause' : 'play', action: 'toggle', style: 'secondary', side: 'end', prio: 1, tip: playing ? 'Pause' : 'Play' },
      { t: 'button', key: 'next', icon: 'next', action: 'next', style: 'ghost', side: 'end', prio: 3, tip: 'Next' },
    );
    return segs;
  }

  /** Now playing, or paused not long ago: the same moment status() calls active. */
  tile(env: SheetEnv): Tile | null {
    const m = this.m;
    if (!m || !this.status().active) return null;
    const playing = m.status === 'playing';
    const pos = this.position(env.now);
    // In whole percents: the grid rebuilds a tile whenever its content changes, and a finer bar would rebuild it every frame.
    const progress = m.duration && pos != null ? Math.round(Math.min(1, pos / m.duration) * 100) / 100 : null;
    const buttons: SheetButton[] = [];
    if (env.interactive) {
      buttons.push(
        { key: 'prev', icon: 'prev', action: 'prev', style: 'ghost', tip: 'Previous' },
        { key: 'toggle', icon: playing ? 'pause' : 'play', action: 'toggle', style: 'secondary', tip: playing ? 'Pause' : 'Play' },
        { key: 'next', icon: 'next', action: 'next', style: 'ghost', tip: 'Next' },
      );
    }
    const showArt = this.ctx.options<{ showArt: boolean }>().showArt !== false;
    return { key: 'music', span: 2, rows: 2, body: { k: 'media', art: showArt ? m.thumbnail : null, title: m.title, artist: m.artist || m.app || '', playing, progress, buttons } };
  }

  async action(name: string): Promise<void> {
    if (name !== 'toggle' && name !== 'next' && name !== 'prev') return;
    if (native.demo) {
      if (this.m && name === 'toggle') this.apply({ ...this.m, status: this.m.status === 'playing' ? 'paused' : 'playing', updatedAt: Date.now(), position: this.position(Date.now()) });
      return;
    }
    await native.mediaControl(name);
    setTimeout(() => void native.mediaState().then((m) => m && this.apply(m)), 350);
  }

  private demo(): void {
    this.later(1200, () =>
      emitLocal<MediaState>('media', {
        available: true,
        app: 'Spotify',
        appId: 'Spotify.exe',
        title: 'SICKO MODE',
        artist: 'Travis Scott',
        album: 'ASTROWORLD',
        status: 'playing',
        position: 42,
        duration: 312,
        updatedAt: Date.now(),
        canPlay: true,
        canPause: true,
        canNext: true,
        canPrev: true,
        thumbnail: null,
      }),
    );
  }
}
