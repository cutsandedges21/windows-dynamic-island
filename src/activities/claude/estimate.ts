// Estimates for a chat's row in Claude's hover card: how full its context is, about how
// long until it fills at the pace it fills while Claude works, and about when the turn it
// is working on is done, from how long its recent turns took. Guesses, shown with a "~".

/** A gap this long between two replies is the user away, not Claude working. */
const IDLE_GAP_MS = 5 * 60_000;
/** Less work than this says too little about the pace. */
const MIN_WORK_MS = 2 * 60_000;
/** A turn longer than this was left waiting (a permission nobody answered), not worked on. */
const MAX_TURN_MS = 3 * 3600_000;
/** The last this many turns are the ones that say how long this chat's turns take. */
const RECENT_TURNS = 12;

/**
 * The context window of a chat on `model`, with `used` tokens in it. Claude Code does not write
 * the window down, so this goes by the model: the Claude 5 Opus, Sonnet and Fable models hold a
 * million tokens, Haiku and the older models 200k unless a chat is seen past that (the 1M option).
 */
export function contextWindow(model: string | null | undefined, used: number): number {
  const m = (model ?? '').toLowerCase();
  if (used > 200_000 || m.includes('[1m]') || /claude-(opus|sonnet|fable)-5/.test(m)) return 1_000_000;
  return 200_000;
}

export interface ContextFill {
  /** Tokens in the context after the newest reply. */
  used: number;
  window: number;
  /** used / window, 0..1. */
  share: number;
  /** Milliseconds of work until it is full at the pace it grew while working; null when unknown. */
  fullIn: number | null;
}

/** How full the context is, from the readings since the last compaction ([ts, tokens], oldest first). */
export function contextFill(model: string | null | undefined, ctx: Array<[number, number]>): ContextFill | null {
  const last = ctx[ctx.length - 1];
  if (!last) return null;
  const used = last[1];
  const window = contextWindow(model, used);
  // Growth over working time only: a night between two replies is not the chat filling slowly.
  let work = 0;
  let grown = 0;
  for (let i = 1; i < ctx.length; i++) {
    const dt = ctx[i][0] - ctx[i - 1][0];
    if (dt <= 0 || dt > IDLE_GAP_MS) continue;
    work += dt;
    grown += Math.max(0, ctx[i][1] - ctx[i - 1][1]);
  }
  const pace = work >= MIN_WORK_MS && grown > 0 ? grown / work : null;
  return { used, window, share: Math.min(1, used / window), fullIn: pace ? Math.max(0, window - used) / pace : null };
}

/**
 * About how long a turn that has run `elapsed` ms still needs: the middle of this chat's recent
 * turns that ran longer than that (a turn that is already long is probably one of the long ones).
 * null with fewer than two finished turns to go by; Infinity once it runs longer than all of them.
 */
export function turnLeft(turns: number[], elapsed: number): number | null {
  const recent = turns.filter((d) => d > 0 && d < MAX_TURN_MS).slice(-RECENT_TURNS);
  if (recent.length < 2) return null;
  const longer = recent.filter((d) => d > elapsed).sort((a, b) => a - b);
  if (!longer.length) return Infinity;
  const n = longer.length;
  const mid = n % 2 ? longer[(n - 1) / 2] : (longer[n / 2 - 1] + longer[n / 2]) / 2;
  return mid - elapsed;
}

/** "<1 min", "~3 min", "~2 h"; null past two days, where a guess means nothing. */
export function about(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return '<1 min';
  if (ms < 3600_000) return `~${Math.round(ms / 60_000)} min`;
  if (ms <= 48 * 3600_000) return `~${Math.round(ms / 3600_000)} h`;
  return null;
}
