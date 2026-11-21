// The Activities + Settings window. Settings are shared with the island through
// Rust (every save is broadcast); live data (Claude sessions, limits) is asked
// from the island over app-command / app-reply events.

import './styles/app.css';
import './styles/settings.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { desktopWidgetsPage, taskbarPage } from './widgets-page';
import { activityMatches, CATALOG_BY_ID, type ActivityMeta, type Category, type OptionSpec } from './activities/catalog';
import { activityPreview, alertPreview, islandPreview } from './previews';
import { agoText, pace, resetsIn, resetsOn, SESSION_WINDOW_MS, tokens as fmtTokens, WEEK_WINDOW_MS } from './core/format';
import { icon, type IconName } from './core/icons';
import { applyPill } from './core/glass';
import { blendLabel, innerPadding, levelWidth, normalizeWidths, pillSize, type Anchor, type Level } from './core/layout';
import { fadesAtOnce } from './core/fade-menu';
import { MENU_ITEMS, menuMain, menuSegments, normalizeMenuOrder, type MenuItemId } from './core/menu';
import { fitSegments } from './core/segments';
import { isTauri, native, on, sendTo, type AutoModelState, type MonitorInfo } from './core/native';
import { ctrlKey, optionHere, platform, thisComputer, unavailableReason } from './core/platform';
import { springAnimate } from './core/renderer';
import { playSound, styleChoices, type ChimeKind } from './core/sounds';
import { ACCENTS, backAt, cloneSettings, growsChoices, growsOf, GROWS_BELOW, HIDE_CHOICES, hideUntil, migrate, newPhoneTopic, type ActivityConfig, type Grows, type PillColor, type Settings } from './core/settings';
import { springs } from './core/spring';
import { catchErrors } from './core/errors';
import { codeGrid } from './codegrid';
import { keepKnobs, multiSegmented, row, section, segmented, stacked, toggle } from './controls';
import { h } from './dom';
import { gestureGroups } from './gestures';
import { landPanel } from './land-panel';
import { modelPicker } from './models-ui';
import { phoneSection } from './remote/settings';
import { welcomePage, type WelcomeHost } from './welcome';
import { noticePanel } from './workspaces/notice/panel';
import { confirmBox } from './workspaces/ui';
import { workspacesPage, type WorkspacesPage } from './workspaces/page';

/** 'welcome' is the first-run setup: the whole window, no sidebar. */
type Page = 'island' | 'activities' | 'taskbar' | 'widgets' | 'workspaces' | 'behavior' | 'alerts' | 'phone' | 'controls' | 'general' | 'welcome';
const PAGES: Page[] = ['island', 'activities', 'taskbar', 'widgets', 'workspaces', 'behavior', 'alerts', 'phone', 'controls', 'general', 'welcome'];
/** Names other windows still open pages by (the island's menu opens 'settings'). */
const ALIAS: Record<string, Page> = { settings: 'island' };
const pageOf = (name: string): Page | null => (PAGES.includes(name as Page) ? (name as Page) : (ALIAS[name] ?? null));

let settings: Settings = migrate(null);
// Rust passes the page to open in an init script (a # in the window URL is not reliable).
const requested = (window as unknown as { __ISLAND_PAGE__?: string }).__ISLAND_PAGE__ || location.hash.slice(1);
let page: Page = pageOf(requested) ?? 'activities';
let dragging = false;
let monitors: MonitorInfo[] = [];
let hotkeyFailures: string[] = [];
/** Why the last sound picked could not be used ('' when it could). */
let soundError = '';

// ------------------------------------------------------------------ talking to the island

const replies = new Map<string, (v: unknown) => void>();
let seq = 0;
async function ask<T = unknown>(target: string, cmd: string, arg: unknown = null): Promise<T | null> {
  const id = `r${++seq}`;
  const done = new Promise<T | null>((resolve) => {
    replies.set(id, (v) => resolve(v as T));
    setTimeout(() => {
      if (replies.delete(id)) resolve(null);
    }, 5000);
  });
  await sendTo('island', 'app-command', { id, target, cmd, arg });
  return done;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(now = false): void {
  clearTimeout(saveTimer);
  const go = () => void native.settingsSet(settings, 'app');
  if (now) go();
  else saveTimer = setTimeout(go, 60);
}

function cfg(id: string): ActivityConfig {
  return settings.activities.config[id];
}

// ------------------------------------------------------------------ shell

const root = document.getElementById('app')!;

/** The sidebar's pages: name, icon, and what is in each, in a few words. */
const NAV: Array<[Exclude<Page, 'welcome'>, string, IconName, string]> = [
  ['island', 'Island', 'spark', 'Look, size, glow'],
  ['activities', 'Activities', 'pulse', 'What it shows'],
  ['taskbar', 'Taskbar & border', 'window', 'Taskbar, border, notches'],
  ['widgets', 'Widgets', 'widgets', 'Tiles on your desktop'],
  ['workspaces', 'Workspaces', 'spaces', 'Your setups'],
  ['behavior', 'Behavior', 'sliders', 'How it acts'],
  ['alerts', 'Alerts', 'bell', 'Notifications, sounds'],
  ['phone', 'Phone', 'phone', 'Island on your phone'],
  ['controls', 'Keys', 'keyboard', 'Shortcuts, gestures'],
  ['general', 'General', 'settings', 'Startup, privacy, about'],
];

/** What the sidebar's search is looking for ('' : not searching). */
let searchQuery = '';

// The window uses Windows' own title bar (close, minimize, snap), so the page
// only needs the sidebar: the island's own little pill, a search for any setting, and the pages.
function nav(): HTMLElement {
  const item = ([p, label, ic, sub]: (typeof NAV)[number]) =>
    h('button', { class: `nav-item${page === p && !searchQuery ? ' active' : ''}`, onclick: () => go(p) }, [h('span', { class: 'nav-ico', html: icon(ic) }), h('span', { class: 'nav-text' }, [h('b', { text: label }), h('small', { text: sub })])]);
  const input = h('input', { type: 'search', placeholder: 'Search settings', value: searchQuery, spellcheck: 'false', 'aria-label': 'Search settings', 'data-focus': 'nav-search' }) as HTMLInputElement;
  input.addEventListener('input', () => {
    searchQuery = input.value;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      searchQuery = '';
      render();
    }
    // Enter: the first result.
    if (e.key === 'Enter') root.querySelector<HTMLElement>('.search-hit')?.click();
  });
  return h('nav', { class: 'nav' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-pill' }, [h('i')]), h('span', { text: 'Island' })]),
    h('label', { class: 'nav-search' }, [h('span', { class: 'ico', html: icon('search') }), input]),
    h('div', { class: 'nav-list' }, NAV.map(item)),
  ]);
}

function go(p: Page): void {
  if (searchQuery) {
    searchQuery = '';
    page = p;
    location.hash = p;
    render();
    return;
  }
  if (p === page) {
    // Workspaces again, from inside one of its own views: back to the cards.
    if (p === 'workspaces') workspaces?.home();
    return;
  }
  page = p;
  location.hash = p;
  render();
  const content = root.querySelector('.content');
  if (content) springAnimate(content, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

/** The first-run setup saves through here, and hands back to Activities with the island open on the new grid. */
const welcomeHost: WelcomeHost = {
  settings: () => settings,
  save: (next) => {
    settings = next;
    save(true);
  },
  done: () => {
    void ask('island', 'open');
    go('activities');
  },
};

function render(): void {
  if (dragging) return;
  document.documentElement.style.setProperty('--accent', ACCENTS[settings.island.accent] ?? settings.island.accent);
  if (page === 'welcome') {
    root.replaceChildren(welcomePage(welcomeHost));
    return;
  }
  // The window takes the island's colour (Settings follows the pill, Moss).
  applyPill(document.documentElement, settings.island.color, settings.island.custom);
  const scroll = root.querySelector('.content')?.scrollTop ?? 0;
  const panelScroll = root.querySelector('.act-panel')?.scrollTop ?? 0;
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active?.dataset?.focus;
  const caret = active && 'selectionStart' in active ? active.selectionStart : null;
  const knobs = keepKnobs(root);
  const body = searchQuery.trim() ? searchPage() : pageBody(page);
  root.replaceChildren(h('div', { class: 'body' }, [nav(), h('main', { class: 'content' }, [body])]));
  knobs(root);
  const content = root.querySelector('.content');
  if (content) content.scrollTop = scroll;
  const panel = root.querySelector('.act-panel');
  if (panel) panel.scrollTop = panelScroll;
  if (focusKey) {
    const again = root.querySelector<HTMLInputElement>(`[data-focus="${focusKey}"]`);
    again?.focus();
    if (again && caret !== null) again.setSelectionRange(caret, caret);
  }
  if (page === 'workspaces' && !searchQuery) workspacesView().shown();
  revealRow();
}

const widgetsHost = () => ({ settings: () => settings, save, render, mac: platform === 'macos' });

/** Page `p`'s content. */
function pageBody(p: Page): HTMLElement {
  switch (p) {
    case 'activities':
      return activitiesPage();
    case 'workspaces':
      return workspacesView().el;
    case 'taskbar':
      return taskbarPage(widgetsHost());
    case 'widgets':
      return desktopWidgetsPage(widgetsHost());
    case 'controls':
      return controlsPage();
    case 'behavior':
      return behaviorPage();
    case 'alerts':
      return alertsPage();
    case 'phone':
      return phonePage();
    case 'general':
      return generalPage();
    default:
      return islandPage();
  }
}

// ------------------------------------------------------------------ search

/** The pages searched by their rows (Workspaces and Phone keep state of their own and are left out). */
const SEARCHED: Page[] = ['island', 'taskbar', 'widgets', 'behavior', 'alerts', 'controls', 'general'];
/** A row to bring into view once its page is drawn (a search result picked). */
let reveal: string | null = null;

/** Every setting whose name or description has the words in it, and every activity: each opens where it is. */
function searchPage(): HTMLElement {
  const q = searchQuery.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const results: HTMLElement[] = [];
  const result = (p: Page, where: string, title: string, help: string, open: () => void, ic?: string) =>
    h('button', { class: 'search-hit', onclick: open }, [
      h('span', { class: 'hit-ico', html: icon(ic ?? NAV.find((n) => n[0] === p)?.[2] ?? 'settings') }),
      h('span', { class: 'hit-text' }, [h('small', { text: where }), h('b', { text: title }), help ? h('span', { text: help }) : null]),
      h('span', { class: 'hit-go', html: icon('chevron-right') }),
    ]);
  for (const meta of CATALOG_BY_ID.values()) {
    if (!activityMatches(meta, q)) continue;
    results.push(
      result('activities', 'Activities', meta.name, firstSentence(meta.description), () => {
        actOpen = meta.id;
        go('activities');
      }, meta.icon),
    );
  }
  const seen = new Set<string>();
  for (const p of SEARCHED) {
    const label = NAV.find((n) => n[0] === p)?.[1] ?? p;
    for (const r of Array.from(pageBody(p).querySelectorAll<HTMLElement>('.row'))) {
      const title = r.querySelector('.row-title')?.textContent?.trim() ?? '';
      const help = r.querySelector('.row-help')?.textContent?.trim() ?? '';
      const sect = r.closest('section')?.querySelector('h2')?.textContent?.trim() ?? '';
      if (!title || !hit(`${title} ${help} ${sect}`) || seen.has(`${p}|${title}`)) continue;
      seen.add(`${p}|${title}`);
      results.push(
        result(p, sect && sect !== title ? `${label} › ${sect}` : label, title, help, () => {
          reveal = title;
          go(p);
        }),
      );
    }
  }
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: 'Search' }), h('p', { text: results.length ? `${results.length} found for “${searchQuery.trim()}”. Pick one to go there.` : `Nothing found for “${searchQuery.trim()}”. Try another word.` })]),
    h('div', { class: 'search-list' }, results.slice(0, 60)),
  ]);
}

/** After a page is drawn: the row a search picked comes into view, lit for a moment. */
function revealRow(): void {
  if (!reveal) return;
  const title = reveal;
  reveal = null;
  const r = Array.from(root.querySelectorAll<HTMLElement>('.row')).find((x) => x.querySelector('.row-title')?.textContent?.trim() === title);
  if (!r) return;
  r.scrollIntoView({ block: 'center' });
  r.classList.add('flash');
  setTimeout(() => r.classList.remove('flash'), 1600);
}

/** The first sentence of a description, for a one-line summary. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}

// ------------------------------------------------------------------ workspaces page

/**
 * Made on first visit and kept for the window's life, so an edit in progress survives going
 * to another page and the window redrawing for a settings change. Its colours follow the
 * accent through the CSS variable.
 */
let workspaces: WorkspacesPage | null = null;
/** For its Time tab: Notice what I work on's switch and how long it keeps (the Workspaces activity's options). */
const noticing = {
  on: () => cfg('workspaces')?.enabled === true && cfg('workspaces').options.notice === true,
  days: () => Math.min(60, Math.max(1, Number(cfg('workspaces')?.options.days) || 14)),
  turnOn: () => {
    const c = cfg('workspaces');
    c.enabled = true;
    c.options.notice = true;
    save(true);
  },
};
function workspacesView(): WorkspacesPage {
  return (workspaces ??= workspacesPage(() => 'var(--accent)', ask, noticing));
}

