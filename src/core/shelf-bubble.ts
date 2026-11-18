// The Shelf's circle (Moss's idea): while files wait on the Shelf and its card is closed, a circle
// the bot's size rests on the other side of the pill, showing the newest file's picture and how
// many there are. Pointing at it opens it into a small panel of the files, each dragged straight
// out into a folder or an app; its x clears the Shelf, with Undo for a moment, and
// the circle goes until files are dropped on the Shelf again. Files dropped on the circle itself
// go on the Shelf without opening the island. The island places it (layout.ts shelfRect).

import { icon } from './icons';
import { shelfPanelRect, type Anchor, type Rect } from './layout';
import type { ShelfFile } from '../activities/shelf';

/** The open panel's size, CSS px. */
export const PANEL_W = 300;
export const PANEL_H = 132;
/** Pointing at the circle opens it after this; leaving closes it after this. */
const OPEN_MS = 120;
const CLOSE_MS = 320;
/** A press that moves this far is a drag out; less is a click. */
const DRAG_PX = 4;
/** Room around the panel the pointer may stray into before it closes. */
const LEAVE_MARGIN = 14;

export interface ShelfBubbleHooks {
  /** Runs one of the Shelf's actions (drag-out with a path, drag-all, clear-all, undo). */
  act(name: string, arg?: unknown): void;
  /** A click on the closed circle: the island opens on the Shelf's card. */
  open(): void;
  /** Its size or place changed: the island publishes its hit area again. */
  changed(): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ShelfBubble {
  readonly el: HTMLElement;
  private readonly face: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private circle: Rect | null = null;
  private anchor: Anchor = 'top';
  private area = { width: 1920, height: 1080 };
  private files: ShelfFile[] = [];
  private undo = false;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sig = '';
  /** What layout() last drew, so the island hears only of real changes (it lays the circle out on every frame it draws). */
  private drawn = '';

  constructor(
    stage: HTMLElement,
    private readonly hooks: ShelfBubbleHooks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'shelfb gone';
    const bg = document.createElement('div');
    bg.className = 'shelfb-bg';
    this.face = document.createElement('div');
    this.face.className = 'shelfb-face';
    this.badge = document.createElement('div');
    this.badge.className = 'shelfb-badge';
    this.panel = document.createElement('div');
    this.panel.className = 'shelfb-panel';
    const head = document.createElement('div');
    head.className = 'sbp-head';
    const grip = document.createElement('div');
    grip.className = 'sbp-grip';
    grip.innerHTML = icon('shelf');
    grip.title = 'Drag them all out';
    this.title = document.createElement('div');
    this.title.className = 'sbp-title';
    const close = document.createElement('button');
    close.className = 'sbp-x';
    close.type = 'button';
    close.innerHTML = icon('x');
    close.title = 'Clear the Shelf';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.act('clear-all');
    });
    head.append(grip, this.title, close);
    this.list = document.createElement('div');
    this.list.className = 'sbp-list';
    this.panel.append(head, this.list);
    this.el.append(bg, this.face, this.badge, this.panel);
    stage.append(this.el);

