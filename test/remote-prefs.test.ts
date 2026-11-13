import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/core/settings';
import { PhoneHub, type PhoneIslandHooks, type PhoneNative } from '../src/remote/hub';
import { applyPref, prefsOf } from '../src/remote/prefs';
import { readIslandMsg, readPhoneMsg, type IslandMsg } from '../src/remote/protocol';

describe('prefs lines', () => {
  it('reads prefs-get and pref, and refuses bad keys and values', () => {
    expect(readPhoneMsg({ t: 'prefs-get' })).toEqual({ t: 'prefs-get' });
    expect(readPhoneMsg({ t: 'pref', key: 'island.glass', value: 40 })).toEqual({ t: 'pref', key: 'island.glass', value: 40 });
    expect(readPhoneMsg({ t: 'pref', key: 'act:music:enabled', value: false })).toEqual({ t: 'pref', key: 'act:music:enabled', value: false });
    expect(readPhoneMsg({ t: 'pref', key: 'island glass', value: 1 })).toBeNull();
    expect(readPhoneMsg({ t: 'pref', key: 'island.glass', value: { x: 1 } })).toBeNull();
    expect(readPhoneMsg({ t: 'pref', key: 'island.glass', value: Infinity })).toBeNull();
    expect(readPhoneMsg({ t: 'pref', key: 'island.color' })).toBeNull();
  });

  it('reads the PC prefs and drops malformed rows', () => {
    const { rows, acts } = prefsOf(defaultSettings());
    const m = readIslandMsg(JSON.parse(JSON.stringify({ t: 'prefs', rows: [...rows, { key: 'x', kind: 'nope' }], acts: [...acts, { id: 5 }] })));
    expect(m).toEqual({ t: 'prefs', rows, acts });
    expect(readIslandMsg({ t: 'prefs', rows: 'no', acts: [] })).toBeNull();
  });
});

describe('the allow-list', () => {
  it('changes an allowed setting and an activity', () => {
    const s = defaultSettings();
    expect(applyPref(s, 'island.glass', 30)).toBe(true);
    expect(s.island.glass).toBe(30);
    expect(applyPref(s, 'general.dnd', true)).toBe(true);
    expect(s.general.dnd).toBe(true);
    expect(applyPref(s, 'island.anchor', 'bottom')).toBe(true);
    expect(s.island.anchor).toBe('bottom');
    const id = s.activities.order.find((x) => x !== 'claude')!;
    expect(applyPref(s, `act:${id}:enabled`, false)).toBe(true);
    expect(s.activities.config[id].enabled).toBe(false);
    expect(applyPref(s, `act:${id}:grows`, 'card')).toBe(true);
    expect(s.activities.config[id].grows).toBe('card');
    expect(prefsOf(s).acts.find((a) => a.id === id)).toMatchObject({ enabled: false, grows: 'card' });
  });

  it('refuses keys off the list, wrong types and out-of-range values, leaving settings alone', () => {
    const s = defaultSettings();
    const before = JSON.stringify(s);
    for (const [key, value] of [
      ['general.phoneTerminal', true],
      ['general.phoneTopic', 'mine'],
      ['general.autoUpdate', false],
      ['general.toggleHotkey', 'Ctrl+A'],
      ['island.edge', 4],
      ['__proto__', true],
      ['island.glass', 101],
      ['island.glass', 'clear'],
      ['island.color', 'pink'],
      ['island.hoverExpand', 'yes'],
      ['act:nope:enabled', true],
      ['act:claude:options', true],
      ['act:music:grows', 'below'],
      ['act:__proto__:enabled', false],
    ] as Array<[string, boolean | string | number]>) {
      expect(applyPref(s, key, value), key).toBe(false);
    }
    expect(JSON.stringify(s)).toBe(before);
  });

  it('never lists a security setting', () => {
    const keys = prefsOf(defaultSettings()).rows.map((r) => r.key);
    expect(keys).toContain('general.dnd');
    expect(keys.some((k) => /phone|topic|hotkey|autoUpdate|startWith|privacy|display/i.test(k))).toBe(false);
  });
});

describe('the hub and prefs', () => {
  async function setup() {
    let settings = defaultSettings();
    const sent: IslandMsg[] = [];
    let onMsg: (e: unknown) => void = () => {};
    const hooks: PhoneIslandHooks = {
      pill: () => null,
      view: (nav) => ({ nav, view: null, urgent: null }),
      act: async () => {},
      facts: () => ({ name: 'PC', platform: 'windows', version: '0', allow: true, term: false, screen: null, folders: [] }),
      fromPhone: () => {},
      prefs: () => prefsOf(settings),
      setPref: (key, value) => {
        const next = structuredClone(settings);
        if (!applyPref(next, key, value)) return false;
        settings = next;
        return true;
      },
    };
    const native: PhoneNative = {
      phones: async () => [{ id: 'p1', name: 'iPhone', pairedAt: 0, lastSeen: 0, connected: true, push: false }],
      send: vi.fn(async (_p: string | null, m: IslandMsg) => (sent.push(m), true)) as PhoneNative['send'],
      vapid: async () => '',
      push: async () => 0,
      copy: async () => true,
      clipboard: async () => ({ files: [], text: null }),
      lock: async () => undefined,
      log: () => {},
      on: async <T,>(event: string, cb: (p: T) => void) => {
        if (event === 'remote-msg') onMsg = cb as (e: unknown) => void;
        return () => {};
      },
    };
    const hub = new PhoneHub(hooks, native);
    await hub.start();
    const line = async (msg: unknown) => {
      onMsg({ phone: 'p1', msg });
      await new Promise((r) => setTimeout(r, 0));
    };
    const prefs = () => sent.filter((m): m is Extract<IslandMsg, { t: 'prefs' }> => m.t === 'prefs');
    return { hub, sent, line, prefs, get: () => settings };
  }

  it('sends prefs only once asked, applies an allowed change and sends the new values', async () => {
    const t = await setup();
    t.hub.tick();
    await t.line({ t: 'nav', open: 'grid' });
    expect(t.prefs()).toHaveLength(0);
    await t.line({ t: 'prefs-get' });
    expect(t.prefs()).toHaveLength(1);
    await t.line({ t: 'pref', key: 'general.dnd', value: true });
    expect(t.get().general.dnd).toBe(true);
    expect(t.prefs().at(-1)!.rows.find((r) => r.key === 'general.dnd')?.value).toBe(true);
  });

  it('refuses a key off the allow-list with a toast', async () => {
    const t = await setup();
    await t.line({ t: 'pref', key: 'general.phoneTerminal', value: true });
    expect(t.get().general.phoneTerminal).toBe(false);
    expect(t.sent.some((m) => m.t === 'toast' && m.tone === 'bad')).toBe(true);
  });
});
