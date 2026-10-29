// Island on your phone, the island's side (src/remote/hub.ts) against a fake island and a fake
// Rust: greeting a phone, sending only what changed (and not too often), following its nav, and
// running only the taps it was shown.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MirrorFrame } from '../src/core/mirror';
import type { Placed } from '../src/core/segments';
import type { SheetView } from '../src/core/sheet';
import { defaultSettings } from '../src/core/settings';
import { CLIP_MAX, DEFAULT_WIDTH, PhoneActs, PhoneError, PhoneHub, termAllowed, type PhoneDelivery, type PhoneInfo, type PhoneIslandHooks, type PhoneNative } from '../src/remote/hub';
import type { BotState, IslandMsg, Nav, ScreenState } from '../src/remote/protocol';

const T0 = Date.parse('2026-10-22T14:00:00Z');
const IPHONE = 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0';
const OTHER = 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4';
const phone = (id = IPHONE, connected = true, extra: Partial<PhoneInfo> = {}): PhoneInfo => ({ id, name: id === IPHONE ? 'iPhone' : 'Other', pairedAt: T0 - 86_400_000, lastSeen: T0, connected, push: false, ...extra });

const frame = (sig: string, placed: Placed[] = []): MirrorFrame => ({
  sig, swap: false, bump: false, placed, w: 300, h: 36, orient: 'horizontal', anchor: 'top', edge: 8, hidden: false, fsHide: false, fullscreen: null,
  glow: null, speed: 'medium', accent: '#6aa6e8', color: 'black', reduce: false, bot: { d: 36 },
});
const chip = (action: string, arg?: unknown) => ({ seg: { t: 'chip', key: 'chip/land', label: '', action, arg, prio: 5 }, x: 0, w: 24 }) as unknown as Placed;

