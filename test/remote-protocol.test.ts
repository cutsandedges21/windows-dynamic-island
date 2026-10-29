import { describe, expect, it } from 'vitest';
import {
  actionsIn, decodePair, encodePair, HELLO_FOLDERS, MAX_ACTION, MAX_TERMS, pairUrl, readIslandMsg, readPhoneMsg, readTermHeader, readTermInfo, readTermReply, relayUrl,
  TERM_DATA, TERM_EXIT, TERM_FRAME_MAX, TERM_REPLAY_MAX, TERM_RESIZE, TERM_SIZE_MAX, TERM_TITLE, type PairPayload, type PhoneControl, type TermInfo,
} from '../src/remote/protocol';

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

  it("takes Claude's New chat, whose action names its folder, up to MAX_ACTION", () => {
    const folder = `C:\\Users\\moss\\${'deep\\'.repeat(40)}project`;
    const action = `act:claude:say:new:${folder}`;
    expect(action.length).toBeGreaterThan(200);
    expect(readPhoneMsg({ t: 'act', action, arg: 'Write the README' })).toEqual({ t: 'act', action, arg: 'Write the README' });
    expect(readPhoneMsg({ t: 'act', action: 'x'.repeat(MAX_ACTION + 1) })).toBeNull();
  });
});

// ---------------------------------------------------------------- terminals, the screen, folders (2026-10-28)

const HELLO = { t: 'hello', v: 1, name: 'MossLaptop', platform: 'windows', version: '0.4.1', allow: true, vapid: null };
const TERM: TermInfo = { id: 'a1b2c3d4', title: 'PowerShell', cwd: 'C:\\Users\\moss', shell: 'powershell', pid: 4321, started: 1_761_660_000_000, exit: null, attached: 1, claude: false };

describe('hello', () => {
  it("from an older island (no terminals, screen or folders): none of them", () => {
    expect(readIslandMsg(HELLO)).toEqual({ ...HELLO, term: false, screen: null, folders: [] });
  });

  it('carries whether terminals are allowed, the screen, and recent folders (six at most)', () => {
    const folders = ['C:\\code\\island', 'C:\\code\\app', '', '   ', 42, 'C:\\a', 'C:\\b', 'C:\\c', 'C:\\d', 'C:\\e'];
    const got = readIslandMsg({ ...HELLO, term: true, screen: 'ready', folders });
    expect(got).toEqual({ ...HELLO, term: true, screen: 'ready', folders: ['C:\\code\\island', 'C:\\code\\app', 'C:\\a', 'C:\\b', 'C:\\c', 'C:\\d'] });
    expect(HELLO_FOLDERS).toBe(6);
    for (const screen of ['ready', 'off', 'missing', null] as const) expect(readIslandMsg({ ...HELLO, screen })).toMatchObject({ screen });
    // Anything else is read as an older island would say it.
    expect(readIslandMsg({ ...HELLO, term: 'yes', screen: 'maybe', folders: 'C:\\x' })).toMatchObject({ term: false, screen: null, folders: [] });
    // Still a hello only when its old fields are right.
    expect(readIslandMsg({ ...HELLO, allow: 'yes', term: true })).toBeNull();
  });
});

describe('terminals', () => {
  it('reads the list Rust sends, dropping what it cannot read', () => {
    const ended = { ...TERM, id: 'e5f6a7b8', exit: 1, attached: 0, claude: true };
    const got = readIslandMsg({ t: 'terms', items: [TERM, ended, { ...TERM, id: 'bad id!' }, { ...TERM, pid: -1 }, null], allowed: true });
    expect(got).toEqual({ t: 'terms', items: [TERM, ended], allowed: true });
    expect(readIslandMsg({ t: 'terms', items: [] })).toBeNull();
    expect(readIslandMsg({ t: 'terms', items: 'x', allowed: false })).toBeNull();
  });

  it('a terminal: exit null while it runs, attached and claude defaulted', () => {
    expect(readTermInfo(TERM)).toEqual(TERM);
    const { attached: _a, claude: _c, exit: _e, ...bare } = TERM;
    expect(readTermInfo(bare)).toEqual({ ...TERM, attached: 0, claude: false, exit: null });
    expect(readTermInfo({ ...TERM, exit: -1073741510 })?.exit).toBe(-1073741510);
    expect(readTermInfo({ ...TERM, exit: 1.5 })).toBeNull();
    expect(readTermInfo({ ...TERM, started: 'today' })).toBeNull();
    expect(readTermInfo({ ...TERM, title: 7 })).toBeNull();
    // A Mac reports its shell's own name.
    expect(readTermInfo({ ...TERM, shell: 'zsh' })?.shell).toBe('zsh');
  });

  it("a stream's first line: a new terminal (defaults when null) or one to attach to", () => {
    expect(readTermHeader({ t: 'term', id: null, cols: 80, rows: 24, cwd: null, shell: null })).toEqual({ t: 'term', id: null, cols: 80, rows: 24, cwd: null, shell: null });
    expect(readTermHeader({ t: 'term', id: 'a1b2c3d4', cols: 40, rows: 30, cwd: null, shell: null })?.id).toBe('a1b2c3d4');
    expect(readTermHeader({ t: 'term', cols: 80, rows: 24, cwd: 'C:\\code', shell: 'bash' })).toEqual({ t: 'term', id: null, cols: 80, rows: 24, cwd: 'C:\\code', shell: 'bash' });
    expect(readTermHeader({ t: 'term', id: null, cols: 0, rows: 24 })).toBeNull();
    expect(readTermHeader({ t: 'term', id: null, cols: 80, rows: TERM_SIZE_MAX + 1 })).toBeNull();
    expect(readTermHeader({ t: 'term', id: null, cols: 80, rows: 24, shell: 'fish' })).toBeNull();
    expect(readTermHeader({ t: 'file', id: null, cols: 80, rows: 24 })).toBeNull();
  });

  it("the PC's answer: term-ok or term-error", () => {
    expect(readTermReply({ t: 'term-ok', id: 'a1b2c3d4', title: 'PowerShell' })).toEqual({ t: 'term-ok', id: 'a1b2c3d4', title: 'PowerShell' });
    expect(readTermReply({ t: 'term-error', error: 'Turned on in Settings › Your phone on the PC' })).toEqual({ t: 'term-error', error: 'Turned on in Settings › Your phone on the PC' });
    expect(readTermReply({ t: 'term-ok', title: 'x' })).toBeNull();
    expect(readTermReply({ t: 'term-error' })).toBeNull();
    expect(readTermReply({ t: 'pong' })).toBeNull();
  });

  it('frames, as Rust and the phone both cut them', () => {
    expect([TERM_DATA, TERM_RESIZE, TERM_EXIT, TERM_TITLE]).toEqual([0, 1, 2, 3]);
    expect(TERM_FRAME_MAX).toBe(65536);
    expect(TERM_REPLAY_MAX).toBe(262144);
    expect(TERM_SIZE_MAX).toBe(500);
    expect(MAX_TERMS).toBe(8);
    // term-list and term-kill are Rust's lines: never one of the island TypeScript's.
    const lines: PhoneControl[] = [{ t: 'term-list' }, { t: 'term-kill', id: 'a1b2c3d4' }];
    for (const l of lines) expect(readPhoneMsg(l)).toBeNull();
  });
});
