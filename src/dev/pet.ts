// Browser preview only (open /?pet): every mood and every moment of the bot side by side, bigger
// than life and labelled, the moments replaying every few seconds. For checking the costumes,
// faces and motions by eye or by screenshot.

import { BubbleView } from '../core/bubble';
import { MOMENT_LOOKS, MOOD_LOOKS } from '../core/looks';
import { MOMENT_MS, MOOD_ORDER, type MomentId } from '../core/pet';

const SIZE = 64;
const CELL = 112;
const COLS = 12;

export function petPreview(accent = '#6aa6e8'): void {
  document.body.classList.add('pet-preview');
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.append(stage);
  const entries: Array<{ label: string; replay: boolean; look: (typeof MOOD_LOOKS)[keyof typeof MOOD_LOOKS] }> = [
    ...MOOD_ORDER.map((m) => ({ label: m, replay: false, look: MOOD_LOOKS[m] })),
    ...(Object.keys(MOMENT_MS) as MomentId[]).map((m) => ({ label: m, replay: true, look: MOMENT_LOOKS[m] })),
  ];
  let play = 1;
  const views = entries.map((e, i) => {
    const x = 24 + (i % COLS) * CELL;
    const y = 40 + Math.floor(i / COLS) * CELL;
    const view = new BubbleView(stage, { interactive: false });
    view.colour(accent);
    view.place({ x, y, w: SIZE, h: SIZE }, { immediate: true });
    view.show(e.look, play);
    const label = document.createElement('div');
    label.textContent = e.label;
    label.style.cssText = `position:fixed;left:${x - 20}px;top:${y + SIZE + 6}px;width:${SIZE + 40}px;text-align:center;font:500 11px var(--font);color:#c8ccd4`;
    stage.append(label);
    return { view, e };
  });
  setInterval(() => {
    play += 1;
    for (const { view, e } of views) if (e.replay) view.show(e.look, play);
  }, 3000);
}
