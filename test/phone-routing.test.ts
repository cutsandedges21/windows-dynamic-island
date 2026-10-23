import { describe, expect, it } from 'vitest';
import { NAV_SETTLE_MS, NavKeeper, navMsg, sameNav } from '../phone/web/src/nav';
import { actMsg, routeAction } from '../phone/web/src/routing';

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
    expect(n.accept({ open: 'card', id: 'music' }, 2000 + NAV_SETTLE_MS + 1)).toBe(true);
    expect(n.want).toEqual({ open: 'card', id: 'music' });
  });

  it('follows the island when nothing is pending (an action opened a card on this phone)', () => {
    const n = new NavKeeper();
    expect(n.accept({ open: 'card', id: 'claude' }, 0)).toBe(true);
    expect(n.want).toEqual({ open: 'card', id: 'claude' });
    expect(n.resend(5)).toEqual({ open: 'card', id: 'claude' });
    expect(n.waiting).toBe(true);
  });
});
