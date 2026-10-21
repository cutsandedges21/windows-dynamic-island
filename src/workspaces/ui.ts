// Small pieces the Workspaces page is built from: a workspace's icon tile, icon buttons, a
// pop-up menu, a yes/no box, toasts, keeping the caret through a redraw, and drag to reorder
// (a grid of cards or a list of items).

import { icon, type IconName } from '../core/icons';
import { springAnimate } from '../core/renderer';
import { springs } from '../core/spring';
import { h } from '../dom';
import { wsColor, type Workspace } from './model';

export function tile(ws: Pick<Workspace, 'icon' | 'color'>, accent: string, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  return h('span', { class: `ws-tile ${size}`, style: `--wc:${wsColor(ws, accent)}`, html: icon(ws.icon), 'aria-hidden': 'true' });
}

export function iconButton(ic: IconName, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${cls}`.trim(), type: 'button', title: label, 'aria-label': label, html: icon(ic), onclick });
}

/** A button with an icon before its words. */
export function labelled(ic: IconName, text: string, cls: string, onclick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', { class: `btn with-icon ${cls}`.trim(), type: 'button', html: icon(ic), onclick });
  b.append(h('span', { text }));
  return b;
}

// ------------------------------------------------------------------ menu

export interface MenuItem {
  label: string;
  icon: IconName;
  run: () => void;
  danger?: boolean;
  /** A line above this item. */
  sep?: boolean;
}

let menuEl: HTMLElement | null = null;
let menuAnchor: HTMLElement | null = null;
let menuOff: (() => void) | null = null;

export function closeMenu(refocus = false): void {
  if (!menuEl) return;
  menuEl.remove();
  menuOff?.();
  menuAnchor?.setAttribute('aria-expanded', 'false');
  if (refocus) menuAnchor?.focus();
  menuEl = menuAnchor = menuOff = null;
}

export function menuOpen(): boolean {
  return menuEl !== null;
}

/** A menu under (or over) `anchor`. Arrow keys move, Escape closes, a press elsewhere closes. */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  const reopen = menuAnchor === anchor;
  closeMenu();
  if (reopen) return;
  const menu = h('div', { class: 'ws-menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) menu.append(h('hr'));
    const b = h('button', { role: 'menuitem', type: 'button', class: it.danger ? 'danger' : '', html: icon(it.icon) });
    b.append(h('span', { text: it.label }));
    b.addEventListener('click', () => {
      closeMenu();
      it.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - m.width - 8, Math.max(8, r.right - m.width));
  let top = r.bottom + 4;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  springAnimate(menu, [{ opacity: 0, transform: 'scale(0.96) translateY(-4px)' }, { opacity: 1, transform: 'none' }], springs.snappy);
  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('button')];
  const key = (e: KeyboardEvent) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === 'Tab') closeMenu();
  };
  const press = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('keydown', key, true);
  document.addEventListener('pointerdown', press, true);
  window.addEventListener('blur', () => closeMenu(), { once: true });
  menuOff = () => {
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('pointerdown', press, true);
  };
  menuEl = menu;
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  buttons()[0]?.focus();
}

// ------------------------------------------------------------------ yes / no

export function boxOpen(): boolean {
  return document.querySelector('.ws-scrim') !== null;
}

/** A question over the page. Escape or a press outside is "no"; a dangerous yes starts on "no". */
export function confirmBox(o: { title: string; text: string; yes: string; no?: string; danger?: boolean }): Promise<boolean> {
  closeMenu();
  return new Promise((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const yes = h('button', { class: `btn ${o.danger ? 'danger' : 'primary'}`, type: 'button', text: o.yes });
    const no = h('button', { class: 'btn ghost', type: 'button', text: o.no ?? 'Cancel' });
    const title = h('h2', { id: 'ws-box-title', text: o.title });
    const box = h('div', { class: 'ws-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ws-box-title' }, [title, h('p', { text: o.text }), h('div', { class: 'ws-dialog-actions' }, [no, yes])]);
    const scrim = h('div', { class: 'ws-scrim' }, [box]);
    const done = (answer: boolean) => {
      document.removeEventListener('keydown', key, true);
      scrim.remove();
      before?.focus?.();
      resolve(answer);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === yes ? no : yes).focus();
      }
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) done(false);
    });
    // Not until the key press that opened the box (Escape: "throw away?") has been delivered,
    // or that same press would answer it at once.
    setTimeout(() => {
      if (scrim.isConnected) document.addEventListener('keydown', key, true);
    }, 0);
    document.body.append(scrim);
    springAnimate(box, [{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'none' }], springs.snappy);
    (o.danger ? no : yes).focus();
  });
}

// ------------------------------------------------------------------ picking from a list

export interface PickOption {
  key: string;
  title: string;
  detail?: string;
  icon?: IconName;
  /** Ticked when the box opens (several-choice lists). */
  on?: boolean;
}

/**
 * A box with a list to choose from: one (a click picks it) or several (ticks, then the button).
 * `load` may be slow (Start's app list); the box says so meanwhile. Null when cancelled.
 */
export function pickBox(o: { title: string; text?: string; several: boolean; yes?: string; empty?: string; extra?: { label: string; on: boolean }; load: () => Promise<PickOption[]> }): Promise<{ keys: string[]; extra: boolean } | null> {
  closeMenu();
  return new Promise((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const ticked = new Set<string>();
    let options: PickOption[] = [];
    let query = '';
    const search = h('input', { class: 'ws-input', type: 'search', placeholder: 'Search', spellcheck: 'false', 'aria-label': 'Search' });
    const list = h('div', { class: 'ws-pick-list', role: 'listbox', 'aria-multiselectable': String(o.several) }, [h('p', { class: 'muted', text: 'Loading…' })]);
    const yes = h('button', { class: 'btn primary', type: 'button', text: o.yes ?? 'Add' });
    const no = h('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });
    const extra = o.extra ? h('input', { type: 'checkbox', id: 'ws-pick-extra' }) : null;
    if (extra && o.extra?.on) extra.checked = true;
    const box = h('div', { class: 'ws-dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title }, [
      h('h2', { text: o.title }),
      o.text ? h('p', { text: o.text }) : null,
      search,
      list,
      h('div', { class: 'ws-dialog-actions' }, [
        extra ? h('label', { class: 'ws-pick-extra', for: 'ws-pick-extra' }, [extra, h('span', { text: o.extra!.label })]) : null,
        no,
        o.several ? yes : null,
      ]),
    ]);
    const scrim = h('div', { class: 'ws-scrim' }, [box]);
    const done = (keys: string[] | null) => {
      document.removeEventListener('keydown', key, true);
      scrim.remove();
      before?.focus?.();
      resolve(keys ? { keys, extra: Boolean(extra?.checked) } : null);
    };
    const paint = () => {
      const q = query.trim().toLowerCase();
      const shown = options.filter((p) => !q || `${p.title}\n${p.detail ?? ''}`.toLowerCase().includes(q));
      list.replaceChildren(
        ...(shown.length
          ? shown.slice(0, 300).map((p) => {
              const on = ticked.has(p.key);
              const row = h('button', { class: `ws-pick${on ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(on), title: p.detail ?? p.title }, [
                o.several ? h('span', { class: 'ws-pick-tick', html: icon('check') }) : null,
                p.icon ? h('span', { class: 'ws-kind', html: icon(p.icon) }) : null,
                h('span', { class: 'ws-pick-text' }, [h('b', { text: p.title }), p.detail ? h('span', { class: 'ws-mono', text: p.detail }) : null]),
              ]);
              row.addEventListener('click', () => {
                if (!o.several) return done([p.key]);
                if (ticked.has(p.key)) ticked.delete(p.key);
                else ticked.add(p.key);
                paint();
              });
              return row;
            })
          : [h('p', { class: 'muted', text: options.length ? 'Nothing matches.' : o.empty ?? 'Nothing here.' })]),
      );
      yes.disabled = !ticked.size;
      yes.textContent = ticked.size > 1 ? `${o.yes ?? 'Add'} ${ticked.size}` : o.yes ?? 'Add';
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
    search.addEventListener('input', () => {
      query = search.value;
      paint();
    });
    yes.addEventListener('click', () => done([...ticked]));
    no.addEventListener('click', () => done(null));
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) done(null);
    });
    setTimeout(() => scrim.isConnected && document.addEventListener('keydown', key, true), 0);
    document.body.append(scrim);
    springAnimate(box, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], springs.snappy);
    search.focus();
    void o.load().then((loaded) => {
      options = loaded;
      for (const p of loaded) if (p.on) ticked.add(p.key);
      if (scrim.isConnected) paint();
    });
  });
}

