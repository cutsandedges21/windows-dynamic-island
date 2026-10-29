// The Activities + Settings window. Settings are shared with the island through
// Rust (every save is broadcast); live data (Claude sessions, limits) is asked
// from the island over app-command / app-reply events.

import './styles/app.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CATALOG_BY_ID, type ActivityMeta, type Band, type OptionSpec } from './activities/catalog';
import { SpringSet } from './core/animator';
import { agoText, pace, resetsIn, resetsOn, SESSION_WINDOW_MS, tokens as fmtTokens, WEEK_WINDOW_MS } from './core/format';
import { icon } from './core/icons';
import { levelWidth, normalizeWidths, type Anchor, type Level } from './core/layout';
import { MENU_ITEMS } from './core/menu';
import { isTauri, native, on, sendTo, type MonitorInfo } from './core/native';
import { availableHere, ctrlKey, optionHere, platform, thisComputer, unavailableReason } from './core/platform';
import { springAnimate } from './core/renderer';
import { ACCENTS, backAt, cloneSettings, HIDE_CHOICES, hideUntil, migrate, newPhoneTopic, type ActivityConfig, type Settings } from './core/settings';
import { springs } from './core/spring';
import { catchErrors } from './core/errors';
import { codeGrid } from './codegrid';
import { multiSegmented, row, section, segmented, stacked, toggle } from './controls';
import { h } from './dom';
import { landPanel } from './land-panel';
import { modelPicker } from './models-ui';
import { phoneSection } from './remote/settings';
import { welcomePage, type WelcomeHost } from './welcome';
import { noticePanel } from './workspaces/notice/panel';
import { workspacesPage, type WorkspacesPage } from './workspaces/page';

/** 'welcome' is the first-run setup: the whole window, no sidebar. */
type Page = 'activities' | 'workspaces' | 'settings' | 'welcome';
const PAGES: Page[] = ['activities', 'workspaces', 'settings', 'welcome'];

let settings: Settings = migrate(null);
// Rust passes the page to open in an init script (a # in the window URL is not reliable).
const requested = (window as unknown as { __ISLAND_PAGE__?: string }).__ISLAND_PAGE__ || location.hash.slice(1);
let page: Page = PAGES.includes(requested as Page) ? (requested as Page) : 'activities';
let dragging = false;
const openCards = new Set<string>();
let monitors: MonitorInfo[] = [];
let hotkeyFailures: string[] = [];

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

// The window uses Windows' own title bar (close, minimize, snap), so the page
// only needs the sidebar.
function nav(): HTMLElement {
  const item = (p: Page, label: string, ic: string) =>
    h('button', { class: `nav-item${page === p ? ' active' : ''}`, html: `${icon(ic)}<span>${label}</span>`, onclick: () => go(p) });
  return h('nav', { class: 'nav' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-pill' }, [h('i')]), h('span', { text: 'Island' })]),
    item('activities', 'Activities', 'pulse'),
    item('workspaces', 'Workspaces', 'grid'),
    item('settings', 'Settings', 'settings'),
  ]);
}

function go(p: Page): void {
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
  const scroll = root.querySelector('.content')?.scrollTop ?? 0;
  const body = page === 'activities' ? activitiesPage() : page === 'workspaces' ? workspacesView().el : settingsPage();
  root.replaceChildren(h('div', { class: 'body' }, [nav(), h('main', { class: 'content' }, [body])]));
  const content = root.querySelector('.content');
  if (content) content.scrollTop = scroll;
  if (page === 'workspaces') workspacesView().shown();
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

const BANDS: Array<{ id: Band | 'available'; label: string; help: string }> = [
  { id: 'high', label: 'High', help: 'Take the island first' },
  { id: 'medium', label: 'Medium', help: 'Shown when nothing high is happening' },
  { id: 'low', label: 'Low', help: 'Background details' },
  { id: 'available', label: 'Available', help: 'Off. Drag one up, or flip its switch, to turn it on' },
];

function orderedIds(): Array<{ kind: 'band'; band: Band | 'available' } | { kind: 'card'; id: string }> {
  const out: Array<{ kind: 'band'; band: Band | 'available' } | { kind: 'card'; id: string }> = [];
  for (const b of BANDS) {
    out.push({ kind: 'band', band: b.id });
    for (const id of settings.activities.order) {
      const c = cfg(id);
      if (!c || !CATALOG_BY_ID.has(id)) continue;
      const band = c.enabled && availableHere(id) ? c.priority : 'available';
      if (band === b.id) out.push({ kind: 'card', id });
    }
  }
  return out;
}

function activitiesPage(): HTMLElement {
  const list = h('div', { class: 'act-list' });
  for (const item of orderedIds()) {
    if (item.kind === 'band') {
      const b = BANDS.find((x) => x.id === item.band)!;
      list.append(h('div', { class: 'band', 'data-band': b.id }, [h('span', { class: 'band-name', text: b.label }), h('span', { class: 'band-help', text: b.help })]));
    } else list.append(activityCard(CATALOG_BY_ID.get(item.id)!));
  }
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: 'Activities' }), h('p', { text: 'What the island shows, how much each thing matters, and how it behaves. Drag to reorder.' })]),
    sizeCard(),
    list,
  ]);
}

