// Music: whatever Windows' media controls (GSMTC) report — Spotify, YouTube in
// a browser, Apple Music, local players — with play/pause and skip. Pointing at
// it grows the pill into an iPhone-style player (src/core/player.ts); the bars
// take their colour from the album art. Clicking the art, in the player or the
// Control Center tile, brings the app playing forward.

import { reducedMotion } from '../core/animator';
import { artColour, barColour } from '../core/artcolor';
import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clock } from '../core/format';
import { hoverGrows } from '../core/grow';
import { emitLocal, native, type AudioState, type MediaState } from '../core/native';
import { platform } from '../core/platform';
import type { PlayerBlock } from '../core/player';
import { growsOf } from '../core/settings';
import type { Seg } from '../core/segments';
import type { SheetButton, SheetView, Tile } from '../core/sheet';
import { pillIsLight } from '../core/glass';
import { BaseActivity } from './base';
import { lineAt, lineIndex, LyricsLoader } from './lyrics';


/** An output device that sounds like it sits on your head. */
export function headphonesLike(device: string | null | undefined): boolean {
  return /head(phone|set)|ear(bud|phone)|airpods|buds|beats|hands-free|wh-\d|wf-\d/i.test(device ?? '');
}

/** The lyrics panel beside the hover player (player.css .pl-ly: 320 + its 20 margin); the card is the player plus this (Justin: less wide). */
export const LYRICS_PANEL_W = 340;

export class MusicActivity extends BaseActivity {
  private m: MediaState | null = null;
  private lyrics = new LyricsLoader(() => this.ctx.update());
  private shown = 0;
  private sung: string | null = null;
  /** The index of the line being sung (-1 before the first): a repeated line is still a new one. */
  private sungAt = -1;
  /** The lyrics panel beside the hover player is open (its button; it stays open until closed). */
  private lyricsOpen = false;
  /** Runs only while the player shows a song with lyrics (an idle island wakes for nothing). */
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastTrack = '';
  private pausedAt: number | null = null;
  private tapping = false;
  private liveUntil = 0;
  /** The art the bars' colour came from, and that colour (null: grey art, or not read yet). */
  private tint: { src: string; hsl: [number, number, number] | null } | null = null;
  /** The default output device's name, for the player's output button. */
  private device: string | null = null;

  constructor() {
    super('music');
  }

  protected init(): void {
    this.listen<MediaState>('media', (m) => this.apply(m));
    this.listen<number[]>('spectrum', (v) => this.paintBars(v));
    this.listen<AudioState>('audio', (a) => (this.device = a.device));
    void native.audioState().then((a) => a && (this.device = a.device));
    // No levels for a moment (capture failed, or a quiet stretch): back to the plain bounce.
    this.every(250, () => this.liveUntil && Date.now() > this.liveUntil && this.paintBars(null));
    void native.mediaState().then((m) => m && this.apply(m, true));
    // Timelines drift between events; a slow poll keeps the bar honest.
    this.every(5000, () => void native.mediaState().then((m) => m && this.apply(m)));
    if (native.demo) this.demo();
  }

  private apply(m: MediaState, first = false): void {
    const prev = this.m;
    this.m = m;
    const playing = m.status === 'playing';
    this.tap(playing);
    this.readTint(m.thumbnail);
    if (playing) this.pausedAt = null;
    else if (prev?.status === 'playing') this.pausedAt = Date.now();
    else if (this.pausedAt === null && m.available && m.title) this.pausedAt = Date.now();

    const track = m.available && m.title ? `${m.title}\u0000${m.artist}` : '';
    if (track && track !== this.lastTrack) {
      this.lastTrack = track;
      if (!first && playing) {
        // Player on a new song: the player grows out of the resting pill (sheet() below) and the
        // pointer holds it like the hover card; the pill under it stays compact, so nothing widens
        // underneath and nothing moves when the card goes back. No nod: the card would bob with
        // the pill while it grows, and the growing is the sign of the new song.
        if (this.newSongPlayer()) this.ctx.surface({ key: `track:${track}`, ms: 3200, level: 'compact', bump: false, hoverHolds: true });
        else this.ctx.surface({ key: `track:${track}`, ms: 3200 });
        this.saw('track', 'music:track');
      }
    } else if (!first && prev && prev.status !== m.status && track) {
      this.ctx.surface({ key: `state:${m.status}`, ms: 1800, bump: false });
      if (m.status === 'playing') this.saw('played', 'music:state');
      else if (prev.status === 'playing') this.saw('paused', 'music:state');
    }
    this.ctx.update();
  }

  /** Music playing: the bot vibes along. */
  override pet(): PetSignal {
    return { mood: this.m?.status === 'playing' ? 'vibing' : null, moment: this.petMoment };
  }

