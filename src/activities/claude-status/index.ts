// Claude Status: every Claude session at a glance, the way the Claude Sessions
// widget showed them: Claude Code, the Claude app and Chrome, with background
// shells on purple rows of their own (under their session, which keeps its own
// colour), unread dots and progress bars for long runs. The engine
// (engine.ts) works it all out inside Island; this file draws it and switches
// to a session when one is clicked.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../../core/activity';
import { native } from '../../core/native';
import type { Seg, Tone } from '../../core/segments';
import type { Block, SheetRow, SheetView, Tile } from '../../core/sheet';
import { BaseActivity } from '../base';
import { StatusEngine, type StatusRow, type StatusState } from './engine';

export type { StatusRow, StatusState } from './engine';

const POLL_MS = 1000;
const SHOW_MS = 4000;
/** Auto model's state is read from Claude Code's settings.json: no need to every second. */
const AUTO_POLL_MS = 5000;

/** The widget's colours, in the island's tones. */
export function toneOf(row: StatusRow): Tone {
  if (row.grey) return 'dim';
  return ({ running: 'info', shell: 'purple', input: 'warn', done: 'good', failed: 'bad', idle: 'dim' } as const)[row.state] ?? 'dim';
}

/** The progress bar's colour: purple for a shell, Claude's own for a run. */
function barTone(row: StatusRow): Tone {
  return row.state === 'shell' ? 'purple' : 'claude';
}

/**
 * "4m", like the widget's fmt_age, but never seconds: the island rolls every
 * text change, so a ticking seconds count would roll every second.
 */