/** What Priority means, under its switch on every activity. */
const PRIORITY_HELP = 'When several things happen at once, the highest one gets the pill and the others wait beside it as small icons. A tie goes to the one higher on this page.';

/** Each behavior switch, with what it does in plain words (shown under it, not hidden in a tooltip). */
const BEHAVIORS: Array<[keyof Pick<ActivityConfig, 'autoShow' | 'persistent' | 'interactive' | 'interrupt'>, string, string]> = [
  ['autoShow', 'Auto-show', 'Pops the island open for a few seconds when something happens here, like a download finishing. Off: it changes quietly, and you see it when you look.'],
  ['persistent', 'Persistent', "Keeps it on the pill for as long as it's going, like music while it plays. Off: it takes the pill only for its moments, then waits beside it as a small icon."],
  ['interactive', 'Interactive', 'Its buttons work right on the island: pause, Accept, Open. Off: the island only shows it.'],
  ['interrupt', 'Interrupt', 'Lets it take over the island for urgent moments, like a permission request or a timer going off, even over something with a higher priority. Off: those moments wait their turn.'],
];

function activityCard(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const open = openCards.has(meta.id);
  // On a Mac, what it cannot run yet says so instead of offering a switch.
  const reason = unavailableReason(meta.id);
  const card = h('div', { class: `act-card${c.enabled && !reason ? '' : ' off'}${reason ? ' unavailable' : ''}${open ? ' open' : ''}`, 'data-id': meta.id });
  const head = h('div', { class: 'act-head' }, [
    h('span', { class: 'grip', html: icon('more'), title: 'Drag to reorder' }),
    h('span', { class: 'act-icon', html: icon(meta.icon) }),
    h('div', { class: 'act-text' }, [h('div', { class: 'act-name', text: meta.name }), h('div', { class: 'act-desc', text: meta.description })]),
    reason
      ? h('span', { class: 'act-soon', text: reason })
      : meta.builtIn
        ? h('span', { class: 'act-soon', text: 'Built in', title: `${meta.name} is part of Island and always on` })
        : toggle(c.enabled, (v) => {
            c.enabled = v;
            save(true);
            flipRender();
          }, `Enable ${meta.name}`),
    h('button', { class: 'chev', html: icon('chevron-down'), title: open ? 'Collapse' : 'Options', onclick: (e: Event) => { e.stopPropagation(); toggleCard(meta.id); } }),
  ]);
  head.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, card));
  card.append(head);
  if (open) card.append(cardBody(meta));
  return card;
}

function cardBody(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const behaviors = BEHAVIORS.map(([key, label, help]) => row(label, help, toggle(c[key], (v) => { c[key] = v; save(true); }, label)));
  const body = h('div', { class: 'act-body' }, [
    row('Priority', PRIORITY_HELP, segmented(c.priority, [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], (v) => { c.priority = v; c.enabled = true; save(true); flipRender(); })),
    ...behaviors,
    // Local AI's model is picked in its panel below, not typed.
    ...meta.options.filter((o) => optionHere(o) && !(meta.id === 'local' && o.key === 'model')).map((o) => optionRow(meta.id, o)),
  ]);
  if (meta.id === 'claude') body.append(claudePanel());
  if (meta.id === 'local') body.append(localPanel());
  if (meta.id === 'land') body.append(landPanel());
  if (meta.id === 'workspaces') body.append(noticePanel({ ask, openWorkspaces: () => { go('workspaces'); void sendTo('app', 'ws-seed', null); } }));
  return body;
}