// ------------------------------------------------------------------ activities page

/** The categories, as chips over the tiles: all, the ones on, then each kind. */
const CATEGORIES: Array<[Category | 'all' | 'on', string]> = [
  ['all', 'All'],
  ['on', 'On'],
  ['developer', 'AI & coding'],
  ['media', 'Music & media'],
  ['productivity', 'Productivity'],
  ['system', 'System'],
  ['communication', 'Messages & calls'],
  ['network', 'Network'],
];
const PRIORITY_LABEL: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

/** Activities' search and category: kept across redraws, so a switch doesn't clear them. */
let actQuery = '';
let actCat: (typeof CATEGORIES)[number][0] = 'all';
/** The activity whose panel is open, or null. */
let actOpen: string | null = null;

/**
 * Activities: every one as a tile with its switch, by category, with a search. A tile opens its
 * panel: how it looks on the island, what it does, and everything it can change.
 */
function activitiesPage(): HTMLElement {
  const q = actQuery.trim();
  const shown = settings.activities.order
    .map((id) => CATALOG_BY_ID.get(id))
    .filter((m): m is ActivityMeta => Boolean(m && cfg(m.id)))
    .filter((m) => (actCat === 'all' ? true : actCat === 'on' ? cfg(m.id).enabled || Boolean(m.builtIn) : m.category === actCat))
    .filter((m) => !q || activityMatches(m, q));
  const on = settings.activities.order.filter((id) => cfg(id)?.enabled && CATALOG_BY_ID.has(id)).length;
  const input = h('input', { type: 'search', placeholder: 'Find an activity: music, Claude, battery…', value: actQuery, spellcheck: 'false', 'aria-label': 'Find an activity', 'data-focus': 'act-search' }) as HTMLInputElement;
  input.addEventListener('input', () => {
    actQuery = input.value;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      actQuery = '';
      render();
    }
  });
  const chips = h(
    'div',
    { class: 'chips' },
    CATEGORIES.map(([k, label]) => h('button', { class: `chip${actCat === k ? ' on' : ''}`, text: label, onclick: () => { actCat = k; render(); } })),
  );
  const grid = h('div', { class: 'act-grid' }, shown.map(activityTile));
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: 'Activities' }), h('p', { text: `Everything the island can show. ${on} on. Flip one on, or open it to see how it looks and change how it behaves.` })]),
    h('label', { class: 'act-search' }, [h('span', { class: 'ico', html: icon('search') }), input]),
    chips,
    shown.length ? grid : h('p', { class: 'muted act-empty', text: q ? `Nothing matches “${q}”.` : 'Nothing here yet.' }),
    actOpen && CATALOG_BY_ID.has(actOpen) ? activityPanel(CATALOG_BY_ID.get(actOpen)!) : null,
  ]);
}

/** One activity's tile: its icon, name, what it does in a line, how much it matters, and its switch. */
function activityTile(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const reason = unavailableReason(meta.id);
  const enabled = (c.enabled || Boolean(meta.builtIn)) && !reason;
  const control = reason
    ? h('span', { class: 'act-soon', text: reason })
    : meta.builtIn
      ? h('span', { class: 'act-soon', text: 'Built in' })
      : toggle(c.enabled, (v) => {
          c.enabled = v;
          save(true);
          render();
        }, `Turn ${meta.name} ${c.enabled ? 'off' : 'on'}`);
  const tile = h('div', { class: `act-tile${enabled ? ' on' : ''}${reason ? ' unavailable' : ''}`, role: 'button', tabindex: '0', 'data-id': meta.id, title: `Open ${meta.name}` }, [
    h('div', { class: 'tile-top' }, [h('span', { class: `act-icon i-${meta.id}`, html: icon(meta.icon) }), control]),
    h('b', { class: 'tile-name', text: meta.name }),
    h('span', { class: 'tile-desc', text: firstSentence(meta.description), title: meta.description }),
    h('span', { class: 'tile-foot' }, [enabled ? h('span', { class: `prio p-${c.priority}`, text: PRIORITY_LABEL[c.priority] ?? '' }) : h('span', { class: 'prio off', text: reason ? 'Not on this computer' : 'Off' }), h('span', { class: 'tile-open', html: icon('chevron-right') })]),
  ]);
  const open = () => {
    actOpen = meta.id;
    render();
  };
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return tile;
}

/** An activity's panel over the tiles: its preview, what it does, its switch, and all its options. */
function activityPanel(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const reason = unavailableReason(meta.id);
  const close = () => {
    actOpen = null;
    render();
  };
  const head = h('div', { class: 'panel-head' }, [
    h('span', { class: `act-icon big i-${meta.id}`, html: icon(meta.icon) }),
    h('div', { class: 'panel-title' }, [h('h2', { text: meta.name }), h('span', { class: 'muted', text: reason ?? (meta.builtIn ? 'Built in: always on' : c.enabled ? 'On' : 'Off') })]),
    reason || meta.builtIn
      ? null
      : toggle(c.enabled, (v) => {
          c.enabled = v;
          save(true);
          render();
        }, `Turn ${meta.name} ${c.enabled ? 'off' : 'on'}`),
    h('button', { class: 'panel-x', html: icon('x'), title: 'Close (Esc)', onclick: close }),
  ]);
  const panel = h('aside', { class: 'act-panel', role: 'dialog', 'aria-label': meta.name }, [
    head,
    activityPreview(meta, c, settings),
    h('p', { class: 'panel-desc', text: meta.description }),
    h('section', { class: 'card section' }, [h('h2', { text: 'Settings' }), cardBody(meta)]),
  ]);
  const wrap = h('div', { class: 'act-panel-wrap' }, [panel]);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  return wrap;
}

/** What Priority means, under its switch on every activity. */
/** The Grows choices in plain words (Settings › When pointed at, and each activity's Grows). */
const GROWS_LABEL: Record<Grows, string> = { wide: 'Sideways', card: 'Into a card', below: 'Below', more: 'Card with more' };
const GROWS_HELP = [
  'When you point at it: Sideways widens the pill, Into a card grows a card out of it.',
  'When you point at it: Card with more grows the sessions card out of the pill, and the ⌄ under its rows opens the rest (limits, tokens, closed chats); Below hangs all of it under the pill; Into a card grows the sessions card alone; Sideways widens the pill and hangs the card under it.',
];

const PRIORITY_HELP = 'When several things happen at once, the highest one gets the pill and the others wait beside it as small icons. A tie goes to the one higher on this page.';

/** Each behavior switch, with what it does in plain words (shown under it, not hidden in a tooltip). */
const BEHAVIORS: Array<[keyof Pick<ActivityConfig, 'autoShow' | 'persistent' | 'interactive' | 'interrupt'>, string, string]> = [
  ['autoShow', 'Auto-show', 'Pops the island open for a few seconds when something happens here, like a download finishing. Off: it changes quietly, and you see it when you look.'],
  ['persistent', 'Persistent', "Keeps it on the pill for as long as it's going, like music while it plays. Off: it takes the pill only for its moments, then waits beside it as a small icon."],
  ['interactive', 'Interactive', 'Its buttons work right on the island: pause, Accept, Open. Off: the island only shows it.'],
  ['interrupt', 'Interrupt', 'Lets it take over the island for urgent moments, like a permission request or a timer going off, even over something with a higher priority. Off: those moments wait their turn.'],
];

function cardBody(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const behaviors = BEHAVIORS.map(([key, label, help]) =>
    row(label, help, toggle(c[key], (v) => {
      c[key] = v;
      save(true);
      // The Grows row is only there while Persistent is on.
      if (key === 'persistent') render();
    }, label)),
  );
  const body = h('div', { class: 'act-body' }, [
    row('Priority', PRIORITY_HELP, segmented(c.priority, [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], (v) => { c.priority = v; c.enabled = true; save(true); flipRender(); })),
    ...behaviors,
    // Pointing at a persistent activity: widen the pill, or grow a card out of it like the music player.
    c.persistent ? row('Grows', GROWS_HELP[meta.id === GROWS_BELOW ? 1 : 0], segmented(growsOf(c, settings.island.defaultGrows, meta.id), growsChoices(meta.id).map((g) => [g, GROWS_LABEL[g]] as [Grows, string]), (v) => { c.grows = v; save(true); render(); })) : null,
    // Local AI's model is picked in its panel below, not typed; System Stats' picks live in its table.
    ...meta.options
      .filter((o) => optionHere(o) && !(meta.id === 'local' && o.key === 'model') && !(meta.id === 'system' && SYSTEM_TABLE_KEYS.has(o.key)))
      .flatMap((o) =>
        meta.id === 'system' && o.key === 'always'
          ? [optionRow(meta.id, o), systemTable()]
          : meta.id === 'claude' && o.key === 'glowInFront'
            ? [autoModelRow(), optionRow(meta.id, o)]
            : [optionRow(meta.id, o)],
      ),
  ]);
  // Claude Code's panel (its hooks, limits and chats) closes its part of the options.
  if (meta.id === 'claude') body.append(claudePanel());
  if (meta.id === 'codex') body.append(codexPanel());
  if (meta.id === 'cursor') body.append(cursorPanel());
  if (meta.id === 'antigravity') body.append(antigravityPanel());
  if (meta.id === 'local') body.append(localPanel());
  if (meta.id === 'land') body.append(landPanel());
  if (meta.id === 'workspaces') body.append(noticePanel({ ask, openWorkspaces: () => { go('workspaces'); void sendTo('app', 'ws-seed', null); } }));
  return body;
}

/**
 * Activities › Claude Status › Auto model: installs the model router and the model check in
 * Claude Code (src-tauri/src/auto_model.rs), or removes them. The switch shows what is really in
 * Claude Code's settings, not a saved option. Its hooks sit beside Island's own (Claude Code ›
 * hooks) and never touch them.
 */
function autoModelRow(): HTMLElement {
  const note = h('div', { class: 'row-help' });
  const sw = toggle(false, (on) => void flip(on), 'Auto model');
  const show = (installed: boolean, text: string, warn = false) => {
    sw.classList.toggle('on', installed);
    sw.setAttribute('aria-checked', String(installed));
    note.className = warn ? 'row-help warn' : 'row-help';
    note.textContent = text;
  };
  const busy = (yes: boolean) => {
    if (yes) sw.setAttribute('disabled', '');
    else sw.removeAttribute('disabled');
  };
  const done = (s: AutoModelState) => {
    if (s.error) show(s.installed, s.error, true);
    else show(s.installed, s.installed ? 'On for every Claude Code session. A backup of its settings.json was saved next to it.' : 'Off. Its hooks are gone from Claude Code; your own hooks stay.');
  };
  const flip = async (want: boolean) => {
    busy(true);
    show(want, want ? 'Adding the hooks to Claude Code…' : 'Removing the hooks…');
    let s = await native.setAutoModel(want);
    // No Node.js on this PC: say what is about to be downloaded, then do it all in one go.
    if (want && s.needsNode) {
      show(false, '');
      const mb = Math.round(s.nodeDownloadBytes / 1e6);
      const yes = await confirmBox({
        title: 'Download Node.js?',
        text: `Auto model runs on Node.js, which isn’t on this PC. Island will download it (${mb} MB) from nodejs.org into its own folder, then turn Auto model on. Nothing else on your PC changes.`,
        yes: `Download ${mb} MB and turn on`,
      });
      if (!yes) {
        busy(false);
        show(false, 'Still off: Auto model needs Node.js.');
        return;
      }
      show(true, 'Downloading Node.js…');
      const stop = await on<{ done: number; total: number }>('auto-model-node', (p) => {
        if (p.total) show(true, p.done < p.total ? `Downloading Node.js… ${Math.round((p.done / p.total) * 100)}% of ${mb} MB` : 'Setting up Auto model…');
      });
      s = await native.installAutoModelNode();
      stop();
    }
    busy(false);
    done(s);
  };
  void native.autoModel().then((s) => show(s.installed, s.installed ? (s.on ? 'On.' : 'Paused from the island’s button.') : ''));
  const r = row(
    'Auto model',
    'Before a prompt runs on a far too strong or too weak Claude model, Claude Code stops and says which model to switch to. When a chat compacts, passes 500k tokens or ends, it tells you if you used the right one: what a cheaper model would have saved, or how much more often a stronger one would have got it right. Adds hooks to Claude Code. Each check asks Claude, so it uses a little of your Claude usage.',
    sw,
  );
  r.querySelector('.row-text')?.append(note);
  return r;
}

