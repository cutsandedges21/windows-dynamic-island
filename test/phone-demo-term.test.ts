import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readIslandMsg, type IslandMsg, type TermHeader } from '../src/remote/protocol';
import { DEMO_FOLDERS, demoHello } from '../phone/web/src/dev/demo-data';
import { DEMO_ISLAND, FakeLink } from '../phone/web/src/dev/fake-link';
import { FakeTerms } from '../phone/web/src/dev/fake-term';

function host() {
  const sent: IslandMsg[] = [];
  return {
    sent,
    lists: () => sent.filter((m): m is Extract<IslandMsg, { t: 'terms' }> => m.t === 'terms'),
    emit: (m: IslandMsg) => void sent.push(m),
    later: (ms: number, fn: () => void) => void setTimeout(fn, ms),
  };
}

/** What a terminal stream got: its output as text, titles, exits, closes. */
function stream() {
  const out: string[] = [];
  const got = { exits: [] as Array<number | null>, closed: 0, titles: [] as string[] };
  const dec = new TextDecoder();
  const on = {
    data: (b: Uint8Array) => void out.push(dec.decode(b)),
    title: (t: string) => void got.titles.push(t),
    exit: (c: number | null) => void got.exits.push(c),
    closed: () => void got.closed++,
  };
  return { on, got, text: () => out.join(''), clear: () => void (out.length = 0) };
}

