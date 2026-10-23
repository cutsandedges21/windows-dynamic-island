// One workspace: what it opens, in order, and anything that can't open; the note on where the
// work stands (saved as it's typed); its project folder; and Restore.

import { agoText } from '../core/format';
import { icon } from '../core/icons';
import { native } from '../core/native';
import { h } from '../dom';
import { checkWorkspace } from './checks';
import type { Ctx } from './ctx';
import { cardMenu, lastRunText } from './dashboard';
import { startEdit } from './editor';
import { contentsText, displayName, itemDetail, itemTitle, KIND_META, shortPath, wsColor, type Resource, type Workspace } from './model';
import { historyPanel, jobPanel, layoutPanel } from './panels';
import { iconButton, labelled, openMenu, tile } from './ui';

let pendingSave: { timer: ReturnType<typeof setTimeout>; run: () => void } | null = null;

/** Saves a note being typed now instead of a moment later (leaving the page, the window losing focus). */
export function flushNotes(): void {
  if (!pendingSave) return;
  clearTimeout(pendingSave.timer);
  const run = pendingSave.run;
  pendingSave = null;
  run();
}

const checking = new Set<string>();

/** Checks the items once per edit of the workspace; the page redraws when the answer is in. */
function ensureChecked(ctx: Ctx, ws: Workspace, force = false): void {
  const have = ctx.ui.checks.get(ws.id);
  if (!force && (have?.at === ws.updatedAt || checking.has(ws.id))) return;
  checking.add(ws.id);
  void checkWorkspace(ws).then((result) => {
    checking.delete(ws.id);
    ctx.ui.checks.set(ws.id, { at: ws.updatedAt, result });
    if (ctx.view.kind === 'detail' && ctx.view.id === ws.id) ctx.paint();
  });
}

function back(ctx: Ctx): HTMLElement {
  const b = h('button', { class: 'ws-back', type: 'button', html: icon('chevron-left'), 'data-focus': 'back', onclick: () => ctx.go({ kind: 'list' }) });
  b.append(h('span', { text: 'Workspaces' }));
  return b;
}

export function detail(ctx: Ctx, id: string): HTMLElement {
  const ws = ctx.store.get(id);
  if (!ws) return h('div', {}, [back(ctx), h('p', { class: 'muted', text: ctx.store.ready ? 'This workspace is gone.' : 'Loading…' })]);
  ensureChecked(ctx, ws);
  const accent = ctx.accent();
  const readOnly = Boolean(ctx.store.readOnly);

  const star = iconButton('star', ws.favorite ? 'Remove from favorites' : 'Add to favorites', () => void ctx.store.update(ws.id, { favorite: !ws.favorite }), `ws-star${ws.favorite ? ' on' : ''}`);
  star.setAttribute('aria-pressed', String(ws.favorite));
  star.dataset.focus = 'd:star';
  const more = iconButton('more', 'More', (e) => openMenu(e.currentTarget as HTMLElement, cardMenu(ctx, ws, { open: false })));
  more.setAttribute('aria-haspopup', 'menu');
  more.dataset.focus = 'd:more';
  const edit = labelled('edit', 'Edit', '', () => startEdit(ctx, ws));
  edit.dataset.focus = 'd:edit';
  const job = ctx.ui.job;
  const mine = job && job.ws === ws.id ? job : null;
  const busy = job?.state === 'running';
  const restore = labelled('play', mine && busy ? 'Restoring…' : 'Restore', 'primary lg', () => ctx.restore?.(ws));
  restore.dataset.focus = 'd:restore';
  if (!ctx.restore || busy) {
    restore.disabled = true;
    restore.title = !ctx.restore ? 'Restoring needs the Island app' : `Restoring ${job!.name}…`;
  } else restore.title = 'Open everything here, in order';
  if (readOnly) star.disabled = more.disabled = edit.disabled = true;

  const meta = h('div', { class: 'ws-meta' }, [
    h('span', { text: contentsText(ws) }),
    h('span', { text: lastRunText(ws, ctx.ui.inUse.has(ws.id)).text }),
    h('span', { text: `Made ${new Date(ws.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` }),
  ]);
  const hero = h('div', { class: 'ws-hero', style: `--wc:${wsColor(ws, accent)}` }, [
    tile(ws, accent, 'lg'),
    h('div', { class: 'ws-hero-text' }, [h('h1', { text: displayName(ws) }), ws.description.trim() ? h('p', { text: ws.description.trim() }) : null, meta]),
    h('div', { class: 'ws-hero-actions' }, [star, more, edit, restore]),
  ]);

  const archived = ws.archived
    ? h('div', { class: 'ws-banner info', role: 'status', html: icon('info') }, [
        h('p', { text: 'Archived: it stays out of the list until you bring it back.' }),
        h('div', { class: 'btns' }, [h('button', { class: 'btn sm', type: 'button', text: 'Unarchive', disabled: readOnly, onclick: () => void ctx.store.update(ws.id, { archived: false }) })]),
      ])
    : null;

  return h('div', { class: 'ws-detail' }, [
    back(ctx),
    hero,
    archived,
    h('div', { class: 'ws-cols' }, [
      h('div', {}, [mine && ctx.ui.jobClosed !== mine.id ? jobPanel(ctx, mine) : null, itemsPanel(ctx, ws), historyPanel(ws)]),
      h('div', {}, [notesPanel(ctx, ws, readOnly), folderPanel(ctx, ws), layoutPanel(ctx, ws, readOnly)]),
    ]),
  ]);
}

