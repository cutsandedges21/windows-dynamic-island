// The PC's Activities and Settings, on the phone: each activity on or off (and how it grows), and
// the settings the PC lets a phone change (src/remote/prefs.ts keeps that list), grouped like the
// PC's Settings nav. A change goes as `{t:'pref'}`; the PC answers with fresh `prefs`, which redraw.

import type { PhoneMsg, PrefActivity, PrefChoice, PrefRow, PrefValue } from '../../../../src/remote/protocol';
import { h, openSheet, spinner, toast, type PhSheet } from '../ui';

export type PrefsKind = 'activities' | 'settings';

export class PrefsSheet {
  private readonly sheet: PhSheet;
  alive = true;

  constructor(
    private readonly kind: PrefsKind,
    pcName: string,
    private readonly send: (m: PhoneMsg) => boolean,
  ) {
    this.sheet = openSheet({ title: kind === 'activities' ? 'Activities' : 'Settings', sub: `On ${pcName}`, icon: kind === 'activities' ? 'grid' : 'sliders', onClose: () => (this.alive = false) });
    this.sheet.body.append(spinner());
    if (!send({ t: 'prefs-get' })) toast('Not connected', 'bad');
  }

  private set(key: string, value: PrefValue): void {
    if (!this.send({ t: 'pref', key, value })) toast('Not connected', 'bad');
  }

  /** Fresh values from the PC. */
  show(rows: PrefRow[], acts: PrefActivity[]): void {
    if (!this.alive) return;
    this.sheet.body.replaceChildren(...(this.kind === 'activities' ? this.drawActs(acts) : this.drawRows(rows)));
  }

  private drawActs(acts: PrefActivity[]): HTMLElement[] {
    if (!acts.length) return [h('p', { class: 'ph-small ph-center', text: 'No activities.' })];
    return [
      h(
        'div',
        { class: 'ph-section ph-prefs' },
        acts.map((a) =>
          h('div', { class: 'ph-pref' }, [
            h('div', { class: 'ph-pref-line' }, [h('span', { class: 'ph-pref-label', text: a.name }), this.switch(a.enabled, (v) => this.set(`act:${a.id}:enabled`, v))]),
            a.enabled && a.choices.length > 1 ? this.seg(a.choices, a.grows, (v) => this.set(`act:${a.id}:grows`, v)) : null,
          ]),
        ),
      ),
    ];
  }

  private drawRows(rows: PrefRow[]): HTMLElement[] {
    const sections = new Map<string, PrefRow[]>();
    for (const r of rows) sections.set(r.section, [...(sections.get(r.section) ?? []), r]);
    return [...sections].map(([name, list]) => h('div', { class: 'ph-section ph-prefs' }, [h('div', { class: 'ph-label', text: name }), ...list.map((r) => this.row(r))]));
  }

  private row(r: PrefRow): HTMLElement {
    const label = h('span', { class: 'ph-pref-label', text: r.label });
    if (r.kind === 'bool') return h('div', { class: 'ph-pref' }, [h('div', { class: 'ph-pref-line' }, [label, this.switch(r.value === true, (v) => this.set(r.key, v))])]);
    if (r.kind === 'choice') return h('div', { class: 'ph-pref' }, [label, this.seg(r.choices ?? [], String(r.value), (v) => this.set(r.key, v))]);
    const input = h('input', { class: 'ph-range', type: 'range', min: String(r.min ?? 0), max: String(r.max ?? 100), step: '1' }) as HTMLInputElement;
    input.value = String(r.value);
    input.addEventListener('change', () => this.set(r.key, Number(input.value)));
    return h('div', { class: 'ph-pref' }, [label, input]);
  }

  private switch(on: boolean, set: (v: boolean) => void): HTMLElement {
    const b = h('button', { class: `ph-switch${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on) }, [h('span', { class: 'ph-knob' })]);
    b.addEventListener('click', () => {
      b.classList.toggle('on', !on);
      set(!on);
    });
    return b;
  }

  private seg(choices: PrefChoice[], value: string, set: (v: string) => void): HTMLElement {
    return h(
      'div',
      { class: 'ph-seg' },
      choices.map((c) => {
        const b = h('button', { class: `ph-seg-b${c.value === value ? ' on' : ''}`, type: 'button', text: c.label });
        b.addEventListener('click', () => c.value !== value && set(c.value));
        return b;
      }),
    );
  }
}
