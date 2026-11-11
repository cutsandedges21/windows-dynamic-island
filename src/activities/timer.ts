// Timer, stopwatch and focus sessions, entirely in the island.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clock } from '../core/format';
import type { Seg } from '../core/segments';
import type { SheetButton, SheetRow, SheetView, Tile } from '../core/sheet';
import { tileCard } from '../core/tilecard';
import { BaseActivity, chime } from './base';

type Mode = 'timer' | 'stopwatch' | 'focus';

interface TimerState {
  mode: Mode;
  label: string;
  /** Countdown: when it ends (running) or how much is left (paused). */
  endsAt: number | null;
  totalMs: number;
  remainingMs: number;
  /** Stopwatch: when it started (running) and time banked before the last pause. */
  startedAt: number | null;
  bankedMs: number;
  /** Stopwatch: the elapsed time at each Lap press. */
  laps: number[];
  running: boolean;
  phase: 'focus' | 'break';
  round: number;
  doneAt: number | null;
}

const DONE_SHOW_MS = 60000;
/** The dial's ceiling: 23:59:59. */
const MAX_SECONDS = 86399;
/** Laps a stopwatch's card lists (the newest). */
const SHOWN_LAPS = 5;

/** 0:12.34: a lap to the hundredth. */
function lapClock(ms: number): string {
  const cs = Math.max(0, Math.floor(ms / 10));
  return `${clock(Math.floor(cs / 100) * 1000)}.${String(cs % 100).padStart(2, '0')}`;
}

/** "5 min", "1h 30m", "45s", "2m 30s": a length as people say it. */
export function shortLength(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const s = secs % 60;
  if (!h && !s) return `${m} min`;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean).join(' ');
}

export class TimerActivity extends BaseActivity {
  private t: TimerState | null = null;

  constructor() {
    super('timer');
  }

  protected init(): void {
    this.every(250, () => this.check());
    // Focus rounds used to turn Quiet on (Moss's v0.4.2). One that Island closed during left it
    // on with this flag: turn it off once, so nobody stays stuck in Quiet.
    if (this.ctx.options<{ quietByFocus?: boolean }>().quietByFocus) {
      this.ctx.setOptions?.({ quietByFocus: undefined });
      if (this.ctx.settings().general.dnd) this.ctx.setQuiet?.(false);
    }
  }

  status(): ActivityStatus {
    const t = this.t;
    if (!t) return { active: false };
    if (t.doneAt) return { active: true, weight: 'foreground', urgent: { key: `done-${t.doneAt}`, level: 'maximum' }, summary: `${t.label} done` };
    // The edge fills as a countdown runs (violet for focus); a stopwatch just circles.
    const left = t.endsAt !== null && t.totalMs > 0 ? Math.max(0, t.endsAt - Date.now()) / t.totalMs : null;
    const beam = !t.running ? null : left === null ? { tone: 'accent' as const, motion: 'orbit' as const } : { tone: t.mode === 'focus' ? ('violet' as const) : ('accent' as const), motion: 'progress' as const, value: 1 - left };
    return { active: true, weight: t.running ? 'foreground' : 'background', summary: `${t.label} ${this.timeText(Date.now())}`, beam };
  }

  chip(): ChipView | null {
    if (!this.t) return null;
    return { icon: this.iconName(), label: this.timeText(Date.now()), tone: this.t.doneAt ? 'warn' : this.t.mode === 'focus' ? 'bad' : 'accent' };
  }

  // ---------------------------------------------------------------- control

  startTimer(ms: number, label = 'Timer'): void {
    this.t = { mode: 'timer', label, endsAt: Date.now() + ms, totalMs: ms, remainingMs: ms, startedAt: null, bankedMs: 0, laps: [], running: true, phase: 'focus', round: 1, doneAt: null };
    this.ctx.surface({ key: 'start', ms: 2500 });
    this.saw('timer-start', 'timer:start');
    this.ctx.update();
  }

