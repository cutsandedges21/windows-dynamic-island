// Island's own Start menu (Moss, 11-18: "a custom start menu ... that displays all of the same options
// the windows start menu does, but instead it's our ui"). Its own window ("start", src-tauri/src/
// startmenu.rs) stands on the taskbar's inner edge; this page draws the menu in it and slides it out
// from the Start button. What it shows, as Windows 11's Start: a search over every app (and the web or
// your files), your pinned apps, All apps A to Z, the files you opened lately, you, Settings, File
// Explorer and the power menu. The island sends its look and pins ('start-frame').

import '../styles/start.css';
import { applyGlass } from './glass';
import { isTauri, native, on, sendTo, type InstalledApp } from './native';
import type { PillColor } from './settings';

/** What the island tells the menu. */
export interface StartFrame {
  color: PillColor;
  glass?: number;
  accent: string;
  pins: InstalledApp[];
}

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
  const setPins = (list: InstalledApp[]) => {
    if (frame) frame.pins = list;
    void sendTo('island', 'start-pins', list);
    draw();
  };
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
    if (at > 0) items.push(await MenuItem.new({ text: 'Move to front', action: () => setPins([a, ...pins().filter((_, i) => i !== at)]) }));
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
    b.addEventListener('click', () => launch(a));
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

  const drawHome = () => {
    const shown = pins();
    wantIcons(shown.map((a) => a.target));
    const grid = el('div', 'sm-grid');
    grid.append(...shown.slice(0, 18).map((a) => appButton(a, 'sm-tile')));
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
  };

  field.addEventListener('input', () => {
    query = field.value;
    pick = 0;
    draw();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
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
