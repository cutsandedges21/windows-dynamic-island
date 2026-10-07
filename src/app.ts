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
import { isTauri, native, on, sendTo, type MonitorInfo } from './core/native';
import { springAnimate } from './core/renderer';
import { ACCENTS, cloneSettings, migrate, type ActivityConfig, type Settings } from './core/settings';
import { springs } from './core/spring';

type Page = 'activities' | 'settings';
type Props = Record<string, unknown> & { class?: string; text?: string; html?: string };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, kids: Array<Node | string | null | false | undefined> = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v); // static icon markup only
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

let settings: Settings = migrate(null);
// Rust passes the page to open in an init script (a # in the window URL is not reliable).
const requested = (window as unknown as { __ISLAND_PAGE__?: string }).__ISLAND_PAGE__ || location.hash.slice(1);
let page: Page = requested === 'settings' ? 'settings' : 'activities';
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
    item('activities', 'Activities', 'grid'),
    item('settings', 'Settings', 'settings'),
  ]);
}

function go(p: Page): void {
  if (p === page) return;
  page = p;
  location.hash = p;
  render();
  const content = root.querySelector('.content');
  if (content) springAnimate(content, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

function render(): void {
  if (dragging) return;
  const scroll = root.querySelector('.content')?.scrollTop ?? 0;
  root.replaceChildren(h('div', { class: 'body' }, [nav(), h('main', { class: 'content' }, [page === 'activities' ? activitiesPage() : settingsPage()])]));
  const content = root.querySelector('.content');
  if (content) content.scrollTop = scroll;
  document.documentElement.style.setProperty('--accent', ACCENTS[settings.island.accent] ?? settings.island.accent);
}

// ------------------------------------------------------------------ controls

function toggle(on: boolean, onchange: (v: boolean) => void, label = ''): HTMLElement {
  const el = h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': label }, [h('i')]);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    el.setAttribute('aria-checked', String(next));
    const knob = el.firstElementChild!;
    springAnimate(knob, [{ transform: `translateX(${next ? -16 : 16}px) scaleX(1.25)` }, { transform: 'none' }], springs.bouncy);
    onchange(next);
  });
  return el;
}

function segmented<T extends string>(value: T, options: Array<[T, string]>, onchange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'segmented' });
  for (const [v, label] of options) {
    wrap.append(h('button', { class: v === value ? 'on' : '', text: label, onclick: () => onchange(v) }));
  }
  return wrap;
}

function row(title: string, help: string | null, control: Node): HTMLElement {
  return h('div', { class: 'row' }, [h('div', { class: 'row-text' }, [h('div', { class: 'row-title', text: title }), help ? h('div', { class: 'row-help', text: help }) : null]), control]);
}

/** A row whose control sits under its text: for a switch with many choices. */
function stacked(r: HTMLElement): HTMLElement {
  r.classList.add('stack');
  return r;
}

