// The phone's own bits around the island: icons, toasts, and the sheets that slide up from the
// bottom (Send, Clipboard, the menu, a question before locking the PC). Plain DOM; the look is
// the island's (phone.css), in the phone's own fixed dark colours so a white pill on the PC
// never turns the phone's controls white.

import { icon } from '../../../src/core/icons';
import { h } from '../../../src/dom';

export { h };

/** An icon from the island's set (static markup). */
export function ico(name: string, cls = 'ph-ico'): HTMLElement {
  return h('span', { class: cls, html: icon(name), 'aria-hidden': 'true' });
}

/** A button in the island's style (`.sbtn`), with an icon and a label. */
export function button(label: string, opts: { icon?: string; style?: 'primary' | 'secondary' | 'ghost' | 'danger'; onclick?: (e: MouseEvent) => void; cls?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: `sbtn style-${opts.style ?? 'secondary'} ph-btn${opts.cls ? ` ${opts.cls}` : ''}`, type: 'button' }, [opts.icon ? ico(opts.icon, 'bi') : null, label ? h('span', { class: 'bl', text: label }) : null]);
  if (opts.onclick) b.addEventListener('click', opts.onclick);
  return b;
}

// ---------------------------------------------------------------- toasts

let toasts: HTMLElement | null = null;

export function toast(text: string, tone: 'good' | 'bad' | 'info' = 'info', ms = 2600): void {
  if (!toasts) {
    toasts = h('div', { class: 'ph-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toasts);
  }
  const t = h('div', { class: `ph-toast tone-${tone}` }, [ico(tone === 'good' ? 'check' : tone === 'bad' ? 'alert' : 'info'), h('span', { text })]);
  toasts.append(t);
  while (toasts.children.length > 3) toasts.firstElementChild?.remove();
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 260);
  }, ms);
}

// ---------------------------------------------------------------- sheets

export interface PhSheet {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  close(): void;
  readonly closed: Promise<void>;
}

let current: PhSheet | null = null;

/** A sheet from the bottom with a title; one at a time (a new one closes the last). */
export function openSheet(opts: { title: string; sub?: string; icon?: string; onClose?: () => void }): PhSheet {
  current?.close();
  const body = h('div', { class: 'ph-sheet-body' });
  const close = h('button', { class: 'ph-sheet-x', type: 'button', 'aria-label': 'Close', html: icon('x') });
  const head = h('div', { class: 'ph-sheet-head' }, [
    opts.icon ? ico(opts.icon, 'ph-sheet-icon') : null,
    h('div', { class: 'ph-sheet-titles' }, [h('div', { class: 'ph-sheet-title', text: opts.title }), opts.sub ? h('div', { class: 'ph-sheet-sub', text: opts.sub }) : null]),
    close,
  ]);
  const panel = h('div', { class: 'ph-sheet', role: 'dialog', 'aria-label': opts.title }, [h('div', { class: 'ph-grab' }), head, body]);
  const el = h('div', { class: 'ph-sheet-wrap' }, [h('div', { class: 'ph-backdrop' }), panel]);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let done!: () => void;
  const closed = new Promise<void>((r) => (done = r));
  let open = true;
  const sheet: PhSheet = {
    el,
    body,
    closed,
    close() {
      if (!open) return;
      open = false;
      if (current === sheet) current = null;
      el.classList.remove('in');
      setTimeout(() => el.remove(), 280);
      opts.onClose?.();
      done();
    },
  };
  el.querySelector('.ph-backdrop')!.addEventListener('click', () => sheet.close());
  close.addEventListener('click', () => sheet.close());
  // Swipe the sheet down to close it.
  let y0: number | null = null;
  panel.addEventListener('touchstart', (e) => (y0 = body.scrollTop <= 0 ? e.touches[0].clientY : null), { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    const dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    panel.style.transform = '';
    if (dy > 90) sheet.close();
  });
  current = sheet;
  return sheet;
}

export function closeSheet(): void {
  current?.close();
}

/** Asks first: true when the user said yes. */
export function confirmSheet(opts: { title: string; text: string; ok: string; icon?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const s = openSheet({ title: opts.title, icon: opts.icon, onClose: () => resolve(answer) });
    s.body.append(
      h('p', { class: 'ph-text', text: opts.text }),
      h('div', { class: 'ph-row ph-row-fill' }, [
        button('Cancel', { style: 'secondary', onclick: () => s.close() }),
        button(opts.ok, {
          style: opts.danger ? 'danger' : 'primary',
          onclick: () => {
            answer = true;
            s.close();
          },
        }),
      ]),
    );
  });
}

/** A small spinner. */
export function spinner(): HTMLElement {
  return h('span', { class: 'ph-spin', 'aria-hidden': 'true' });
}

/** Copies text, through the async clipboard where there is one. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'ph-offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Running as an app from the Home Screen (not in a Safari tab). */
export function standalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}
