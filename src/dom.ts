// A tiny element builder for the Activities window's pages (src/app.ts, src/welcome.ts,
// src/models-ui.ts). Plain DOM, no framework.

export type Props = Record<string, unknown> & { class?: string; text?: string; html?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, kids: Array<Node | string | null | false | undefined> = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v); // static icon markup only
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