const grid = (title = 'Song'): SheetView => ({
  key: 'island/grid',
  wide: true,
  blocks: [
    {
      t: 'tiles', key: 'grid', cols: 4, rows: 1, pages: 1, cell: 80,
      items: [
        { key: 'music/m', action: 'act:music:open', body: { k: 'media', title, artist: 'Artist', playing: true, buttons: [{ key: 'p', label: '', action: 'act:music:toggle' }] } },
        { key: 'land/land', action: 'act:land:card', body: { k: 'stat', icon: 'land', label: 'Land', value: '2 nearby' } },
      ],
    },
  ],
});
const landCard: SheetView = {
  key: 'land/card',
  blocks: [
    { t: 'head', key: 'head', title: 'Land', buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close' }] },
    { t: 'rows', key: 'saved', items: [{ key: 'f', title: 'photo.jpg', action: 'act:land:open', arg: 'C:\\Users\\moss\\Downloads\\photo.jpg' }] },
    { t: 'input', key: 'text', placeholder: 'Paste a link', action: 'act:land:stage-text' },
  ],
};
const permission: SheetView = {
  key: 'claude/perm:r1',
  blocks: [
    { t: 'head', key: 'h', title: 'Run npm test?' },
    { t: 'input', key: 'deny-why', placeholder: 'Or tell Claude what to do instead…', action: 'act:claude:deny-with:r1' },
    {
      t: 'buttons', key: 'answer',
      items: [
        { key: 'deny', label: 'Deny', action: 'act:claude:deny', arg: 'r1', style: 'danger' },
        { key: 'allow', label: 'Allow', action: 'act:claude:allow', arg: 'r1', style: 'primary' },
      ],
    },
  ],
};

/** A fake island: one pill, Control Center, Land's card, maybe an urgent Claude card. */
function fakeIsland() {
  const f = {
    frame: frame('a') as MirrorFrame | null,
    bot: { look: { state: 'idle', face: 'neutre', costume: [], motion: 'breathe' }, play: 1, strength: 0.5 } as BotState | null,
    grid: grid(),
    cards: { land: landCard } as Record<string, SheetView>,
    urgent: null as { id: string; view: SheetView } | null,
    allow: true,
    term: false,
    screen: 'ready' as ScreenState,
    folders: ['C:\\code\\island'] as string[],
    /** What act() throws, once. */
    fail: null as Error | null,
    widths: [] as number[],
    acts: [] as Array<[string, string, unknown]>,
    got: [] as PhoneDelivery[],
  };
  const hooks: PhoneIslandHooks = {
    pill: () => (f.frame ? { frame: f.frame, bot: f.bot } : null),
    view: (nav: Nav, width: number) => {
      f.widths.push(width);
      if (f.urgent) return { nav, view: f.urgent.view, urgent: f.urgent.id };
      if (nav.open === 'none') return { nav, view: null, urgent: null };
      if (nav.open === 'card' && f.cards[nav.id]) return { nav, view: f.cards[nav.id], urgent: null };
      return { nav: { open: 'grid' }, view: f.grid, urgent: null };
    },
    act: async (p, action, arg) => {
      f.acts.push([p, action, arg]);
      const err = f.fail;
      f.fail = null;
      if (err) throw err;
    },
    facts: () => ({ name: 'MossLaptop', platform: 'windows', version: '0.3.1', allow: f.allow, term: f.term, screen: f.screen, folders: [...f.folders] }),
    fromPhone: (item) => void f.got.push(item),
  };
  return { f, hooks };
}

/** A fake Rust: the phone list, what was sent, and events. */
function fakeRust() {
  const bus = new Map<string, Set<(p: unknown) => void>>();
  const r = {
    list: [] as PhoneInfo[],
    sent: [] as Array<{ phone: string | null; msg: IslandMsg }>,
    logs: [] as string[],
    clipText: 'from the PC' as string | null,
    emit: (event: string, payload: unknown) => {
      for (const cb of [...(bus.get(event) ?? [])]) cb(payload);
    },
    /** Rust's list changed: what it would emit. */
    phones: (list: PhoneInfo[]) => {
      r.list = list;
      r.emit('remote-phones', list);
    },
    line: (msg: unknown, from = IPHONE) => r.emit('remote-msg', { phone: from, msg }),
    types: (to = IPHONE) => r.sent.filter((x) => x.phone === to).map((x) => x.msg.t),
    last: <T extends IslandMsg['t']>(t: T, to = IPHONE) => r.sent.filter((x) => x.phone === to && x.msg.t === t).pop()?.msg as Extract<IslandMsg, { t: T }> | undefined,
  };
  const native: PhoneNative & { [k: string]: any } = {
    phones: vi.fn(async () => r.list),
    send: vi.fn(async (p: string | null, msg: IslandMsg) => {
      r.sent.push({ phone: p, msg });
      return true;
    }),
    vapid: vi.fn(async () => ''),
    push: vi.fn(async () => 1),
    copy: vi.fn(async () => true),
    clipboard: vi.fn(async () => ({ files: [], text: r.clipText })),
    lock: vi.fn(async () => undefined),
    log: (t: string) => void r.logs.push(t),
    on: async <T>(event: string, cb: (p: T) => void) => {
      let set = bus.get(event);
      if (!set) bus.set(event, (set = new Set()));
      set.add(cb as (p: unknown) => void);
      return () => void set!.delete(cb as (p: unknown) => void);
    },
  };
  return { r, native };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

async function setup(list: PhoneInfo[] = []) {
  const { f, hooks } = fakeIsland();
  const { r, native } = fakeRust();
  r.list = list;
  const hub = new PhoneHub(hooks, native);
  await hub.start();
  await flush();
  return { f, r, native, hub };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a phone connecting', () => {
  it('gets hello, then the pill and the view at once', async () => {
    const { r } = await setup();
    r.phones([phone()]);
    await flush();
    expect(r.types()).toEqual(['hello', 'pill', 'view']);
    expect(r.last('hello')).toEqual({ t: 'hello', v: 1, name: 'MossLaptop', platform: 'windows', version: '0.3.1', allow: true, vapid: null, term: false, screen: 'ready', folders: ['C:\\code\\island'] });
    expect(r.last('pill')?.bot?.play).toBe(1);
    expect(r.last('view')).toMatchObject({ nav: { open: 'grid' }, urgent: null, view: { key: 'island/grid' } });
  });

  it('greets phones already connected when the island starts, at an iPhone width until told', async () => {
    const { r, f } = await setup([phone(), phone(OTHER, false)]);
    expect(r.types()).toEqual(['hello', 'pill', 'view']);
    expect(r.types(OTHER)).toEqual([]);
    expect(f.widths).toEqual([DEFAULT_WIDTH]);
  });

  it('forgets a phone that goes offline: nothing more goes to it, and its lines are ignored', async () => {
    const { r, f, hub } = await setup([phone()]);
    r.phones([phone(IPHONE, false)]);
    f.grid = grid('Another song');
    hub.tick();
    r.line({ t: 'act', action: 'act:music:toggle' });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.types()).toEqual(['hello', 'pill', 'view']);
    expect(f.acts).toEqual([]);
    // Back online: a new session, greeted again.
    r.phones([phone()]);
    await flush();
    expect(r.types()).toEqual(['hello', 'pill', 'view', 'hello', 'pill', 'view']);
  });

  it("takes a phone's first line even when it beats the list that says it connected", async () => {
    const { r, f } = await setup();
    r.list = [phone()];
    r.line({ t: 'nav', open: 'card', id: 'land' });
    await flush();
    expect(r.types()).toEqual(['hello', 'pill', 'view', 'view']);
    expect(r.last('view')?.nav).toEqual({ open: 'card', id: 'land' });
    expect(f.widths.length).toBe(2);
  });
});

