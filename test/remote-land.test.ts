// Land and Island on your phone: connected phones as send targets beside computers and friends,
// and what a phone sends shown the way Land shows what another computer sent.

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
import type { RemotePhone } from '../src/core/native';
import { defaultSettings } from '../src/core/settings';
import type { Block, SheetView } from '../src/core/sheet';
import { LandActivity, PHONE } from '../src/activities/land';

const T0 = Date.parse('2026-10-22T12:00:00Z');
const IPHONE = 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0';
const phone = (connected = true, name = "Moss's iPhone"): RemotePhone => ({ id: IPHONE, name, pairedAt: T0 - 86_400_000, lastSeen: T0, connected, push: false });
const MAC = { id: 'a1b2c3d4e5f60718', name: "Moss's MacBook Air", os: 'macos' };

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function resetNative(phones: RemotePhone[]) {
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  Object.assign(h.native, {
    isTauri: true,
    demo: false,
    landStart: vi.fn(async (name: string | null, visible: boolean) => ({ ok: true, value: { id: 'me0000000000000a', name: name ?? 'DESKTOP-MOSS', visible, peers: [], fresh: false, friends: [] } })),
    landStop: vi.fn(async () => undefined),
    landScan: vi.fn(async () => []),
    landPlace: vi.fn(async () => []),
    landFriendsOnline: vi.fn(async () => []),
    landFirewall: vi.fn(async () => ({ state: 'ok', network: '' })),
    landSend: vi.fn(async (peer: string) => ({ ok: true, value: `out-${peer}` })),
    landSendText: vi.fn(async (peer: string) => ({ ok: true, value: `text-${peer}` })),
    landStage: vi.fn(async (paths: string[]) => paths.map((p) => ({ path: p, name: p.split('\\').pop(), size: 1000, dir: !p.includes('.'), files: p.includes('.') ? 1 : 12, error: null }))),
    remotePhones: vi.fn(async () => phones),
    remoteSend: vi.fn(async () => true),
    remoteSendFile: vi.fn(async (_phone: string, path: string) => ({ ok: true, value: `file-${path}` })),
    clipboardSetText: vi.fn(async () => true),
    openUrl: vi.fn(async () => true),
    open: vi.fn(async () => true),
    reveal: vi.fn(async () => true),
  });
}

async function boot(phones: RemotePhone[] = [phone()]) {
  resetNative(phones);
  const settings = defaultSettings();
  const surfaced: Array<{ key?: string }> = [];
  const act = new LandActivity();
  const ctx = {
    id: 'land', config: () => settings.activities.config.land, options: () => ({ visible: true, name: '' }) as never, settings: () => settings,
    update: () => {}, surface: (o?: { key?: string }) => void surfaced.push(o ?? {}), alert: () => {}, open: () => {}, close: () => {},
    isOpen: () => false, isPrimary: () => true, notify: () => {}, log: () => {}, openCard: () => {}, closeCard: () => {}, cardOpen: () => true,
  } as unknown as ActivityContext;
  await act.start(ctx);
  await tick(0);
  return { act, surfaced };
}