    this.el.addEventListener('pointerenter', () => this.point(true));
    this.el.addEventListener('pointerleave', () => this.point(false));
    this.face.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.undo && !this.files.length) this.hooks.act('undo');
      else this.hooks.open();
    });
    this.dragFrom(grip, () => this.hooks.act('drag-all'));
    this.list.addEventListener('click', (e) => {
      const u = (e.target as HTMLElement).closest('.sbp-undo');
      if (u) {
        e.stopPropagation();
        this.hooks.act('undo');
      }
    });
  }

  /** Where the circle rests (null: not shown), the screen edge the island is on and the area. */
  place(circle: Rect | null, anchor: Anchor, area: { width: number; height: number }): void {
    this.circle = circle;
    this.anchor = anchor;
    this.area = area;
    this.layout();
  }

  /** The Shelf's files and whether Clear can still be undone. */
  show(files: ShelfFile[], undo: boolean): void {
    this.files = files;
    this.undo = undo;
    const sig = JSON.stringify([files, undo]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw();
    this.layout();
  }

  /** Shown: files wait, or Clear can still be undone. */
  get shown(): boolean {
    return this.circle !== null && (this.files.length > 0 || this.undo);
  }

  /** What takes the mouse: the circle, or the open panel. */
  get hitRect(): Rect | null {
    if (!this.shown || !this.circle) return null;
    return this.opened ? shelfPanelRect(this.circle, this.anchor, PANEL_W, PANEL_H, this.area) : this.circle;
  }

  /** (x, y) is on the circle or its open panel, give or take a few pixels. */
  contains(x: number, y: number): boolean {
    const r = this.hitRect;
    const m = 6;
    return Boolean(r && x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m);
  }

  /** Files dragged over the circle: it lights up to take them. */
  dropping(on: boolean): void {
    this.el.classList.toggle('drop', on);
  }

  /** Files just landed on it. */
  bump(): void {
    this.el.classList.remove('bump');
    void this.el.offsetWidth;
    this.el.classList.add('bump');
  }

  /** Where the pointer is (Rust's 'pointer' event; null once it is far away): closes the panel once it has left. */
  pointerAt(p: { x: number; y: number } | null): void {
    if (!this.opened) return;
    const r = this.hitRect;
    const inside = p && r && p.x >= r.x - LEAVE_MARGIN && p.x <= r.x + r.w + LEAVE_MARGIN && p.y >= r.y - LEAVE_MARGIN && p.y <= r.y + r.h + LEAVE_MARGIN;
    if (!inside) this.point(false);
  }

  private point(on: boolean): void {
    clearTimeout(this.timer);
    if (on === this.opened) return;
    this.timer = setTimeout(
      () => {
        if (on && !this.files.length) return;
        this.opened = on;
        this.layout();
      },
      on ? OPEN_MS : CLOSE_MS,
    );
  }

  private layout(): void {
    const shown = this.shown;
    this.el.classList.toggle('gone', !shown);
    if (!shown || !this.circle) {
      if (this.opened) this.opened = false;
      this.changedIf('gone');
      return;
    }
    if (!this.files.length) this.opened = false;
    const r = this.opened ? shelfPanelRect(this.circle, this.anchor, PANEL_W, PANEL_H, this.area) : this.circle;
    this.el.classList.toggle('open', this.opened);
    this.el.classList.toggle('up', this.anchor === 'bottom');
    const s = this.el.style;
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.w}px`;
    s.height = `${r.h}px`;
    s.setProperty('--d', `${this.circle.w}px`);
    this.changedIf(`${this.opened}|${this.anchor}|${r.x},${r.y},${r.w},${r.h}`);
  }

  /** Tells the island only when what is drawn changed: it redraws on that, and lays this out again. */
  private changedIf(key: string): void {
    if (key === this.drawn) return;
    this.drawn = key;
    this.hooks.changed();
  }

  private draw(): void {
    const n = this.files.length;
    const newest = this.files[n - 1];
    // The circle: the newest file's picture, or the Shelf's tray; Undo's arrow while only Undo is left.
    if (!n && this.undo) {
      this.face.innerHTML = icon('history');
      this.face.title = 'Put the files back on the Shelf';
    } else if (newest?.thumb) {
      this.face.innerHTML = '';
      const img = document.createElement('img');
      img.src = newest.thumb;
      img.alt = '';
      img.draggable = false;
      this.face.append(img);
      this.face.title = `${plural(n, 'file')} on the Shelf`;
    } else {
      this.face.innerHTML = icon(newest?.dir ? 'folder' : 'shelf');
      this.face.title = `${plural(n, 'file')} on the Shelf`;
    }
    this.badge.textContent = n > 99 ? '99+' : String(n);
    this.badge.hidden = n < 2;
    this.title.innerHTML = `<b>Shelf</b><span>${n ? plural(n, 'file') : 'Cleared'}</span>`;
    // The panel: one tile per file, newest first, each dragged out on its own.
    this.list.replaceChildren();
    if (!n && this.undo) {
      const u = document.createElement('button');
      u.type = 'button';
      u.className = 'sbp-undo';
      u.textContent = 'Undo';
      this.list.append(u);
      return;
    }
    for (const f of [...this.files].reverse()) {
      const t = document.createElement('div');
      t.className = `sbp-file${f.missing ? ' missing' : ''}`;
      t.title = f.missing ? `${f.name}: not there any more` : `${f.name} · drag it out`;
      const pic = document.createElement('div');
      pic.className = 'sbp-pic';
      if (f.thumb) {
        const img = document.createElement('img');
        img.src = f.thumb;
        img.alt = '';
        img.draggable = false;
        pic.append(img);
      } else pic.innerHTML = icon(f.dir ? 'folder' : 'file');
      const name = document.createElement('div');
      name.className = 'sbp-name';
      name.textContent = f.name;
      t.append(pic, name);
      if (!f.missing) this.dragFrom(t, () => this.hooks.act('drag-out', f.path));
      this.list.append(t);
    }
  }

  /** A press on `el` that moves a few pixels starts a real drag out of the island. */
  private dragFrom(el: HTMLElement, start: () => void): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (m: PointerEvent) => {
        if (Math.abs(m.clientX - x0) < DRAG_PX && Math.abs(m.clientY - y0) < DRAG_PX) return;
        stop();
        start();
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
    });
  }
}