function optionRow(id: string, o: OptionSpec): HTMLElement {
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

function toggleCard(id: string): void {
  const card = root.querySelector<HTMLElement>(`.act-card[data-id="${id}"]`);
  if (openCards.has(id)) openCards.delete(id);
  else openCards.add(id);
  if (!card) return render();
  const before = card.getBoundingClientRect().height;
  const others = captureRects();
  card.classList.toggle('open', openCards.has(id));
  card.querySelector('.act-body')?.remove();
  if (openCards.has(id)) card.append(cardBody(CATALOG_BY_ID.get(id)!));
  const after = card.getBoundingClientRect().height;
  springAnimate(card, [{ height: `${before}px` }, { height: `${after}px` }], springs.content);
  playFlip(others);
}

// ------------------------------------------------------------------ fluid reordering (FLIP + springs)

function captureRects(): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>('.act-card, .band').forEach((el) => m.set(el.dataset.id ?? `band-${el.dataset.band}`, el.getBoundingClientRect()));
  return m;
}

function playFlip(before: Map<string, DOMRect>): void {
  root.querySelectorAll<HTMLElement>('.act-card, .band').forEach((el) => {
    const key = el.dataset.id ?? `band-${el.dataset.band}`;
    const was = before.get(key);
    if (!was) {
      springAnimate(el, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], springs.content);
      return;
    }
    const now = el.getBoundingClientRect();
    const dy = was.top - now.top;
    if (Math.abs(dy) < 0.5) return;
    springAnimate(el, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], springs.content);
  });
}

function flipRender(): void {
  const before = captureRects();
  render();
  playFlip(before);
}

interface DragState {
  card: HTMLElement;
  id: string;
  startY: number;
  items: HTMLElement[];
  tops: number[];
  heights: number[];
  from: number;
  to: number;
  gap: number;
  self: SpringSet<'y' | 's'>;
  others: Map<HTMLElement, SpringSet<'y'>>;
  started: boolean;
}
let drag: DragState | null = null;

function startDrag(e: PointerEvent, card: HTMLElement): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.switch, .chev, input, button:not(.grip)')) return;
  const items = [...root.querySelectorAll<HTMLElement>('.act-list > *')];
  const rects = items.map((el) => el.getBoundingClientRect());
  const from = items.indexOf(card);
  drag = {
    card,
    id: card.dataset.id!,
    startY: e.clientY,
    items,
    tops: rects.map((r) => r.top),
    heights: rects.map((r) => r.height),
    from,
    to: from,
    gap: rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 8,
    self: new SpringSet({ y: 0, s: 1 }, (v) => { card.style.transform = `translateY(${v.y}px) scale(${v.s})`; }, springs.drag),
    others: new Map(),
    started: false,
  };
  card.setPointerCapture(e.pointerId);
  card.addEventListener('pointermove', onDragMove);
  card.addEventListener('pointerup', onDragEnd, { once: true });
  card.addEventListener('pointercancel', onDragEnd, { once: true });
}

function onDragMove(e: PointerEvent): void {
  const d = drag;
  if (!d) return;
  const dy = e.clientY - d.startY;
  if (!d.started) {
    if (Math.abs(dy) < 5) return;
    d.started = true;
    dragging = true;
    d.card.classList.add('dragging');
    d.self.set({ s: 1.03 }, { config: springs.snappy });
  }
  d.self.set({ y: dy }, { config: springs.drag });
  // Where would the card's centre land? Never above the first band header.
  const centre = d.tops[d.from] + d.heights[d.from] / 2 + dy;
  let to = d.from;
  for (let i = 0; i < d.items.length; i++) {
    if (i === d.from) continue;
    const mid = d.tops[i] + d.heights[i] / 2;
    if (i < d.from && centre < mid) to = Math.min(to, i);
    if (i > d.from && centre > mid) to = Math.max(to, i);
  }
  to = Math.max(1, to);
  if (to === d.to) return;
  d.to = to;
  const shift = d.heights[d.from] + d.gap;
  d.items.forEach((el, i) => {
    if (i === d.from) return;
    let target = 0;
    if (d.from < d.to && i > d.from && i <= d.to) target = -shift;
    if (d.from > d.to && i >= d.to && i < d.from) target = shift;
    let s = d.others.get(el);
    if (!s) {
      s = new SpringSet({ y: 0 }, (v) => { el.style.transform = v.y ? `translateY(${v.y}px)` : ''; }, springs.content);
      d.others.set(el, s);
    }
    s.set({ y: target }, { config: springs.content });
  });
}

