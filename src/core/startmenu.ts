// Island's own Start menu (Moss, 11-18: "a custom start menu ... that displays all of the same options
// the windows start menu does, but instead it's our ui"). Its own window ("start", src-tauri/src/
// startmenu.rs) stands on the taskbar's inner edge; this page draws the menu in it and slides it out
// from the Start button. What it shows, as Windows 11's Start: a search over every app (and the web or
// your files), your pinned apps, All apps A to Z, the files you opened lately, you, Settings, File
// Explorer and the power menu. The island sends its look and pins ('start-frame').

import '../styles/start.css';
import { cleanFolders, dockSlots, foldApps, FOLD_MS, FOLD_ZONE, FOLDER_NAME, folderKey, glideFrom, moveSlot, popIn, sinkInto, staggerIn, unfoldApp, type DockApp, type DockSlot } from './dock';
import { applyGlass } from './glass';
import { isTauri, native, on, sendTo, type InstalledApp } from './native';
import type { DockFolder, PillColor } from './settings';

/** What the island tells the menu. */
export interface StartFrame {
  color: PillColor;
  glass?: number;
  accent: string;
  pins: InstalledApp[];
  /** Pinned apps dropped onto one another (as the taskbar's: dock.ts dockSlots). */
  folders?: DockFolder[];
}

/** A drag on a pinned app starts once the pointer has moved this far (CSS px); less is a click. */
const DRAG_PX = 5;
/** Pinned places Start shows (three rows of six). */
const PINNED_MAX = 18;

/** What Rust says when it opens: the side the taskbar is on, the menu's box in the window, and the
 *  point it grows out of (the Start button). */
interface StartOpen {
  side: 'bottom' | 'top' | 'left' | 'right';
  menu: [number, number, number, number];
  origin: [number, number];
  gen: number;
}

interface RecentFile {
  name: string;
  path: string;
  lnk: string;
  at: number;
}

/** Apps whose name, or a word of it, starts with what was typed first; then any containing it. */
export function searchApps(apps: readonly InstalledApp[], query: string, max = 8): InstalledApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: InstalledApp[] = [];
  const words: InstalledApp[] = [];
  const inside: InstalledApp[] = [];
  for (const a of apps) {
    const n = a.name.toLowerCase();
    if (n.startsWith(q)) starts.push(a);
    else if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) words.push(a);
    else if (n.includes(q)) inside.push(a);
  }
  return [...starts, ...words, ...inside].slice(0, max);
}

/** All apps under their first letter (# for the rest), A to Z. */
export function byLetter(apps: readonly InstalledApp[]): Array<[string, InstalledApp[]]> {
  const groups = new Map<string, InstalledApp[]>();
  for (const a of [...apps].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))) {
    const c = a.name.trim().charAt(0).toUpperCase();
    const k = /[A-Z]/.test(c) ? c : '#';
    const g = groups.get(k);
    if (g) g.push(a);
    else groups.set(k, [a]);
  }
  return [...groups].sort((a, b) => (a[0] === '#' ? -1 : b[0] === '#' ? 1 : a[0].localeCompare(b[0])));
}