export function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return '';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class ClaudeStatusActivity extends BaseActivity {
  private rows: StatusRow[] = [];
  private engine: StatusEngine | null = null;
  private busy = false;
  /**
   * Auto model (src-tauri/src/auto_model.rs): the router that warns before a prompt runs on the
   * wrong model, and the model check that reviews a chat when it compacts, passes 500k tokens or
   * ends. Installed from Activities › Claude Status; once it is, the card's header has a button
   * that pauses both.
   */
  private auto = { installed: false, on: true };
  private last = new Map<string, StatusState>();
  /** A session just finished (green), failed or was stopped (red), or needs you (orange): the island glows that colour for a moment. */
  private flash: { tone: Tone; until: number } | null = null;

  constructor() {
    super('claudeStatus');
  }

  protected async init(): Promise<void> {
    const env = await native.claudeEnv();
    if (!env || !this.alive) return;
    this.engine = new StatusEngine(env.configDir, (...p) => this.ctx.log(...p));
    await this.engine.importWidget(env.configDir);
    this.every(POLL_MS, () => void this.poll(), true);
    this.every(AUTO_POLL_MS, () => void this.pollAuto(), true);
  }

  /** Whether Auto model is installed (Activities) and paused (the card's button). */
  private async pollAuto(): Promise<void> {
    const s = await native.autoModel();
    if (!this.alive || (s.installed === this.auto.installed && s.on === this.auto.on)) return;
    this.auto = { installed: s.installed, on: s.on };
    this.ctx.update();
  }

  private async poll(): Promise<void> {
    if (!this.engine || this.busy) return;
    this.busy = true;
    let rows: StatusRow[];
    try {
      rows = await this.engine.poll();
    } catch (err) {
      this.ctx.log('poll error', String(err));
      return;
    } finally {
      this.busy = false;
    }
    if (!this.alive) return;

    // A session that just finished pops the island for a moment; one waiting on
    // you holds it open instead (status().urgent).
    const opts = this.ctx.options<{ showDone?: boolean }>();
    // A background shell has its own row, so a turn that ends with a server still running is still "done".
    for (const r of rows) {
      const st = r.state;
      const before = this.last.get(r.id);
      // Stopping one yourself (Esc) is no news: it only turns red, and glows red a moment.
      if (before && before !== st && r.stopped) this.glow('bad');
      if (before && before !== st && !r.stopped && (st === 'input' || st === 'done' || st === 'failed')) {
        if (opts.showDone !== false && st !== 'input') this.ctx.surface({ key: `${r.id}:${st}`, ms: SHOW_MS, level: 'expanded' });
        this.glow(st === 'done' ? 'good' : st === 'failed' ? 'bad' : 'warn');
        this.saw(st === 'done' ? 'claude-done' : st === 'failed' ? 'claude-error' : 'claude-asks', `claudeStatus:${r.id}`);
      }
    }
    this.last = new Map(rows.map((r) => [r.id, r.state]));

    const sig = (x: StatusRow[]) => JSON.stringify(x);
    if (sig(rows) !== sig(this.rows)) {
      this.rows = rows;
      this.ctx.update();
    }
  }

  private glow(tone: Tone): void {
    this.flash = { tone, until: Date.now() + SHOW_MS };
    this.later(SHOW_MS + 50, () => this.ctx.update());
  }

  /** Waiting on you: a question, or a turn that failed (not one you stopped yourself). */
  private waiting(): StatusRow[] {
    return this.rows.filter((r) => !r.grey && !r.stopped && (r.state === 'input' || r.state === 'failed'));
  }

  /** Sessions, not rows: a shell's own row belongs to its session. */
  private sessions(): number {
    return new Set(this.rows.map((r) => r.parent ?? r.id)).size;
  }

  /** The row the pill talks about: the widget's own order (running first). */
  private top(): StatusRow | null {
    // The engine sorts orange and red first.
    return this.rows[0] ?? null;
  }

  status(): ActivityStatus {
    if (!this.rows.length) return { active: false };
    const running = this.rows.some((r) => !r.grey && r.state === 'running');
    const shell = this.rows.some((r) => !r.grey && r.state === 'shell');
    const waiting = this.waiting().length;
    // Red, stopped too, puts Claude Status ahead of quieter activities like orange does.
    const red = this.rows.some((r) => !r.grey && r.state === 'failed');
    const barRow = this.rows.find((r) => r.progress);
    const bar = barRow?.progress;
    // Orange (a permission or a question) holds the island open, Quiet or not, from
    // any window, until it is answered or tapped away. A new one opens it again.
    const asking = this.rows.filter((r) => !r.grey && r.state === 'input');
    return {
      active: true,
      weight: running || shell || waiting || red ? 'foreground' : 'background',
      urgent: asking.length ? { key: asking.map((r) => `${r.id}@${r.since}`).join(','), level: 'expanded' } : null,
      summary: waiting ? `${waiting} awaiting you` : `${this.sessions()} Claude session${this.sessions() === 1 ? '' : 's'}`,
      // Just finished, failed or stopped, or asking: the island glows that colour all round for a moment.
      beam: this.flash && Date.now() < this.flash.until
        ? { tone: this.flash.tone, motion: 'still' }
        : waiting
          ? { tone: 'warn', motion: 'pulse' }
          : bar && barRow
            ? { tone: barRow.state === 'shell' ? 'purple' : 'info', motion: 'progress', value: bar.value }
            : running
              ? { tone: 'info', motion: 'orbit' }
              : null,
      // Running, the blue light stays on round the pill whatever is in front (unless switched off).
      beamBehind: running && this.ctx.options<{ glowInFront?: boolean }>().glowInFront !== false ? { tone: 'info', motion: 'orbit' } : null,
    };
  }

  chip(): ChipView | null {
    const t = this.top();
    if (!t) return null;
    return { icon: 'claude', label: String(this.sessions()), dot: toneOf(t), pulse: t.state === 'running' && !t.grey };
  }

  render(env: RenderEnv): Seg[] {
    const t = this.top();
    if (!t) return [];
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const segs: Seg[] = [{ t: 'icon', key: 'mark', icon: 'claude', tone: 'claude', prio: 0 }];
    if (env.vertical) {
      segs.push({ t: 'dot', key: 'dot', tone: toneOf(t), pulse: t.state === 'running' && !t.grey, badge: this.rows.some((r) => r.unread), prio: 0 });
      return segs;
    }
    // At rest it is only the dots, like the widget's compact mode; the name
    // shows when the island grows (hover, click, or a session finishing).
    const resting = !roomy && !env.hover && !env.open && !env.surfaced;
    const dots = this.rows.slice(0, 8);
    // A pink corner dot, like the widget's: that session has an answer you haven't read.
    dots.forEach((r, i) => segs.push({ t: 'dot', key: `d:${r.id}`, tone: toneOf(r), pulse: r.state === 'running' && !r.grey, badge: r.unread, prio: i ? 4 : 0, tip: `${r.label} · ${r.where}` }));
    if (resting) return segs;
    segs.push({ t: 'text', key: 'label', text: t.label, weight: 'semibold', prio: 1, max: roomy ? 220 : 140 });
    if (roomy && t.progress) segs.push({ t: 'progress', key: 'bar', value: t.progress.value, tone: barTone(t), w: 70, side: 'end', prio: 3 });
    segs.push({
      t: 'text',
      key: 'state',
      text: t.progress && roomy ? t.progress.text : [t.word, age(env.now / 1000 - t.since)].filter(Boolean).join(' '),
      tone: t.grey ? 'muted' : toneOf(t),
      size: 'sm',
      side: 'end',
      prio: 2,
    });
    return segs;
  }

  /** withBars: the card's rows carry their progress bar inline (the grid's tile stays plain). */
  private sheetRows(now: number, withBars = false): SheetRow[] {
    return this.rows.map((r) => ({
      key: r.id,
      dot: toneOf(r),
      pulse: r.state === 'running' && !r.grey,
      unread: r.unread,
      title: r.label,
      detail: `${r.where} · ${[r.word, age(now / 1000 - r.since)].filter(Boolean).join(' ')}${r.hidden ? ' · hidden' : ''}`,
      bar: withBars && r.progress ? { value: r.progress.value, text: r.progress.text, label: r.progress.method, tone: barTone(r) } : undefined,
      action: 'jump',
      arg: r.id,
      tip: `${r.label} · ${r.where}`,
      button: { key: 'dismiss', icon: 'x', action: 'dismiss', arg: r.id, style: 'ghost', tip: 'Dismiss until it changes' },
    }));
  }

  sheet(env: SheetEnv): SheetView | null {
    if (!this.rows.length) return null;
    const waiting = this.waiting().length;
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: 'claude',
        tone: 'claude',
        title: 'Claude',
        sub: waiting ? `${waiting} awaiting you` : `${this.sessions()} session${this.sessions() === 1 ? '' : 's'}`,
        // Only once Auto model is installed (Activities › Claude Status); "Show Auto model button" there hides it.
        buttons: !this.auto.installed || this.ctx.options<{ showAutoModel?: boolean }>().showAutoModel === false ? [] : [
          {
            key: 'router',
            label: this.auto.on ? 'Auto model: on' : 'Auto model: off',
            action: 'router',
            style: this.auto.on ? 'secondary' : 'ghost',
            tip: this.auto.on
              ? 'Warns you before a prompt runs on a far too strong or too weak Claude model, and checks a chat when it compacts, passes 500k tokens or ends: was it on the right model. Click to pause.'
              : 'Paused: Claude runs every prompt on the model you picked, with no checks. Click to turn back on.',
          },
        ],
      },
    ];
    // Each row carries its progress bar on its second line, after "Terminal · running 6m".
    blocks.push({ t: 'rows', key: 'rows', items: this.sheetRows(env.now, true) });
    // Pointing at it, a chat finishing or one waiting on you: the card grows out of the pill when
    // Claude Status grows into a card (its Grows), else it hangs under the pill (grow.ts hoverView, chatView).
    return { key: 'claudeStatus', blocks };
  }

  tile(env: SheetEnv): Tile | null {
    if (!this.rows.length) return null;
    return {
      key: 'claudeStatus',
      span: 2,
      rows: 2,
      tone: 'claude',
      body: { k: 'list', icon: 'claude', label: 'Claude sessions', rows: this.sheetRows(env.now), empty: 'All quiet' },
    };
  }

  async action(name: string, arg: unknown): Promise<void> {
    if (name === 'router') {
      this.auto = { ...this.auto, on: await native.setRouter(!this.auto.on) };
      this.ctx.update();
      return;
    }
    if (!this.engine || typeof arg !== 'string') return;
    if (name === 'dismiss') {
      this.engine.dismiss(arg);
      this.rows = this.rows.filter((r) => r.id !== arg);
      this.ctx.update();
      return;
    }
    if (name === 'jump' && !(await this.engine.jump(arg))) this.ctx.alert('shake');
  }
}
