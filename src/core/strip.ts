// The strip: a slim row of numbers along the top of the screen while a full-screen app is in
// front (Games' frame rate, CPU, GPU, RAM, network and the time), for those who would rather
// not have the island over a game. It only shows; it never takes the mouse.

export type StripStyle = 'black' | 'glass' | 'bare';

export interface StripItem {
  key: string;
  /** Small and dim before the value ("FPS", "CPU"). */
  label?: string;
  value: string;
}

export interface StripView {
  style: StripStyle;
  items: StripItem[];
}

export class Strip {
  readonly el: HTMLElement;
  private sig = '';

  constructor(stage: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'strip';
    this.el.hidden = true;
    stage.append(this.el);
  }

  /** Shows `view` (null hides it). Items are kept by key, so a number changing never rebuilds the row. */
  show(view: StripView | null): void {
    if (!view || !view.items.length) {
      if (!this.el.hidden) this.el.hidden = true;
      this.sig = '';
      return;
    }
    const sig = JSON.stringify(view);
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.hidden = false;
    this.el.className = `strip strip-${view.style}`;
    const keyed = new Map<string, HTMLElement>();
    for (const c of Array.from(this.el.children) as HTMLElement[]) keyed.set(c.dataset.k ?? '', c);
    this.el.replaceChildren(
      ...view.items.map((it) => {
        let e = keyed.get(it.key);
        if (!e) {
          e = document.createElement('span');
          e.className = 'si';
          e.dataset.k = it.key;
          e.append(document.createElement('i'), document.createElement('b'));
        }
        e.children[0].textContent = it.label ?? '';
        (e.children[0] as HTMLElement).hidden = !it.label;
        e.children[1].textContent = it.value;
        return e;
      }),
    );
  }
}
