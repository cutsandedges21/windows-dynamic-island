// VisibilityGate: tells an animation whether anyone can see it right now.
//
// "Open" means the element is attached to the document, on screen (IntersectionObserver, which
// also reports display:none and clipped-away ancestors, and fires again on re-attach) and the
// page is not hidden. An animation draws only while the gate is open and is woken by onChange
// when it opens, so an island that is collapsed or minimised costs nothing.

export class VisibilityGate {
  private intersecting = true;
  private lastOpen: boolean;
  private readonly observer: IntersectionObserver | null;

  constructor(
    private readonly element: Element,
    private readonly onChange: (open: boolean) => void,
  ) {
    this.lastOpen = this.open;
    document.addEventListener('visibilitychange', this.update);
    this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(this.onIntersect) : null;
    this.observer?.observe(element);
  }

  /** Checked synchronously, so a frame callback can bail out the moment the element goes away. */
  get open(): boolean {
    return this.element.isConnected && this.intersecting && !document.hidden;
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.update);
    this.observer?.disconnect();
  }

  private readonly onIntersect = (entries: IntersectionObserverEntry[]): void => {
    const latest = entries[entries.length - 1];
    if (latest) this.intersecting = latest.isIntersecting;
    this.update();
  };

  private readonly update = (): void => {
    const open = this.open;
    if (open === this.lastOpen) return;
    this.lastOpen = open;
    this.onChange(open);
  };
}
