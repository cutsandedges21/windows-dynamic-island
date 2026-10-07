// Plan limits and weekly tokens, ported from Usage Clip's usage.js and tokens.js.
//
// Limits come from GET api.anthropic.com/api/oauth/usage (Rust makes the call
// with Claude Code's own token). 20 s is the fastest pace the endpoint sustains
// (measured 2026-09-28: 10 s apart → 429 + 5 min lockout); the client only polls
// when local activity could have moved the numbers (else once a minute), widens
// its interval after a 429, and returns to 20 s after 2 quiet hours. When Usage
// Clip is running it polls the same endpoint, so a fresh Usage Clip reading is
// reused instead of spending a call.

import { native } from '../../core/native';

const BASE_INTERVAL_MS = 20000;
const MAX_INTERVAL_MS = 120000;
const IDLE_REFRESH_MS = 60000;
const RELAX_AFTER_MS = 2 * 3600000;
const EXPIRED_RECHECK_MS = 30000;
const RATE_LIMIT_MIN_WAIT_MS = 60000;
const MAX_BACKOFF_MS = 30 * 60000;
const STATUSLINE_MAX_AGE_MS = 15 * 60000;
const SHARED_FRESH_MS = 25000;
const CACHE_KEY = 'island:claude-usage';

export interface LimitWindow {
  pct: number;
  resetsAt: number | null;
}
export interface UsageData {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  models: Array<{ name: string; pct: number; resetsAt: number | null }>;
}
export interface UsageState {
  data: UsageData | null;
  error: string | null;
  message?: string | null;
  source: 'api' | 'cache' | 'statusline' | 'usage-clip' | null;
  fetchedAt: number | null;
  retryAt?: number;
}

export function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    if (/^\d+(\.\d+)?$/.test(value)) return toMs(Number(value));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function pct(v: unknown): number | null {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? Math.max(0, n) : null;
}

