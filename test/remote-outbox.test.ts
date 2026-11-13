// What the PC sends a phone while Island is closed there (src/remote/outbox.ts, and the hub that
// holds it): bounded and short-lived, notified once, delivered on connect, never held for a
// connected phone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneHub, type PhoneInfo, type PhoneIslandHooks, type PhoneNative } from '../src/remote/hub';
import { heldPush, heldWhat, holdForPhone, OUTBOX_MAX, OUTBOX_TEXT_MAX, OUTBOX_TTL_MS, PhoneOutbox, PREVIEW_MAX, type HeldEnd, type HeldItem } from '../src/remote/outbox';
import { INBOX_OPEN, type IslandMsg } from '../src/remote/protocol';
import { INBOX_READY_MS, inboxReady } from '../phone/web/src/routing';

const T0 = Date.parse('2026-11-12T14:00:00Z');
const PH = 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0';
const note = (text: string, settle?: (e: HeldEnd) => void): HeldItem => ({ kind: 'text', text, from: 'MossLaptop', settle });
const pic = (name = 'photo.jpg', settle?: (e: HeldEnd) => void): HeldItem => ({ kind: 'file', path: `C:\\Users\\moss\\Pictures\\${name}`, name, size: 1234, settle });

describe('the outbox', () => {
  it('keeps the newest OUTBOX_MAX per phone, dropping the oldest', () => {
    const box = new PhoneOutbox();
    const ends: string[] = [];
    for (let i = 0; i < OUTBOX_MAX + 2; i++) box.add(PH, note(`n${i}`, (e) => ends.push(`n${i}:${e}`)), T0 + i);
    expect(ends).toEqual(['n0:dropped', 'n1:dropped']);
    const got = box.take(PH, T0 + 100);
    expect(got.map((x) => (x.kind === 'text' ? x.text : ''))).toEqual(Array.from({ length: OUTBOX_MAX }, (_, i) => `n${i + 2}`));
    expect(box.take(PH, T0 + 100)).toEqual([]);
  });

  it('drops what waited a day', () => {
    const box = new PhoneOutbox();
    const ends: string[] = [];
    box.add(PH, note('old', (e) => ends.push(`old:${e}`)), T0);
    box.add(PH, pic('new.jpg'), T0 + OUTBOX_TTL_MS - 1000);
    expect(box.count(PH, T0 + OUTBOX_TTL_MS)).toBe(1);
    expect(ends).toEqual(['old:dropped']);
    expect(box.take(PH, T0 + OUTBOX_TTL_MS).map((x) => x.kind)).toEqual(['file']);
  });

  it('refuses text too long to wait, and forgets an unpaired phone', () => {
    const box = new PhoneOutbox();
    expect(box.add(PH, note('x'.repeat(OUTBOX_TEXT_MAX + 1)), T0)).toBe(false);
    const ends: string[] = [];
    box.add(PH, note('hi', (e) => ends.push(e)), T0);
    box.forget(PH);
    expect(ends).toEqual(['dropped']);
    expect(box.count(PH, T0)).toBe(0);
  });
});

describe('the notification', () => {
  it('names the kind, opens the inbox and folds into one', () => {
    expect(heldPush(pic(), 'MossLaptop')).toEqual({ title: 'MossLaptop sent you a picture', body: 'Tap to save it to Photos.', tag: INBOX_OPEN, open: INBOX_OPEN });
    expect(heldPush({ kind: 'file', path: 'C:\\a.pdf', name: 'a.pdf', size: 1 }, 'PC').title).toBe('PC sent you a file');
    expect(heldPush(note('https://example.com/some/long/path?q=secret'), 'PC')).toMatchObject({ title: 'PC sent you a link', body: 'example.com' });
    expect(heldWhat({ kind: 'file', path: 'x', name: 'scan', size: 1, mime: 'image/png' })).toBe('a picture');
  });

  it('shows only a short preview of a note', () => {
    const n = heldPush(note('a'.repeat(500)), 'PC');
    expect(n.title).toBe('PC sent you a note');
    expect(n.body.length).toBe(PREVIEW_MAX);
    expect(heldPush(note('buy\n  milk'), 'PC').body).toBe('buy milk');
  });
});

describe('the phone, after a tapped notification', () => {
  it('shows what arrives ready for a while', () => {
    const until = T0 + INBOX_READY_MS;
    expect(inboxReady(until, T0 + 1000)).toBe(true);
    expect(inboxReady(until, until)).toBe(false);
    expect(inboxReady(0, T0)).toBe(false);
  });
});

// ------------------------------------------------------------------ the hub holding and delivering

