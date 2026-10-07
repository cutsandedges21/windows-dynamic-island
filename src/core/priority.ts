// The priority manager: given what every activity reports, decide which one the
// island is about right now. Pure functions, so the rules are easy to test.
//
// 1. An urgent activity whose Interrupt behaviour is on takes the island.
// 2. Else an activity the user picked (chip, wheel) keeps it while visible.
// 3. Else the newest surfaced event (music started, download finished…).
// 4. Else the best-ranked persistent activity: happening-now beats quiet,
//    then High > Medium > Low, then the user's order in the Activities page.

import type { ActivityStatus } from './activity';
import type { Level } from './layout';
import type { ActivityConfig } from './settings';

export const BAND_SCORE = { high: 3, medium: 2, low: 1 } as const;

export interface Candidate {
  id: string;
  status: ActivityStatus;
  config: ActivityConfig;
  /** Position in the user's order (0 = top). */
  order: number;
}

export interface Surface {
  id: string;
  key: string;
  until: number;
  level: Level;
  at: number;
}

export interface Choice {
  primary: string | null;
  /** Key of the surface that made `primary` show, if that is the reason. */
  surfaced: string | null;
  urgent: boolean;
  /** Activities that may show (primary first, then by rank). */
  visible: string[];
}

export function rankOf(c: Candidate): number {
  return (c.status.weight === 'background' ? 0 : 10000) + BAND_SCORE[c.config.priority] * 1000 - c.order;
}

export function choosePrimary(
  candidates: Candidate[],
  opts: { selected: string | null; surfaces: Surface[]; now: number; dnd: boolean },
): Choice {
  const live = candidates.filter((c) => c.config.enabled && c.status.active);
  const byRank = [...live].sort((a, b) => rankOf(b) - rankOf(a));
  const surfaces = opts.dnd ? [] : opts.surfaces.filter((s) => s.until > opts.now && live.some((c) => c.id === s.id));
  const surfacedIds = new Set(surfaces.map((s) => s.id));
  // Busy activities that are not persistent still show, as a chip beside the pill's
  // own content; only persistent ones (or events, urgency, a pick) take the pill itself.
  const visible = byRank.filter(
    (c) => c.config.persistent || surfacedIds.has(c.id) || (c.status.urgent && c.config.interrupt) || c.status.weight === 'foreground',
  );

  const urgent = byRank.find((c) => c.status.urgent && c.config.interrupt);
  if (urgent) return { primary: urgent.id, surfaced: null, urgent: true, visible: order(visible, urgent.id) };

  if (opts.selected && visible.some((c) => c.id === opts.selected)) {
    return { primary: opts.selected, surfaced: null, urgent: false, visible: order(visible, opts.selected) };
  }
  const newest = [...surfaces].sort((a, b) => b.at - a.at)[0];
  if (newest) return { primary: newest.id, surfaced: newest.key, urgent: false, visible: order(visible, newest.id) };

  const top = visible.find((c) => c.config.persistent);
  return { primary: top?.id ?? null, surfaced: null, urgent: false, visible: order(visible, top?.id ?? null) };
}

function order(list: Candidate[], first: string | null): string[] {
  const ids = list.map((c) => c.id);
  if (!first) return ids;
  return [first, ...ids.filter((id) => id !== first)];
}