  startStopwatch(): void {
    this.t = { mode: 'stopwatch', label: 'Stopwatch', endsAt: null, totalMs: 0, remainingMs: 0, startedAt: Date.now(), bankedMs: 0, laps: [], running: true, phase: 'focus', round: 1, doneAt: null };
    this.ctx.surface({ key: 'start', ms: 2000 });
    this.ctx.update();
  }

  startFocus(round = 1, phase: 'focus' | 'break' = 'focus'): void {
    const o = this.ctx.options<{ focusMinutes: number; breakMinutes: number }>();
    const ms = (phase === 'focus' ? Number(o.focusMinutes) || 25 : Number(o.breakMinutes) || 5) * 60000;
    this.t = {
      mode: 'focus',
      label: phase === 'focus' ? 'Focus' : 'Break',
      endsAt: Date.now() + ms,
      totalMs: ms,
      remainingMs: ms,
      startedAt: null,
      bankedMs: 0,
      laps: [],
      running: true,
      phase,
      round,
      doneAt: null,
    };
    this.ctx.surface({ key: `focus-${round}-${phase}`, ms: 2500 });
    this.saw(phase === 'focus' ? 'focus-start' : 'break-start', 'timer:start');
    this.ctx.update();
  }

  /** A focus round running: the bot concentrates; a finished timer needs you. */
  override pet(): PetSignal {
    const t = this.t;
    const mood = t?.doneAt ? 'needs-you' : t?.running && t.mode === 'focus' && t.phase === 'focus' ? 'focused' : null;
    return { mood, moment: this.petMoment };
  }

  private check(): void {
    const t = this.t;
    if (!t) return;
    const now = Date.now();
    if (t.doneAt && now - t.doneAt > DONE_SHOW_MS) {
      this.t = null;
      this.ctx.update();
      return;
    }
    if (t.running && t.endsAt && now >= t.endsAt) {
      t.running = false;
      t.remainingMs = 0;
      t.endsAt = null;
      t.doneAt = now;
      this.ctx.alert('shake');
      this.saw('timer-done', 'timer:done');
      this.ctx.alert('glow', t.mode === 'focus' ? 'bad' : 'warn');
      if (this.ctx.settings().general.sounds) chime('done');
      this.ctx.notify(t.mode === 'focus' ? (t.phase === 'focus' ? 'Focus session done' : 'Break over') : 'Timer done', t.label);
      this.ctx.update();
    }
  }

  private elapsedMs(now: number): number {
    const t = this.t!;
    return t.bankedMs + (t.running && t.startedAt ? now - t.startedAt : 0);
  }

  /** The lap running now: its number and how long it has gone. */
  private currentLap(now: number): { n: number; ms: number } {
    const t = this.t!;
    return { n: t.laps.length + 1, ms: this.elapsedMs(now) - (t.laps[t.laps.length - 1] ?? 0) };
  }

  private leftMs(now: number): number {
    const t = this.t!;
    if (t.mode === 'stopwatch') return 0;
    return t.running && t.endsAt ? Math.max(0, t.endsAt - now) : t.remainingMs;
  }

  private timeText(now: number): string {
    const t = this.t;
    if (!t) return '';
    if (t.doneAt) return '0:00';
    return clock(t.mode === 'stopwatch' ? this.elapsedMs(now) : this.leftMs(now));
  }

  private iconName(): string {
    const t = this.t;
    if (!t) return 'timer';
    return t.mode === 'stopwatch' ? 'stopwatch' : t.mode === 'focus' ? 'focus' : 'timer';
  }

  // ---------------------------------------------------------------- view

