// Land's activity against a fake native layer: what the island shows for devices nearby,
// dropped files, offers to accept, and transfers in both directions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({
  native: h.native,
  on: async (event: string, cb: (p: unknown) => void) => {
    let set = h.bus.get(event);
    if (!set) h.bus.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
  emitLocal: () => {},
}));

import type { ActivityContext, RenderEnv, SheetEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import type { LandPeer, LandTransfer } from '../src/core/native';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';
import { mapActions, type Block, type SheetView } from '../src/core/sheet';
import { LandActivity, ENDED_MS, hueOf, INTRO_MS, initials, osLabel, what } from '../src/activities/land';

const T0 = Date.parse('2026-10-13T12:00:00Z');
const MAC: LandPeer = { id: 'a1b2c3d4e5f60718', name: "Moss's MacBook Air", os: 'macos' };
const LAB: LandPeer = { id: '0badc0ffee123456', name: 'LAB-DESKTOP-07', os: 'windows' };

const emit = (event: string, payload: unknown) => {
  // Rust's list as a scan would return it.
  if (event === 'land-peers') h.native.landScan = vi.fn(async () => payload);
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function resetNative() {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    landStart: vi.fn(async (name: string | null, visible: boolean) => ({ ok: true, value: { id: 'me0000000000000a', name: name ?? 'DESKTOP-MOSS', visible, peers: [], fresh: false, friends: [] } })),
    landFriendAnswer: vi.fn(async () => true),
    landFriendsOnline: vi.fn(async () => []),
    landStop: vi.fn(async () => undefined),
    landScan: vi.fn(async () => []),
    landSend: vi.fn(async (peer: string) => ({ ok: true, value: `out-${peer}` })),
    landAnswer: vi.fn(async () => true),
    landCancel: vi.fn(async () => true),
    landStage: vi.fn(async (paths: string[]) => paths.map((p) => ({ path: p, name: p.split('\\').pop(), size: 1000, dir: !p.includes('.'), files: p.includes('.') ? 1 : 12, error: null }))),
    open: vi.fn(async () => true),
    reveal: vi.fn(async () => true),
  });
}

type Calls = { surface: Array<{ key?: string; ms?: number; level?: string }>; alert: unknown[][]; notify: unknown[][]; openCard: number; cardOpen: boolean };

async function boot(options: Record<string, unknown> = {}) {
  const settings = defaultSettings();
  const calls: Calls = { surface: [], alert: [], notify: [], openCard: 0, cardOpen: false };
  const act = new LandActivity();
  const ctx: ActivityContext = {
    id: 'land',
    config: () => settings.activities.config.land,
    options: () => ({ visible: true, name: '', ...options }) as never,
    settings: () => settings,
    update: () => {},
    surface: (o) => void calls.surface.push(o ?? {}),
    alert: (...a) => void calls.alert.push(a),
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: (...a) => void calls.notify.push(a),
    log: () => {},
    openCard: () => {
      calls.openCard++;
      calls.cardOpen = true;
    },
    closeCard: () => void (calls.cardOpen = false),
    cardOpen: () => calls.cardOpen,
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls };
}

const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheetEnv = (reason: SheetEnv['reason'], over: Partial<SheetEnv> = {}): SheetEnv => ({ reason, now: Date.now(), width: 520, vertical: false, interactive: true, surfaced: null, ...over });

const transfer = (over: Partial<LandTransfer> = {}): LandTransfer => ({
  id: 'out-1',
  dir: 'out',
  peer: MAC,
  state: 'waiting',
  done: 0,
  total: 10_000_000,
  count: 3,
  items: [{ name: 'Trip', size: 10_000_000, files: 3, dir: true }],
  error: null,
  saved: [],
  folder: null,
  expires: null,
  ...over,
});

