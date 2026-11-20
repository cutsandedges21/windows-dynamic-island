// The right-click menu's Fade: like tapping Ctrl over the island (it fades, clicks go through), but it
// stays that way until Show. Its own item, beside Moss's Hide, which is left as it is.

import { describe, expect, it } from 'vitest';
import { fadeSegments, fadeSheet } from '../src/core/fade-menu';
import { DEFAULT_ICON_ONLY, FULL_MENU, MENU_ITEMS, menuSegments, normalizeMenuOrder, type MenuState } from '../src/core/menu';
import type { Seg } from '../src/core/segments';
import { defaultSettings, HIDE_CHOICES, migrate } from '../src/core/settings';

const st: MenuState = { anchor: 'top', dnd: false, mac: false, reminders: true };
const fadeButton = (faded: boolean) => menuSegments(FULL_MENU, { ...st, faded }).find((x) => x.key === 'menu/fade') as Extract<Seg, { t: 'button' }>;

describe('the menu\'s Fade', () => {
  it('is its own item, right after Hide, shown with its name by default; Hide keeps its choices', () => {
    const ids = MENU_ITEMS.map((m) => m.id);
    expect(ids.indexOf('fade')).toBe(ids.indexOf('hide') + 1);
    expect(MENU_ITEMS.find((m) => m.id === 'fade')?.label).toBe('Fade');
    expect(FULL_MENU.fade).toBe(true);
    expect(DEFAULT_ICON_ONLY.fade).toBe(false);
    expect(HIDE_CHOICES.map((c) => c.id)).toEqual(['30m', '1h', '3h', 'morning', 'shown']);
  });

  it('says Fade while the island shows, and Show (eye, primary) while it is faded; both toggle it', () => {
    const off = fadeButton(false);
    expect(off.label).toBe('Fade');
    expect(off.icon).toBe('fade');
    expect(off.style).toBe('ghost');
    expect(off.tip).toBe('Fade the island now, or choose how it fades on its own');
    // Fade opens its card (fade now, Peek lasts, Smart fade); Show brings the island back at once.
    expect(off.action).toBe('island:fade-menu');
    const on = fadeButton(true);
    expect(on.label).toBe('Show');
    expect(on.icon).toBe('eye');
    expect(on.style).toBe('primary');
    expect(on.action).toBe('island:fade');
    // Unset (the Settings preview) reads as not faded.
    expect(menuSegments(FULL_MENU, st).find((x) => x.key === 'menu/fade')).toEqual(off);
  });

  it('opened, laid out like Hide: fade now, then Peek lasts and Smart fade, each one row with its two choices', () => {
    const v = fadeSheet({ faded: false, peekUntilBack: true, smartFade: false });
    expect(v.blocks.map((b) => b.key)).toEqual(['head', 'for']);
    const rows = (v.blocks[1] as Extract<(typeof v.blocks)[number], { t: 'choices' }>).items;
    expect(rows.map((r) => r.label)).toEqual(['Fade now', 'Peek lasts', 'Smart fade']);
    expect(rows[0]).toMatchObject({ action: 'island:fade' });
    expect(rows[1].options!.map((o) => [o.label, o.selected, o.action, o.arg])).toEqual([
      ['Until the pointer moves off', false, 'island:peek-lasts', 'off'],
      ['Until it comes back', true, 'island:peek-lasts', 'back'],
    ]);
    expect(rows[2].options!.map((o) => [o.label, o.selected, o.arg])).toEqual([['Off', true, false], ['On', false, true]]);
    // Faded already: the first row brings it back.
    expect((fadeSheet({ faded: true, peekUntilBack: false, smartFade: true }).blocks[1] as { items: Array<{ label: string }> }).items[0].label).toBe('Show the island');
    // The pill: back to the menu, then its name.
    expect(fadeSegments(false).map((x) => x.key)).toEqual(['fade/back', 'fade/icon', 'fade/text']);
    expect(fadeSegments(true).map((x) => x.key)).toEqual(['fade/back', 'fade/icon']);
  });

  it('as a bare icon keeps its name in the tip', () => {
    const segs = menuSegments(FULL_MENU, { ...st, faded: true }, { order: normalizeMenuOrder(null), iconOnly: { ...DEFAULT_ICON_ONLY, fade: true } });
    const b = segs.find((x) => x.key === 'menu/fade') as Extract<Seg, { t: 'button' }>;
    expect(b.label).toBeUndefined();
    expect(b.tip).toBe('Bring the island back');
  });

  it('comes in after Hide in a menu arranged before it existed, wherever Hide was moved', () => {
    expect(normalizeMenuOrder(['position', 'quiet', 'hide', 'reminders', 'workspaces', 'activities'])).toEqual(['position', 'quiet', 'hide', 'fade', 'reminders', 'workspaces', 'activities', 'settings']);
    expect(normalizeMenuOrder(['activities', 'hide', 'quiet', 'workspaces', 'reminders', 'position'])).toEqual(['activities', 'hide', 'fade', 'quiet', 'workspaces', 'reminders', 'position', 'settings']);
    // Where the user put it, it stays.
    expect(normalizeMenuOrder(['fade', 'position', 'quiet', 'hide', 'reminders', 'workspaces', 'activities'])[0]).toBe('fade');
    const old = migrate({ version: 6, island: { menu: { position: true, quiet: true, hide: false, reminders: true, workspaces: true, activities: true }, menuOrder: ['hide', 'quiet', 'position'], menuIconOnly: { hide: true } } });
    expect(old.island.menu.fade).toBe(true);
    expect(old.island.menu.hide).toBe(false);
    expect(old.island.menuOrder.slice(0, 3)).toEqual(['hide', 'fade', 'quiet']);
    expect(old.island.menuIconOnly.fade).toBe(false);
  });

  it('is kept across restarts; settings from before it load as not faded, and junk is dropped', () => {
    expect(defaultSettings().island.faded).toBe(false);
    const raw = defaultSettings() as unknown as Record<string, any>;
    delete raw.island.faded;
    expect(migrate(raw).island.faded).toBe(false);
    expect(migrate({ version: 6, island: { anchor: 'top' } }).island.faded).toBe(false);
    raw.island.faded = true;
    expect(migrate(raw).island.faded).toBe(true);
    raw.island.faded = 'yes';
    expect(migrate(raw).island.faded).toBe(false);
  });
});