  /** The length the timer starts with, set on its tile's dial (5 minutes until then). */
  private timerSeconds(): number {
    const n = Math.round(Number(this.ctx.options<{ timerSeconds: number }>().timerSeconds));
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_SECONDS, n) : 300;
  }

  /** Starters for the open, idle island. */
  home(): Seg[] {
    if (this.t) return [];
    const o = this.ctx.options<{ focusMinutes: number }>();
    const n = this.timerSeconds();
    return [
      { t: 'button', key: 'start5', icon: 'timer', label: shortLength(n), action: 'start-secs', arg: n, style: 'secondary', prio: 5, tip: `Start a ${shortLength(n)} timer` },
      { t: 'button', key: 'focus', icon: 'focus', label: `${o.focusMinutes || 25}m`, action: 'focus', style: 'secondary', prio: 5, tip: 'Start a focus session' },
      { t: 'button', key: 'sw', icon: 'stopwatch', action: 'stopwatch', style: 'ghost', prio: 6, tip: 'Stopwatch' },
    ];
  }

  /**
   * Running or paused: the time and pause/stop. Finished: what to do next.
   * Idle: the starters home() offers. Icon-only throughout, so they fit one cell.
   */
  tile(env: SheetEnv): Tile | null {
    const t = this.t;
    if (!t) {
      // A tile of nothing but a title is no use when buttons are off.
      if (!env.interactive) return null;
      const starters = this.home().flatMap((s): SheetButton[] => (s.t === 'button' ? [{ key: s.key, icon: s.icon, action: s.action, arg: s.arg, style: s.style === 'good' ? 'primary' : 'secondary', tip: s.tip }] : []));
      // The dial and its Start replace the quick-timer button; focus and stopwatch sit small up top.
      const buttons = starters.filter((b) => b.key !== 'start5').map((b) => ({ ...b, style: 'ghost' as const }));
      const dial = { seconds: this.timerSeconds(), action: 'length', start: { key: 'start', icon: 'play', action: 'start-secs', style: 'primary' as const, tip: 'Start' } };
      return { key: 'timer', tone: 'accent', body: { k: 'actions', icon: 'timer', label: 'Timer', buttons, dial } };
    }

    if (t.doneAt) {
      const focus = t.mode === 'focus';
      const buttons: SheetButton[] = [];
      if (env.interactive) {
        // The same buttons, in the same order, as the pill's finished timer (render below).
        if (focus) {
          buttons.push(
            { key: 'next', label: t.phase === 'focus' ? 'Start break' : 'Next focus', action: 'next', style: 'primary' },
            { key: 'dismiss', icon: 'check', action: 'dismiss', style: 'secondary', tip: 'Dismiss' },
          );
        } else {
          buttons.push(
            { key: 'snooze', label: '+1 min', action: 'add', arg: 60000, style: 'secondary' },
            { key: 'restart', icon: 'refresh', action: 'restart', style: 'ghost', tip: 'Again' },
            { key: 'dismiss', icon: 'check', label: 'Done', action: 'dismiss', style: 'primary' },
          );
        }
      }
      const label = focus ? (t.phase === 'focus' ? 'Focus done' : 'Break over') : `${t.label} done`;
      return { key: 'timer', tone: 'warn', body: { k: 'actions', icon: 'bell', label, sub: 'Time is up', buttons } };
    }

    const name = t.mode === 'focus' ? t.label : t.mode === 'stopwatch' ? 'Stopwatch' : 'Timer';
    const lap = t.mode === 'stopwatch' && t.laps.length ? this.currentLap(env.now) : null;
    const what = t.mode === 'focus' ? `Round ${t.round}` : lap ? `Lap ${lap.n} · ${clock(lap.ms)}` : t.mode === 'stopwatch' ? 'Counting up' : t.label;
    // A stopwatch's Lap while it runs, Reset while it's paused, like the iPhone's.
    const sw: SheetButton[] =
      t.mode !== 'stopwatch' ? [] : t.running ? [{ key: 'lap', icon: 'flag', action: 'lap', style: 'secondary', tip: 'Lap' }] : [{ key: 'reset', icon: 'refresh', action: 'reset', style: 'secondary', tip: 'Reset' }];
    const buttons: SheetButton[] = env.interactive
      ? [
          ...sw,
          { key: 'toggle', icon: t.running ? 'pause' : 'play', action: 'toggle', style: 'secondary', tip: t.running ? 'Pause' : 'Resume' },
          { key: 'stop', icon: 'x', action: 'stop', style: 'ghost', tip: 'Stop' },
        ]
      : [];
    return {
      key: 'timer',
      tone: t.running ? 'accent' : undefined,
      body: { k: 'actions', icon: this.iconName(), label: `${name} ${this.timeText(env.now)}`, sub: t.running ? what : 'Paused', buttons },
    };
  }

  /** Pointed at, a stopwatch with laps: its tile's card, then the laps, newest first. */
  sheet(env: SheetEnv): SheetView | null {
    const t = this.t;
    if (env.reason !== 'hover' || t?.mode !== 'stopwatch' || !t.laps.length) return null;
    const tile = this.tile(env);
    if (!tile) return null;
    const laps: SheetRow[] = t.laps.map((at, i) => ({ key: `lap${i + 1}`, title: `Lap ${i + 1}`, badge: lapClock(at - (t.laps[i - 1] ?? 0)) }));
    // The key the tile's own card has, so the first lap only adds the list under it.
    return { key: 'tile-card', blocks: [...tileCard(tile, 'Timer', 'timer'), { t: 'rows', key: 'laps', items: laps.reverse().slice(0, SHOWN_LAPS) }] };
  }

  render(env: RenderEnv): Seg[] {
    const t = this.t;
    if (!t) return [];
    const now = env.now;
    const tone = t.mode === 'focus' && t.phase === 'focus' ? 'bad' : t.mode === 'focus' ? 'good' : 'accent';
    const time: Seg = { t: 'text', key: 'time', text: this.timeText(now), weight: 'semibold', size: env.level === 'maximum' ? 'lg' : 'md', prio: 0 };

    if (t.doneAt) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'bell', tone: 'warn', anim: 'bob', prio: 0 },
        { t: 'text', key: 'label', text: t.mode === 'focus' ? (t.phase === 'focus' ? 'Focus done' : 'Break over') : `${t.label} done`, weight: 'semibold', prio: 0 },
      ];
      if (env.level === 'compact') return segs;
      if (t.mode === 'focus') {
        const next = t.phase === 'focus' ? 'break' : 'focus';
        segs.push(
          { t: 'button', key: 'next', label: next === 'break' ? 'Start break' : 'Next focus', action: 'next', style: 'primary', side: 'end', prio: 1 },
          { t: 'button', key: 'dismiss', icon: 'check', action: 'dismiss', style: 'secondary', side: 'end', prio: 1, tip: 'Dismiss' },
        );
      } else {
        segs.push(
          { t: 'button', key: 'snooze', label: '+1 min', action: 'add', arg: 60000, style: 'secondary', side: 'end', prio: 2 },
          { t: 'button', key: 'restart', icon: 'refresh', action: 'restart', style: 'ghost', side: 'end', prio: 3, tip: 'Again' },
          { t: 'button', key: 'dismiss', icon: 'check', label: 'Done', action: 'dismiss', style: 'primary', side: 'end', prio: 1 },
        );
      }
      return segs;
    }

    const icon: Seg = { t: 'icon', key: 'icon', icon: this.iconName(), tone, anim: t.running ? undefined : 'pulse', prio: 0 };
    if (env.level === 'compact' || env.level === 'idle') return [icon, { ...time, side: 'end' }];

    const label = t.mode === 'focus' ? `${t.label} · ${t.round}` : t.mode === 'stopwatch' && t.laps.length ? `Lap ${t.laps.length + 1}` : t.label;
    const segs: Seg[] = [icon, { t: 'text', key: 'label', text: label, tone: 'muted', prio: 4 }];
    if (t.mode !== 'stopwatch') {
      segs.push({ t: 'progress', key: 'bar', value: t.totalMs ? 1 - this.leftMs(now) / t.totalMs : 0, tone, w: env.level === 'maximum' ? 170 : 90, prio: 5, side: 'center' });
    }
    segs.push({ ...time, side: 'end' });
    if (env.level === 'maximum') {
      if (t.mode !== 'stopwatch') segs.push({ t: 'button', key: 'add', label: '+1m', action: 'add', arg: 60000, style: 'ghost', side: 'end', prio: 4 });
      else if (t.running) segs.push({ t: 'button', key: 'lap', label: 'Lap', action: 'lap', style: 'ghost', side: 'end', prio: 3 });
      else segs.push({ t: 'button', key: 'reset', label: 'Reset', action: 'reset', style: 'ghost', side: 'end', prio: 3 });
      segs.push(
        { t: 'button', key: 'toggle', icon: t.running ? 'pause' : 'play', action: 'toggle', style: 'secondary', side: 'end', prio: 1, tip: t.running ? 'Pause' : 'Resume' },
        { t: 'button', key: 'stop', icon: 'x', action: 'stop', style: 'ghost', side: 'end', prio: 2, tip: 'Stop' },
      );
    }
    return segs;
  }

  action(name: string, arg: unknown): void {
    const now = Date.now();
    switch (name) {
      case 'start':
        this.startTimer((Number(arg) || 5) * 60000, `${Number(arg) || 5} min timer`);
        return;
      case 'focus':
        this.startFocus(1, 'focus');
        return;
      case 'stopwatch':
        this.startStopwatch();
        return;
      case 'length': {
        // The dial's new total, in seconds (0 is allowed while setting it; Start ignores it).
        const n = Math.round(Number(arg));
        if (!Number.isFinite(n)) return;
        this.ctx.setOptions?.({ timerSeconds: Math.min(MAX_SECONDS, Math.max(0, n)) });
        this.ctx.update();
        return;
      }
      case 'start-secs': {
        // The dial sends its own length (0 on an empty dial starts nothing); without one, the saved length.
        const n = Math.min(MAX_SECONDS, Math.round(typeof arg === 'number' ? arg : this.timerSeconds()));
        if (n > 0) this.startTimer(n * 1000, `${shortLength(n)} timer`);
        return;
      }
    }
    const t = this.t;
    if (!t) return;
    switch (name) {
      case 'toggle':
        if (t.mode === 'stopwatch') {
          if (t.running) {
            t.bankedMs = this.elapsedMs(now);
            t.startedAt = null;
          } else t.startedAt = now;
        } else if (t.running) {
          t.remainingMs = this.leftMs(now);
          t.endsAt = null;
        } else t.endsAt = now + t.remainingMs;
        t.running = !t.running;
        break;
      case 'add': {
        const ms = Number(arg) || 60000;
        if (t.doneAt) {
          t.doneAt = null;
          t.running = true;
          t.endsAt = now + ms;
          t.totalMs = ms;
          t.remainingMs = ms;
        } else if (t.running && t.endsAt) {
          t.endsAt += ms;
          t.totalMs += ms;
        } else {
          t.remainingMs += ms;
          t.totalMs += ms;
        }
        break;
      }
      case 'lap':
        if (t.mode === 'stopwatch' && t.running) t.laps.push(this.elapsedMs(now));
        break;
      case 'reset':
        // Back to 0:00 with no laps; a running stopwatch keeps going from there.
        if (t.mode !== 'stopwatch') return;
        t.bankedMs = 0;
        t.startedAt = t.running ? now : null;
        t.laps = [];
        break;
      case 'restart':
        if (t.mode === 'focus') this.startFocus(t.round, t.phase);
        else this.startTimer(t.totalMs || 300000, t.label);
        return;
      case 'next':
        if (t.mode === 'focus') this.startFocus(t.phase === 'break' ? t.round + 1 : t.round, t.phase === 'focus' ? 'break' : 'focus');
        return;
      case 'stop':
      case 'dismiss':
        this.t = null;
        this.ctx.close();
        break;
    }
    this.ctx.update();
  }

  command(cmd: string, arg: unknown): unknown {
    if (cmd === 'start') this.startTimer((Number(arg) || 5) * 60000, `${Number(arg) || 5} min timer`);
    else if (cmd === 'focus') this.startFocus();
    else if (cmd === 'stopwatch') this.startStopwatch();
    return true;
  }
}
