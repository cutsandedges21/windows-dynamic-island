// The Workspaces page of the Activities window: every workspace as a card (or, on the Time tab,
// where the week went), one workspace with its items and notes, and the editor. The page element lives as long as the window, so going
// to Activities and back (or a settings change redrawing the window) keeps an edit in progress.
// See docs/WORKSPACES.md.

import '../styles/workspaces.css';
import { isTauri, native, on, type Tried } from '../core/native';
import { springAnimate } from '../core/renderer';
import { springs } from '../core/spring';
import { h } from '../dom';
import type { Ctx, Noticing, Ui, View, WsTab } from './ctx';
import { dashboard } from './dashboard';
import { detail, flushNotes } from './detail';
import { cancelEdit, editor, loadDraft, saveEdit, startEdit } from './editor';
import type { WsSort } from './model';
import { readTrail } from './notice/model';
import type { Answer, Job } from './restore';
import { takeSeed } from './seed';
import { createStore } from './store';
import { workspaceSpans, type WsSpan } from './time';
import { loadTime } from './timeview';
import { boxOpen, closeMenu, keepFocus, menuOpen, toast } from './ui';

export interface WorkspacesPage {
  el: HTMLElement;
  /** Back to the cards (the sidebar's Workspaces, pressed while already here). */
  home(): void;
  /** The page is on screen again: the Time tab catches up. */
  shown(): void;
}

const UI_KEY = 'island:ws-ui';
/** The browser preview's stand-in for recent-work.json. */
const PREVIEW_TRAIL_KEY = 'island:recent-work';

function readUi(): { sort: WsSort; showArchived: boolean; tab: WsTab } {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as { sort?: unknown; showArchived?: unknown; tab?: unknown };
    return { sort: v.sort === 'recent' || v.sort === 'name' ? v.sort : 'manual', showArchived: v.showArchived === true, tab: v.tab === 'time' ? 'time' : 'cards' };
  } catch {
    return { sort: 'manual', showArchived: false, tab: 'cards' };
  }
}

export function rememberUi(ui: Ui): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ sort: ui.sort, showArchived: ui.showArchived, tab: ui.tab }));
  } catch {
    // Storage full or off: only the view choice is lost.
  }
}

