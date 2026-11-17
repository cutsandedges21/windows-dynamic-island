// Settings › Widgets: desktop widgets (which ones, and how they look) and the taskbar (on or off,
// how it looks, whether Windows' own taskbar hides, whether it can be dragged). Both are drawn by
// the island (src/core/widgets.ts, src/core/dock.ts); this page only edits their settings.

import { section, row, segmented, toggle } from './controls';
import { icon, type IconName } from './core/icons';
import { sendTo } from './core/native';
import { DOCK_LABELS, DOCK_SIZE_LABELS, toggleDockItem } from './core/dock';
import { DOCK_ITEMS, DOCK_SIZES, type DockSize, type ItemLook, type Settings } from './core/settings';
import { MAX_WIDGETS, newWidgetId, WIDGET_KINDS } from './core/widgets';
import { h } from './dom';

export interface WidgetsPageHost {
  settings(): Settings;
  /** Saves; `now` also redraws the island at once. */
  save(now?: boolean): void;
  /** Draws the page again. */
  render(): void;
  mac: boolean;
}

/** The looks, as the island's own Appearance offers them, plus following the island. */
const LOOKS: ReadonlyArray<[ItemLook['color'], string]> = [
  ['island', 'Like the island'],
  ['black', 'Black'],
  ['white', 'White'],
  ['matte-black', 'Matte black'],
  ['matte-white', 'Matte white'],
  ['glass', 'Glass'],
];

/** A row of small swatches, one per look, the chosen one ringed; under it the glass slider when Glass is picked. */
function lookPicker(look: ItemLook, host: WidgetsPageHost): HTMLElement[] {
  const swatches = h(
    'div',
    { class: 'lookpick', role: 'radiogroup' },
    LOOKS.map(([value, label]) =>
      h(
        'button',
        {
          class: `look${look.color === value ? ' on' : ''}`,
          role: 'radio',
          'aria-checked': String(look.color === value),
          title: label,
          onclick: () => {
            look.color = value;
            host.save(true);
            host.render();
          },
        },
        [h('span', { class: `lk lk-${value}` }), h('span', { class: 'lk-label', text: label })],
      ),
    ),
  );
  const out = [row('Look', null, swatches)];
  out[0].classList.add('stack');
  if (look.color === 'glass') {
    const slider = h('input', { type: 'range', min: 0, max: 100, value: String(look.glass), 'aria-label': 'Glass' });
    slider.addEventListener('input', () => {
      look.glass = Number(slider.value);
      host.save();
    });
    out.push(row('Glass', 'Clear is more see-through; tinted lets less of what is behind show through.', h('div', { class: 'glass-slider' }, [h('span', { class: 'muted', text: 'Clear' }), slider, h('span', { class: 'muted', text: 'Tinted' })])));
  }
  return out;
}

/** What the taskbar shows: a chip per item, ticked when it is on the taskbar. */
function dockPicker(host: WidgetsPageHost): HTMLElement {
  const t = host.settings().island.taskbar;
  const chips = h(
    'div',
    { class: 'dockpick' },
    DOCK_ITEMS.map((k) => {
      const on = !t.hidden.includes(k);
      return h(
        'button',
        {
          class: `dpi${on ? ' on' : ''}`,
          'aria-pressed': String(on),
          title: on ? `Take ${DOCK_LABELS[k]} off the taskbar` : `Put ${DOCK_LABELS[k]} on the taskbar`,
          onclick: () => {
            t.hidden = toggleDockItem(t.hidden, k);
            host.save(true);
            host.render();
          },
        },
        [h('span', { html: on ? icon('check') : icon('plus') }), h('span', { text: DOCK_LABELS[k] })],
      );
    }),
  );
  const r = row('Show on the taskbar', 'Pick what it shows. The battery only shows on a PC that has one.', chips);
  r.classList.add('stack');
  return r;
}