// ------------------------------------------------------------------ toasts

/** A line at the bottom of the window for a few seconds, with one action (Undo). */
export function toast(text: string, action?: { label: string; run: () => void }, ms = 6000): void {
  let host = document.querySelector<HTMLElement>('.ws-toasts');
  if (!host) {
    host = h('div', { class: 'ws-toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  while (host.children.length >= 3) host.firstElementChild!.remove();
  const el = h('div', { class: 'ws-toast', role: 'status' }, [h('span', { text })]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    const anim = springAnimate(el, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], springs.fade, { fill: 'forwards' });
    if (anim) anim.finished.then(() => el.remove(), () => el.remove());
    else el.remove();
  };
  if (action) {
    el.append(h('button', { class: 'btn sm', type: 'button', text: action.label, onclick: () => { close(); action.run(); } }));
  }
  host.append(el);
  springAnimate(el, [{ opacity: 0, transform: 'translateY(8px) scale(0.98)' }, { opacity: 1, transform: 'none' }], springs.snappy);
  timer = setTimeout(close, ms);
}

// ------------------------------------------------------------------ redraws

/**
 * Redraws with `paint`, then gives the focus (and the caret, and a text box's scroll) back to
 * the element with the same `data-focus` key, so a redraw never interrupts typing.
 */
export function keepFocus(paint: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active?.dataset?.focus;
  const typed = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  let range: [number | null, number | null] | null = null;
  try {
    if (typed) range = [typed.selectionStart, typed.selectionEnd];
  } catch {
    // Some input types (number) have no selection.
  }
  const scroll = typed?.scrollTop ?? 0;
  paint();
  if (!key) return;
  const next = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  if (!next || next === document.activeElement) return;
  next.focus({ preventScroll: true });
  if ((next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && range) {
    try {
      next.setSelectionRange(range[0], range[1]);
    } catch {
      // As above.
    }
    next.scrollTop = scroll;
  }
}

// ------------------------------------------------------------------ drag to reorder

export interface DragSort {
  /** The element whose children (each with data-id) are reordered. */
  container: HTMLElement;
  /** Only a press inside this starts a drag (default: anywhere on the item). */
  handle?: string;
  /** A press on these never starts one. */
  ignore?: string;
  /** The new order of the ids, once dropped somewhere else. */
  onDrop: (ids: string[], moved: string) => void;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p).overflowY;
    if ((s === 'auto' || s === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Press, move a few pixels and drag: the others make room as it passes, and it settles where it is let go. */
export function dragSort(o: DragSort): void {
  o.container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-id]');
    if (!item || item.parentElement !== o.container) return;
    if (o.handle && !target.closest(o.handle)) return;
    if (o.ignore && target.closest(o.ignore)) return;
    track(o, item, e);
  });
}

function track(o: DragSort, item: HTMLElement, down: PointerEvent): void {
  const sx = down.clientX;
  const sy = down.clientY;
  const items = () => [...o.container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.id !== undefined);
  const startIds = items().map((c) => c.dataset.id!);
  let ghost: HTMLElement | null = null;
  let home: DOMRect | null = null;
  const scroller = scrollParent(o.container);

  const begin = () => {
    home = item.getBoundingClientRect();
    ghost = item.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('data-id');
    ghost.querySelectorAll('[data-focus], [id]').forEach((n) => {
      n.removeAttribute('data-focus');
      n.removeAttribute('id');
    });
    ghost.classList.add('ws-ghost');
    Object.assign(ghost.style, { left: `${home.left}px`, top: `${home.top}px`, width: `${home.width}px`, height: `${home.height}px` });
    document.body.append(ghost);
    item.classList.add('drag-placeholder');
    document.body.classList.add('ws-dragging');
    springAnimate(ghost, [{ transform: 'none' }, { transform: 'scale(1.03)' }], springs.snappy, { fill: 'forwards' });
  };

  const move = (e: PointerEvent) => {
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!ghost) {
      if (Math.hypot(dx, dy) < 6) return;
      begin();
    }
    ghost!.getAnimations().forEach((a) => a.cancel());
    ghost!.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (e.clientY < r.top + 36) scroller.scrollBy(0, -14);
      else if (e.clientY > r.bottom - 36) scroller.scrollBy(0, 14);
    }
    const list = items();
    const over = list.find((el) => {
      if (el === item) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!over) return;
    const before = new Map(list.map((el) => [el, el.getBoundingClientRect()]));
    if (list.indexOf(over) > list.indexOf(item)) over.after(item);
    else over.before(item);
    for (const el of list) {
      if (el === item) continue;
      el.getAnimations().forEach((a) => a.cancel());
      const was = before.get(el)!;
      const now = el.getBoundingClientRect();
      const ddx = was.left - now.left;
      const ddy = was.top - now.top;
      if (Math.abs(ddx) < 0.5 && Math.abs(ddy) < 0.5) continue;
      springAnimate(el, [{ transform: `translate(${ddx}px, ${ddy}px)` }, { transform: 'none' }], springs.content);
    }
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!ghost || !home) return;
    // The click that ends a drag must not also open what was dragged.
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    const g = ghost;
    const at = item.getBoundingClientRect();
    const finish = () => {
      g.remove();
      item.classList.remove('drag-placeholder');
      document.body.classList.remove('ws-dragging');
      const ids = items().map((c) => c.dataset.id!);
      if (ids.join('\n') !== startIds.join('\n')) o.onDrop(ids, item.dataset.id!);
    };
    const anim = springAnimate(g, [{ transform: g.style.transform }, { transform: `translate(${at.left - home.left}px, ${at.top - home.top}px)` }], springs.content, { fill: 'forwards' });
    if (anim) anim.finished.then(finish, finish);
    else finish();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
