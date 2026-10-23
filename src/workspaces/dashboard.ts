// The Workspaces page's front: two tabs, where the time went (timeview.ts) and the cards. The
// cards: one for each workspace (favorites first), search, the order they're shown in, the
// archived ones folded away, and a welcome when there are none yet.

import { agoText } from '../core/format';
import { icon } from '../core/icons';
import { native } from '../core/native';
import { segmented } from '../controls';
import { h } from '../dom';
import type { Ctx, WsTab } from './ctx';
import { discardDraft, resumeDraft, startEdit } from './editor';
import { contents, countText, displayName, duplicateWorkspace, KIND_META, matchScore, moveBefore, sortWorkspaces, STARTERS, wsColor, type Workspace, type WsSort } from './model';
import { rememberUi } from './page';
import { jobSummary } from './restore';
import { timeView } from './timeview';
import { confirmBox, dragSort, iconButton, labelled, openMenu, tile, toast, type MenuItem } from './ui';

export function dashboard(ctx: Ctx): HTMLElement {
  const { store, ui } = ctx;
  const page = h('div', { class: 'ws-dash' });
  const newButton = labelled('plus', 'New workspace', 'primary', () => startEdit(ctx, null));
  newButton.dataset.focus = 'new';
  if (store.readOnly) newButton.disabled = true;
  page.append(
    h('div', { class: 'ws-head' }, [
      h('div', { class: 'page-head' }, [
        h('h1', { text: 'Workspaces' }),
        h('p', { text: 'The apps, files, sites and commands one piece of work needs, with a note on where you left off. Open them all in one click.' }),
      ]),
      store.list.length ? newButton : null,
    ]),
  );
  page.append(...banners(ctx));
  if (!store.ready) {
    page.append(h('p', { class: 'muted', text: 'Loading your workspaces…' }));
    return page;
  }
  const all = store.list;
  if (!all.length) {
    page.append(welcome(ctx));
    return page;
  }
  page.append(tabs(ctx));
  if (ui.tab === 'time') {
    page.append(timeView(ctx));
    return page;
  }
  page.append(toolbar(ctx));

  const q = ui.query.trim();
  if (q) {
    const hits = all
      .map((w) => [w, matchScore(w, q)] as const)
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);
    page.append(group('Results', hits.length, hits.length ? grid(ctx, hits, false) : h('p', { class: 'muted ws-none', text: `Nothing matches “${q}”. Search looks at names, descriptions, notes and what each workspace opens.` })));
    return page;
  }

  const live = all.filter((w) => !w.archived);
  const recent = live.filter((w) => w.lastOpenedAt).sort((a, b) => b.lastOpenedAt! - a.lastOpenedAt!).slice(0, 3);
  if (recent.length && live.length > 3 && ui.sort !== 'recent') page.append(group('Pick up where you left off', null, recentRows(ctx, recent)));
  const favorites = sortWorkspaces(live.filter((w) => w.favorite), ui.sort);
  const others = sortWorkspaces(live.filter((w) => !w.favorite), ui.sort);
  const sortable = ui.sort === 'manual' && !store.readOnly;
  if (favorites.length) page.append(group('Favorites', favorites.length, grid(ctx, favorites, sortable)));
  if (others.length || !favorites.length) {
    page.append(group(favorites.length ? 'Everything else' : 'All workspaces', others.length, others.length ? grid(ctx, others, sortable) : h('p', { class: 'muted ws-none', text: 'Every workspace is archived.' })));
  }
  const archived = all.filter((w) => w.archived);
  if (archived.length) {
    const fold = h('button', { class: `ws-fold${ui.showArchived ? ' open' : ''}`, type: 'button', 'aria-expanded': String(ui.showArchived), 'data-focus': 'fold', html: icon('chevron-down') });
    fold.prepend(h('span', { text: `Archived (${archived.length})` }));
    fold.addEventListener('click', () => {
      ui.showArchived = !ui.showArchived;
      rememberUi(ui);
      ctx.paint();
    });
    page.append(h('section', { class: 'ws-section' }, [fold, ui.showArchived ? grid(ctx, sortWorkspaces(archived, ui.sort), false) : null]));
  }
  return page;
}

