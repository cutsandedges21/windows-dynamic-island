// A tap on a button that moves. The Back button rides under the card, and the card's height
// changes whenever a new view streams in (Claude's meters and chats, a live score), so the button
// can slide away between the finger going down and coming up: the browser then sends the click
// to whatever is under the finger by then, and the tap did nothing. A tap here is judged by the
// finger alone: down on the button, up again without travelling (a scroll is not a tap).

/** How far the finger may travel and still be a tap (CSS px). */
export const TAP_SLOP = 12;

export interface Point {
  x: number;
  y: number;
}

/** Down and up close enough together to be a tap, wherever the button went meanwhile. */
export function isTap(down: Point, up: Point, slop = TAP_SLOP): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop;
}

/** Runs `fn` on a tap that started on `el` (on the finger's way up), or on its click (keyboard, a mouse). */
export function onTap(el: HTMLElement, fn: () => void): void {
  let down: (Point & { id: number }) | null = null;
  let tapped = 0;
  el.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  // On the window: the button may no longer be under the finger when it comes up.
  window.addEventListener(
    'pointerup',
    (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || !isTap(d, { x: e.clientX, y: e.clientY })) return;
      tapped = Date.now();
      fn();
    },
    true,
  );
  window.addEventListener('pointercancel', () => (down = null), true);
  el.addEventListener('click', () => {
    // The click that follows a tap already handled.
    if (Date.now() - tapped < 800) return;
    fn();
  });
}
