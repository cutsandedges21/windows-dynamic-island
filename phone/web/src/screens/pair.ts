// Pairing: scan the code Island shows on the PC (Settings › Your phone › Pair a phone), or paste
// its link. A code that came in the page's address asks first ("Pair with MossLaptop?"): a link
// from anywhere must not pair the phone by itself.

import type { PairPayload } from '../../../../src/remote/protocol';
import type { SavedIsland } from '../link/api';
import { WHERE_PAIR, readPairInput } from '../pairing';
import { button, h, ico, spinner, standalone } from '../ui';
import { scan } from './scanner';

export interface PairHooks {
  /** Pairs and opens the island; rejects with the words to show. */
  pair(p: PairPayload): Promise<void>;
  /** Islands paired already (to go back to one). */
  saved: SavedIsland[];
  open(id: string): void;
  demo: boolean;
}

export interface PairOptions {
  /** A code from the page's address, to confirm. */
  pending?: PairPayload | null;
  /** Shown at the top: why the phone is back here ("MossLaptop removed this phone"). */
  reason?: string | null;
}

export class PairScreen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private busy = false;

  constructor(
    root: HTMLElement,
    private readonly hooks: PairHooks,
    opts: PairOptions = {},
  ) {
    this.error = h('p', { class: 'ph-error', role: 'alert' });
    this.body = h('div', { class: 'ph-pair-body' });
    this.el = h('main', { class: 'ph-screen ph-pair' }, [
      h('img', { class: 'ph-app-icon small', src: './icons/icon-192.png', alt: '' }),
      h('h1', { class: 'ph-h1', text: 'Pair with your PC' }),
      opts.reason ? h('p', { class: 'ph-callout' }, [ico('info'), h('span', { text: opts.reason })]) : null,
      this.body,
      this.error,
    ]);
    root.append(this.el);
    if (opts.pending) this.confirm(opts.pending);
    else this.choose();
  }

  private say(text: string): void {
    this.error.textContent = text;
  }

  /** Scan or paste. */
  private choose(): void {
    const paste = h('div', { class: 'ph-paste' });
    const scanBtn = button('Scan the code', { icon: 'screenshot', style: 'primary', cls: 'ph-big', onclick: () => void this.scan() });
    const pasteBtn = button('Paste a pairing link', {
      icon: 'link',
      style: 'secondary',
      cls: 'ph-big',
      onclick: () => {
        pasteBtn.hidden = true;
        this.pastePanel(paste);
      },
    });
    const saved = this.hooks.saved.length
      ? h('div', { class: 'ph-saved' }, [
          h('div', { class: 'ph-label', text: 'Paired already' }),
          ...this.hooks.saved.map((s) => {
            const b = h('button', { class: 'ph-saved-row', type: 'button' }, [ico('laptop'), h('span', { text: s.name }), ico('chevron-right')]);
            b.addEventListener('click', () => this.hooks.open(s.id));
            return b;
          }),
        ])
      : null;
    const parts: Array<HTMLElement | null> = [
      h('p', { class: 'ph-lead', text: `On your PC, open Island's ${WHERE_PAIR}. Then scan the code it shows.` }),
      scanBtn,
      pasteBtn,
      paste,
      this.hooks.demo ? button('Use a demo code', { icon: 'spark', style: 'ghost', onclick: () => this.confirm(demoPair()) }) : null,
      !standalone() && !this.hooks.demo ? h('p', { class: 'ph-small', text: 'Tip: pair from the Home Screen app. A pairing made in a Safari tab is lost when Safari clears the site.' }) : null,
      saved,
    ];
    this.body.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
  }

  private pastePanel(host: HTMLElement): void {
    const ta = h('textarea', { class: 'ph-textarea', rows: '3', placeholder: 'https://…/#pair=…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
    const go = () => {
      const r = readPairInput(ta.value);
      if (!r.ok) return this.say(r.error);
      this.say('');
      void this.run(r.pair);
    };
    const fromClipboard = button('Paste', {
      icon: 'clipboard',
      style: 'ghost',
      onclick: async () => {
        try {
          ta.value = await navigator.clipboard.readText();
          go();
        } catch {
          ta.focus();
        }
      },
    });
    host.replaceChildren(ta, h('div', { class: 'ph-row' }, [fromClipboard, button('Pair', { icon: 'check', style: 'primary', onclick: go })]));
    ta.focus();
  }

  private async scan(): Promise<void> {
    this.say('');
    const p = await scan((text) => this.say(text));
    if (p) await this.run(p);
  }

  /** A code from the address (or the demo): ask first. */
  private confirm(p: PairPayload): void {
    this.say('');
    this.body.replaceChildren(
      h('div', { class: 'ph-confirm' }, [
        ico('laptop', 'ph-confirm-icon'),
        h('div', { class: 'ph-confirm-name', text: p.name || 'Your PC' }),
        h('p', { class: 'ph-text', text: `Pair this phone with ${p.name || 'this PC'}? You'll see its island here and can press its buttons.` }),
        h('div', { class: 'ph-row ph-row-fill' }, [button('Not now', { style: 'secondary', onclick: () => this.choose() }), button('Pair', { icon: 'check', style: 'primary', onclick: () => void this.run(p) })]),
      ]),
    );
  }

  private async run(p: PairPayload): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('');
    this.body.replaceChildren(h('div', { class: 'ph-pairing' }, [spinner(), h('span', { text: `Pairing with ${p.name || 'your PC'}…` })]));
    try {
      await this.hooks.pair(p);
    } catch (err) {
      this.busy = false;
      this.choose();
      this.say(err instanceof Error ? err.message : String(err));
      return;
    }
    this.busy = false;
  }

  destroy(): void {
    this.el.remove();
  }
}

/** A well-formed code for the demo's pretend PC. */
function demoPair(): PairPayload {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return { v: 1, id: 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0', relays: ['https://use1-1.relay.n0.iroh.iroh.link/'], code: hex, name: 'MossLaptop' };
}