/** Time and the cards, as two icons with a line under the one showing. Arrow keys move between them. */
function tabs(ctx: Ctx): HTMLElement {
  const { ui } = ctx;
  const pick = (tab: WsTab) => {
    if (ui.tab === tab) return;
    ui.tab = tab;
    ui.time.day = null;
    ui.time.fresh = true;
    rememberUi(ui);
    ctx.paint();
  };
  const tab = (key: WsTab, ic: string, label: string) => {
    const on = ui.tab === key;
    return h('button', {
      class: `ws-tab${on ? ' on' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(on),
      'aria-label': label,
      title: label,
      tabindex: on ? '0' : '-1',
      'data-focus': `tab:${key}`,
      html: icon(ic),
      onclick: () => pick(key),
    });
  };
  const list = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Show' }, [tab('time', 'trend', 'Time'), tab('cards', 'grid', 'Workspaces')]);
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: WsTab = e.key === 'ArrowLeft' ? 'time' : 'cards';
    pick(next);
    document.querySelector<HTMLElement>(`[data-focus="tab:${next}"]`)?.focus();
  });
  return list;
}

function group(title: string, count: number | null, body: Node): HTMLElement {
  return h('section', { class: 'ws-section' }, [
    h('div', { class: 'ws-section-head' }, [h('span', { text: title }), count === null ? null : h('span', { class: 'count', text: String(count) })]),
    body,
  ]);
}

function banners(ctx: Ctx): HTMLElement[] {
  const { store, ui } = ctx;
  const out: HTMLElement[] = [];
  if (store.readOnly) out.push(banner('alert', store.readOnly, []));
  if (store.recovered) {
    const path = store.recovered;
    out.push(
      banner('info', `Island couldn't read your saved workspaces, so it moved that file to ${path} and started a new one. Nothing in it was deleted.`, [
        h('button', { class: 'btn sm', type: 'button', text: 'Show the file', onclick: () => void native.reveal(path) }),
        h('button', { class: 'btn sm ghost', type: 'button', text: 'OK', onclick: () => { store.recovered = null; ctx.paint(); } }),
      ]),
    );
  }
  const pending = ui.pendingDraft;
  if (pending && ctx.view.kind !== 'edit') {
    const name = pending.draft.name.trim() || 'a new workspace';
    out.push(
      banner('info', `You didn't save your changes to ${pending.isNew ? name : `“${name}”`} (${agoText(Date.now() - pending.at)}).`, [
        h('button', { class: 'btn sm primary', type: 'button', text: 'Keep editing', onclick: () => resumeDraft(ctx) }),
        h('button', { class: 'btn sm ghost', type: 'button', text: 'Throw away', onclick: () => discardDraft(ctx) }),
      ]),
    );
  }
  return out;
}

function banner(kind: 'alert' | 'info', text: string, buttons: HTMLElement[]): HTMLElement {
  return h('div', { class: `ws-banner${kind === 'info' ? ' info' : ''}`, role: kind === 'alert' ? 'alert' : 'status', html: icon(kind === 'alert' ? 'alert' : 'info') }, [h('p', { text }), buttons.length ? h('div', { class: 'btns' }, buttons) : null]);
}

