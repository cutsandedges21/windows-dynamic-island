import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wheelDelta } from '../src/core/renderer';
import { WheelGesture } from '../src/core/wheel';

/** Feeds `gap:delta` events (ms since the last one, px), returning every switch. */
function run(w: WheelGesture, events: string, start = 0): number[] {
  let now = start;
  const out: number[] = [];
  for (const e of events.trim().split(/\s+/)) {
    const [gap, delta] = e.split(':').map(Number);
    now += gap;
    const dir = w.step(delta, now);
    if (dir) out.push(dir);
  }
  return out;
}

/** Real flicks on the user's touchpad, logged from the island (one per line, 1 s apart). */
const [twoFlicks, hard, gentle, slowStart] = readFileSync(new URL('./wheel-touchpad.txt', import.meta.url), 'utf8').trim().split('\n');

describe('scrolling the pill', () => {
  it('a hard flick switches once, however long it coasts', () => {
    expect(run(new WheelGesture(), hard)).toEqual([-1]);
    expect(run(new WheelGesture(), slowStart)).toEqual([-1]);
  });

  it('a gentle flick switches once', () => {
    expect(run(new WheelGesture(), gentle)).toEqual([-1]);
  });

  it('a second flick that stops the first one coasting switches again', () => {
    expect(run(new WheelGesture(), twoFlicks)).toEqual([-1, -1]);
  });

  it('turning back switches back at once', () => {
    expect(run(new WheelGesture(), '0:-40 16:-40 16:0 1:-60 16:-50 16:30 16:40')).toEqual([-1, 1]);
  });

  it('a fast spin of a mouse wheel switches once; a notch after a pause switches again', () => {
    const w = new WheelGesture();
    expect(run(w, '0:100 40:100 40:100 40:100')).toEqual([1]);
    expect(w.step(100, 1000)).toBe(1);
  });

  it('a mouse that scrolls by lines switches on one notch, not two', () => {
    // Windows reports a notch as 3 lines (deltaMode 1); counted 40 px a line it is clearly meant.
    const notch = wheelDelta({ deltaY: 3, deltaX: 0, deltaMode: 1 } as WheelEvent);
    expect(notch).toBe(120);
    expect(new WheelGesture().step(notch, 0)).toBe(1);
    expect(wheelDelta({ deltaY: 0, deltaX: -1, deltaMode: 2 } as WheelEvent)).toBe(-400);
    expect(wheelDelta({ deltaY: -57, deltaX: 0, deltaMode: 0 } as WheelEvent)).toBe(-57);
  });
});
