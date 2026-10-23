// What the PC sends to the phone (phase 2): text or a link from Land's card, and files. Each
// arrives as a card above the bar: "From MossLaptop", Copy / Open for text, Save for a file
// (the iOS share sheet, where Save to Files and Photos live; else a download link).

import type { IncomingFile } from '../link/api';
import { fileSize, linkIn } from '../format';
import { button, copyText, h, ico, toast } from '../ui';

function card(host: HTMLElement, iconName: string, title: string, body: HTMLElement[], actions: HTMLElement[], onGone?: () => void): void {
  const close = h('button', { class: 'ph-inbox-x', type: 'button', 'aria-label': 'Dismiss' }, [ico('x')]);
  const el = h('div', { class: 'ph-inbox-card' }, [
    h('div', { class: 'ph-inbox-head' }, [ico(iconName, 'ph-inbox-icon'), h('span', { class: 'ph-inbox-title', text: title }), close]),
    ...body,
    h('div', { class: 'ph-row' }, actions),
  ]);
  const gone = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 240);
    onGone?.();
  };
  close.addEventListener('click', gone);
  for (const a of actions) a.addEventListener('click', () => setTimeout(gone, 400));
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();
  requestAnimationFrame(() => el.classList.add('in'));
}

export function inboxText(host: HTMLElement, text: string, from: string): void {
  const url = linkIn(text);
  const actions: HTMLElement[] = [
    button('Copy', {
      icon: 'copy',
      style: url ? 'secondary' : 'primary',
      onclick: async () => toast((await copyText(text)) ? 'Copied' : "Couldn't copy", 'good'),
    }),
  ];
  if (url) actions.push(button('Open', { icon: 'external', style: 'primary', onclick: () => window.open(url, '_blank', 'noopener') }));
  card(host, url ? 'link' : 'clipboard', `From ${from}`, [h('div', { class: 'ph-inbox-text', text })], actions);
}

export function inboxFile(host: HTMLElement, f: IncomingFile, from: string): void {
  const { name, mime } = f.header;
  const type = mime || f.blob.type || 'application/octet-stream';
  const file = new File([f.blob], name, { type });
  const url = URL.createObjectURL(f.blob);
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  let save: HTMLElement;
  if (nav.canShare?.({ files: [file] })) {
    save = button('Save', {
      icon: 'download',
      style: 'primary',
      onclick: () => {
        navigator.share({ files: [file] }).catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') toast("Couldn't open the share sheet", 'bad');
        });
      },
    });
  } else {
    save = h('a', { class: 'sbtn style-primary ph-btn', href: url, download: name }, [ico('download', 'bi'), h('span', { class: 'bl', text: 'Save' })]);
  }
  const body: HTMLElement[] = [];
  if (type.startsWith('image/')) body.push(h('img', { class: 'ph-inbox-img', src: url, alt: '' }));
  body.push(h('div', { class: 'ph-inbox-file' }, [h('span', { class: 'ph-inbox-name', text: name }), h('span', { class: 'ph-inbox-size', text: fileSize(f.header.size || f.blob.size) })]));
  card(host, type.startsWith('image/') ? 'image' : 'file', `From ${from}`, body, [save], () => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}
