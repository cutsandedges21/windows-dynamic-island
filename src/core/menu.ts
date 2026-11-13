// The island's right-click menu: what it can hold, which of those the user keeps
// (Settings â€º Behavior â€º Right-click menu), and how long the pill gets for them.
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

/** Which items show just their icon (the name in a tip on hover) instead of icon and name. */
export type MenuIconOnly = Record<MenuItemId, boolean>;

/** As the menu always came: only Activities is a bare icon. */
export const DEFAULT_ICON_ONLY: MenuIconOnly = { position: false, quiet: false, hide: false, reminders: false, workspaces: false, activities: true };

/** As the menu always came: MENU_ITEMS' order. */
export const DEFAULT_MENU_ORDER: MenuItemId[] = MENU_ITEMS.map((m) => m.id);

/** How the user arranged the menu (Settings › Behavior › Right-click menu): their order, and which are icons only. */
export interface MenuLook {
  order: readonly MenuItemId[];
  iconOnly: MenuIconOnly;
}

export const DEFAULT_MENU_LOOK: MenuLook = { order: DEFAULT_MENU_ORDER, iconOnly: DEFAULT_ICON_ONLY };

/** A saved order made whole: known ids once each, in their saved order, then any missing ones in MENU_ITEMS' order. */
export function normalizeMenuOrder(saved: unknown): MenuItemId[] {
  const known = new Set<string>(DEFAULT_MENU_ORDER);
  const order = Array.isArray(saved) ? saved.filter((id): id is MenuItemId => typeof id === 'string' && known.has(id)) : [];
  for (const id of DEFAULT_MENU_ORDER) if (!order.includes(id)) order.push(id);
  return [...new Set(order)];
}

/** A saved icon-only choice made whole: true or false for every item, the default where it is missing. */
export function normalizeIconOnly(saved: unknown): MenuIconOnly {
  const out = { ...DEFAULT_ICON_ONLY };
  if (saved && typeof saved === 'object') for (const id of DEFAULT_MENU_ORDER) {
    const v = (saved as Record<string, unknown>)[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

/** Items that sit on the menu's far end (with Settings) when nothing but their own kind follows them. */
const END_KIND: ReadonlySet<MenuItemId> = new Set(['reminders', 'workspaces', 'activities']);

export interface MenuState {
  anchor: Anchor;
  /** Quiet (do not disturb) is on. */
  dnd: boolean;
  mac: boolean;
  /** The Reminders activity is on (its button opens its card). */
  reminders: boolean;
}

/**
 * The menu's segments: the items `shown` keeps, in `look`'s order, each as icon and name or icon only,
 * and Settings last. Reminders, Workspaces and Activities go to the far end with Settings when only
 * their own kind follows them (as they come); moved in front of the others they stay where they are put.
 */
export function menuSegments(shown: MenuShown, st: MenuState, look: MenuLook = DEFAULT_MENU_LOOK): Seg[] {
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
  const order = normalizeMenuOrder(look.order).filter((id) => shown[id] && (id !== 'reminders' || st.reminders));
  // The far end: the trailing run of Reminders / Workspaces / Activities.
  let firstEnd = order.length;
  while (firstEnd > 0 && END_KIND.has(order[firstEnd - 1])) firstEnd--;
  const segs: Seg[] = [];
  order.forEach((id, n) => {
    const bare = look.iconOnly[id];
    const side = n >= firstEnd ? ('end' as const) : undefined;
    /** A button's name: shown beside its icon, or only in the tip when it is a bare icon. */
    const named = (name: string, tip?: string) => (bare ? { tip: tip ?? name } : { label: name, ...(tip ? { tip } : {}) });
    switch (id) {
      case 'position':
        // A line parts Position from what comes before it too, when something does.
        if (segs.length > 0 && segs[segs.length - 1].t !== 'sep') segs.push({ t: 'sep', key: 'menu/sep-before' });
        if (!bare) segs.push({ t: 'text', key: 'menu/label', text: 'Position', tone: 'muted', size: 'sm', prio: 3 });
        segs.push(pos('top', 'pos-top', 'Top centre'), pos('right', 'pos-right', 'Right centre'), pos('bottom', 'pos-bottom', 'Bottom centre'), pos('left', 'pos-left', 'Left centre'));
        // The line parts Position from whatever follows it: Quiet and Hide, or the far end (Settings is always there).
        segs.push({ t: 'sep', key: 'menu/sep' });
        break;
      case 'quiet': {
        const tip = st.mac ? 'Quiet: the island stays small and its notifications wait' : 'Do not disturb, for Windows and the island: notifications wait and the island stays small';
        segs.push({ t: 'button', key: 'menu/dnd', icon: 'moon', ...named(st.dnd ? 'Quiet on' : 'Quiet', tip), style: st.dnd ? 'primary' : 'ghost', action: 'island:dnd', side, prio: 2 });
        break;
      }
      case 'hide':
        segs.push({ t: 'button', key: 'menu/hide', icon: 'eye-off', ...named('Hide', 'Hide the island for a while'), action: 'island:hide-menu', style: 'ghost', side, prio: 2 });
        break;
      case 'reminders':
        segs.push({ t: 'button', key: 'menu/reminders', icon: 'bell', ...named('Reminders', 'Reminders and notes'), action: 'island:reminders', side, style: 'secondary', prio: 1 });
        break;
      case 'workspaces':
        segs.push({ t: 'button', key: 'menu/workspaces', icon: 'grid', ...named('Workspaces'), action: 'island:app', arg: 'workspaces', side, style: 'secondary', prio: 1 });
        break;
      case 'activities':
        segs.push({ t: 'button', key: 'menu/activities', icon: 'pulse', ...named('Activities'), action: 'island:app', arg: 'activities', side, style: 'ghost', prio: 1 });
        break;
    }
  });
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
export function menuMain(shown: MenuShown, st: MenuState, pill: MenuPill, measure: Measure = measureText, look: MenuLook = DEFAULT_MENU_LOOK): number {
  const run = (segs: Seg[]) => (pill.vertical ? verticalRun(segs, pill.crossMax, measure) : naturalRun(segs, pill.cross, measure)) + pill.pad * 2;
  const segs = menuSegments(shown, st, look);
  // Settings and its neighbours sit on the far end; Position, Quiet and Hide on the near one. The
  // two ends get room between them, unless the near one ends in Position's line: that parts them.
  const near = segs.filter((x) => (x.side ?? 'start') === 'start');
  const split = near.length > 0 && near[near.length - 1].t !== 'sep' && segs.some((x) => x.side === 'end');
  return menuLength(pill.max, run(segs), split, pill.cross);
}
