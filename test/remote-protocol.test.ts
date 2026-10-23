import { describe, expect, it } from 'vitest';
import { actionsIn, decodePair, encodePair, pairUrl, readIslandMsg, readPhoneMsg, relayUrl, type PairPayload } from '../src/remote/protocol';

const PAIR: PairPayload = {
  v: 1,
  id: 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0',
  relays: ['https://use1-1.relay.n0.iroh.iroh.link/'],
  code: '0123456789abcdef0123456789abcdef',
  name: 'Moss’s Laptop',
};

describe('the pairing code', () => {
  it('goes through the QR URL and back, accents and all', () => {
    const url = pairUrl(PAIR, 'https://island-phone.vercel.app/');
    expect(url.startsWith('https://island-phone.vercel.app/#pair=')).toBe(true);
    expect(url).not.toMatch(/[+/=]$/);
    expect(decodePair(url)).toEqual(PAIR);
    expect(decodePair(`#pair=${encodePair(PAIR)}`)).toEqual(PAIR);
    expect(decodePair(encodePair(PAIR))).toEqual(PAIR);
  });

  it('drops the trailing dot from relay names, which hangs a browser', () => {
    expect(relayUrl('https://use1-1.relay.n0.iroh.iroh.link./')).toBe('https://use1-1.relay.n0.iroh.iroh.link/');
    expect(relayUrl('https://use1-1.relay.n0.iroh.iroh.link.')).toBe('https://use1-1.relay.n0.iroh.iroh.link/');
    expect(relayUrl('http://plain.example/')).toBeNull();
    expect(relayUrl('not a url')).toBeNull();
    const dotted = { ...PAIR, relays: ['https://use1-1.relay.n0.iroh.iroh.link./'] };
    expect(decodePair(encodePair(dotted))?.relays).toEqual(['https://use1-1.relay.n0.iroh.iroh.link/']);
  });

  it('refuses anything that is not a well-formed version 1 code', () => {
    expect(decodePair('')).toBeNull();
    expect(decodePair('https://island-phone.vercel.app/#pair=%%%')).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, v: 2 } as unknown as PairPayload))).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, code: 'short' }))).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, code: PAIR.code.toUpperCase() }))).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, relays: [] }))).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, relays: ['ftp://x/'] }))).toBeNull();
    expect(decodePair(encodePair({ ...PAIR, id: 'has spaces in it, not an id' }))).toBeNull();
  });
});

describe("a phone's lines", () => {
  it('keeps what the island handles and drops the rest', () => {
    expect(readPhoneMsg({ t: 'nav', open: 'grid', width: 390.4 })).toEqual({ t: 'nav', open: 'grid', width: 390 });
    expect(readPhoneMsg({ t: 'nav', open: 'card', id: 'music' })).toEqual({ t: 'nav', open: 'card', id: 'music' });
    expect(readPhoneMsg({ t: 'nav', open: 'card' })).toBeNull();
    expect(readPhoneMsg({ t: 'nav', open: 'grid', width: 5 })).toEqual({ t: 'nav', open: 'grid' });
    expect(readPhoneMsg({ t: 'act', action: 'act:music:toggle' })).toEqual({ t: 'act', action: 'act:music:toggle' });
    expect(readPhoneMsg({ t: 'act', action: 'act:timer:start', arg: { min: 25 } })).toEqual({ t: 'act', action: 'act:timer:start', arg: { min: 25 } });
    expect(readPhoneMsg({ t: 'act', action: '' })).toBeNull();
    expect(readPhoneMsg({ t: 'text', text: '  ' })).toBeNull();
    expect(readPhoneMsg({ t: 'text', text: 'https://omnivox.ca' })).toEqual({ t: 'text', text: 'https://omnivox.ca' });
    expect(readPhoneMsg({ t: 'lock', extra: 1 })).toEqual({ t: 'lock' });
    // Rust's own lines never reach the island's TypeScript as these.
    expect(readPhoneMsg({ t: 'pair', code: PAIR.code })).toBeNull();
    expect(readPhoneMsg('nav')).toBeNull();
  });

  it("reads the island's lines the phone draws", () => {
    expect(readIslandMsg({ t: 'hello', v: 1, name: 'MossLaptop', platform: 'windows', version: '0.3.1', allow: true, vapid: null })).not.toBeNull();
    expect(readIslandMsg({ t: 'hello', v: 1, name: 'MossLaptop', platform: 'linux', version: '0.3.1', allow: true, vapid: null })).toBeNull();
    expect(readIslandMsg({ t: 'view', nav: { open: 'grid' }, view: { key: 'k', blocks: [] }, urgent: null })).not.toBeNull();
    expect(readIslandMsg({ t: 'view', nav: { open: 'grid' }, view: { key: 'k' }, urgent: null })).toBeNull();
    expect(readIslandMsg({ t: 'pill', frame: { placed: [] }, bot: null })).not.toBeNull();
    expect(readIslandMsg({ t: 'denied', why: 'code' })).toEqual({ t: 'denied', why: 'code' });
    expect(readIslandMsg({ t: 'denied', why: 'other' })).toBeNull();
  });
});

describe('what a phone may press', () => {
  it('is every action a view or pill offers: buttons, rows, tiles, inputs, the player', () => {
    const view = {
      key: 'island/grid',
      blocks: [
        { t: 'head', key: 'h', title: 'x', buttons: [{ key: 'b', label: 'Close', action: 'act:land:close' }] },
        { t: 'input', key: 'i', placeholder: 'Reply', action: 'act:claude:reply', engage: 'island:sheet-engage' },
        { t: 'rows', key: 'r', items: [{ key: 'a', title: 'Island', action: 'act:workspaces:restore', arg: 'ws_1', button: { key: 'x', label: '', action: 'act:phone:hide' } }] },
        { t: 'tiles', key: 'g', cols: 4, rows: 4, pages: 1, cell: 92, items: [{ key: 'music/m', action: 'act:music:open', body: { k: 'media', title: 't', artist: 'a', playing: true, buttons: [{ key: 'p', label: '', action: 'act:music:toggle' }] } }] },
        { t: 'player', key: 'p', art: null, title: 't', artist: 'a', playing: true, position: 1, duration: 2, color: null, actions: { prev: 'act:music:prev', toggle: 'act:music:toggle', next: 'act:music:next', seek: 'act:music:seek' } },
      ],
    };
    const pill = { placed: [{ seg: { t: 'input', key: 'in', placeholder: 'Ask', action: 'act:claude:send', cancel: 'island:cancel-input' } }] };
    expect([...actionsIn([view, pill])].sort()).toEqual(
      ['act:claude:reply', 'act:claude:send', 'act:land:close', 'act:music:next', 'act:music:open', 'act:music:prev', 'act:music:seek', 'act:music:toggle', 'act:phone:hide', 'act:workspaces:restore', 'island:cancel-input', 'island:sheet-engage'].sort(),
    );
  });
});
