// Other apps: whatever a script or program sends through the activity API
// (`island-hook.exe activity`, JSON on stdin). See docs/ACTIVITY-API.md.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { hasIcon } from '../core/icons';
import { native } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { SheetRow, Tile } from '../core/sheet';
import { BaseActivity } from './base';

const MAX_ITEMS = 10;
const MAX_MS = 24 * 3600 * 1000;
const TONES: ReadonlySet<string> = new Set(['default', 'muted', 'dim', 'accent', 'claude', 'good', 'warn', 'bad', 'info', 'violet']);
/** Links the island will open: https anywhere, http only for localhost. */
const SAFE_URL = /^(?:https:\/\/\S+|http:\/\/localhost(?::\d+)?(?:[/?#]\S*)?)$/i;

type Item = {
  id: string;
  title: string;
  text: string;
  icon: string;
  tone: Tone | undefined;
  /** undefined: no bar, null: indeterminate, number: 0 to 1. */
  progress: number | null | undefined;
  url: string | null;
  urgent: boolean;
  /** Bumps when the title or text change, so a dismissed alert can come back for new news. */
  rev: number;
  at: number;
  expiresAt: number | null;
};

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : undefined);

/** null is an indeterminate bar, a number is clamped to 0..1, anything else keeps the old value. */
function readProgress(v: unknown, fallback: number | null | undefined): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  return fallback;
}

export class ExternalActivity extends BaseActivity {
  /** Oldest first: every update re-inserts its item, so the last one is the most recent. */
  private readonly items = new Map<string, Item>();
  private readonly dismissed = new Set<string>();

  constructor() {
    super('external');
  }

  protected init(): void {
    this.listen<Record<string, unknown>>('external-activity', (p) => this.ingest(p));
    this.every(1000, () => this.sweep());
  }

  private ingest(p: Record<string, unknown>): void {
    if (!p || typeof p !== 'object') return;
    const id = str(typeof p.id === 'number' ? String(p.id) : p.id, 80);
    if (!id) return;
    if (p.state === 'end') {
      if (this.items.delete(id)) this.ctx.update();
      return;
    }

    // Fields a sender leaves out keep their last value, so `{"id":"x","progress":0.5}` is a valid update.
    const now = Date.now();
    const prev = this.items.get(id);
    const title = str(p.title, 80) || prev?.title || id;
    const text = p.text === undefined ? (prev?.text ?? '') : (str(p.text, 160) ?? '');
    const changed = !prev || prev.title !== title || prev.text !== text;
    const url = p.url === undefined ? (prev?.url ?? null) : typeof p.url === 'string' && SAFE_URL.test(p.url.trim()) ? p.url.trim() : null;
    const ms = typeof p.ms === 'number' && Number.isFinite(p.ms) && p.ms > 0 ? Math.min(p.ms, MAX_MS) : null;

    const item: Item = {
      id,
      title,
      text,
      icon: p.icon === undefined ? (prev?.icon ?? 'stack') : typeof p.icon === 'string' && hasIcon(p.icon) ? p.icon : 'stack',
      tone: p.tone === undefined ? prev?.tone : typeof p.tone === 'string' && TONES.has(p.tone) ? (p.tone as Tone) : undefined,
      progress: readProgress(p.progress, prev?.progress),
      url,
      urgent: p.urgent === undefined ? (prev?.urgent ?? false) : p.urgent === true,
      rev: (prev?.rev ?? 0) + (changed ? 1 : 0),
      at: now,
      expiresAt: ms !== null ? now + ms : (prev?.expiresAt ?? null),
    };
    this.items.delete(id);
    this.items.set(id, item);
    while (this.items.size > MAX_ITEMS) this.items.delete(this.items.keys().next().value as string);

    if (changed) {
      this.ctx.surface({ key: `ext:${id}`, ms: 3500, level: 'expanded' });
      // Island's own update notice is news for the bot; anything else reacts by its tone.
      const tone = item.tone ?? 'info';
      this.saw(id === 'island-update' ? 'updated' : tone === 'good' ? 'good-news' : tone === 'bad' ? 'bad-news' : tone === 'warn' ? 'warning' : 'info', `external:${id}`);
      if (item.urgent) {
        this.ctx.alert('shake');
        this.ctx.alert('glow', item.tone ?? 'warn');
      }
    }
    this.ctx.update();
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, it] of this.items) {
      if (it.expiresAt !== null && now >= it.expiresAt) {
        this.items.delete(id);
        changed = true;
      }
    }
    if (changed) this.ctx.update();
  }

  private latest(): Item | null {
    let last: Item | null = null;
    for (const it of this.items.values()) last = it;
    return last;
  }

  private urgentKey(it: Item): string {
    return `ext:${it.id}:${it.rev}`;
  }

  dismiss(key: string): void {
    if (this.dismissed.size > 50) this.dismissed.clear();
    this.dismissed.add(key);
  }

  status(): ActivityStatus {
    const top = this.latest();
    if (!top) return { active: false };
    const list = [...this.items.values()].reverse();
    const urgent = list.find((i) => i.urgent && !this.dismissed.has(this.urgentKey(i)));
    const running = list.some((i) => i.progress !== undefined);
    return {
      active: true,
      weight: urgent || running || Date.now() - top.at < 15000 ? 'foreground' : 'background',
      urgent: urgent ? { key: this.urgentKey(urgent), level: 'expanded' } : null,
      summary: clip(top.text ? `${top.title}: ${top.text}` : top.title, 60),
    };
  }

  chip(): ChipView | null {
    const it = this.latest();
    return it ? { icon: it.icon, label: it.title, tone: it.tone } : null;
  }

  /** One row per app that has sent something, newest first; a row with a link opens it. */
  tile(env: SheetEnv): Tile | null {
    const list = [...this.items.values()].reverse();
    if (!list.length) return null;
    const row = (it: Item): SheetRow => ({
      key: it.id,
      icon: it.icon,
      tone: it.tone,
      title: it.title,
      detail: it.text || undefined,
      badge: typeof it.progress === 'number' ? `${Math.round(it.progress * 100)}%` : undefined,
      action: env.interactive && it.url ? 'open' : undefined,
      arg: it.id,
      tip: env.interactive && it.url ? 'Open link' : undefined,
    });
    const rows = list.length <= 3 ? list.map(row) : [...list.slice(0, 2).map(row), { key: '+more', title: `+${list.length - 2} more` }];
    return { key: 'other', rows: rows.length > 1 ? 2 : 1, body: { k: 'list', icon: 'stack', label: 'Other apps', rows } };
  }

  render(env: RenderEnv): Seg[] {
    const it = this.latest();
    if (!it) return [];
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: it.icon, tone: it.tone ?? 'accent', anim: it.urgent ? 'pulse' : undefined, prio: 0 },
      { t: 'text', key: 'title', text: it.title, weight: 'semibold', prio: 1, min: 60 },
    ];
    if (env.level === 'compact' || env.level === 'idle') {
      if (typeof it.progress === 'number') segs.push({ t: 'text', key: 'pct', text: `${Math.round(it.progress * 100)}%`, tone: 'muted', side: 'end', prio: 0 });
      return segs;
    }

    if (it.text && !env.vertical) segs.push({ t: 'text', key: 'text', text: it.text, tone: 'muted', prio: 4, min: 50 });
    if (it.progress !== undefined) {
      segs.push({ t: 'progress', key: 'bar', value: it.progress, tone: it.tone ?? 'accent', w: env.level === 'maximum' ? 140 : 80, side: 'center', prio: 5 });
    }
    if (this.items.size > 1 && !env.vertical) {
      segs.push({ t: 'text', key: 'more', text: `+${this.items.size - 1}`, tone: 'muted', size: 'sm', side: 'end', prio: 7, tip: `${this.items.size - 1} more` });
    }
    if (it.url) {
      segs.push({ t: 'button', key: 'open', icon: 'external', label: env.level === 'maximum' && !env.vertical ? 'Open' : undefined, action: 'open', style: 'secondary', side: 'end', prio: 2, tip: 'Open link' });
    }
    return segs;
  }

  action(name: string, arg?: unknown): void {
    // A tile row passes the id of its item; the card's button means the latest one.
    const url = (typeof arg === 'string' ? this.items.get(arg) : this.latest())?.url;
    if (name !== 'open' || !url || !SAFE_URL.test(url)) return;
    void native.open(url);
    this.ctx.close();
  }
}
