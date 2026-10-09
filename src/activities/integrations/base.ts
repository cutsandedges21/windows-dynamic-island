// The shared half of every integration activity (GitHub, Vercel, Stripe, Notion, n8n,
// Cal.com, Resend). While the activity runs, which is while it is enabled, it asks
// `integration_poll` for a snapshot on a schedule, waits longer after failures, compares each
// snapshot with the last one and surfaces what changed, and draws the pill, the chip and the
// service's tile in the open island. A service only says what its snapshot means: how to
// compare two of them, what to show at a glance, and what its tile holds.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../../core/activity';
import { bridge, type PollReply } from '../../core/bridge';
import { clip } from '../../core/format';
import { native } from '../../core/native';
import type { Seg } from '../../core/segments';
import type { Tile, TileBody } from '../../core/sheet';
import { BaseActivity } from '../base';
import { noticeMs, pickChange, retryDelay, safeUrl, type Change, type Failure, type Glance } from './util';

export interface IntegrationSpec {
  /** The Credential Manager name of the key; catalog.ts has the same string. */
  secret: string;
  /** Poll interval while all is well, ms. */
  everyMs: number;
  /** The service's own page, opened when nothing more specific applies. */
  home: string;
}

/** A tile without its key: the activity's id is the key. */
export type TileContent = Omit<Tile, 'key'>;

/** The word on a tile whose poll failed. */
const FAILURE_WORD: Record<string, string> = { auth: 'Key refused', limit: 'Rate limited', network: 'Offline', http: 'Error', demo: 'Preview' };

export abstract class IntegrationActivity<S extends object> extends BaseActivity {
  protected snapshot: S | null = null;
  protected failure: Failure | null = null;
  /** Null until the first poll answers. */
  private keySaved: boolean | null = null;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private again = false;
  /** The poll options the snapshot was taken with: new options start a new baseline. */
  private snapshotOptions = '';
  private notice: { change: Change; until: number } | null = null;
  private readonly seen = new Set<string>();

  protected constructor(id: string, protected readonly spec: IntegrationSpec) {
    super(id);
  }

  // ---------------------------------------------------------------- what a service provides

  /** What changed between two snapshots. Pure; the first snapshot is never compared. */
  protected abstract compare(prev: S, next: S, now: number): Change[];
  /** The service in one line, for the pill when the user keeps it on the island. */
  protected abstract headline(snapshot: S, now: number): Glance | null;
  /** The service's cell in the open island's grid. */
  protected abstract tileFor(snapshot: S, now: number): TileContent;
  /** The non-secret settings the poller needs. */
  protected pollOptions(): Record<string, unknown> {
    return {};
  }
  /** Hosts a link may use over plain http: the user's own server. */
  protected origin(): string | undefined {
    return undefined;
  }
  /** The page an Open button goes to when nothing more specific applies. (Not called home: that name is the island's hook for idle buttons.) */
  protected landing(): string {
    return this.spec.home;
  }
  /** What to show with no news. Services whose glance depends on the clock (Cal.com) replace this. */
  protected glance(now: number): Glance | null {
    return this.snapshot ? this.headline(this.snapshot, now) : null;
  }

  // ---------------------------------------------------------------- polling

  protected init(): void {
    // The Activities page saves keys in another window; it tells this one.
    this.listen<{ name?: string }>('secret-changed', (p) => {
      if (p?.name === this.spec.secret) this.refresh();
    });
    this.schedule(0);
  }

  protected override dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reconfigure(): void {
    this.refresh();
  }