/** Every widget there is, as cards: its icon, name and what it shows, and whether it is on the desktop. */
function gallery(host: WidgetsPageHost): HTMLElement {
  const w = host.settings().island.widgets;
  const full = w.items.length >= MAX_WIDGETS;
  return h(
    'div',
    { class: 'wgal' },
    WIDGET_KINDS.map(({ kind, label, icon: ic, about }) => {
      const on = w.items.some((x) => x.kind === kind);
      const card = h(
        'button',
        {
          class: `wcard${on ? ' on' : ''}`,
          'aria-pressed': String(on),
          disabled: !on && full,
          title: on ? `Take ${label} off the desktop` : full ? `${MAX_WIDGETS} widgets at most` : `Put ${label} on the desktop`,
          onclick: () => {
            if (on) w.items = w.items.filter((x) => x.kind !== kind);
            else if (w.items.length < MAX_WIDGETS) w.items.push({ id: newWidgetId(kind, w.items.map((x) => x.id)), kind, x: -1, y: -1 });
            host.save(true);
            host.render();
          },
        },
        [
          h('span', { class: 'wc-ico', html: icon(ic as IconName) }),
          h('span', { class: 'wc-text' }, [h('b', { text: label }), h('span', { class: 'muted', text: about })]),
          h('span', { class: 'wc-state', html: on ? icon('check') : icon('plus') }),
        ],
      );
      return card;
    }),
  );
}

export function widgetsPage(host: WidgetsPageHost): HTMLElement {
  const s = host.settings();
  const w = s.island.widgets;
  const t = s.island.taskbar;
  const head = h('div', { class: 'page-head' }, [h('h1', { text: 'Widgets' }), h('p', { text: "Tiles from Control Center, live on your desktop, and a taskbar along the bottom, in the island's look." })]);
  if (host.mac) {
    return h('div', { class: 'page' }, [head, section('Coming to Mac', [h('p', { class: 'muted', text: 'Desktop widgets and the taskbar are on Windows for now.' })])]);
  }
  const placed = w.items.length;
  const widgets = section('Desktop widgets', [
    row(
      'Widgets on the desktop',
      placed ? `${placed} on the desktop. They sit under your windows; Show desktop (Win+D) brings them up with it.` : 'Pick the ones you want below.',
      toggle(w.on, (v) => {
        w.on = v;
        host.save(true);
        host.render();
      }),
    ),
    ...(w.on
      ? [
          gallery(host),
          ...lookPicker(w.look, host),
          h('p', { class: 'wtip', html: `${icon('info')}<span>Drag a widget to move it. Right-click it to lock it in place, pick a size (for widgets that show more when bigger) or take it off.</span>` }),
        ]
      : []),
  ]);
  const taskbar = section('Taskbar', [
    row(
      'Island taskbar',
      "Start, your apps (the Apps tile's and the ones open), music and the timer, Wi-Fi and sound, the clock and notifications.",
      toggle(t.on, (v) => {
        t.on = v;
        host.save(true);
        host.render();
      }),
    ),
    ...(t.on
      ? [
          dockPicker(host),
          row(
            'Size',
            'Medium is the size it has always been.',
            segmented(t.size, DOCK_SIZES.map((k) => [k, DOCK_SIZE_LABELS[k]] as [DockSize, string]), (v) => {
              t.size = v;
              host.save(true);
              host.render();
            }),
          ),
          ...lookPicker(t.look, host),
          row(
            "Hide Windows' taskbar",
            "Windows' own taskbar hides itself while this one shows, and comes back when you turn this off or quit Island. Pointing at the very bottom edge still brings it up.",
            toggle(t.hideWindows, (v) => {
              t.hideWindows = v;
              host.save(true);
            }),
          ),
          row(
            'Lock in place',
            'Off: drag the taskbar by its empty space to slide it along the bottom; double-click there to bring it back to the middle.',
            h('div', { class: 'row-actions' }, [
              h('button', { class: 'btn ghost', text: 'Back to the middle', onclick: () => void sendTo('island', 'dock-pref', { centre: true }) }),
              toggle(t.locked, (v) => {
                t.locked = v;
                host.save(true);
              }),
            ]),
          ),
          h('p', { class: 'wtip', html: `${icon('info')}<span>Right-click the taskbar for the same choices.</span>` }),
        ]
      : []),
  ]);
  return h('div', { class: 'page' }, [head, widgets, taskbar]);
}
