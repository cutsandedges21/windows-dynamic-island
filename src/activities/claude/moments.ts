// One pop-up per moment. A Claude Code chat finishing or needing you is reported several
// ways: its hooks (Stop, PermissionRequest, a Notification), the session list noticing it
// (the tracker's events), and the session rows changing colour (Claude Status's engine).
// Whichever comes first pops the island and glows; the rest find the moment already told.
// A chat's next turn makes its moments news again.

/** 'end': a turn finished, well or on an error. 'needs': the chat waits on you. */
export type MomentKind = 'end' | 'needs';

export class MomentGate {
  /** `${session}|${kind}` → when it was told. */
  private readonly told = new Map<string, number>();
  /**
   * Sessions whose prompt was answered or handed back to the chat: the session list may go on
   * saying they wait (a beat behind, or until the user answers in the chat), which is no new moment.
   */
  private readonly settled = new Set<string>();

  /**
   * True the first time this moment is reported: pop up for it. `polled`: it comes from the
   * session list, not a hook, so a prompt already answered or handed back is not news.
   */
  allow(sid: string, kind: MomentKind, now: number, polled = false): boolean {
    if (!sid) return false;
    if (polled && kind === 'needs' && this.settled.has(sid)) return false;
    const key = `${sid}|${kind}`;
    if (this.told.has(key)) return false;
    this.told.set(key, now);
    if (this.told.size > 400) for (const [k, t] of this.told) if (now - t > 24 * 3600_000) this.told.delete(k);
    return true;
  }

  /** Whether this moment was already told (and not made news again since). */
  has(sid: string, kind: MomentKind): boolean {
    return this.told.has(`${sid}|${kind}`);
  }

  /**
   * The chat started a turn at `startedAt` (a prompt, or a run seen starting then): what it
   * said before is old. A start no later than a moment is that moment's own turn, seen late.
   */
  ran(sid: string, startedAt: number): void {
    for (const kind of ['end', 'needs'] as const) {
      const key = `${sid}|${kind}`;
      const at = this.told.get(key);
      if (at !== undefined && startedAt > at) this.told.delete(key);
    }
  }

  /** Its prompt was answered (here, on the phone or in the chat) or handed back: the next prompt is news, the polled old one is not. */
  answered(sid: string): void {
    this.told.delete(`${sid}|needs`);
    this.settled.add(sid);
  }

  /** The session list says it no longer waits: from now on, its saying so again is news. */
  stopped(sid: string): void {
    this.settled.delete(sid);
  }

  /** A prompt that was answered or handed back, which the session list still shows waiting. */
  settling(sid: string): boolean {
    return this.settled.has(sid);
  }
}
