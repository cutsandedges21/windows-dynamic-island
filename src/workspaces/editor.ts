// Making and changing a workspace: its name and look, the project folder, what it opens (in
// order; drag to reorder), the notes, and Save. The edit is a copy until Save. Meanwhile it is
// kept in the browser's storage, so closing the window doesn't lose it: the page offers it back.

import { agoText } from '../core/format';
import { icon } from '../core/icons';
import { native } from '../core/native';
import { platform } from '../core/platform';
import { ACCENTS } from '../core/settings';
import { segmented, toggle } from '../controls';
import { h } from '../dom';
import { checkWorkspace } from './checks';
import type { Ctx, EditState, SavedDraft, View } from './ctx';
import { deleteWorkspace } from './dashboard';
import {
  appName,
  displayName,
  editorFields,
  itemDetail,
  itemTitle,
  KIND_META,
  MAX_ITEMS,
  newResource,
  newWorkspace,
  normalizeUrl,
  normalizeWorkspace,
  RESOURCE_KINDS,
  shortPath,
  WS_ICONS,
  wsColor,
  type CommandHost,
  type Resource,
  type ResourceKind,
  type RunMode,
  type Shell,
  type Workspace,
} from './model';
import { confirmBox, dragSort, iconButton, labelled, openMenu, pickBox, tile, toast, type MenuItem } from './ui';

const DRAFT_KEY = 'island:ws-draft';
const mac = platform === 'macos';

// ------------------------------------------------------------------ the draft in storage

export function loadDraft(): SavedDraft | null {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { draft?: unknown; isNew?: unknown; at?: unknown } | null;
    const draft = v ? normalizeWorkspace(v.draft) : null;
    if (!v || !draft) return null;
    return { draft, isNew: v.isNew === true, at: typeof v.at === 'number' ? v.at : Date.now() };
  } catch {
    return null;
  }
}

function keepDraft(st: EditState): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: st.draft, isNew: st.isNew, at: Date.now() }));
  } catch {
    // Storage full or off: the edit still lives in the open window.
  }
}

function clearDraft(ctx: Ctx): void {
  clearTimeout(draftTimer);
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // As above.
  }
  ctx.ui.pendingDraft = null;
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;
let footerNote: HTMLElement | null = null;

/** Something in the draft changed: mark it, keep it in storage a moment later. */
function changed(st: EditState): void {
  st.dirty = true;
  if (footerNote?.isConnected && !footerNote.textContent) footerNote.textContent = 'Not saved yet';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => keepDraft(st), 300);
}

// ------------------------------------------------------------------ starting, saving, leaving

/** Opens the editor on a copy of `ws`, or on a new workspace (from a starter's name and look). */
export async function startEdit(
  ctx: Ctx,
  ws: Workspace | null,
  seed?: Partial<Pick<Workspace, 'name' | 'icon' | 'color' | 'description' | 'cwd'>> & { apps?: string[] },
): Promise<void> {
  if (ctx.store.readOnly) return;
  const pending = ctx.ui.pendingDraft;
  if (pending) {
    // The same workspace's unsaved edit comes back instead of a fresh copy.
    if (ws && !pending.isNew && pending.draft.id === ws.id) return resumeDraft(ctx);
    const name = pending.draft.name.trim() || 'a new workspace';
    const drop = await confirmBox({
      title: 'Unsaved changes',
      text: `You didn't save your changes to ${pending.isNew ? name : `“${name}”`}. Throw them away and go on?`,
      yes: 'Throw away',
      no: 'Keep those',
      danger: true,
    });
    if (!drop) return resumeDraft(ctx);
    clearDraft(ctx);
  }
  const draft = ws ? structuredClone(ws) : newWorkspace(seed);
  if (!ws && seed?.cwd) draft.cwd = seed.cwd;
  if (!ws && seed?.apps?.length) draft.resources = seed.apps.map((path) => newResource('app', { path }));
  const back: View = ctx.view.kind === 'edit' ? { kind: 'list' } : ctx.view;
  const st: EditState = { draft, isNew: !ws, dirty: Boolean(seed), open: new Set(), check: null, back, restoredFrom: null, nameMissing: false };
  ctx.go({ kind: 'edit', edit: st });
  if (st.isNew) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-focus="e:name"]')?.focus());
  void recheck(ctx, st);
}