function windowOf(obj: unknown): LimitWindow | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const utilization = pct(o.utilization ?? o.used_percentage);
  if (utilization == null) return null;
  return { pct: utilization, resetsAt: toMs(o.resets_at) };
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Normalize the API response: 5-hour, weekly, and model-scoped weekly limits. */
export function parseUsage(data: unknown): UsageData {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const out: UsageData = { fiveHour: windowOf(d.five_hour), sevenDay: windowOf(d.seven_day), models: [] };
  const seen = new Set<string>();
  if (Array.isArray(d.limits)) {
    for (const limit of d.limits as Array<Record<string, unknown>>) {
      const name = (limit?.scope as { model?: { display_name?: string } } | undefined)?.model?.display_name;
      if (typeof name !== 'string' || !name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.models.push({ name, pct: pct(limit.percent ?? limit.utilization) ?? 0, resetsAt: toMs(limit.resets_at) });
    }
  }
  for (const [key, value] of Object.entries(d)) {
    const m = /^seven_day_(.+)$/.exec(key);
    if (!m || m[1] === 'oauth_apps' || m[1] === 'cowork') continue;
    const w = windowOf(value);
    if (!w) continue;
    const name = titleCase(m[1]);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.models.push({ name, ...w });
  }
  return out;
}

/** usage-state.json from a statusLine hook: { rate_limits: { five_hour, seven_day } } or the bare object. */
export function parseStatusLine(raw: unknown): UsageData | null {
  const r = raw as Record<string, unknown> | null;
  const limits = (r && (r.rate_limits || r)) as Record<string, unknown> | null;
  if (!limits) return null;
  const parsed: UsageData = { fiveHour: windowOf(limits.five_hour), sevenDay: windowOf(limits.seven_day), models: [] };
  return parsed.fiveHour || parsed.sevenDay ? parsed : null;
}

export interface UsageDeps {
  configDir: string;
  usageClipCache: string | null;
  getVersion: () => string | null;
  getActivity: () => string;
  now?: () => number;
}

export class UsageClient {
  state: UsageState = { data: null, error: null, source: null, fetchedAt: null };
  failures = 0;
  nextAt = 0;
  interval = BASE_INTERVAL_MS;
  last429At = 0;
  lastSuccessAt = 0;
  private lastActivity: string | undefined;
  private inFlight = false;
  private readonly now: () => number;

  constructor(private readonly deps: UsageDeps) {
    this.now = deps.now ?? (() => Date.now());
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
      if (saved) {
        if (saved.data && this.now() - saved.fetchedAt < 6 * 3600000) this.state = { data: saved.data, error: null, source: 'cache', fetchedAt: saved.fetchedAt };
        if (Number.isFinite(saved.interval)) this.interval = Math.min(Math.max(saved.interval, BASE_INTERVAL_MS), MAX_INTERVAL_MS);
        if (Number.isFinite(saved.last429At)) this.last429At = saved.last429At;
      }
    } catch {
      /* first run */
    }
  }

  private save(): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: this.state.data, fetchedAt: this.state.fetchedAt, interval: this.interval, last429At: this.last429At }));
    } catch {
      /* best effort */
    }
  }

  due(): boolean {
    const now = this.now();
    if (now < this.nextAt) return false;
    if (this.lastSuccessAt === 0) return true;
    if (this.deps.getActivity() !== this.lastActivity) return true;
    return now - this.lastSuccessAt >= IDLE_REFRESH_MS;
  }

  rateLimited(): boolean {
    return this.state.error === 'rate_limited' && this.now() < this.nextAt;
  }

  /** Poll if due (or forced, unless that would extend a 429 lockout). */
  async maybePoll(force = false): Promise<boolean> {
    if (this.inFlight) return false;
    if (force ? this.rateLimited() : !this.due()) return false;
    this.inFlight = true;
    try {
      await this.poll();
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  /** A Usage Clip reading newer than ours and under 25 s old saves an API call. */
  private async shared(): Promise<UsageData | null> {
    if (!this.deps.usageClipCache) return null;
    const text = await native.readText(this.deps.usageClipCache, 64 * 1024);
    if (!text) return null;
    try {
      const c = JSON.parse(text);
      const fetchedAt = Number(c?.fetchedAt);
      if (!c?.data || !Number.isFinite(fetchedAt) || this.now() - fetchedAt > SHARED_FRESH_MS) return null;
      if (this.state.fetchedAt && fetchedAt <= this.state.fetchedAt) return null;
      this.state = { data: c.data, error: null, message: null, source: 'usage-clip', fetchedAt };
      return c.data;
    } catch {
      return null;
    }
  }

  async poll(): Promise<UsageState> {
    if (await this.shared()) {
      const now = this.now();
      this.nextAt = now + this.interval;
      this.lastSuccessAt = now;
      this.lastActivity = this.deps.getActivity();
      this.save();
      return this.state;
    }
    const res = await native.usageFetch(this.deps.getVersion());
    if (res.noToken) return this.fail('no_token', 'Sign in to Claude Code to see limits', BASE_INTERVAL_MS);
    if (res.status === 0) return this.fail('network', 'Offline, retrying', this.backoff());
    if (res.status === 401) return this.fail('expired', 'Use Claude Code once to refresh it', EXPIRED_RECHECK_MS);
    if (res.status === 429) {
      this.last429At = this.now();
      this.interval = Math.min(this.interval * 2, MAX_INTERVAL_MS);
      const retry = Number(res.retryAfter);
      const wait = Number.isFinite(retry) && retry > 0 ? Math.max(retry * 1000, this.interval) : Math.max(RATE_LIMIT_MIN_WAIT_MS, this.backoff());
      const st = await this.fail('rate_limited', 'Limits paused by the API', wait);
      this.save();
      return st;
    }
    if (res.status < 200 || res.status >= 300) return this.fail('http', `Usage API error ${res.status}`, this.backoff());
    if (!res.body) return this.fail('http', 'Unreadable usage response', this.backoff());
    const now = this.now();
    this.failures = 0;
    if (this.interval > BASE_INTERVAL_MS && now - this.last429At > RELAX_AFTER_MS) this.interval = BASE_INTERVAL_MS;
    this.nextAt = now + this.interval;
    this.lastSuccessAt = now;
    this.lastActivity = this.deps.getActivity();
    this.state = { data: parseUsage(res.body), error: null, message: null, source: 'api', fetchedAt: now };
    this.save();
    return this.state;
  }

  backoff(): number {
    this.failures += 1;
    return Math.min(BASE_INTERVAL_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
  }

  private async statusLine(): Promise<UsageData | null> {
    const file = `${this.deps.configDir}\\usage-state.json`;
    const [st] = await native.statMany([file]);
    if (!st || this.now() - st.mtimeMs > STATUSLINE_MAX_AGE_MS) return null;
    const text = await native.readText(file, 256 * 1024);
    try {
      return text ? parseStatusLine(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }

  private async fail(error: string, message: string, waitMs: number): Promise<UsageState> {
    this.nextAt = this.now() + waitMs;
    const fallback = await this.statusLine();
    // Keep the last good numbers on screen; the error shows as a note.
    this.state = {
      data: fallback || this.state.data || null,
      error,
      message,
      retryAt: this.nextAt,
      source: fallback ? 'statusline' : this.state.source,
      fetchedAt: this.state.fetchedAt,
    };
    return this.state;
  }
}

// ------------------------------------------------------------------ weekly tokens

const DAY_MS = 86400000;
const MAX_FILE_AGE_MS = 8 * DAY_MS;

interface TokenEntry {
  ts: number;
  input: number;
  cacheCreation: number;
  output: number;
  cacheRead: number;
}

/**
 * Weekly token totals from every transcript under projects/ (subagent files
 * included). One API response is written as several lines sharing one usage
 * block, so entries are deduped by message.id + requestId (max per field).
 */
export class WeeklyTokens {
  private files = new Map<string, number>(); // path -> offset
  readonly entries = new Map<string, TokenEntry>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly projectsDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  scan(): Promise<void> {
    if (!this.running) this.running = this.doScan().finally(() => (this.running = null));
    return this.running;
  }

  private async doScan(): Promise<void> {
    const list = await native.listFiles(this.projectsDir, true, '.jsonl', MAX_FILE_AGE_MS);
    for (const f of list) {
      let offset = this.files.get(f.path) ?? 0;
      if (f.size < offset) offset = 0;
      if (f.size > offset) {
        const r = await native.usageEntries(f.path, offset);
        if (r) {
          for (const e of r.entries) this.absorb(e[0], e[1], e[2], e[3], e[4], e[5]);
          offset = r.consumed;
        }
      }
      this.files.set(f.path, offset);
    }
    const cutoff = this.now() - MAX_FILE_AGE_MS;
    for (const [key, e] of this.entries) if (e.ts < cutoff) this.entries.delete(key);
  }

  absorb(key: string, ts: number, input: number, cacheCreation: number, output: number, cacheRead: number): void {
    const prev = this.entries.get(key);
    if (prev) {
      prev.ts = Math.min(prev.ts, ts);
      prev.input = Math.max(prev.input, input);
      prev.cacheCreation = Math.max(prev.cacheCreation, cacheCreation);
      prev.output = Math.max(prev.output, output);
      prev.cacheRead = Math.max(prev.cacheRead, cacheRead);
    } else {
      this.entries.set(key, { ts, input, cacheCreation, output, cacheRead });
    }
  }

  /** fresh = input + cache creation + output; cached = cache reads. */
  totals(windowStartMs: number): { fresh: number; cached: number; output: number } {
    let fresh = 0;
    let cached = 0;
    let output = 0;
    for (const e of this.entries.values()) {
      if (e.ts < windowStartMs) continue;
      fresh += e.input + e.cacheCreation + e.output;
      cached += e.cacheRead;
      output += e.output;
    }
    return { fresh, cached, output };
  }
}

/** Start of the weekly window: seven_day.resets_at - 7 days, else rolling 7 days. */
export function weekWindowStart(resetsAtMs: number | null | undefined, now = Date.now()): number {
  if (resetsAtMs != null && Number.isFinite(resetsAtMs) && resetsAtMs > now - 7 * DAY_MS) return resetsAtMs - 7 * DAY_MS;
  return now - 7 * DAY_MS;
}
