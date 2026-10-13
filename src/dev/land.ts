// Browser preview only: Land's card after a drop (/?land), files being dragged over the pill
// (/?land=drag), an offer from a computer nearby (/?land=ask), or a send going (/?land=send).

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
  if (mode === 'drag') {
    inner.onFileDrop({ type: 'enter', paths: ['Trip'], x: 0, y: 0 });
    return;
  }
  inner.onFileDrop({ type: 'drop', paths: ['Trip', 'itinerary.pdf', 'boarding-pass.png'], x: 0, y: 0 });
  if (mode === 'send') {
    await sleep(400);
    await land.action?.('pick', 'a1b2c3d4e5f60718');
    await land.action?.('send');
    island.schedule();
  }
}
