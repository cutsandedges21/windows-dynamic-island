// Clipboard (phase 2): what is on the PC's clipboard, to copy onto this phone.

import type { Link } from '../link/api';
import { button, copyText, h, openSheet, spinner, toast, type PhSheet } from '../ui';

export class ClipSheet {
  private readonly sheet: PhSheet;
  private readonly box: HTMLElement;
  private open = true;

  constructor(
    private readonly link: Link,
    private readonly pc: string,
  ) {
    this.sheet = openSheet({ title: `${pc}'s clipboard`, icon: 'clipboard', onClose: () => (this.open = false) });
    this.box = h('div', { class: 'ph-clip' });
    this.sheet.body.append(this.box);
    this.ask();
  }

  get alive(): boolean {
    return this.open;
  }

  private ask(): void {
    if (!this.link.send({ t: 'clip-get' })) {
      this.box.replaceChildren(h('p', { class: 'ph-text', text: 'Not connected.' }));
      return;
    }
    this.box.replaceChildren(h('div', { class: 'ph-pairing' }, [spinner(), h('span', { text: `Asking ${this.pc}…` })]));
  }

  /** The PC's answer (`{t:'clip'}`). */
  show(text: string): void {
    if (!this.open) return;
    const again = button('Refresh', { icon: 'refresh', style: 'ghost', onclick: () => this.ask() });
    if (!text) {
      this.box.replaceChildren(h('p', { class: 'ph-text', text: 'Nothing to copy: the clipboard is empty or holds no text (a picture or files).' }), h('div', { class: 'ph-row' }, [again]));
      return;
    }
    this.box.replaceChildren(
      h('div', { class: 'ph-clip-text', text }),
      h('div', { class: 'ph-row' }, [
        again,
        button('Copy to this phone', {
          icon: 'copy',
          style: 'primary',
          onclick: async () => {
            const ok = await copyText(text);
            toast(ok ? 'Copied' : "Couldn't copy", ok ? 'good' : 'bad');
            if (ok) this.sheet.close();
          },
        }),
      ]),
    );
  }
}
