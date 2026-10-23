// Small words and numbers the phone shows. No DOM.

const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2:14 PM", "yesterday 2:14 PM", "Tuesday 2:14 PM", "Oct 20, 2:14 PM"; "just now" under a minute. */
export function lastSeenText(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return 'not seen yet';
  if (now - at < 60_000 && now >= at) return 'just now';
  const d = new Date(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return time(d);
  if (days === 1) return `yesterday ${time(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${time(d)}`;
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time(d)}`;
}

/** "Trying again in 8 s", or "Trying again…" when the try is due. */
export function retryText(retryAt: number, now: number): string {
  const s = Math.ceil((retryAt - now) / 1000);
  return s > 0 ? `Trying again in ${s} s` : 'Trying again…';
}

/** "840 KB", "2.3 MB". */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The text as a web link to open, if it is one (http or https only). */
export function linkIn(text: string): string | null {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