function setupHub(list: PhoneInfo[]) {
  const bus = new Map<string, Set<(p: unknown) => void>>();
  const sent: Array<{ phone: string | null; msg: IslandMsg }> = [];
  const pushes: Array<[string, string, string, string, boolean]> = [];
  const files: Array<[string, string]> = [];
  const state = { list };
  const native: PhoneNative = {
    phones: async () => state.list,
    send: async (phone, msg) => {
      sent.push({ phone, msg });
      return true;
    },
    vapid: async () => '',
    push: async (...a) => {
      pushes.push(a);
      return 1;
    },
    sendFile: async (phone, path) => void files.push([phone, path]),
    copy: async () => true,
    clipboard: async () => ({ files: [], text: null }),
    lock: async () => undefined,
    log: () => undefined,
    on: async <T>(event: string, cb: (p: T) => void) => {
      let set = bus.get(event);
      if (!set) bus.set(event, (set = new Set()));
      set.add(cb as (p: unknown) => void);
      return () => void set!.delete(cb as (p: unknown) => void);
    },
  };
  const hooks: PhoneIslandHooks = {
    pill: () => null,
    view: (nav) => ({ nav, view: null, urgent: null }),
    act: async () => undefined,
    facts: () => ({ name: 'MossLaptop', platform: 'windows', version: '0.4.2', allow: true, term: false, screen: 'ready', folders: [] }),
    fromPhone: () => undefined,
  };
  const phones = (l: PhoneInfo[]) => {
    state.list = l;
    for (const cb of bus.get('remote-phones') ?? []) cb(l);
  };
  return { hub: new PhoneHub(hooks, native), sent, pushes, files, phones };
}

const iphone = (connected: boolean, push = true): PhoneInfo => ({ id: PH, name: 'iPhone', pairedAt: T0 - 86_400_000, lastSeen: T0, connected, push });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('the hub', () => {
  beforeEach(() => void vi.useFakeTimers({ now: T0 }));
  afterEach(() => void vi.useRealTimers());

  it('holds nothing for a connected phone: it is sent as always, no push', async () => {
    const h = setupHub([iphone(true)]);
    await h.hub.start();
    await flush();
    expect(holdForPhone(PH, note('hi'))).toBe(false);
    expect(h.pushes).toEqual([]);
    h.hub.stop();
  });

  it('holds for a closed phone, notifies it, and delivers on connect after hello', async () => {
    const h = setupHub([iphone(false)]);
    await h.hub.start();
    await flush();
    const ends: string[] = [];
    expect(holdForPhone(PH, note('https://example.com', (e) => ends.push(`t:${e}`)))).toBe(true);
    expect(holdForPhone(PH, pic('cat.jpg', (e) => ends.push(`f:${e}`)))).toBe(true);
    expect(h.pushes).toEqual([
      ['MossLaptop sent you a link', 'example.com', INBOX_OPEN, INBOX_OPEN, false],
      ['MossLaptop sent you a picture', 'Tap to save it to Photos.', INBOX_OPEN, INBOX_OPEN, false],
    ]);
    expect(h.hub.held(PH)).toBe(2);
    expect(h.sent).toEqual([]);

    h.phones([iphone(true)]);
    await flush();
    const types = h.sent.filter((x) => x.phone === PH).map((x) => x.msg.t);
    expect(types[0]).toBe('hello');
    expect(h.sent.find((x) => x.msg.t === 'text')?.msg).toEqual({ t: 'text', text: 'https://example.com', from: 'MossLaptop' });
    expect(h.files).toEqual([[PH, 'C:\\Users\\moss\\Pictures\\cat.jpg']]);
    expect(ends).toEqual(['t:sent', 'f:sent']);
    expect(h.hub.held(PH)).toBe(0);
    h.hub.stop();
  });

  it('holds but does not notify a phone that has notifications off', async () => {
    const h = setupHub([iphone(false, false), { ...iphone(false), id: 'other', name: 'iPad' }]);
    await h.hub.start();
    await flush();
    expect(holdForPhone(PH, note('hi'))).toBe(true);
    expect(h.pushes).toEqual([]);
    h.hub.stop();
  });

  it('holds nothing for an unknown phone, or once the hub stopped', async () => {
    const h = setupHub([iphone(false)]);
    await h.hub.start();
    await flush();
    expect(holdForPhone('nobody', note('hi'))).toBe(false);
    h.hub.stop();
    expect(holdForPhone(PH, note('hi'))).toBe(false);
  });

  it('drops what waited for a phone that was unpaired', async () => {
    const h = setupHub([iphone(false)]);
    await h.hub.start();
    await flush();
    const ends: string[] = [];
    holdForPhone(PH, note('hi', (e) => ends.push(e)));
    h.phones([]);
    expect(ends).toEqual(['dropped']);
    h.hub.stop();
  });
});