function optionRow(id: string, o: OptionSpec): HTMLElement {
  // A heading sets the options after it apart (Claude Status › Claude Code).
  if (o.type === 'heading') return h('div', { class: 'opt-head' }, [h('h3', { text: o.label }), o.help ? h('div', { class: 'row-help', text: o.help }) : null]);
  const opts = cfg(id).options;
  const set = (v: unknown) => {
    opts[o.key] = v;
    save();
  };
  let control: Node;
  if (o.type === 'toggle') control = toggle(Boolean(opts[o.key] ?? o.default), set, o.label);
  else if (o.type === 'number') {
    const input = h('input', { type: 'number', min: o.min, max: o.max, step: o.step ?? 1, value: String(opts[o.key] ?? o.default) });
    input.addEventListener('change', () => set(Math.min(o.max, Math.max(o.min, Number(input.value) || o.default))));
    control = h('label', { class: 'num' }, [input, o.unit ? h('span', { text: o.unit }) : null]);
  } else if (o.type === 'choice' && o.choices.some((c) => c.group)) return stacked(row(o.label, o.help ?? null, codeGrid(String(opts[o.key] ?? o.default), o.choices, set)));
  else if (o.type === 'choice') control = segmented(String(opts[o.key] ?? o.default), o.choices.map((c) => [c.value, c.label] as [string, string]), (v) => { set(v); render(); });
  else if (o.type === 'multi') {
    const saved = Array.isArray(opts[o.key]) ? (opts[o.key] as unknown[]).filter((v): v is string => typeof v === 'string') : o.default;
    control = multiSegmented(saved.length ? saved : o.default, o.choices.map((c) => [c.value, c.label] as [string, string]), set);
  } else {
    const input = h('input', { type: o.secret ? 'password' : 'text', placeholder: o.placeholder ?? '', value: String(opts[o.key] ?? o.default), spellcheck: 'false' });
    input.addEventListener('change', () => set(input.value.trim()));
    control = input;
  }
  return row(o.label, o.help ?? null, control);
}

// ------------------------------------------------------------------ System Stats table

const SYSTEM_STATS: Array<{ key: 'cpu' | 'mem' | 'gpu'; label: string; icon: IconName; opt: 'Cpu' | 'Ram' | 'Gpu'; pill: string }> = [
  { key: 'cpu', label: 'CPU', icon: 'cpu', opt: 'Cpu', pill: 'cpu' },
  { key: 'mem', label: 'RAM', icon: 'memory', opt: 'Ram', pill: 'ram' },
  { key: 'gpu', label: 'GPU', icon: 'gpu', opt: 'Gpu', pill: 'gpu' },
];
const SYSTEM_TABLE_KEYS = new Set(['order', 'show', ...SYSTEM_STATS.map((s) => `expanded${s.opt}`)]);

/**
 * One row per stat: drag the grip to set the priority (the top one leads), a switch for the
 * resting pill ("On the pill": nothing picked means the top one alone) and one for the expanded island.
 */
function systemTable(): HTMLElement {
  const meta = CATALOG_BY_ID.get('system')!;
  const opts = cfg('system').options;
  const value = (key: string) => {
    const o = meta.options.find((x) => x.key === key);
    return Boolean(opts[key] ?? (o && 'default' in o ? o.default : false));
  };
  const saved = String(opts.order ?? 'cpu,mem,gpu').split(',');
  const stats = [...SYSTEM_STATS].sort((a, b) => (saved.indexOf(a.key) + 4) % 4 - ((saved.indexOf(b.key) + 4) % 4));
  const shown = new Set<unknown>(Array.isArray(opts.show) ? opts.show : []);

  const list = h('div', { class: 'stat-rows' });
  const order = () => [...list.children].map((el) => (el as HTMLElement).dataset.key);
  /** With nothing picked for the pill, the top row's switch shows that it is the one there. */
  const fillPill = () => {
    for (const el of list.children) {
      const on = shown.size ? shown.has(SYSTEM_STATS.find((s) => s.key === (el as HTMLElement).dataset.key)!.pill) : el === list.firstElementChild;
      const sw = el.querySelector<HTMLElement>('.pill-cell .switch')!;
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(on));
    }
  };
  for (const s of stats) {
    const grip = h('span', { class: 'grip', html: icon('more'), title: 'Drag to change the priority' });
    const pill = toggle(false, (v) => {
      // The first pick starts from what the pill already shows: the top one.
      if (!shown.size) shown.add(SYSTEM_STATS.find((x) => x.key === order()[0])!.pill);
      if (v) shown.add(s.pill);
      else shown.delete(s.pill);
      opts.show = SYSTEM_STATS.map((x) => x.pill).filter((k) => shown.has(k));
      save();
      fillPill();
    }, `${s.label} on the pill`);
    const line = h('div', { class: 'stat-row', 'data-key': s.key }, [
      grip,
      h('span', { class: 'stat-icon', html: icon(s.icon) }),
      h('span', { class: 'stat-name', text: s.label }),
      h('span', { class: 'stat-cell pill-cell' }, [pill]),
      h('span', { class: 'stat-cell' }, [toggle(value(`expanded${s.opt}`), (v) => { opts[`expanded${s.opt}`] = v; save(); }, `${s.label} when expanded`)]),
    ]);
    grip.addEventListener('pointerdown', (e) => dragStat(e as PointerEvent, line, list, () => {
      opts.order = order().join(',');
      save();
      fillPill();
    }));
    list.append(line);
  }
  fillPill();
  return h('div', { class: 'stat-table' }, [
    h('div', { class: 'stat-head' }, [h('span', { class: 'stat-title', text: 'Priority' }), h('span', { class: 'stat-cell', text: 'On the pill' }), h('span', { class: 'stat-cell', text: 'Expanded' })]),
    list,
    h('div', { class: 'row-help', text: 'The top stat leads, and it is the one beside other activities. On the pill picks what the resting pill shows side by side (none: the top one alone); Expanded shows the ones switched on. Both go in this order.' }),
  ]);
}

/** Drag a stat row up or down; it swaps past a neighbour once the pointer crosses that neighbour's middle. */
function dragStat(e: PointerEvent, line: HTMLElement, list: HTMLElement, done: () => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  line.classList.add('dragging');
  const move = (ev: PointerEvent) => {
    const others = [...list.children].filter((el) => el !== line) as HTMLElement[];
    const before = others.find((el) => { const r = el.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (before ? line.nextElementSibling !== before : list.lastElementChild !== line) list.insertBefore(line, before ?? null);
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    line.classList.remove('dragging');
    done();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

/** Things that change an activity's state just draw the page again (the tiles animate in CSS). */
function flipRender(): void {
  render();
}

// ------------------------------------------------------------------ size + position

function sizeCard(): HTMLElement {
  const area = monitors.find((m) => m.id === settings.island.displayId) ?? monitors.find((m) => m.primary) ?? null;
  const areaCss = area ? { width: area.work.width / area.scale, height: area.work.height / area.scale } : { width: 1536, height: 816 };
  const levels: Array<[keyof Settings['island']['widths'], string]> = [['compact', 'Compact'], ['expanded', 'Expanded'], ['maximum', 'Maximum']];
  const track = h('div', { class: 'track' }, [h('div', { class: 'track-fill' })]);
  const readout = h('div', { class: 'size-readout' });
  const vertical = settings.island.anchor === 'left' || settings.island.anchor === 'right';
  const paint = () => {
    const w = settings.island.widths;
    const span = (v: number) => `${(v / 0.9) * 100}%`;
    track.querySelectorAll<HTMLElement>('.thumb').forEach((t) => {
      t.style.left = span(w[t.dataset.level as keyof typeof w]);
    });
    (track.querySelector('.track-fill') as HTMLElement).style.width = span(w.maximum);
    readout.replaceChildren(
      ...levels.map(([k, label]) => {
        const px = vertical ? Math.round(areaCss.height * w[k]) : levelWidth(areaCss, w, k as Level, settings.island.edge, settings.island.size);
        return h('span', {}, [h('b', { text: `${label} ${Math.round(w[k] * 100)}%` }), ` ≈ ${px} px`]);
      }),
    );
  };
  for (const [k, label] of levels) {
    const thumb = h('div', { class: 'thumb', 'data-level': k, title: `${label} width` }, [h('span', { text: label[0] })]);
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add('active');
      void ask('island', 'preview-level', k);
      const rect = track.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) * 0.9;
        const w = { ...settings.island.widths, [k]: Math.round(frac * 200) / 200 };
        // Keep the three widths in order while dragging.
        if (k === 'compact') w.compact = Math.min(w.compact, w.expanded - 0.02);
        if (k === 'expanded') w.expanded = Math.min(Math.max(w.expanded, w.compact + 0.02), w.maximum - 0.02);
        if (k === 'maximum') w.maximum = Math.max(w.maximum, w.expanded + 0.02);
        settings.island.widths = normalizeWidths(w);
        paint();
        save();
      };
      const up = () => {
        thumb.removeEventListener('pointermove', move);
        thumb.classList.remove('active');
        void ask('island', 'preview-level', null);
        save(true);
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up, { once: true });
      thumb.addEventListener('pointercancel', up, { once: true });
    });
    track.append(thumb);
  }
  paint();
  const pos = (a: Anchor, label: string) =>
    h('button', {
      class: `pos${settings.island.anchor === a ? ' on' : ''}`,
      title: label,
      html: `${icon(`pos-${a}`)}<span>${label}</span>`,
      onclick: () => {
        settings.island.anchor = a;
        save(true);
        render();
      },
    });
  return h('section', { class: 'card size-card' }, [
    h('div', { class: 'size-head' }, [h('h2', { text: 'Island' }), h('div', { class: 'positions' }, [pos('top', 'Top'), pos('right', 'Right'), pos('bottom', 'Bottom'), pos('left', 'Left')])]),
    h('p', {
      class: 'muted',
      text: `Compact is the pill at rest, Expanded is when something happens or you point at it, Maximum is when you open it. Each is a share of the display${vertical ? '; on the left or right the island stands vertical, so they set its height' : ''}. Drag a handle and watch the island.`,
    }),
    track,
    readout,
  ]);
}

// ------------------------------------------------------------------ Local AI panel

/** Local AI's models: what this PC has, which models it can run, and download, switch or delete them. */
function localPanel(): HTMLElement {
  const host = {
    option: () => String(cfg('local').options.model ?? ''),
    choose: (value: string) => {
      const c = cfg('local');
      c.options.model = value;
      const wasOff = !c.enabled;
      c.enabled = true;
      save(true);
      // Picking a model turns Local AI on, which moves its card out of Available.
      if (wasOff) flipRender();
    },
  };
  return h('div', { class: 'local-panel' }, [h('h3', { text: 'Models' }), modelPicker(host, 'list')]);
}

// ------------------------------------------------------------------ Claude panel (Usage Clip's screen)

interface ClaudeSnapshot {
  available: boolean;
  usage: { data: { fiveHour: { pct: number; resetsAt: number | null } | null; sevenDay: { pct: number; resetsAt: number | null } | null; models: Array<{ name: string; pct: number }> } | null; error: string | null; message?: string | null; source: string | null } | null;
  tokens: { fresh: number; cached: number } | null;
  sessions: Array<{ id: string; slot: number | null; displayTitle: string; label: string; tone: string; project: string; host: string; model: string | null; lastActivityMs: number; needsYou: boolean; cwd: string }>;
  closed: Array<{ id: string; displayTitle: string; project: string; closedAt: number; entrypoint: string | null; editorHost?: string | null }>;
  chats: Array<{ uuid: string; displayTitle: string; project: string | null; label: string | null; updatedAt: number }>;
  hooks: { installed: boolean; upToDate?: boolean; hookReady: boolean; settingsPath: string } | null;
  hooksSeenAt: number;
}

let claudeTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Runs `load` once `panel` is on the page, then every 2 s while it stays there. A panel is built
 * before its card joins the page, so the first run waits for that (checking at once used to stop
 * it for good: the panels sat on "Loading…"). A switched-off activity has nobody to answer, and
 * an island that doesn't answer is said so, instead of loading forever.
 */
function whileShown(panel: HTMLElement, id: string, load: () => Promise<void>): ReturnType<typeof setInterval> {
  let shown = false;
  let waits = 0;
  let misses = 0;
  const name = CATALOG_BY_ID.get(id)?.name ?? id;
  const tick = async (): Promise<void> => {
    if (!panel.isConnected) {
      if (shown || ++waits > 10) clearInterval(timer);
      return;
    }
    shown = true;
    if (!cfg(id).enabled) {
      panel.replaceChildren(h('div', { class: 'muted', text: `Turn ${name} on above to see its chats and set up its hooks.` }));
      return;
    }
    await load();
    const waiting = panel.textContent === 'Loading…';
    misses = waiting ? misses + 1 : 0;
    if (waiting && misses >= 3) panel.replaceChildren(h('div', { class: 'muted', text: `${name} didn't answer. Is Island running? This retries every 2 seconds.` }));
  };
  const timer = setInterval(() => void tick(), 2000);
  setTimeout(() => void tick(), 0);
  return timer;
}

function claudePanel(): HTMLElement {
  const panel = h('div', { class: 'claude-panel' }, [h('div', { class: 'muted', text: 'Loading…' })]);
  const load = async () => {
    const snap = await ask<ClaudeSnapshot>('claude', 'snapshot');
    // An open install preview stays put until it is answered.
    if (snap && panel.isConnected && !dragging && !panel.querySelector('.hook-preview')) fillClaude(panel, snap);
  };
  clearInterval(claudeTimer);
  claudeTimer = whileShown(panel, 'claude', load);
  return panel;
}

