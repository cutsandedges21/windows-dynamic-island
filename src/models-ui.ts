// The Local AI model picker: cards in the welcome flow, rows under Activities › Local AI.
// It shows what this PC has, every model Island can download with the one that suits this
// PC marked Recommended, and Ollama's models when Ollama runs. Picking a model makes it the
// one that answers and downloads it if it is not on the PC yet. Downloads run in Rust and
// carry on when this window closes; every picker on screen follows them through events.

import { bridge, type IslandModel, type LocalModel, type LocalStatus, type ModelsReport, type SetupEnd, type SetupProgress } from './core/bridge';
import { icon } from './core/icons';
import { activeValue, ISLAND, isEmbedding, modelView, sizeText, specs, type ModelView } from './core/models';
import { on } from './core/native';
import { h } from './dom';

export interface PickerHost {
  /** Local AI's `model` option right now. */
  option(): string;
  /** Makes `value` the model that answers: 'island:small', an Ollama name, or '' to let Island choose. */
  choose(value: string): void;
}

type Layout = 'cards' | 'list';

interface Mounted {
  el: HTMLElement;
  host: PickerHost;
  layout: Layout;
  /** It has been on screen, so leaving the screen means it is gone. */
  seen: boolean;
  /** When it was made: one that never reached the screen is dropped after a moment. */
  born: number;
}

/** Shared by every picker, so a page redraw keeps the progress and errors. */
let report: ModelsReport | null = null;
let ollama: LocalStatus | null = null;
let progress: SetupProgress | null = null;
let loaded = false;
/** The last thing that went wrong, shown under its model until the next pick. */
let failure: { model: string; text: string } | null = null;
/** The model whose Delete was pressed once; a second press deletes it. */
let confirming: string | null = null;
const mounted = new Set<Mounted>();
let listening = false;

async function reload(): Promise<void> {
  const [r, s] = await Promise.all([bridge.localModels(), bridge.localStatus()]);
  report = r;
  ollama = s;
  loaded = true;
  if (!report?.downloading) progress = null;
  paintAll();
}

function listen(): void {
  if (listening) return;
  listening = true;
  void on<SetupProgress>('local-setup', (p) => {
    const fresh = report?.downloading !== p.model;
    progress = p;
    if (report) report.downloading = p.model;
    if (fresh) paintAll();
    else paintProgress();
  });
  void on<SetupEnd>('local-setup-end', (e) => {
    progress = null;
    if (!e.ok && !e.cancelled) failure = { model: e.model, text: e.error || 'The download failed.' };
    void reload();
  });
}

/** A picker that keeps itself up to date. */
export function modelPicker(host: PickerHost, layout: Layout): HTMLElement {
  listen();
  const entry: Mounted = { el: h('div', { class: `models models-${layout}` }), host, layout, seen: false, born: Date.now() };
  mounted.add(entry);
  paint(entry);
  void reload();
  return entry.el;
}

/** The name of the model downloading right now, as the pickers last heard. */
export function downloadingName(): string | null {
  const id = report?.downloading;
  return id ? (report?.models.find((m) => m.id === id)?.name ?? null) : null;
}

function paintAll(): void {
  for (const m of [...mounted]) {
    if (m.el.isConnected) m.seen = true;
    else if (m.seen || Date.now() - m.born > 2000) {
      mounted.delete(m);
      continue;
    }
    paint(m);
  }
}

/** Only the bar and the numbers: rebuilding buttons mid-click would swallow the click. */
function paintProgress(): void {
  const r = report;
  const m = r && progress ? r.models.find((x) => x.id === progress!.model) : undefined;
  if (!r || !m) return;
  const v = modelView(m, r, progress, false);
  for (const entry of mounted) {
    entry.el.querySelectorAll<HTMLElement>(`[data-model="${m.id}"]`).forEach((box) => {
      const fill = box.querySelector<HTMLElement>('.bar > i');
      if (fill) fill.style.width = `${Math.round((v.progress ?? 0) * 100)}%`;
      const detail = box.querySelector<HTMLElement>('.model-detail');
      if (detail) detail.textContent = v.detail;
      const pct = box.querySelector<HTMLElement>('.model-pct');
      if (pct) pct.textContent = v.progress == null ? '' : `${Math.round(v.progress * 100)}%`;
    });
  }
}

