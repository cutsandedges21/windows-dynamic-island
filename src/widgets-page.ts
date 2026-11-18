// Settings › Widgets: desktop widgets (which ones, and how they look) and the taskbar (on or off,
// how it looks, whether Windows' own taskbar hides, whether it can be dragged). Both are drawn by
// the island (src/core/widgets.ts, src/core/dock.ts); this page only edits their settings.

import { section, row, segmented, toggle } from './controls';
import { icon, type IconName } from './core/icons';
import { sendTo } from './core/native';
import { DOCK_LABELS, DOCK_SIZE_LABELS, DOCK_STYLE_LABELS, toggleDockItem, toggleStyle } from './core/dock';
import {
  DOCK_ITEMS,
  DOCK_SIDES,
  DOCK_SIZES,
  DOCK_STYLES,
  frameAvailable,
  MAX_SITES,
  NOTCH_CORNERS,
  NOTCH_SIZES,
  siteOf,
  type DockSide,
  type DockSize,
  type DockStyle,
  type ItemLook,
  type NotchConfig,
  type NotchCorner,
  type NotchSize,
  type Settings,
} from './core/settings';
import { faviconOf } from './core/frame';
import { screenPreview } from './previews';

const SIDE_LABELS: Record<DockSide, string> = { bottom: 'Bottom', left: 'Left', right: 'Right', top: 'Top' };
const CORNER_LABELS: Record<NotchCorner, string> = { 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' };
const NOTCH_SIZE_LABELS: Record<NotchSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

/** What each taskbar style does (Settings › Widgets › Taskbar); any of them can be on together. */
const STYLE_HINTS: Record<DockStyle, string> = {
  rise: 'Icons grow under the pointer.',
  spotlight: 'A light shines down on the app in front, and glides to the next one.',
  glide: 'A highlight and the name slide along to what you point at.',
};
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

/** Settings › Widgets: the desktop widgets alone. */
export function desktopWidgetsPage(host: WidgetsPageHost): HTMLElement {
  return widgetsPage(host, 'widgets');
}

/** Settings › Taskbar & border: the taskbar, the screen border and the notches, with the screen as it will look. */
export function taskbarPage(host: WidgetsPageHost): HTMLElement {
  return widgetsPage(host, 'taskbar');
}

function widgetsPage(host: WidgetsPageHost, part: 'widgets' | 'taskbar'): HTMLElement {
  const s = host.settings();
  const w = s.island.widgets;
  const t = s.island.taskbar;
  const head =
    part === 'widgets'
      ? h('div', { class: 'page-head' }, [h('h1', { text: 'Widgets' }), h('p', { text: 'Tiles from Control Center, live on your desktop, under your windows.' })])
      : h('div', { class: 'page-head' }, [h('h1', { text: 'Taskbar & border' }), h('p', { text: "Your own taskbar in the island's look, a line round the screen, and notches for your websites and the Shelf." })]);
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
            'Position',
            t.side === 'top' && s.island.anchor === 'top' ? 'On the top, the island sits in the middle of the taskbar.' : 'The screen edge it sits along.',
            segmented(t.side, DOCK_SIDES.map((k) => [k, SIDE_LABELS[k]] as [DockSide, string]), (v) => {
              t.side = v;
              // Its place along the old edge means nothing on the new one.
              t.centre = -1;
              host.save(true);
              host.render();
            }),
          ),
          row(
            'Size',
            'Medium is the size it has always been.',
            segmented(t.size, DOCK_SIZES.map((k) => [k, DOCK_SIZE_LABELS[k]] as [DockSize, string]), (v) => {
              t.size = v;
              host.save(true);
              host.render();
            }),
          ),
          ...DOCK_STYLES.map((k) =>
            row(
              DOCK_STYLE_LABELS[k],
              STYLE_HINTS[k],
              toggle(t.styles.includes(k), () => {
                t.styles = toggleStyle(t.styles, k);
                host.save(true);
              }),
            ),
          ),
          row(
            t.side === 'bottom' ? 'Blend into the bottom' : `Blend into the ${t.side} edge`,
            t.side === 'bottom' ? "Sits on the screen's bottom edge, over Windows' taskbar and the icons in its middle, instead of floating above it." : `Sits on the screen's ${t.side} edge instead of floating beside it.`,
            toggle(t.edge, (v) => {
              t.edge = v;
              host.save(true);
              host.render();
            }),
          ),
          ...(t.edge
            ? [
                row(
                  'Melt the ends',
                  'Its ends curve out into the edge of the screen instead of going straight into it.',
                  toggle(t.melt, (v) => {
                    t.melt = v;
                    host.save(true);
                  }),
                ),
              ]
            : []),
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
  if (part === 'widgets') return h('div', { class: 'page' }, [head, widgets]);
  return h('div', { class: 'page' }, [head, h('div', { class: 'preview-dock' }, [screenPreview(s)]), taskbar, borderSection(host)]);
}