function meterRow(name: string, w: { pct: number; resetsAt: number | null } | null, windowMs: number, resetText: string): HTMLElement {
  const now = Date.now();
  const p = w ? pace(w.resetsAt, windowMs, now) : null;
  const bar = h('div', { class: 'meter-bar' }, [h('i', { class: 'fill' }), h('i', { class: 'tick' })]);
  (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${w ? Math.min(1, w.pct / 100) : 0})`;
  const tick = bar.lastElementChild as HTMLElement;
  tick.style.left = `${(p ?? 0) * 100}%`;
  tick.style.opacity = p == null ? '0' : '1';
  if (w && w.pct >= 90) bar.classList.add('hot');
  const tip = p == null ? 'No active window yet.' : `White tick = time passed (${Math.round(p * 100)}%). Bar past the tick: at this pace you hit the limit before it resets.`;
  return h('div', { class: 'meter', title: tip }, [h('div', { class: 'meter-head' }, [h('span', { text: name }), h('span', { class: 'muted', text: resetText })]), h('div', { class: 'meter-body' }, [bar, h('b', { text: w ? `${Math.round(w.pct)}%` : '–' })])]);
}

function fillClaude(panel: HTMLElement, s: ClaudeSnapshot): void {
  const now = Date.now();
  const d = s.usage?.data;
  const kids: Node[] = [];
  kids.push(
    h('div', { class: 'limits' }, [
      meterRow('Session', d?.fiveHour ?? null, SESSION_WINDOW_MS, d?.fiveHour ? resetsIn(d.fiveHour.resetsAt, now) : 'checking'),
      meterRow('This week', d?.sevenDay ?? null, WEEK_WINDOW_MS, d?.sevenDay ? resetsOn(d.sevenDay.resetsAt, now) : 'checking'),
    ]),
  );
  const extra: Node[] = [];
  if (d?.models.length) extra.push(...d.models.map((m) => h('span', { class: 'pill-chip', text: `${m.name} ${Math.round(m.pct)}%` })));
  if (s.tokens) extra.push(h('span', { class: 'muted', text: `Tokens this week ${fmtTokens(s.tokens.fresh)}${s.tokens.cached ? `  +${fmtTokens(s.tokens.cached)} cache` : ''}` }));
  if (s.usage?.error) extra.push(h('span', { class: 'warn', text: s.usage.message ?? s.usage.error }));
  if (s.usage?.source === 'usage-clip') extra.push(h('span', { class: 'muted', text: 'Sharing readings with Usage Clip' }));
  kids.push(h('div', { class: 'limit-extra' }, extra));

  const list = h('div', { class: 'sess-list' });
  if (!s.sessions.length) list.append(h('div', { class: 'muted', text: 'No Claude Code sessions running. Start one in a terminal or your editor.' }));
  for (const x of s.sessions) {
    list.append(
      h('button', { class: `sess tone-${x.tone}`, title: `${x.displayTitle}\n${x.cwd}`, onclick: () => void ask('claude', 'switch', x.id) }, [
        h('span', { class: 'slot', text: x.slot ? String(x.slot) : '' }),
        h('span', { class: `dot${x.needsYou ? ' pulse' : ''}` }),
        h('span', { class: 'sess-title', text: x.displayTitle }),
        h('span', { class: 'sess-meta', text: [x.project, x.host, x.model, agoText(now - x.lastActivityMs)].filter(Boolean).join(' · ') }),
        h('span', { class: 'sess-label', text: x.label }),
      ]),
    );
  }
  kids.push(h('h3', { text: 'Sessions' }), list);

  if (s.chats.length) {
    kids.push(h('h3', { text: 'Claude app chats' }));
    kids.push(h('div', { class: 'mini-list' }, s.chats.map((c) => h('button', { class: 'mini', onclick: () => void ask('claude', 'open-desktop', c.uuid) }, [h('span', { text: c.displayTitle }), h('span', { class: 'muted', text: c.label ?? agoText(now - c.updatedAt) })]))));
  }
  if (s.closed.length) {
    kids.push(h('h3', { text: 'Closed in the last day' }));
    kids.push(
      h('div', { class: 'mini-list' }, s.closed.map((c) =>
        h('button', { class: 'mini', title: `Reopens in ${c.entrypoint === 'claude-vscode' ? c.editorHost || 'your editor' : 'a new terminal'}`, onclick: () => void ask('claude', 'reopen', c.id) }, [
          h('span', { text: c.displayTitle }),
          h('span', { class: 'muted', text: agoText(now - c.closedAt) }),
        ]),
      )),
    );
  }

  const hooks = s.hooks;
  // Installed but written by an older Island (a timeout changed): replies from the island need the update.
  const stale = Boolean(hooks?.installed && hooks.upToDate === false);
  const hookText = !hooks
    ? 'Hook status unknown'
    : stale
      ? 'Installed, but from an older version. Update them so replies and answers from the island reach your chats.'
      : hooks.installed
        ? `Installed${s.hooksSeenAt ? `, last event ${agoText(now - s.hooksSeenAt)}` : ', waiting for the first event'}`
        : 'Not installed. Without hooks the island still tracks sessions, but answering prompts and replying from the island need them.';
  const hookBox = h('div', { class: 'hooks' }, [
    h('div', {}, [h('b', { text: 'Claude Code hooks ' }), h('span', { class: 'muted', text: hookText })]),
    h('div', { class: 'hook-actions' }, [
      h('button', { class: stale ? 'btn primary' : 'btn', text: stale ? 'Update hooks…' : hooks?.installed ? 'Reinstall…' : 'Install hooks…', onclick: () => void hookFlow(hookBox, true) }),
      hooks?.installed ? h('button', { class: 'btn ghost', text: 'Remove…', onclick: () => void hookFlow(hookBox, false) }) : null,
      h('button', { class: 'btn ghost', text: 'Refresh limits', onclick: () => void ask('claude', 'refresh') }),
      h('button', { class: 'btn ghost', text: 'Test alert', onclick: () => void ask('claude', 'test-alert') }),
    ]),
  ]);
  kids.push(hookBox);
  panel.replaceChildren(...kids);
}

async function hookFlow(box: HTMLElement, install: boolean): Promise<void> {
  const prev = await ask<{ diff?: string; backup?: string; settingsPath?: string; fingerprint?: string; error?: string }>('claude', 'hooks-preview', install);
  box.querySelector('.hook-preview')?.remove();
  if (!prev || prev.error) {
    box.append(h('div', { class: 'hook-preview warn', text: prev?.error ?? 'Could not read Claude Code settings.' }));
    return;
  }
  const confirm = h('button', { class: 'btn primary', text: install ? 'Install' : 'Remove' });
  const view = h('div', { class: 'hook-preview' }, [
    h('div', { class: 'muted', text: `${prev.settingsPath} will change like this. A backup goes to ${prev.backup} first; your own hooks stay.` }),
    h('pre', { text: prev.diff ?? '' }),
    h('div', { class: 'hook-actions' }, [confirm, h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => view.remove() })]),
  ]);
  confirm.addEventListener('click', async () => {
    const r = await ask<{ ok: boolean; backup?: string; error?: string }>('claude', 'hooks-write', { install, fingerprint: prev.fingerprint });
    view.replaceChildren(h('div', { class: r?.ok ? 'ok' : 'warn', text: r?.ok ? `${install ? 'Installed' : 'Removed'}. Backup: ${r.backup}. New Claude Code sessions pick it up; restart running ones.` : r?.error ?? 'Failed' }));
  });
  box.append(view);
  springAnimate(view, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

// ------------------------------------------------------------------ Codex panel

interface CodexSnapshot {
  available: boolean;
  usage: { data: { fiveHour: { pct: number; resetsAt: number | null } | null; sevenDay: { pct: number; resetsAt: number | null } | null } | null } | null;
  asOf: number | null;
  tokens: { fresh: number; cached: number } | null;
  sessions: Array<{ id: string; displayTitle: string; label: string; tone: string; project: string; host: string; lastActivityMs: number; needsYou: boolean; cwd: string }>;
  closed: Array<{ id: string; displayTitle: string; project: string; closedAt: number; entrypoint: string | null; host?: string }>;
  hooks: { installed: boolean; upToDate: boolean; codexFound: boolean; hookReady: boolean; hooksPath: string; error: string | null } | null;
  hooksSeenAt: number;
}

let codexTimer: ReturnType<typeof setInterval> | undefined;
/** Does Codex run Island's hooks? Asked once per visit (it starts codex.exe for a moment), and after an install. */
let codexTrust: { trusted: boolean; error: string | null } | null = null;
let codexTrustAsked = false;

function codexPanel(): HTMLElement {
  const panel = h('div', { class: 'claude-panel' }, [h('div', { class: 'muted', text: 'Loading…' })]);
  codexTrust = null;
  codexTrustAsked = false;
  const load = async () => {
    const snap = await ask<CodexSnapshot>('codex', 'snapshot');
    if (!snap || !panel.isConnected || dragging || panel.querySelector('.hook-preview')) return;
    fillCodex(panel, snap);
    if (snap.hooks?.installed && !codexTrustAsked) {
      codexTrustAsked = true;
      void checkCodexTrust(panel, false);
    }
  };
  clearInterval(codexTimer);
  codexTimer = whileShown(panel, 'codex', load);
  return panel;
}

async function checkCodexTrust(panel: HTMLElement, trust: boolean): Promise<void> {
  codexTrust = (await ask<{ trusted: boolean; error: string | null }>('codex', 'hooks-trust', trust)) ?? { trusted: false, error: 'No answer' };
  const snap = await ask<CodexSnapshot>('codex', 'snapshot');
  if (snap && panel.isConnected && !panel.querySelector('.hook-preview')) fillCodex(panel, snap);
}

function fillCodex(panel: HTMLElement, s: CodexSnapshot): void {
  const now = Date.now();
  const d = s.usage?.data;
  const kids: Node[] = [];
  if (!s.available) {
    panel.replaceChildren(h('div', { class: 'muted', text: 'Codex has not run on this PC yet (no .codex folder). Install the Codex app or the Codex CLI, then come back.' }));
    return;
  }
  if (d) {
    kids.push(
      h('div', { class: 'limits' }, [
        meterRow('5 hours', d.fiveHour, SESSION_WINDOW_MS, d.fiveHour ? resetsIn(d.fiveHour.resetsAt, now) : '–'),
        meterRow('This week', d.sevenDay, WEEK_WINDOW_MS, d.sevenDay ? resetsOn(d.sevenDay.resetsAt, now) : '–'),
      ]),
    );
  }
  const extra: Node[] = [];
  if (!d) extra.push(h('span', { class: 'muted', text: 'Plan limits show here after a Codex turn on a ChatGPT plan.' }));
  else if (s.asOf) extra.push(h('span', { class: 'muted', text: `As of ${agoText(now - s.asOf)}: Codex updates them after each turn.` }));
  if (s.tokens) extra.push(h('span', { class: 'muted', text: `Tokens this week ${fmtTokens(s.tokens.fresh)}${s.tokens.cached ? `  +${fmtTokens(s.tokens.cached)} cache` : ''}` }));
  kids.push(h('div', { class: 'limit-extra' }, extra));

  const list = h('div', { class: 'sess-list' });
  if (!s.sessions.length) list.append(h('div', { class: 'muted', text: 'No Codex chats open. Start one in the Codex app, a terminal or your editor.' }));
  for (const x of s.sessions) {
    list.append(
      h('button', { class: `sess tone-${x.tone}`, title: `${x.displayTitle}\n${x.cwd}`, onclick: () => void ask('codex', 'switch', x.id) }, [
        h('span', { class: 'slot', text: '' }),
        h('span', { class: `dot${x.needsYou ? ' pulse' : ''}` }),
        h('span', { class: 'sess-title', text: x.displayTitle }),
        h('span', { class: 'sess-meta', text: [x.project, x.host, agoText(now - x.lastActivityMs)].filter(Boolean).join(' · ') }),
        h('span', { class: 'sess-label', text: x.label }),
      ]),
    );
  }
  kids.push(h('h3', { text: 'Chats' }), list);
  if (s.closed.length) {
    kids.push(h('h3', { text: 'Closed in the last day' }));
    kids.push(
      h('div', { class: 'mini-list' }, s.closed.map((c) =>
        h('button', { class: 'mini', title: c.entrypoint === 'codex-app' ? 'Reopens in the Codex app' : c.entrypoint === 'codex-editor' ? `Brings up ${c.host ?? 'your editor'}` : 'Reopens in a new terminal', onclick: () => void ask('codex', 'reopen', c.id) }, [
          h('span', { text: c.displayTitle }),
          h('span', { class: 'muted', text: agoText(now - c.closedAt) }),
        ]),
      )),
    );
  }

  const hooks = s.hooks;
  const stale = Boolean(hooks?.installed && hooks.upToDate === false);
  const trust = codexTrust;
  const trustText = !hooks?.installed ? '' : trust === null ? ', checking that Codex trusts them…' : trust.trusted ? ', trusted by Codex' : `, not trusted by Codex yet${trust.error ? ` (${trust.error})` : ''}`;
  const hookText = !hooks
    ? 'Hook status unknown'
    : hooks.error
      ? hooks.error
      : stale
        ? 'Installed, but from an older version. Update them so replies and answers from the island reach your chats.'
        : hooks.installed
          ? `Installed${trustText}${s.hooksSeenAt ? `. Last event ${agoText(now - s.hooksSeenAt)}` : '. Waiting for the first event'}`
          : "Not installed. Without hooks the island still lists chats from Codex's files, but answering commands and replying from the island need them.";
  const needsTrust = Boolean(hooks?.installed && trust && !trust.trusted);
  const hookBox = h('div', { class: 'hooks' }, [
    h('div', {}, [h('b', { text: 'Codex hooks ' }), h('span', { class: needsTrust || hooks?.error ? 'warn' : 'muted', text: hookText })]),
    hooks && !hooks.codexFound ? h('div', { class: 'muted', text: "codex.exe isn't on this PC, so Island can't ask Codex to trust its hooks. Install the Codex app or the CLI first." }) : null,
    h('div', { class: 'hook-actions' }, [
      h('button', { class: stale ? 'btn primary' : 'btn', text: stale ? 'Update hooks…' : hooks?.installed ? 'Reinstall…' : 'Install hooks…', onclick: () => void codexHookFlow(panel, hookBox, true) }),
      hooks?.installed ? h('button', { class: needsTrust ? 'btn primary' : 'btn ghost', text: needsTrust ? 'Trust them' : 'Check trust', onclick: () => { codexTrust = null; void checkCodexTrust(panel, needsTrust); } }) : null,
      hooks?.installed ? h('button', { class: 'btn ghost', text: 'Remove…', onclick: () => void codexHookFlow(panel, hookBox, false) }) : null,
      h('button', { class: 'btn ghost', text: 'Refresh', onclick: () => void ask('codex', 'refresh') }),
    ]),
  ]);
  kids.push(hookBox);
  panel.replaceChildren(...kids);
}

async function codexHookFlow(panel: HTMLElement, box: HTMLElement, install: boolean): Promise<void> {
  const prev = await ask<{ diff?: string; backup?: string; hooksPath?: string; fingerprint?: string; trust?: string[]; error?: string }>('codex', 'hooks-preview', install);
  box.querySelector('.hook-preview')?.remove();
  if (!prev || prev.error) {
    box.append(h('div', { class: 'hook-preview warn', text: prev?.error ?? "Could not read Codex's hooks.json." }));
    return;
  }
  const confirm = h('button', { class: 'btn primary', text: install ? 'Install and trust' : 'Remove' });
  const view = h('div', { class: 'hook-preview' }, [
    h('div', { class: 'muted', text: `${prev.hooksPath} will change like this. A backup goes to ${prev.backup} first; your own hooks stay.` }),
    h('pre', { text: prev.diff ?? '' }),
    ...(install && prev.trust?.length
      ? [
          h('div', { class: 'muted', text: "Codex runs a new hook only once it's trusted. Island then asks Codex to trust these (Codex writes them to its config.toml):" }),
          h('pre', { text: prev.trust.join('\n') }),
        ]
      : []),
    h('div', { class: 'hook-actions' }, [confirm, h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => view.remove() })]),
  ]);
  confirm.addEventListener('click', async () => {
    confirm.setAttribute('disabled', '');
    const r = await ask<{ ok: boolean; backup?: string; error?: string; trusted?: boolean; trustError?: string | null }>('codex', 'hooks-write', { install, fingerprint: prev.fingerprint });
    const backup = r?.backup ? ` Backup: ${r.backup}.` : '';
    let text = r?.error ?? 'Failed';
    let ok = Boolean(r?.ok);
    if (r?.ok && !install) text = `Removed.${backup}`;
    else if (r?.ok && r.trusted) text = `Installed, and Codex trusts them.${backup} New Codex chats pick them up; restart running ones.`;
    else if (r?.ok) {
      ok = false;
      text = `Installed, but Codex didn't trust them yet${r.trustError ? `: ${r.trustError}` : ''}. Fix that and press Trust them, or open Codex and type /hooks.${backup}`;
    }
    if (r?.ok) codexTrust = install ? { trusted: Boolean(r.trusted), error: r.trustError ?? null } : null;
    view.replaceChildren(
      h('div', { class: ok ? 'ok' : 'warn', text }),
      h('div', { class: 'hook-actions' }, [
        h('button', {
          class: 'btn ghost',
          text: 'Done',
          onclick: () => {
            view.remove();
            void ask<CodexSnapshot>('codex', 'snapshot').then((snap) => {
              if (snap && panel.isConnected) fillCodex(panel, snap);
            });
          },
        }),
      ]),
    );
  });
  box.append(view);
  springAnimate(view, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

// ------------------------------------------------------------------ Cursor panel

interface CursorSnapshot {
  available: boolean;
  sessions: Array<{ id: string; displayTitle: string; label: string; tone: string; project: string; host: string; lastActivityMs: number; needsYou: boolean; cwd: string }>;
  closed: Array<{ id: string; displayTitle: string; project: string; closedAt: number }>;
  hooks: { installed: boolean; upToDate: boolean; gate: boolean; cursorFound: boolean; hookReady: boolean; hooksPath: string; error: string | null } | null;
  hooksSeenAt: number;
  /** Ask me here before Cursor runs a command (the option). */
  gate: boolean;
}

let cursorTimer: ReturnType<typeof setInterval> | undefined;

function cursorPanel(): HTMLElement {
  const panel = h('div', { class: 'claude-panel' }, [h('div', { class: 'muted', text: 'Loading…' })]);
  const load = async () => {
    const snap = await ask<CursorSnapshot>('cursor', 'snapshot');
    if (!snap || !panel.isConnected || dragging || panel.querySelector('.hook-preview')) return;
    fillCursor(panel, snap);
  };
  clearInterval(cursorTimer);
  cursorTimer = whileShown(panel, 'cursor', load);
  return panel;
}

function fillCursor(panel: HTMLElement, s: CursorSnapshot): void {
  const now = Date.now();
  if (!s.available) {
    panel.replaceChildren(h('div', { class: 'muted', text: "Cursor isn't on this PC. Install Cursor, then come back." }));
    return;
  }
  const kids: Node[] = [];
  const list = h('div', { class: 'sess-list' });
  if (!s.sessions.length) list.append(h('div', { class: 'muted', text: "No Cursor agent chats open. Start one in Cursor's chat." }));
  for (const x of s.sessions) {
    list.append(
      h('button', { class: `sess tone-${x.tone}`, title: `${x.displayTitle}\n${x.cwd}`, onclick: () => void ask('cursor', 'switch', x.id) }, [
        h('span', { class: 'slot', text: '' }),
        h('span', { class: `dot${x.needsYou ? ' pulse' : ''}` }),
        h('span', { class: 'sess-title', text: x.displayTitle }),
        h('span', { class: 'sess-meta', text: [x.project, agoText(now - x.lastActivityMs)].filter(Boolean).join(' · ') }),
        h('span', { class: 'sess-label', text: x.label }),
      ]),
    );
  }
  kids.push(h('h3', { text: 'Chats' }), list);
  if (s.closed.length) {
    kids.push(h('h3', { text: 'Closed in the last day' }));
    kids.push(
      h('div', { class: 'mini-list' }, s.closed.map((c) =>
        h('button', { class: 'mini', title: 'Brings up Cursor at this folder', onclick: () => void ask('cursor', 'reopen', c.id) }, [
          h('span', { text: c.displayTitle }),
          h('span', { class: 'muted', text: agoText(now - c.closedAt) }),
        ]),
      )),
    );
  }

  const hooks = s.hooks;
  const stale = Boolean(hooks?.installed && hooks.upToDate === false);
  const gateDiffers = Boolean(hooks?.installed && hooks.gate !== s.gate);
  const hookText = !hooks
    ? 'Hook status unknown'
    : hooks.error
      ? hooks.error
      : stale
        ? 'Installed, but from an older version. Update them so replies from the island reach your chats.'
        : gateDiffers
          ? s.gate
            ? 'Installed without the command hooks. Update them so Cursor asks you here before running a command.'
            : 'Installed with the command hooks, but asking here is off. Update them to take those out.'
          : hooks.installed
            ? `Installed${hooks.gate ? ', asking here before commands' : ''}${s.hooksSeenAt ? `. Last event ${agoText(now - s.hooksSeenAt)}` : '. Waiting for the first event'}`
            : "Not installed. Without hooks the island still lists chats from Cursor's transcripts, but replies and finished cards need them.";
  const hookBox = h('div', { class: 'hooks' }, [
    h('div', {}, [h('b', { text: 'Cursor hooks ' }), h('span', { class: hooks?.error ? 'warn' : 'muted', text: hookText })]),
    h('div', { class: 'hook-actions' }, [
      h('button', { class: stale || gateDiffers ? 'btn primary' : 'btn', text: stale || gateDiffers ? 'Update hooks…' : hooks?.installed ? 'Reinstall…' : 'Install hooks…', onclick: () => void cursorHookFlow(panel, hookBox, true, s.gate) }),
      hooks?.installed ? h('button', { class: 'btn ghost', text: 'Remove…', onclick: () => void cursorHookFlow(panel, hookBox, false, s.gate) }) : null,
      h('button', { class: 'btn ghost', text: 'Refresh', onclick: () => void ask('cursor', 'refresh') }),
    ]),
  ]);
  kids.push(hookBox);
  panel.replaceChildren(...kids);
}

async function cursorHookFlow(panel: HTMLElement, box: HTMLElement, install: boolean, gate: boolean): Promise<void> {
  const prev = await ask<{ diff?: string; backup?: string; hooksPath?: string; fingerprint?: string; error?: string }>('cursor', 'hooks-preview', { install, gate });
  box.querySelector('.hook-preview')?.remove();
  if (!prev || prev.error) {
    box.append(h('div', { class: 'hook-preview warn', text: prev?.error ?? "Could not read Cursor's hooks.json." }));
    return;
  }
  const confirm = h('button', { class: 'btn primary', text: install ? 'Install' : 'Remove' });
  const view = h('div', { class: 'hook-preview' }, [
    h('div', { class: 'muted', text: `${prev.hooksPath} will change like this. A backup goes to ${prev.backup} first; your own hooks stay.` }),
    h('pre', { text: prev.diff ?? '' }),
    h('div', { class: 'hook-actions' }, [confirm, h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => view.remove() })]),
  ]);
  confirm.addEventListener('click', async () => {
    confirm.setAttribute('disabled', '');
    const r = await ask<{ ok: boolean; backup?: string; error?: string }>('cursor', 'hooks-write', { install, gate, fingerprint: prev.fingerprint });
    const backup = r?.backup ? ` Backup: ${r.backup}.` : '';
    const text = r?.ok ? (install ? `Installed.${backup} Cursor picks them up at once; if a chat misses them, restart Cursor.` : `Removed.${backup}`) : (r?.error ?? 'Failed');
    view.replaceChildren(
      h('div', { class: r?.ok ? 'ok' : 'warn', text }),
      h('div', { class: 'hook-actions' }, [
        h('button', {
          class: 'btn ghost',
          text: 'Done',
          onclick: () => {
            view.remove();
            void ask<CursorSnapshot>('cursor', 'snapshot').then((snap) => {
              if (snap && panel.isConnected) fillCursor(panel, snap);
            });
          },
        }),
      ]),
    );
  });
  box.append(view);
  springAnimate(view, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

// ------------------------------------------------------------------ Antigravity panel

interface AgSnapshot {
  available: boolean;
  sessions: Array<{ id: string; displayTitle: string; label: string; tone: string; project: string; host: string; lastActivityMs: number; needsYou: boolean; cwd: string }>;
  closed: Array<{ id: string; displayTitle: string; project: string; closedAt: number }>;
  hooks: { installed: boolean; upToDate: boolean; gate: boolean; cursorFound: boolean; hookReady: boolean; hooksPath: string; error: string | null } | null;
  hooksSeenAt: number;
  /** Ask me here before Antigravity runs a command (the option). */
  gate: boolean;
}

let agTimer: ReturnType<typeof setInterval> | undefined;

function antigravityPanel(): HTMLElement {
  const panel = h('div', { class: 'claude-panel' }, [h('div', { class: 'muted', text: 'Loading…' })]);
  const load = async () => {
    const snap = await ask<AgSnapshot>('antigravity', 'snapshot');
    if (!snap || !panel.isConnected || dragging || panel.querySelector('.hook-preview')) return;
    fillAntigravity(panel, snap);
  };
  clearInterval(agTimer);
  agTimer = whileShown(panel, 'antigravity', load);
  return panel;
}

function fillAntigravity(panel: HTMLElement, s: AgSnapshot): void {
  const now = Date.now();
  if (!s.available) {
    panel.replaceChildren(h('div', { class: 'muted', text: "Antigravity isn't on this PC. Install the Antigravity app, IDE or CLI, then come back." }));
    return;
  }
  const kids: Node[] = [];
  const list = h('div', { class: 'sess-list' });
  if (!s.sessions.length) list.append(h('div', { class: 'muted', text: "No Antigravity chats open. Start one in the Antigravity app, IDE or CLI." }));
  for (const x of s.sessions) {
    list.append(
      h('button', { class: `sess tone-${x.tone}`, title: `${x.displayTitle}\n${x.cwd}`, onclick: () => void ask('antigravity', 'switch', x.id) }, [
        h('span', { class: 'slot', text: '' }),
        h('span', { class: `dot${x.needsYou ? ' pulse' : ''}` }),
        h('span', { class: 'sess-title', text: x.displayTitle }),
        h('span', { class: 'sess-meta', text: [x.project, agoText(now - x.lastActivityMs)].filter(Boolean).join(' · ') }),
        h('span', { class: 'sess-label', text: x.label }),
      ]),
    );
  }
  kids.push(h('h3', { text: 'Chats' }), list);
  if (s.closed.length) {
    kids.push(h('h3', { text: 'Closed in the last day' }));
    kids.push(
      h('div', { class: 'mini-list' }, s.closed.map((c) =>
        h('button', { class: 'mini', title: 'Brings up Antigravity', onclick: () => void ask('antigravity', 'reopen', c.id) }, [
          h('span', { text: c.displayTitle }),
          h('span', { class: 'muted', text: agoText(now - c.closedAt) }),
        ]),
      )),
    );
  }

  const hooks = s.hooks;
  const stale = Boolean(hooks?.installed && hooks.upToDate === false);
  const gateDiffers = Boolean(hooks?.installed && hooks.gate !== s.gate);
  const hookText = !hooks
    ? 'Hook status unknown'
    : hooks.error
      ? hooks.error
      : stale
        ? 'Installed, but from an older version. Update them so replies from the island reach your chats.'
        : gateDiffers
          ? s.gate
            ? 'Installed without the command hooks. Update them so Antigravity asks you here before running a command.'
            : 'Installed with the command hooks, but asking here is off. Update them to take those out.'
          : hooks.installed
            ? `Installed${hooks.gate ? ', asking here before commands' : ''}${s.hooksSeenAt ? `. Last event ${agoText(now - s.hooksSeenAt)}` : '. Waiting for the first event'}`
            : "Not installed. Without hooks the island still lists chats from Antigravity's transcripts, but replies and finished cards need them.";
  const hookBox = h('div', { class: 'hooks' }, [
    h('div', {}, [h('b', { text: 'Antigravity hooks ' }), h('span', { class: hooks?.error ? 'warn' : 'muted', text: hookText })]),
    h('div', { class: 'hook-actions' }, [
      h('button', { class: stale || gateDiffers ? 'btn primary' : 'btn', text: stale || gateDiffers ? 'Update hooks…' : hooks?.installed ? 'Reinstall…' : 'Install hooks…', onclick: () => void antigravityHookFlow(panel, hookBox, true, s.gate) }),
      hooks?.installed ? h('button', { class: 'btn ghost', text: 'Remove…', onclick: () => void antigravityHookFlow(panel, hookBox, false, s.gate) }) : null,
      h('button', { class: 'btn ghost', text: 'Refresh', onclick: () => void ask('antigravity', 'refresh') }),
    ]),
  ]);
  kids.push(hookBox);
  panel.replaceChildren(...kids);
}

async function antigravityHookFlow(panel: HTMLElement, box: HTMLElement, install: boolean, gate: boolean): Promise<void> {
  const prev = await ask<{ diff?: string; backup?: string; hooksPath?: string; fingerprint?: string; error?: string }>('antigravity', 'hooks-preview', { install, gate });
  box.querySelector('.hook-preview')?.remove();
  if (!prev || prev.error) {
    box.append(h('div', { class: 'hook-preview warn', text: prev?.error ?? "Could not read Antigravity's hooks.json." }));
    return;
  }
  const confirm = h('button', { class: 'btn primary', text: install ? 'Install' : 'Remove' });
  const view = h('div', { class: 'hook-preview' }, [
    h('div', { class: 'muted', text: `${prev.hooksPath} will change like this. A backup goes to ${prev.backup} first; your own hooks stay.` }),
    h('pre', { text: prev.diff ?? '' }),
    h('div', { class: 'hook-actions' }, [confirm, h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => view.remove() })]),
  ]);
  confirm.addEventListener('click', async () => {
    confirm.setAttribute('disabled', '');
    const r = await ask<{ ok: boolean; backup?: string; error?: string }>('antigravity', 'hooks-write', { install, gate, fingerprint: prev.fingerprint });
    const backup = r?.backup ? ` Backup: ${r.backup}.` : '';
    const text = r?.ok ? (install ? `Installed.${backup} New Antigravity chats pick them up; restart running ones.` : `Removed.${backup}`) : (r?.error ?? 'Failed');
    view.replaceChildren(
      h('div', { class: r?.ok ? 'ok' : 'warn', text }),
      h('div', { class: 'hook-actions' }, [
        h('button', {
          class: 'btn ghost',
          text: 'Done',
          onclick: () => {
            view.remove();
            void ask<AgSnapshot>('antigravity', 'snapshot').then((snap) => {
              if (snap && panel.isConnected) fillAntigravity(panel, snap);
            });
          },
        }),
      ]),
    );
  });
  box.append(view);
  springAnimate(view, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

// ------------------------------------------------------------------ settings page

/** Everything that makes Island go online, for the Privacy section. Keep it in step with the Rust HTTP calls. */
function privacyNote(mac: boolean): string {
  const online = [
    // Claude Code and Games are not on a Mac yet.
    ...(mac ? [] : ["Claude plan limits (with Claude Code's own sign-in)"]),
    "Ask (Anthropic's API, with your key)",
    'weather (Open-Meteo)',
    'a calendar link',
    'the integrations you connect',
    'Send to my phone (the notification text goes through ntfy.sh)',
    "Land's friends on other networks (n0's relays and key lookup see which Islands connect, never the files)",
    "a phone you pair in Your phone (n0's relays carry its connection, encrypted end to end; its notifications go through Apple's push service, encrypted for the phone)",
    ...(mac ? [] : ["the Games ping (the game's server, or 1.1.1.1)"]),
    'the Local AI models you choose to download',
  ];
  const list = `${online.slice(0, -1).join(', ')} and ${online[online.length - 1]}`;
  return `Island only goes online for what you turn on: ${list}. With Update automatically on, it also asks GitHub for a newer Island every 6 hours. Questions the bot answers with Local never leave ${thisComputer()}.`;
}

/** The old one-page Settings, split by `part` into the sidebar's pages (by section). */
function settingsPage(part: 'island' | 'behavior' | 'alerts' | 'phone' | 'general'): HTMLElement {
  const s = settings;
  const i = s.island;
  const g = s.general;
  const mac = platform === 'macos';
  const accents = h('div', { class: 'swatches' }, Object.entries(ACCENTS).map(([name, color]) =>
    h('button', { class: `swatch${i.accent === name ? ' on' : ''}`, title: name, style: `--c:${color}`, onclick: () => { i.accent = name; save(true); render(); } }),
  ));
  const edge = h('input', { type: 'range', min: 0, max: 40, value: String(i.edge) });
  edge.addEventListener('input', () => {
    i.edge = Number(edge.value);
    save();
  });
  const displayModes: Array<[typeof i.display, string]> = [['primary', 'Primary'], ['cursor', 'Follow mouse'], ['active', 'Follow active window'], ['specific', 'Specific']];
  if (monitors.length >= 2) displayModes.push(['duplicate', 'Duplicate']);
  const displayChoice = segmented(i.display, displayModes, (v) => {
    i.display = v;
    if (v === 'specific' && !i.displayId) i.displayId = monitors[0]?.id ?? null;
    if (v === 'duplicate' && !i.displayIds.some((id) => monitors.some((m) => m.id === id))) i.displayIds = monitors.map((m) => m.id);
    save(true);
    render();
  });
  const duplicate = i.display === 'duplicate';
  const monitorList = h('div', { class: 'monitors' }, monitors.map((m) =>
    h('button', {
      class: `monitor${(duplicate ? i.displayIds.includes(m.id) : i.display === 'specific' && i.displayId === m.id) ? ' on' : ''}`,
      onclick: () => {
        if (duplicate) i.displayIds = i.displayIds.includes(m.id) ? i.displayIds.filter((id) => id !== m.id) : [...i.displayIds, m.id];
        else {
          i.display = 'specific';
          i.displayId = m.id;
        }
        save(true);
        render();
      },
    }, [h('b', { text: `${m.name}${m.primary ? ' (primary)' : ''}` }), h('span', { class: 'muted', text: `${m.bounds.width}×${m.bounds.height} · ${Math.round(m.scale * 100)}% · taskbar ${m.taskbar}` })]),
  ));
  // Clear ↔ Tinted, like iOS Liquid Glass; the island follows while dragging.
  const glass = h('input', { type: 'range', min: 0, max: 100, value: String(i.glass), 'aria-label': 'Glass' });
  glass.addEventListener('input', () => {
    i.glass = Number(glass.value);
    save();
  });
  const glassSlider = h('div', { class: 'glass-slider' }, [h('span', { class: 'muted', text: 'Clear' }), glass, h('span', { class: 'muted', text: 'Tinted' })]);
  const secs: HTMLElement[] = [
    section('Appearance', [
      stacked(row('Pill colour', 'The whole island, card included.', pillColours(i))),
      ...(i.color === 'glass' ? [row('Glass', 'Clear is more see-through; tinted lets less of what is behind show through.', glassSlider)] : []),
      ...(i.color === 'custom' ? [row('Your colour', 'Text on it turns dark by itself when the colour is light.', customColour(i))] : []),
      row('Accent', null, accents),
      // As the taskbar can take it (Justin, 11-20).
      row("In the album's colour", "While a song plays, the island takes its album art's colour, as its music card does: the pill alone, or the pill and every card.", segmented(i.albumTint, [['off', 'Off'], ['compact', 'Pill only'], ['all', 'All of it']], (v) => { i.albumTint = v; save(true); render(); })),
      row('Bot', 'A little bot beside the pill, in your accent colour. It reacts to what happens; click it to talk to it.', toggle(i.bot, (v) => { i.bot = v; save(true); render(); })),
      row('Size', 'Pill height and text size.', segmented(i.size, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => { i.size = v; save(true); render(); })),
      // Like the taskbar's Blend into the bottom; floating stays the default.
      row(blendLabel(i.anchor), `Sits on the screen's ${i.anchor} edge, flat along it, instead of floating ${i.anchor === 'top' ? 'below' : i.anchor === 'bottom' ? 'above' : 'beside'} it.`, toggle(i.blend, (v) => { i.blend = v; save(true); render(); })),
      ...(i.blend ? [] : [row('Distance from the edge', 'Gap between the island and its screen edge.', edge)]),
      row('When nothing is happening', null, segmented(i.idle, [['pill', 'Small pill'], ['hidden', 'Tuck away']], (v) => { i.idle = v; save(true); render(); })),
      row('Reduce motion', 'Springs jump straight to their end.', segmented(i.reduceMotion, [['system', 'System'], ['on', 'On'], ['off', 'Off']], (v) => { i.reduceMotion = v; save(true); render(); })),
      row('When pointed at', 'How an activity grows when you point at it. Each one can override this in Activities.', segmented(i.defaultGrows, [['wide', 'Sideways'], ['card', 'Into a card']], (v) => { i.defaultGrows = v; save(true); render(); })),
      row('Hover card', "What shows under the island when you point at it. Music's player and Phone's list still show when you point at them.", segmented(i.hoverCard, [['pointer', 'What you point at'], ['claude', 'Claude stats']], (v) => { i.hoverCard = v; save(true); render(); })),
      row('Border glow', 'Light that circles the pill while something works; orange is Claude. Off saves the most battery.', segmented(i.glow, [['off', 'Off'], ['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']], (v) => { i.glow = v; save(true); render(); })),
    ]),
    section('Display', [
      stacked(row('Show the island on', duplicate ? 'Duplicate: the pill shows on every screen picked below. The one on the screen your pointer is on is the one that works; pointing at one never moves the others.' : 'Multi-monitor: which display it lives on.', displayChoice)),
      monitorList,
    ]),
    section('Behavior', [
      row('Expand on hover', null, toggle(i.hoverExpand, (v) => { i.hoverExpand = v; save(true); })),
      row('Peek behind', `With the pointer on the island, tap ${ctrlKey()}: it fades and your clicks go to whatever is under it, until the pointer moves away.`, toggle(i.peekThrough, (v) => { i.peekThrough = v; save(true); })),
      row('Peek lasts', `How long a tap of ${ctrlKey()} keeps the island faded.`, segmented(i.peekUntilBack ? 'back' : 'off', [['off', 'Until the pointer moves off'], ['back', 'Until it comes back']], (v) => { i.peekUntilBack = v === 'back'; save(true); render(); })),
      row('Smart fade', 'The island stays faded until you point at it. Pop-ups, like a finished chat, still show in full.', toggle(i.smartFade, (v) => { i.smartFade = v; save(true); })),
      row('Hide in full-screen apps', 'Games, videos and presentations. Urgent things still show.', toggle(i.hideInFullscreen, (v) => { i.hideInFullscreen = v; save(true); })),
      row('Show other activities beside the main one', 'Small chips, with +N when there is no room.', toggle(i.showSecondary, (v) => { i.showSecondary = v; save(true); render(); })),
      ...(i.showSecondary
        ? [
            row('Icons on the small pill', 'The other activities as small icons while the island rests. The pill grows to fit them, so none drop off.', segmented(i.compactIcons.show, [['always', 'Always'], ['hover', 'Only when pointed at'], ['never', 'Never']], (v) => { i.compactIcons.show = v; save(true); render(); })),
            ...(i.compactIcons.show === 'never' ? [] : [row('Where they sit', i.anchor === 'left' || i.anchor === 'right' ? 'On a standing pill, Left is the top end and Right the bottom.' : null, segmented(i.compactIcons.side, [['start', 'Left'], ['end', 'Right']], (v) => { i.compactIcons.side = v; save(true); render(); }))]),
          ]
        : []),
      row('Do not disturb', 'Nothing expands on its own; urgent moments still interrupt.', toggle(g.dnd, (v) => { g.dnd = v; save(true); })),
      menuRow(i),
      hideRow(i, mac),
      fadeRow(i),
    ]),
    section('Startup', [
      row(mac ? 'Open at login' : 'Start with Windows', null, toggle(g.startWithWindows, (v) => { g.startWithWindows = v; save(true); void native.autostartSet(v); })),
      row('Update automatically', mac ? 'When a newer Island is released, it downloads in the background and Island restarts into it. Island must be in Applications.' : 'When a newer Island is released, it downloads in the background and Island restarts into it.', toggle(g.autoUpdate, (v) => { g.autoUpdate = v; save(true); })),
      row('Run setup again', 'The two questions, the Local AI model and your phone. Your Control Center is rebuilt from the answers.', h('button', { class: 'btn', text: 'Run setup', onclick: () => go('welcome') })),
    ]),
    section('Notifications', [
      row(mac ? 'Mac notifications' : 'Windows notifications', 'A notification for moments that need you (Claude sessions, timers).', toggle(g.notifications, (v) => { g.notifications = v; save(true); })),
      row('Sounds', 'A chime when something finishes or needs you. Reminders chime either way.', toggle(g.sounds, (v) => { g.sounds = v; save(true); })),
      ...soundRows(g.sound),
      row('Send to my phone', 'The same notifications, pushed to the free ntfy app on your phone, wherever it is.', toggle(g.phonePush, (v) => { g.phonePush = v; if (v && !g.phoneTopic) g.phoneTopic = newPhoneTopic(); save(true); render(); })),
      ...(g.phonePush && g.phoneTopic ? [phoneRow(g)] : []),
      ...(g.phonePush && g.phoneTopic && !mac
        ? [
            row(
              'Answer Claude and Codex from my phone',
              "Claude Code's permission pushes get Allow and Deny buttons. With Windows Hello asked before Allow (Activities › Claude Status › Claude Code), the phone can only Deny. Anyone who can read your topic could tap them too, so keep it to yourself.",
              toggle(g.phoneApprove, (v) => {
                g.phoneApprove = v;
                if (v && !g.phoneReplyTopic) g.phoneReplyTopic = newPhoneTopic();
                save(true);
              }),
            ),
          ]
        : []),
    ]),
    phoneSection({ settings: () => settings, save: () => save(true) }),
    section('Privacy', [
      row('Show what you copied', 'Off: the Clipboard activity only says "Copied". Password managers are always skipped.', toggle(s.privacy.clipboardContent, (v) => { s.privacy.clipboardContent = v; save(true); })),
      row('Screenshot thumbnails', null, toggle(s.privacy.screenshotPreview, (v) => { s.privacy.screenshotPreview = v; save(true); })),
      h('p', { class: 'muted', text: privacyNote(mac) }),
    ]),
    section('About', [
      h('p', { text: `Island ${__APP_VERSION__} by Moss. Claude session logic comes from Usage Clip; the hook relay is adapted from Coucou (MIT, Louis Raillé) and the avatar from bloub (MIT, Jérémy Perret). Icons and the rest of the design are Island's own.` }),
      h('div', { class: 'hook-actions' }, [
        h('button', { class: 'btn ghost', text: 'Open log folder', onclick: () => void (islandData && native.open(islandData)) }),
        h('button', { class: 'btn danger', text: 'Quit Island', onclick: () => void native.quit() }),
      ]),
    ]),
  ];
  const titled = (el: HTMLElement) => el.querySelector('h2')?.textContent?.trim() ?? '';
  const KNOWN = ['Appearance', 'Display', 'Behavior', 'Startup', 'Notifications', 'Privacy', 'About'];
  const parts: Record<typeof part, { title: string; sub: string; keep: (t: string) => boolean; preview?: HTMLElement }> = {
    island: { title: 'Island', sub: 'How the island looks, where it sits and how wide it gets.', keep: (t) => t === 'Appearance' || t === 'Display', preview: islandPreview(s) },
    behavior: { title: 'Behavior', sub: 'How the island acts when you point at it, click it, or work full screen.', keep: (t) => t === 'Behavior' },
    alerts: { title: 'Alerts', sub: 'Notifications and sounds when something finishes or needs you.', keep: (t) => t === 'Notifications', preview: alertPreview(s, (k) => void playSound(k, s.general.sound)) },
    phone: { title: 'Phone', sub: 'Island on your phone.', keep: (t) => !KNOWN.includes(t) },
    general: { title: 'General', sub: 'Startup, privacy and about.', keep: (t) => t === 'Startup' || t === 'Privacy' || t === 'About' },
  };
  const pp = parts[part];
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: pp.title }), h('p', { text: pp.sub })]),
    pp.preview ? h('div', { class: 'preview-dock' }, [pp.preview]) : null,
    ...secs.filter((el) => pp.keep(titled(el))),
    part === 'island' ? sizeCard() : null,
  ]);
}