  private tap(on: boolean): void {
    if (on === this.tapping || native.demo) return;
    this.tapping = on;
    void native.spectrumWatch(on);
  }

  protected override dispose(): void {
    this.tap(false);
    this.stopTicker();
  }

  /** The bars' colour from new art: read once per picture, off the main path. */
  private readTint(src: string | null): void {
    // No cover for a moment (a new song's not sent yet): the colour stays as it is.
    if (!src) return;
    if (this.tint?.src === src) return;
    const tint: { src: string; hsl: [number, number, number] | null } = { src, hsl: null };
    this.tint = tint;
    void artColour(src).then((hsl) => {
      if (this.tint !== tint || !this.alive) return;
      if (hsl) tint.hsl = hsl;
      this.ctx.update();
    });
  }

  /** The album's colour for the whole island (Settings › Appearance › In the album's colour), as its
   *  music card takes it; null without a song, or with grey art. */
  artTint(): string | null {
    // Only while a song shows (the tile's test, as the taskbar's: Moss, 11-20, the island kept the
    // colour after the player closed), and not between songs: it fades to the pill's own and the next
    // song's fades in, while the last song stays on show (Moss: "slowly fade to black, then ... fade
    // into colour").
    const m = this.m;
    if (!m || !this.status().active || m.between) return null;
    return this.barTint() ?? null;
  }

  /** Between songs (a skip): the taskbar's colour fades out too. */
  betweenSongs(): boolean {
    return this.m?.between === true;
  }

  /** The bars' colour for this pill: the art's, made to read on a light or dark pill; undefined keeps the accent. */
  private barTint(): string | undefined {
    const hsl = this.tint?.hsl;
    if (!hsl) return undefined;
    return barColour(hsl, pillIsLight(document.documentElement));
  }

  private hoverPlayer(): boolean {
    return this.ctx.options<{ hoverPlayer: boolean }>().hoverPlayer !== false;
  }

  /**
   * A new song grows the player out of the pill instead of widening it (Activities › Music › Player
   * on a new song): only when pointing at the music grows that same player, so it is never a card
   * the hover would not show (Player on hover off, or Grows › Sideways).
   */
  private newSongPlayer(): boolean {
    if (this.ctx.options<{ newSongPlayer: boolean }>().newSongPlayer !== true || !this.hoverPlayer()) return false;
    const grows = hoverGrows('music', growsOf(this.ctx.config(), this.ctx.settings().island.defaultGrows, 'music'), this.ctx.options());
    return grows === 'card';
  }

  /** Surfaced by a new song with Player on a new song: the player shows, not the widened pill. */
  private newSongCard(surfaced: string | null): boolean {
    return Boolean(surfaced?.startsWith('track:')) && this.newSongPlayer();
  }

  /** Pointing at the music grows the pill into the player (Activities › Music › Player on hover). */
  claimsHover(): boolean | 'morph' {
    return this.hoverPlayer() && Boolean(this.m?.title) && this.status().active ? 'morph' : false;
  }

