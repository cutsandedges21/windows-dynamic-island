// First visit in Safari: Island belongs on the Home Screen. A Home Screen app keeps its own
// storage (Safari wipes a site's after 7 days unvisited, and the pairing with it) and is the
// only place iOS allows notifications from a website. "Use it in Safari anyway" goes on.

import { button, h, ico } from '../ui';

/** iOS's Share icon: a square with an arrow out of its top (static markup). */
const SHARE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="ico"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8.5 10.5H6.5a1.5 1.5 0 00-1.5 1.5v7.5A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V12a1.5 1.5 0 00-1.5-1.5h-2"/></svg>';
/** "Add to Home Screen": a rounded square with a plus. */
const ADD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="ico"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>';

export type Platform = 'ios' | 'android' | 'other';

export function platformOf(ua: string, touchPoints: number): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export function installScreen(root: HTMLElement, opts: { platform: Platform; fromCode: string | null; onContinue: () => void }): HTMLElement {
  const step = (n: number, html: string, text: string) =>
    h('li', { class: 'ph-step' }, [h('span', { class: 'ph-step-n', text: String(n) }), h('span', { class: 'ph-step-icon', html }), h('span', { class: 'ph-step-text', text })]);
  const steps =
    opts.platform === 'ios'
      ? [step(1, SHARE, 'Tap Share in Safari’s toolbar.'), step(2, ADD, 'Choose Add to Home Screen, then Add.'), step(3, '', 'Open Island from your Home Screen.')]
      : opts.platform === 'android'
        ? [step(1, '', 'Open your browser’s menu (⋮).'), step(2, ADD, 'Choose Add to Home screen or Install app.'), step(3, '', 'Open Island from your Home Screen.')]
        : [step(1, ADD, 'Add this page to your Home Screen from your browser’s menu.'), step(2, '', 'Open Island from there.')];
  const el = h('main', { class: 'ph-screen ph-install' }, [
    h('img', { class: 'ph-app-icon', src: './icons/icon-192.png', alt: '' }),
    h('h1', { class: 'ph-h1', text: 'Island on your phone' }),
    h('p', { class: 'ph-lead', text: 'Add it to your Home Screen first. There it keeps your pairing, and it can show notifications from your PC.' }),
    h('ol', { class: 'ph-steps' }, steps),
    opts.platform === 'ios' ? h('p', { class: 'ph-small', text: 'Needs iOS 16.4 or later.' }) : null,
    opts.fromCode
      ? h('p', { class: 'ph-callout' }, [ico('info'), h('span', { text: `Came from the code on ${opts.fromCode}? Scan it again from the Home Screen app: the app keeps its own storage, apart from Safari.` })])
      : null,
    h('div', { class: 'ph-actions' }, [button(opts.platform === 'ios' ? 'Use it in Safari anyway' : 'Use it here anyway', { style: 'ghost', onclick: () => opts.onContinue() })]),
  ]);
  root.append(el);
  return el;
}
