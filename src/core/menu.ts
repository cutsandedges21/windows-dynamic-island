// The island's right-click menu: what it can hold, which of those the user keeps
// (Settings › Behavior › Right-click menu), and how long the pill gets for them.
// The pill is only as long as what it holds: whatever the user takes out, no hole is left.

import type { IconName } from './icons';
import type { Anchor } from './layout';
import { measureText, naturalRun, verticalRun, type Measure, type Seg } from './segments';

/** What the menu can hold besides Settings, which always stays: it leads back to this choice. */
export type MenuItemId = 'position' | 'quiet' | 'hide' | 'reminders' | 'workspaces' | 'activities';

/** Which of them the menu shows. */
export type MenuShown = Record<MenuItemId, boolean>;

/** In the order the menu shows them, named as Settings lists them. */
export const MENU_ITEMS: ReadonlyArray<{ id: MenuItemId; label: string }> = [
  { id: 'position', label: 'Position' },
  { id: 'quiet', label: 'Quiet' },
  { id: 'hide', label: 'Hide' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'activities', label: 'Activities' },
];

/** The whole menu, as it comes. */
export const FULL_MENU: MenuShown = { position: true, quiet: true, hide: true, reminders: true, workspaces: true, activities: true };

export interface MenuState {
  anchor: Anchor;
  /** Quiet (do not disturb) is on. */
  dnd: boolean;
  mac: boolean;
  /** The Reminders activity is on (its button opens its card). */
  reminders: boolean;
}

/** The menu's segments: the items `shown` keeps, each in its usual place, and Settings last. */
export function menuSegments(shown: MenuShown, st: MenuState): Seg[] {
  const pos = (anchor: Anchor, icon: IconName, tip: string): Seg => ({
    t: 'button',
    key: `menu/${anchor}`,
    icon,
    action: 'island:anchor',
    arg: anchor,
    style: st.anchor === anchor ? 'primary' : 'ghost',
    tip,
    prio: 1,
  });
  const segs: Seg[] = [];
  if (shown.position) {
    segs.push(
      { t: 'text', key: 'menu/label', text: 'Position', tone: 'muted', size: 'sm', prio: 3 },
      pos('top', 'pos-top', 'Top centre'),
      pos('right', 'pos-right', 'Right centre'),
      pos('bottom', 'pos-bottom', 'Bottom centre'),
      pos('left', 'pos-left', 'Left centre'),
    );
    // The line parts Position from whatever follows it: Quiet and Hide, or the far end (Settings is always there).
    segs.push({ t: 'sep', key: 'menu/sep' });
  }
  if (shown.quiet) {
    segs.push({
      t: 'button',
      key: 'menu/dnd',
      icon: 'moon',
      label: st.dnd ? 'Quiet on' : 'Quiet',
      style: st.dnd ? 'primary' : 'ghost',
      action: 'island:dnd',
      tip: st.mac ? 'Quiet: the island stays small and its notifications wait' : 'Do not disturb, for Windows and the island: notifications wait and the island stays small',
      prio: 2,
    });
  }
  if (shown.hide) segs.push({ t: 'button', key: 'menu/hide', icon: 'eye-off', label: 'Hide', action: 'island:hide-menu', style: 'ghost', tip: 'Hide the island for a while', prio: 2 });
  if (shown.reminders && st.reminders) segs.push({ t: 'button', key: 'menu/reminders', icon: 'bell', label: 'Reminders', action: 'island:reminders', side: 'end', style: 'secondary', tip: 'Reminders and notes', prio: 1 });
  if (shown.workspaces) segs.push({ t: 'button', key: 'menu/workspaces', icon: 'grid', label: 'Workspaces', action: 'island:app', arg: 'workspaces', side: 'end', style: 'secondary', prio: 1 });
  if (shown.activities) segs.push({ t: 'button', key: 'menu/activities', icon: 'pulse', label: 'Activities', action: 'island:app', arg: 'activities', side: 'end', style: 'secondary', prio: 1 });
  segs.push({ t: 'button', key: 'menu/settings', icon: 'settings', action: 'island:app', arg: 'settings', side: 'end', style: 'ghost', tip: 'Settings', prio: 1 });
  return segs;
}

/** Room between the menu's two ends on top of the usual gap between items, px: enough to read as two groups. */
export const MENU_SPLIT = 16;

/**
 * How long the menu pill is, px along it: just its items (`run`: laid end to end at their natural
 * size, gaps and the pill's padding included), plus MENU_SPLIT between its two ends when .
 * Never longer than `max` (the open island's length: past it the least important items
 * drop, as on any pill), never shorter than `min`.
 */
export function menuLength(max: number, run: number, split: boolean, min: number): number {
  return Math.round(Math.max(min, Math.min(max, run + (split ? MENU_SPLIT : 0))));
}

/** The pill the menu opens in: the open island's length and thickness, its padding at each end, the room across a vertical one. */
export interface MenuPill {
  max: number;
  cross: number;
  pad: number;
  vertical: boolean;
  crossMax: number;
}

/** menuLength for the items `shown` keeps, measured the way the pill lays them out. */
export function menuMain(shown: MenuShown, st: MenuState, pill: MenuPill, measure: Measure = measureText): number {
  const run = (segs: Seg[]) => (pill.vertical ? verticalRun(segs, pill.crossMax, measure) : naturalRun(segs, pill.cross, measure)) + pill.pad * 2;
  const segs = menuSegments(shown, st);
  // Settings and its neighbours sit on the far end; Position, Quiet and Hide on the near one. The
  // two ends get room between them, unless the near one ends in Position's line: that parts them.
  const near = segs.filter((x) => (x.side ?? 'start') === 'start');
  const split = near.length > 0 && near[near.length - 1].t !== 'sep' && segs.some((x) => x.side === 'end');
  return menuLength(pill.max, run(segs), split, pill.cross);
}
