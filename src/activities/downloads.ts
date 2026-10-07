// Downloads: files arriving in the Downloads folder. Browser temp files
// (.crdownload, .part…) show their speed while they grow; when one turns into
// the finished file the island offers Open and Show.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { agoText, baseName, bytes, clip, rate } from '../core/format';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Options = { folder: string };
type FsChange = { id: string; kind: string; paths: string[] };
type Transfer = { path: string; name: string; size: number; at: number; grewAt: number; since: number; speed: number };
type Arrival = { path: string; name: string; at: number };
type Finished = { name: string; path: string; at: number };

const WATCH_ID = 'downloads';
const TEMP = /\.(crdownload|part|partial|download)$/i;
const TEMP_EXTS = ['.crdownload', '.part', '.partial', '.download'];
const DONE_MS = 6000;
/** A temp file that neither grows nor changes for this long is abandoned (cancelled, or paused for good). */
const STALE_MS = 3 * 60000;
/** How far apart a vanished temp file and a new file may be and still count as one download. */
const PAIR_MS = 10000;
/** The tile remembers finished downloads this long (and no more than RECENT_MAX of them). */
const RECENT_MS = 24 * 3600000;
const RECENT_MAX = 5;
/** Rows the tile lists. */
const TILE_ROWS = 2;

const isTemp = (name: string) => TEMP.test(name);
/** Office lock files and the like. */
const ignored = (name: string) => name.startsWith('~$');

/** "report.pdf.crdownload" → "report.pdf"; Chrome's "Unconfirmed 123.crdownload" has no name yet. */
function shown(file: string): string {
  return file.replace(TEMP, '').replace(/^Unconfirmed \d+$/i, '') || 'Download';
}

export class DownloadsActivity extends BaseActivity {
  private folder = '';
  private readonly active = new Map<string, Transfer>();
  /** Temp files that just disappeared, by lower-case path. */
  private readonly gone = new Map<string, { name: string; at: number }>();
  private arrived: Arrival[] = [];
  private done: Finished | null = null;
  /** Finished downloads, newest first: what the tile lists once the card has gone. */
  private recent: Finished[] = [];
  private readonly pending = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private polling = false;

  constructor() {
    super('downloads');
  }

  protected async init(): Promise<void> {
    this.listen<FsChange>('fs-change', (e) => {
      if (e.id === WATCH_ID) this.onChange(e);
    });
    this.every(1000, () => void this.poll());
    await this.watchFolder();
  }

  override dispose(): void {
    void native.unwatch(WATCH_ID);
  }

  reconfigure(): void {
    void this.watchFolder();
  }

  private async watchFolder(): Promise<void> {
    const custom = this.ctx.options<Partial<Options>>().folder;
    const wanted = (typeof custom === 'string' && custom.trim()) || (await native.knownFolders()).downloads;
    if (!this.alive || !wanted || wanted === this.folder) return;
    this.folder = wanted;
    this.active.clear();
    this.gone.clear();
    this.arrived = [];
    this.recent = [];
    const ok = await native.watch(WATCH_ID, wanted); // replaces any earlier watch with this id
    if (!this.alive) {
      void native.unwatch(WATCH_ID);
      return;
    }
    if (!ok) {
      void native.unwatch(WATCH_ID);
      this.ctx.log('cannot watch', wanted);
      return;
    }
    await this.adopt(wanted);
  }

  /** Browser files that were already downloading when the island started. */
  private async adopt(folder: string): Promise<void> {
    const lists = await Promise.all(TEMP_EXTS.map((ext) => native.listFiles(folder, false, ext, 60000)));
    if (!this.alive || folder !== this.folder) return;
    const now = Date.now();
    for (const f of lists.flat()) if (!ignored(f.name)) this.track(f.path, f.size, now);
    if (this.active.size) this.ctx.update();
  }

  // ---------------------------------------------------------------- tracking

  private track(path: string, size: number, now: number): void {
    const key = path.toLowerCase();
    const t = this.active.get(key);
    if (t) t.grewAt = now;
    else this.active.set(key, { path, name: shown(baseName(path)), size, at: now, grewAt: now, since: now, speed: 0 });
    this.gone.delete(key);
  }

  private lose(path: string, now: number): void {
    const key = path.toLowerCase();
    const t = this.active.get(key);
    this.active.delete(key);
    if (!this.gone.has(key)) this.gone.set(key, { name: t?.name ?? shown(baseName(path)), at: now });
  }