describe('what goes to a phone', () => {
  it('sends a view only when it changed', async () => {
    const { r, f, hub } = await setup([phone()]);
    await vi.advanceTimersByTimeAsync(1000);
    hub.tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.types().filter((t) => t === 'view')).toHaveLength(1);
    f.grid = grid('Next song');
    hub.tick();
    await flush();
    expect(r.types().filter((t) => t === 'view')).toHaveLength(2);
    expect(JSON.stringify(r.last('view'))).toContain('Next song');
  });

  it('sends at most 8 views a second, and the last state always goes out', async () => {
    const { r, f, hub } = await setup([phone()]);
    const before = r.types().filter((t) => t === 'view').length;
    for (let i = 0; i < 100; i++) {
      f.grid = grid(`Song ${i}`);
      hub.tick();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(500);
    const views = r.sent.filter((x) => x.msg.t === 'view');
    // 100 changes over a second: about 8 views, never more than 9 counting the one at the start.
    expect(views.length - before).toBeLessThanOrEqual(9);
    expect(views.length - before).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(views[views.length - 1].msg)).toContain('Song 99');
  });

  it('sends the pill when it changed (or nods), not on every compose', async () => {
    const { r, f, hub } = await setup([phone()]);
    await vi.advanceTimersByTimeAsync(1000);
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.types().filter((t) => t === 'pill')).toHaveLength(1);
    f.frame = frame('b');
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.last('pill')?.frame.sig).toBe('b');
    // The bot changed alone: that is news too.
    f.bot = { ...f.bot!, play: 2 };
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    // A nod once per frame, not again for the same frame.
    f.frame = { ...frame('b'), bump: true };
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.types().filter((t) => t === 'pill')).toHaveLength(4);
  });

  it('follows the phone: a card at its width, nothing, a card the island has not, back to the grid', async () => {
    const { r, f } = await setup([phone()]);
    r.line({ t: 'nav', open: 'card', id: 'land', width: 360 });
    await flush();
    expect(r.last('view')).toMatchObject({ nav: { open: 'card', id: 'land' }, view: { key: 'land/card' } });
    expect(f.widths.at(-1)).toBe(360);
    r.line({ t: 'nav', open: 'none' });
    await flush();
    expect(r.last('view')).toEqual({ t: 'view', nav: { open: 'none' }, view: null, urgent: null });
    // No card: Control Center, and the phone is told so.
    r.line({ t: 'nav', open: 'card', id: 'weather' });
    await flush();
    expect(r.last('view')).toMatchObject({ nav: { open: 'grid' }, view: { key: 'island/grid' } });
    expect(f.widths.at(-1)).toBe(360);
  });

  it('puts an urgent card first, whatever the phone was on', async () => {
    const { r, f, hub } = await setup([phone()]);
    f.urgent = { id: 'claude', view: permission };
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.last('view')).toMatchObject({ nav: { open: 'grid' }, urgent: 'claude', view: { key: 'claude/perm:r1' } });
  });
});

