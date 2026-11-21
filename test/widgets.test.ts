// Desktop widgets: the saved list, which tile a kind shows, and what the island sends and syncs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any>, sent: [] as Array<[string, string, unknown]>, handlers: new Map<string, (p: any) => void>() }));
vi.mock('../src/core/native', async (orig) => ({
  ...(await orig<typeof import('../src/core/native')>()),
  native: h.native,
  on: async (event: string, cb: (p: any) => void) => {
    h.handlers.set(event, cb);
    return () => {};
  },
  sendTo: async (w: string, e: string, p: unknown) => void h.sent.push([w, e, p]),
}));

import { defaultSettings, migrate } from '../src/core/settings';
import { cleanWidgets, idleTile, lookOf, newWidgetId, sized, sizeFor, sizesOf, tileFor, WidgetHost, WIDGET_KINDS, type WidgetFrame } from '../src/core/widgets';
import type { ItemLook } from '../src/core/settings';
import type { Tile } from '../src/core/sheet';

const tile = (key: string, span = 2, rows = 1): Tile => ({ key, span, rows, body: { k: 'stat', icon: 'x', label: key, value: '1' } });

beforeEach(() => {
  h.sent.length = 0;
  h.handlers.clear();
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.native.widgetsSync = vi.fn();
  h.native.log = vi.fn();
});

describe('the saved list', () => {
  it('keeps known kinds with safe ids, once each, at most eight', () => {
    expect(cleanWidgets([{ id: 'clock', kind: 'clock', x: 10.4, y: 20 }, { id: 'clock', kind: 'clock' }, { id: '../x', kind: 'timer' }, { id: 'a', kind: 'nope' }, 5, { id: 'w', kind: 'weather' }])).toEqual([
      { id: 'clock', kind: 'clock', x: 10, y: 20 },
      { id: 'w', kind: 'weather', x: -1, y: -1 },
    ]);
    const many = WIDGET_KINDS.map((k, i) => ({ id: `w${i}`, kind: k.kind }));
    expect(cleanWidgets(many)).toHaveLength(8);
    expect(cleanWidgets('no')).toEqual([]);
  });

  it('survives settings migration, and is off by default', () => {
    expect(defaultSettings().island.widgets).toEqual({ on: false, items: [], look: { color: 'island', glass: 11, tint: 80 } });
    const out = migrate({ island: { widgets: { on: true, look: { color: 'matte-white', glass: 300 }, items: [{ id: 'clock', kind: 'clock', x: 5, y: 6, locked: true }, { id: 'music', kind: 'music', size: '2x4' }, { id: 'w', kind: 'weather', size: '9x9' }, { id: 'bad id', kind: 'timer' }] } } });
    expect(out.island.widgets).toEqual({
      on: true,
      look: { color: 'matte-white', glass: 100, tint: 80 },
      items: [
        { id: 'clock', kind: 'clock', x: 5, y: 6, locked: true },
        { id: 'music', kind: 'music', x: -1, y: -1, size: '2x4' },
        { id: 'w', kind: 'weather', x: -1, y: -1 },
      ],
    });
    expect(migrate({ island: { widgets: 7 } }).island.widgets).toEqual({ on: false, items: [], look: { color: 'island', glass: 11, tint: 80 } });
    expect(migrate({ island: { widgets: { look: { color: 'neon' } } } }).island.widgets.look.color).toBe('island');
  });

  it('names a second widget of a kind after the first', () => {
    expect(newWidgetId('timer', [])).toBe('timer');
    expect(newWidgetId('timer', ['timer', 'timer-2'])).toBe('timer-3');
  });
});

describe('what a kind shows', () => {
  it("is the first tile of that activity, or nothing while it has none", () => {
    const tiles = [tile('battery/battery'), tile('system/cpu'), tile('system/mem')];
    expect(tileFor('system', tiles)?.key).toBe('system/cpu');
    expect(tileFor('systems', tiles)).toBeNull();
    expect(tileFor('timer', tiles)).toBeNull();
  });

  it('starts a window sized to its cells', () => {
    expect(sizeFor(2, 1)).toEqual({ w: 2 * 92 + 8 + 52, h: 92 + 52 });
  });
});

function host(items: Array<{ id: string; kind: string; x: number; y: number; size?: string; locked?: boolean }>, on = true, look: ItemLook = { color: 'island', glass: 11, tint: 80 }) {
  const settings = { on, items, look };
  const acts: Array<[string, unknown]> = [];
  let saved = 0;
  const tiles = [tile('timer/timer'), tile('weather/weather')];
  const w = new WidgetHost(
    { tiles: () => tiles, act: (a, b) => void acts.push([a, b]), save: () => void saved++, look: () => ({ accent: '#fff', color: 'black', reduce: false }) },
    () => settings,
  );
  return { w, acts, saved: () => saved, settings };
}

