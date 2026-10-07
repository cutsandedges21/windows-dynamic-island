// Display formatting. The first block is a straight port of Usage Clip's
// renderer/format.js (same outputs, same tests).

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const SESSION_WINDOW_MS = 5 * HOUR;
export const WEEK_WINDOW_MS = 7 * DAY;

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function resetsIn(resetsAt: number | null | undefined, now: number): string {
  if (!Number.isFinite(resetsAt)) return 'not started';
  const left = (resetsAt as number) - now;
  if (left <= 0) return 'resetting now';
  if (left < 60000) return 'resets in under a minute';
  return `resets in ${duration(left)}`;
}

export function resetsOn(resetsAt: number | null | undefined, now: number): string {
  if (!Number.isFinite(resetsAt)) return 'not started';
  if ((resetsAt as number) - now <= 0) return 'resetting now';
  const d = new Date(resetsAt as number);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `resets today ${time}`;
  return `resets ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

export function tokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 999500) return `${Math.round(v / 1000)}k`;
  if (v < 9.95e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v < 999.5e6) return `${Math.round(v / 1e6)}M`;
  return `${(v / 1e9).toFixed(1)}B`;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Fraction of the limit window already elapsed (where the white pace tick sits). */
export function pace(resetsAt: number | null | undefined, windowMs: number, now: number): number | null {
  if (!Number.isFinite(resetsAt)) return null;
  const start = (resetsAt as number) - windowMs;
  return Math.min(1, Math.max(0, (now - start) / windowMs));
}

export function sessionCount(sessions: Array<{ alive: boolean; needsYou?: boolean }>): { text: string; needs: number } {
  const running = sessions.filter((s) => s.alive).length;
  const needs = sessions.filter((s) => s.needsYou).length;
  const closed = sessions.length - running;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (!running && closed) parts.push(`${closed} closed`);
  return { text: parts.join(', '), needs };
}

// ------------------------------------------------------------------ Island extras

export function agoText(ms: number): string {
  const a = age(ms);
  return a === 'now' ? 'just now' : `${a} ago`;
}

/** 12m 43s style elapsed time for a running task. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** mm:ss or h:mm:ss for timers and media. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export function rate(bytesPerSec: number): string {
  return `${bytes(bytesPerSec)}/s`;
}

export function percent(frac: number): string {
  return `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "in 10m", "in 2h 5m", "now". */
export function until(ms: number): string {
  if (ms <= 30000) return 'now';
  return `in ${duration(ms)}`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Markdown as readable plain text for a small card: no heading marks, bold
 * stars, backticks, fences or link syntax; bullets become "•".
 */
export function plainText(md: string): string {
  return String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Last path segment of a folder, either slash direction. */
export function baseName(path: string): string {
  const parts = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || String(path || '');
}
