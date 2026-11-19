// Apps: your apps in Control Center, one tap to open one on this computer. On a phone
// (Island on your phone draws the same tile and card) that makes the phone a launcher for
// the PC. The list starts as the taskbar's pinned apps; Edit takes apps off and adds any app
// from Start's list.

import type { ActivityStatus, SheetEnv } from '../core/activity';
import type { DockCard } from '../core/dock';
import { native, type InstalledApp } from '../core/native';
import type { Seg } from '../core/segments';
import type { Block, FileTile, SheetRow, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';

/** Apps kept, at most. */
export const APPS_MAX = 40;
/** An app's icon, a side in pixels. */
const ICON_PX = 48;
/** Matches listed while adding an app. */
const FOUND_ROWS = 6;
/** "Opening Photos" stays this long. */
const NOTE_MS = 2500;

const isApp = (a: unknown): a is InstalledApp => typeof a === 'object' && a !== null && typeof (a as InstalledApp).name === 'string' && typeof (a as InstalledApp).target === 'string' && (a as InstalledApp).target !== '';

/** The saved list as it may be used: real entries only, no target twice, APPS_MAX at most. */
export function cleanApps(saved: unknown): InstalledApp[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const out: InstalledApp[] = [];
  for (const a of saved) {
    if (!isApp(a) || seen.has(a.target.toLowerCase())) continue;
    seen.add(a.target.toLowerCase());
    out.push({ name: a.name, target: a.target });
    if (out.length === APPS_MAX) break;
  }
  return out;
}

/** Apps whose name holds every word typed, the ones starting with it first. */
export function findApps(all: InstalledApp[], query: string, skip: ReadonlySet<string>, limit = FOUND_ROWS): InstalledApp[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = all.filter((a) => !skip.has(a.target.toLowerCase()) && words.every((w) => a.name.toLowerCase().includes(w)));
  const first = (a: InstalledApp) => (a.name.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hits.sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name)).slice(0, limit);
}

export class AppsActivity extends BaseActivity {
  private apps: InstalledApp[] = [];
  /** Each app's icon by target (null: none, or not asked yet). */
  private readonly icons = new Map<string, string | null>();
  private editing = false;
  private query = '';
  /** Start's list of apps, read when Edit first opens. */
  private installed: InstalledApp[] | null = null;
  private note: { text: string; bad: boolean; until: number } | null = null;

  constructor() {
    super('apps');
  }

  protected async init(): Promise<void> {
    const saved = this.ctx.options<{ apps?: unknown }>().apps;
    if (Array.isArray(saved)) this.apps = cleanApps(saved);
    else {
      // First time: what is pinned to the taskbar.
      const pinned = cleanApps(await native.appsPinned());
      if (!this.alive) return;
      this.apps = pinned;
      if (pinned.length) this.save();
    }
    void this.loadIcons();
    this.ctx.update();
  }

  /** `set`: the list replaced (the taskbar pinned, unpinned or moved an app). */
  command(cmd: string, arg: unknown): unknown {
    if (cmd !== 'set' || !Array.isArray(arg)) return false;
    this.apps = cleanApps(arg);
    this.save();
    void this.loadIcons();
    this.ctx.update();
    return true;
  }

  private save(): void {
    this.ctx.setOptions?.({ apps: this.apps });
  }

  /** Start's list of apps, read once (for Edit's add and the taskbar card's search). */
  private readInstalled(): void {
    if (this.installed || this.reading) return;
    this.reading = true;
    void native.wsApps().then((list) => {
      this.reading = false;
      if (!this.alive) return;
      this.installed = list;
      this.ctx.update();
    });
  }
  private reading = false;

  private async loadIcons(): Promise<void> {
    const want = this.apps.map((a) => a.target).filter((t) => !this.icons.has(t));
    if (!want.length) return;
    for (const t of want) this.icons.set(t, null);
    const got = await native.appsIcons(want, ICON_PX);
    if (!this.alive) return;
    want.forEach((t, i) => this.icons.set(t, got[i] ?? null));
    this.ctx.update();
  }

  /** The same card for the taskbar's arrow (src/core/dock.ts): its actions are this card's. */
  dockCard(now = Date.now()): DockCard {
    const note = this.note && now < this.note.until ? this.note : null;
    const have = new Set(this.apps.map((a) => a.target.toLowerCase()));
    // Editing: Start's apps not on the list yet, to add. Otherwise the search opens any app (MacDock's
    // Launchpad search, Moss): the ones on the list too.
    const typed = this.query.trim() !== '';
    const found = typed ? findApps(this.installed ?? [], this.query, this.editing ? have : new Set()).map((a) => ({ name: a.name, target: a.target })) : [];
    return {
      apps: this.apps.map((a) => ({ name: a.name, target: a.target, icon: this.icons.get(a.target) ?? null })),
      editing: this.editing,
      query: this.query,
      found,
      note: note?.text ?? null,
      bad: note?.bad ?? false,
      reading: (this.editing || typed) && !this.installed,
    };
  }

  status(): ActivityStatus {
    return { active: false };
  }

  render(): Seg[] {
    return [];
  }

  /** The tile: how many apps, and a tap opens the card with them. */
  tile(env: SheetEnv): Tile | null {
    if (!env.interactive) return null;
    const n = this.apps.length;
    return { key: 'apps', action: 'card', tip: 'Your apps', body: { k: 'actions', icon: this.meta.icon, label: 'Apps', sub: n ? `${n} ${n === 1 ? 'app' : 'apps'}` : 'Add your apps', buttons: [] } };
  }