const islandPage = () => settingsPage('island');
const behaviorPage = () => settingsPage('behavior');
const alertsPage = () => settingsPage('alerts');
const phonePage = () => settingsPage('phone');
const generalPage = () => settingsPage('general');

// ------------------------------------------------------------------ controls page

/** Every gesture and key the island answers to, in one place; the keys can be changed here too. */
function controlsPage(): HTMLElement {
  const g = settings.general;
  const mac = platform === 'macos';
  const hotkey = (key: 'toggleHotkey' | 'activitiesHotkey', failId: string) => {
    const input = h('input', { type: 'text', value: g[key], spellcheck: 'false', placeholder: 'e.g. Alt+Shift+Space' });
    input.addEventListener('change', () => {
      g[key] = input.value.trim();
      save(true);
      // The Hide and show lines name the toggle key.
      render();
    });
    return h('div', { class: 'hotkey' }, [input, hotkeyFailures.includes(failId) ? h('span', { class: 'warn', text: 'Taken by another app' }) : null]);
  };
  const line = ([how, what]: [string, string]) => h('div', { class: 'ctl-row' }, [h('span', { class: 'ctl-how', text: how }), h('span', { class: 'ctl-what', text: what })]);
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: 'Controls' }), h('p', { text: 'Every gesture and key the island answers to.' })]),
    ...gestureGroups(settings, platform).map((grp) => section(grp.title, grp.items.map(line))),
    section('Keyboard shortcuts', [
      row('Open or close the island', null, hotkey('toggleHotkey', 'island.toggle')),
      row('Open Activities', null, hotkey('activitiesHotkey', 'island.activities')),
      // Claude Code comes to the Mac in part 2, its session keys with it.
      ...(mac ? [] : [h('p', { class: 'muted', text: 'Claude Code sessions: Alt+Shift+1–9 switches, Alt+Shift+0 jumps to the one that needs you (Activities › Claude Status › Claude Code › Session hotkeys).' })]),
    ]),
  ]);
}

