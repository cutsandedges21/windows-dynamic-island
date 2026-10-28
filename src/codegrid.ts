// A choice with many short values in groups (Hockey's teams): every code on screen at once,
// one line per group, the chosen one's full name above. Picking updates in place.

import { h } from './dom';

export interface GridChoice {
  value: string;
  label: string;
  group?: string;
}

/** The choices by group, in the order they come. */
export function groupChoices(choices: GridChoice[]): Array<{ group: string; items: GridChoice[] }> {
  const out: Array<{ group: string; items: GridChoice[] }> = [];
  for (const c of choices) {
    const group = c.group ?? '';
    const last = out.at(-1);
    if (last && last.group === group) last.items.push(c);
    else out.push({ group, items: [c] });
  }
  return out;
}

export function codeGrid(value: string, choices: GridChoice[], onchange: (v: string) => void): HTMLElement {
  const name = h('div', { class: 'codegrid-name', text: choices.find((c) => c.value === value)?.label ?? value });
  const grid = h('div', { class: 'codegrid' }, [name]);
  const buttons: HTMLButtonElement[] = [];
  for (const { group, items } of groupChoices(choices)) {
    const codes = h('div', { class: 'codegrid-codes' });
    for (const c of items) {
      const b = h('button', { class: c.value === value ? 'on' : '', text: c.value, title: c.label, 'aria-label': c.label, 'aria-pressed': String(c.value === value) }) as HTMLButtonElement;
      b.dataset.value = c.value;
      b.addEventListener('click', () => {
        for (const x of buttons) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        }
        name.textContent = c.label;
        onchange(c.value);
      });
      buttons.push(b);
      codes.append(b);
    }
    grid.append(h('div', { class: 'codegrid-group', text: group }), codes);
  }
  return grid;
}
