// Edit Control Center: hold a tile on the phone and the PC's grid opens here to arrange, as
// holding a tile does on the PC. The tiles jiggle; move them up or down, take them off (they wait
// under "Add tiles"), put them back, then Save sends the whole layout to the PC (src/remote/grid-edit.ts),
// which saves it to the same setting the PC's own edit mode does.

import type { SheetView, Tile } from '../../../../src/core/sheet';
import { addKey, gridTiles, layoutOf, moveKey, removeKey, type PhoneLayout } from '../../../../src/remote/grid-edit';
import { button, h, ico, openSheet } from '../ui';

/** A tile's name for the list: its label or title if it has one, else its key. */
export function tileName(t: Tile | undefined, key: string): string {
  const b = (t?.body ?? {}) as { label?: unknown; title?: unknown };
  if (typeof b.label === 'string' && b.label) return b.label;
  if (typeof b.title === 'string' && b.title) return b.title;
  if (t?.tip) return t.tip;
  return key.split('/').pop() ?? key;
}

export function openGridEditor(view: SheetView | null, save: (l: PhoneLayout) => void): void {
  const { items, tray } = gridTiles(view);
  if (!items.length && !tray.length) return;
  const byKey = new Map([...items, ...tray].map((t) => [t.key, t]));
  let layout = layoutOf(view);
  const s = openSheet({ title: 'Edit Control Center', sub: 'Same layout as on the PC', icon: 'grid' });
  const list = h('div', { class: 'ph-section ph-ge' });

  const iconBtn = (name: string, label: string, fn: () => void, disabled = false) => {
    const b = h('button', { class: 'ph-ge-btn', type: 'button' }, [ico(name)]);
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', () => {
      fn();
      draw();
    });
    return b;
  };

  const draw = () => {
    const rows = layout.order.map((k, i) =>
      h('div', { class: 'ph-ge-row jiggle' }, [
        iconBtn('minus', 'Take off', () => (layout = removeKey(layout, k))),
        h('span', { class: 'ph-ge-name', text: tileName(byKey.get(k), k) }),
        iconBtn('chevron-up', 'Move up', () => (layout = moveKey(layout, k, i - 1)), i === 0),
        iconBtn('chevron-down', 'Move down', () => (layout = moveKey(layout, k, i + 1)), i === layout.order.length - 1),
      ]),
    );
    const extra = layout.hidden.map((k) =>
      h('div', { class: 'ph-ge-row off' }, [iconBtn('plus', 'Add', () => (layout = addKey(layout, k))), h('span', { class: 'ph-ge-name', text: tileName(byKey.get(k), k) })]),
    );
    list.replaceChildren(...rows, ...(extra.length ? [h('div', { class: 'ph-label', text: 'Add tiles' }), ...extra] : []));
  };
  draw();

  s.body.append(
    list,
    h('div', { class: 'ph-section ph-stack' }, [
      button('Save', {
        icon: 'check',
        style: 'primary',
        onclick: () => {
          s.close();
          save(layout);
        },
      }),
    ]),
  );
}