function soundRows(snd: Settings['general']['sound']): HTMLElement[] {
  const volume = h('input', { type: 'range', min: 0, max: 100, value: String(snd.volume) });
  volume.addEventListener('input', () => {
    snd.volume = Number(volume.value);
    save();
  });
  volume.addEventListener('change', () => void playSound('done', snd));
  const hear = (kind: ChimeKind, text: string) => h('button', { class: 'btn', text, onclick: () => void playSound(kind, snd) });
  // The dialog can outlast a settings update from the island, so the file goes on what is current then.
  const pick = async (kind: ChimeKind) => {
    const got = await native.soundPick(kind);
    soundError = got.error ?? '';
    if (got.name) {
      const now = settings.general.sound;
      now[kind] = got.name;
      now.rev += 1;
      save(true);
      void playSound(kind, now);
    }
    render();
  };
  const forget = async (kind: ChimeKind) => {
    await native.soundClear(kind);
    const now = settings.general.sound;
    now[kind] = '';
    now.rev += 1;
    save(true);
    render();
  };
  const own = (kind: ChimeKind, title: string) =>
    row(title, snd[kind] || 'No file yet: the Soft chime plays.', h('div', { class: 'sound-own' }, [
      h('button', { class: 'btn', text: snd[kind] ? 'Change…' : 'Choose…', onclick: () => void pick(kind) }),
      snd[kind] ? h('button', { class: 'btn ghost', text: 'Remove', onclick: () => void forget(kind) }) : null,
    ]));
  return [
    stacked(row('Sound', 'Pick one to hear it.', segmented(snd.style, styleChoices(), (v) => { snd.style = v; save(true); render(); void playSound('done', snd); }))),
    ...(snd.style === 'custom'
      ? [
          own('done', 'When something finishes'),
          own('attention', 'When something needs you'),
          ...(soundError ? [h('div', { class: 'row-help warn', text: soundError })] : []),
        ]
      : []),
    row('Volume', null, volume),
    row('Hear it', null, h('div', { class: 'sound-own' }, [hear('done', 'Finished'), hear('attention', 'Needs you')])),
  ];
}

