// The Apps tile: the saved list, finding an app to add, and what a tap does.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityContext } from '../src/core/activity';
import { defaultSettings } from '../src/core/settings';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));
vi.mock('../src/core/native', async (orig) => ({ ...(await orig<typeof import('../src/core/native')>()), native: h.native, on: async () => () => {} }));

import { AppsActivity, cleanApps, findApps } from '../src/activities/apps';

const PAINT = { name: 'Paint', target: 'C:\Windows\mspaint.exe' };
const PHOTOS = { name: 'Photos', target: 'shell:AppsFolder\Microsoft.Photos!App' };
const NOTEPAD = { name: 'Notepad', target: 'C:\Windows\notepad.exe' };

beforeEach(() => {
  for (const k of Object.keys(h.native)) delete h.native[k];
  Object.assign(h.native, {
    demo: false,
    appsPinned: vi.fn(async () => [PAINT, PHOTOS]),
    appsIcons: vi.fn(async (targets: string[]) => targets.map((t) => (t === PAINT.target ? 'data:image/png;base64,AA' : null))),
    wsApps: vi.fn(async () => [NOTEPAD, PAINT, PHOTOS]),
    wsLaunch: vi.fn(async () => ({ ok: true, value: { pid: 1, note: null } })),
    log: vi.fn(),
  });
});

async function boot(options: Record<string, unknown> = {}) {
  const settings = defaultSettings();
  const saved: Array<Record<string, unknown>> = [];
  let card = 0;
  const act = new AppsActivity();
  const ctx = {
    id: 'apps',
    config: () => settings.activities.config.apps,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: () => {},
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => false,
    notify: () => {},
    log: () => {},
    setOptions: (p: Record<string, unknown>) => void saved.push(p),
    openCard: () => void card++,
  } as unknown as ActivityContext;
  await act.start(ctx);
  await new Promise((r) => setTimeout(r, 0));
  return { act, saved, cards: () => card };
}

const env = { reason: 'open' as const, now: Date.now(), width: 400, vertical: false, interactive: true, surfaced: null };
const files = (act: AppsActivity) => act.sheet(env)!.blocks.find((b) => b.t === 'files') as Extract<NonNullable<ReturnType<AppsActivity['sheet']>>['blocks'][number], { t: 'files' }> | undefined;

describe('apps', () => {
  it('keeps only real entries, once each', () => {
    expect(cleanApps([PAINT, { name: 'x' }, 7, { ...PAINT, target: PAINT.target.toUpperCase() }, PHOTOS])).toEqual([PAINT, PHOTOS]);
    expect(cleanApps('no')).toEqual([]);
  });

  it('finds apps by every word typed, names starting with it first, never one already there', () => {
    const all = [{ name: 'Snipping Tool', target: 'a' }, { name: 'Paint', target: 'b' }, { name: 'MS Paint 3D', target: 'c' }];
    expect(findApps(all, 'paint', new Set()).map((a) => a.name)).toEqual(['Paint', 'MS Paint 3D']);
    expect(findApps(all, 'paint', new Set(['b'])).map((a) => a.name)).toEqual(['MS Paint 3D']);
    expect(findApps(all, '  ', new Set())).toEqual([]);
  });

  it('starts with the taskbar pins, saves them, and shows each with its icon', async () => {
    const { act, saved } = await boot();
    expect(saved).toEqual([{ apps: [PAINT, PHOTOS] }]);
    expect(act.tile(env)).toMatchObject({ action: 'card', body: { label: 'Apps', sub: '2 apps' } });
    expect(files(act)!.items.map((f) => [f.name, f.thumb, f.action])).toEqual([
      ['Paint', 'data:image/png;base64,AA', 'open'],
      ['Photos', null, 'open'],
    ]);
  });

  it('a saved list wins over the pins, even an empty one', async () => {
    const { act } = await boot({ apps: [] });
    expect(h.native.appsPinned).not.toHaveBeenCalled();
    expect(files(act)).toBeUndefined();
  });

  it('a tap opens the app and says so; a failure says why', async () => {
    const { act, cards } = await boot();
    await act.action('card');
    expect(cards()).toBe(1);
    await act.action('open', PHOTOS.target);
    expect(h.native.wsLaunch).toHaveBeenCalledWith({ kind: 'app', path: PHOTOS.target, args: '', cwd: '' }, '');
    expect(act.sheet({ ...env, now: Date.now() })!.blocks[0]).toMatchObject({ sub: 'Opening Photos' });
    h.native.wsLaunch = vi.fn(async () => ({ ok: false, error: 'It is gone.' }));
    await act.action('open', PAINT.target);
    expect(act.sheet({ ...env, now: Date.now() })!.blocks[0]).toMatchObject({ sub: "Couldn't open Paint: It is gone." });
    // Only what is on the list opens.
    await act.action('open', 'C:\evil.exe');
    expect(h.native.wsLaunch).toHaveBeenCalledTimes(1);
  });

  it('Edit takes apps off and adds one from Start', async () => {
    const { act, saved } = await boot();
    await act.action('edit');
    await new Promise((r) => setTimeout(r, 0));
    expect(files(act)!.items.every((f) => f.action === undefined && f.remove?.action === 'remove')).toBe(true);
    await act.action('find', 'note');
    const found = act.sheet(env)!.blocks.find((b) => b.t === 'rows');
    expect(found).toMatchObject({ items: [{ title: 'Notepad', action: 'add', arg: NOTEPAD.target }] });
    await act.action('add', NOTEPAD.target);
    await act.action('remove', PAINT.target);
    expect(saved.at(-1)).toEqual({ apps: [PHOTOS, NOTEPAD] });
    // Only an app Start lists can be added.
    await act.action('add', 'C:\evil.exe');
    expect(saved.at(-1)).toEqual({ apps: [PHOTOS, NOTEPAD] });
  });
});