  private onChange(e: FsChange): void {
    const now = Date.now();
    const paths: string[] = [];
    for (const path of e.paths) {
      const name = baseName(path);
      if (ignored(name)) continue;
      const key = path.toLowerCase();
      if (e.kind !== 'modify') {
        paths.push(path);
        continue;
      }
      // Browsers write constantly and the 1 s poll tracks growth; only a temp file we have not met needs a look.
      const known = this.active.get(key);
      if (known) known.grewAt = now;
      else if (isTemp(name) && !this.pending.has(key)) {
        this.pending.add(key);
        paths.push(path);
      }
    }
    if (!paths.length) return;
    this.queue = this.queue.then(() => this.settle(e.kind, paths)).catch(() => undefined);
  }

  /** Looks at what is on disk for the paths an event named, then pairs vanished temp files with new ones. */
  private async settle(kind: string, paths: string[]): Promise<void> {
    const stats = await native.statMany(paths);
    for (const p of paths) this.pending.delete(p.toLowerCase());
    if (!this.alive) return;
    const now = Date.now();
    paths.forEach((path, i) => {
      const st = stats[i];
      const name = baseName(path);
      if (isTemp(name)) {
        if (st && !st.dir) this.track(path, st.size, now);
        else this.lose(path, now);
      } else if (st && !st.dir && (kind === 'create' || kind === 'rename')) {
        this.arrived.push({ path, name, at: now });
      }
    });
    this.matchDone(now);
    this.ctx.update();
  }

  /** A temp file vanished and a new file appeared: that is a finished download. */
  private matchDone(now: number): void {
    for (const [key, g] of this.gone) if (now - g.at > PAIR_MS) this.gone.delete(key);
    this.arrived = this.arrived.filter((a) => now - a.at <= PAIR_MS);
    for (const [key, g] of [...this.gone]) {
      if (!this.arrived.length) break;
      // Same base name when the browser knew it (report.pdf.part); else the newest file (Chrome's "Unconfirmed").
      const file = this.arrived.find((a) => a.name.toLowerCase() === g.name.toLowerCase()) ?? this.arrived[this.arrived.length - 1];
      this.arrived.splice(this.arrived.indexOf(file), 1);
      this.gone.delete(key);
      this.done = { name: file.name, path: file.path, at: now };
      this.recent = [this.done, ...this.recent.filter((r) => r.path.toLowerCase() !== file.path.toLowerCase())].slice(0, RECENT_MAX);
      this.ctx.surface({ key: `done:${file.name}`, ms: DONE_MS, level: 'expanded' });
    }
  }