describe('what a phone may press', () => {
  async function pressing() {
    const s = await setup([phone()]);
    r = s.r;
    f = s.f;
    return s;
  }
  let r: ReturnType<typeof fakeRust>['r'];
  let f: ReturnType<typeof fakeIsland>['f'];
  const press = async (action: string, arg?: unknown) => {
    r.line(arg === undefined ? { t: 'act', action } : { t: 'act', action, arg });
    await flush();
  };

  it('runs what it was shown, as the island would', async () => {
    await pressing();
    await press('act:music:toggle');
    await press('act:land:card');
    expect(f.acts).toEqual([
      [IPHONE, 'act:music:toggle', undefined],
      [IPHONE, 'act:land:card', undefined],
    ]);
  });

  it("refuses what isn't on its screen, and says so", async () => {
    await pressing();
    await press('act:music:next');
    expect(f.acts).toEqual([]);
    expect(r.last('toast')).toEqual({ t: 'toast', text: "That button isn't there any more", tone: 'bad' });
    expect(r.logs.some((l) => l.includes('refused act:music:next'))).toBe(true);
  });

  it("only Quiet of the island's own: never opening windows, arranging or hiding", async () => {
    await pressing();
    for (const a of ['island:app', 'island:grid-edit', 'island:grid-reset', 'island:hide', 'island:anchor', 'island:card-close']) await press(a, 'settings');
    expect(f.acts).toEqual([]);
    await press('island:dnd');
    expect(f.acts).toEqual([[IPHONE, 'island:dnd', undefined]]);
  });

  it('presses a shown button only with the argument it was shown with; typed text is free', async () => {
    await pressing();
    r.line({ t: 'nav', open: 'card', id: 'land' });
    await flush();
    await press('act:land:open', 'C:\\Windows\\System32\\cmd.exe');
    expect(f.acts).toEqual([]);
    await press('act:land:open', 'C:\\Users\\moss\\Downloads\\photo.jpg');
    await press('act:land:stage-text', 'https://omnivox.ca');
    expect(f.acts.map((a) => a[2])).toEqual(['C:\\Users\\moss\\Downloads\\photo.jpg', 'https://omnivox.ca']);
  });

  it('presses what the pill shows, and nothing it no longer shows', async () => {
    const { hub } = await pressing();
    f.frame = frame('c', [chip('act:land:card')]);
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    f.grid = { key: 'island/grid', blocks: [] };
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    await press('act:land:card');
    expect(f.acts).toHaveLength(1);
    f.frame = frame('d');
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    await press('act:land:card');
    expect(f.acts).toHaveLength(1);
  });

  it('a view gone stale refuses its old buttons', async () => {
    const { hub } = await pressing();
    f.urgent = { id: 'claude', view: permission };
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.last('view')?.urgent).toBe('claude');
    f.urgent = null;
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.last('view')?.urgent).toBeNull();
    await press('act:claude:deny', 'r1');
    expect(f.acts).toEqual([]);
  });

  it('with Windows Hello asked before Allow: no Allow buttons, no Allow presses, Deny still works', async () => {
    const { r, f, hub } = await setup();
    f.allow = false;
    f.urgent = { id: 'claude', view: permission };
    r.phones([phone()]);
    await flush();
    expect(r.last('hello')?.allow).toBe(false);
    const sent = JSON.stringify(r.last('view'));
    expect(sent).toContain('act:claude:deny');
    expect(sent).not.toContain('act:claude:allow');
    r.line({ t: 'act', action: 'act:claude:allow', arg: 'r1' });
    await flush();
    expect(f.acts).toEqual([]);
    expect(r.last('toast')?.text).toBe('Allow needs Windows Hello, on the PC');
    r.line({ t: 'act', action: 'act:claude:deny', arg: 'r1' });
    await flush();
    expect(f.acts).toEqual([[IPHONE, 'act:claude:deny', 'r1']]);
    // Turned off again: Allow comes back.
    f.allow = true;
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.stringify(r.last('view'))).toContain('act:claude:allow');
  });

  it('ignores lines it cannot read', async () => {
    await pressing();
    r.line({ t: 'act', action: '' });
    r.line({ t: 'pair', code: 'x' });
    r.line('nonsense');
    await flush();
    expect(f.acts).toEqual([]);
    expect(r.logs.filter((l) => l.includes("doesn't read"))).toHaveLength(3);
  });
});