/** "Just now", "12m ago", "3h ago", "Yesterday", or the day. */
export function agoText(at: number, now: number): string {
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  if (h < 48) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const SVG = {
  search: '<svg viewBox="0 0 24 24" class="line"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  power: '<svg viewBox="0 0 24 24" class="line"><path d="M12 3.5v8"/><path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0"/></svg>',
  settings: '<svg viewBox="0 0 24 24" class="line"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.1 7.4l2 1.2M17.9 15.4l2 1.2M4.1 16.6l2-1.2M17.9 8.6l2-1.2"/></svg>',
  folder: '<svg viewBox="0 0 24 24" class="line"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  web: '<svg viewBox="0 0 24 24" class="line"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>',
  file: '<svg viewBox="0 0 24 24" class="line"><path d="M7 3.5h6.5L18 8v12.5H7z"/><path d="M13.5 3.5V8H18"/></svg>',
  back: '<svg viewBox="0 0 24 24" class="line"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg>',
  next: '<svg viewBox="0 0 24 24" class="line"><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" class="line"><rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  sleep: '<svg viewBox="0 0 24 24" class="line"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg>',
  signout: '<svg viewBox="0 0 24 24" class="line"><path d="M14 4.5H6.5v15H14"/><path d="M11 12h9M17 8.5l3.5 3.5-3.5 3.5"/></svg>',
  restart: '<svg viewBox="0 0 24 24" class="line"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/></svg>',
  app: '<svg viewBox="0 0 24 24" class="line"><rect x="4.5" y="4.5" width="15" height="15" rx="4"/></svg>',
};

/** The pins as the taskbar's folder functions take them (dock.ts): each one pinned, by its lower-case target. */
export function startApps(pins: readonly InstalledApp[]): DockApp[] {
  return pins.map((p) => ({ key: p.target.toLowerCase(), name: p.name, icon: null, windows: [], front: false, pinned: true }));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** This window is the menu. */
export async function runStart(stage: HTMLElement): Promise<void> {
  const root = document.documentElement;
  root.classList.add('start-window');
  let frame: StartFrame | null = null;
  let apps: InstalledApp[] = [];
  let recent: RecentFile[] = [];
  const icons = new Map<string, string | null>();
  let view: 'home' | 'all' = 'home';
  let query = '';
  let gen = 0;
  let pick = 0;

  const menu = el('div', 'sm');
  const search = el('label', 'sm-search');
  const field = el('input', 'sm-field');
  field.type = 'text';
  field.placeholder = 'Search for apps, settings and documents';
  field.spellcheck = false;
  search.append(el('span', 'sm-search-ico', SVG.search), field);
  const body = el('div', 'sm-body');
  const foot = el('div', 'sm-foot');
  menu.append(search, body, foot);
  stage.append(menu);

  const iconOf = (target: string): HTMLElement => {
    const box = el('span', 'sm-ico');
    const got = icons.get(target.toLowerCase());
    if (got) {
      const img = document.createElement('img');
      img.src = got;
      img.alt = '';
      img.draggable = false;
      box.append(img);
    } else box.innerHTML = SVG.app;
    return box;
  };
  /** Fetches icons not seen yet, then draws again. */
  const wantIcons = (targets: string[]) => {
    const want = [...new Set(targets)].filter((t) => !icons.has(t.toLowerCase()));
    if (!want.length) return;
    for (const t of want) icons.set(t.toLowerCase(), null);
    void native.appsIcons(want, 48).then((got) => {
      want.forEach((t, i) => icons.set(t.toLowerCase(), got[i] ?? null));
      draw();
    });
  };

  const close = () => void native.startShow(false);
  const launch = (a: InstalledApp) => {
    close();
    void native.wsLaunch({ kind: 'app', path: a.target, args: '', cwd: '' }, '');
  };
  const pins = () => frame?.pins ?? [];
  const folders = () => frame?.folders ?? [];
  /** The pins and folders changed (either null: as they are); each folder keeps to pinned apps. */
  const setLayout = (list: InstalledApp[] | null, fs: DockFolder[] | null) => {
    const p = list ?? pins();
    const before = JSON.stringify(folders());
    const f = cleanFolders(fs ?? folders(), p);
    if (frame) {
      frame.pins = p;
      frame.folders = f;
    }
    // The folders first: the pins' change makes the island send its frame, which should have them.
    if (JSON.stringify(f) !== before) void sendTo('island', 'start-folders', f);
    if (list) void sendTo('island', 'start-pins', p);
    draw();
  };
  const setPins = (list: InstalledApp[]) => setLayout(list, null);
  const pinOf = (key: string) => pins().find((p) => p.target.toLowerCase() === key) ?? null;
  const folderOf = (key: string) => folders().find((f) => f.apps.includes(key)) ?? null;
  const appMenu = async (a: InstalledApp) => {
    if (!isTauri) return;
    const { Menu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
    const at = pins().findIndex((p) => p.target.toLowerCase() === a.target.toLowerCase());
    const items = [
      await MenuItem.new({ text: 'Open', action: () => launch(a) }),
      await MenuItem.new({
        text: at >= 0 ? 'Unpin from Start' : 'Pin to Start',
        action: () => setPins(at >= 0 ? pins().filter((_, i) => i !== at) : [...pins(), a]),
      }),
    ];
    const inFolder = folderOf(a.target.toLowerCase());
    if (at > 0 && !inFolder) items.push(await MenuItem.new({ text: 'Move to front', action: () => setPins([a, ...pins().filter((_, i) => i !== at)]) }));
    if (inFolder) {
      const out = () => {
        const c = unfoldApp(pins(), folders(), a.target.toLowerCase());
        if (c) setLayout(c.pins, c.folders ?? null);
      };
      items.push(await MenuItem.new({ text: 'Remove from folder', action: out }));
    }
    if (/\.exe$/i.test(a.target)) {
      items.push(
        (await PredefinedMenuItem.new({ item: 'Separator' })) as never,
        await MenuItem.new({ text: 'Run as administrator', action: () => void native.startAdmin(a.target) }),
        await MenuItem.new({ text: 'Open file location', action: () => void native.startReveal(a.target) }),
      );
    }
    await (await Menu.new({ items })).popup();
  };
  const appButton = (a: InstalledApp, cls: string) => {
    const b = el('button', cls);
    b.title = a.name;
    b.append(iconOf(a.target), el('span', 'sm-name'));
    b.querySelector('.sm-name')!.textContent = a.name;
    b.addEventListener('click', () => {
      if (!swallowClick) launch(a);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void appMenu(a);
    });
    return b;
  };

  const section = (title: string, extra?: HTMLElement) => {
    const head = el('div', 'sm-head');
    const t = el('b', '');
    t.textContent = title;
    head.append(t);
    if (extra) head.append(extra);
    return head;
  };
  const pill = (text: string, ico: string, onclick: () => void) => {
    const b = el('button', 'sm-pill');
    b.append(el('span', '', text), el('i', '', ico));
    b.querySelector('span')!.textContent = text;
    b.addEventListener('click', onclick);
    return b;
  };

  const drawSearch = () => {
    const found = searchApps(apps, query);
    wantIcons(found.map((a) => a.target));
    pick = Math.min(pick, Math.max(0, found.length + 1));
    const list = el('div', 'sm-results');
    const rows: HTMLElement[] = found.map((a) => appButton(a, 'sm-row'));
    const web = el('button', 'sm-row');
    web.append(el('span', 'sm-ico', SVG.web), el('span', 'sm-name'));
    web.querySelector('.sm-name')!.textContent = `Search the web for "${query.trim()}"`;
    web.addEventListener('click', () => void native.startSearch('web', query));
    const files = el('button', 'sm-row');
    files.append(el('span', 'sm-ico', SVG.folder), el('span', 'sm-name'));
    files.querySelector('.sm-name')!.textContent = `Search your files for "${query.trim()}"`;
    files.addEventListener('click', () => void native.startSearch('files', query));
    rows.push(web, files);
    rows.forEach((r, i) => r.classList.toggle('picked', i === pick));
    list.append(section(found.length ? 'Best match' : 'No app with that name'), ...rows);
    body.replaceChildren(list);
  };

  // Folders (Moss, 11-20: "like it does on windows ... the same way that folders on the taskbar do"):
  // a pinned app held a moment on another makes a folder of the two, or goes into a folder held on; a
  // click opens it over Start, its name at the top (click it to rename); dragged out of it, an app is
  // back among the pins. Pinned apps drag to new places too, the others making room.
  let swallowClick = false;
  /** A pinned app is being dragged: Start isn't drawn again under it (an icon arriving) until it is dropped. */
  let homeDrag = false;
  const swallow = () => {
    swallowClick = true;
    window.setTimeout(() => (swallowClick = false), 0);
  };
  /** A folder's place among the pins: up to four of its apps' icons in a rounded square, its name. */
  const folderButton = (s: Extract<DockSlot, { kind: 'folder' }>) => {
    const b = el('button', 'sm-tile sm-folder');
    b.title = s.folder.name;
    const ico = el('span', 'sm-ico');
    const g = el('span', 'sm-fgrid');
    for (const a of s.apps.slice(0, 4)) {
      const got = icons.get(a.key);
      if (got) {
        const img = document.createElement('img');
        img.src = got;
        img.alt = '';
        img.draggable = false;
        g.append(img);
      } else g.append(el('i', 'sm-fblank'));
    }
    ico.append(g);
    const n = el('span', 'sm-name');
    n.textContent = s.folder.name;
    b.append(ico, n);
    b.addEventListener('click', () => {
      if (!swallowClick) openFolder(s.folder.id);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void folderMenu(s.folder);
    });
    return b;
  };
  const slotButton = (s: DockSlot) => {
    const b = s.kind === 'folder' ? folderButton(s) : appButton(pinOf(s.key) ?? { name: s.app.name, target: s.key }, 'sm-tile');
    b.dataset.key = s.key;
    return b;
  };
  const folderMenu = async (f: DockFolder) => {
    if (!isTauri) return;
    const { Menu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
    const items = [
      await MenuItem.new({ text: 'Open folder', action: () => openFolder(f.id) }),
      await MenuItem.new({ text: 'Rename folder', action: () => openFolder(f.id, true) }),
      (await PredefinedMenuItem.new({ item: 'Separator' })) as never,
      await MenuItem.new({ text: 'Ungroup', action: () => setLayout(null, folders().filter((x) => x.id !== f.id)) }),
    ];
    await (await Menu.new({ items })).popup();
  };

  /** Pinned places dragged in `grid`: to a new place or onto another (a folder); in an open folder, out of it. */
  const wireDrag = (grid: HTMLElement, inFolder: boolean) => {
    type Drag = { t: HTMLElement; id: number; x0: number; y0: number; gx: number; gy: number; moved: boolean; from: number; over: HTMLElement | null; armed: boolean; wait: number };
    let d: Drag | null = null;
    const tiles = () => [...grid.querySelectorAll<HTMLElement>(':scope > .sm-tile')];
    const unarm = (m: Drag) => {
      window.clearTimeout(m.wait);
      m.over?.classList.remove('sm-fold-on');
      m.over = null;
      m.armed = false;
    };
    /** The dragged tile under the pointer, wherever its place in the grid is now. */
    const follow = (m: Drag, e: PointerEvent) => {
      const g = grid.getBoundingClientRect();
      m.t.style.transform = `translate(${e.clientX - g.left - m.gx - m.t.offsetLeft}px, ${e.clientY - g.top - m.gy - m.t.offsetTop}px)`;
    };
    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = (e.target as HTMLElement).closest<HTMLElement>('.sm-tile');
      if (!t || t.parentElement !== grid || !t.dataset.key) return;
      const g = grid.getBoundingClientRect();
      d = { t, id: e.pointerId, x0: e.clientX, y0: e.clientY, gx: e.clientX - g.left - t.offsetLeft, gy: e.clientY - g.top - t.offsetTop, moved: false, from: tiles().indexOf(t), over: null, armed: false, wait: 0 };
    });
    grid.addEventListener('pointermove', (e) => {
      const m = d;
      if (!m || e.pointerId !== m.id) return;
      if (!m.moved) {
        if (Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < DRAG_PX) return;
        m.moved = true;
        grid.setPointerCapture(e.pointerId);
        m.t.classList.add('moving');
        grid.classList.add('sm-dragging');
        if (!inFolder) homeDrag = true;
      }
      follow(m, e);
      if (inFolder) {
        // Out past the folder's edge: let go, and it is out of the folder.
        const r = fpanel.getBoundingClientRect();
        fpanel.classList.toggle('sm-dropping', e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
        return;
      }
      const g = grid.getBoundingClientRect();
      const px = e.clientX - g.left;
      const py = e.clientY - g.top;
      const others = tiles().filter((k) => k !== m.t);
      const o = others.find((k) => px >= k.offsetLeft && px <= k.offsetLeft + k.offsetWidth && py >= k.offsetTop && py <= k.offsetTop + k.offsetHeight);
      if (!o) return unarm(m);
      const cx = o.offsetLeft + o.offsetWidth / 2;
      const cy = o.offsetTop + o.offsetHeight / 2;
      // Over its middle (an app dragged, not a folder): held there, it folds in.
      if (!m.t.classList.contains('sm-folder') && Math.abs(px - cx) < o.offsetWidth * FOLD_ZONE && Math.abs(py - cy) < o.offsetHeight * 0.32) {
        if (m.over === o) return;
        unarm(m);
        m.over = o;
        m.wait = window.setTimeout(() => {
          if (d !== m || m.over !== o) return;
          m.armed = true;
          o.classList.add('sm-fold-on');
        }, FOLD_MS);
        return;
      }
      unarm(m);
      // Else between: before it or after it, the others sliding over to make room.
      const at = others.indexOf(o) + (px > cx ? 1 : 0);
      if (tiles().indexOf(m.t) === at) return;
      const was = new Map(others.map((k) => [k, [k.offsetLeft, k.offsetTop]] as const));
      grid.insertBefore(m.t, others[at] ?? null);
      for (const k of others) {
        const [x, y] = was.get(k)!;
        const dx = x - k.offsetLeft;
        const dy = y - k.offsetTop;
        if (!dx && !dy) continue;
        k.style.transition = 'none';
        k.style.transform = `translate(${dx}px, ${dy}px)`;
        void k.offsetWidth;
        k.style.transition = '';
        k.style.transform = '';
      }
      follow(m, e);
    });
    const end = async (e: PointerEvent) => {
      const m = d;
      if (!m || e.pointerId !== m.id) return;
      const target = m.armed && m.over && e.type === 'pointerup' ? m.over : null;
      const onto = target?.dataset.key;
      unarm(m);
      d = null;
      if (!m.moved) return;
      swallow();
      // Where it was let go, for it to glide on from there.
      const was = m.t.querySelector('.sm-ico')!.getBoundingClientRect();
      m.t.classList.remove('moving');
      m.t.style.transform = '';
      grid.classList.remove('sm-dragging');
      const key = m.t.dataset.key!;
      if (inFolder) {
        const out = fpanel.classList.contains('sm-dropping');
        fpanel.classList.remove('sm-dropping');
        const c = out && e.type === 'pointerup' ? unfoldApp(pins(), folders(), key) : null;
        if (c) setLayout(c.pins, c.folders ?? null);
        else drawFolder(true);
        settle(key, was);
        return;
      }
      const apps = startApps(pins());
      const c = onto ? foldApps(pins(), apps, folders(), key, onto, Date.now().toString(36)) : moveSlot(pins(), apps, folders(), key, tiles().indexOf(m.t));
      if (c && onto && target) await sinkInto(m.t, was, target.querySelector('.sm-ico')!.getBoundingClientRect());
      homeDrag = false;
      if (c?.pins || c?.folders) setLayout(c.pins, c.folders ?? null);
      else draw();
      if (!onto) settle(key, was);
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
  };

  // An open folder: over Start, the rest dimmed behind it; a click there closes it.
  const fback = el('div', 'sm-fback');
  const fpanel = el('div', 'sm-fpanel');
  const fname = el('input', 'sm-fname');
  fname.maxLength = 40;
  fname.spellcheck = false;
  fname.placeholder = FOLDER_NAME;
  fname.title = 'Rename';
  const fgrid = el('div', 'sm-fgrid-box');
  fpanel.append(fname, fgrid);
  fback.append(fpanel);
  menu.append(fback);
  wireDrag(fgrid, true);
  let folderOn: string | null = null;
  fback.addEventListener('pointerdown', (e) => {
    if (e.target === fback) closeFolder();
  });
  const renameFolder = () => {
    const f = folders().find((x) => x.id === folderOn);
    const v = fname.value.trim() || FOLDER_NAME;
    if (!f || v === f.name) return;
    setLayout(null, folders().map((x) => (x === f ? { ...x, name: v } : x)));
  };
  fname.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fname.blur();
    else if (e.key === 'Escape') {
      e.stopPropagation();
      fname.value = folders().find((x) => x.id === folderOn)?.name ?? '';
      fname.blur();
    }
  });
  fname.addEventListener('blur', renameFolder);
  const openFolder = (id: string, rename = false) => {
    folderOn = id;
    drawFolder(true);
    // It grows out of the folder's own place (and goes back into it).
    const from = [...body.querySelectorAll<HTMLElement>('.sm-grid > .sm-folder')].find((x) => x.dataset.key === folderKey(id));
    if (from) {
      const f = from.getBoundingClientRect();
      const box = fback.getBoundingClientRect();
      fpanel.style.transformOrigin = `${f.left + f.width / 2 - box.left - fpanel.offsetLeft}px ${f.top + f.height / 2 - box.top - fpanel.offsetTop}px`;
    } else fpanel.style.transformOrigin = '';
    fback.classList.add('on');
    staggerIn([...fgrid.children]);
    if (rename)
      window.setTimeout(() => {
        fname.focus();
        fname.select();
      }, 60);
  };
  function closeFolder(): void {
    if (folderOn === null) return;
    if (document.activeElement === fname) fname.blur();
    folderOn = null;
    fback.classList.remove('on');
  }
  /** The open folder's apps (and its name, unless it is being typed in); `force`: drawn again even mid-drag. */
  function drawFolder(force = false): void {
    if (folderOn === null) return;
    const s = dockSlots(startApps(pins()), folders()).find((x) => x.key === folderKey(folderOn!));
    if (!s || s.kind !== 'folder') return closeFolder();
    if (document.activeElement !== fname) fname.value = s.folder.name;
    if (!force && fgrid.querySelector('.moving')) return;
    wantIcons(s.apps.map((a) => pinOf(a.key)?.target ?? a.key));
    fgrid.style.setProperty('--sm-fcols', String(Math.min(4, Math.max(2, Math.ceil(Math.sqrt(s.apps.length))))));
    fgrid.replaceChildren(...s.apps.map((a) => slotButton({ kind: 'app', key: a.key, app: a })));
  }

  /** The pinned place `key`, just drawn again, glides from `was` (where its icon was let go) into it. */
  const settle = (key: string, was: DOMRect) => {
    const t = [...body.querySelectorAll<HTMLElement>('.sm-grid > .sm-tile')].find((x) => x.dataset.key === key);
    const ico = t?.querySelector('.sm-ico');
    if (!ico) return;
    const now = ico.getBoundingClientRect();
    glideFrom(t!, was.left - now.left, was.top - now.top);
  };
  /** What each pinned place showed last time (a folder: its apps), so a new one, or a folder that
   *  gained or lost an app, pops in; null until Pinned was drawn once. */
  let homeSigs: Map<string, string> | null = null;
  const sigOf = (s: DockSlot) => (s.kind === 'folder' ? s.apps.map((a) => a.key).join('|') : '');

  const drawHome = () => {
    if (homeDrag) return;
    const shown = pins();
    wantIcons(shown.map((a) => a.target));
    const grid = el('div', 'sm-grid');
    const slots = dockSlots(startApps(shown), folders()).slice(0, PINNED_MAX);
    const tiles = slots.map(slotButton);
    grid.append(...tiles);
    wireDrag(grid, false);
    const was = homeSigs;
    homeSigs = new Map(slots.map((s) => [s.key, sigOf(s)]));
    if (was) slots.forEach((s, i) => {
      if (was.get(s.key) !== sigOf(s)) popIn(tiles[i].querySelector('.sm-ico')!);
    });
    if (!shown.length) grid.append(el('p', 'sm-empty', 'Right-click an app in All apps and pick Pin to Start.'));
    const rec = el('div', 'sm-recent');
    for (const f of recent.slice(0, 6)) {
      const b = el('button', 'sm-file');
      b.title = f.path;
      const ico = el('span', 'sm-ico', SVG.file);
      const got = icons.get(f.path.toLowerCase());
      if (got) {
        ico.innerHTML = '';
        const img = document.createElement('img');
        img.src = got;
        img.alt = '';
        ico.append(img);
      }
      const text = el('span', 'sm-ftext');
      const n = el('b', '');
      n.textContent = f.name;
      const when = el('span', '');
      when.textContent = agoText(f.at, Date.now());
      text.append(n, when);
      b.append(ico, text);
      b.addEventListener('click', () => void native.startOpenRecent(f.lnk));
      rec.append(b);
    }
    wantIcons(recent.slice(0, 6).map((f) => f.path));
    if (!recent.length) rec.append(el('p', 'sm-empty', 'Files you open show here.'));
    body.replaceChildren(
      section('Pinned', pill('All apps', SVG.next, () => ((view = 'all'), draw()))),
      grid,
      section('Recommended'),
      rec,
    );
  };

  const drawAll = () => {
    const list = el('div', 'sm-all');
    for (const [letter, group] of byLetter(apps)) {
      list.append(el('div', 'sm-letter', letter));
      for (const a of group) list.append(appButton(a, 'sm-row'));
    }
    // Icons only for what scrolls into view.
    const io = new IntersectionObserver((seen) => {
      const want = seen.filter((s) => s.isIntersecting).map((s) => (s.target as HTMLElement).title);
      const targets = apps.filter((a) => want.includes(a.name)).map((a) => a.target);
      if (targets.length) wantIcons(targets);
    });
    list.querySelectorAll<HTMLElement>('.sm-row').forEach((r) => io.observe(r));
    body.replaceChildren(section('All apps', pill('Back', SVG.back, () => ((view = 'home'), draw()))), list);
  };

  // The bottom: you, and Settings, File Explorer and the power menu.
  const userBtn = el('button', 'sm-user');
  const avatar = el('span', 'sm-avatar');
  const userName = el('span', '');
  userBtn.append(avatar, userName);
  userBtn.title = 'Account settings';
  userBtn.addEventListener('click', () => void native.startDo('accounts'));
  const quick = (what: string, ico: string, tip: string) => {
    const b = el('button', 'sm-quick', ico);
    b.title = tip;
    b.addEventListener('click', () => void native.startDo(what));
    return b;
  };
  const powerBtn = el('button', 'sm-quick', SVG.power);
  powerBtn.title = 'Power';
  const powerMenu = el('div', 'sm-power');
  for (const [what, text, ico] of [
    ['lock', 'Lock', SVG.lock],
    ['signout', 'Sign out', SVG.signout],
    ['sleep', 'Sleep', SVG.sleep],
    ['restart', 'Restart', SVG.restart],
    ['shutdown', 'Shut down', SVG.power],
  ] as const) {
    const b = el('button', 'sm-prow', ico);
    b.append(el('span', ''));
    b.querySelector('span')!.textContent = text;
    b.addEventListener('click', () => void native.startDo(what));
    powerMenu.append(b);
  }
  powerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    powerMenu.classList.toggle('on');
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.sm-power')) powerMenu.classList.remove('on');
  });
  foot.append(userBtn, el('i', 'sm-spacer'), quick('documents', SVG.file, 'Documents'), quick('explorer', SVG.folder, 'File Explorer'), quick('settings', SVG.settings, 'Settings'), powerBtn, powerMenu);

  const draw = () => {
    if (frame) {
      root.dataset.pill = frame.color;
      root.style.setProperty('--accent', frame.accent);
      applyGlass(root, frame.glass);
    }
    if (query.trim()) drawSearch();
    else if (view === 'all') drawAll();
    else drawHome();
    if (query.trim() || view !== 'home') closeFolder();
    else drawFolder();
  };

  field.addEventListener('input', () => {
    query = field.value;
    pick = 0;
    draw();
  });
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === fname) return;
    if (e.key === 'Escape') {
      if (folderOn !== null) return closeFolder();
      if (query) {
        field.value = query = '';
        draw();
      } else close();
      return;
    }
    if (query.trim()) {
      const rows = [...body.querySelectorAll<HTMLElement>('.sm-row')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length);
        rows.forEach((r, i) => r.classList.toggle('picked', i === pick));
      } else if (e.key === 'Enter') rows[pick]?.click();
      return;
    }
    // Typing anywhere searches.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== field) field.focus();
  });

  /** Opened: in its place, growing out of the Start button. */
  const open = (o: StartOpen) => {
    gen = o.gen;
    const [x, y, w, h] = o.menu;
    Object.assign(menu.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    menu.style.transformOrigin = `${o.origin[0] - x}px ${o.origin[1] - y}px`;
    root.dataset.side = o.side;
    view = 'home';
    field.value = query = '';
    closeFolder();
    draw();
    menu.classList.remove('up');
    void menu.offsetWidth;
    // Two frames on: the window is on screen by then, so the whole slide shows.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (gen === o.gen) menu.classList.add('up');
    }));
    window.setTimeout(() => field.focus(), 30);
    // Fresh each time: the apps (cached after the first), the recent files, the user.
    void native.wsApps().then((list) => {
      apps = list;
      if (query || view === 'all') draw();
    });
    void native.startRecent(12).then((list) => {
      recent = list;
      if (!query && view === 'home') draw();
    });
    void sendTo('island', 'start-hello', null);
  };
  await on<StartOpen>('start-open', open);
  await on<number>('start-close', (g) => {
    gen = g;
    menu.classList.remove('up');
    powerMenu.classList.remove('on');
    // Hidden once it is down behind the bar (start.css: 0.26s), not partway.
    window.setTimeout(() => void native.startHidden(g), 300);
  });
  await on<StartFrame>('start-frame', (f) => {
    frame = f;
    draw();
  });
  void native.startUser().then((u) => {
    userName.textContent = u.name || 'You';
    if (u.picture) {
      const img = document.createElement('img');
      img.src = u.picture;
      img.alt = '';
      avatar.replaceChildren(img);
    } else avatar.textContent = (u.name || '?').charAt(0).toUpperCase();
  });
  void native.startHello();
  void gen;
}
