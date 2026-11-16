// Games: while one runs (Steam, or a store's games folder), the pill shows its
// frame rate and ping, even at its smallest. The native watcher (game.rs) does
// the detecting and measuring; this reads its numbers once a second. Frame
// rate needs a one-time Windows permission (Performance Log Users), asked from
// here; RivaTuner's numbers are used without it when RivaTuner runs.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { rate } from '../core/format';
import { native, type GameState, type NetSample, type SysSample } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { Block, SheetButton, SheetView, Tile } from '../core/sheet';
import type { StripItem, StripStyle, StripView } from '../core/strip';
import { BaseActivity } from './base';

interface Options {
  showPing: boolean;
  overGames: boolean;
  /** In a full-screen game: the island, or a slim strip along the top. */
  display: 'island' | 'strip';
  stripStyle: StripStyle;
}

/** "Sent to Game Bar" stays this long. */
const FLASH_MS = 2500;

const pct = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);

/** The strip's numbers, left to right: frame rate, CPU, GPU, RAM, ping, network down and up, the time. */
export function stripItems(g: GameState, sys: SysSample | null, net: NetSample | null, ping: number | null, now: number): StripItem[] {
  const items: StripItem[] = [{ key: 'fps', label: 'FPS', value: fpsText(g.fps) }];
  if (sys) {
    items.push({ key: 'cpu', label: 'CPU', value: pct(sys.cpu) });
    if (sys.gpu != null) items.push({ key: 'gpu', label: 'GPU', value: pct(sys.gpu) });
    if (sys.memTotal > 0) items.push({ key: 'ram', label: 'RAM', value: pct((sys.memUsed / sys.memTotal) * 100) });
  }
  if (ping != null) items.push({ key: 'ping', label: 'Ping', value: `${ping} ms` });
  if (net) items.push({ key: 'down', label: '↓', value: rate(net.rxBps) }, { key: 'up', label: '↑', value: rate(net.txBps) });
  items.push({ key: 'time', value: new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) });
  return items;
}

/** When the user last ran the one-time setup (it needs a sign-out to take effect). */
const SETUP_KEY = 'island.game.setupAt';

/** Ping coloured the way games do it. */
export function pingTone(ms: number | null | undefined): Tone {
  if (ms == null) return 'muted';
  return ms < 60 ? 'good' : ms < 120 ? 'warn' : 'bad';
}

export function fpsText(fps: number | null | undefined): string {
  return fps == null || !Number.isFinite(fps) ? '—' : String(Math.round(fps));
}

export class GameActivity extends BaseActivity {
  state: GameState | null = null;
  private note: string | null = null;
  /** CPU, GPU and RAM, and the network's speed, read while a game runs (the card and the strip). */
  private sys: SysSample | null = null;
  private net: NetSample | null = null;
  private micMuted: boolean | null = null;
  private flash: { text: string; until: number } | null = null;

  constructor() {
    super('game');
  }

  private opts(): Options {
    const o = this.ctx.options<Partial<Options>>();
    const style = o.stripStyle === 'glass' || o.stripStyle === 'bare' ? o.stripStyle : 'black';
    return { showPing: o.showPing !== false, overGames: o.overGames !== false, display: o.display === 'strip' ? 'strip' : 'island', stripStyle: style };
  }

  protected init(): void {
    if (native.demo) {
      this.state = { game: { name: 'Hades II', appId: 1145350, pid: 1, source: 'steam' }, fps: 143.6, fpsSource: 'frames', fpsNeedsSetup: false, ping: 24, pingTarget: '155.133.248.34', pingKind: 'server' };
      return;
    }
    this.every(1000, () => void this.poll(), true);
  }

  private async poll(): Promise<void> {
    const next = await native.gameState();
    const was = this.state?.game?.name ?? null;
    this.state = next;
    if (next?.game) {
      // Every second poll: these are for a glance, and cost a little to read.
      if (!this.sys || Date.now() % 2000 < 1000) {
        const [sys, net, audio] = await Promise.all([native.sysSample?.(false) ?? null, native.netSample?.() ?? null, native.audioState?.() ?? null]);
        if (!this.alive) return;
        this.sys = sys;
        this.net = net;
        this.micMuted = audio?.micMuted ?? null;
      }
    } else {
      this.sys = null;
      this.net = null;
    }
    const now = next?.game?.name ?? null;
    if (now && now !== was) {
      this.ctx.surface({ key: `game:${now}`, ms: 4000, level: 'expanded' });
      this.saw('game-start', `game:${now}`);
    }
    if (now || was) this.ctx.update();
  }

  private setupDone(): boolean {
    try {
      return Boolean(localStorage.getItem(SETUP_KEY));
    } catch {
      return false;
    }
  }

  private ping(): number | null {
    return this.opts().showPing ? (this.state?.ping ?? null) : null;
  }