function itemsPanel(ctx: Ctx, ws: Workspace): HTMLElement {
  const check = ctx.ui.checks.get(ws.id)?.result ?? null;
  const again = h('button', { class: 'btn sm ghost', type: 'button', text: 'Check again', title: 'Look for the files, folders and apps again (after plugging in a drive)', onclick: () => ensureChecked(ctx, ws, true) });
  const head = h('h2', {}, [h('span', { text: 'What opens' }), ws.resources.length ? again : null]);
  if (!ws.resources.length) {
    return h('section', { class: 'ws-panel' }, [
      head,
      h('p', { class: 'muted', text: 'Nothing yet. Add the apps, files, folders, websites and commands this work needs; they open in the order you put them.' }),
      labelled('plus', 'Add things to open', '', () => startEdit(ctx, ws)),
    ]);
  }
  const off = ws.resources.filter((r) => !r.enabled).length;
  const problems = ws.resources.filter((r) => r.enabled && check?.items.get(r.id)?.problem).length;
  const summary = [`${ws.resources.length - off} open in this order`, off ? `${off} switched off` : '', problems ? `${problems} can't open right now` : ''].filter(Boolean).join(' · ');
  return h('section', { class: 'ws-panel' }, [
    head,
    h('p', { class: 'muted', text: summary }),
    h('ol', { class: 'ws-steps' }, ws.resources.map((r, i) => step(r, i, check?.items.get(r.id)?.problem ?? null, check?.items.get(r.id)?.found ?? null))),
  ]);
}

function step(r: Resource, i: number, problem: string | null, found: string | null): HTMLElement {
  const tags: HTMLElement[] = [];
  if (!r.enabled) tags.push(h('span', { class: 'ws-tag', text: 'Off' }));
  else if (r.mode === 'ask') tags.push(h('span', { class: 'ws-tag ask', text: 'Asks first', title: 'Restoring waits for your yes before this one' }));
  if (r.enabled && problem) tags.push(h('span', { class: 'ws-tag warn', text: "Can't open" }));
  const detail = itemDetail(r);
  return h('li', { class: `ws-step${r.enabled ? '' : ' off'}` }, [
    h('span', { class: 'ws-step-n', text: String(i + 1) }),
    h('span', { class: 'ws-kind', title: KIND_META[r.kind].add, html: icon(KIND_META[r.kind].icon) }),
    h('div', { class: 'ws-step-text' }, [
      h('div', { class: 'ws-step-title', text: itemTitle(r) }),
      detail && detail !== itemTitle(r) ? h('div', { class: 'ws-step-detail', text: itemDetail(r, true), title: found ? `${detail}\nFound at ${found}` : detail }) : null,
      r.enabled && problem ? h('div', { class: 'ws-step-why', text: problem }) : null,
    ]),
    h('div', { class: 'ws-tags' }, tags),
  ]);
}