  /** The card: every app as its icon over its name; Edit to take apps off and add others. */
  sheet(env: SheetEnv): SheetView | null {
    if (env.reason !== 'open') return null;
    const note = this.note && env.now < this.note.until ? this.note : null;
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'head',
        icon: this.meta.icon,
        tone: 'accent',
        title: 'Apps',
        sub: note?.text ?? (this.editing ? 'Drag to reorder, take apps off, or add one below' : 'Tap one to open it on this computer'),
        buttons: [
          { key: 'edit', label: this.editing ? 'Done' : 'Edit', action: 'edit', style: this.editing ? 'primary' : 'ghost' },
          { key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost', tip: 'Control Center' },
        ],
      },
    ];
    if (this.apps.length) {
      const items: FileTile[] = this.apps.map((a) => ({
        key: a.target,
        name: a.name,
        thumb: this.icons.get(a.target) ?? null,
        icon: 'grid',
        action: this.editing ? undefined : 'open',
        arg: a.target,
        tip: this.editing ? a.name : `Open ${a.name}`,
        remove: this.editing ? { key: 'rm', icon: 'x', action: 'remove', arg: a.target, style: 'ghost', tip: `Take ${a.name} off` } : undefined,
      }));
      // While editing, an app drags to a new place (Justin).
      blocks.push({ t: 'files', key: 'apps', items, wrap: true, reorder: this.editing ? 'move' : undefined });
    } else if (!this.editing) {
      blocks.push({ t: 'text', key: 'none', text: 'No apps here yet. Press Edit and add the ones you open most.', tone: 'muted', size: 'sm' });
    }
    if (this.editing) {
      blocks.push({ t: 'input', key: 'find', placeholder: 'Add an app: type its name', action: 'find', change: 'find', value: this.query });
      const have = new Set(this.apps.map((a) => a.target.toLowerCase()));
      const found = findApps(this.installed ?? [], this.query, have);
      if (found.length) {
        const rows: SheetRow[] = found.map((a) => ({ key: a.target, icon: 'plus', title: a.name, action: 'add', arg: a.target, tip: `Add ${a.name}` }));
        blocks.push({ t: 'rows', key: 'found', items: rows });
      } else if (this.query.trim()) {
        blocks.push({ t: 'text', key: 'nothing', text: this.installed ? 'No app with that name in Start.' : 'Reading your apps…', tone: 'muted', size: 'sm' });
      }
    }
    return { key: 'apps', wide: true, blocks };
  }

  async action(name: string, arg?: unknown): Promise<void> {
    const target = typeof arg === 'string' ? arg : '';
    switch (name) {
      case 'card':
        this.ctx.openCard?.();
        break;
      case 'open': {
        const app = this.apps.find((a) => a.target === target);
        if (!app) break;
        const r = await native.wsLaunch({ kind: 'app', path: app.target, args: '', cwd: '' }, '');
        if (!this.alive) return;
        this.note = r.ok ? { text: `Opening ${app.name}`, bad: false, until: Date.now() + NOTE_MS } : { text: `Couldn't open ${app.name}: ${r.error}`, bad: true, until: Date.now() + NOTE_MS * 2 };
        this.later(NOTE_MS * 2 + 50, () => this.ctx.update());
        break;
      }
      case 'edit':
        this.editing = !this.editing;
        this.query = '';
        if (this.editing) this.readInstalled();
        break;
      case 'find':
        this.query = typeof arg === 'string' ? arg : '';
        if (this.query.trim()) this.readInstalled();
        break;
      case 'launch': {
        // Any of Start's apps, from the taskbar card's search.
        const app = this.installed?.find((a) => a.target === target) ?? this.apps.find((a) => a.target === target);
        if (!app) break;
        this.query = '';
        const r = await native.wsLaunch({ kind: 'app', path: app.target, args: '', cwd: '' }, '');
        if (!this.alive) return;
        this.note = r.ok ? { text: `Opening ${app.name}`, bad: false, until: Date.now() + NOTE_MS } : { text: `Couldn't open ${app.name}: ${r.error}`, bad: true, until: Date.now() + NOTE_MS * 2 };
        this.later(NOTE_MS * 2 + 50, () => this.ctx.update());
        break;
      }
      case 'add': {
        const app = this.installed?.find((a) => a.target === target);
        if (!app || this.apps.length >= APPS_MAX || this.apps.some((a) => a.target.toLowerCase() === target.toLowerCase())) break;
        this.apps = [...this.apps, { name: app.name, target: app.target }];
        this.query = '';
        this.save();
        void this.loadIcons();
        break;
      }
      case 'remove':
        this.apps = this.apps.filter((a) => a.target !== target);
        this.save();
        break;
      case 'move': {
        // { key: the app's target, to: its new place }.
        const m = arg as { key?: unknown; to?: unknown } | null;
        const from = this.apps.findIndex((a) => a.target === m?.key);
        const to = typeof m?.to === 'number' ? Math.max(0, Math.min(this.apps.length - 1, Math.round(m.to))) : -1;
        if (from < 0 || to < 0 || from === to) break;
        const next = [...this.apps];
        const [app] = next.splice(from, 1);
        next.splice(to, 0, app);
        this.apps = next;
        this.save();
        break;
      }
      default:
        return;
    }
    this.ctx.update();
  }
}
