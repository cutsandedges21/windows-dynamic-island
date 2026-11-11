// How far along a run is, the way the Claude Sessions widget guessed it: from
// Claude's task list when there is one, else from how long your past runs took.
// Times are in seconds, like the widget's.

/** Starting guesses for long runs, blended with your own history as it builds up. */
export const CODE_PRIOR = [150, 210, 270, 330]; // Claude Code: ~3-5 min
export const CHAT_PRIOR = [80, 110, 140, 170]; // app/Chrome replies: ~1.5-2.5 min

/** A run gets a bar once it passes a minute. */
export const BAR_AFTER = 60;
/** Only commands that usually take this long get a bar. */
export const SHELL_BAR_MIN = 15;

/**
 * Expected [fraction done, seconds left] for a run that has lasted `elapsed`,
 * from how much longer past runs went once they had lasted that long. Past
 * every sample, assume ~25% more (at least a minute).
 */
export function estimate(samples: number[], elapsed: number): [number, number] {
  const longer = samples.filter((d) => d > elapsed).sort((a, b) => a - b);
  const total = longer.length ? longer[Math.floor(longer.length / 2)] : elapsed + Math.max(60, 0.25 * elapsed);
  return [elapsed / total, total - elapsed];
}

export function fmtLeft(seconds: number): string {
  if (seconds < 45) return 'almost done';
  return `~${Math.round(seconds / 60)} min left`;
}

/** What makes two commands the same for timing: no leading cd, nothing piped after it, no redirections. */
export function shellKey(cmd: string): string {
  let c = (cmd || '').replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
  c = c.split(/(?<!\|)\|(?!\|)/)[0];
  c = c.replace(/\s*\d?>&\d|\s*\d?>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  return c.split(/\s+/).filter(Boolean).join(' ').slice(0, 160);
}

/** The command inside the Bash tool's wrapper: eval '...' < /dev/null. */
export function bashCommand(line: string): string {
  const m = /eval '((?:[^']|'\\'')*)' < \/dev\/null/.exec(line || '');
  return m ? m[1].replace(/'\\''/g, "'") : '';
}

/** Past durations of this command, else of commands that start the same way. */
export function shellSamples(times: Record<string, number[]>, cmd: string): number[] {
  const key = shellKey(cmd);
  if (!key) return [];
  if (times[key]) return times[key];
  const head = key.split(' ').slice(0, 3).join(' ');
  return Object.entries(times)
    .filter(([k]) => k.split(' ').slice(0, 3).join(' ') === head)
    .flatMap(([, v]) => v);
}