function notesPanel(ctx: Ctx, ws: Workspace, readOnly: boolean): HTMLElement {
  // What's being typed wins over what's saved, until the two are the same again.
  let draft = ctx.ui.notes.get(ws.id);
  if (draft && draft.text === ws.notes.text && draft.next === ws.notes.next) {
    ctx.ui.notes.delete(ws.id);
    draft = undefined;
  }
  const notes = draft ?? { text: ws.notes.text, next: ws.notes.next };
  const saved = h('div', { class: 'ws-saved', 'aria-live': 'polite', text: ws.notes.savedAt ? `Saved ${agoText(Date.now() - ws.notes.savedAt)}` : 'Saved as you type.' });
  const schedule = () => {
    ctx.ui.notes.set(ws.id, notes);
    if (pendingSave) clearTimeout(pendingSave.timer);
    const run = () => {
      pendingSave = null;
      void ctx.store.update(ws.id, { notes: { text: notes.text, next: notes.next, savedAt: Date.now() } }, true).then((ok) => {
        if (ok && saved.isConnected) saved.textContent = 'Saved just now';
      });
    };
    pendingSave = { timer: setTimeout(run, 500), run };
  };
  const text = h('textarea', { class: 'ws-text', id: 'ws-notes', rows: 4, placeholder: 'What were you in the middle of? What’s half done, what did you find out?', 'data-focus': `notes:${ws.id}`, disabled: readOnly });
  text.value = notes.text;
  text.addEventListener('input', () => {
    notes.text = text.value.slice(0, 4000);
    schedule();
  });
  const next = h('input', { class: 'ws-input', id: 'ws-next', type: 'text', maxlength: 300, placeholder: 'e.g. Fix the login bug before the dashboard', 'data-focus': `next:${ws.id}`, disabled: readOnly, value: notes.next });
  next.addEventListener('input', () => {
    notes.next = next.value;
    schedule();
  });
  for (const field of [text, next]) field.addEventListener('blur', () => flushNotes());
  return h('section', { class: 'ws-panel ws-notes' }, [
    h('h2', { text: 'Where you left off' }),
    h('label', { class: 'ws-label', for: 'ws-next', text: 'Next step' }),
    next,
    h('label', { class: 'ws-label', for: 'ws-notes', text: 'Notes' }),
    text,
    saved,
  ]);
}

function folderPanel(ctx: Ctx, ws: Workspace): HTMLElement | null {
  const cwd = ws.cwd.trim();
  if (!cwd) {
    return h('section', { class: 'ws-panel' }, [
      h('h2', { text: 'Project folder' }),
      h('p', { class: 'muted', text: 'None. A project folder is where commands run and apps start, and paths can be written from it.' }),
      ctx.store.readOnly ? null : h('button', { class: 'btn sm', type: 'button', text: 'Set one', onclick: () => startEdit(ctx, ws) }),
    ]);
  }
  const problem = ctx.ui.checks.get(ws.id)?.result.cwd ?? null;
  return h('section', { class: 'ws-panel' }, [
    h('h2', { text: 'Project folder' }),
    h('div', { class: 'ws-path-row' }, [
      h('span', { class: 'ws-mono', text: shortPath(cwd, 44), title: cwd }),
      iconButton('folder', 'Show in Explorer', () => void native.wsShow(cwd, '')),
      iconButton('copy', 'Copy the path', () => void native.clipboardSetText(cwd)),
    ]),
    problem ? h('div', { class: 'ws-hint warn', text: problem }) : null,
  ]);
}