  /** Bass to treble onto the pill's bars; null hands them back to the CSS bounce. */
  private paintBars(v: number[] | null): void {
    const live = v !== null && v.some((x) => x > 0) && !reducedMotion();
    this.liveUntil = live ? Date.now() + 600 : 0;
    for (const e of document.querySelectorAll<HTMLElement>('.seg-bars')) {
      e.classList.toggle('live', live);
      if (live) v!.forEach((x, i) => e.style.setProperty(`--eq${i}`, String(x)));
    }
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
    const bars: Seg = { t: 'bars', key: 'bars', active: playing, tone: 'accent', color: this.barTint(), side: 'end', prio: 2 };
    const title: Seg = { t: 'text', key: 'title', text: m.title, weight: 'semibold', prio: 0, max: env.level === 'compact' ? 120 : undefined };

    if (env.level === 'compact' || env.level === 'idle') {
      // Under the player a new song grew, the pill rests as it was: no title widening it.
      return env.surfaced && !this.newSongCard(env.surfaced) ? [art, title, bars] : [art, bars];
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

  /**
   * Now playing, or paused not long ago (the same moment status() calls active): the cover, the
   * song, and back, play/pause and next (Justin). A click anywhere else opens the lyrics card.
   */
  tile(env: SheetEnv): Tile | null {
    const m = this.m;
    if (!m || !this.status().active) return null;
    const playing = m.status === 'playing';
    const buttons: SheetButton[] = [];
    if (env.interactive) {
      buttons.push(
        { key: 'prev', icon: 'prev', action: 'prev', style: 'ghost', tip: 'Previous' },
        { key: 'toggle', icon: playing ? 'pause' : 'play', action: 'toggle', style: 'secondary', tip: playing ? 'Pause' : 'Play' },
        { key: 'next', icon: 'next', action: 'next', style: 'ghost', tip: 'Next' },
      );
    }
    const showArt = this.ctx.options<{ showArt: boolean }>().showArt !== false;
    // The cover too opens the card (no `open`): only the three buttons do something else.
    return {
      key: 'music',
      span: 2,
      rows: 2,
      action: env.interactive ? 'card' : undefined,
      tip: this.lyricsOn() ? 'Lyrics' : 'Now playing',
      // The Music widget takes the art's colour as the island's music card does (Moss, 11-18).
      tint: this.barTint() ?? null,
      body: { k: 'media', art: showArt ? m.thumbnail : null, title: m.title, artist: m.artist || m.app || '', playing, progress: null, buttons },
    };
  }

  /** Clicking the art brings the app playing forward: Windows finds its tab or window (media.rs `focus`). */
  private canOpen(): boolean {
    return platform === 'windows';
  }

  private lyricsOn(): boolean {
    return this.ctx.options<{ lyrics: boolean }>().lyrics !== false;
  }

  /** The line being sung for the player: '' between lines, null when the song has no synced lyrics. */
  private lyric(pos: number | null, now: number): string | null {
    this.shown = now;
    const lines = this.lyrics.lines(this.m, this.lyricsOn());
    this.sung = lines && pos != null ? (lineAt(lines, pos) ?? '') : null;
    this.sungAt = lines && pos != null ? lineIndex(lines, pos) : -1;
    if (this.sung != null && !this.ticker && this.alive) this.ticker = setInterval(() => this.tick(), 250);
    return this.sung;
  }

  /** The panel's lines: the whole song, the one being sung, or why there are none. */
  private panel(pos: number | null, close?: string): NonNullable<PlayerBlock['lyrics']> {
    const lines = this.lyrics.lines(this.m, this.lyricsOn());
    if (!lines) {
      const note = !this.lyricsOn() ? 'Lyrics are off in Activities › Music' : this.m && this.lyrics.known(this.m) ? 'No synced lyrics for this song' : 'Looking for lyrics…';
      return { lines: [], at: -1, note, close };
    }
    return { lines: lines.map((l) => l.text), at: pos != null ? lineIndex(lines, pos) : -1, close };
  }

  /** Where the line between the player and the lyrics was last left (its panel's width, px), or null for the usual split. */
  private lyricsSplit(): number | null {
    const w = this.ctx.options<{ lyricsSplit?: unknown }>().lyricsSplit;
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
  }

  /** The player's width on this island's size (island.ts MORPH_W), so the panel adds to it and the player itself stays put. */
  private playerWidth(): number {
    const scale = { small: 0.88, medium: 1, large: 1.14 }[this.ctx.settings().island.size] ?? 1;
    return Math.round(372 * scale);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Lines change between the 1 s patches: while the player shows, look four times a second. */
  private tick(): void {
    if (!this.alive || this.sung == null || Date.now() - this.shown > 1500) return this.stopTicker();
    const lines = this.lyrics.lines(this.m, this.lyricsOn());
    const pos = this.position(Date.now());
    const line = lines && pos != null ? (lineAt(lines, pos) ?? '') : null;
    const at = lines && pos != null ? lineIndex(lines, pos) : -1;
    if (line !== this.sung || at !== this.sungAt) this.ctx.update();
  }

  /**
   * The player the pill grows into while the pointer is on the music: like an iPhone's
   * Dynamic Island, and like Claude's card it stays while the pointer is on it.
   */
  sheet(env: SheetEnv): SheetView | null {
    const m = this.m;
    if (env.reason === 'open') return m?.title ? this.stageCard(env) : null;
    // Pointed at, or a new song with Player on a new song: the same player, so pointing at it
    // after a new song keeps the card it already shows.
    const asked = env.reason === 'hover' || (env.reason === 'surfaced' && this.newSongCard(env.surfaced));
    if (!asked || !this.hoverPlayer() || !m?.title) return null;
    const on = env.interactive;
    const pos = this.position(env.now);
    const showArt = this.ctx.options<{ showArt: boolean }>().showArt !== false;
    const lyric = this.lyric(pos, env.now);
    // The lyrics button shows only for a song with synced lyrics; the panel stays open until closed.
    const open = on && this.lyricsOpen && lyric != null;
    const block: PlayerBlock = {
      t: 'player',
      key: 'player',
      art: showArt ? m.thumbnail : null,
      title: m.title,
      artist: m.artist || m.app || '',
      playing: m.status === 'playing',
      position: pos,
      duration: m.duration && m.duration > 0 ? m.duration : null,
      color: this.barTint() ?? null,
      // The card on the art's colour, like the lyrics card from Control Center (Justin).
      cardTint: this.barTint() ?? null,
      // No sung line under the artist (Justin): the lyrics button opens the whole song instead.
      lyric: null,
      lyrics: open ? { ...this.panel(pos, 'lyrics'), split: 'lyrics-split', width: this.lyricsSplit() } : null,
      lyricsButton: on && lyric != null ? { action: 'lyrics', on: open } : null,
      // Not interactive (Activities › Music): the player only shows, with no buttons.
      actions: on
        ? { prev: 'prev', toggle: 'toggle', next: 'next', seek: 'seek', output: platform === 'windows' ? 'output' : undefined, open: this.canOpen() ? 'open' : undefined }
        : { prev: '', toggle: '', next: '' },
      output: { icon: headphonesLike(this.device) ? 'headphones' : 'speaker', tip: this.device ? `Sound output: ${this.device}` : 'Sound output' },
    };
    return { key: 'player', morph: true, blocks: [block], width: open ? this.playerWidth() + LYRICS_PANEL_W : undefined };
  }

  /**
   * Control Center's lyrics card (the Music tile's lyrics button): the art big over the track and
   * its controls, the whole song's lyrics beside it, on the art's colour. Back goes to Control Center.
   */
  private stageCard(env: SheetEnv): SheetView {
    const m = this.m!;
    const pos = this.position(env.now);
    this.lyric(pos, env.now);
    const showArt = this.ctx.options<{ showArt: boolean }>().showArt !== false;
    const block: PlayerBlock = {
      t: 'player',
      key: 'player',
      art: showArt ? m.thumbnail : null,
      title: m.title,
      artist: m.artist || m.app || '',
      playing: m.status === 'playing',
      position: pos,
      duration: m.duration && m.duration > 0 ? m.duration : null,
      color: this.barTint() ?? null,
      lyric: null,
      lyrics: this.panel(pos),
      stage: { tint: this.barTint() ?? null },
      actions: { prev: 'prev', toggle: 'toggle', next: 'next', seek: 'seek', output: platform === 'windows' ? 'output' : undefined, open: this.canOpen() ? 'open' : undefined },
      output: { icon: headphonesLike(this.device) ? 'headphones' : 'speaker', tip: this.device ? `Sound output: ${this.device}` : 'Sound output' },
    };
    return {
      key: 'music-lyrics',
      width: 640,
      blocks: [{ t: 'head', key: 'head', icon: 'music', title: 'Lyrics', sub: m.app || undefined, back: { key: 'back', icon: 'chevron-left', action: 'lyrics-back', style: 'ghost', tip: 'Back to Control Center' } }, block],
    };
  }

  async action(name: string, arg?: unknown): Promise<void> {
    if (name === 'lyrics') {
      this.lyricsOpen = !this.lyricsOpen;
      this.ctx.update();
      return;
    }
    if (name === 'lyrics-split') {
      const w = Number(arg);
      if (!Number.isFinite(w)) return;
      // Kept with Music's options: the lyrics open where they were left, every time (Justin).
      this.ctx.setOptions?.({ lyricsSplit: Math.round(Math.max(160, Math.min(900, w))) });
      this.ctx.update();
      return;
    }
    if (name === 'lyrics-card') return this.ctx.openCard?.();
    if (name === 'lyrics-back') return this.ctx.closeCard?.();
    // The Music tile (its lyrics or its player): the card, Justin's lyrics card.
    if (name === 'card') return this.ctx.openCard?.();
    if (name === 'output') {
      await native.soundOutput();
      return;
    }
    if (name === 'open') {
      // The tab or app it's playing in comes forward, and the island steps out of its way.
      if (!native.demo) await native.mediaControl('focus');
      this.ctx.close();
      return;
    }
    if (name !== 'toggle' && name !== 'next' && name !== 'prev' && name !== 'seek') return;
    if (native.demo) {
      if (this.m && name === 'toggle') this.apply({ ...this.m, status: this.m.status === 'playing' ? 'paused' : 'playing', updatedAt: Date.now(), position: this.position(Date.now()) });
      if (this.m && name === 'seek' && Number.isFinite(Number(arg))) this.apply({ ...this.m, position: Number(arg), updatedAt: Date.now() });
      return;
    }
    if (name === 'seek') {
      const secs = Number(arg);
      if (!Number.isFinite(secs) || secs < 0) return;
      await native.mediaControl('seek', secs);
    } else await native.mediaControl(name);
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
