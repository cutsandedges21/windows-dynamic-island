import { describe, expect, it, vi } from 'vitest';
import { TERM_DATA, TERM_EXIT, TERM_RESIZE, TERM_TITLE } from '../src/remote/protocol';
import { LinkTerm, readTermAnswer, readTermFrame, resizePayload, termHeaderLine, termOpenError, TERM_LINE_MAX, type WasmTerm } from '../phone/web/src/link/term';

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));

/** phone/wasm's Term, pretend: records what is sent and lets a test play the PC. */
function fakeWasm() {
  const sent: { kind: number; text: string }[] = [];
  const calls: string[] = [];
  let frame: ((kind: number, payload: Uint8Array) => void) | null = null;
  let ended: ((why: string) => void) | null = null;
  const term: WasmTerm = {
    reply: () => '',
    onFrame(f, e) {
      calls.push('onFrame');
      frame = f;
      ended = e;
    },
    send(kind, payload) {
      sent.push({ kind, text: dec.decode(payload) });
      return true;
    },
    close: () => void calls.push('close'),
    free: () => void calls.push('free'),
  };
  return {
    term,
    sent,
    calls,
    pc: {
      frame: (kind: number, payload: Uint8Array) => frame?.(kind, payload),
      end: (why = 'the PC ended the terminal stream') => ended?.(why),
    },
  };
}

function events() {
  const got: string[] = [];
  return {
    got,
    on: {
      data: (b: Uint8Array) => void got.push(`data ${dec.decode(b)}`),
      title: (t: string) => void got.push(`title ${t}`),
      exit: (c: number | null) => void got.push(`exit ${c}`),
      closed: () => void got.push('closed'),
    },
  };
}

/** A LinkTerm whose frames start when the test says so (the real one waits a tick). */
function open(title = 'pwsh') {
  const w = fakeWasm();
  const e = events();
  let start = () => {};
  const t = new LinkTerm(w.term, 'a1b2c3d4', title, e.on, (f) => (start = f));
  return { ...w, ...e, t, start: () => start() };
}

describe('terminal streams: lines', () => {
  it('writes the header with every field, nulls for a new terminal', () => {
    const line = termHeaderLine({ t: 'term', id: null, cols: 80, rows: 24, cwd: null, shell: null });
    expect(JSON.parse(line!)).toEqual({ t: 'term', id: null, cols: 80, rows: 24, cwd: null, shell: null });
    const attach = termHeaderLine({ t: 'term', id: 'a1b2c3d4', cols: 100, rows: 30, cwd: 'C:\\Users\\moss\\island', shell: 'bash' });
    expect(JSON.parse(attach!)).toEqual({ t: 'term', id: 'a1b2c3d4', cols: 100, rows: 30, cwd: 'C:\\Users\\moss\\island', shell: 'bash' });
    expect(attach).not.toContain('\n');
  });

  it('sends sizes the PC takes: whole, 1 to 500, 80x24 when not measured yet', () => {
    expect(JSON.parse(termHeaderLine({ t: 'term', id: null, cols: 80.7, rows: 0, cwd: null, shell: null })!)).toMatchObject({ cols: 80, rows: 1 });
    expect(JSON.parse(termHeaderLine({ t: 'term', id: null, cols: Number.NaN, rows: 9000, cwd: null, shell: null })!)).toMatchObject({ cols: 80, rows: 500 });
  });

  it('refuses a header too long for one line', () => {
    expect(termHeaderLine({ t: 'term', id: null, cols: 80, rows: 24, cwd: 'x'.repeat(TERM_LINE_MAX), shell: null })).toBeNull();
  });

  it("reads the PC's answer", () => {
    expect(readTermAnswer('{"t":"term-ok","id":"a1b2c3d4","title":"pwsh"}')).toEqual({ t: 'term-ok', id: 'a1b2c3d4', title: 'pwsh' });
    expect(readTermAnswer('{"t":"term-error","error":"Turned on in Settings › Your phone on the PC"}')).toEqual({ t: 'term-error', error: 'Turned on in Settings › Your phone on the PC' });
    // No id, not JSON, or another stream's answer (an Island from before terminals): no answer.
    expect(readTermAnswer('{"t":"term-ok","title":"x"}')).toBeNull();
    expect(readTermAnswer('not json')).toBeNull();
    expect(readTermAnswer('{"t":"file-error","id":"","error":"not a file"}')).toBeNull();
  });

  it("puts phone/wasm's reasons in plain words", () => {
    expect(termOpenError('no answer')).toBe('Island on the PC is too old for terminals. Update it there.');
    expect(termOpenError('no answer in time')).toBe("The PC didn't answer. Try again.");
    expect(termOpenError('connection lost')).toBe('The connection to the PC dropped.');
  });
});

