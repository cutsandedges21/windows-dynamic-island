// What a Claude Code session is doing, folded from its transcript the way the
// Claude Sessions widget's hook.py folded hook events: when the run started,
// Claude's task list (for the progress bar), and the shell commands it ran
// (to name and time the shell processes found under Claude). Seconds, like the widget.

import { native, type WorkEvent } from '../../core/native';

/** Claude's task list: total, done, when the last step finished (the widget's prog). */
export interface Prog {
  total: number;
  done: number;
  /** Steps already done when this run started: time per step counts from here. */
  baseDone?: number;
  lastDoneAt?: number;
  doneIds?: string[];
  deletedIds?: string[];
  /** Workflow agents instead of a task list. */
  kind?: 'workflow';
  countStart?: number;
}

/** A shell command Claude ran: "task" once it went to the background, "end" once a foreground one returned. */
export interface ShellCall {
  id: string;
  cmd: string;
  desc: string;
  at: number;
  task?: string;
  end?: number;
}

export interface Work {
  runStarted: number | null;
  /** When the last turn ended (Claude Code's turn_duration line, what the Stop hook saw). */
  stoppedAt: number | null;
  prog: Prog | null;
  shells: ShellCall[];
}

const KEEP_CALLS = 12;

export function emptyWork(): Work {
  return { runStarted: null, stoppedAt: null, prog: null, shells: [] };
}

/** hook.py's update_progress and track_shells, one transcript event at a time. */
export function fold(w: Work, ev: WorkEvent): void {
  const at = ev.at / 1000;
  const prog: Prog = w.prog ?? { total: 0, done: 0 };
  switch (ev.k) {
    case 'prompt': {
      w.runStarted = at;
      if (w.prog && w.prog.total && w.prog.done >= w.prog.total) {
        w.prog = null; // the last list finished: start fresh
      } else if (w.prog) {
        w.prog.lastDoneAt = at; // time per step restarts this run
        w.prog.baseDone = w.prog.done;
      }
      return;
    }
    case 'stop':
      w.stoppedAt = at;
      return;
    case 'todo':
      if (ev.done > prog.done) prog.lastDoneAt = at;
      prog.total = ev.total;
      prog.done = ev.done;
      w.prog = prog;
      return;
    case 'taskCreate':
      prog.total += 1;
      w.prog = prog;
      return;
    case 'taskUpdate': {
      const done = new Set(prog.doneIds ?? []);
      const deleted = new Set(prog.deletedIds ?? []);
      if (ev.status === 'completed' && !done.has(ev.id)) {
        done.add(ev.id);
        prog.lastDoneAt = at;
      } else if (ev.status === 'deleted' && !deleted.has(ev.id)) {
        deleted.add(ev.id);
        done.delete(ev.id);
        prog.total = Math.max(0, prog.total - 1);
      }
      prog.doneIds = [...done].sort();
      prog.deletedIds = [...deleted].sort();
      prog.done = done.size;
      w.prog = prog;
      return;
    }
    case 'shell':
      w.shells = [...w.shells, { id: ev.id, cmd: ev.cmd, desc: ev.desc, at }].slice(-KEEP_CALLS);
      return;
    case 'result': {
      const c = w.shells.find((x) => x.id === ev.id);
      if (!c || c.end != null || c.task != null) return;
      if (ev.task) c.task = ev.task;
      else c.end = at;
      return;
    }
  }
}

/** Reads one transcript's new lines each time and keeps its Work up to date. */
export class WorkReader {
  private files = new Map<string, { offset: number; work: Work }>();

  async read(path: string | null): Promise<Work> {
    if (!path) return emptyWork();
    let f = this.files.get(path);
    if (!f) this.files.set(path, (f = { offset: 0, work: emptyWork() }));
    const open = f.work.shells.filter((c) => c.end == null && c.task == null).map((c) => c.id);
    const scan = await native.transcriptWork(path, f.offset, open);
    if (scan) {
      if (scan.consumed < f.offset) f.work = emptyWork(); // rewritten from the start
      for (const ev of scan.events) fold(f.work, ev);
      f.offset = scan.consumed;
    }
    return f.work;
  }

  prune(keep: Set<string>): void {
    for (const p of [...this.files.keys()]) if (!keep.has(p)) this.files.delete(p);
  }
}
