// Scrolling the pill switches activity: one scroll gesture moves one activity.
// A touchpad sends dozens of small events per flick, then a zero when the finger
// lifts, then keeps coasting for seconds with deltas as big as the flick's own.
// The flick adds up until it is clearly meant, switches once, and the rest of it,
// coast included, is ignored. A new flick still switches right away: turning
// back, a pause, or a finger touching down again (which stops the coast).

/** How far one scroll gesture has to go before it switches activity, in px (a wheel notch is ~100). */
const WHEEL_PX = 50;
/** A pause this long ends the gesture. */
const WHEEL_QUIET_MS = 200;
/** While coasting, events come every frame; a gap this long means a finger stopped it to flick again. */
const COAST_GAP_MS = 60;
/**
 * A coast only slows down: an event this many times the one before, this long after the finger
 * lifted and at least COAST_KICK_PX, is a new flick that started without the coast stopping first
 * (Justin's quick swipes, one after another, were lost). Just after the lift the coast's own first
 * events jump up, so it waits that long.
 */
const COAST_KICK = 2;
const COAST_KICK_PX = 12;
const COAST_SETTLE_MS = 90;

export class WheelGesture {
  private at = -Infinity;
  private sum = 0;
  private spent = false;
  /** The finger has lifted: what follows is the touchpad coasting. */
  private coasting = false;
  private liftedAt = 0;
  private last = 0;

  /** Feeds one wheel event (px, signed); -1 or 1 when it switches that way, else 0. */
  step(delta: number, now: number): -1 | 0 | 1 {
    const gap = now - this.at;
    this.at = now;
    if (gap > (this.coasting ? COAST_GAP_MS : WHEEL_QUIET_MS)) this.reset();
    if (!delta) {
      if (this.sum && !this.coasting) {
        this.coasting = true;
        this.liftedAt = now;
      }
      return 0;
    }
    const size = Math.abs(delta);
    const kicked = this.coasting && now - this.liftedAt > COAST_SETTLE_MS && size >= COAST_KICK_PX && size >= this.last * COAST_KICK;
    this.last = size;
    if (kicked) this.reset();
    // Coasting never turns back, so turning back is always a new scroll.
    if (this.sum && Math.sign(delta) !== Math.sign(this.sum)) this.reset();
    if (this.spent) return 0;
    this.sum += delta;
    if (Math.abs(this.sum) < WHEEL_PX) return 0;
    this.spent = true;
    return Math.sign(this.sum) as -1 | 1;
  }

  private reset(): void {
    this.sum = 0;
    this.spent = false;
    this.coasting = false;
  }
}
