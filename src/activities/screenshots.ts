// Screenshots: a new image in the Screenshots folder, with a thumbnail and
// Copy, Edit, Open and Show.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { agoText, baseName } from '../core/format';
import { native } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { SheetButton, Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Options = { preview: boolean };
type FsChange = { id: string; kind: string; paths: string[] };
type Shot = { path: string; name: string; src: string | null; at: number };

const IMAGE = /\.(png|jpe?g)$/i;
const SHOT_MS = 7000;
/** The tile keeps offering a screenshot this long. */
const TILE_MS = 3600000;
const FLASH_MS = 1500;
const MAX_BYTES = 8_000_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function base64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A small JPEG data URL. The full file as base64 would be megabytes inside
 * every layout signature, and the slot on the pill is only ~30 px wide.
 */
async function thumbnail(b: Uint8Array, mime: string): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(new Blob([b.slice()], { type: mime }));
    const scale = Math.min(1, 160 / Math.max(bmp.width, bmp.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}

export class ScreenshotsActivity extends BaseActivity {
  private shot: Shot | null = null;
  private flash: { text: string; tone: Tone; until: number } | null = null;
  private readonly watching: string[] = [];
  private readonly seen = new Map<string, number>();

  constructor() {
    super('screenshots');
  }

  protected async init(): Promise<void> {
    this.listen<FsChange>('fs-change', (e) => this.onChange(e));
    this.onDispose(() => this.watching.forEach((id) => void native.unwatch(id)));
    const { screenshots } = await native.knownFolders();
    for (const [i, dir] of screenshots.entries()) {
      if (!this.alive) break;
      const id = `shots-${i}`;
      if (await native.watch(id, dir)) this.watching.push(id);
    }
    // Stopped while the watches were being set up: the disposer above has already run.
    if (!this.alive) this.watching.forEach((id) => void native.unwatch(id));
  }

  private onChange(e: FsChange): void {
    if (!e.id.startsWith('shots-') || e.kind !== 'create') return;
    for (const path of e.paths) {
      if (!IMAGE.test(path)) continue;
      const now = Date.now();
      if (now - (this.seen.get(path) ?? 0) < 3000) continue; // some writers report a create twice
      this.seen.set(path, now);
      if (this.seen.size > 40) this.seen.delete(this.seen.keys().next().value as string);
      // The file is still being written when its create event arrives.
      setTimeout(() => {
        if (this.alive) void this.capture(path);
      }, 400);
    }
  }

  private async capture(path: string): Promise<void> {
    let [st] = await native.statMany([path]);
    if (st && st.size === 0) {
      await sleep(400);
      [st] = await native.statMany([path]);
    }
    if (!st || st.dir || !this.alive) return;

    const wantPreview = this.ctx.options<Partial<Options>>().preview !== false && this.ctx.settings().privacy.screenshotPreview;
    let src: string | null = null;
    if (wantPreview) {
      const bytes = await native.readBytes(path, MAX_BYTES);
      if (bytes) {
        const mime = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
        src = (await thumbnail(bytes, mime)) ?? (bytes.length <= 300_000 ? `data:${mime};base64,${base64(bytes)}` : null);
      }
    }
    if (!this.alive) return;
    this.shot = { path, name: baseName(path), src, at: Date.now() };
    this.flash = null;
    this.ctx.surface({ key: 'shot', ms: SHOT_MS, level: 'expanded' });
    this.saw('screenshot', `screenshots:${path}`);
    this.ctx.update();
  }

  status(): ActivityStatus {
    if (!this.shot || Date.now() - this.shot.at >= SHOT_MS) return { active: false };
    return { active: true, weight: 'foreground', summary: 'Screenshot' };
  }

  /** The latest screenshot for an hour: how long ago, and Copy, Open and Edit (icon-only, to fit a cell). */
  tile(env: SheetEnv): Tile | null {
    const s = this.shot;
    if (!s || env.now - s.at >= TILE_MS) return null;
    const flash = this.flash && env.now < this.flash.until ? this.flash : null;
    const buttons: SheetButton[] = [];
    if (env.interactive) {
      // Rust can only put PNGs on the clipboard.
      if (/\.png$/i.test(s.name)) buttons.push({ key: 'copy', icon: 'copy', action: 'copy', style: 'primary', tip: 'Copy image' });
      buttons.push(
        { key: 'open', icon: 'external', action: 'open', style: 'secondary', tip: 'Open' },
        { key: 'edit', icon: 'edit', action: 'edit', style: 'secondary', tip: 'Edit in Paint' },
      );
    }
    return { key: 'screenshot', tone: flash?.tone, body: { k: 'actions', icon: 'screenshot', label: 'Screenshot', sub: flash?.text ?? agoText(env.now - s.at), buttons } };
  }

  render(env: RenderEnv): Seg[] {
    const s = this.shot;
    if (!s) return [];
    const flash = this.flash && env.now < this.flash.until ? this.flash : null;
    const segs: Seg[] = [
      { t: 'art', key: 'art', src: s.src, icon: 'screenshot', prio: 3 },
      { t: 'text', key: 'label', text: flash?.text ?? 'Screenshot', tone: flash?.tone ?? 'default', weight: 'semibold', prio: 0 },
    ];
    if (env.level === 'compact' || env.level === 'idle') return segs;

    const wide = env.level === 'maximum' && !env.vertical;
    if (wide) segs.push({ t: 'text', key: 'name', text: s.name, tone: 'muted', size: 'sm', prio: 6 });
    // Rust can only put PNGs on the clipboard.
    if (/\.png$/i.test(s.name)) {
      segs.push({ t: 'button', key: 'copy', icon: flash?.text === 'Copied' ? 'check' : 'copy', label: env.vertical ? undefined : 'Copy', action: 'copy', style: 'primary', side: 'end', prio: 1, tip: 'Copy image' });
    }
    segs.push(
      { t: 'button', key: 'edit', icon: 'edit', label: wide ? 'Edit' : undefined, action: 'edit', style: 'secondary', side: 'end', prio: 3, tip: 'Edit in Paint' },
      { t: 'button', key: 'open', icon: 'external', label: wide ? 'Open' : undefined, action: 'open', style: 'secondary', side: 'end', prio: 2, tip: 'Open' },
      { t: 'button', key: 'show', icon: 'folder', label: wide ? 'Show' : undefined, action: 'show', style: 'ghost', side: 'end', prio: 4, tip: 'Show in folder' },
    );
    return segs;
  }

  async action(name: string): Promise<void> {
    const s = this.shot;
    if (!s) return;
    if (name === 'copy') {
      const ok = await native.clipboardCopyImage(s.path);
      this.flash = { text: ok ? 'Copied' : 'Copy failed', tone: ok ? 'good' : 'bad', until: Date.now() + FLASH_MS };
      this.later(FLASH_MS + 30, () => this.ctx.update());
      this.ctx.update();
      return;
    }
    if (name === 'edit') void native.edit(s.path);
    else if (name === 'open') void native.open(s.path);
    else if (name === 'show') void native.reveal(s.path);
    else return;
    this.shot = null; // the card has done its job
    this.ctx.close();
    this.ctx.update();
  }
}
