// Quiet's moon: while Quiet (do not disturb) is on, a small moon sits at the end of the pill,
// like the iPhone's Focus icon, so Quiet is never left on unnoticed.

import type { Seg } from './segments';

/**
 * The pills that carry the moon, by the island's view key: an activity's pill, the idle pill,
 * lone chips and the open island. The menu lights its own Quiet button instead; the "+N" list,
 * Hide's choices, a file drop and the island's own note last a moment and are about something else.
 */
export function moonShows(viewKey: string): boolean {
  return viewKey.startsWith('act:') || viewKey === 'idle' || viewKey === 'chips' || viewKey === 'home';
}

/**
 * The moon for this pill, or nothing. `inMenu`: the right-click menu keeps its Quiet button
 * (Settings › Right-click menu can take it out), so the tip says where to turn Quiet off.
 */
export function quietMoon(dnd: boolean, viewKey: string, inMenu: boolean): Seg[] {
  if (!dnd || !moonShows(viewKey)) return [];
  const tip = inMenu ? 'Quiet is on: right-click the island to turn it off' : 'Quiet is on: turn it off in Settings, under Do not disturb';
  return [{ t: 'icon', key: 'island/quiet', icon: 'moon', tone: 'violet', size: 'sm', side: 'end', prio: 1, tip }];
}