const fresh = (cwd: string | null, shell: TermHeader['shell'] = 'powershell'): TermHeader => ({ t: 'term', id: null, cols: 40, rows: 20, cwd, shell });
const again = (id: string): TermHeader => ({ t: 'term', id, cols: 40, rows: 20, cwd: null, shell: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the demo's terminals", () => {
  it('start with one running in the project and one that ended, in a list the phone reads', () => {
    const h = host();
    const terms = new FakeTerms(h, { now: 10_000_000 });
    terms.sendList();
    const [m] = h.lists();
    expect(m.allowed).toBe(true);
    expect(m.items.map((t) => [t.title, t.exit])).toEqual([
      ['windows-dynamic-island', null],
      ['npm test', 0],
    ]);
    expect(readIslandMsg(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('open a new one with a prompt, echo what is typed, and answer on Enter', async () => {
    const h = host();
    const terms = new FakeTerms(h);
    const s = stream();
    const opening = terms.open(fresh(DEMO_FOLDERS[1]), s.on);
    await vi.advanceTimersByTimeAsync(200);
    const t = await opening;
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.title).toBe('degreepilot');
    expect(s.text()).toMatch(/PS C:\\Users\\Moss\\Projects\\degreepilot> $/);
    // The list now has it, with this stream attached.
    expect(h.lists().pop()?.items.find((x) => x.id === t.id)).toMatchObject({ exit: null, attached: 1, cwd: DEMO_FOLDERS[1] });

    s.clear();
    t.write('echo hi');
    expect(s.text()).toBe('echo hi');
    t.write(new TextEncoder().encode('\r'));
    expect(s.text()).toBe('echo hi\r\nhi\r\nPS C:\\Users\\Moss\\Projects\\degreepilot> ');

    // Backspace takes a letter back, ^C drops the line, arrows do nothing here.
    s.clear();
    t.write('lx\x7f');
    expect(s.text()).toBe('lx\b \b');
    t.write('\x1b[A\x1bOB');
    expect(s.text()).toBe('lx\b \b');
    t.write('\x03');
    expect(s.text()).toBe('lx\b \b^C\r\nPS C:\\Users\\Moss\\Projects\\degreepilot> ');
  });

  it('start in Home with the shell asked for', async () => {
    const terms = new FakeTerms(host());
    const s = stream();
    const opening = terms.open(fresh(null, 'cmd'), s.on);
    await vi.advanceTimersByTimeAsync(200);
    const t = await opening;
    expect(t.title).toBe('Moss');
    expect(s.text()).toMatch(/C:\\Users\\Moss>$/);
  });

  it("replay a terminal's recent output to a stream that opens it again", async () => {
    const terms = new FakeTerms(host());
    const a = stream();
    const opening = terms.open(fresh(DEMO_FOLDERS[0]), a.on);
    await vi.advanceTimersByTimeAsync(200);
    const t = await opening;
    t.write('echo first\r');
    t.close();

    const b = stream();
    const reopening = terms.open(again(t.id), b.on);
    await vi.advanceTimersByTimeAsync(200);
    const t2 = await reopening;
    expect(t2.id).toBe(t.id);
    expect(b.text()).toContain('echo first\r\nfirst\r\n');
    // Closing a stream is not an end: nothing ended, nothing closed from the PC's side.
    expect(a.got).toEqual({ exits: [], closed: 0, titles: [] });
  });

  it('end with exit: the exit code, then the stream closes; opened again it says so at once', async () => {
    const h = host();
    const terms = new FakeTerms(h);
    const s = stream();
    const opening = terms.open(fresh(null), s.on);
    await vi.advanceTimersByTimeAsync(200);
    const t = await opening;
    t.write('exit\r');
    expect(s.got.exits).toEqual([0]);
    expect(s.got.closed).toBe(1);
    expect(h.lists().pop()?.items.find((x) => x.id === t.id)?.exit).toBe(0);

    const late = stream();
    const reopening = terms.open(again(t.id), late.on);
    await vi.advanceTimersByTimeAsync(200);
    await reopening;
    expect(late.text()).toContain('exit');
    expect(late.got.exits).toEqual([0]);
    expect(late.got.closed).toBe(1);
  });

  it('end and leave the list on term-kill', async () => {
    const h = host();
    const terms = new FakeTerms(h);
    const s = stream();
    const opening = terms.open(again('a1b2c3d4'), s.on);
    await vi.advanceTimersByTimeAsync(200);
    await opening;
    expect(s.text()).toContain('nothing to commit, working tree clean');
    terms.kill('a1b2c3d4');
    expect(s.got.exits).toEqual([1]);
    expect(s.got.closed).toBe(1);
    expect(h.lists().pop()?.items.map((x) => x.id)).toEqual(['e5f6a7b8']);
    const gone = terms.open(again('a1b2c3d4'), stream().on).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(String(await gone)).toContain("isn't there any more");
  });

  it('refuse to open while terminals are off on the PC', async () => {
    const h = host();
    const terms = new FakeTerms(h, { allowed: false });
    const p = terms.open(fresh(null), stream().on);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(String(await caught)).toContain('Turned on in Settings › Your phone on the PC');
    terms.sendList();
    expect(h.lists().pop()?.allowed).toBe(false);
  });
});

describe("the demo PC's hello", () => {
  it('says terminals are on, Chrome Remote Desktop is ready, and which folders Claude worked in', () => {
    const m = demoHello();
    expect(m).toMatchObject({ term: true, screen: 'ready', folders: DEMO_FOLDERS });
    expect(readIslandMsg(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(demoHello('MossDesktop', { term: false, screen: null })).toMatchObject({ name: 'MossDesktop', term: false, screen: null });
    expect(demoHello('x', { screen: 'missing' }).screen).toBe('missing');
  });
});

describe('the demo link', () => {
  it('answers term-list, opens terminals, and drops their streams when it closes', async () => {
    const link = new FakeLink({ screen: 'off' });
    const got: IslandMsg[] = [];
    link.onMessage((m) => void got.push(m));
    link.open(DEMO_ISLAND);
    await vi.advanceTimersByTimeAsync(800);
    expect(link.state.s).toBe('online');
    expect(got.find((m) => m.t === 'hello')).toMatchObject({ term: true, screen: 'off' });

    expect(link.send({ t: 'term-list' })).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const list = got.filter((m) => m.t === 'terms').pop();
    expect(list && list.t === 'terms' && list.items.length).toBe(2);

    const s = stream();
    const opening = link.openTerm(fresh(null), s.on);
    await vi.advanceTimersByTimeAsync(200);
    const t = await opening;
    t.write('pwd\r');
    expect(s.text()).toContain('C:\\Users\\Moss\r\n');

    link.close();
    expect(s.got.closed).toBe(1);
    await expect(link.openTerm(again(t.id), stream().on)).rejects.toThrow('Not connected');
  });

  it('keeps terminals off when ?noterm', async () => {
    const link = new FakeLink({ term: false });
    const got: IslandMsg[] = [];
    link.onMessage((m) => void got.push(m));
    link.open(DEMO_ISLAND);
    await vi.advanceTimersByTimeAsync(800);
    expect(got.find((m) => m.t === 'hello')).toMatchObject({ term: false, screen: 'ready' });
    link.send({ t: 'term-list' });
    await vi.advanceTimersByTimeAsync(100);
    expect(got.filter((m) => m.t === 'terms').pop()).toMatchObject({ allowed: false });
    link.close();
  });
});