function toolbar(ctx: Ctx): HTMLElement {
  const { ui } = ctx;
  const input = h('input', { type: 'search', placeholder: 'Search workspaces', value: ui.query, spellcheck: 'false', 'data-focus': 'search', 'aria-label': 'Search workspaces' });
  input.addEventListener('input', () => {
    ui.query = input.value;
    ctx.paint();
  });
  input.addEventListener('keydown', (e) => {
    // Enter opens the best match.
    if (e.key === 'Enter' && ui.query.trim()) {
      const best = ctx.store.list.map((w) => [w, matchScore(w, ui.query)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0];
      if (best) ctx.go({ kind: 'detail', id: best[0].id });
    }
  });
  const search = h('label', { class: 'ws-search', html: icon('search') }, [input, h('kbd', { text: 'Ctrl F' })]);
  const sort = segmented<WsSort>(ui.sort, [['manual', 'Your order'], ['recent', 'Recent'], ['name', 'A–Z']], (v) => {
    ui.sort = v;
    rememberUi(ui);
    ctx.paint();
  });
  sort.setAttribute('aria-label', 'Order');
  return h('div', { class: 'ws-toolbar' }, [search, sort]);
}

function welcome(ctx: Ctx): HTMLElement {
  const start = (s: (typeof STARTERS)[number] | null) =>
    h('button', { class: 'ws-starter', type: 'button', onclick: () => startEdit(ctx, null, s ? { name: s.name, icon: s.icon, color: s.color, description: s.description } : undefined) }, [
      tile(s ?? { icon: 'plus', color: '' }, ctx.accent(), 'sm'),
      h('span', {}, [h('b', { text: s ? s.name : 'Start empty' }), h('small', { text: s ? s.description : 'Name it and add what it needs.' })]),
    ]);
  return h('div', { class: 'ws-empty' }, [
    tile({ icon: 'grid', color: '' }, ctx.accent(), 'lg'),
    h('h2', { text: 'Set up a workspace once, open it whenever you need it' }),
    h('p', { text: 'Say what a piece of work needs (apps, files, folders, websites, terminal commands) and add a note on where you stopped. Restoring it opens everything, in order, and you see what opened and what didn’t.' }),
    h('div', { class: 'ws-starters' }, [...STARTERS.map(start), start(null)]),
  ]);
}

function recentRows(ctx: Ctx, list: Workspace[]): HTMLElement {
  return h(
    'div',
    { class: 'ws-recent' },
    list.map((ws) => {
      const text = h('span', { class: 'ws-recent-text' }, [h('b', { text: displayName(ws) })]);
      const line = h('span');
      const inUse = ctx.ui.inUse.has(ws.id);
      const next = ws.notes.next.trim();
      if (inUse) line.append(next ? 'In use · ' : 'In use');
      if (next) line.append(h('em', { text: 'Next: ' }), next);
      else if (!inUse) line.textContent = `Opened ${agoText(Date.now() - ws.lastOpenedAt!)}`;
      text.append(line);
      const dot = lastRunText(ws, inUse).dot;
      return h('button', { class: 'ws-recent-row', type: 'button', style: `--wc:${wsColor(ws, ctx.accent())}`, 'data-focus': `recent:${ws.id}`, onclick: () => ctx.go({ kind: 'detail', id: ws.id }) }, [tile(ws, ctx.accent(), 'sm'), text, dot ? h('span', { class: `ws-dot ${dot}`, 'aria-hidden': 'true' }) : null]);
    }),
  );
}

function grid(ctx: Ctx, list: Workspace[], sortable: boolean): HTMLElement {
  const el = h('div', { class: 'ws-grid' }, list.map((ws) => card(ctx, ws, sortable ? list : null)));
  if (sortable && list.length > 1) {
    dragSort({
      container: el,
      ignore: 'button:not(.ws-card-open)',
      onDrop: (ids) => void ctx.store.reorder(placeWithin(ctx.store.list.map((w) => w.id), ids)),
    });
  }
  return el;
}

/** The whole order, with a section's members in their new order in the places they held. */
function placeWithin(full: string[], section: string[]): string[] {
  const members = new Set(section);
  const out = full.slice();
  let k = 0;
  for (let i = 0; i < out.length; i++) if (members.has(out[i])) out[i] = section[k++];
  return out;
}

/** The card's light and line: "In use" (flashing) while a window of it is open, else how the last restore went. */
export function lastRunText(ws: Workspace, inUse = false): { dot: string; text: string } {
  if (inUse) return { dot: 'in-use', text: 'In use' };
  const run = ws.history[0];
  if (!ws.lastOpenedAt && !run) return { dot: '', text: 'Never opened' };
  const when = agoText(Date.now() - (ws.lastOpenedAt ?? run!.at));
  if (!run || run.outcome === 'done') return { dot: run ? 'done' : '', text: `Opened ${when}` };
  const failed = run.steps.filter((s) => s.status === 'failed').length;
  if (run.outcome === 'cancelled') return { dot: 'cancelled', text: `Stopped ${when}` };
  return { dot: run.outcome, text: `${failed} didn't open · ${when}` };
}

function card(ctx: Ctx, ws: Workspace, section: Workspace[] | null): HTMLElement {
  const accent = ctx.accent();
  const el = h('article', { class: `ws-card${ws.archived ? ' archived' : ''}`, 'data-id': ws.id, style: `--wc:${wsColor(ws, accent)}` });
  const open = h('button', { class: 'ws-card-open', type: 'button', 'aria-label': `${displayName(ws)}: open`, 'data-focus': `card:${ws.id}`, onclick: () => ctx.go({ kind: 'detail', id: ws.id }) });
  if (section) {
    open.title = 'Drag to reorder (or Alt+arrow keys)';
    open.addEventListener('keydown', (e) => {
      if (!e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const ids = section.map((w) => w.id);
      const at = ids.indexOf(ws.id);
      const to = at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ids.length) return;
      const moved = moveBefore(ids, ws.id, to > at ? ids[to + 1] ?? null : ids[to]);
      void ctx.store.reorder(placeWithin(ctx.store.list.map((w) => w.id), moved));
    });
  }
  const star = iconButton('star', ws.favorite ? 'Remove from favorites' : 'Add to favorites', () => void ctx.store.update(ws.id, { favorite: !ws.favorite }), `ws-star${ws.favorite ? ' on' : ''}`);
  star.setAttribute('aria-pressed', String(ws.favorite));
  star.dataset.focus = `star:${ws.id}`;
  const more = iconButton('more', 'More', (e) => openMenu(e.currentTarget as HTMLElement, cardMenu(ctx, ws)), 'ws-more');
  more.setAttribute('aria-haspopup', 'menu');
  more.dataset.focus = `more:${ws.id}`;
  if (ctx.store.readOnly) star.disabled = more.disabled = true;

  const kinds = contents(ws);
  const chips = h(
    'div',
    { class: 'ws-chips' },
    kinds.length
      ? kinds.map((c) => h('span', { class: 'ws-chip', title: countText(c.kind, c.count), html: icon(KIND_META[c.kind].icon) }, [h('span', { text: countText(c.kind, c.count) })]))
      : [h('span', { class: 'ws-chip empty', text: 'Nothing to open yet' })],
  );
  const next = ws.notes.next.trim();
  const job = ctx.ui.job;
  const busy = job?.state === 'running';
  const last = busy && job.ws === ws.id ? { dot: 'running', text: `Restoring · ${jobSummary(job)}` } : lastRunText(ws, ctx.ui.inUse.has(ws.id));
  const restore = labelled('play', 'Restore', 'sm ws-restore', () => ctx.restore?.(ws));
  restore.dataset.focus = `restore:${ws.id}`;
  if (!ctx.restore || busy) {
    restore.disabled = true;
    restore.title = !ctx.restore ? 'Restoring needs the Island app' : `Restoring ${job!.name}…`;
  } else restore.title = `Open everything in ${displayName(ws)}`;

  const parts: Array<HTMLElement | null> = [
    open,
    h('div', { class: 'ws-card-top' }, [tile(ws, accent), h('div', { class: 'ws-card-title' }, [h('div', { class: 'ws-card-name', text: displayName(ws) })]), star, more]),
    ws.description.trim() ? h('div', { class: 'ws-desc', text: ws.description.trim() }) : null,
    chips,
    next ? h('div', { class: 'ws-next-line', title: next }, [h('b', { text: 'Next' }), h('span', { text: next })]) : null,
    h('div', { class: 'ws-card-foot' }, [h('span', { class: 'ws-when' }, [h('span', { class: `ws-dot ${last.dot}`.trim(), 'aria-hidden': 'true' }), h('span', { text: last.text })]), ws.archived ? null : restore]),
  ];
  el.append(...parts.filter((p): p is HTMLElement => p !== null));
  return el;
}

/** The ⋯ menu of a card (and of a workspace's own page). */
export function cardMenu(ctx: Ctx, ws: Workspace, opts: { open?: boolean } = { open: true }): MenuItem[] {
  const { store } = ctx;
  const items: MenuItem[] = [];
  if (opts.open) items.push({ label: 'Open', icon: 'arrow-right', run: () => ctx.go({ kind: 'detail', id: ws.id }) });
  items.push(
    { label: 'Edit', icon: 'edit', run: () => startEdit(ctx, ws) },
    {
      label: 'Duplicate',
      icon: 'copy',
      run: async () => {
        const copy = duplicateWorkspace(ws);
        if (await store.add(copy)) {
          // Right after the original, not at the top.
          await store.reorder(moveBefore(store.list.map((w) => w.id), copy.id, store.list[store.list.findIndex((w) => w.id === ws.id) + 1]?.id ?? null));
          toast(`Made “${displayName(copy)}”.`, { label: 'Edit it', run: () => startEdit(ctx, store.get(copy.id) ?? copy) });
        }
      },
    },
    ws.archived
      ? { label: 'Unarchive', icon: 'arrow-up', sep: true, run: () => void store.update(ws.id, { archived: false }) }
      : {
          label: 'Archive',
          icon: 'arrow-down',
          sep: true,
          run: async () => {
            if (await store.update(ws.id, { archived: true })) toast(`Archived “${displayName(ws)}”.`, { label: 'Undo', run: () => void store.update(ws.id, { archived: false }) });
          },
        },
    { label: 'Delete…', icon: 'x', danger: true, run: () => void deleteWorkspace(ctx, ws) },
  );
  return items;
}

/** Asks first, then deletes, with Undo for a few seconds. The apps and files themselves are never touched. */
export async function deleteWorkspace(ctx: Ctx, ws: Workspace): Promise<boolean> {
  const sure = await confirmBox({
    title: `Delete “${displayName(ws)}”?`,
    text: 'Its list of apps, files, sites and commands goes, with its notes and layout. The apps and files themselves stay where they are.',
    yes: 'Delete',
    danger: true,
  });
  if (!sure) return false;
  const { store } = ctx;
  const order = store.list.map((w) => w.id);
  const copy = structuredClone(store.get(ws.id) ?? ws);
  if (!(await store.remove(ws.id))) return false;
  if (ctx.view.kind === 'detail' && ctx.view.id === ws.id) ctx.go({ kind: 'list' });
  toast(`Deleted “${displayName(ws)}”.`, {
    label: 'Undo',
    run: async () => {
      if (await store.add(copy)) await store.reorder(order);
    },
  }, 8000);
  return true;
}