function paint(entry: Mounted): void {
  if (!loaded) {
    entry.el.replaceChildren(h('div', { class: 'muted models-wait', text: 'Looking at this PC…' }));
    return;
  }
  const r = report;
  if (!r) {
    entry.el.replaceChildren(h('div', { class: 'warn', text: 'Island could not read this PC.' }));
    return;
  }
  const option = entry.host.option();
  const active = activeValue(ollama, option);
  const list = h('div', { class: 'model-list' });
  for (const m of r.models) list.append(entry.layout === 'cards' ? card(entry, r, m, option, active) : row(entry, r, m, active));
  const kids: Node[] = [specsBlock(r), list];
  const theirs = ollama?.running ? ollama.models.filter((m) => !isEmbedding(m)) : [];
  if (theirs.length) kids.push(ollamaBlock(entry, theirs, active));
  if (entry.layout === 'list' && option) {
    kids.push(h('div', { class: 'models-foot' }, [h('button', { class: 'btn ghost', text: 'Let Island choose', title: 'The recommended model, or Ollama while it runs', onclick: () => pickValue(entry, '') })]));
  }
  entry.el.replaceChildren(...kids);
}

function specsBlock(r: ModelsReport): HTMLElement {
  const s = specs(r.machine, r.models);
  const item = (ic: string, label: string, value: string) =>
    h('div', { class: 'spec' }, [h('span', { class: 'spec-icon', html: icon(ic) }), h('div', { class: 'spec-text' }, [h('div', { class: 'spec-label', text: label }), h('div', { class: 'spec-value', text: value, title: value })])]);
  return h('div', { class: 'specs-block' }, [
    h('div', { class: 'specs' }, [item('cpu', s.threads ? `Processor · ${s.threads}` : 'Processor', s.cpu), item('memory', 'Memory', s.memory), item('gpu', 'Graphics', s.graphics), item('drive', 'Disk', s.disk)]),
    h('p', { class: 'spec-note', text: s.note }),
  ]);
}

const LABEL: Partial<Record<ModelView['status'], string>> = {
  ready: 'Downloaded',
  paused: 'Paused',
  'too-big': 'Too big for this PC',
  'no-room': 'Not enough space',
};

function statusTag(v: ModelView): HTMLElement | null {
  if (v.status === 'downloading') return h('span', { class: 'tag tag-live model-pct', text: v.progress == null ? '' : `${Math.round(v.progress * 100)}%` });
  if (v.status === 'in-use') return h('span', { class: 'tag tag-in-use', html: `${icon('check')}<span>In use</span>` });
  const text = LABEL[v.status];
  return text ? h('span', { class: `tag tag-${v.status}`, text }) : null;
}

