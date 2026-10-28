// Script errors and rejected promises nobody caught go to island.log, so a window that
// breaks on someone's PC leaves a line saying where. Each error is logged once a minute
// and a run logs at most 30, so an error thrown on every frame can't fill the log.

const SAME_MS = 60_000;
const MAX_LINES = 30;
const MAX_TEXT = 300;

/** What an ErrorEvent or a PromiseRejectionEvent carries, as far as a log line needs. */
export interface ErrorParts {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
  reason?: unknown;
}

function described(value: unknown): string {
  if (value instanceof Error) return (value.stack?.split('\n')[0] ?? '').trim() || `${value.name}: ${value.message}`;
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

/** One line: the message, and where it was thrown when the browser says. */
export function errorText(e: ErrorParts): string {
  let text = 'reason' in e ? described(e.reason) : e.message || described(e.error);
  if (!text) text = 'unknown error';
  if (e.filename) {
    const file = e.filename.split(/[\\/]/).pop() ?? e.filename;
    text += ` (${file}:${e.lineno ?? 0}:${e.colno ?? 0})`;
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** `log(kind, text)` writes `<window>: <kind>: <text>` through `write`, within the limits above. */
export function errorLogger(window: string, write: (line: string) => void, now: () => number = Date.now): (kind: string, text: string) => void {
  const last = new Map<string, number>();
  let lines = 0;
  return (kind, text) => {
    if (lines >= MAX_LINES) return;
    const key = `${kind}\n${text}`;
    const at = now();
    const seen = last.get(key);
    if (seen !== undefined && at - seen < SAME_MS) return;
    last.set(key, at);
    lines++;
    write(lines === MAX_LINES ? `${window}: js errors: more than ${MAX_LINES}, the rest are not logged` : `${window}: ${kind}: ${text}`);
  };
}

/** Logs this window's uncaught errors and unhandled rejections. */
export function catchErrors(window: string, write: (line: string) => void): void {
  const log = errorLogger(window, write);
  addEventListener('error', (e) => log('js error', errorText(e)));
  addEventListener('unhandledrejection', (e) => log('unhandled rejection', errorText({ reason: e.reason })));
}