  /** Polls now and forgets earlier failures. */
  protected refresh(): void {
    this.failures = 0;
    if (this.polling) this.again = true;
    else this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), ms);
  }

  private async cycle(): Promise<void> {
    this.timer = null;
    if (!this.alive || this.polling) return;
    this.polling = true;
    let delay = this.spec.everyMs;
    try {
      const options = this.pollOptions();
      const reply: PollReply = await bridge.integrationPoll(this.meta.id, options);
      if (!this.alive) return;
      delay = reply.ok ? this.accept(reply as unknown as S, JSON.stringify(options)) : this.reject(reply);
    } catch (err) {
      this.ctx.log('poll crashed', String(err));
    } finally {
      this.polling = false;
      if (this.alive) {
        this.ctx.update();
        this.schedule(this.again ? 0 : delay);
      }
      this.again = false;
    }
  }

  private accept(next: S, optionsKey: string): number {
    const prev = this.snapshot;
    const comparable = prev !== null && optionsKey === this.snapshotOptions;
    this.snapshot = next;
    this.snapshotOptions = optionsKey;
    this.keySaved = true;
    this.failure = null;
    this.failures = 0;
    if (comparable) this.announce(this.compare(prev, next, Date.now()));
    return this.spec.everyMs;
  }

  private reject(reply: { code: string; error: string; retryAfter?: number | null }): number {
    this.failures += 1;
    this.failure = { code: reply.code, error: reply.error, retryAfter: reply.retryAfter };
    this.keySaved = reply.code !== 'no-key';
    if (reply.code === 'no-key') {
      this.snapshot = null;
      this.notice = null;
    }
    return retryDelay(this.spec.everyMs, this.failure, this.failures);
  }

  // ---------------------------------------------------------------- news

  /** Surfaces the most important of the changes that have not been shown before. */
  protected announce(changes: Change[]): void {
    const fresh = changes.filter((c) => !this.seen.has(c.key));
    if (!fresh.length) return;
    for (const c of fresh) this.seen.add(c.key);
    if (this.seen.size > 300) {
      const recent = [...this.seen].slice(-100);
      this.seen.clear();
      for (const k of recent) this.seen.add(k);
    }
    const picked = pickChange(fresh);
    if (!picked) return;
    const change = picked.more ? { ...picked.top, detail: [picked.top.detail, `+${picked.more} more`].filter(Boolean).join(' · ') } : picked.top;
    const ms = noticeMs(change);
    this.notice = { change, until: Date.now() + ms };
    const loud = change.tone === 'bad' || change.tone === 'warn';
    this.ctx.surface({ key: change.key, ms, level: change.level ?? (loud ? 'expanded' : 'compact') });
    if (change.tone === 'bad') this.ctx.alert('shake');
    if (loud) this.ctx.alert('glow', change.tone);
    // The bot reacts by how it went; a payment coming in gets its own coin.
    const reaction = change.key.startsWith('stripe:') && change.key.endsWith(':paid') ? 'payment' : change.tone === 'good' ? 'good-news' : change.tone === 'bad' ? 'bad-news' : change.tone === 'warn' ? 'warning' : 'info';
    this.saw(reaction, `${this.meta.id}:${change.key}`);
    this.ctx.update();
  }

  private liveNotice(now: number): Change | null {
    return this.notice && now < this.notice.until ? this.notice.change : null;
  }

  /** The news, or, when the user keeps this activity on the island, the service at a glance. */
  private view(now: number): { glance: Glance; news: boolean } | null {
    const news = this.liveNotice(now);
    if (news) return { glance: news, news: true };
    const quiet = this.ctx.config().persistent ? this.glance(now) : null;
    return quiet ? { glance: quiet, news: false } : null;
  }

  // ---------------------------------------------------------------- the activity contract

  status(): ActivityStatus {
    const v = this.view(Date.now());
    if (!v) return { active: false };
    const { title, detail } = v.glance;
    return { active: true, weight: v.news ? 'foreground' : 'background', summary: clip(detail ? `${title} · ${detail}` : title, 60) };
  }

  chip(env: RenderEnv): ChipView | null {
    const v = this.view(env.now);
    return v ? { icon: v.glance.icon, label: clip(v.glance.title, 18), tone: v.glance.tone } : null;
  }

  render(env: RenderEnv): Seg[] {
    const v = this.view(env.now);
    if (!v) return [];
    const g = v.glance;
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: g.icon, tone: g.tone, anim: v.news && g.tone === 'bad' ? 'pulse' : undefined, prio: 0 },
      { t: 'text', key: 'title', text: g.title, weight: 'semibold', prio: 1, min: 60, max: roomy ? undefined : 170 },
    ];
    if (!roomy) return segs;
    if (g.detail && !env.vertical) segs.push({ t: 'text', key: 'detail', text: g.detail, tone: 'muted', prio: 4, min: 50 });
    const cta = g.cta ?? { icon: 'external', label: 'Open' };
    segs.push({
      t: 'button',
      key: 'open',
      icon: cta.icon,
      label: env.level === 'maximum' && !env.vertical ? cta.label : undefined,
      action: 'open',
      arg: safeUrl(g.url, this.origin()) ?? this.landing(),
      style: 'secondary',
      side: 'end',
      prio: 2,
      tip: `${cta.label} in ${this.meta.name}`,
    });
    return segs;
  }

  action(name: string, arg: unknown): void {
    if (name === 'open') {
      void native.openUrl(safeUrl(arg, this.origin()) ?? this.landing());
      this.ctx.close();
    } else if (name === 'refresh') this.refresh();
  }

  // ---------------------------------------------------------------- the tile

  tile(_env: SheetEnv): Tile | null {
    const now = Date.now();
    const meta = this.meta;
    const make = (content: TileContent): Tile => ({ key: meta.id, ...content });
    const stat = (value: string, sub: string, tone: Tile['tone'], action: string, arg?: unknown): Tile =>
      make({ tone, action, arg, body: { k: 'stat', icon: meta.icon, label: meta.name, value, sub } satisfies TileBody });
    // No key (or a setting it needs): the tile says so, and a tap opens the Activities page.
    const setup = (value: string, sub: string) => stat(value, sub, 'muted', 'island:app', 'activities');

    if (this.keySaved === false) return setup('Add key', 'Tap to set it up');
    if (this.failure?.code === 'config') return setup('Set up', this.failure.error);
    if (this.failure?.code === 'auth') return stat(FAILURE_WORD.auth, this.failure.error, 'bad', 'island:app', 'activities');
    if (!this.snapshot) {
      return this.failure ? stat(FAILURE_WORD[this.failure.code] ?? 'Error', this.failure.error, 'warn', 'refresh') : stat('…', 'Loading', 'muted', 'refresh');
    }
    return make(this.tileFor(this.snapshot, now));
  }
}