const env = (over: Partial<RenderEnv> = {}): RenderEnv => ({ level: 'expanded', width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheetEnv = (reason: SheetEnv['reason']): SheetEnv => ({ reason, now: Date.now(), width: 520, vertical: false, interactive: true, surfaced: null });
const block = <T extends Block['t']>(v: SheetView | null, t: T) => v?.blocks.find((b) => b.t === t) as Extract<Block, { t: T }> | undefined;
const people = (act: LandActivity) => block(act.sheet(sheetEnv('open')), 'people')?.items ?? [];
const sendButton = (act: LandActivity) => block(act.sheet(sheetEnv('open')), 'buttons')?.items[0];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('your phones in Land', () => {
  it('shows connected phones as avatars beside the computers, a phone badge on each', async () => {
    const { act } = await boot();
    emit('land-peers', [MAC]);
    const list = people(act);
    expect(list.map((p) => p.name)).toEqual(["Moss's MacBook Air", "Moss's iPhone"]);
    expect(list[1]).toMatchObject({ key: `${PHONE}${IPHONE}`, sub: 'Phone', badge: 'phone', initials: 'MI', action: 'pick' });
    // Gone offline: off the list, and no longer picked.
    await act.action('pick', `${PHONE}${IPHONE}`);
    emit('remote-phones', [phone(false)]);
    expect(people(act).map((p) => p.name)).toEqual(["Moss's MacBook Air"]);
  });

  it('sends each file to a phone, folders staying here, and circles its avatar until it arrives', async () => {
    const { act, surfaced } = await boot();
    act.drop(['C:\\Users\\moss\\report.pdf', 'C:\\Users\\moss\\photo.jpg', 'C:\\Users\\moss\\Trip']);
    await tick(0);
    // The phone is the only one there: it is who Send goes to.
    expect(sendButton(act)?.label).toBe("Send to Moss's iPhone");
    await act.action('send', null);
    expect(h.native.remoteSendFile.mock.calls).toEqual([
      [IPHONE, 'C:\\Users\\moss\\report.pdf'],
      [IPHONE, 'C:\\Users\\moss\\photo.jpg'],
    ]);
    expect(h.native.landSend).not.toHaveBeenCalled();
    const avatar = people(act)[0];
    expect(avatar).toMatchObject({ progress: null, sub: 'Sending…' });
    expect(act.render(env()).find((s) => s.key === 'pct')).toMatchObject({ text: 'Sending' });
    expect(JSON.stringify(act.sheet(sheetEnv('open')))).toContain('Folders stayed here');
    emit('remote-file-sent', { phone: IPHONE, name: 'photo.jpg', ok: true });
    emit('remote-file-sent', { phone: IPHONE, name: 'report.pdf', ok: false, error: 'The phone ran out of memory' });
    const rows = block(act.sheet(sheetEnv('open')), 'rows');
    const details = JSON.stringify(act.sheet(sheetEnv('open')));
    expect(details).toContain('The phone ran out of memory');
    expect(rows).toBeDefined();
    expect(surfaced.some((s) => s.key?.startsWith('end:phone-out-'))).toBe(true);
  });

  it('a phone that does not take the file says why', async () => {
    const { act } = await boot();
    h.native.remoteSendFile = vi.fn(async () => ({ ok: false, error: 'That phone is not connected.' }));
    act.drop(['C:\\Users\\moss\\report.pdf']);
    await tick(0);
    await act.action('send', null);
    expect(JSON.stringify(act.sheet(sheetEnv('open')))).toContain('That phone is not connected.');
  });

  it('sends text to a phone as one line, with this computer as who it is from', async () => {
    const { act } = await boot();
    h.native.landScan = vi.fn(async () => [MAC]);
    emit('land-peers', [MAC]);
    await act.action('stage-text', 'https://omnivox.ca');
    await tick(0);
    await act.action('pick', `${PHONE}${IPHONE}`);
    await act.action('pick', MAC.id);
    expect(sendButton(act)?.label).toBe('Send to 2 devices');
    await act.action('send', null);
    expect(h.native.remoteSend).toHaveBeenCalledWith(IPHONE, { t: 'text', text: 'https://omnivox.ca', from: 'DESKTOP-MOSS' });
    expect(h.native.landSendText).toHaveBeenCalledWith(MAC.id, 'https://omnivox.ca');
  });
});

describe('what a phone sends', () => {
  it('a file shows like one from another computer: from the phone, Open and Show in folder', async () => {
    const { act, surfaced } = await boot();
    act.fromPhone({ kind: 'file', phone: IPHONE, from: "Moss's iPhone", id: 'f1', name: 'IMG_0001.JPG', path: 'C:\\Users\\moss\\Downloads\\IMG_0001.JPG', size: 2_000_000, mime: 'image/jpeg' });
    expect(surfaced.at(-1)?.key).toBe('end:phone-in-f1');
    const pill = act.render(env());
    expect(pill.find((s) => s.key === 'end')).toMatchObject({ text: "IMG_0001.JPG from Moss's iPhone" });
    expect(pill.find((s) => s.key === 'open')).toMatchObject({ action: 'open', arg: 'C:\\Users\\moss\\Downloads\\IMG_0001.JPG' });
    const card = act.sheet(sheetEnv('surfaced'));
    expect(block(card, 'buttons')?.items[0]).toMatchObject({ label: 'Show in folder', action: 'show' });
  });

  it('text shows with its phone, already copied; a link can be opened, and copied again', async () => {
    const { act } = await boot();
    act.fromPhone({ kind: 'text', phone: IPHONE, from: "Moss's iPhone", text: 'https://omnivox.ca' });
    const card = act.sheet(sheetEnv('surfaced'));
    expect(block(card, 'head')).toMatchObject({ title: "Moss's iPhone sent you a link", sub: 'Copied to the clipboard' });
    const buttons = block(card, 'buttons')!.items;
    expect(buttons.map((b) => b.action)).toEqual(['copy-text', 'open-text']);
    await act.action('open-text', buttons[1].arg);
    expect(h.native.openUrl).toHaveBeenCalledWith('https://omnivox.ca');
    await act.action('copy-text', buttons[0].arg);
    expect(h.native.clipboardSetText).toHaveBeenCalledWith('https://omnivox.ca');
    // Later, in Land's list: a tap opens the link.
    const row = block(act.sheet(sheetEnv('open')), 'rows')?.items.find((r) => r.title.includes('a link'));
    expect(row).toMatchObject({ action: 'open-text' });
  });

  it('gives its computer name for phones to be greeted with', async () => {
    const { act } = await boot();
    expect(act.computerName()).toBe('DESKTOP-MOSS');
  });
});