function onDragEnd(): void {
  const d = drag;
  drag = null;
  if (!d) return;
  d.card.removeEventListener('pointermove', onDragMove);
  if (!d.started) {
    dragging = false;
    return;
  }
  // Settle into the gap, then commit the new order and band.
  const slotTop = d.to > d.from ? d.tops[d.to] + d.heights[d.to] - d.heights[d.from] : d.tops[d.to];
  d.self.set({ y: slotTop - d.tops[d.from], s: 1 }, { config: springs.content });
  d.self.onRest(() => {
    const seq = d.items.map((el) => el.dataset.id ?? `band:${el.dataset.band}`);
    const [moved] = seq.splice(d.from, 1);
    seq.splice(d.to, 0, moved);
    let band: string = 'high';
    const order: string[] = [];
    for (const key of seq) {
      if (key.startsWith('band:')) {
        band = key.slice(5);
        continue;
      }
      order.push(key);
      if (key === d.id) {
        const c = cfg(key);
        // A built-in one (Land) cannot be turned off: dropped on Available, it goes back to its band.
        if (band === 'available') c.enabled = CATALOG_BY_ID.get(key)?.builtIn === true;
        else {
          c.enabled = true;
          c.priority = band as Band;
        }
      }
    }
    for (const id of settings.activities.order) if (!order.includes(id)) order.push(id);
    settings.activities.order = order;
    save(true);
    d.card.classList.remove('dragging');
    dragging = false;
    const before = new Map<string, DOMRect>();
    d.items.forEach((el) => before.set(el.dataset.id ?? `band-${el.dataset.band}`, el.getBoundingClientRect()));
    render();
    playFlip(before);
  });
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

function claudePanel(): HTMLElement {
  const panel = h('div', { class: 'claude-panel' }, [h('div', { class: 'muted', text: 'Loading…' })]);
  const load = async () => {
    if (!panel.isConnected) {
      clearInterval(claudeTimer);
      return;
    }
    const snap = await ask<ClaudeSnapshot>('claude', 'snapshot');
    if (snap && panel.isConnected && !dragging) fillClaude(panel, snap);
  };
  clearInterval(claudeTimer);
  claudeTimer = setInterval(load, 2000);
  void load();
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

function settingsPage(): HTMLElement {
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
  const hotkey = (key: 'toggleHotkey' | 'activitiesHotkey', failId: string) => {
    const input = h('input', { type: 'text', value: g[key], spellcheck: 'false', placeholder: 'e.g. Alt+Shift+Space' });
    input.addEventListener('change', () => {
      g[key] = input.value.trim();
      save(true);
    });
    return h('div', { class: 'hotkey' }, [input, hotkeyFailures.includes(failId) ? h('span', { class: 'warn', text: 'Taken by another app' }) : null]);
  };
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', { text: 'Settings' }), h('p', { text: 'How Island looks and behaves everywhere.' })]),
    section('Appearance', [
      row('Pill colour', 'The whole island, card included.', segmented(i.color, [['black', 'Black'], ['white', 'White'], ['matte-white', 'Matte white'], ['matte-black', 'Matte black'], ['glass', 'Glass']], (v) => { i.color = v; save(true); render(); })),
      row('Accent', null, accents),
      row('Bot', 'A little bot beside the pill, in your accent colour. It reacts to what happens; click it to talk to it.', toggle(i.bot, (v) => { i.bot = v; save(true); render(); })),
      row('Size', 'Pill height and text size.', segmented(i.size, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => { i.size = v; save(true); render(); })),
      row('Distance from the edge', 'Gap between the island and its screen edge.', edge),
      row('When nothing is happening', null, segmented(i.idle, [['pill', 'Small pill'], ['hidden', 'Tuck away']], (v) => { i.idle = v; save(true); render(); })),
      row('Reduce motion', 'Springs jump straight to their end.', segmented(i.reduceMotion, [['system', 'System'], ['on', 'On'], ['off', 'Off']], (v) => { i.reduceMotion = v; save(true); render(); })),
      row('Hover card', "What shows under the island when you point at it. Music's player and Phone's list still show when you point at them.", segmented(i.hoverCard, [['pointer', 'What you point at'], ['claude', 'Claude stats']], (v) => { i.hoverCard = v; save(true); render(); })),
      row('Border glow', 'Light that circles the pill while something works; orange is Claude. Off saves the most battery.', segmented(i.glow, [['off', 'Off'], ['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']], (v) => { i.glow = v; save(true); render(); })),
    ]),
    section('Display', [
      stacked(row('Show the island on', duplicate ? 'Duplicate: the pill shows on every screen picked below. You click it on the primary one (or the first picked); the rest are copies.' : 'Multi-monitor: which display it lives on.', displayChoice)),
      monitorList,
    ]),
    section('Behavior', [
      row('Expand on hover', null, toggle(i.hoverExpand, (v) => { i.hoverExpand = v; save(true); })),
      row('Peek behind', `With the pointer on the island, tap ${ctrlKey()}: it fades and your clicks go to whatever is under it, until the pointer moves away.`, toggle(i.peekThrough, (v) => { i.peekThrough = v; save(true); })),
      row('Hide in full-screen apps', 'Games, videos and presentations. Urgent things still show.', toggle(i.hideInFullscreen, (v) => { i.hideInFullscreen = v; save(true); })),
      row('Show other activities beside the main one', 'Small chips, with +N when there is no room.', toggle(i.showSecondary, (v) => { i.showSecondary = v; save(true); })),
      row('Do not disturb', 'Nothing expands on its own; urgent moments still interrupt.', toggle(g.dnd, (v) => { g.dnd = v; save(true); })),
      menuRow(i),
      hideRow(i, mac),
    ]),
    section('Startup', [
      row(mac ? 'Open at login' : 'Start with Windows', null, toggle(g.startWithWindows, (v) => { g.startWithWindows = v; save(true); void native.autostartSet(v); })),
      row('Update automatically', mac ? 'When a newer Island is released, it downloads in the background and Island restarts into it. Island must be in Applications.' : 'When a newer Island is released, it downloads in the background and Island restarts into it.', toggle(g.autoUpdate, (v) => { g.autoUpdate = v; save(true); })),
      row('Run setup again', 'The two questions, the Local AI model and your phone. Your Control Center is rebuilt from the answers.', h('button', { class: 'btn', text: 'Run setup', onclick: () => go('welcome') })),
    ]),
    section('Notifications', [
      row(mac ? 'Mac notifications' : 'Windows notifications', 'A notification for moments that need you (Claude sessions, timers).', toggle(g.notifications, (v) => { g.notifications = v; save(true); })),
      row('Sounds', 'A soft chime when something finishes or needs you.', toggle(g.sounds, (v) => { g.sounds = v; save(true); })),
      row('Send to my phone', 'The same notifications, pushed to the free ntfy app on your phone, wherever it is.', toggle(g.phonePush, (v) => { g.phonePush = v; if (v && !g.phoneTopic) g.phoneTopic = newPhoneTopic(); save(true); render(); })),
      ...(g.phonePush && g.phoneTopic ? [phoneRow(g)] : []),
      ...(g.phonePush && g.phoneTopic && !mac
        ? [
            row(
              'Answer Claude from my phone',
              "Claude Code's permission pushes get Allow and Deny buttons. With Windows Hello asked before Allow (Activities › Claude Code), the phone can only Deny. Anyone who can read your topic could tap them too, so keep it to yourself.",
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
    section('Keyboard shortcuts', [
      row('Open or close the island', null, hotkey('toggleHotkey', 'island.toggle')),
      row('Open Activities', null, hotkey('activitiesHotkey', 'island.activities')),
      // Claude Code comes to the Mac in part 2, its session keys with it.
      ...(mac ? [] : [h('p', { class: 'muted', text: 'Claude Code sessions: Alt+Shift+1–9 switches, Alt+Shift+0 jumps to the one that needs you (Activities › Claude Code).' })]),
    ]),
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
  ]);
}

/** Which items the island's right-click menu shows; Settings is always there, the way back here. */
function menuRow(i: Settings['island']): HTMLElement {
  const choice = multiSegmented(
    MENU_ITEMS.filter((m) => i.menu[m.id]).map((m) => m.id),
    MENU_ITEMS.map((m) => [m.id, m.label]),
    (on) => {
      for (const m of MENU_ITEMS) i.menu[m.id] = on.includes(m.id);
      save(true);
      render();
    },
    0,
  );
  return stacked(row('Right-click menu', 'What the island shows when you right-click it. Turn off what you never use and the menu gets shorter by that much. Settings always stays.', choice));
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
    if (e.key === 'Escape' && isTauri && !e.defaultPrevented) void getCurrentWindow().close();
  });
  void cloneSettings;
}

catchErrors('app', (line) => void native.log(line));
void boot();