const ALEX = { id: 'b0'.repeat(32), name: 'Alex', os: 'windows' };
const FRIEND = { id: 'f1'.repeat(32), name: 'Alex', added: T0 - 86_400_000 };
const SAM = { id: 'c2'.repeat(32), name: 'Sam', added: T0 };
/** Land starts with these friends on other networks. */
const withFriends = (friends: unknown[]) => {
  h.native.landStart = vi.fn(async (name: string | null, visible: boolean) => ({ ok: true, value: { id: 'me0000000000000a', name: name ?? 'DESKTOP-MOSS', visible, peers: [], fresh: false, friends } }));
};
const friendAsk = (over: Record<string, unknown> = {}) => ({ id: 'friend-1', from: ALEX, state: 'asking', expires: T0 + 120_000, ...over });

const block = <T extends Block['t']>(view: SheetView | null, t: T, key?: string) => view?.blocks.find((b) => b.t === t && (!key || b.key === key)) as Extract<Block, { t: T }> | undefined;

/** Every level and orientation renders valid, fittable, icon-only-when-vertical segments. */
function smoke(act: LandActivity, label: string): void {
  for (const level of ['compact', 'expanded', 'maximum'] as const) {
    for (const vertical of [false, true]) {
      const at = `${label} ${level}${vertical ? ' vertical' : ''}`;
      const segs = act.render(env(level, { vertical }));
      const keys = segs.map((s) => s.key);
      expect(new Set(keys).size, `${at}: unique keys`).toBe(keys.length);
      for (const s of segs) {
        if (s.t === 'icon') expect(hasIcon(s.icon), `${at}: icon ${s.icon}`).toBe(true);
        if (s.t === 'button') {
          expect(hasIcon(s.icon!), `${at}: button icon ${s.icon}`).toBe(true);
          if (vertical) expect(s.label, `${at}: vertical button ${s.key} is icon-only`).toBeUndefined();
        }
      }
      if (vertical) fitVertical(segs, 200, 40);
      else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetNative();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('land helpers', () => {
  it('names devices the way avatars show them', () => {
    expect(initials("Moss's MacBook Air")).toBe('MM');
    expect(initials('DESKTOP-K2L3M4')).toBe('DK');
    expect(initials('studio')).toBe('ST');
    expect(initials('  ')).toBe('?');
    expect(hueOf(MAC.id)).toBe(hueOf(MAC.id));
    expect(hueOf(MAC.id)).toBeGreaterThanOrEqual(0);
    expect(hueOf(MAC.id)).toBeLessThan(360);
    expect([osLabel('macos'), osLabel('windows'), osLabel('plan9')]).toEqual(['Mac', 'Windows', '']);
    expect(what({ items: [{ name: 'a.pdf', size: 1, files: 1, dir: false }], count: 1 })).toBe('a.pdf');
    expect(what({ items: [{ name: 'Trip', size: 1, files: 4, dir: true }], count: 4 })).toBe('Trip');
    expect(what({ items: [], count: 7 })).toBe('7 files');
  });

  it('people avatars keep their actions through the island namespacing', () => {
    const [b] = mapActions([{ t: 'people', key: 'p', items: [{ key: 'x', name: 'X', initials: 'X', hue: 1, action: 'pick', arg: 'x' }] }], (a) => `act:land:${a}`);
    expect(b.t === 'people' && b.items[0].action).toBe('act:land:pick');
  });
});

describe('land', () => {
  it('starts with its name and visibility, and stops with the activity', async () => {
    const { act } = await boot({ name: ' Studio ', visible: false });
    expect(h.native.landStart).toHaveBeenCalledWith('Studio', false, true, null);
    expect(act.status().active).toBe(false);
    act.stop();
    expect(h.native.landStop).toHaveBeenCalled();
  });

  it('reaches friends on other networks unless that is turned off', async () => {
    await boot({ anywhere: false });
    expect(h.native.landStart).toHaveBeenCalledWith(null, true, false, null);
  });

  it('uses your own relay when one is set, and says so when the address is wrong', async () => {
    h.native.landStart = vi.fn(async (name: string | null, visible: boolean) => ({ ok: true, value: { id: 'me0000000000000a', name: name ?? 'DESKTOP-MOSS', visible, peers: [], fresh: false, friends: [], relayError: '“relay.example.com” isn’t a relay address.' } }));
    const { act } = await boot({ relay: ' https://relay.example.com ' });
    expect(h.native.landStart).toHaveBeenCalledWith(null, true, true, 'https://relay.example.com');
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'text', 'relay')!.text).toContain('n0');
  });

  it('a friend request takes the island until answered: Block, Not now or Add', async () => {
    const { act, calls } = await boot();
    emit('land-friend-ask', friendAsk());
    expect(calls.alert).toEqual([['shake']]);
    expect(calls.notify[0]).toEqual(['Alex wants to be friends', 'Friends can send each other files from anywhere. Answer in the island.']);
    expect(act.status()).toMatchObject({ active: true, urgent: { key: 'friend:friend-1', level: 'maximum' }, summary: 'Alex wants to be friends' });
    expect(act.pet().mood).toBe('needs-you');
    const card = act.sheet(sheetEnv('urgent'))!;
    expect(block(card, 'head')).toMatchObject({ title: 'Alex wants to be friends' });
    expect(block(card, 'countdown')).toMatchObject({ until: T0 + 120_000, total: 120_000 });
    expect(block(card, 'buttons', 'answer')!.items.map((b) => [b.action, b.arg])).toEqual([
      ['friend-block', 'friend-1'],
      ['friend-no', 'friend-1'],
      ['friend-add', 'friend-1'],
    ]);
    expect(block(act.sheet(sheetEnv('urgent', { interactive: false })), 'buttons', 'answer')).toBeUndefined();
    smoke(act, 'friend request');

    await act.action('friend-add', 'friend-1');
    expect(h.native.landFriendAnswer).toHaveBeenCalledWith('friend-1', 'add');
    emit('land-friend-ask', friendAsk({ state: 'added', expires: undefined }));
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('a file offer comes before a friend request', async () => {
    const { act } = await boot();
    emit('land-friend-ask', friendAsk());
    emit('land-transfer', transfer({ id: 'in-7', dir: 'in', peer: LAB, state: 'asking' }));
    expect(act.status().urgent?.key).toBe('ask:in-7');
    emit('land-transfer', transfer({ id: 'in-7', dir: 'in', peer: LAB, state: 'declined', error: 'Declined.' }));
    expect(act.status().urgent?.key).toBe('friend:friend-1');
  });

  it('a request whose asker gave up leaves the island', async () => {
    const { act } = await boot();
    emit('land-friend-ask', friendAsk());
    expect(act.status().urgent?.key).toBe('friend:friend-1');
    emit('land-friend-ask', friendAsk({ state: 'gone', expires: undefined }));
    expect(act.status().urgent ?? null).toBeNull();
  });

  it('while the island is hidden, friend requests get a no at once and nothing pops up', async () => {
    const settings = defaultSettings();
    const { act, calls } = await boot();
    (act as unknown as { ctx: ActivityContext }).ctx.settings = () => ({ ...settings, island: { ...settings.island, hiddenUntil: Date.now() + 3_600_000 } });
    emit('land-friend-ask', friendAsk({ id: 'friend-2' }));
    expect(h.native.landFriendAnswer).toHaveBeenCalledWith('friend-2', 'no');
    expect(calls.alert).toEqual([]);
    expect(calls.notify).toEqual([]);
  });

  it('its first start on a computer says what it is, as the system asks about the network', async () => {
    h.native.landStart = vi.fn(async () => ({ ok: true, value: { id: 'me0000000000000a', name: 'DESKTOP-MOSS', visible: true, peers: [], fresh: true } }));
    const { act, calls } = await boot();
    expect(calls.surface).toEqual([{ key: 'intro', ms: INTRO_MS, level: 'expanded' }]);
    expect(act.status()).toMatchObject({ active: true, summary: 'Land is on' });
    const card = act.sheet(sheetEnv('surfaced', { surfaced: 'intro' }))!;
    expect(block(card, 'head')!.title).toBe('Land is on');
    expect(block(card, 'text', 'ask')!.text).toContain('firewall');
    smoke(act, 'intro');
    await tick(INTRO_MS + 1000);
    expect(act.status().active).toBe(false);
    // Later starts (the key is there now) say nothing.
    resetNative();
    const again = await boot();
    expect(again.calls.surface).toEqual([]);
  });

  it('says why when it cannot start, and takes no drops then', async () => {
    h.native.landStart = vi.fn(async () => ({ ok: false, error: 'Land cannot take files: access denied' }));
    const { act } = await boot();
    expect(act.accepts()).toBeNull();
    expect(act.drop(['C:\\x.txt'])).toBe(false);
    const card = act.sheet(sheetEnv('open'));
    expect(block(card, 'people')?.empty).toContain('access denied');
    expect(act.tile(sheetEnv('open'))?.body).toMatchObject({ value: 'Off' });
  });

  it('a drop stages the files, opens its card and looks for computers', async () => {
    const { act, calls } = await boot();
    expect(act.accepts()).toBe('Drop to send with Land');
    expect(act.drop(['C:\\Users\\m\\Trip', 'C:\\Users\\m\\notes.txt'])).toBe(true);
    await tick(0);
    expect(calls.openCard).toBe(1);
    expect(h.native.landScan).toHaveBeenCalled();
    expect(h.native.landStage).toHaveBeenCalledWith(['C:\\Users\\m\\Trip', 'C:\\Users\\m\\notes.txt']);
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'head')).toMatchObject({ title: 'Land', sub: '13 files · 2.0 KB' });
    expect(block(card, 'rows', 'files')!.items.map((r) => [r.icon, r.title])).toEqual([
      ['folder', 'Trip'],
      ['file', 'notes.txt'],
    ]);
    // Nobody around yet: the empty row says what is needed, and Send waits.
    expect(block(card, 'people')!.items).toEqual([]);
    expect(block(card, 'buttons', 'send')!.items[0]).toMatchObject({ label: 'Send', disabled: true });
    // The same path dropped again is not listed twice.
    act.drop(['C:\\Users\\m\\notes.txt']);
    await tick(0);
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'files')!.items).toHaveLength(2);
    expect(act.tile(sheetEnv('open'))?.body).toMatchObject({ value: '13 files ready' });
  });

  it('keeps asking who is around while its card is open', async () => {
    const { act, calls } = await boot();
    await act.action('card');
    expect(calls.openCard).toBe(1);
    const n = h.native.landScan.mock.calls.length;
    await tick(4100);
    expect(h.native.landScan.mock.calls.length).toBeGreaterThan(n);
    calls.cardOpen = false;
    const m = h.native.landScan.mock.calls.length;
    await tick(10_000);
    expect(h.native.landScan.mock.calls.length).toBe(m);
  });

  it('sends to the only computer around, or to the ones picked', async () => {
    const { act } = await boot();
    act.drop(['C:\\a.txt']);
    await tick(0);
    emit('land-peers', [MAC]);
    let card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'people')!.items[0]).toMatchObject({ key: MAC.id, initials: 'MM', sub: 'Mac', selected: true });
    expect(block(card, 'buttons', 'send')!.items[0]).toMatchObject({ label: "Send to Moss's MacBook Air", disabled: false });
    // A tap on the only one keeps it picked.
    await act.action('pick', MAC.id);
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items[0].selected).toBe(true);

    emit('land-peers', [MAC, LAB]);
    card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'people')!.items.every((p) => !p.selected)).toBe(true);
    expect(block(card, 'buttons', 'send')!.items[0]).toMatchObject({ label: 'Pick a computer', disabled: true });
    await act.action('pick', MAC.id);
    await act.action('pick', LAB.id);
    expect(block(act.sheet(sheetEnv('open')), 'buttons', 'send')!.items[0].label).toBe('Send to 2 computers');
    await act.action('send');
    expect(h.native.landSend.mock.calls).toEqual([
      [MAC.id, ['C:\\a.txt']],
      [LAB.id, ['C:\\a.txt']],
    ]);
    // On their way: the list empties.
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'files')).toBeUndefined();
    // A computer that leaves is no longer picked.
    emit('land-peers', [LAB]);
    act.drop(['C:\\b.txt']);
    await tick(0);
    expect(block(act.sheet(sheetEnv('open')), 'buttons', 'send')!.items[0].label).toBe('Send to LAB-DESKTOP-07');
  });

  it('friends on other networks show next to the computers nearby, and Send reaches them', async () => {
    withFriends([FRIEND]);
    h.native.landFriendsOnline = vi.fn(async () => [FRIEND.id]);
    const { act } = await boot();
    act.drop(['C:\\a.txt']);
    await tick(0);
    emit('land-peers', [MAC]);
    const card = act.sheet(sheetEnv('open'))!;
    const people = block(card, 'people')!.items;
    expect(people.map((p) => p.key)).toEqual([MAC.id, FRIEND.id]);
    expect(people[1]).toMatchObject({ name: 'Alex', initials: 'AL', badge: 'globe', sub: 'Online', selected: false });
    // Two to choose from: nothing is picked for you.
    expect(block(card, 'buttons', 'send')!.items[0]).toMatchObject({ label: 'Pick who gets them', disabled: true });
    await act.action('pick', FRIEND.id);
    expect(block(act.sheet(sheetEnv('open')), 'buttons', 'send')!.items[0].label).toBe('Send to Alex');
    await act.action('send');
    expect(h.native.landSend.mock.calls).toEqual([[FRIEND.id, ['C:\\a.txt']]]);
  });

  it('a friend on the same network shows once, as the computer nearby, and gets files the fast way', async () => {
    withFriends([FRIEND]);
    const { act } = await boot();
    act.drop(['C:\\a.txt']);
    await tick(0);
    emit('land-peers', [{ ...MAC, anywhere: FRIEND.id }]);
    const people = block(act.sheet(sheetEnv('open')), 'people')!.items;
    expect(people.map((p) => p.key)).toEqual([MAC.id]);
    expect(people[0]).toMatchObject({ name: "Moss's MacBook Air", badge: 'globe', sub: 'Mac', selected: true });
    await act.action('send');
    expect(h.native.landSend.mock.calls).toEqual([[MAC.id, ['C:\\a.txt']]]);
  });

  it('a lone friend is picked for you, like a lone computer', async () => {
    withFriends([FRIEND]);
    const { act } = await boot();
    act.drop(['C:\\a.txt']);
    await tick(0);
    expect(block(act.sheet(sheetEnv('open')), 'buttons', 'send')!.items[0]).toMatchObject({ label: 'Send to Alex', disabled: false });
  });

  it('asks which friends are online when its card opens, then every 20 s while it is open', async () => {
    withFriends([FRIEND, SAM]);
    h.native.landFriendsOnline = vi.fn(async () => [SAM.id]);
    const { act } = await boot();
    let people = block(act.sheet(sheetEnv('open')), 'people')!.items;
    expect(people.find((p) => p.key === FRIEND.id)!.sub).toBe('Friend');
    await act.action('card');
    await tick(0);
    expect(h.native.landFriendsOnline).toHaveBeenCalledTimes(1);
    people = block(act.sheet(sheetEnv('open')), 'people')!.items;
    expect(people.find((p) => p.key === FRIEND.id)!.sub).toBe('Not online');
    expect(people.find((p) => p.key === SAM.id)!.sub).toBe('Online');
    await tick(5000);
    expect(h.native.landFriendsOnline).toHaveBeenCalledTimes(1);
    await tick(20000);
    expect(h.native.landFriendsOnline).toHaveBeenCalledTimes(2);
  });

  it('keeps its friends as Rust reports them', async () => {
    withFriends([FRIEND]);
    const { act } = await boot();
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items.map((p) => p.key)).toEqual([FRIEND.id]);
    emit('land-friends', [FRIEND, SAM]);
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items.map((p) => p.key)).toEqual([FRIEND.id, SAM.id]);
    emit('land-friends', []);
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items).toEqual([]);
  });

  it('a send to a friend who is away waits in the card, not on the pill, and goes when they are back', async () => {
    const { act } = await boot();
    const far = transfer({ id: 'out-q', peer: { id: FRIEND.id, name: 'Alex', os: '' }, state: 'queued' });
    emit('land-transfer', far);
    expect(act.status().active).toBe(false);
    const row = block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items[0];
    expect(row.detail).toBe('Sends when Alex is online');
    expect(row.button).toMatchObject({ action: 'cancel', arg: 'out-q' });
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: '1 waiting' });
    emit('land-transfer', { ...far, state: 'sending', done: 5_000_000 });
    expect(act.status()).toMatchObject({ active: true, summary: 'To Alex · 50%' });
  });

  it('a transfer whose connection dropped shows as paused, can be cancelled, and picks up again', async () => {
    const { act } = await boot();
    emit('land-transfer', transfer({ id: 'out-p', state: 'sending', done: 3_000_000 }));
    emit('land-transfer', transfer({ id: 'out-p', state: 'paused', done: 3_000_000, error: "Connection to Moss's MacBook Air lost. Trying again…" }));
    expect(act.status()).toMatchObject({ active: true, summary: "To Moss's MacBook Air · Paused" });
    const segs = act.render(env('expanded'));
    expect(segs.find((s) => s.key === 'icon')).toMatchObject({ icon: 'pause' });
    expect(segs.find((s) => s.key === 'pct')).toMatchObject({ text: 'Paused' });
    const row = block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items[0];
    expect(row.detail).toContain('Trying again');
    expect(row.button).toMatchObject({ action: 'cancel', arg: 'out-p' });
    smoke(act, 'paused');
    emit('land-transfer', transfer({ id: 'out-p', state: 'sending', done: 6_000_000 }));
    expect(act.render(env('expanded')).find((s) => s.key === 'pct')).toMatchObject({ text: '60%' });
  });

  it('a transfer with a friend says how it goes: direct, or through a relay', async () => {
    const { act } = await boot();
    const far = transfer({ id: 'out-f', peer: { id: FRIEND.id, name: 'Alex', os: '' }, state: 'sending', done: 5_000_000, via: 'relay' });
    emit('land-transfer', far);
    const detail = () => block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items[0].detail;
    expect(detail()).toContain('through a relay');
    emit('land-transfer', { ...far, via: 'direct' });
    expect(detail()).toContain('direct');
    emit('land-transfer', transfer({ id: 'out-f', state: 'sending', done: 5_000_000, via: 'lan' }));
    expect(detail()).not.toMatch(/direct|relay/);
  });

  it('a send that cannot start says why and keeps the files', async () => {
    h.native.landSend = vi.fn(async () => ({ ok: false, error: 'That device is gone. Try again when it shows up.' }));
    const { act } = await boot();
    act.drop(['C:\\a.txt']);
    await tick(0);
    emit('land-peers', [MAC]);
    await act.action('send');
    const card = act.sheet(sheetEnv('open'))!;
    expect(block(card, 'text', 'note')!.text).toBe('That device is gone. Try again when it shows up.');
    expect(block(card, 'rows', 'files')!.items).toHaveLength(1);
    await tick(9000);
    expect(block(act.sheet(sheetEnv('open')), 'text', 'note')).toBeUndefined();
  });

  it('shows a send going: waiting, a filling ring and bar, then sent with the bot pleased', async () => {
    const { act, calls } = await boot();
    emit('land-peers', [MAC]);
    emit('land-transfer', transfer());
    expect(act.status()).toMatchObject({ active: true, summary: "To Moss's MacBook Air · Waiting", beam: { motion: 'orbit' } });
    expect(act.pet().mood).toBe('uploading');
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items[0]).toMatchObject({ progress: null, sub: 'Waiting…' });
    smoke(act, 'waiting');

    emit('land-transfer', transfer({ state: 'sending', done: 2_500_000 }));
    await tick(1000);
    emit('land-transfer', transfer({ state: 'sending', done: 5_000_000 }));
    expect(act.status()).toMatchObject({ summary: "To Moss's MacBook Air · 50%", beam: { motion: 'progress', value: 0.5 } });
    expect(act.render(env('compact')).map((s) => s.key)).toEqual(['icon', 'pct']);
    const row = block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items[0];
    expect(row).toMatchObject({ title: "To Moss's MacBook Air · Trip", detail: '50% · 4.8 MB of 9.5 MB · 2.4 MB/s', button: { action: 'cancel' } });
    expect(act.tile(sheetEnv('open'))!.body).toMatchObject({ value: '50%', progress: 0.5 });
    smoke(act, 'sending');
    await act.action('cancel', 'out-1');
    expect(h.native.landCancel).toHaveBeenCalledWith('out-1');

    emit('land-transfer', transfer({ state: 'done', done: 10_000_000 }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'end:out-1', ms: ENDED_MS, level: 'expanded' });
    expect(act.pet().moment?.id).toBe('land-sent');
    expect(act.status()).toMatchObject({ active: true, summary: "Sent to Moss's MacBook Air" });
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items[0]).toMatchObject({ badge: 'check', tone: 'good', sub: 'Sent' });
    smoke(act, 'sent');
    await tick(ENDED_MS + 1000);
    expect(act.status().active).toBe(false);
    // The card still lists it for a while.
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items[0].detail).toBe('Sent · 9.5 MB');
  });

  it('says so when the other side declines', async () => {
    const { act, calls } = await boot();
    emit('land-peers', [MAC]);
    emit('land-transfer', transfer());
    emit('land-transfer', transfer({ state: 'declined', error: "Moss's MacBook Air declined." }));
    expect(calls.surface.at(-1)).toMatchObject({ key: 'end:out-1' });
    expect(act.render(env('expanded')).map((s) => (s.t === 'text' ? s.text : s.key))).toEqual(['icon', "Moss's MacBook Air declined."]);
    expect(block(act.sheet(sheetEnv('open')), 'people')!.items[0]).toMatchObject({ badge: 'x', tone: 'bad', sub: 'Declined' });
  });

  it('an offer takes the island until answered: who, what, Accept or Decline', async () => {
    const { act, calls } = await boot();
    const offer = transfer({
      id: 'in-1',
      dir: 'in',
      peer: LAB,
      state: 'asking',
      total: 48_300_000,
      count: 14,
      items: [
        { name: 'Trip', size: 46_100_000, files: 13, dir: true },
        { name: 'itinerary.pdf', size: 2_200_000, files: 1, dir: false },
      ],
      expires: T0 + 120_000,
    });
    emit('land-transfer', offer);
    expect(calls.alert).toEqual([['shake']]);
    expect(calls.notify[0]).toEqual(['LAB-DESKTOP-07 wants to send you files', '14 files · 46.1 MB. Accept or decline in the island.']);
    expect(act.status()).toMatchObject({ active: true, urgent: { key: 'ask:in-1', level: 'maximum' }, summary: 'LAB-DESKTOP-07 wants to send 14 files' });
    expect(act.pet().mood).toBe('needs-you');
    const card = act.sheet(sheetEnv('urgent'))!;
    expect(block(card, 'head')).toMatchObject({ title: 'LAB-DESKTOP-07 wants to send you', sub: '14 files · 46.1 MB' });
    expect(block(card, 'rows', 'files')!.items.map((r) => [r.title, r.detail])).toEqual([
      ['Trip', '13 files · 44.0 MB'],
      ['itinerary.pdf', '2.1 MB'],
    ]);
    expect(block(card, 'countdown')).toMatchObject({ until: T0 + 120_000, total: 120_000 });
    expect(block(card, 'buttons', 'answer')!.items.map((b) => [b.action, b.arg])).toEqual([
      ['decline', 'in-1'],
      ['accept', 'in-1'],
    ]);
    // Without Interactive, no buttons: the pill still offers nothing to press.
    expect(block(act.sheet(sheetEnv('urgent', { interactive: false })), 'buttons', 'answer')).toBeUndefined();
    smoke(act, 'asking');

    await act.action('accept', 'in-1');
    expect(h.native.landAnswer).toHaveBeenCalledWith('in-1', true);
    emit('land-transfer', { ...offer, state: 'receiving', done: 24_000_000, expires: null });
    expect(act.status().urgent ?? null).toBeNull();
    expect(act.pet().mood).toBe('downloading');
    expect(act.render(env('expanded')).find((s) => s.key === 'who')).toMatchObject({ text: 'From LAB-DESKTOP-07' });

    emit('land-transfer', { ...offer, state: 'done', done: 48_300_000, expires: null, saved: ['C:\\Users\\m\\Downloads\\Trip', 'C:\\Users\\m\\Downloads\\itinerary.pdf'], folder: 'C:\\Users\\m\\Downloads' });
    expect(act.pet().moment?.id).toBe('land-received');
    expect(act.status().summary).toBe('14 files from LAB-DESKTOP-07');
    const keys = act.render(env('maximum')).map((s) => s.key);
    expect(keys).toEqual(['icon', 'end', 'show']);
    const done = act.sheet(sheetEnv('surfaced'))!;
    expect(block(done, 'rows', 'saved')!.items.map((r) => r.title)).toEqual(['Trip', 'itinerary.pdf']);
    await act.action('show', 'C:\\Users\\m\\Downloads\\Trip');
    expect(h.native.reveal).toHaveBeenCalledWith('C:\\Users\\m\\Downloads\\Trip');
  });

  it('one file received offers Open', async () => {
    const { act } = await boot();
    emit('land-transfer', transfer({ id: 'in-2', dir: 'in', state: 'asking', count: 1, items: [{ name: 'a.pdf', size: 5, files: 1, dir: false }], total: 5 }));
    expect(block(act.sheet(sheetEnv('urgent')), 'rows', 'files')).toBeUndefined();
    emit('land-transfer', transfer({ id: 'in-2', dir: 'in', state: 'done', count: 1, items: [{ name: 'a.pdf', size: 5, files: 1, dir: false }], total: 5, done: 5, saved: ['D:\\Downloads\\a (1).pdf'] }));
    const open = act.render(env('expanded')).find((s) => s.key === 'open');
    expect(open).toMatchObject({ action: 'open', arg: 'D:\\Downloads\\a (1).pdf' });
  });

  it('while the island is hidden, offers are declined at once and nothing pops up', async () => {
    const settings = defaultSettings();
    const { act, calls } = await boot();
    // The island was hidden for an hour after Land started.
    (act as unknown as { ctx: ActivityContext }).ctx.settings = () => ({ ...settings, island: { ...settings.island, hiddenUntil: Date.now() + 3_600_000 } });
    emit('land-transfer', transfer({ id: 'in-9', dir: 'in', state: 'asking' }));
    expect(h.native.landAnswer).toHaveBeenCalledWith('in-9', false);
    expect(calls.alert).toEqual([]);
    expect(calls.notify).toEqual([]);
  });

  it('declining an offer yourself is not announced', async () => {
    const { act, calls } = await boot();
    emit('land-transfer', transfer({ id: 'in-3', dir: 'in', state: 'asking' }));
    await act.action('decline', 'in-3');
    expect(h.native.landAnswer).toHaveBeenCalledWith('in-3', false);
    emit('land-transfer', transfer({ id: 'in-3', dir: 'in', state: 'declined', error: 'Declined.' }));
    expect(calls.surface).toEqual([]);
    expect(act.status().active).toBe(false);
  });

  it('keeps a short history of transfers', async () => {
    const { act } = await boot();
    for (let i = 0; i < 9; i++) {
      emit('land-transfer', transfer({ id: `t${i}` }));
      emit('land-transfer', transfer({ id: `t${i}`, state: 'done', done: 10_000_000 }));
      await tick(1000);
    }
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items).toHaveLength(4);
    await tick(31 * 60_000);
    emit('land-transfer', transfer({ id: 'new' }));
    expect(block(act.sheet(sheetEnv('open')), 'rows', 'transfers')!.items.map((r) => r.key)).toEqual(['new']);
  });
});
