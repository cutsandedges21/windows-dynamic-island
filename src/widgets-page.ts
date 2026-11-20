// Settings › Widgets: desktop widgets (which ones, and how they look) and the taskbar (on or off,
// how it looks, whether Windows' own taskbar hides, whether it can be dragged). Both are drawn by
// the island (src/core/widgets.ts, src/core/dock.ts); this page only edits their settings.

import { section, row, segmented, toggle } from './controls';
import { icon, type IconName } from './core/icons';
import { sendTo } from './core/native';
import { DOCK_LABELS, DOCK_SIZE_LABELS, DOCK_STYLE_LABELS, dockRow, toggleDockItem, toggleStyle } from './core/dock';
import {
  barNeedsHidden,
  barOrder,
  type DockItem,
  DOCK_SIDES,
  DOCK_SIZES,
  DOCK_STYLES,
  frameAvailable,
  MAX_SITES,
  NAME_FONTS,
  NAME_LOOKS,
  type NameFont,
  type NameLook,
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
import { loadSiteIcon } from './core/frame';
import { screenPreview } from './previews';

const SIDE_LABELS: Record<DockSide, string> = { bottom: 'Bottom', left: 'Left', right: 'Right', top: 'Top' };
const CORNER_LABELS: Record<NotchCorner, string> = { 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' };
const NOTCH_SIZE_LABELS: Record<NotchSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

/** What each taskbar style does (Settings › Widgets › Taskbar); any of them can be on together. */
const STYLE_HINTS: Record<DockStyle, string> = {
  rise: 'Icons grow under the pointer.',
  spotlight: 'A light shines down on the app in front, and glides to the next one.',
  glide: 'A highlight slides along to what you point at.',
  names: 'The name of what you point at shows over the bar.',
  accent: "Start, search, Wi-Fi, sound, the battery and the rest of the icons that aren't apps take the accent colour.",
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
function lookPicker(look: ItemLook, host: WidgetsPageHost, followLabel = 'Like the island'): HTMLElement[] {
  const swatches = h(
    'div',
    { class: 'lookpick', role: 'radiogroup' },
    LOOKS.map(([value, name]) => [value, value === 'island' ? followLabel : name] as const).map(([value, label]) =>
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
/** Each taskbar item's icon in Settings. */
const DOCK_ICONS: Record<DockItem, IconName> = {
  start: 'grid',
  search: 'search',
  arrow: 'chevron-up',
  apps: 'window',
  music: 'music',
  timer: 'timer',
  claude: 'claude',
  tray: 'more',
  battery: 'battery',
  wifi: 'wifi',
  sound: 'speaker',
  clock: 'clock',
  notifications: 'bell',
  settings: 'settings',
};

/**
 * What the taskbar shows, as the right-click menu's editor (Justin, 11-19): the bar as it will read,
 * then its items to drag into order (by the handle, or along the bar itself) and turn on or off.
 * Settings' gear opens this page; it comes last, but can move like the rest.
 */
function dockPicker(host: WidgetsPageHost): HTMLElement {
  const t = host.settings().island.taskbar;
  let order = barOrder(t.order);
  const stage = h('div', { class: 'tb-stage', 'aria-label': 'Preview of the taskbar' });
  const list = h('div', { class: 'menu-editor', role: 'list' });
  /** The bar: the items on, in order, a line between kinds as the taskbar draws them. */
  const paint = (dragged: DockItem | null = null) => {
    const on = new Set(order.filter((k) => !t.hidden.includes(k)));
    stage.replaceChildren(
      ...dockRow(order, on).map((k) =>
        k === 'sep'
          ? h('i', { class: 'tb-sep' })
          : h('span', { class: `tb-item${k === dragged ? ' ghost' : ''}`, title: DOCK_LABELS[k], 'data-id': k, html: icon(DOCK_ICONS[k]) }),
      ),
    );
  };
  const commit = () => {
    t.order = [...order];
    host.save(true);
    paint();
  };
  const fill = () => {
    list.replaceChildren(
      ...order.map((k) => {
        const on = !t.hidden.includes(k);
        const grip = h('button', { class: 'me-grip', title: 'Drag to move, or drag it along the bar above (or Up / Down arrow keys)', 'aria-label': `Move ${DOCK_LABELS[k]}`, html: icon('grip') });
        const r = h('div', { class: `me-row${on ? '' : ' off'}`, role: 'listitem', 'data-id': k }, [
          grip,
          h('span', { class: 'me-ico', html: icon(DOCK_ICONS[k]) }),
          h('span', { class: 'me-name', text: DOCK_LABELS[k] }),
          toggle(on, () => {
            t.hidden = toggleDockItem(t.hidden, k);
            r.classList.toggle('off', t.hidden.includes(k));
            host.save(true);
            paint();
          }, `Show ${DOCK_LABELS[k]}`),
        ]);
        grip.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const i = order.indexOf(k);
          const j = i + (e.key === 'ArrowUp' ? -1 : 1);
          if (j < 0 || j >= order.length) return;
          order.splice(i, 1);
          order.splice(j, 0, k);
          fill();
          commit();
          (list.querySelector(`[data-id="${k}"] .me-grip`) as HTMLElement | null)?.focus();
        });
        // Along the list: pointer events, so a mouse, a touchpad and a finger all work.
        grip.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          r.classList.add('dragging');
          const start = order.join();
          const onMove = (ev: PointerEvent) => {
            for (const other of [...list.children] as HTMLElement[]) {
              if (other === r) continue;
              const box = other.getBoundingClientRect();
              const mid = box.top + box.height / 2;
              const before = (r.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
              if (before && ev.clientY < mid) {
                list.insertBefore(r, other);
                break;
              }
              if (!before && ev.clientY > mid) list.insertBefore(r, other.nextSibling);
            }
            order = barOrder([...list.children].map((x) => (x as HTMLElement).dataset.id));
            paint(k);
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            r.classList.remove('dragging');
            if (order.join() !== start) commit();
            else paint();
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
        });
        return r;
      }),
    );
  };
  // Along the bar: an item dragged past another's middle takes its place.
  stage.addEventListener('pointerdown', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.tb-item[data-id]');
    if (e.button !== 0 || !item) return;
    e.preventDefault();
    const k = item.dataset.id as DockItem;
    const start = order.join();
    const x0 = e.clientX;
    let moving = false;
    const onMove = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - x0) < 4) return;
      moving = true;
      const shown = [...stage.querySelectorAll<HTMLElement>('.tb-item[data-id]')].filter((x) => x.dataset.id !== k);
      const before = shown.find((x) => {
        const b = x.getBoundingClientRect();
        return ev.clientX < b.left + b.width / 2;
      });
      const rest = order.filter((x) => x !== k);
      const at = before ? rest.indexOf(before.dataset.id as DockItem) : rest.length;
      const next = [...rest.slice(0, at), k, ...rest.slice(at)];
      if (next.join() !== order.join()) {
        order = next;
        paint(k);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (order.join() !== start) {
        fill();
        commit();
      } else paint();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  fill();
  paint();
  const r = row('Show on the taskbar', 'Drag the handles to put them in order, or drag one along the bar; turn off what you never use. The battery only shows on a PC that has one; the gear opens these settings.', h('div', { class: 'menu-edit-wrap' }, [h('div', { class: 'tb-stage-wrap' }, [stage]), list]));
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
          // Search follows Start: Island's Start with its search field, or Windows' search.
          ...(t.hidden.includes('start') && t.hidden.includes('search')
            ? []
            : [
                sub(
                  row(
                    'Start opens',
                    "Island's own Start: your pinned apps, every app, your recent files, search and the power menu, in the taskbar's look. Search opens the same one, ready to type in.",
                    segmented(
                      t.startOpens,
                      [
                        ['island', "Island's Start"],
                        ['windows', "Windows' Start"],
                      ],
                      (v) => {
                        t.startOpens = v;
                        host.save(true);
                        host.render();
                      },
                    ),
                  ),
                ),
                ...(t.startOpens === 'island' && !t.hidden.includes('start')
                  ? [
                      sub(
                        row(
                          'The Windows key opens it too',
                          "A press of the Windows key on its own opens Island's Start; shortcuts like Win+E stay Windows'.",
                          toggle(t.startKey, (v) => {
                            t.startKey = v;
                            host.save(true);
                          }),
                        ),
                      ),
                    ]
                  : []),
              ]),
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
              t.scale = null;
              host.save(true);
              host.render();
            }),
          ),
          // Off the bottom, Windows' taskbar is not in the way: Blend and Auto-hide stand on their own.
          ...(barNeedsHidden(t) ? [] : edgeRows(host)),
          ...lookPicker(t.look, host),
          row(
            "Hide Windows' taskbar",
            barNeedsHidden(t) && !t.hideWindows
              ? "Windows' own taskbar hides itself while this one shows, and comes back when you turn this off or quit Island. Turn it on to blend this one into the bottom or let it auto-hide."
              : "Windows' own taskbar hides itself while this one shows, and comes back when you turn this off or quit Island. Pointing at the very bottom edge still brings it up.",
            toggle(t.hideWindows, (v) => {
              t.hideWindows = v;
              host.save(true);
              host.render();
            }),
          ),
          // At the bottom they live inside it (Moss, 11-18: on with Windows' taskbar still there they look wrong).
          ...(barNeedsHidden(t) && t.hideWindows ? edgeRows(host).map(sub) : []),
          row(
            'Place',
            'It stays put. Edit position lets you drag it along its edge, stretch its ends to make it longer and its top to make it taller, and double-click it back to the middle; press Done when it is right.',
            h('div', { class: 'row-actions' }, [
              h('button', { class: 'btn ghost', text: 'Back to the middle', onclick: () => void sendTo('island', 'dock-pref', { centre: true }) }),
              h('button', { class: 'btn', text: 'Edit position', onclick: () => void sendTo('dock', 'dock-edit', true) }),
            ]),
          ),
          h('p', { class: 'wtip', html: `${icon('info')}<span>Right-click the taskbar for the same choices.</span>` }),
        ]
      : []),
  ]);
  if (part === 'widgets') return h('div', { class: 'page' }, [head, widgets]);
  return h('div', { class: 'page' }, [head, h('div', { class: 'preview-dock' }, [screenPreview(s)]), taskbar, ...(t.on ? [stylesSection(host)] : []), borderSection(host)]);
}

