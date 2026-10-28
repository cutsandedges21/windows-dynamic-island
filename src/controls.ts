// The Activities window's controls, shared by its pages (src/app.ts, src/workspaces/):
// a switch, a segmented choice, a settings row and a section card.

import { springAnimate } from './core/renderer';
import { springs } from './core/spring';
import { h } from './dom';

export function toggle(on: boolean, onchange: (v: boolean) => void, label = ''): HTMLElement {
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

export function segmented<T extends string>(value: T, options: Array<[T, string]>, onchange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'segmented' });
  for (const [v, label] of options) {
    wrap.append(h('button', { class: v === value ? 'on' : '', text: label, onclick: () => onchange(v) }));
  }
  return wrap;
}

/** Like segmented, but any mix can be on; the last `least` on stay on. */
export function multiSegmented(values: string[], options: Array<[string, string]>, onchange: (v: string[]) => void, least = 1): HTMLElement {
  const wrap = h('div', { class: 'segmented multi' });
  const on = new Set(values);
  for (const [v, label] of options) {
    const b = h('button', { class: on.has(v) ? 'on' : '', text: label, 'aria-pressed': String(on.has(v)) });
    b.addEventListener('click', () => {
      if (on.has(v) && on.size <= least) return;
      if (on.has(v)) on.delete(v);
      else on.add(v);
      b.classList.toggle('on', on.has(v));
      b.setAttribute('aria-pressed', String(on.has(v)));
      onchange(options.map(([x]) => x).filter((x) => on.has(x)));
    });
    wrap.append(b);
  }
  return wrap;
}

export function row(title: string, help: string | null, control: Node): HTMLElement {
  return h('div', { class: 'row' }, [h('div', { class: 'row-text' }, [h('div', { class: 'row-title', text: title }), help ? h('div', { class: 'row-help', text: help }) : null]), control]);
}

/** A row whose control sits under its text: for a switch with many choices. */
export function stacked(r: HTMLElement): HTMLElement {
  r.classList.add('stack');
  return r;
}

export function section(title: string, kids: Node[]): HTMLElement {
  return h('section', { class: 'card section' }, [h('h2', { text: title }), ...kids]);
}