/**
 * The island's right-click menu: a preview of it at the island's own size (the open island's thickness,
 * and only as long as its items, as on the screen), and its items to drag into order, show or hide, and
 * show as icon only or icon and name. An item can be dragged straight onto the preview, or moved along it
 * (Justin). Settings is always there, last: the way back here.
 */
function menuRow(i: Settings['island']): HTMLElement {
  const stage = h('div', { class: 'menu-stage' });
  const preview = h('div', { class: 'menu-preview', 'aria-label': 'Preview of the right-click menu' });
  stage.append(preview);
  const list = h('div', { class: 'menu-editor', role: 'list' });
  const state = () => ({ anchor: i.anchor, dnd: settings.general.dnd, mac: platform === 'macos', reminders: true });
  const lookOf = (order: MenuItemId[]) => ({ order, iconOnly: i.menuIconOnly, settingsIconOnly: i.menuSettingsIconOnly });
  /** The menu as the island lays it out: its length, thickness and padding, and where each part sits. */
  const layout = (order: MenuItemId[], shown: Settings['island']['menu']) => {
    // The island's screen is this one's (Settings opens on it); the island's open size at its Size setting.
    const area = { width: window.screen.width || 1536, height: window.screen.availHeight || 864 };
    const size = pillSize(area, i.widths, 'maximum', i.edge, i.size, 'horizontal');
    const pad = innerPadding(size.cross);
    const st = state();
    const look = lookOf(order);
    const main = menuMain(shown, st, { max: size.main, cross: size.cross, pad, vertical: false, crossMax: size.h }, undefined, look);
    return { main, cross: size.cross, pad, placed: fitSegments(menuSegments(shown, st, look), main - pad * 2, size.cross) };
  };
  /** Which item a part of the menu belongs to (Position is a label, four buttons and its lines); null: Settings. */
  const idOf = (key: string): MenuItemId | null => {
    const k = key.slice('menu/'.length);
    if (['top', 'right', 'bottom', 'left', 'label', 'sep', 'sep-before'].includes(k)) return 'position';
    if (k === 'dnd') return 'quiet';
    return (MENU_ITEMS.some((m) => m.id === k) ? k : null) as MenuItemId | null;
  };
  const listOrder = () => normalizeMenuOrder([...list.children].map((r) => (r as HTMLElement).dataset.id));
  /** Draws the preview for `order` and `shown` (a drag shows what letting go would do); `ghost` is the item being dragged. */
  const paint = (order: MenuItemId[] = listOrder(), shown: Settings['island']['menu'] = i.menu, ghost: MenuItemId | null = null) => {
    const { main, cross, pad, placed } = layout(order, shown);
    preview.style.width = `${main}px`;
    preview.style.height = `${cross}px`;
    preview.style.borderRadius = `${cross / 2}px`;
    preview.replaceChildren(
      ...placed.map(({ seg, x, w }) => {
        const id = idOf(seg.key);
        let el: HTMLElement;
        if (seg.t === 'sep') el = h('span', { class: 'mp-sep' });
        else if (seg.t === 'text') el = h('span', { class: 'mp-label', text: seg.text });
        else if (seg.t === 'button') {
          el = h('span', { class: `mp-btn style-${seg.style ?? 'secondary'}${seg.label ? '' : ' icon-only'}`, title: seg.tip ?? seg.label ?? '' });
          el.innerHTML = seg.icon ? icon(seg.icon) : '';
          if (seg.label) el.append(h('span', { text: seg.label }));
        } else el = h('span');
        el.classList.add('mp-item');
        if (id) el.dataset.id = id;
        if (id && id === ghost) el.classList.add('mp-ghost');
        el.style.left = `${pad + x}px`;
        el.style.width = `${w}px`;
        return el;
      }),
    );
  };
  /** Where `id` lands when let go at `clientX` over the preview: the menu's order with it there. */
  const dropOrder = (id: MenuItemId, clientX: number, shown: Settings['island']['menu']): MenuItemId[] => {
    const rest = listOrder().filter((x) => x !== id);
    const without = { ...shown, [id]: false };
    const { main, pad, placed } = layout(rest, without);
    const box = stage.getBoundingClientRect();
    const left = box.left + (box.width - main) / 2 + pad;
    // Each item's middle, from the menu laid out without the dragged one (so nothing shifts under the pointer).
    const span = new Map<MenuItemId, [number, number]>();
    for (const p of placed) {
      const pid = idOf(p.seg.key);
      if (!pid) continue;
      const [a, b] = span.get(pid) ?? [Infinity, -Infinity];
      span.set(pid, [Math.min(a, p.x), Math.max(b, p.x + p.w)]);
    }
    const before = rest.find((x) => {
      const s = span.get(x);
      return s !== undefined && clientX < left + (s[0] + s[1]) / 2;
    });
    const shownRest = rest.filter((x) => span.has(x));
    const at = before ? rest.indexOf(before) : shownRest.length ? rest.indexOf(shownRest[shownRest.length - 1]) + 1 : 0;
    return [...rest.slice(0, at), id, ...rest.slice(at)];
  };
  const overStage = (e: PointerEvent) => {
    const b = stage.getBoundingClientRect();
    return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6;
  };
  /** Puts `id` at `order`'s place and shows it, as dropped on the preview. */
  const place = (id: MenuItemId, order: MenuItemId[]) => {
    const was = i.menu[id];
    i.menuOrder = normalizeMenuOrder(order);
    i.menu[id] = true;
    fill();
    paint();
    save(true);
    // Hide's row below names the menu only while Hide is in it.
    if (id === 'hide' && !was) render();
  };
  const label = (id: MenuItemId) => MENU_ITEMS.find((m) => m.id === id)?.label ?? id;
  const iconOf: Record<MenuItemId, IconName> = { position: 'pos-top', quiet: 'moon', hide: 'eye-off', fade: 'fade', reminders: 'bell', workspaces: 'grid', activities: 'pulse', settings: 'settings' };
  const commit = () => {
    i.menuOrder = listOrder();
    paint();
    save(true);
  };
  const move = (r: HTMLElement, by: -1 | 1) => {
    const other = by < 0 ? r.previousElementSibling : r.nextElementSibling;
    if (!other || (other as HTMLElement).classList.contains('fixed')) return;
    if (by < 0) list.insertBefore(r, other);
    else list.insertBefore(other, r);
    commit();
  };
  const fill = () => {
    list.replaceChildren();
    for (const id of i.menuOrder) {
      const grip = h('button', { class: 'me-grip', title: 'Drag to move, or onto the island above (or Up / Down arrow keys)', 'aria-label': `Move ${label(id)}` });
      grip.innerHTML = icon('grip');
      const look = segmented(i.menuIconOnly[id] ? 'icon' : 'both', [['both', 'Icon and name'], ['icon', 'Icon only']], (v) => {
        i.menuIconOnly[id] = v === 'icon';
        if (id === 'settings') i.menuSettingsIconOnly = v === 'icon';
        for (const b of look.querySelectorAll('button')) b.classList.toggle('on', b.textContent === (v === 'icon' ? 'Icon only' : 'Icon and name'));
        paint();
        save(true);
      });
      const ico = h('span', { class: 'me-ico' });
      ico.innerHTML = icon(iconOf[id]);
      // Settings can move but never goes: it leads back here.
      const r: HTMLElement = h('div', { class: `me-row${id === 'settings' || i.menu[id] ? '' : ' off'}`, role: 'listitem' }, [
        grip,
        ico,
        h('span', { class: 'me-name', text: label(id) }),
        look,
        id === 'settings' ? h('span', { class: 'muted me-always', text: 'Always on' }) : toggle(i.menu[id], (on) => {
          i.menu[id] = on;
          r.classList.toggle('off', !on);
          paint();
          save(true);
          // Hide's row below names the menu only while Hide is in it.
          if (id === 'hide') render();
        }, `Show ${label(id)}`),
      ]);
      r.dataset.id = id;
      grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        move(r, e.key === 'ArrowUp' ? -1 : 1);
        grip.focus();
      });
      // Drag by the grip: pointer events, so a mouse, a touchpad and a finger all work. Along the list it
      // reorders; over the preview it shows where it would sit there, and letting go puts it there (on).
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Followed on the window: moving the row in the list takes it out of the page for a moment, which ends a pointer capture.
        r.classList.add('dragging');
        const startOrder = listOrder().join();
        let over: MenuItemId[] | null = null;
        const onMove = (ev: PointerEvent) => {
          if (overStage(ev)) {
            over = dropOrder(id, ev.clientX, i.menu);
            stage.classList.add('hot');
            paint(over, { ...i.menu, [id]: true }, id);
            return;
          }
          if (over) {
            over = null;
            stage.classList.remove('hot');
            paint();
          }
          for (const other of [...list.children] as HTMLElement[]) {
            if (other === r || other.classList.contains('fixed')) continue;
            const box = other.getBoundingClientRect();
            const mid = box.top + box.height / 2;
            const before = (r.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
            if (before && ev.clientY < mid) { list.insertBefore(r, other); paint(); break; }
            if (!before && ev.clientY > mid) { list.insertBefore(r, other.nextSibling); paint(); }
          }
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          r.classList.remove('dragging');
          stage.classList.remove('hot');
          if (over) place(id, over);
          else if (listOrder().join() !== startOrder) commit();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
      list.append(r);
    }
  };
  // An item on the preview moves along it: let go and it stays there; let go off it and nothing changes.
  preview.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.mp-item[data-id]');
    if (e.button !== 0 || !el) return;
    const id = el.dataset.id as MenuItemId;
    e.preventDefault();
    const x0 = e.clientX;
    let moving = false;
    let over: MenuItemId[] | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - x0) < 4) return;
      moving = true;
      if (overStage(ev)) {
        over = dropOrder(id, ev.clientX, i.menu);
        stage.classList.add('hot');
        paint(over, i.menu, id);
      } else if (over) {
        over = null;
        stage.classList.remove('hot');
        paint(listOrder(), i.menu, id);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      stage.classList.remove('hot');
      if (over && over.join() !== listOrder().join()) place(id, over);
      else paint();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  fill();
  paint();
  return stacked(row('Right-click menu', 'What the island shows when you right-click it, as it will look and as big as it is. Drag the handles to reorder, or drag an item straight onto the island; turn off what you never use and the menu gets shorter by that much. Settings always stays, last unless you move it.', h('div', { class: 'menu-edit-wrap' }, [stage, list])));
}

