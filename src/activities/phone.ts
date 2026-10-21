// Phone: your phone's notifications on the island. Windows' Phone Link mirrors them
// (an iPhone over Bluetooth) and src-tauri/src/phonelink.rs hands each new one over.
// Island's own pushes (Settings › Notifications › Send to my phone) come back the same
// way, as the ntfy app's; those are skipped.
//
// A new one shows on the pill for a few seconds. All of them wait in a list, in memory
// only, newest first: a tile in Control Center, and, with Persistent on, the phone icon
// on the pill, whose hover card is the list (like Claude's). ✕ dismisses one.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { agoText, clip } from '../core/format';
import { native, type PhoneNote } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';

const SHOW_MS = 6000;
/** The list holds this many at most. */
const KEEP_MAX = 50;
/** Rows in the hover card; the open island's card shows them all. */
const HOVER_ROWS = 8;
const TILE_ROWS = 4;

type Note = PhoneNote & { at: number };

/** A push Island sent itself, mirrored back from the phone's ntfy app. */
export function isEcho(note: Pick<PhoneNote, 'app'>): boolean {
  return note.app.trim().toLowerCase() === 'ntfy';
}

export class PhoneActivity extends BaseActivity {
  /** Newest first. */
  private notes: Note[] = [];

  constructor() {
    super('phone');
  }

  protected async init(): Promise<void> {
    this.listen<PhoneNote>('phone-note', (n) => this.arrive(n));
    this.every(60_000, () => this.prune(Date.now()));
    this.onDispose(() => void native.phoneLinkWatch(false));
    const access = await native.phoneLinkWatch(true);
    // Stopped while asking: the disposer's "off" may have landed before this "on".
    if (!this.alive) void native.phoneLinkWatch(false);
    else if (access !== 'allowed') this.ctx.log(`notification access: ${access}`);
  }

  private arrive(n: PhoneNote): void {
    if (isEcho(n)) return;
    // The same notification again (an updated one): it moves to the top, once.
    this.notes = [{ ...n, at: Date.now() }, ...this.notes.filter((x) => x.id !== n.id)].slice(0, KEEP_MAX);
    this.ctx.surface({ key: `phone:${n.id}`, ms: SHOW_MS, level: 'expanded' });
    this.saw('info', `phone:${n.id}`);
    this.later(SHOW_MS + 50, () => this.ctx.update());
    this.ctx.update();
  }

  private keepMs(): number {
    return (Number(this.ctx.options<{ keepHours: number }>().keepHours) || 24) * 3600_000;
  }

  /** Old ones leave the list on their own. */
  private prune(now: number): void {
    const cut = now - this.keepMs();
    const kept = this.notes.filter((n) => n.at >= cut);
    if (kept.length === this.notes.length) return;
    this.notes = kept;
    this.ctx.update();
  }

  private fresh(now: number): Note | null {
    const n = this.notes[0];
    return n && now - n.at < SHOW_MS ? n : null;
  }

  status(): ActivityStatus {
    const n = this.fresh(Date.now());
    if (n) return { active: true, weight: 'foreground', summary: n.app ? `${n.app}: ${n.title}` : n.title };
    const count = this.notes.length;
    if (!count) return { active: false };
    // Waiting ones: with Persistent on, the phone icon stays on the pill; it never takes the pill itself.
    return { active: true, weight: 'background', chipOnly: true, summary: `${count} phone notification${count > 1 ? 's' : ''}` };
  }

  chip(): ChipView | null {
    if (!this.notes.length) return null;
    return { icon: 'phone', label: String(this.notes.length), tone: this.fresh(Date.now()) ? 'accent' : 'muted', action: 'list' };
  }

  /** The pointer on the phone icon shows the list, whatever Settings › Hover card says. */
  claimsHover(): boolean {
    return this.notes.length > 0;
  }

  render(env: RenderEnv): Seg[] {
    const n = this.fresh(env.now) ?? this.notes[0];
    if (!n) return [];
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: 'phone', prio: 3 },
      { t: 'text', key: 'who', text: n.title || n.app || 'Phone', weight: 'semibold', prio: 0 },
    ];
    if (env.level === 'compact' || env.level === 'idle' || env.vertical) return segs;
    if (n.body) segs.push({ t: 'text', key: 'body', text: n.body, tone: 'muted', prio: 2 });
    return segs;
  }

  private row(n: Note, now: number): SheetRow {
    return {
      key: String(n.id),
      icon: 'phone',
      title: n.title || n.app || 'Notification',
      detail: [n.title ? n.app : null, agoText(now - n.at), n.body ? clip(n.body.replace(/\s+/g, ' '), 140) : null].filter(Boolean).join(' · '),
      tip: n.body || undefined,
      button: { key: 'x', icon: 'x', action: 'dismiss', arg: n.id, style: 'ghost', tip: 'Dismiss' },
    };
  }

  /** The list: a heading with Clear all, then the notifications, newest first. */
  private listSheet(now: number, max: number): SheetView {
    const count = this.notes.length;
    const shown = this.notes.slice(0, max);
    const blocks: SheetView['blocks'] = [
      {
        t: 'head',
        key: 'head',
        icon: 'phone',
        title: 'Phone',
        sub: count ? `${count} notification${count > 1 ? 's' : ''}` : 'No notifications',
        buttons: count ? [{ key: 'clear', label: 'Clear all', action: 'clear', style: 'ghost', tip: 'Dismiss them all' }] : undefined,
      },
    ];
    if (shown.length) blocks.push({ t: 'rows', key: 'notes', items: shown.map((n) => this.row(n, now)) });
    else blocks.push({ t: 'text', key: 'none', text: 'New ones from your phone wait here until you dismiss them.', tone: 'muted', size: 'sm' });
    if (count > shown.length) blocks.push({ t: 'text', key: 'more', text: `${count - shown.length} more in Control Center`, tone: 'muted', size: 'sm' });
    return { key: 'list', blocks };
  }

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason === 'hover') return this.listSheet(env.now, HOVER_ROWS);
    if (env.reason === 'open') return this.listSheet(env.now, KEEP_MAX);
    // Just arrived: the whole message, in the card under the pill while it is shown.
    const n = this.fresh(env.now);
    if (!n || !n.body) return null;
    return {
      key: `phone:${n.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'phone', title: n.title || n.app || 'Phone', sub: n.app || undefined },
        { t: 'text', key: 'body', text: n.body, bubble: true, lines: 6 },
      ],
    };
  }

  /** Control Center: the newest ones with ✕; a tap on the tile opens the whole list. */
  tile(env: SheetEnv): Tile | null {
    const count = this.notes.length;
    return {
      key: 'phone',
      span: 2,
      rows: 2,
      action: 'list',
      tip: 'All phone notifications',
      body: { k: 'list', icon: 'phone', label: count ? `Phone · ${count}` : 'Phone', rows: this.notes.slice(0, TILE_ROWS).map((n) => this.row(n, env.now)), empty: 'No notifications' },
    };
  }

  action(name: string, arg: unknown): void {
    if (name === 'dismiss') this.notes = this.notes.filter((n) => n.id !== arg);
    else if (name === 'clear') this.notes = [];
    else if (name === 'list') {
      this.ctx.openCard?.();
      return;
    } else return;
    this.ctx.update();
  }
}