function bar(v: ModelView): HTMLElement {
  const pct = Math.round((v.progress ?? 0) * 100);
  return h('div', { class: `bar${v.status === 'paused' ? ' paused' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, [h('i', { style: `width:${pct}%` })]);
}

function problem(m: IslandModel): HTMLElement | null {
  return failure?.model === m.id ? h('div', { class: 'model-error', text: failure.text }) : null;
}

/** The welcome flow's card: the whole card is the button. */
function card(entry: Mounted, r: ModelsReport, m: IslandModel, option: string, active: string): HTMLElement {
  const v = modelView(m, r, progress, active === ISLAND + m.id);
  const off = v.status === 'too-big' || v.status === 'no-room';
  const picked = option === ISLAND + m.id || active === ISLAND + m.id;
  const el = h('div', {
    class: `model-card status-${v.status}${m.recommended ? ' recommended' : ''}${picked ? ' picked' : ''}${off ? ' off' : ''}`,
    'data-model': m.id,
    role: 'button',
    tabindex: off ? -1 : 0,
    'aria-disabled': off ? 'true' : null,
    title: off ? v.detail : v.status === 'get' || v.status === 'paused' ? `Download ${m.name} and use it` : `Use ${m.name}`,
  }, [
    h('div', { class: 'model-top' }, [h('span', { class: 'model-name', text: m.name }), m.recommended ? h('span', { class: 'badge', text: 'Recommended' }) : null, statusTag(v)]),
    h('div', { class: 'model-about', text: m.about }),
    h('div', { class: 'model-detail', text: v.detail }),
    v.status === 'downloading' || v.status === 'paused' ? bar(v) : null,
    problem(m),
  ]);
  if (v.status === 'downloading') {
    el.append(h('button', { class: 'btn ghost model-cancel', text: 'Cancel', onclick: (e: Event) => (e.stopPropagation(), void bridge.localSetupCancel()) }));
  }
  if (!off) {
    el.addEventListener('click', () => void pick(entry, m));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void pick(entry, m);
      }
    });
  }
  return el;
}

/** The Activities page's row, with explicit buttons. */
function row(entry: Mounted, r: ModelsReport, m: IslandModel, active: string): HTMLElement {
  const v = modelView(m, r, progress, active === ISLAND + m.id);
  const button = (text: string, style: string, go: () => void, tip?: string) => h('button', { class: `btn ${style}`, text, title: tip, onclick: go });
  const actions: Node[] = [];
  if (v.status === 'ready') actions.push(button('Use', 'primary', () => void pick(entry, m)));
  if (v.status === 'get') actions.push(button('Download', 'primary', () => void pick(entry, m), `Download ${m.name} and use it`));
  if (v.status === 'paused') actions.push(button('Resume', 'primary', () => void pick(entry, m)));
  if (v.status === 'downloading') actions.push(button('Cancel', 'ghost', () => void bridge.localSetupCancel(), 'What is downloaded stays; Resume carries on'));
  if ((m.downloaded || m.partial > 0) && v.status !== 'downloading') {
    const sure = confirming === m.id;
    actions.push(button(sure ? `Delete ${sizeText(m.downloaded ? m.size : m.partial)}?` : 'Delete', sure ? 'danger' : 'ghost', () => void remove(entry, m), sure ? 'Press again to delete' : 'Free the disk space'));
  }
  return h('div', { class: `model-row status-${v.status}${m.recommended ? ' recommended' : ''}`, 'data-model': m.id }, [
    h('div', { class: 'model-text' }, [
      h('div', { class: 'model-top' }, [h('span', { class: 'model-name', text: m.name }), m.recommended ? h('span', { class: 'badge', text: 'Recommended' }) : null, statusTag(v)]),
      h('div', { class: 'model-about', text: m.about }),
      h('div', { class: 'model-detail', text: v.detail }),
      v.status === 'downloading' || v.status === 'paused' ? bar(v) : null,
      problem(m),
    ]),
    h('div', { class: 'model-actions' }, actions),
  ]);
}

function ollamaBlock(entry: Mounted, models: LocalModel[], active: string): HTMLElement {
  return h('div', { class: 'ollama-block' }, [
    h('div', { class: 'models-sub', text: 'Already on this PC, from Ollama' }),
    ...models.map((m) =>
      h('div', { class: 'model-row compact' }, [
        h('div', { class: 'model-text' }, [h('div', { class: 'model-top' }, [h('span', { class: 'model-name', text: m.name }), active === m.name ? statusTag({ status: 'in-use', detail: '', progress: null }) : null]), h('div', { class: 'model-detail', text: [sizeText(m.size), m.params].filter(Boolean).join(' · ') })]),
        h('div', { class: 'model-actions' }, active === m.name ? [] : [h('button', { class: 'btn', text: 'Use', onclick: () => pickValue(entry, m.name) })]),
      ]),
    ),
  ]);
}

function pickValue(entry: Mounted, value: string): void {
  failure = null;
  entry.host.choose(value);
  paintAll();
}

/** Makes `m` the model that answers, downloading it first if it is not here yet. */
async function pick(entry: Mounted, m: IslandModel): Promise<void> {
  const r = report;
  if (!r) return;
  const v = modelView(m, r, progress, false);
  if (v.status === 'too-big' || v.status === 'no-room') return;
  failure = null;
  entry.host.choose(ISLAND + m.id);
  if (v.status === 'downloading' || (m.downloaded && r.runtime)) {
    paintAll();
    return;
  }
  // Show it as starting now; the first event brings the real numbers.
  r.downloading = m.id;
  progress = null;
  paintAll();
  const started = await bridge.localSetup(m.id);
  if (!started.ok) {
    failure = { model: m.id, text: started.error };
    await reload();
  }
}

async function remove(entry: Mounted, m: IslandModel): Promise<void> {
  if (confirming !== m.id) {
    confirming = m.id;
    paintAll();
    setTimeout(() => {
      if (confirming !== m.id) return;
      confirming = null;
      paintAll();
    }, 4000);
    return;
  }
  confirming = null;
  const done = await bridge.localRemove(m.id);
  if (!done.ok) failure = { model: m.id, text: done.error };
  else if (entry.host.option() === ISLAND + m.id) entry.host.choose('');
  await reload();
}