describe('the island host', () => {

  it('makes the windows, sends each its tile once, and again only when it changes', async () => {
    const { w } = host([
      { id: 'clock', kind: 'clock', x: -1, y: -1 },
      { id: 'timer', kind: 'timer', x: 40, y: 50 },
    ]);
    await w.start();
    w.tick(0);
    expect(h.native.widgetsSync).toHaveBeenCalledWith([
      { id: 'clock', x: -1, y: -1, w: 300, h: 150 },
      { id: 'timer', x: 40, y: 50, ...sizeFor(2, 1) },
    ]);
    expect(h.sent.map(([to, ev]) => [to, ev])).toEqual([['widget-clock', 'widget-frame-clock'], ['widget-timer', 'widget-frame-timer']]);
    expect((h.sent[1][2] as { tile: Tile }).tile.key).toBe('timer/timer');
    w.tick(1000);
    expect(h.sent).toHaveLength(2);
    expect(h.native.widgetsSync).toHaveBeenCalledTimes(1);
    // A widget window that just opened asks again.
    h.handlers.get('widget-ready')!({ id: 'timer' });
    expect(h.sent).toHaveLength(3);
  });

  it('closes every window when turned off', async () => {
    const { w, settings } = host([{ id: 'clock', kind: 'clock', x: 1, y: 1 }]);
    await w.start();
    w.tick(0);
    settings.on = false;
    w.tick(1000);
    expect(h.native.widgetsSync).toHaveBeenLastCalledWith([]);
  });

  it("runs a press only if it is one of an activity's actions, and saves where one was dragged", async () => {
    const { w, acts, saved, settings } = host([{ id: 'timer', kind: 'timer', x: -1, y: -1 }]);
    await w.start();
    h.handlers.get('widget-act')!({ action: 'act:timer:toggle', arg: 5 });
    h.handlers.get('widget-act')!({ action: 'island:hide', arg: null });
    h.handlers.get('widget-act')!({ action: 7 });
    expect(acts).toEqual([['act:timer:toggle', 5]]);
    h.handlers.get('widget-moved')!({ id: 'timer', x: 300.6, y: 20 });
    h.handlers.get('widget-moved')!({ id: 'nobody', x: 1, y: 1 });
    h.handlers.get('widget-moved')!({ id: 'timer', x: NaN, y: 1 });
    expect(settings.items[0]).toMatchObject({ x: 301, y: 20 });
    expect(saved()).toBe(1);
  });
});

describe('looks, sizes and the right-click menu', () => {
  it('a widget looks like the island unless it has a look of its own', () => {
    const island = { color: 'matte-black' as const, glass: 40, tint: 55 };
    expect(lookOf({ color: 'island', glass: 90, tint: 20 }, island)).toEqual({ color: 'matte-black', glass: 40, tint: 55 });
    expect(lookOf({ color: 'glass', glass: 90, tint: 20 }, island)).toEqual({ color: 'glass', glass: 90, tint: 20 });
    expect(lookOf({ color: 'tinted', glass: 90, tint: 20 }, island)).toEqual({ color: 'tinted', glass: 90, tint: 20 });
  });

  it('only tiles that show more when bigger have sizes, and only those sizes take', () => {
    const lyrics: Tile = { key: 'music/music', span: 2, rows: 4, body: { k: 'lyrics', title: 't', artist: 'a', playing: true, lines: ['x'], at: 0 } };
    const list: Tile = { key: 'claude/claude', span: 2, rows: 1, body: { k: 'list', icon: 'claude', label: 'Claude', rows: [] } };
    expect(sizesOf(lyrics).map(([v]) => v)).toEqual(['1x2', '1x4', '2x4']);
    expect(sizesOf(list).map(([v]) => v)).toEqual(['2x1', '2x2', '2x4']);
    expect(sizesOf(tile('weather/weather'))).toEqual([]);
    expect(sizesOf(null)).toEqual([]);
    expect(sized(lyrics, '1x4')).toMatchObject({ w: 1, h: 4 });
    expect(sized(list, '1x4')).toBe(list);
    expect(sized(list, undefined)).toBe(list);
  });

  it('every kind in the gallery has an icon and a line about it', () => {
    for (const k of WIDGET_KINDS) {
      expect(k.icon).toBeTruthy();
      expect(k.about.length).toBeGreaterThan(5);
    }
  });

  it('sends its own look, its lock and its sizes with each frame', async () => {
    const { w } = host([{ id: 'timer', kind: 'timer', x: 1, y: 1, locked: true }], true, { color: 'glass', glass: 70, tint: 80 });
    await w.start();
    w.tick(0);
    const frame = h.sent.at(-1)![2] as WidgetFrame;
    expect(frame).toMatchObject({ color: 'glass', glass: 70, locked: true, sizes: [], size: '' });
  });

  it('the menu locks, sizes and removes a widget, and saves each change', async () => {
    const { w, settings, saved } = host([
      { id: 'timer', kind: 'timer', x: 1, y: 1 },
      { id: 'clock', kind: 'clock', x: 2, y: 2 },
    ]);
    await w.start();
    h.handlers.get('widget-pref')!({ id: 'timer', locked: true });
    expect(settings.items[0].locked).toBe(true);
    h.handlers.get('widget-pref')!({ id: 'timer', locked: false });
    expect(settings.items[0].locked).toBeUndefined();
    h.handlers.get('widget-pref')!({ id: 'timer', size: '2x4' });
    expect(settings.items[0].size).toBe('2x4');
    h.handlers.get('widget-pref')!({ id: 'timer', size: '../x' });
    expect(settings.items[0].size).toBe('2x4');
    h.handlers.get('widget-pref')!({ id: 'clock', remove: true });
    expect(settings.items.map((x) => x.id)).toEqual(['timer']);
    h.handlers.get('widget-pref')!({ id: 'nobody', remove: true });
    expect(saved()).toBe(4);
  });
});

describe('a widget with nothing to show', () => {
  it('says its activity is off, or what it is waiting for', () => {
    expect(idleTile('music', 'off').body).toMatchObject({ value: 'Music is off', sub: 'Turn it on in Activities' });
    expect(idleTile('music', 'quiet').body).toMatchObject({ value: 'Nothing playing' });
    expect(idleTile('game', 'quiet').body).toMatchObject({ value: 'No game running' });
    expect(idleTile('nope', 'quiet').body).toMatchObject({ value: 'Nothing right now' });
  });
});