  private pingTip(): string {
    const s = this.state;
    if (!s?.ping) return "No answer from the game's server";
    return s.pingKind === 'server' ? `Round trip to the game's server (${s.pingTarget})` : "Internet latency (1.1.1.1): the game's server does not answer pings";
  }

  /** A game running: the bot plays along. */
  override pet(): PetSignal {
    return { mood: this.state?.game ? 'gaming' : null, moment: this.petMoment };
  }

  status(): ActivityStatus {
    const g = this.state?.game;
    if (!g) return { active: false };
    return {
      active: true,
      weight: 'foreground',
      summary: `${g.name}${this.state?.fps != null ? ` · ${fpsText(this.state.fps)} FPS` : ''}`,
      // Set to a strip, the pill leaves a full-screen game to it.
      overFullscreen: this.opts().overGames && this.opts().display === 'island',
    };
  }

  chip(): ChipView | null {
    const s = this.state;
    if (!s?.game) return null;
    return { icon: 'gamepad', label: `${fpsText(s.fps)} FPS`, tone: 'good' };
  }

  render(env: RenderEnv): Seg[] {
    const s = this.state;
    const g = s?.game;
    if (!s || !g) return [];
    const ping = this.ping();
    if (env.vertical) {
      const segs: Seg[] = [
        { t: 'text', key: 'fps', text: fpsText(s.fps), weight: 'bold', prio: 0 },
        { t: 'text', key: 'fps-unit', text: 'FPS', tone: 'muted', size: 'xs', prio: 1 },
      ];
      if (ping != null) segs.push({ t: 'text', key: 'ping', text: String(ping), tone: pingTone(ping), weight: 'semibold', prio: 2, tip: this.pingTip() }, { t: 'text', key: 'ping-unit', text: 'ms', tone: 'muted', size: 'xs', prio: 3 });
      return segs;
    }
    const segs: Seg[] = [];
    if (env.level === 'expanded' || env.level === 'maximum') {
      segs.push({ t: 'icon', key: 'pad', icon: 'gamepad', tone: 'good', prio: 3 }, { t: 'text', key: 'name', text: g.name, weight: 'semibold', prio: 5, max: env.level === 'maximum' ? 260 : 170 });
    }
    segs.push(
      { t: 'text', key: 'fps', text: fpsText(s.fps), weight: 'bold', prio: 0, side: env.level === 'compact' || env.level === 'idle' ? 'center' : 'end', tip: s.fpsSource === 'rivatuner' ? 'Frame rate from RivaTuner' : 'Frames per second' },
      { t: 'text', key: 'fps-unit', text: 'FPS', tone: 'muted', size: 'sm', prio: 1, side: env.level === 'compact' || env.level === 'idle' ? 'center' : 'end' },
    );
    if (ping != null) {
      const side = env.level === 'compact' || env.level === 'idle' ? 'center' : 'end';
      segs.push({ t: 'sep', key: 'sep', prio: 4, side }, { t: 'text', key: 'ping', text: `${ping} ms`, tone: pingTone(ping), weight: 'semibold', prio: 1, side, tip: this.pingTip() });
    }
    if (env.level === 'maximum' && s.fpsNeedsSetup) {
      segs.push({ t: 'button', key: 'setup', icon: 'settings', label: this.setupDone() ? 'Sign out to finish' : 'Turn on FPS', action: 'setup', style: 'primary', side: 'end', prio: 2 });
    }
    return segs;
  }

