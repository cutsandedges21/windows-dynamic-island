// Where a tap on the phone's copy of the island goes. The island's renderers report every press
// as an action string: an activity's own (`act:<id>:<name>`) goes to the PC, which runs it as if
// it had been clicked there; the island's own (`island:*`) mostly stay on the phone, which keeps
// its own navigation (Control Center, a card). Grid arranging, hiding and moving the island,
// and opening windows on the PC never leave the phone. No DOM.

import { PHONE_ISLAND_ACTIONS, type PhoneMsg } from '../../../src/remote/protocol';

export type Route =
  /** Send it to the island: `{t:'act', action, arg}`. */
  | { to: 'island' }
  /** The pill itself was tapped: Control Center opens (or closes). */
  | { to: 'toggle' }
  /** Control Center ("+3 more", Back). */
  | { to: 'grid' }
  /** A chip: that activity's card. */
  | { to: 'card'; id: string }
  /** Something only the PC can do (open a window there, move or hide the island): say so. */
  | { to: 'pc-only' }
  /** Hover, focus and arranging chatter: nothing to do on a phone. */
  | { to: 'none' };

/** Island actions that do something on the PC only. */
const PC_ONLY = new Set(['island:app', 'island:anchor', 'island:hide', 'island:hide-menu']);

export function routeAction(action: string, arg: unknown): Route {
  if (action.startsWith('act:')) return { to: 'island' };
  if (PHONE_ISLAND_ACTIONS.includes(action)) return { to: 'island' };
  switch (action) {
    case 'island:tap':
      return { to: 'toggle' };
    case 'island:select':
      return typeof arg === 'string' && arg ? { to: 'card', id: arg } : { to: 'none' };
    case 'island:overflow':
    case 'island:back':
      return { to: 'grid' };
  }
  if (PC_ONLY.has(action)) return { to: 'pc-only' };
  // island:hover, hover-key, sheet-hover, sheet-engage, sheet-escape, wheel, menu, bot,
  // cancel-input, grid-* (arranging), and anything unknown.
  return { to: 'none' };
}

/** The line for a tap the island runs. */
export function actMsg(action: string, arg: unknown): PhoneMsg {
  return arg === undefined ? { t: 'act', action } : { t: 'act', action, arg };
}
