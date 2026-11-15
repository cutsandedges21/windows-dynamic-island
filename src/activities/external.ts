// Other apps: whatever a script or program sends through the activity API
// (`island-hook.exe activity`, JSON on stdin). See docs/ACTIVITY-API.md.
// `island-hook.exe ask` sends the same with buttons and waits: its card holds the island open
// until a button is pressed (here or on a phone), and the pressed button's id goes back to it.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { hasIcon } from '../core/icons';
import { native } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { Block, SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';

const MAX_ITEMS = 10;
const MAX_MS = 24 * 3600 * 1000;
const TONES: ReadonlySet<string> = new Set(['default', 'muted', 'dim', 'accent', 'claude', 'good', 'warn', 'bad', 'info', 'violet', 'purple']);
/** Links the island will open: https anywhere, http only for localhost. */
const SAFE_URL = /^(?:https:\/\/\S+|http:\/\/localhost(?::\d+)?(?:[/?#]\S*)?)$/i;
/** A question's buttons: at most this many, with ids island-hook accepts too. */
const MAX_BUTTONS = 3;
const BUTTON_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A question's button. The primary one (Allow) is the action `confirm`, which a phone may not press while Windows Hello guards Allow. */
export type AskButton = { id: string; label: string; primary: boolean };
/** A sender waiting on `island-hook.exe ask`: its pipe request and the buttons it offered. */
type Ask = { requestId: string; buttons: AskButton[] };

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
  /** Waiting for a button (`island-hook.exe ask`); null for a plain item. */
  ask: Ask | null;
  /** Bumps when the title or text change, so a dismissed alert can come back for new news. */
  rev: number;
  at: number;
  expiresAt: number | null;
};

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : undefined);

/** A question's buttons as sent, or null when they are not 1 to 3 buttons with ids and labels (one primary at most). */
export function readButtons(v: unknown): AskButton[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BUTTONS) return null;
  const out: AskButton[] = [];
  for (const b of v) {
    if (!b || typeof b !== 'object') return null;
    const o = b as Record<string, unknown>;
    const label = str(o.label, 24);
    if (typeof o.id !== 'string' || !BUTTON_ID.test(o.id) || !label || out.some((x) => x.id === o.id)) return null;
    out.push({ id: o.id, label, primary: o.primary === true && !out.some((x) => x.primary) });
  }
  return out;
}

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
    // The sender stopped asking (its island-hook ended, or 30 minutes went by): the question goes.
    this.listen<{ request_id: string }>('hook-expired', ({ request_id }) => {
      const it = [...this.items.values()].find((i) => i.ask?.requestId === request_id);
      if (it && this.items.delete(it.id)) this.ctx.update();
    });
    this.every(1000, () => this.sweep());
  }

  /** Drops an item; a question still waiting is let go, so its sender hears no answer. */
  private remove(id: string): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    if (it.ask) void native.hookReply(it.ask.requestId, 'decline');
    return true;
  }

  private ingest(p: Record<string, unknown>): void {
    if (!p || typeof p !== 'object') return;
    const id = str(typeof p.id === 'number' ? String(p.id) : p.id, 80);
    if (!id) return;
    if (p.state === 'end') {
      if (this.remove(id)) this.ctx.update();
      return;
    }
    // A question (`island-hook.exe ask`) comes with the pipe's request id; bad buttons: no card, no wait.
    const requestId = p.island === 'ask' && typeof p.request_id === 'string' ? p.request_id : null;
    const buttons = requestId ? readButtons(p.buttons) : null;
    if (requestId && !buttons) {
      void native.hookReply(requestId, 'decline');
      return;
    }

    // Fields a sender leaves out keep their last value, so `{"id":"x","progress":0.5}` is a valid update.
    const now = Date.now();
    const prev = this.items.get(id);
    // A new question under the same id replaces the old one, whose sender hears no answer.
    if (requestId && prev?.ask && prev.ask.requestId !== requestId) void native.hookReply(prev.ask.requestId, 'decline');
    const ask: Ask | null = requestId && buttons ? { requestId, buttons } : (prev?.ask ?? null);
    const title = str(p.title, 80) || prev?.title || id;
    const text = p.text === undefined ? (prev?.text ?? '') : (str(p.text, 160) ?? '');
    const changed = !prev || prev.title !== title || prev.text !== text || ask !== prev.ask;
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
      ask,
      rev: (prev?.rev ?? 0) + (changed ? 1 : 0),
      at: now,
      expiresAt: ms !== null ? now + ms : (prev?.expiresAt ?? null),
    };
    this.items.delete(id);
    this.items.set(id, item);
    while (this.items.size > MAX_ITEMS) this.remove(this.items.keys().next().value as string);
    // The card is up (the next frame draws it): the sender keeps waiting for a button.
    if (requestId) void native.hookReply(requestId, 'ack');

    if (changed) {
      this.ctx.surface({ key: `ext:${id}`, ms: 3500, level: 'expanded' });
      // Island's own update notice is news for the bot; anything else reacts by its tone.
      const tone = item.tone ?? 'info';
      this.saw(id === 'island-update' ? 'updated' : tone === 'good' ? 'good-news' : tone === 'bad' ? 'bad-news' : tone === 'warn' ? 'warning' : 'info', `external:${id}`);
      if (item.urgent || item.ask) {
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
      if (it.expiresAt !== null && now >= it.expiresAt) changed = this.remove(id) || changed;
    }
    if (changed) this.ctx.update();
  }

  private latest(): Item | null {
    let last: Item | null = null;
    for (const it of this.items.values()) last = it;
    return last;
  }

  /** The newest question still waiting for a button. */
  private asking(): Item | null {
    let last: Item | null = null;
    for (const it of this.items.values()) if (it.ask) last = it;
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
    // A question holds the island open until it is answered or tapped away, before any other alert.
    const open = (i: Item) => !this.dismissed.has(this.urgentKey(i));
    const urgent = list.find((i) => i.ask && open(i)) ?? list.find((i) => i.urgent && open(i));
    const running = list.some((i) => i.progress !== undefined);
    return {
      active: true,
      weight: urgent || running || Date.now() - top.at < 15000 ? 'foreground' : 'background',
      urgent: urgent ? { key: this.urgentKey(urgent), level: 'expanded', ask: urgent.ask !== null } : null,
      summary: clip(top.text ? `${top.title}: ${top.text}` : top.title, 60),
    };
  }

  chip(): ChipView | null {
    const it = this.latest();
    return it ? { icon: it.icon, label: it.title, tone: it.tone } : null;
  }

  /** A question's card, whatever asks for it (holding the island open, pointed at, opened): its text and buttons. */
  sheet(): SheetView | null {
    const it = this.asking();
    if (!it?.ask) return null;
    const blocks: Block[] = [{ t: 'head', key: 'h', icon: it.icon, tone: it.tone ?? 'warn', title: it.title }];
    if (it.text) blocks.push({ t: 'text', key: 'text', text: it.text, tone: 'muted', size: 'sm' });
    blocks.push({
      t: 'buttons',
      key: 'answer',
      items: it.ask.buttons.map((b) => ({
        key: b.id,
        label: b.label,
        icon: b.primary ? 'check' : undefined,
        action: b.primary ? 'confirm' : 'answer',
        arg: { id: it.id, button: b.id },
        style: b.primary ? 'primary' : 'secondary',
      })),
    });
    return { key: `ext-ask:${it.ask.requestId}`, blocks };
  }

  /** Pointed at while a question waits, its card shows, whatever Settings › Hover card says. */
  claimsHover(): boolean {
    return this.asking() !== null;
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
    if (name === 'answer' || name === 'confirm') return this.press(name, arg);
    // A tile row passes the id of its item; the card's button means the latest one.
    const url = (typeof arg === 'string' ? this.items.get(arg) : this.latest())?.url;
    if (name !== 'open' || !url || !SAFE_URL.test(url)) return;
    void native.open(url);
    this.ctx.close();
  }

  /** A question's button: its id goes back to the sender, and the question is done here. */
  private press(name: 'answer' | 'confirm', arg: unknown): void {
    const a = (arg && typeof arg === 'object' ? arg : {}) as Record<string, unknown>;
    const it = typeof a.id === 'string' ? this.items.get(a.id) : undefined;
    const button = it?.ask?.buttons.find((b) => b.id === a.button);
    // `confirm` is the primary button and only it: the phone's Windows Hello guard counts on that.
    if (!it?.ask || !button || button.primary !== (name === 'confirm')) return;
    this.items.delete(it.id);
    void native.hookReply(it.ask.requestId, JSON.stringify({ kind: 'button', id: button.id }));
    this.ctx.update();
  }
}