  /** Hover: the numbers with what they mean, and the one-time setup when frames are not counted yet. */
  sheet(env: SheetEnv): SheetView | null {
    const s = this.state;
    const g = s?.game;
    if (!s || !g || env.reason === 'urgent') return null;
    const blocks: Block[] = [
      { t: 'head', key: 'h', icon: 'gamepad', tone: 'good', title: g.name, sub: g.source === 'steam' ? 'Steam' : 'Game' },
      {
        t: 'stats',
        key: 'numbers',
        items: [
          { key: 'fps', label: s.fpsSource === 'rivatuner' ? 'FPS (RivaTuner)' : 'FPS', value: fpsText(s.fps) },
          { key: 'ping', label: s.pingKind === 'internet' ? 'Ping (internet)' : 'Ping', value: s.ping != null ? `${s.ping} ms` : '—', tone: pingTone(s.ping), tip: this.pingTip() },
          ...this.sysStats(),
        ],
      },
    ];
    if (env.reason === 'open') {
      blocks[0] = { ...blocks[0], buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost', tip: 'Control Center' }] } as Block;
      if (env.interactive) blocks.push({ t: 'buttons', key: 'bar', align: 'fill', items: this.barButtons(env.now) });
      const flash = this.flash && env.now < this.flash.until ? this.flash.text : null;
      if (flash) blocks.push({ t: 'text', key: 'flash', text: flash, size: 'sm', tone: 'muted' });
    }
    if (s.fpsNeedsSetup) {
      const done = this.setupDone();
      blocks.push(
        {
          t: 'text',
          key: 'why',
          size: 'sm',
          tone: 'muted',
          text: done
            ? 'Almost there: sign out of Windows and back in, and FPS shows up.'
            : 'Windows only shares frame timing with apps you allow. One click adds you to "Performance Log Users" (Windows asks first), then sign out and back in.',
        },
        { t: 'buttons', key: 'b', items: [{ key: 'setup', label: done ? 'Run setup again' : 'Turn on FPS', icon: 'settings', action: 'setup', style: done ? 'ghost' : 'primary' }] },
      );
    }
    if (this.note) blocks.push({ t: 'text', key: 'note', text: this.note, size: 'sm' });
    return { key: 'game', blocks };
  }

  /** CPU, GPU and RAM for the card, once they have been read. */
  private sysStats(): Array<{ key: string; label: string; value: string }> {
    const y = this.sys;
    if (!y) return [];
    const out = [{ key: 'cpu', label: 'CPU', value: pct(y.cpu) }];
    if (y.gpu != null) out.push({ key: 'gpu', label: 'GPU', value: pct(y.gpu) });
    if (y.memTotal > 0) out.push({ key: 'ram', label: 'RAM', value: pct((y.memUsed / y.memTotal) * 100) });
    return out;
  }

  /** Game mode's buttons: Xbox Game Bar's own shortcuts, and the microphone. */
  private barButtons(_now: number): SheetButton[] {
    const items: SheetButton[] = [
      { key: 'shot', icon: 'screenshot', label: 'Screenshot', action: 'bar', arg: 'screenshot', style: 'secondary', tip: 'A screenshot of the game (Win+Alt+PrtScn)' },
      { key: 'clip', icon: 'download', label: 'Last 30 s', action: 'bar', arg: 'clip', style: 'secondary', tip: 'Save the last 30 seconds as a clip (Win+Alt+G)' },
      { key: 'rec', icon: 'record', label: 'Record', action: 'bar', arg: 'record', style: 'secondary', tip: 'Start or stop recording (Win+Alt+R)' },
    ];
    if (this.micMuted != null) items.push({ key: 'mic', icon: this.micMuted ? 'mic-off' : 'mic', label: this.micMuted ? 'Unmute' : 'Mute', action: 'mic', style: this.micMuted ? 'danger' : 'secondary', tip: this.micMuted ? 'Turn the microphone back on' : 'Mute the microphone everywhere' });
    return items;
  }

  /** Over a full-screen game, when set to a strip: the numbers along the top in place of the island. */
  strip(now: number): StripView | null {
    const s = this.state;
    const o = this.opts();
    if (!s?.game || o.display !== 'strip') return null;
    return { style: o.stripStyle, items: stripItems(s, this.sys, this.net, this.ping(), now) };
  }

  tile(_env: SheetEnv): Tile | null {
    const s = this.state;
    const g = s?.game;
    if (!s || !g) return null;
    const ping = this.ping();
    return {
      key: 'game',
      span: 2,
      tone: 'good',
      action: 'card',
      tip: this.pingTip(),
      body: { k: 'stat', icon: 'gamepad', label: g.name, value: `${fpsText(s.fps)} FPS`, sub: ping != null ? `${ping} ms ping${s.pingKind === 'internet' ? ' (internet)' : ''}` : s.fpsNeedsSetup ? 'Hover the pill to turn on FPS' : 'Ping —' },
    };
  }

  async action(name: string, arg?: unknown): Promise<void> {
    if (name === 'card') {
      this.ctx.openCard?.();
      return;
    }
    if (name === 'bar') {
      const what = arg === 'screenshot' || arg === 'clip' || arg === 'record' ? arg : null;
      if (!what || !this.state?.game) return;
      const ok = await native.gameBar(what);
      if (!this.alive) return;
      const said = { screenshot: 'Screenshot asked from Game Bar', clip: 'Last 30 seconds asked from Game Bar', record: 'Recording switched in Game Bar' }[what];
      this.flash = { text: ok ? said : "Windows didn't take the keys", until: Date.now() + FLASH_MS };
      this.later(FLASH_MS + 50, () => this.ctx.update());
      this.ctx.update();
      return;
    }
    if (name === 'mic') {
      if (this.micMuted == null) return;
      const want = !this.micMuted;
      if (await native.micSetMute(want)) this.micMuted = want;
      if (this.alive) this.ctx.update();
      return;
    }
    if (name !== 'setup') return;
    const r = await native.gameFpsSetup();
    if (r.ok) {
      try {
        localStorage.setItem(SETUP_KEY, String(Date.now()));
      } catch {
        /* the message below still says what to do */
      }
    }
    this.note = r.message;
    this.ctx.log('fps setup', { ok: r.ok });
    this.ctx.surface({ key: 'game-setup', ms: 10_000, level: 'expanded' });
    this.ctx.update();
  }
}