/**
 * Pill colour: Glass first, on its own (Moss, 11-20), then the solid looks, then Custom, your own
 * colour, its dot showing it.
 */
function pillColours(i: Settings['island']): HTMLElement {
  const pick = (v: PillColor, label: string, dot = false) =>
    h('button', { class: i.color === v ? 'on' : '', 'aria-pressed': String(i.color === v), onclick: () => { i.color = v; save(true); render(); } }, [
      ...(dot ? [h('i', { class: 'seg-dot', style: `--c:${i.custom}` })] : []),
      h('span', { text: label }),
    ]);
  return h('div', { class: 'segmented pill-colours' }, [
    pick('glass', 'Glass'),
    h('i', { class: 'seg-sep', 'aria-hidden': 'true' }),
    pick('black', 'Black'),
    pick('white', 'White'),
    pick('matte-white', 'Matte white'),
    pick('matte-black', 'Matte black'),
    h('i', { class: 'seg-sep', 'aria-hidden': 'true' }),
    pick('custom', 'Custom', true),
  ]);
}

/** Custom's colour: the system picker, the island following while you drag through it. */
function customColour(i: Settings['island']): HTMLElement {
  const input = h('input', { type: 'color', value: i.custom, 'aria-label': 'Pill colour' });
  const hex = h('span', { class: 'muted mono', text: i.custom.toUpperCase() });
  input.addEventListener('input', () => {
    i.custom = input.value.toLowerCase();
    hex.textContent = i.custom.toUpperCase();
    applyPill(document.documentElement, i.color, i.custom);
    save();
  });
  input.addEventListener('change', () => { save(true); render(); });
  return h('label', { class: 'custom-colour' }, [input, hex]);
}

/** Hide the island for a while, or, while it is hidden, say until when and bring it back. */
function hideRow(i: Settings['island'], mac: boolean): HTMLElement {
  const now = Date.now();
  if (i.hiddenUntil > now) {
    const at = backAt(i.hiddenUntil, now);
    const show = h('button', { class: 'btn', text: 'Show it now', onclick: () => { i.hiddenUntil = 0; save(true); render(); } });
    return row('The island is hidden', at ? `It comes back ${at}.` : 'It stays hidden until you bring it back.', show);
  }
  const tray = mac ? 'the menu bar icon' : 'the tray icon';
  const where = i.menu.hide ? `the island's right-click menu and ${tray}` : tray;
  const choices = h('div', { class: 'hide-choices' }, HIDE_CHOICES.map((c) =>
    h('button', { class: 'btn ghost', text: c.label, onclick: () => { i.hiddenUntil = hideUntil(c.id, Date.now()); save(true); render(); } }),
  ));
  return stacked(row('Hide the island', `The pill and the bot leave the screen for a while; Claude's prompts go back to the terminal meanwhile. Also in ${where}.`, choices));
}

/**
 * Fade the island: what the right-click menu's Fade card shows. Take both settings off and Fade
 * just fades, no card (Moss, 11-20). As it came, all three show.
 */
function fadeRow(i: Settings['island']): HTMLElement {
  const f = i.fadeCard;
  const on = (Object.keys(f) as Array<keyof typeof f>).filter((k) => f[k]);
  const pick = multiSegmented(on, [['now', 'Fade now'], ['peek', 'Peek lasts'], ['smart', 'Smart fade']], (v) => {
    i.fadeCard = { now: v.includes('now'), peek: v.includes('peek'), smart: v.includes('smart') };
    save(true);
    render();
  }, 0);
  const what = fadesAtOnce(f)
    ? "Fade in the right-click menu fades the island at once, nothing else. Right-click it and press Show to bring it back."
    : 'What the card shows when you press Fade in the right-click menu. Turn off Peek lasts and Smart fade and Fade just fades, no card.';
  return stacked(row('Fade the island', what, pick));
}

/** The topic to subscribe to on the phone, with Copy and a test push. */
function phoneRow(g: Settings['general']): HTMLElement {
  const status = h('span', { class: 'muted', text: '' });
  const test = async (): Promise<void> => {
    status.textContent = 'Sending…';
    const ok = await native.phonePush(g.phoneTopic, 'Island', 'Your phone is connected. Island notifications show up here now.');
    status.textContent = ok ? 'Sent. Check your phone.' : 'Could not reach ntfy.sh. Check the connection.';
  };
  const buttons = h('div', { class: 'hide-choices' }, [
    h('button', { class: 'btn ghost', text: 'Copy topic', onclick: () => { void native.clipboardSetText(g.phoneTopic); status.textContent = 'Copied.'; } }),
    h('button', { class: 'btn', text: 'Send a test', onclick: () => void test() }),
    status,
  ]);
  return stacked(row(`Topic: ${g.phoneTopic}`, 'On your iPhone: install ntfy from the App Store, tap +, paste this topic, Subscribe, and allow notifications. Keep the topic private: anyone who has it can read these.', buttons));
}

/** Island's data folder (log, relay, models), as Rust reports it on this system. */
let islandData = '';

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  settings = migrate(await native.settingsGet());
  monitors = await native.monitors();
  islandData = (await native.knownFolders()).islandData;
  await on<{ value: unknown; origin: string }>('settings', ({ value, origin }) => {
    if (origin === 'app') return;
    settings = migrate(value);
    render();
  });
  await on<{ id: string; result: unknown }>('app-reply', ({ id, result }) => {
    const r = replies.get(id);
    if (r) {
      replies.delete(id);
      r(result);
    }
  });
  await on<string>('navigate', (p) => go((p as Page) || 'activities'));
  const state = await ask<{ hotkeyFailures: string[] }>('island', 'state');
  hotkeyFailures = state?.hotkeyFailures ?? [];
  if (settings.general.startWithWindows !== (await native.autostartGet()) && isTauri) {
    settings.general.startWithWindows = await native.autostartGet();
  }
  render();
  window.addEventListener('keydown', (e) => {
    // A page that handles Escape itself (Workspaces: back, cancel) says so with preventDefault.
    // Escape closes an activity's panel, then clears a search, and only then the window.
    if (e.key === 'Escape' && !e.defaultPrevented && actOpen) {
      actOpen = null;
      render();
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented && searchQuery) {
      searchQuery = '';
      render();
      return;
    }
    if (e.key === 'Escape' && isTauri && !e.defaultPrevented) void getCurrentWindow().close();
  });
  void cloneSettings;
}

catchErrors('app', (line) => void native.log(line));
void boot();
