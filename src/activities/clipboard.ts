// Clipboard: what you just copied, with Open for links and a shortcut to
// Windows' clipboard history. Password managers' copies never arrive (Rust
// drops them); with the clipboard privacy setting off the content is not shown.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { clip } from '../core/format';
import { native, type ClipboardEvent as ClipEvent } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetRow, Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Copied = { kind: 'text' | 'files' | 'image'; preview: string | null; url: string | null; count: number; at: number };
/** A text copied earlier, kept so the tile can put it back. `seq` is the native clipboard sequence number. */
type Item = { seq: number; text: string };

const SHOW_MS = 2500;
const WEB_LINK = /^https?:\/\/\S+$/i;
/** How many recent texts the tile lists (and the most this activity ever keeps). */
const HISTORY = 3;

export class ClipboardActivity extends BaseActivity {
  private c: Copied | null = null;
  private history: Item[] = [];

  constructor() {
    super('clipboard');
  }

  protected init(): void {
    this.listen<ClipEvent>('clipboard', (e) => this.apply(e));
  }

  private apply(e: ClipEvent): void {
    if (e.excluded || (e.kind !== 'text' && e.kind !== 'files' && e.kind !== 'image')) return;
    let preview: string | null = null;
    let url: string | null = null;
    // Without the privacy permission the text is not even kept.
    if (!this.ctx.settings().privacy.clipboardContent) this.history = [];
    else if (e.kind === 'text') {
      const raw = (e.text ?? '').slice(0, 2000).trim();
      preview = clip(raw.replace(/\s+/g, ' '), 60) || null;
      if (WEB_LINK.test(raw)) url = raw;
      // Copying a text again moves it to the front rather than listing it twice.
      if (raw) this.history = [{ seq: e.seq, text: raw }, ...this.history.filter((h) => h.text !== raw)].slice(0, HISTORY);
    }
    this.c = { kind: e.kind, preview, url, count: Array.isArray(e.files) ? e.files.length : 0, at: Date.now() };
    this.ctx.surface({ key: 'copy', ms: SHOW_MS, level: 'expanded' });
    this.ctx.update();
  }

  private label(c: Copied): string {
    if (c.kind === 'image') return 'Copied image';
    if (c.kind === 'files') return c.count > 0 ? `Copied ${c.count} ${c.count === 1 ? 'file' : 'files'}` : 'Copied files';
    return 'Copied';
  }

  status(): ActivityStatus {
    const c = this.c;
    if (!c || Date.now() - c.at >= SHOW_MS) return { active: false };
    return { active: true, weight: 'foreground', summary: this.label(c) }; // never the content: summaries show in lists and tooltips
  }

  /** The last few texts, each one tap from the clipboard again. Always there: with nothing copied it says so. */
  tile(env: SheetEnv): Tile {
    const allowed = this.ctx.settings().privacy.clipboardContent;
    const rows: SheetRow[] = (allowed ? this.history : []).map((h) => ({
      key: String(h.seq),
      title: clip(h.text.replace(/\s+/g, ' '), 40),
      action: env.interactive ? 'copy' : undefined,
      arg: h.seq,
      tip: env.interactive ? 'Copy again' : undefined,
    }));
    return { key: 'clipboard', rows: rows.length > 1 ? 2 : 1, body: { k: 'list', icon: 'clipboard', label: 'Clipboard', rows, empty: allowed ? 'Copy something' : 'Content hidden' } };
  }

  render(env: RenderEnv): Seg[] {
    const c = this.c;
    if (!c) return [];
    const icon = c.kind === 'files' ? 'folder' : c.kind === 'image' ? 'image' : c.url ? 'link' : 'clipboard';
    const segs: Seg[] = [{ t: 'icon', key: 'icon', icon, tone: 'accent', prio: 0 }];
    if (env.vertical) {
      if (c.kind === 'files' && c.count > 0) segs.push({ t: 'text', key: 'count', text: String(c.count), weight: 'semibold', prio: 0 });
    } else if (env.level === 'compact' || env.level === 'idle') {
      segs.push({ t: 'text', key: 'label', text: this.label(c), weight: 'semibold', prio: 0 });
    } else if (c.preview) {
      segs.push(
        { t: 'text', key: 'label', text: this.label(c), tone: 'muted', prio: 3 },
        { t: 'text', key: 'preview', text: c.preview, weight: 'semibold', prio: 0, min: 60 },
      );
    } else segs.push({ t: 'text', key: 'label', text: this.label(c), weight: 'semibold', prio: 0 });

    if (env.level === 'maximum') {
      const label = (text: string) => (env.vertical ? undefined : text);
      if (c.url) segs.push({ t: 'button', key: 'open', icon: 'external', label: label('Open'), action: 'open', style: 'primary', side: 'end', prio: 1, tip: 'Open link' });
      segs.push({ t: 'button', key: 'history', icon: 'history', label: label('History'), action: 'history', style: 'secondary', side: 'end', prio: 2, tip: 'Clipboard history (Win+V)' });
    }
    return segs;
  }

  action(name: string, arg?: unknown): void {
    if (name === 'copy') {
      // A tile row names its text by sequence number; nothing else is ever put on the clipboard.
      const item = this.ctx.settings().privacy.clipboardContent ? this.history.find((h) => h.seq === arg) : undefined;
      if (!item) return;
      void native.clipboardSetText(item.text);
    } else if (name === 'open' && this.c?.url) void native.open(this.c.url);
    else if (name === 'history') void native.clipboardHistory();
    else return;
    this.ctx.close();
  }
}