/** Until the window says otherwise: on, kept two weeks. */
const NOTICING: Noticing = { on: () => true, days: () => 14, turnOn: () => undefined };

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** How the page talks to the island window (app.ts's ask: app-command / app-reply). */
export type Ask = <T>(target: string, cmd: string, arg?: unknown) => Promise<T | null>;

export function workspacesPage(accent: () => string, ask: Ask, noticing: Noticing = NOTICING): WorkspacesPage {
  const el = h('div', { class: 'page ws-page' });
  const saved = readUi();
  const ui: Ui = {
    query: '',
    sort: saved.sort,
    showArchived: saved.showArchived,
    notes: new Map(),
    checks: new Map(),
    pendingDraft: loadDraft(),
    listScroll: 0,
    job: null,
    jobClosed: null,
    tab: saved.tab,
    time: { back: 0, day: null, spans: null, for: 0, at: 0, loading: false, fresh: true },
  };
  const store = createStore('app', (message) => toast(message));
  const scroller = () => el.closest<HTMLElement>('.content');

  const render = (): HTMLElement => {
    const v = ctx.view;
    if (v.kind === 'detail') return detail(ctx, v.id);
    if (v.kind === 'edit') return editor(ctx, v.edit);
    return dashboard(ctx);
  };
  // A redraw while a button is held would swap the element under the pointer, and the click
  // (or a drag) would be lost: e.g. leaving a path box checks it, and the answer can land
  // between the press and the release on Add. So it waits for the release.
  let pressed = false;
  let owed = false;
  const paint = () => {
    if (pressed) {
      owed = true;
      return;
    }
    keepFocus(() => el.replaceChildren(render()));
  };
  const release = () => {
    pressed = false;
    if (owed) {
      owed = false;
      // After the click that the release makes.
      setTimeout(paint, 0);
    }
  };
  window.addEventListener('pointerdown', () => (pressed = true), true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  // Let go outside the window: the next move says no button is down.
  window.addEventListener('pointermove', (e) => pressed && e.buttons === 0 && release(), true);
  window.addEventListener('blur', () => pressed && release());
  const go = (view: View) => {
    closeMenu();
    flushNotes();
    const s = scroller();
    if (ctx.view.kind === 'list' && s) ui.listScroll = s.scrollTop;
    ctx.view = view;
    paint();
    if (s) s.scrollTop = view.kind === 'list' ? ui.listScroll : 0;
    const first = el.firstElementChild;
    if (first) springAnimate(first, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], springs.content);
  };

  /** A request to the island's engine; says why when the island doesn't answer. */
  const engine = async <T>(cmd: string, arg?: unknown): Promise<T | null> => {
    const r = await ask<T>('workspaces', cmd, arg);
    if (r === null) toast('The island didn’t answer. Restoring needs Island running.');
    return r;
  };
  const started = (r: Tried<string> | null) => {
    if (r && !r.ok) toast(r.error);
  };
  const ctx: Ctx = {
    store,
    ui,
    view: { kind: 'list' },
    accent,
    go,
    paint,
    restore: isTauri
      ? (ws) => {
          ui.jobClosed = null;
          void engine<Tried<string>>('restore', { id: ws.id }).then(started);
        }
      : null,
    answer: (step: string, a: Answer) => void engine('answer', { step, answer: a }),
    cancel: () => void engine('cancel'),
    retry: () => void engine<Tried<string>>('retry').then(started),
    noticing,
    spans: async (since: number, until: number): Promise<WsSpan[]> => {
      if (!isTauri) {
        try {
          return workspaceSpans(readTrail(JSON.parse(localStorage.getItem(PREVIEW_TRAIL_KEY) ?? 'null')).spans, since, until);
        } catch {
          return [];
        }
      }
      // The island's record has the last minute too; with the Workspaces activity off, the file.
      const live = await ask<WsSpan[]>('workspaces', 'spans', { since, until });
      if (Array.isArray(live)) return live;
      return workspaceSpans(readTrail(await native.noticeLoad()).spans, since, until);
    },
  };
  void on<Job>('ws-job', (job) => {
    ui.job = job;
    paint();
  });
  if (isTauri) void ask<Job | null>('workspaces', 'job').then((job) => {
    if (job && !ui.job) {
      ui.job = job;
      paint();
    }
  });

  store.subscribe(() => {
    // The workspace on screen was removed (in the other window, or by an undo).
    if (ctx.view.kind === 'detail' && store.ready && !store.get(ctx.view.id)) ctx.view = { kind: 'list' };
    paint();
  });

  // Capture, so this runs before the window's own Escape (which closes it) and can claim the key.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!el.isConnected || boxOpen() || menuOpen() || document.body.classList.contains('ws-dragging')) return;
      const v = ctx.view;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (v.kind === 'edit') {
          e.preventDefault();
          void cancelEdit(ctx, v.edit);
        } else if (v.kind === 'detail') {
          e.preventDefault();
          go({ kind: 'list' });
        } else if (ui.tab === 'time' && ui.time.day !== null) {
          // The day picked in the Time tab's bars: back to the whole week.
          e.preventDefault();
          ui.time.day = null;
          paint();
        } else if (ui.query) {
          e.preventDefault();
          ui.query = '';
          paint();
        }
      } else if (mod && key === 's' && v.kind === 'edit') {
        e.preventDefault();
        void saveEdit(ctx, v.edit);
      } else if (mod && key === 'n' && v.kind !== 'edit' && store.ready && !store.readOnly) {
        e.preventDefault();
        startEdit(ctx, null);
      } else if (v.kind === 'list' && ((mod && key === 'f') || (e.key === '/' && !typing(e.target)))) {
        // Search lives with the cards.
        if (ui.tab === 'time' && store.list.length) {
          ui.tab = 'cards';
          rememberUi(ui);
          paint();
        }
        const search = el.querySelector<HTMLInputElement>('.ws-search input');
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      }
    },
    true,
  );
  // Typing in a note saves a moment later; leaving the window saves now.
  window.addEventListener('blur', () => flushNotes());
  window.addEventListener('pagehide', () => flushNotes());

  // "Make it a workspace" from the island (Trail): the editor opens with what it noticed.
  paint();
  const loading = store.load();
  const takeOver = () => {
    const seed = takeSeed();
    if (seed) void loading.then(() => startEdit(ctx, null, { name: seed.name, description: seed.description, cwd: seed.cwd, apps: seed.apps }));
  };
  void on('ws-seed', () => takeOver());
  setTimeout(takeOver, 0);

  // The Time tab keeps up while it's on screen (loadTime fetches once the numbers are a minute old).
  const timeShowing = () => el.isConnected && ctx.view.kind === 'list' && ui.tab === 'time';
  setInterval(() => {
    if (timeShowing() && document.visibilityState === 'visible') loadTime(ctx);
  }, 15_000);
  return {
    el,
    home: () => go({ kind: 'list' }),
    shown: () => {
      if (!timeShowing()) return;
      loadTime(ctx, true);
      paint();
    },
  };
}
