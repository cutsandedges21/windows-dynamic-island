import { describe, expect, it } from 'vitest';
import { NAV_LEFT_MS, NAV_SETTLE_MS, NavKeeper, navMsg, sameNav } from '../phone/web/src/nav';
import { actMsg, routeAction } from '../phone/web/src/routing';
import { isTap, TAP_SLOP } from '../phone/web/src/tap';

describe('a tap on a button that moves (Back rides under a card that changes height)', () => {
  it('counts the finger, not where the button went', () => {
    expect(isTap({ x: 100, y: 400 }, { x: 102, y: 405 })).toBe(true);
    expect(isTap({ x: 100, y: 400 }, { x: 100, y: 400 + TAP_SLOP + 1 })).toBe(false);
  });
});

describe('where a tap on the phone goes', () => {
  it('sends activity actions and Quiet to the island', () => {
    expect(routeAction('act:music:toggle', undefined)).toEqual({ to: 'island' });
    expect(routeAction('act:claude:deny-with:req-1', 'stop')).toEqual({ to: 'island' });
    expect(routeAction('island:dnd', null)).toEqual({ to: 'island' });
    expect(actMsg('act:claude:allow', 'req-1')).toEqual({ t: 'act', action: 'act:claude:allow', arg: 'req-1' });
    expect(actMsg('act:music:next', undefined)).toEqual({ t: 'act', action: 'act:music:next' });
  });

  it('keeps the navigation on the phone', () => {
    expect(routeAction('island:tap', null)).toEqual({ to: 'toggle' });
    expect(routeAction('island:select', 'music')).toEqual({ to: 'card', id: 'music' });
    expect(routeAction('island:select', null)).toEqual({ to: 'none' });
    expect(routeAction('island:overflow', null)).toEqual({ to: 'grid' });
  });

  it('never arranges the grid, hides or moves the island, or opens windows from a phone', () => {
    for (const a of ['island:grid-edit', 'island:grid-move', 'island:grid-drop', 'island:grid-hide', 'island:sheet-engage', 'island:hover', 'island:hover-key', 'island:sheet-hover', 'island:menu', 'island:wheel', 'island:bot', 'whatever']) {
      expect(routeAction(a, null)).toEqual({ to: 'none' });
    }
    for (const a of ['island:app', 'island:anchor', 'island:hide', 'island:hide-menu']) expect(routeAction(a, 'x')).toEqual({ to: 'pc-only' });
  });
});

describe("the phone's navigation", () => {
  it('asks with the width it has', () => {
    expect(navMsg({ open: 'grid' }, 374.4)).toEqual({ t: 'nav', open: 'grid', width: 374 });
    expect(navMsg({ open: 'card', id: 'claude' }, 50)).toEqual({ t: 'nav', open: 'card', id: 'claude', width: 200 });
    expect(navMsg({ open: 'none' })).toEqual({ t: 'nav', open: 'none' });
    expect(sameNav({ open: 'card', id: 'a' }, { open: 'card', id: 'b' })).toBe(false);
  });

  it('toggles Control Center from the pill and goes back from a card', () => {
    const n = new NavKeeper();
    expect(n.want).toEqual({ open: 'grid' });
    expect(n.toggle(0)).toEqual({ open: 'none' });
    expect(n.toggle(0)).toEqual({ open: 'grid' });
    n.go({ open: 'card', id: 'music' }, 0);
    expect(n.back(0)).toEqual({ open: 'grid' });
  });

  it('drops views that answer an older ask, until the answer comes or it waited long enough', () => {
    const n = new NavKeeper({ open: 'grid' });
    n.go({ open: 'card', id: 'music' }, 1000);
    expect(n.waiting).toBe(true);
    expect(n.accept({ open: 'grid' }, 1100)).toBe(false);
    expect(n.accept({ open: 'card', id: 'music' }, 1200)).toBe(true);
    expect(n.waiting).toBe(false);
    n.go({ open: 'none' }, 2000);
    expect(n.accept({ open: 'card', id: 'timer' }, 2000 + NAV_SETTLE_MS + 1)).toBe(true);
    expect(n.want).toEqual({ open: 'card', id: 'timer' });
  });

  it('keeps Control Center after Back while the card it left keeps streaming in late', () => {
    // The bug: Back from Claude's card, the answer slow to come, and the card's next meter update
    // (sent before the island read the Back) put the card back once NAV_SETTLE_MS had passed.
    const n = new NavKeeper({ open: 'grid' });
    n.go({ open: 'card', id: 'claude' }, 0);
    expect(n.accept({ open: 'card', id: 'claude' }, 100)).toBe(true);
    n.back(1000);
    expect(n.accept({ open: 'card', id: 'claude' }, 1200)).toBe(false);
    expect(n.accept({ open: 'card', id: 'claude' }, 1000 + NAV_SETTLE_MS + 500)).toBe(false);
    expect(n.want).toEqual({ open: 'grid' });
    // Unanswered that long: the phone asks again, and still keeps the card away.
    expect(n.overdue(1000 + NAV_SETTLE_MS + 500)).toBe(true);
    expect(n.resend(1000 + NAV_SETTLE_MS + 500)).toEqual({ open: 'grid' });
    expect(n.overdue(1000 + NAV_SETTLE_MS + 600)).toBe(false);
    expect(n.accept({ open: 'card', id: 'claude' }, 1000 + NAV_SETTLE_MS * 2 + 600)).toBe(false);
    expect(n.accept({ open: 'grid' }, 1000 + NAV_SETTLE_MS * 2 + 700)).toBe(true);
    expect(n.waiting).toBe(false);
    // Answered, the island's word goes again (an action can open its card here).
    expect(n.accept({ open: 'card', id: 'claude' }, 9000)).toBe(true);
  });

  it('lets the card it left back in only if the island keeps saying so for a long time', () => {
    const n = new NavKeeper({ open: 'grid' });
    n.go({ open: 'card', id: 'music' }, 0);
    n.accept({ open: 'card', id: 'music' }, 10);
    n.back(100);
    expect(n.accept({ open: 'card', id: 'music' }, 100 + NAV_LEFT_MS - 1)).toBe(false);
    expect(n.accept({ open: 'card', id: 'music' }, 100 + NAV_LEFT_MS + 1)).toBe(true);
  });

  it('Home always asks for Control Center, even when it is already showing', () => {
    const n = new NavKeeper();
    expect(n.back(0)).toEqual({ open: 'grid' });
    expect(n.waiting).toBe(true);
    expect(n.accept({ open: 'grid' }, 10)).toBe(true);
  });

  it('follows the island when nothing is pending (an action opened a card on this phone)', () => {
    const n = new NavKeeper();
    expect(n.accept({ open: 'card', id: 'claude' }, 0)).toBe(true);
    expect(n.want).toEqual({ open: 'card', id: 'claude' });
    expect(n.resend(5)).toEqual({ open: 'card', id: 'claude' });
    expect(n.waiting).toBe(true);
  });
});