/** One notch's choices: on or off, where, how big. */
function notchRows(name: string, about: string, c: NotchConfig, host: WidgetsPageHost): HTMLElement[] {
  return [
    row(
      name,
      about,
      toggle(c.on, (v) => {
        c.on = v;
        host.save(true);
        host.render();
      }),
    ),
    ...(c.on
      ? [
          row(
            'Place',
            null,
            segmented(c.corner, NOTCH_CORNERS.map((k) => [k, CORNER_LABELS[k]] as [NotchCorner, string]), (v) => {
              c.corner = v;
              host.save(true);
              host.render();
            }),
          ),
          row(
            'Size',
            'Small is smaller than the taskbar; Medium is the taskbar at Small.',
            segmented(c.size, NOTCH_SIZES.map((k) => [k, NOTCH_SIZE_LABELS[k]] as [NotchSize, string]), (v) => {
              c.size = v;
              host.save(true);
              host.render();
            }),
          ),
        ]
      : []),
  ];
}

/** The pinned websites: each with its icon and a remove button, and a field to add one. */
function sitesList(host: WidgetsPageHost): HTMLElement {
  const isl = host.settings().island;
  const field = h('input', { type: 'url', class: 'site-add-field', placeholder: 'Paste a link, like github.com', spellcheck: 'false', 'aria-label': 'Website to add' }) as HTMLInputElement;
  const note = h('span', { class: 'muted site-note' });
  const add = () => {
    const site = siteOf(field.value);
    if (!site) {
      note.textContent = "That isn't a web address.";
      return;
    }
    if (isl.sites.some((s) => s.url === site.url)) {
      note.textContent = 'Already pinned.';
      return;
    }
    if (isl.sites.length >= MAX_SITES) {
      note.textContent = `${MAX_SITES} websites at most.`;
      return;
    }
    isl.sites.push(site);
    host.save(true);
    host.render();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const rows = isl.sites.map((s, i) =>
    h('div', { class: 'site-row' }, [
      h('img', { class: 'site-ico', src: faviconOf(s.url), alt: '' }),
      h('span', { class: 'site-text' }, [h('b', { text: s.title }), h('span', { class: 'muted', text: s.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })]),
      h('button', {
        class: 'btn ghost icon-btn',
        title: 'Move up',
        disabled: i === 0,
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14.5 12 9l5.5 5.5"/></svg>',
        onclick: () => {
          isl.sites.splice(i - 1, 0, ...isl.sites.splice(i, 1));
          host.save(true);
          host.render();
        },
      }),
      h('button', {
        class: 'btn ghost icon-btn',
        title: `Remove ${s.title}`,
        html: icon('x'),
        onclick: () => {
          isl.sites.splice(i, 1);
          host.save(true);
          host.render();
        },
      }),
    ]),
  );
  return h('div', { class: 'sites' }, [
    ...rows,
    h('div', { class: 'site-add' }, [field, h('button', { class: 'btn', text: 'Add', onclick: add })]),
    note,
  ]);
}

/** Settings › Widgets › Screen border. */
function borderSection(host: WidgetsPageHost): HTMLElement {
  const isl = host.settings().island;
  const f = isl.frame;
  // The notches work with or without the border: without it they melt into the screen's edge.
  const notches = [
    ...notchRows('Websites notch', 'Your pinned sites in a notch on the screen’s edge; click one to open it in your browser.', f.sites, host),
    ...(f.sites.on ? [sitesList(host)] : []),
    ...notchRows('Shelf notch', 'Files you keep for later, in a notch on the screen’s edge; drag one out, or drop files on it.', f.shelf, host),
  ];
  const border = frameAvailable(isl)
    ? [
        row(
          'Show the border',
          'A thin line round your whole screen in the taskbar’s look, joining it and the island; the notches come out of it.',
          toggle(f.on, (v) => {
            f.on = v;
            host.save(true);
            host.render();
          }),
        ),
        ...(f.on
          ? [
              row(
                'Glow',
                'Where the light runs while Claude works or something waits on you.',
                segmented(
                  f.glow,
                  [
                    ['island', 'Island only'],
                    ['screen', 'Whole screen'],
                  ],
                  (v) => {
                    f.glow = v;
                    host.save(true);
                  },
                ),
              ),
            ]
          : []),
      ]
    : [
        row(
          'Show the border',
          'A thin line round your whole screen that joins the taskbar and the island. Turn on the taskbar with Blend into the edge here, and Blend into the top in Appearance, to use it.',
          h('span', { class: 'muted', text: 'Not available yet' }),
        ),
      ];
  return section('Screen border and notches', [...border, ...notches]);
}