/** A row that belongs to the one above it: indented under it. */
function sub(r: HTMLElement): HTMLElement {
  r.classList.add('sub');
  return r;
}

/** Blend into the edge (+ Melt the ends) and Auto-hide. */
function edgeRows(host: WidgetsPageHost): HTMLElement[] {
  const t = host.settings().island.taskbar;
  return [
    row(
      t.side === 'bottom' ? 'Blend into the bottom' : `Blend into the ${t.side} edge`,
      t.side === 'bottom' ? "Sits on the screen's bottom edge instead of floating above it." : `Sits on the screen's ${t.side} edge instead of floating beside it.`,
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
    row(
      'Auto-hide',
      'It waits faint on its edge, out of the way, and slides up when you point at it (as it does over a full-screen game).',
      toggle(t.autoHide, (v) => {
        t.autoHide = v;
        host.save(true);
      }),
    ),
  ];
}

const NAME_FONT_LABELS: Record<NameFont, string> = { system: 'System', clean: 'Clean', serif: 'Serif', mono: 'Mono', hand: 'Handwritten' };
const NAME_LOOK_LABELS: Record<NameLook, string> = { bubble: 'Bubble', plain: 'Plain', outline: 'Outline' };

/** Settings › Taskbar › Styles: how the taskbar answers the pointer, on its own card (Moss, 11-18). */
function stylesSection(host: WidgetsPageHost): HTMLElement {
  const t = host.settings().island.taskbar;
  const n = t.names;
  const styleRow = (k: DockStyle) =>
    row(
      DOCK_STYLE_LABELS[k],
      STYLE_HINTS[k],
      toggle(t.styles.includes(k), () => {
        t.styles = toggleStyle(t.styles, k);
        host.save(true);
        // Names and Accent bring their own rows.
        if (k === 'names' || k === 'accent') host.render();
      }),
    );
  // Each style's own rows, under it.
  const nameRows: HTMLElement[] = [];
  const accentRows: HTMLElement[] = t.styles.includes('accent')
    ? [
        sub(
          row(
            'Black outline',
            'A thin black line round each icon, so any accent stands out, on glass too.',
            toggle(t.accentBorder, (v) => {
              t.accentBorder = v;
              host.save(true);
            }),
          ),
        ),
      ]
    : [];
  if (t.styles.includes('names')) {
    const sample = h('span', { class: 'name-sample', 'data-name-font': n.font, 'data-name-look': n.look }, [h('span', { text: 'Spotify' })]);
    sample.classList.toggle('bold', n.bold);
    const font = segmented(
      n.font,
      NAME_FONTS.map((k) => [k, NAME_FONT_LABELS[k]] as [NameFont, string]),
      (v) => {
        n.font = v;
        host.save(true);
        host.render();
      },
    );
    // Each font's button is written in that font.
    font.querySelectorAll('button').forEach((b, i) => b.setAttribute('data-name-font', NAME_FONTS[i]));
    const fontRow = row('Font', null, font);
    fontRow.classList.add('stack');
    nameRows.push(
      sub(fontRow),
      sub(
        row(
          'Look',
          'Bubble sits in a small pill, Plain is the name alone, Outline is a thin ring round it.',
          segmented(
            n.look,
            NAME_LOOKS.map((k) => [k, NAME_LOOK_LABELS[k]] as [NameLook, string]),
            (v) => {
              n.look = v;
              host.save(true);
              host.render();
            },
          ),
        ),
      ),
      sub(
        row(
          'Bold',
          null,
          toggle(n.bold, (v) => {
            n.bold = v;
            sample.classList.toggle('bold', v);
            host.save(true);
          }),
        ),
      ),
      sub(row('How it looks', null, h('div', { class: 'name-stage' }, [sample]))),
    );
  }
  const rows = DOCK_STYLES.flatMap((k) => [styleRow(k), ...(k === 'names' ? nameRows : k === 'accent' ? accentRows : [])]);
  return section('Styles', [h('p', { class: 'muted section-note', text: 'How the taskbar answers your pointer. Mix any of them.' }), ...rows]);
}

/** One notch's choices: on or off, where, how big. */
function notchRows(kind: 'sites' | 'shelf', name: string, about: string, c: NotchConfig, host: WidgetsPageHost): HTMLElement[] {
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
            'Corner',
            c.at ? 'It sits where you dragged it; Back to the corner puts it here again.' : null,
            segmented(c.corner, NOTCH_CORNERS.map((k) => [k, CORNER_LABELS[k]] as [NotchCorner, string]), (v) => {
              c.corner = v;
              c.at = null;
              host.save(true);
              host.render();
            }),
          ),
          row(
            'Move it',
            'Edit position lets you drag it anywhere along either side of the screen; press Done to keep it there.',
            h('div', { class: 'row-actions' }, [
              ...(c.at
                ? [
                    h('button', {
                      class: 'btn ghost',
                      text: 'Back to the corner',
                      onclick: () => {
                        c.at = null;
                        host.save(true);
                        host.render();
                      },
                    }),
                  ]
                : []),
              h('button', { class: 'btn', text: 'Edit position', onclick: () => void sendTo('frame', 'frame-edit', kind) }),
            ]),
          ),
          sub(
            row(
              'Always movable',
              'Drag it any time, without Edit position.',
              toggle(c.free, (v) => {
                c.free = v;
                host.save(true);
              }),
            ),
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
  const icoOf = (url: string) => {
    const img = h('img', { class: 'site-ico', alt: '' }) as HTMLImageElement;
    loadSiteIcon(img, url);
    return img;
  };
  const rows = isl.sites.map((s, i) =>
    h('div', { class: 'site-row' }, [
      icoOf(s.url),
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
    ...notchRows('sites', 'Websites notch', 'Your pinned sites in a notch on the screen’s edge; click one to open it in your browser.', f.sites, host),
    ...(f.sites.on ? [sitesList(host)] : []),
    ...notchRows('shelf', 'Shelf notch', 'Files you keep for later, in a notch on the screen’s edge; drag one out, or drop files on it.', f.shelf, host),
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
          'A thin line round your whole screen that joins the taskbar and the island. Turn on the taskbar with Blend into the edge here to use it.',
          h('span', { class: 'muted', text: 'Not available yet' }),
        ),
      ];
  // Their own look and ways (Moss, 11-19), for the border and both notches.
  const shown = frameAvailable(isl) && f.on;
  const anyNotch = f.sites.on || f.shelf.on;
  const sides = new Set([f.sites, f.shelf].filter((c) => c.on).map((c) => c.at?.side ?? (c.corner.endsWith('left') ? 'left' : 'right')));
  const blendLabel = sides.size === 1 ? `Blend into the ${[...sides][0]} edge` : 'Blend into the sides';
  const ways =
    shown || anyNotch
      ? [
          ...lookPicker(f.look, host, 'Like the taskbar'),
          row(
            'Auto-hide',
            'The border and the notches wait faint until your pointer comes to the screen’s edge.',
            toggle(f.autoHide, (v) => {
              f.autoHide = v;
              host.save(true);
            }),
          ),
          ...(anyNotch
            ? [
                row(
                  blendLabel,
                  'The notches sit on the screen’s edge. Off, they float just off it, rounded all round.',
                  toggle(f.blend, (v) => {
                    f.blend = v;
                    host.save(true);
                    host.render();
                  }),
                ),
                ...(f.blend
                  ? [
                      sub(
                        row(
                          'Melt the ends',
                          'Their ends curve out into the edge instead of meeting it square.',
                          toggle(f.melt, (v) => {
                            f.melt = v;
                            host.save(true);
                          }),
                        ),
                      ),
                    ]
                  : []),
              ]
            : []),
        ]
      : [];
  return section('Screen border and notches', [...border, ...notches, ...ways]);
}