function section(title: string, kids: Node[]): HTMLElement {
  return h('section', { class: 'card section' }, [h('h2', { text: title }), ...kids]);
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
      const band = c.enabled ? c.priority : 'available';
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

const BEHAVIORS: Array<[keyof Pick<ActivityConfig, 'autoShow' | 'persistent' | 'interactive' | 'interrupt'>, string, string]> = [
  ['autoShow', 'Auto-show', 'Expand on its own when something happens'],
  ['persistent', 'Persistent', 'Stay on the island while it is active'],
  ['interactive', 'Interactive', 'Buttons work right in the pill'],
  ['interrupt', 'Interrupt', 'May take over for urgent moments'],
];

function activityCard(meta: ActivityMeta): HTMLElement {
  const c = cfg(meta.id);
  const open = openCards.has(meta.id);
  const card = h('div', { class: `act-card${c.enabled ? '' : ' off'}${open ? ' open' : ''}`, 'data-id': meta.id });
  const head = h('div', { class: 'act-head' }, [
    h('span', { class: 'grip', html: icon('more'), title: 'Drag to reorder' }),
    h('span', { class: 'act-icon', html: icon(meta.icon) }),
    h('div', { class: 'act-text' }, [h('div', { class: 'act-name', text: meta.name }), h('div', { class: 'act-desc', text: meta.description })]),
    toggle(c.enabled, (v) => {
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
  const chips = h('div', { class: 'behaviors' });
  for (const [key, label, help] of BEHAVIORS) {
    chips.append(
      h('button', {
        class: `chip${c[key] ? ' on' : ''}`,
        title: help,
        text: label,
        onclick: (e: Event) => {
          c[key] = !c[key];
          (e.currentTarget as HTMLElement).classList.toggle('on', c[key]);
          save(true);
        },
      }),
    );
  }
  const body = h('div', { class: 'act-body' }, [
    h('div', { class: 'body-row' }, [h('span', { class: 'label', text: 'Priority' }), segmented(c.priority, [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], (v) => { c.priority = v; c.enabled = true; save(true); flipRender(); })]),
    h('div', { class: 'body-row' }, [h('span', { class: 'label', text: 'Behavior' }), chips]),
    ...meta.options.map((o) => optionRow(meta.id, o)),
  ]);
  if (meta.id === 'claude') body.append(claudePanel());
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
  } else if (o.type === 'choice') control = segmented(String(opts[o.key] ?? o.default), o.choices.map((c) => [c.value, c.label] as [string, string]), (v) => { set(v); render(); });
  else {
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
        if (band === 'available') c.enabled = false;
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
    h('p', { class: 'muted', text: vertical ? 'Width levels, as a share of the display. On the left or right the island stands vertical, so they set its height.' : 'Width levels, as a share of the display. Drag a handle and watch the island.' }),
    track,
    readout,
  ]);
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

function settingsPage(): HTMLElement {
  const s = settings;
  const i = s.island;
  const g = s.general;
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
      row('Accent', null, accents),
      row('Size', 'Pill height and text size.', segmented(i.size, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => { i.size = v; save(true); render(); })),
      row('Distance from the edge', 'Gap between the island and its screen edge.', edge),
      row('When nothing is happening', null, segmented(i.idle, [['pill', 'Small pill'], ['hidden', 'Tuck away']], (v) => { i.idle = v; save(true); render(); })),
      row('Reduce motion', 'Springs jump straight to their end.', segmented(i.reduceMotion, [['system', 'System'], ['on', 'On'], ['off', 'Off']], (v) => { i.reduceMotion = v; save(true); render(); })),
      row('Hover card', 'What shows under the island when you point at it.', segmented(i.hoverCard, [['pointer', 'What you point at'], ['claude', 'Claude stats']], (v) => { i.hoverCard = v; save(true); render(); })),
      row('Border glow', 'Light that circles the pill while something works; orange is Claude. Off saves the most battery.', segmented(i.glow, [['off', 'Off'], ['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']], (v) => { i.glow = v; save(true); render(); })),
    ]),
    section('Display', [
      stacked(row('Show the island on', duplicate ? 'Duplicate: the pill shows on every screen picked below. You click it on the primary one (or the first picked); the rest are copies.' : 'Multi-monitor: which display it lives on.', displayChoice)),
      monitorList,
    ]),
    section('Behavior', [
      row('Expand on hover', null, toggle(i.hoverExpand, (v) => { i.hoverExpand = v; save(true); })),
      row('Hide in full-screen apps', 'Games, videos and presentations. Urgent things still show.', toggle(i.hideInFullscreen, (v) => { i.hideInFullscreen = v; save(true); })),
      row('Show other activities beside the main one', 'Small chips, with +N when there is no room.', toggle(i.showSecondary, (v) => { i.showSecondary = v; save(true); })),
      row('Do not disturb', 'Nothing expands on its own; urgent moments still interrupt.', toggle(g.dnd, (v) => { g.dnd = v; save(true); })),
    ]),
    section('Startup', [
      row('Start with Windows', null, toggle(g.startWithWindows, (v) => { g.startWithWindows = v; save(true); void native.autostartSet(v); })),
    ]),
    section('Notifications', [
      row('Windows notifications', 'A toast for moments that need you (Claude sessions, timers).', toggle(g.notifications, (v) => { g.notifications = v; save(true); })),
      row('Sounds', 'A soft chime when something finishes or needs you.', toggle(g.sounds, (v) => { g.sounds = v; save(true); })),
    ]),
    section('Keyboard shortcuts', [
      row('Open or close the island', null, hotkey('toggleHotkey', 'island.toggle')),
      row('Open Activities', null, hotkey('activitiesHotkey', 'island.activities')),
      h('p', { class: 'muted', text: 'Claude Code sessions: Alt+Shift+1–9 switches, Alt+Shift+0 jumps to the one that needs you (Activities › Claude Code).' }),
    ]),
    section('Privacy', [
      row('Show what you copied', 'Off: the Clipboard activity only says "Copied". Password managers are always skipped.', toggle(s.privacy.clipboardContent, (v) => { s.privacy.clipboardContent = v; save(true); })),
      row('Screenshot thumbnails', null, toggle(s.privacy.screenshotPreview, (v) => { s.privacy.screenshotPreview = v; save(true); })),
      h('p', { class: 'muted', text: 'Everything stays on this PC. The only network calls are Claude plan limits (with Claude Code\'s own sign-in), and weather or calendar if you turn them on.' }),
    ]),
    section('About', [
      h('p', { text: 'Island 0.1.0 by Moss. Claude session logic comes from Usage Clip; the hook relay is adapted from Coucou (MIT, Louis Raillé). Icons and design are Island\'s own.' }),
      h('div', { class: 'hook-actions' }, [
        h('button', { class: 'btn ghost', text: 'Open log folder', onclick: () => void native.open(`${localAppData}\\Island`) }),
        h('button', { class: 'btn danger', text: 'Quit Island', onclick: () => void native.quit() }),
      ]),
    ]),
  ]);
}

let localAppData = '';

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  settings = migrate(await native.settingsGet());
  monitors = await native.monitors();
  localAppData = (await native.knownFolders()).localAppData;
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
    if (e.key === 'Escape' && isTauri) void getCurrentWindow().close();
  });
  void cloneSettings;
}

void boot();
