// The Activities page in a Mac's words. The catalog is written for Windows ("Windows Hello", "this
// PC"); on a Mac the same sentences name the Mac's own things. Only the Mac build loads this
// (vite.config.ts puts it in front of each page, after compat.ts); it rewrites the catalog's text
// once, before anything draws it.

import { CATALOG } from '../activities/catalog';

/** Most specific first: a longer phrase is changed before a shorter one inside it. */
const PHRASES: Array<[string, string]> = [
  ['Windows Hello to Allow', 'Touch ID to Allow'],
  ['Windows Hello', 'Touch ID'],
  ['Windows notification', 'Mac notification'],
  ['In Windows Terminal it counts only when that chat\'s tab is the one showing.', 'In Terminal and iTerm it counts only when that chat\'s tab is the one showing.'],
  ['Windows Terminal', 'Terminal'],
  ['through Windows media controls', "in the Mac's Now Playing"],
  ['Snipping Tool: drag an area', 'the screenshot toolbar'],
  ['and Windows notifies you, even if Island is closed', 'and the Mac notifies you, even if Island is closed'],
  ['Reads an iCal (ICS) link, or on Windows every calendar in your Windows accounts.', "Reads every calendar in this Mac's Calendar app, or an iCal (ICS) link."],
  ['My Windows accounts', "This Mac's calendars"],
  [
    'Windows accounts: every calendar you added in Windows Settings › Accounts (Outlook, Microsoft 365, Google, iCloud). Windows asks for calendar access the first time.',
    "This Mac's calendars: every calendar in the Calendar app (iCloud, Google, Exchange, Outlook). macOS asks for calendar access the first time.",
  ],
  [' On Windows, allow Island through the firewall on private networks the first time it asks.', ' If macOS asks whether Island may find devices on your network, allow it.'],
  ['It starts with the apps pinned to your taskbar; Edit adds any app from Start.', 'It starts with the apps in your Dock; Edit adds any app from Applications.'],
  ["codex.exe isn't on this PC", "Codex isn't on this Mac"],
  ['Alt+Shift+', 'Option+Shift+'],
  ['Ctrl+V', 'Control+V'],
  ['this PC', 'this Mac'],
  ['This PC', 'This Mac'],
  ['the PC', 'the Mac'],
  [' · taskbar ', ' · Dock '],
];

/** A sentence in a Mac's words. */
export function macWords(text: string): string {
  let out = text;
  for (const [from, to] of PHRASES) out = out.split(from).join(to);
  return out;
}

/** Rewrites the catalog's names, descriptions and options for a Mac, once. */
export function macCatalog(): void {
  for (const meta of CATALOG) {
    meta.description = macWords(meta.description);
    for (const o of meta.options) {
      o.label = macWords(o.label);
      if (o.help) o.help = macWords(o.help);
      if ('choices' in o && Array.isArray(o.choices)) for (const c of o.choices) c.label = macWords(c.label);
    }
  }
}

/** Words worth a second look: a text without any of them is left alone. */
const HINT = /Windows|PC\b|Alt\+|Ctrl\+|Snipping| · taskbar /;

/**
 * The Settings window's own text in a Mac's words, as its pages are drawn (they are built in code,
 * after this runs): each new text and placeholder goes through macWords once. The island's own
 * window (where chats and notes are shown) is left as it is.
 */
export function macPages(doc: Document): void {
  const fix = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.nodeValue ?? '';
      if (HINT.test(t)) {
        const m = macWords(t);
        if (m !== t) n.nodeValue = m;
      }
      return;
    }
    if (!(n instanceof Element)) return;
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = n.getAttribute(attr);
      if (v && HINT.test(v)) n.setAttribute(attr, macWords(v));
    }
    for (const child of Array.from(n.childNodes)) fix(child);
  };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') fix(m.target);
      else m.addedNodes.forEach(fix);
    }
  }).observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
}

macCatalog();
if (typeof document !== 'undefined' && /app\.html$/.test(location.pathname)) macPages(document);
