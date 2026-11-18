// The Shelf: a place to park files for a moment, built into Island. Files dragged over the island
// open it like Control Center, split in two: the Shelf on the left, Land on the right. Dropped on
// the Shelf, they wait there and the island stays open until the pill or the card's x is clicked
// (island.ts shelfPinned). Closed, the Shelf rests as a circle beside the pill, opposite the bot
// (src/core/shelf-bubble.ts); pointing at it opens it to drag files back out. The Shelf never
// moves or copies a file: it keeps paths, and drags them out with Windows' own drag (shelf.rs).

import type { ActivityStatus, SheetEnv } from '../core/activity';
import { bytes } from '../core/format';
import { native, type LandStaged } from '../core/native';
import type { Seg } from '../core/segments';
import type { Block, FileTile, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';

/** Files the Shelf remembers across restarts, at most. */
export const SHELF_FILES_MAX = 60;
/** A tile's picture, a side in pixels. */
const THUMB_PX = 96;
/** The Shelf's card: narrower than Land's (Moss: "the card for the file shelf smaller than Land's"). */
export const SHELF_CARD_W = 360;
/** After Clear, Undo brings the files back for this long. */
export const UNDO_MS = 6000;

/** A file on the Shelf, as the circle shows it. */
export interface ShelfFile {
  path: string;
  name: string;
  thumb: string | null;
  dir: boolean;
  missing: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the card's heading says under "Shelf". */
export function shelfSummary(items: readonly Pick<LandStaged, 'size' | 'error'>[], ticked: number): string {
  if (!items.length) return 'Drop files here to keep them for later';
  const size = items.filter((s) => !s.error).reduce((a, s) => a + s.size, 0);
  if (ticked) return `${ticked} selected`;
  return size > 0 ? `${plural(items.length, 'file')} · ${bytes(size)}` : plural(items.length, 'file');
}

/** `paths` added after `have`, each once, newest last, at most `max` in all (the oldest go first). */
export function addPaths(have: readonly string[], paths: readonly string[], max = SHELF_FILES_MAX): string[] {
  const out = have.filter((p) => !paths.includes(p));
  for (const p of paths) if (!out.includes(p)) out.push(p);
  return out.slice(Math.max(0, out.length - max));
}

export class ShelfActivity extends BaseActivity {
  private items: LandStaged[] = [];
  private readonly thumbs = new Map<string, string | null>();
  private readonly ticked = new Set<string>();
  /** What Clear took off, for Undo. */
  private undo: { items: LandStaged[]; until: number } | null = null;
  private note: string | null = null;

  constructor() {
    super('shelf');
  }

  protected async init(): Promise<void> {
    const saved = this.ctx.options<{ files?: unknown }>().files;
    if (Array.isArray(saved)) await this.add(saved.filter((x): x is string => typeof x === 'string'), false);
  }

  status(): ActivityStatus {
    return { active: false, weight: 'background' };
  }

  render(): Seg[] {
    return [];
  }

  // ---------------------------------------------------------------- for the island

  /** The files on the Shelf, oldest first. */
  files(): ShelfFile[] {
    this.loadThumbs();
    return this.items.map((s) => ({ path: s.path, name: s.name, thumb: this.thumbs.get(s.path) ?? null, dir: s.dir, missing: Boolean(s.error) }));
  }

  /** Clear has just taken files off and Undo can still bring them back. */
  canUndo(now = Date.now()): boolean {
    return this.undo !== null && this.undo.until > now;
  }

  drop(paths: string[]): boolean {
    if (!paths.length) return false;
    void this.add(paths, true);
    return true;
  }

  accepts(): string | null {
    return 'Drop to keep on the Shelf';
  }

  // ---------------------------------------------------------------- Control Center

  /** Its own tile (Justin): how many files wait and how big they are; a tap opens the Shelf's card. */
  tile(env: SheetEnv): Tile {
    const ok = this.items.filter((s) => !s.error);
    const size = ok.reduce((a, s) => a + s.size, 0);
    return {
      key: 'shelf',
      tone: this.items.length ? 'accent' : undefined,
      action: env.interactive ? 'card' : undefined,
      tip: 'Open the Shelf',
      body: {
        k: 'stat',
        icon: 'shelf',
        label: 'Shelf',
        value: this.items.length ? plural(this.items.length, 'file') : 'Empty',
        sub: this.items.length ? (size > 0 ? bytes(size) : undefined) : 'Drop on the island',
      },
    };
  }

  // ---------------------------------------------------------------- the card

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason !== 'open') return null;
    const picked = this.items.filter((s) => this.ticked.has(s.path)).length;
    const head: Block = {
      t: 'head',
      key: 'head',
      icon: 'shelf',
      tone: 'accent',
      title: 'Shelf',
      sub: this.note ?? shelfSummary(this.items, picked),
      buttons: [
        ...(this.items.length > 1 ? [{ key: 'all', label: picked === this.items.length ? 'None' : 'All', action: 'tick-all', style: 'ghost' as const, tip: picked === this.items.length ? 'Untick them all' : 'Tick them all' }] : []),
        ...(this.items.length ? [{ key: 'clear', icon: 'trash', action: 'clear', style: 'ghost' as const, tip: picked ? 'Take the ticked files off the Shelf' : 'Take every file off the Shelf' }] : []),
        { key: 'close', icon: 'x', action: 'island:shelf-close', style: 'ghost' as const, tip: 'Close' },
      ],
    };
    const blocks: Block[] = [head];
    if (this.items.length) {
      this.loadThumbs();
      const items: FileTile[] = this.items.map((s) => ({
        key: s.path,
        name: s.name,
        sub: s.error ?? (s.dir ? plural(s.files, 'file') : bytes(s.size)),
        thumb: this.thumbs.get(s.path) ?? null,
        icon: s.dir ? 'folder' : 'file',
        ticked: this.ticked.has(s.path),
        tone: s.error ? 'bad' : undefined,
        action: s.error || !env.interactive ? undefined : 'tick',
        arg: s.path,
        tip: s.error ? `${s.name}: ${s.error}` : `${s.name} · click to tick, drag it out into a folder, an app, or onto Land`,
        remove: { key: 'rm', icon: 'x', action: 'unstage', arg: s.path, style: 'ghost', tip: 'Take it off the Shelf' },
      }));
      blocks.push({ t: 'files', key: 'files', items, drag: env.interactive ? 'drag-out' : undefined });
    } else {
      blocks.push({ t: 'text', key: 'hint', text: 'Drag files over the island and drop them on the Shelf side. They wait here until you drag them out.', tone: 'muted', size: 'sm' });
    }
    return { key: 'shelf/card', width: SHELF_CARD_W, blocks };
  }

  // ---------------------------------------------------------------- actions

  async action(name: string, arg?: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : '';
    switch (name) {
      case 'card':
        this.ctx.openCard?.();
        return;
      case 'tick':
        if (this.ticked.has(id)) this.ticked.delete(id);
        else if (this.items.some((s) => s.path === id && !s.error)) this.ticked.add(id);
        break;
      case 'tick-all': {
        const ok = this.items.filter((s) => !s.error);
        const every = ok.length > 0 && ok.every((s) => this.ticked.has(s.path));
        this.ticked.clear();
        if (!every) for (const s of ok) this.ticked.add(s.path);
        break;
      }
      case 'unstage':
        this.items = this.items.filter((s) => s.path !== id);
        this.changed();
        break;
      case 'clear':
      case 'clear-all': {
        // The ticked files, or every file when none is ticked (the circle's x: all); Undo brings them back for a moment.
        const gone = this.ticked.size && name === 'clear' ? this.items.filter((s) => this.ticked.has(s.path)) : this.items;
        if (!gone.length) break;
        this.undo = { items: gone, until: Date.now() + UNDO_MS };
        const paths = new Set(gone.map((s) => s.path));
        this.items = this.items.filter((s) => !paths.has(s.path));
        this.changed();
        this.later(UNDO_MS + 50, () => this.ctx.update());
        break;
      }
      case 'undo':
        if (this.undo && this.undo.until > Date.now()) {
          const back = this.undo.items.filter((s) => !this.items.some((x) => x.path === s.path));
          this.items = [...back, ...this.items];
          this.undo = null;
          this.changed();
        }
        break;
      case 'drag-out': {
        // Dragging a ticked file takes every ticked one with it; an unticked one goes alone.
        const paths = this.ticked.has(id) ? this.items.filter((s) => this.ticked.has(s.path) && !s.error).map((s) => s.path) : this.items.filter((s) => s.path === id && !s.error).map((s) => s.path);
        await this.dragOut(paths);
        break;
      }
      case 'drag-all':
        await this.dragOut(this.items.filter((s) => !s.error).map((s) => s.path));
        break;
      default:
        return;
    }
    this.ctx.update();
  }

  private async dragOut(paths: string[]): Promise<void> {
    if (!paths.length || native.demo) return;
    const r = await native.shelfDrag(paths);
    if (!this.alive) return;
    this.note = r.ok ? null : r.error;
    if (r.ok && r.value) this.ticked.clear();
  }

  private async add(paths: string[], fresh: boolean): Promise<void> {
    const want = addPaths(
      this.items.map((s) => s.path),
      paths,
    );
    const known = new Map(this.items.map((s) => [s.path, s]));
    const missing = want.filter((p) => !known.has(p));
    const got = missing.length ? await native.landStage(missing) : [];
    if (!this.alive) return;
    for (const s of got) known.set(s.path, s);
    this.items = want.map((p) => known.get(p)).filter((s): s is LandStaged => Boolean(s));
    if (fresh) {
      this.undo = null;
      this.note = null;
    }
    this.changed();
    this.ctx.update();
  }

  /** The Shelf changed: ticks and pictures of files gone are dropped, and its paths saved for the next start. */
  private changed(): void {
    const paths = new Set(this.items.map((s) => s.path));
    for (const x of [...this.ticked]) if (!paths.has(x)) this.ticked.delete(x);
    for (const x of [...this.thumbs.keys()]) if (!paths.has(x)) this.thumbs.delete(x);
    this.ctx.setOptions?.({ files: [...paths] });
  }

  /** Asks Windows for each new file's picture; its icon shows until it comes. */
  private loadThumbs(): void {
    if (native.demo) return;
    for (const s of this.items) {
      if (s.error || this.thumbs.has(s.path)) continue;
      this.thumbs.set(s.path, null);
      void native.shelfThumb?.(s.path, THUMB_PX).then((src) => {
        if (!this.alive || !src || !this.thumbs.has(s.path)) return;
        this.thumbs.set(s.path, src);
        this.ctx.update();
      });
    }
  }
}