/** Back into an edit that wasn't saved before the window closed. */
export function resumeDraft(ctx: Ctx): void {
  const p = ctx.ui.pendingDraft;
  if (!p) return;
  ctx.ui.pendingDraft = null;
  const back: View = !p.isNew && ctx.store.get(p.draft.id) ? { kind: 'detail', id: p.draft.id } : { kind: 'list' };
  const st: EditState = { draft: p.draft, isNew: p.isNew, dirty: true, open: new Set(), check: null, back, restoredFrom: p.at, nameMissing: false };
  ctx.go({ kind: 'edit', edit: st });
  void recheck(ctx, st);
}

export function discardDraft(ctx: Ctx): void {
  clearDraft(ctx);
  ctx.paint();
}

export async function saveEdit(ctx: Ctx, st: EditState): Promise<void> {
  const d = st.draft;
  d.name = d.name.trim();
  if (!d.name) {
    st.nameMissing = true;
    ctx.paint();
    document.querySelector<HTMLInputElement>('[data-focus="e:name"]')?.focus();
    return;
  }
  for (const r of d.resources) if (r.kind === 'url') r.url = normalizeUrl(r.url);
  d.updatedAt = Date.now();
  const ok = st.isNew ? await ctx.store.add(d) : await ctx.store.update(d.id, editorFields(d));
  // A failed save says why (a toast) and leaves the edit as it is.
  if (!ok) return;
  clearDraft(ctx);
  ctx.go({ kind: 'detail', id: d.id });
}

export async function cancelEdit(ctx: Ctx, st: EditState): Promise<void> {
  if (st.dirty) {
    const drop = await confirmBox({
      title: 'Throw away your changes?',
      text: st.isNew ? 'This workspace hasn’t been saved yet.' : `Your changes to “${displayName(st.draft)}” haven’t been saved.`,
      yes: 'Throw away',
      no: 'Keep editing',
      danger: true,
    });
    if (!drop) return;
  }
  clearDraft(ctx);
  const back = st.back.kind === 'detail' && !ctx.store.get(st.back.id) ? { kind: 'list' as const } : st.back;
  ctx.go(back);
}

/** Looks for the files, folders and programs again; the editor redraws with what's missing. */
async function recheck(ctx: Ctx, st: EditState): Promise<void> {
  const result = await checkWorkspace(st.draft);
  st.check = result;
  if (ctx.view.kind === 'edit' && ctx.view.edit === st) ctx.paint();
}

// ------------------------------------------------------------------ the editor

export function editor(ctx: Ctx, st: EditState): HTMLElement {
  const d = st.draft;
  const accent = ctx.accent();
  const head = h('div', { class: 'ws-editor-head' }, [
    tile(d, accent, 'lg'),
    h('div', {}, [h('h1', { text: st.isNew ? 'New workspace' : 'Edit workspace' }), st.isNew ? null : h('div', { class: 'muted', text: displayName(ctx.store.get(d.id) ?? d) })]),
  ]);
  const back = h('button', { class: 'ws-back', type: 'button', html: icon('chevron-left'), onclick: () => void cancelEdit(ctx, st) });
  back.append(h('span', { text: st.back.kind === 'detail' ? 'Back' : 'Workspaces' }));

  const restored = st.restoredFrom
    ? h('div', { class: 'ws-banner info', role: 'status', html: icon('info') }, [h('p', { text: `Your unsaved changes from ${agoText(Date.now() - st.restoredFrom)} are back.` })])
    : null;

  return h('div', { class: 'ws-editor' }, [back, head, restored, identity(ctx, st), project(ctx, st), items(ctx, st), notes(st), footer(ctx, st)]);
}

function panel(title: string, kids: Array<Node | null>, help?: string): HTMLElement {
  return h('section', { class: 'ws-panel' }, [h('h2', { text: title }), help ? h('p', { class: 'muted', text: help }) : null, ...kids]);
}