describe('cards opened from a phone', () => {
  it('open on that phone, which then shows the card; going back shows Control Center', async () => {
    const { r, hub } = await setup([phone(), phone(OTHER)]);
    hub.openCard(IPHONE, 'land');
    await flush();
    expect(r.last('view')?.nav).toEqual({ open: 'card', id: 'land' });
    expect(r.last('view', OTHER)?.nav).toEqual({ open: 'grid' });
    expect(hub.showsCard('land')).toBe(true);
    hub.closeCard(IPHONE, 'reminders');
    expect(hub.showsCard('land')).toBe(true);
    hub.closeCard(IPHONE, 'land');
    await flush();
    expect(r.last('view')?.nav).toEqual({ open: 'grid' });
    expect(hub.showsCard('land')).toBe(false);
  });

  it('PhoneActs knows which phone pressed what an activity is running, until it is done', async () => {
    const acts = new PhoneActs();
    let during: string | null = null;
    let release!: () => void;
    const running = acts.run('land', IPHONE, () => new Promise<void>((resolve) => {
      during = acts.phoneFor('land');
      release = resolve;
    }));
    expect(during).toBe(IPHONE);
    expect(acts.phoneFor('music')).toBeNull();
    release();
    await running;
    expect(acts.phoneFor('land')).toBeNull();
    // A failing action lets go too.
    await expect(acts.run('land', IPHONE, async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(acts.phoneFor('land')).toBeNull();
  });
});

describe('phone ↔ PC', () => {
  it('text from the phone goes on the clipboard and shows on the island', async () => {
    const { r, f, native } = await setup([phone()]);
    r.line({ t: 'text', text: 'https://omnivox.ca' });
    await flush();
    expect(native.copy).toHaveBeenCalledWith('https://omnivox.ca');
    expect(f.got).toEqual([{ kind: 'text', phone: IPHONE, from: 'iPhone', text: 'https://omnivox.ca' }]);
    expect(r.last('toast')).toEqual({ t: 'toast', text: 'Copied on MossLaptop', tone: 'good' });
  });

  it("answers clip-get with the PC clipboard's text, '' for none, cut to what a line holds", async () => {
    const { r } = await setup([phone()]);
    r.line({ t: 'clip-get' });
    await flush();
    expect(r.last('clip')).toEqual({ t: 'clip', text: 'from the PC' });
    r.clipText = null;
    r.line({ t: 'clip-get' });
    await flush();
    expect(r.last('clip')).toEqual({ t: 'clip', text: '' });
    r.clipText = 'x'.repeat(CLIP_MAX + 5);
    r.line({ t: 'clip-get' });
    await flush();
    expect(r.last('clip')?.text).toHaveLength(CLIP_MAX);
    expect(r.last('toast')?.tone).toBe('info');
  });

  it('locks the PC', async () => {
    const { r, native } = await setup([phone()]);
    r.line({ t: 'lock' });
    await flush();
    expect(native.lock).toHaveBeenCalledTimes(1);
    expect(r.last('toast')).toEqual({ t: 'toast', text: 'Locked', tone: 'good' });
  });

  it('shows a file the phone sent, named for the phone', async () => {
    const { r, f } = await setup([phone()]);
    r.emit('remote-file', { phone: IPHONE, id: 'f1', name: 'IMG_0001.JPG', path: 'C:\\Users\\moss\\Downloads\\IMG_0001.JPG', size: 2_000_000, mime: 'image/jpeg' });
    r.emit('remote-file', { phone: IPHONE, id: 'f2', path: '' });
    expect(f.got).toEqual([{ kind: 'file', phone: IPHONE, from: 'iPhone', id: 'f1', name: 'IMG_0001.JPG', path: 'C:\\Users\\moss\\Downloads\\IMG_0001.JPG', size: 2_000_000, mime: 'image/jpeg' }]);
  });
});

describe('terminals, the screen and folders in hello (2026-10-28)', () => {
  it('a fresh hello goes out when one of them changes, and only then', async () => {
    const { r, f, hub } = await setup([phone(), phone(OTHER)]);
    hub.tick();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.types().filter((t) => t === 'hello')).toHaveLength(1);
    f.term = true;
    hub.tick();
    await flush();
    expect(r.last('hello')?.term).toBe(true);
    expect(r.last('hello', OTHER)?.term).toBe(true);
    f.screen = 'off';
    hub.syncHello();
    await flush();
    expect(r.last('hello')?.screen).toBe('off');
    f.folders = ['C:\\code\\app', 'C:\\code\\island'];
    hub.tick();
    await flush();
    expect(r.last('hello')?.folders).toEqual(['C:\\code\\app', 'C:\\code\\island']);
    expect(r.types().filter((t) => t === 'hello')).toHaveLength(4);
    // Nothing changed: no hello.
    hub.tick();
    hub.syncHello();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.types().filter((t) => t === 'hello')).toHaveLength(4);
  });

  it('a fresh hello goes before the view it explains (Allow coming back)', async () => {
    const { r, f, hub } = await setup();
    f.allow = false;
    f.urgent = { id: 'claude', view: permission };
    r.phones([phone()]);
    await flush();
    f.allow = true;
    hub.tick();
    await vi.advanceTimersByTimeAsync(200);
    const types = r.types();
    expect(types.lastIndexOf('hello')).toBeLessThan(types.lastIndexOf('view'));
    expect(r.last('hello')?.allow).toBe(true);
  });

  it("a tap that goes wrong for the phone shows there as a toast; other failures only go to the log", async () => {
    const { r, f, hub } = await setup([phone()]);
    f.cards.claude = { key: 'claude/chats', blocks: [{ t: 'input', key: 'say', placeholder: 'Message Claude…', action: 'act:claude:say:S1' }] };
    hub.openCard(IPHONE, 'claude');
    await flush();
    f.fail = new PhoneError("Couldn't start Claude: claude is not installed");
    r.line({ t: 'act', action: 'act:claude:say:S1', arg: 'hello' });
    await flush();
    expect(f.acts).toEqual([[IPHONE, 'act:claude:say:S1', 'hello']]);
    expect(r.last('toast')).toEqual({ t: 'toast', text: "Couldn't start Claude: claude is not installed", tone: 'bad' });
    f.fail = new Error('a bug');
    r.line({ t: 'act', action: 'act:claude:say:S1', arg: 'again' });
    await flush();
    expect(r.types().filter((t) => t === 'toast')).toHaveLength(1);
    expect(r.logs.some((l) => l.includes('a bug'))).toBe(true);
  });

  it("knows a phone's name (the island says which phone opened a terminal)", async () => {
    const { hub } = await setup([phone(), phone(OTHER, false)]);
    expect(hub.phoneName(IPHONE)).toBe('iPhone');
    expect(hub.phoneName(OTHER)).toBe('Other');
    expect(hub.phoneName('nobody')).toBeNull();
  });

  it('terminals are allowed with the switch on, and not while Windows Hello guards Allow', () => {
    const s = defaultSettings();
    expect(s.general.phoneTerminal).toBe(false);
    expect(termAllowed(s)).toBe(false);
    s.general.phoneTerminal = true;
    expect(termAllowed(s)).toBe(true);
    s.activities.config.claude.options.requireHello = true;
    expect(termAllowed(s)).toBe(false);
  });
});

describe('notifications (phase 3)', () => {
  it('hello carries the push key, asked once and kept', async () => {
    const { r, native } = await setup();
    (native.vapid as ReturnType<typeof vi.fn>).mockResolvedValue('BPublicKeyOfIsland');
    r.phones([phone(), phone(OTHER)]);
    await flush();
    expect(r.last('hello')?.vapid).toBe('BPublicKeyOfIsland');
    expect(r.last('hello', OTHER)?.vapid).toBe('BPublicKeyOfIsland');
    expect(native.vapid).toHaveBeenCalledTimes(1);
  });

  it('pushes only when a paired phone turned notifications on', async () => {
    const { r, native, hub } = await setup([phone()]);
    hub.push('Needs permission · tests', 'Running command: npm test', 'lock', 'claude', true);
    expect(native.push).not.toHaveBeenCalled();
    r.phones([phone(IPHONE, false, { push: true })]);
    hub.push('Needs permission · tests', 'Running command: npm test', 'lock', 'claude', true);
    expect(native.push).toHaveBeenCalledWith('Needs permission · tests', 'Running command: npm test', 'lock', 'claude', true);
  });
});