describe('terminal streams: frames', () => {
  it('reads data, title and exit frames from the PC', () => {
    const bytes = enc.encode('PS C:\\> ');
    expect(readTermFrame(TERM_DATA, bytes)).toEqual({ k: 'data', bytes });
    expect(readTermFrame(TERM_TITLE, json({ title: 'npm test' }))).toEqual({ k: 'title', title: 'npm test' });
    expect(readTermFrame(TERM_EXIT, json({ code: 1 }))).toEqual({ k: 'exit', code: 1 });
    expect(readTermFrame(TERM_EXIT, json({ code: null }))).toEqual({ k: 'exit', code: null });
    expect(readTermFrame(TERM_EXIT, json({}))).toEqual({ k: 'exit', code: null });
  });

  it('skips kinds it does not know and broken frames', () => {
    expect(readTermFrame(9, enc.encode('later'))).toBeNull();
    expect(readTermFrame(TERM_RESIZE, json({ cols: 1, rows: 1 }))).toBeNull();
    expect(readTermFrame(TERM_TITLE, enc.encode('{'))).toBeNull();
    expect(readTermFrame(TERM_TITLE, json({ title: 5 }))).toBeNull();
  });

  it('makes resize frames of whole sizes from 1 to 500', () => {
    expect(dec.decode(resizePayload(80, 24)!)).toBe('{"cols":80,"rows":24}');
    expect(dec.decode(resizePayload(80.9, 0)!)).toBe('{"cols":80,"rows":1}');
    expect(dec.decode(resizePayload(9000, -3)!)).toBe('{"cols":500,"rows":1}');
    expect(resizePayload(Number.NaN, 24)).toBeNull();
    expect(resizePayload(80, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('terminal streams: the handle', () => {
  it('waits for whoever opened it before taking frames', () => {
    const s = open();
    expect(s.calls).toEqual([]);
    s.start();
    expect(s.calls).toEqual(['onFrame']);
  });

  it('starts frames a tick after it is made, by default', async () => {
    const w = fakeWasm();
    new LinkTerm(w.term, 'a1', 'pwsh', events().on);
    expect(w.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.calls).toEqual(['onFrame']);
  });

  it('writes strings as UTF-8 data frames and sizes as resize frames', () => {
    const s = open();
    s.t.write('ls -la\r');
    s.t.write(enc.encode('é'));
    s.t.write('');
    s.t.resize(120, 40);
    s.t.resize(Number.NaN, 40);
    expect(s.sent).toEqual([
      { kind: TERM_DATA, text: 'ls -la\r' },
      { kind: TERM_DATA, text: 'é' },
      { kind: TERM_RESIZE, text: '{"cols":120,"rows":40}' },
    ]);
  });

  it('gives output, a new title, the exit code, then closed', () => {
    const s = open('pwsh');
    s.start();
    s.pc.frame(TERM_DATA, enc.encode('hi\r\n'));
    s.pc.frame(TERM_TITLE, json({ title: 'Build' }));
    expect(s.t.title).toBe('Build');
    s.pc.frame(7, enc.encode('a later kind'));
    s.pc.frame(TERM_EXIT, json({ code: 0 }));
    s.pc.end();
    expect(s.got).toEqual(['data hi\r\n', 'title Build', 'exit 0', 'closed']);
  });

  it('tells closed once, sends nothing after, and frees the wasm object', async () => {
    const s = open();
    s.start();
    s.pc.end('connection lost');
    s.pc.end('again');
    s.t.write('x');
    s.t.resize(80, 24);
    s.t.close();
    await Promise.resolve();
    expect(s.got).toEqual(['closed']);
    expect(s.sent).toEqual([]);
    expect(s.calls).toEqual(['onFrame', 'free']);
  });

  it('close finishes the stream, and nothing is told after it', async () => {
    const s = open();
    s.start();
    s.t.close();
    s.t.close();
    s.pc.frame(TERM_DATA, enc.encode('late'));
    s.pc.end();
    s.t.write('x');
    await Promise.resolve();
    expect(s.got).toEqual([]);
    expect(s.calls).toEqual(['onFrame', 'close', 'free']);
  });

  it('a stream closed before its frames start never takes them', () => {
    const s = open();
    s.t.close();
    s.start();
    expect(s.calls).toEqual(['close']);
  });

  it('keeps going when a callback throws', () => {
    const s = open();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const on = { ...s.on, data: () => { throw new Error('xterm broke'); } };
    const w = fakeWasm();
    let start = () => {};
    const t = new LinkTerm(w.term, 'a1', 'pwsh', on, (f) => (start = f));
    start();
    w.pc.frame(TERM_DATA, enc.encode('x'));
    w.pc.frame(TERM_TITLE, json({ title: 'still here' }));
    expect(t.title).toBe('still here');
    expect(s.got).toEqual(['title still here']);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