function identity(ctx: Ctx, st: EditState): HTMLElement {
  const d = st.draft;
  const accent = ctx.accent();
  const name = h('input', { class: `ws-input${st.nameMissing ? ' bad' : ''}`, id: 'ws-e-name', type: 'text', maxlength: 80, value: d.name, placeholder: 'e.g. School, Client site, Album mix', 'data-focus': 'e:name', spellcheck: 'false' });
  const nameHint = h('div', { class: 'ws-hint bad', text: st.nameMissing ? 'Give it a name.' : '' });
  name.addEventListener('input', () => {
    d.name = name.value;
    if (st.nameMissing && name.value.trim()) {
      st.nameMissing = false;
      name.classList.remove('bad');
      nameHint.textContent = '';
    }
    changed(st);
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void saveEdit(ctx, st);
  });
  const desc = h('input', { class: 'ws-input', id: 'ws-e-desc', type: 'text', maxlength: 300, value: d.description, placeholder: 'What it’s for (optional)', 'data-focus': 'e:desc' });
  desc.addEventListener('input', () => {
    d.description = desc.value;
    changed(st);
  });
  const color = wsColor(d, accent);
  const icons = h(
    'div',
    { class: 'ws-icons', role: 'radiogroup', 'aria-label': 'Icon' },
    WS_ICONS.map((ic) =>
      h('button', {
        class: `ws-icon-pick${d.icon === ic ? ' on' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': String(d.icon === ic),
        'aria-label': ic,
        title: ic,
        style: `--wc:${color}`,
        'data-focus': `e:icon:${ic}`,
        html: icon(ic),
        onclick: () => {
          d.icon = ic;
          changed(st);
          ctx.paint();
        },
      }),
    ),
  );
  const colors = h(
    'div',
    { class: 'ws-colors', role: 'radiogroup', 'aria-label': 'Colour' },
    ['', ...Object.keys(ACCENTS)].map((key) =>
      h('button', {
        class: `ws-color${key ? '' : ' auto'}${d.color === key ? ' on' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': String(d.color === key),
        'aria-label': key || 'Island’s accent',
        title: key || 'Island’s accent (changes with it)',
        style: `--c:${key ? ACCENTS[key] : accent}`,
        'data-focus': `e:color:${key || 'auto'}`,
        onclick: () => {
          d.color = key;
          changed(st);
          ctx.paint();
        },
      }),
    ),
  );
  return panel('Name and look', [
    h('div', { class: 'ws-form' }, [
      h('label', { for: 'ws-e-name', text: 'Name' }),
      h('div', {}, [name, nameHint]),
      h('label', { for: 'ws-e-desc', text: 'Description' }),
      desc,
      h('label', { class: 'top', text: 'Icon' }),
      icons,
      h('label', { text: 'Colour' }),
      colors,
    ]),
  ]);
}

/** A path box with Browse… (the system's Open dialog). `commit` runs when it's done changing. */
function pathField(o: { id: string; value: string; focus: string; placeholder: string; pick: 'app' | 'file' | 'folder' | 'program'; start: () => string | null; set: (v: string) => void; commit: () => void }): HTMLElement {
  const input = h('input', { class: 'ws-input mono', id: o.id, type: 'text', value: o.value, placeholder: o.placeholder, spellcheck: 'false', 'data-focus': o.focus });
  input.addEventListener('input', () => o.set(input.value));
  input.addEventListener('change', () => o.commit());
  const browse = h('button', { class: 'btn', type: 'button', text: 'Browse…', 'data-focus': `${o.focus}:browse` });
  browse.addEventListener('click', async () => {
    const [p] = await native.wsPick(o.pick, false, o.start());
    if (!p) return;
    input.value = p;
    o.set(p);
    o.commit();
  });
  if (!native.isTauri) {
    browse.disabled = true;
    browse.title = 'Needs the Island app';
  }
  return h('div', { class: 'ws-path' }, [input, browse]);
}

function hint(text: string | null, kind: '' | 'warn' = ''): HTMLElement {
  return h('div', { class: `ws-hint ${kind}`.trim(), text: text ?? '' });
}

function project(ctx: Ctx, st: EditState): HTMLElement {
  const d = st.draft;
  const field = pathField({
    id: 'ws-e-cwd',
    value: d.cwd,
    focus: 'e:cwd',
    placeholder: mac ? '~/code/my-app' : 'C:\\Users\\you\\code\\my-app',
    pick: 'folder',
    start: () => d.cwd || null,
    set: (v) => {
      d.cwd = v;
      changed(st);
    },
    commit: () => void recheck(ctx, st),
  });
  const problem = st.check?.cwd ?? null;
  return panel(
    'Project folder',
    [field, problem ? hint(problem, 'warn') : null],
    'Optional. Apps and commands start in this folder unless they say otherwise, and the paths below can be written from it (src\\index.ts).',
  );
}

function items(ctx: Ctx, st: EditState): HTMLElement {
  const d = st.draft;
  const list = h('div', { class: 'ws-items' }, d.resources.map((r) => itemRow(ctx, st, r)));
  if (d.resources.length > 1) {
    dragSort({
      container: list,
      handle: '.ws-grip',
      onDrop: (ids) => {
        d.resources = ids.map((id) => d.resources.find((r) => r.id === id)!).filter(Boolean);
        changed(st);
        ctx.paint();
      },
    });
  }
  const add = h('div', { class: 'ws-add' }, [
    h('span', { class: 'muted', text: 'Add' }),
    ...RESOURCE_KINDS.map((kind) => {
      const b = labelled(KIND_META[kind].icon, KIND_META[kind].add, 'sm', (e) => {
        if (kind !== 'app' || !native.isTauri) return void addItem(ctx, st, kind);
        const choices: MenuItem[] = [
          { label: 'From your apps…', icon: 'grid', run: () => void addInstalled(ctx, st) },
          { label: 'Browse for a program…', icon: 'folder', run: () => void addItem(ctx, st, 'app') },
        ];
        if (!mac) choices.push({ label: 'From open windows…', icon: 'window', run: () => void addFromWindows(ctx, st) });
        openMenu(e.currentTarget as HTMLElement, choices);
      });
      b.dataset.focus = `e:add:${kind}`;
      if (kind === 'app' && native.isTauri) b.setAttribute('aria-haspopup', 'menu');
      return b;
    }),
  ]);
  add.firstElementChild?.setAttribute('style', 'align-self:center;margin-right:4px;font-size:12.5px');
  return panel(
    'What opens, in order',
    [d.resources.length ? list : h('div', { class: 'ws-empty-items', text: 'Nothing yet. Add the apps, files, folders, websites and commands this work needs.' }), add],
    'Top to bottom when you restore. Drag the handle to change the order; switch one off to keep it here without opening it.',
  );
}

async function addItem(ctx: Ctx, st: EditState, kind: ResourceKind): Promise<void> {
  const d = st.draft;
  let made: Resource[];
  if ((kind === 'app' || kind === 'file' || kind === 'folder') && native.isTauri) {
    const paths = await native.wsPick(kind, true, kind === 'app' ? null : d.cwd || null);
    if (!paths.length) return;
    made = paths.map((path) => newResource(kind, { path }));
  } else made = [newResource(kind)];
  addMade(ctx, st, made);
}

/** Apps from Start's list (desktop programs and Store apps). */
async function addInstalled(ctx: Ctx, st: EditState): Promise<void> {
  const apps = native.wsApps();
  const picked = await pickBox({
    title: 'Add apps',
    text: 'From your list of apps, Store apps included.',
    several: true,
    empty: 'No apps found.',
    load: async () => (await apps).map((a) => ({ key: a.target, title: a.name, detail: a.target.startsWith('shell:') ? 'Store app' : shortPath(a.target, 64), icon: 'window' })),
  });
  if (!picked) return;
  const names = new Map((await apps).map((a) => [a.target, a.name]));
  // A Store app's path says nothing readable, so its name goes along.
  addMade(ctx, st, picked.keys.map((target) => newResource('app', { path: target, label: target.startsWith('shell:') ? names.get(target) ?? '' : '' })));
}

/** The programs of windows open right now (each once, minus those already here). */
async function addFromWindows(ctx: Ctx, st: EditState): Promise<void> {
  const live = await native.wsWindows();
  if (!live.ok) return toast(live.error);
  const have = new Set(st.draft.resources.filter((r) => r.kind === 'app').map((r) => r.path.trim().toLowerCase()));
  const programs = new Map<string, { exe: string; titles: string[] }>();
  for (const w of live.value) {
    const key = w.exe.toLowerCase();
    if (have.has(key)) continue;
    const p = programs.get(key) ?? { exe: w.exe, titles: [] };
    p.titles.push(w.title);
    programs.set(key, p);
  }
  const picked = await pickBox({
    title: 'Add apps that are open',
    text: 'The programs behind the windows on screen now. To also keep where the windows are, save the layout on the workspace’s page.',
    several: true,
    empty: 'Every open app is already in this workspace.',
    load: async () => [...programs.values()].map((p) => ({ key: p.exe, title: appName(p.exe), detail: p.titles.slice(0, 2).join(' · '), icon: 'window' })),
  });
  if (!picked) return;
  addMade(ctx, st, picked.keys.map((exe) => newResource('app', { path: exe })));
}

/** New items at the end; one alone opens, ready to fill in. */
function addMade(ctx: Ctx, st: EditState, made: Resource[]): void {
  const d = st.draft;
  if (!made.length) return;
  if (d.resources.length + made.length > MAX_ITEMS) {
    toast(`A workspace holds up to ${MAX_ITEMS} things to open.`);
    return;
  }
  d.resources.push(...made);
  // One new item opens, ready to fill in; several picked at once stay closed.
  if (made.length === 1) st.open.add(made[0].id);
  changed(st);
  ctx.paint();
  const first = made[0];
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-focus="i:${first.id}:${first.kind === 'url' || first.kind === 'command' ? 'main' : 'text'}"]`);
    target?.focus();
    target?.closest('.ws-item')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  void recheck(ctx, st);
}

function moveItem(ctx: Ctx, st: EditState, r: Resource, by: number): void {
  const list = st.draft.resources;
  const at = list.indexOf(r);
  const to = at + by;
  if (at < 0 || to < 0 || to >= list.length) return;
  list.splice(at, 1);
  list.splice(to, 0, r);
  changed(st);
  ctx.paint();
}

function removeItem(ctx: Ctx, st: EditState, r: Resource): void {
  const list = st.draft.resources;
  const at = list.indexOf(r);
  if (at < 0) return;
  list.splice(at, 1);
  st.open.delete(r.id);
  changed(st);
  ctx.paint();
  toast(`Removed ${itemTitle(r)}.`, {
    label: 'Undo',
    run: () => {
      if (ctx.view.kind !== 'edit' || ctx.view.edit !== st) return;
      list.splice(Math.min(at, list.length), 0, r);
      changed(st);
      ctx.paint();
    },
  });
}

function itemRow(ctx: Ctx, st: EditState, r: Resource): HTMLElement {
  const open = st.open.has(r.id);
  const check = st.check?.items.get(r.id);
  const problem = check?.problem ?? null;
  const el = h('div', { class: `ws-item${open ? ' open' : ''}${r.enabled ? '' : ' off'}`, 'data-id': r.id });
  const flip = () => {
    if (st.open.has(r.id)) st.open.delete(r.id);
    else st.open.add(r.id);
    ctx.paint();
  };
  const grip = h('button', { class: 'ws-grip', type: 'button', title: 'Drag to reorder, or use the arrow keys', 'aria-label': `Move ${itemTitle(r)}`, 'data-focus': `i:${r.id}:grip`, html: icon('more') });
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveItem(ctx, st, r, e.key === 'ArrowUp' ? -1 : 1);
    }
  });
  const title = h('div', { class: 'ws-item-title', text: itemTitle(r) });
  const detail = itemDetail(r);
  const text = h('div', { class: 'ws-item-text', role: 'button', tabindex: '0', title: detail || null, 'aria-expanded': String(open), 'data-focus': `i:${r.id}:text` }, [
    title,
    detail && detail !== itemTitle(r) ? h('div', { class: 'ws-item-detail', text: itemDetail(r, true) }) : null,
    r.enabled && problem ? h('div', { class: 'ws-step-why', text: problem }) : null,
  ]);
  text.addEventListener('click', flip);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });
  const tags = h('div', { class: 'ws-tags' }, [r.mode === 'ask' && r.enabled ? h('span', { class: 'ws-tag ask', text: 'Asks first' }) : null]);
  const on = toggle(r.enabled, (v) => {
    r.enabled = v;
    el.classList.toggle('off', !v);
    changed(st);
  }, `Open ${itemTitle(r)} when restoring`);
  on.dataset.focus = `i:${r.id}:on`;
  on.title = 'Open it when restoring';
  const chev = iconButton('chevron-down', open ? 'Close' : 'Details', flip, 'ws-chev');
  chev.dataset.focus = `i:${r.id}:chev`;
  const remove = iconButton('x', 'Remove', () => removeItem(ctx, st, r), 'danger');
  el.append(h('div', { class: 'ws-item-head' }, [grip, h('span', { class: 'ws-kind', title: KIND_META[r.kind].add, html: icon(KIND_META[r.kind].icon) }), text, tags, on, chev, remove]));
  if (open) el.append(itemBody(ctx, st, r, title, problem, check?.found ?? null));
  return el;
}

function itemBody(ctx: Ctx, st: EditState, r: Resource, titleEl: HTMLElement, problem: string | null, found: string | null): HTMLElement {
  const d = st.draft;
  const id = (f: string) => `ws-i-${r.id}-${f}`;
  const rows: Node[] = [];
  const add = (label: string, control: Node, forId?: string, top = false) => rows.push(h('label', { class: top ? 'top' : '', for: forId ?? null, text: label }), control);
  const edited = () => {
    changed(st);
    titleEl.textContent = itemTitle(r);
  };
  const commit = () => void recheck(ctx, st);
  const text = (field: string, value: string, placeholder: string, set: (v: string) => void, mono = true) => {
    const input = h('input', { class: `ws-input${mono ? ' mono' : ''}`, id: id(field), type: 'text', value, placeholder, spellcheck: 'false', 'data-focus': `i:${r.id}:${field}` });
    input.addEventListener('input', () => {
      set(input.value);
      edited();
    });
    return input;
  };
  const wait = () => {
    const input = h('input', { type: 'number', min: 0, max: 600, step: 1, value: String(r.wait), id: id('wait'), 'data-focus': `i:${r.id}:wait` });
    input.addEventListener('change', () => {
      r.wait = Math.min(600, Math.max(0, Math.round(Number(input.value) || 0)));
      input.value = String(r.wait);
      changed(st);
    });
    return h('div', {}, [h('label', { class: 'num' }, [input, h('span', { class: 'muted', text: 'seconds before the next one' })])]);
  };
  const problemHint = problem ? hint(problem, 'warn') : found ? hint(`Found: ${found}`) : null;

  if (r.kind === 'app') {
    add('App', h('div', {}, [pathField({ id: id('main'), value: r.path, focus: `i:${r.id}:main`, placeholder: mac ? '/Applications/Something.app' : 'C:\\…\\App.exe, a shortcut, or a name like code', pick: 'app', start: () => null, set: (v) => { r.path = v; edited(); }, commit }), problemHint]), id('main'));
    add('Arguments', text('args', r.args, mac ? 'e.g. --new-window' : 'e.g.  .   or  --new-window "D:\\Notes"', (v) => (r.args = v)), id('args'));
    add('Start in', pathField({ id: id('cwd'), value: r.cwd, focus: `i:${r.id}:cwd`, placeholder: 'The project folder', pick: 'folder', start: () => r.cwd || d.cwd || null, set: (v) => { r.cwd = v; edited(); }, commit }), id('cwd'));
    add('If it’s running', segmented(r.reuse ? 'reuse' : 'new', [['reuse', 'Bring it to the front'], ['new', 'Start another']], (v) => { r.reuse = v === 'reuse'; changed(st); ctx.paint(); }));
    add('Then wait', wait(), id('wait'));
  } else if (r.kind === 'file') {
    add('File', h('div', {}, [pathField({ id: id('main'), value: r.path, focus: `i:${r.id}:main`, placeholder: 'The file to open', pick: 'file', start: () => d.cwd || null, set: (v) => { r.path = v; edited(); }, commit }), problemHint]), id('main'));
    add('Open with', pathField({ id: id('with'), value: r.openWith, focus: `i:${r.id}:with`, placeholder: 'Its usual app', pick: 'program', start: () => null, set: (v) => { r.openWith = v; edited(); }, commit }), id('with'));
    add('Then wait', wait(), id('wait'));
  } else if (r.kind === 'folder') {
    add('Folder', h('div', {}, [pathField({ id: id('main'), value: r.path, focus: `i:${r.id}:main`, placeholder: 'The folder to open', pick: 'folder', start: () => d.cwd || null, set: (v) => { r.path = v; edited(); }, commit }), problemHint]), id('main'));
  } else if (r.kind === 'url') {
    const url = text('main', r.url, 'https://…  or  localhost:3000', (v) => (r.url = v));
    url.addEventListener('change', () => {
      r.url = normalizeUrl(url.value);
      url.value = r.url;
      edited();
      commit();
    });
    add('Address', h('div', {}, [url, problemHint]), id('main'));
  } else {
    const cmd = h('textarea', { class: 'ws-text short mono', id: id('main'), rows: 2, placeholder: 'npm run dev', spellcheck: 'false', 'data-focus': `i:${r.id}:main` });
    cmd.value = r.command;
    cmd.addEventListener('input', () => {
      r.command = cmd.value;
      edited();
    });
    cmd.addEventListener('change', commit);
    add('Command', h('div', {}, [cmd, problemHint]), id('main'), true);
    if (!mac) {
      add('Shell', segmented<Shell>(r.shell, [['powershell', 'PowerShell'], ['pwsh', 'PowerShell 7'], ['cmd', 'Command Prompt']], (v) => { r.shell = v; changed(st); ctx.paint(); }));
      add('Runs in', segmented<CommandHost>(r.host, [['terminal', 'Windows Terminal'], ['console', 'Its own window']], (v) => { r.host = v; changed(st); ctx.paint(); }));
    }
    add('Start in', pathField({ id: id('cwd'), value: r.cwd, focus: `i:${r.id}:cwd`, placeholder: 'The project folder', pick: 'folder', start: () => r.cwd || d.cwd || null, set: (v) => { r.cwd = v; edited(); }, commit }), id('cwd'));
    add('Then wait', wait(), id('wait'));
  }

  add('Name', text('label', r.label, itemTitle({ ...r, label: '' } as Resource), (v) => (r.label = v), false), id('label'));
  const modes: Array<[RunMode, string]> = r.kind === 'command' ? [['ask', 'Ask me first'], ['auto', 'Run it']] : [['auto', 'Opens on its own'], ['ask', 'Ask me first']];
  const mode = segmented<RunMode>(r.mode, modes, (v) => { r.mode = v; changed(st); ctx.paint(); });
  const modeNote =
    r.kind === 'command' && r.mode === 'auto'
      ? h('div', { class: 'ws-note warn', text: 'Runs every time this workspace is restored, without asking. You see the command as it starts.' })
      : r.kind === 'command'
        ? h('div', { class: 'ws-note', text: 'Restoring shows the command and waits for your yes.' })
        : null;
  add('When restoring', h('div', {}, [mode, modeNote]));
  return h('div', { class: 'ws-item-body' }, [h('div', { class: 'ws-form' }, rows)]);
}

function notes(st: EditState): HTMLElement {
  const n = st.draft.notes;
  const next = h('input', { class: 'ws-input', id: 'ws-e-next', type: 'text', maxlength: 300, value: n.next, placeholder: 'e.g. Fix the login bug before the dashboard', 'data-focus': 'e:next' });
  next.addEventListener('input', () => {
    n.next = next.value;
    n.savedAt = Date.now();
    changed(st);
  });
  const text = h('textarea', { class: 'ws-text', id: 'ws-e-notes', rows: 4, placeholder: 'What were you in the middle of? What’s half done?', 'data-focus': 'e:notes' });
  text.value = n.text;
  text.addEventListener('input', () => {
    n.text = text.value.slice(0, 4000);
    n.savedAt = Date.now();
    changed(st);
  });
  return panel('Where you left off', [h('label', { class: 'ws-label', for: 'ws-e-next', text: 'Next step' }), next, h('label', { class: 'ws-label', for: 'ws-e-notes', text: 'Notes' }), text]);
}

function footer(ctx: Ctx, st: EditState): HTMLElement {
  const d = st.draft;
  const check = st.check;
  const missing = d.resources.filter((r) => r.enabled && check?.items.get(r.id)?.problem).length + (check?.cwd ? 1 : 0);
  footerNote = h('span', {
    class: `grow${missing ? ' warn' : ''}`,
    text: missing ? `${missing} ${missing === 1 ? 'thing' : 'things'} can't be found right now. You can still save.` : st.dirty ? 'Not saved yet' : '',
  });
  const remove =
    !st.isNew && ctx.store.get(d.id)
      ? h('button', {
          class: 'btn ghost danger',
          type: 'button',
          text: 'Delete…',
          onclick: async () => {
            const ws = ctx.store.get(d.id);
            if (ws && (await deleteWorkspace(ctx, ws))) {
              clearDraft(ctx);
              ctx.go({ kind: 'list' });
            }
          },
        })
      : null;
  return h('div', { class: 'ws-footer' }, [
    remove,
    footerNote,
    h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => void cancelEdit(ctx, st) }),
    h('button', { class: 'btn primary', type: 'button', text: st.isNew ? 'Create workspace' : 'Save', title: 'Ctrl+S', 'data-focus': 'e:save', onclick: () => void saveEdit(ctx, st) }),
  ]);
}
