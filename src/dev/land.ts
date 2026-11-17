// Browser preview only: Land's card after a drop (/?land), files being dragged over the pill
// (/?land=drag, the Shelf side lit: /?land=drag-shelf), dropped on the Shelf (/?land=shelf), the Shelf's circle
// (/?land=circle), an offer from a computer nearby (/?land=ask), or a send going (/?land=send).

import type { Activity } from '../core/activity';
import type { Island } from '../core/island';
import type { FileDrop, native as Native } from '../core/native';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function landPreview(island: Island, native: typeof Native, mode: string): Promise<void> {
  const sizes = [48_200_000, 2_300_000, 640_000];
  Object.assign(native as unknown as Record<string, unknown>, {
    landStage: async (paths: string[]) => paths.map((p, i) => ({ path: p, name: p, size: sizes[i % 3], dir: i === 0, files: i === 0 ? 37 : 1, error: null })),
  });
  await sleep(700);
  const inner = island as unknown as { onFileDrop(e: FileDrop): void; running: Map<string, Activity & { demoOffer?(): void; action?(n: string, a?: unknown): unknown }> };
  const land = inner.running.get('land');
  if (!land) return;
  if (mode === 'ask') {
    land.demoOffer?.();
    island.schedule();
    return;
  }
  const files = ['Trip', 'itinerary.pdf', 'boarding-pass.png'];
  // Files dragged over the island open the drop card; then the pointer goes over one side.
  inner.onFileDrop({ type: 'enter', paths: files, x: 0, y: 0 });
  await sleep(600);
  const side = mode === 'shelf' || mode === 'drag-shelf' ? 'shelf' : 'land';
  const zone = document.querySelector<HTMLElement>(`[data-zone="${side}"]`)?.getBoundingClientRect();
  const at = zone ? { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 } : { x: 0, y: 0 };
  // A real drag reports the pointer all the time; the card may still be growing at the first one.
  for (let i = 0; i < 4; i++, await sleep(250)) {
    const r = document.querySelector<HTMLElement>(`[data-zone="${side}"]`)?.getBoundingClientRect();
    if (r) Object.assign(at, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
    inner.onFileDrop({ type: 'over', ...at });
  }
  if (mode === 'drag' || mode === 'drag-shelf') return;
  await sleep(300);
  inner.onFileDrop({ type: 'drop', paths: files, ...at });
  if (mode === 'circle') {
    // The Shelf's circle: files on the Shelf, its card closed.
    await sleep(300);
    inner.running.get('shelf')?.drop?.(files);
    (island as unknown as { dismiss(): void }).dismiss();
    island.schedule();
    return;
  }
  if (mode === 'send') {
    await sleep(400);
    await land.action?.('pick', 'a1b2c3d4e5f60718');
    await land.action?.('send');
    island.schedule();
  }
}
