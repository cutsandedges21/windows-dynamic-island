// What the phone shows under its pill (Control Center, an activity's card, or nothing) and the
// bookkeeping between asking the island for it and the island's views arriving. The phone asks
// with `{t:'nav'}`; every `{t:'view'}` carries the nav the island has for this phone. A view that
// answers an older nav (it was on its way when the user tapped) is dropped until the answer to
// the new one arrives or NAV_SETTLE_MS pass. With nothing pending the island's word wins: an
// action pressed on the phone can open its card there. No DOM.

import type { Nav, PhoneMsg } from '../../../src/remote/protocol';

/** How long a nav waits for its answer before the island's word goes again. */
export const NAV_SETTLE_MS = 2500;

export function sameNav(a: Nav, b: Nav): boolean {
  if (a.open !== b.open) return false;
  return a.open !== 'card' || (b.open === 'card' && a.id === b.id);
}

/** The line that asks for `nav`, with the width the phone has for a card (CSS px). */
export function navMsg(nav: Nav, width?: number): PhoneMsg {
  const w = width !== undefined && Number.isFinite(width) ? Math.round(Math.max(200, Math.min(2000, width))) : undefined;
  if (nav.open === 'card') return w === undefined ? { t: 'nav', open: 'card', id: nav.id } : { t: 'nav', open: 'card', id: nav.id, width: w };
  return w === undefined ? { t: 'nav', open: nav.open } : { t: 'nav', open: nav.open, width: w };
}

export class NavKeeper {
  private wanted: Nav;
  private pending: { nav: Nav; at: number } | null = null;

  /** Control Center by default: a phone is opened to do something. */
  constructor(initial: Nav = { open: 'grid' }) {
    this.wanted = initial;
  }

  /** What the phone shows (or is waiting to show). */
  get want(): Nav {
    return this.wanted;
  }

  /** Waiting for the island to answer a nav. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** The user asked for `nav`; the caller sends it. */
  go(nav: Nav, now: number): Nav {
    this.wanted = nav;
    this.pending = { nav, at: now };
    return nav;
  }

  /** A tap on the pill: Control Center, or closed again when it is showing. */
  toggle(now: number): Nav {
    return this.go(this.wanted.open === 'grid' ? { open: 'none' } : { open: 'grid' }, now);
  }

  /** Back from a card. */
  back(now: number): Nav {
    return this.go({ open: 'grid' }, now);
  }

  /** After (re)connecting: the island starts afresh, so the phone says again what it shows. */
  resend(now: number): Nav {
    this.pending = { nav: this.wanted, at: now };
    return this.wanted;
  }

  /**
   * A view arrived for `nav`. True: draw it (and `want` follows the island). False: it answers
   * an older nav; keep what is on screen.
   */
  accept(nav: Nav, now: number): boolean {
    if (this.pending) {
      if (sameNav(nav, this.pending.nav)) {
        this.pending = null;
        this.wanted = nav;
        return true;
      }
      if (now - this.pending.at < NAV_SETTLE_MS) return false;
      this.pending = null;
    }
    this.wanted = nav;
    return true;
  }
}
