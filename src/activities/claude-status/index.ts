// Claude Status's look: every Claude session at a glance, the way the Claude Sessions widget
// showed them: Claude Code, the Claude app and Chrome, with background shells on purple rows
// of their own (under their session, which keeps its own colour), unread dots and progress
// bars for long runs. The engine (engine.ts) works the rows out inside Island; these helpers
// draw them on the pill, the card and the Control Center tile. Since Claude Code and Claude
// Status became one activity, the Claude activity (src/activities/claude) owns the engine and
// draws with these.

import type { RenderEnv } from '../../core/activity';
import type { Seg, Tone } from '../../core/segments';
import type { SheetButton, SheetRow } from '../../core/sheet';
import type { StatusRow } from './engine';

export { StatusEngine, type StatusRow, type StatusState } from './engine';

/** A finished, failed or waiting session shows (and glows) this long. */
export const SHOW_MS = 4000;

/** The widget's colours, in the island's tones. */
export function toneOf(row: StatusRow): Tone {
  if (row.grey) return 'dim';
  return ({ running: 'info', shell: 'purple', input: 'warn', done: 'good', failed: 'bad', idle: 'dim' } as const)[row.state] ?? 'dim';
}

/** The progress bar's colour: purple for a shell, Claude's own for a run. */
export function barTone(row: StatusRow): Tone {
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

/** Waiting on you: a question, or a turn that failed (not one you stopped yourself). */
export function waitingRows(rows: StatusRow[]): StatusRow[] {
  return rows.filter((r) => !r.grey && !r.stopped && (r.state === 'input' || r.state === 'failed'));
}

/** Sessions, not rows: a shell's own row belongs to its session. */
export function sessionCount(rows: StatusRow[]): number {
  return new Set(rows.map((r) => r.parent ?? r.id)).size;
}

/** "2 awaiting you", else "3 sessions". */
export function statusSub(rows: StatusRow[]): string {
  const waiting = waitingRows(rows).length;
  const n = sessionCount(rows);
  return waiting ? `${waiting} awaiting you` : `${n} session${n === 1 ? '' : 's'}`;
}

/**
 * The pill: the Claude mark and a dot per session (a pink corner dot for an answer not read
 * yet), like the widget's compact mode; the name and state when the island grows. `focus`: the
 * row the pill talks about (a session that just finished), else the first (orange and red sort first).
 */
export function statusSegments(rows: StatusRow[], env: RenderEnv, focus?: string | null): Seg[] {
  const t = rows.find((r) => r.id === focus) ?? rows[0];
  if (!t) return [];
  const roomy = env.level === 'expanded' || env.level === 'maximum';
  const segs: Seg[] = [{ t: 'icon', key: 'mark', icon: 'claude', tone: 'claude', prio: 0 }];
  if (env.vertical) {
    segs.push({ t: 'dot', key: 'dot', tone: toneOf(t), pulse: t.state === 'running' && !t.grey, badge: rows.some((r) => r.unread), prio: 0 });
    return segs;
  }
  // At rest it is only the dots; the name shows when the island grows (hover, click, or a session finishing).
  const resting = !roomy && !env.hover && !env.open && !env.surfaced;
  rows.slice(0, 8).forEach((r, i) => segs.push({ t: 'dot', key: `d:${r.id}`, tone: toneOf(r), pulse: r.state === 'running' && !r.grey, badge: r.unread, prio: i ? 4 : 0, tip: `${r.label} · ${r.where}` }));
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

/**
 * The session rows of the card and the tile. withBars: each carries its progress bar on its
 * second line, after "Terminal · running 6m" (the grid's tile stays plain). `slot`: a Claude
 * Code session's Alt+Shift number, as a badge.
 */
export function statusRows(rows: StatusRow[], now: number, withBars = false, slot: (id: string) => number | null = () => null): SheetRow[] {
  return rows.map((r) => {
    const n = slot(r.id);
    const dismiss: SheetButton = { key: 'dismiss', icon: 'x', action: 'dismiss', arg: r.id, style: 'ghost', tip: 'Dismiss until it changes' };
    return {
      key: r.id,
      dot: toneOf(r),
      pulse: r.state === 'running' && !r.grey,
      unread: r.unread,
      title: r.label,
      detail: `${r.where} · ${[r.word, age(now / 1000 - r.since)].filter(Boolean).join(' ')}${r.hidden ? ' · hidden' : ''}`,
      bar: withBars && r.progress ? { value: r.progress.value, text: r.progress.text, label: r.progress.method, tone: barTone(r) } : undefined,
      badge: n ? String(n) : undefined,
      action: 'jump',
      arg: r.id,
      tip: `${r.label} · ${r.where}${n ? ` (Alt+Shift+${n})` : ''}`,
      button: dismiss,
    };
  });
}