  private async poll(): Promise<void> {
    if (this.done && Date.now() - this.done.at > DONE_MS) {
      this.done = null;
      this.ctx.update();
    }
    if (this.polling || !this.active.size) return;
    this.polling = true;
    try {
      const list = [...this.active.values()];
      const stats = await native.statMany(list.map((t) => t.path));
      if (!this.alive) return;
      const now = Date.now();
      list.forEach((t, i) => {
        const st = stats[i];
        if (!st || st.dir) {
          this.lose(t.path, now);
          return;
        }
        const dt = (now - t.at) / 1000;
        if (dt < 0.2) return;
        const instant = Math.max(0, st.size - t.size) / dt;
        t.speed = t.speed > 0 ? t.speed * 0.6 + instant * 0.4 : instant; // smoothed, so the number does not jitter
        if (st.size !== t.size) t.grewAt = now;
        t.size = st.size;
        t.at = now;
      });
      for (const [key, t] of this.active) if (now - t.grewAt > STALE_MS) this.active.delete(key);
      this.matchDone(now);
      this.ctx.update();
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------- view

  /** The download that started first stays the headline, so names do not flicker. */
  private lead(): Transfer | null {
    let best: Transfer | null = null;
    for (const t of this.active.values()) if (!best || t.since < best.since) best = t;
    return best;
  }

  private total(): number {
    let sum = 0;
    for (const t of this.active.values()) sum += t.speed;
    return sum;
  }

  private finished(now: number): Finished | null {
    return this.done && now - this.done.at < DONE_MS ? this.done : null;
  }

  /**
   * Arriving: the lead download's speed (its total size is not known, so no bar).
   * Otherwise the last couple of finished files from today, each one tap from open.
   */
  tile(env: SheetEnv): Tile | null {
    const t = this.lead();
    if (t) {
      const total = this.total();
      const more = this.active.size - 1;
      const size = bytes(t.size);
      return { key: 'downloads', tone: 'accent', body: { k: 'stat', icon: 'download', label: clip(t.name, 26), value: total >= 1 ? rate(total) : size, sub: more > 0 ? `${size} · +${more} more` : size, progress: null } };
    }
    const files = this.recent.filter((r) => env.now - r.at < RECENT_MS).slice(0, TILE_ROWS);
    if (!files.length) return null;
    const rows = files.map((f) => ({ key: f.path, title: clip(f.name, 30), detail: agoText(env.now - f.at), action: env.interactive ? 'open' : undefined, arg: f.path, tip: env.interactive ? 'Open' : undefined }));
    return { key: 'downloads', rows: rows.length > 1 ? 2 : 1, body: { k: 'list', icon: 'download', label: 'Downloads', rows } };
  }

  status(): ActivityStatus {
    const now = Date.now();
    const d = this.finished(now);
    const t = this.lead();
    if (!t && !d) return { active: false };
    return {
      active: true,
      weight: 'foreground',
      summary: d ? `Downloaded ${clip(d.name, 28)}` : `${clip(t!.name, 24)} · ${rate(this.total())}`,
      // Sizes are unknown while a file arrives, so the edge circles instead of filling.
      beam: d ? null : { tone: 'info', motion: 'orbit' },
    };
  }

  chip(): ChipView | null {
    const t = this.lead();
    if (this.finished(Date.now())) return { icon: 'check', label: 'Downloaded', tone: 'good' };
    return t ? { icon: 'download', label: rate(this.total()), tone: 'accent' } : null;
  }

  render(env: RenderEnv): Seg[] {
    const compact = env.level === 'compact' || env.level === 'idle';
    const d = this.finished(env.now);
    if (d) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'check', tone: 'good', prio: 0 },
        { t: 'text', key: 'name', text: d.name, weight: 'semibold', prio: 0, min: 60 },
      ];
      if (compact) return segs;
      if (!env.vertical) segs.splice(1, 0, { t: 'text', key: 'label', text: 'Downloaded', tone: 'muted', prio: 4 });
      segs.push(
        { t: 'button', key: 'open', icon: 'external', label: env.vertical ? undefined : 'Open', action: 'open', style: 'primary', side: 'end', prio: 1, tip: 'Open file' },
        { t: 'button', key: 'show', icon: 'folder', label: env.level === 'maximum' && !env.vertical ? 'Show' : undefined, action: 'show', style: 'secondary', side: 'end', prio: 2, tip: 'Show in folder' },
      );
      return segs;
    }

    const t = this.lead();
    if (!t) return [];
    const total = this.total();
    const speed = total >= 1 ? (env.vertical ? bytes(total) : rate(total)) : bytes(t.size);
    const icon: Seg = { t: 'icon', key: 'icon', icon: 'download', tone: 'accent', anim: 'bob', prio: 0 };
    const speedText: Seg = { t: 'text', key: 'speed', text: speed, weight: 'semibold', side: 'end', prio: 0 };
    if (compact) return [icon, speedText];

    const segs: Seg[] = [
      icon,
      { t: 'text', key: 'name', text: t.name, weight: 'semibold', prio: 2, min: 60 },
      { t: 'progress', key: 'bar', value: null, tone: 'accent', w: env.level === 'maximum' ? 140 : 80, side: 'center', prio: 5 },
      speedText,
    ];
    if (env.level === 'maximum' && !env.vertical) segs.push({ t: 'text', key: 'size', text: bytes(t.size), tone: 'muted', size: 'sm', side: 'end', prio: 6 });
    if (this.active.size > 1) segs.push({ t: 'text', key: 'more', text: `+${this.active.size - 1}`, tone: 'muted', size: 'sm', side: 'end', prio: 7 });
    return segs;
  }

  action(name: string, arg?: unknown): void {
    if (name !== 'open' && name !== 'show') return;
    // A tile row passes the path of a download we saw finish (never anything else); the card's buttons mean the file that just did.
    const d = typeof arg === 'string' ? this.recent.find((r) => r.path === arg) : this.finished(Date.now());
    if (!d) return;
    if (name === 'open') void native.open(d.path);
    else void native.reveal(d.path);
    if (this.done?.path === d.path) this.done = null;
    this.ctx.close();
    this.ctx.update();
  }
}
