// A terminal on the PC, from the phone (docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md).
// phone/wasm opens its stream (the header line out, the PC's answer line in) and cuts it into
// frames (`[kind][len: u32 big-endian][payload]`, at most 64 KiB, src/frames.rs); this file gives
// the frames their meaning and is api.ts's TermHandle. No DOM and no wasm here (the wasm Term is
// handed in), so test/link-term.test.ts drives it with a fake.

import { readTermReply, TERM_DATA, TERM_EXIT, TERM_RESIZE, TERM_SIZE_MAX, TERM_TITLE, type TermHeader, type TermReply } from '../../../../src/remote/protocol';
import type { Link, TermHandle } from './api';

/** phone/wasm's Term (src/lib.rs). */
export interface WasmTerm {
  /** The PC's answer line: `term-ok` (frames follow) or `term-error`. */
  reply(): string;
  /** frame(kind, bytes) for every frame from the PC, then ended(why) once (never after close); earlier ones are given now. */
  onFrame(frame: (kind: number, payload: Uint8Array) => void, ended: (why: string) => void): void;
  /** Queues a frame (data over 64 KiB goes as several); false if the stream is done. */
  send(kind: number, payload: Uint8Array): boolean;
  /** Finishes this side and stops reading; no callbacks after it. */
  close(): void;
  free(): void;
}

/** What openTerm reports to whoever opened the terminal. */
export type TermEvents = Parameters<Link['openTerm']>[1];

/** A header line or answer line on a terminal stream, at most (phone/wasm MAX_TERM_LINE). */
export const TERM_LINE_MAX = 64 * 1024;
/** As protocol.ts reads term-ok's. */
const TITLE_MAX = 400;

const utf8 = new TextEncoder();

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whole columns or rows as the PC takes them (1 to TERM_SIZE_MAX); null for what isn't a number. */
function termSize(n: number): number | null {
  return Number.isFinite(n) ? Math.min(TERM_SIZE_MAX, Math.max(1, Math.floor(n))) : null;
}

/** The header line as it goes to the PC (80x24 for a size not measured yet); null when it is too long to send (a path of 60,000 letters). */
export function termHeaderLine(h: TermHeader): string | null {
  const line = JSON.stringify({ t: 'term', id: h.id ?? null, cols: termSize(h.cols) ?? 80, rows: termSize(h.rows) ?? 24, cwd: h.cwd ?? null, shell: h.shell ?? null });
  return utf8.encode(line).length + 1 > TERM_LINE_MAX ? null : line;
}

/** The PC's answer line: `term-ok`, `term-error`, or null for anything else (an Island from before terminals). */
export function readTermAnswer(line: string): TermReply | null {
  return readTermReply(json(line));
}

/** Words for phone/wasm's openTerm rejections. */
export function termOpenError(why: string): string {
  if (why === 'no answer') return 'Island on the PC is too old for terminals. Update it there.';
  if (why === 'no answer in time') return "The PC didn't answer. Try again.";
  return 'The connection to the PC dropped.';
}

/** A frame from the PC, read; null for a kind this page doesn't know (a newer Island's) or a broken one. */
export type TermFrame = { k: 'data'; bytes: Uint8Array } | { k: 'title'; title: string } | { k: 'exit'; code: number | null };

export function readTermFrame(kind: number, payload: Uint8Array): TermFrame | null {
  if (kind === TERM_DATA) return { k: 'data', bytes: payload };
  if (kind !== TERM_TITLE && kind !== TERM_EXIT) return null;
  const v = json(new TextDecoder().decode(payload));
  if (!isObj(v)) return null;
  if (kind === TERM_TITLE) return typeof v.title === 'string' ? { k: 'title', title: v.title.slice(0, TITLE_MAX) } : null;
  return { k: 'exit', code: typeof v.code === 'number' && Number.isInteger(v.code) ? v.code : null };
}

/** A resize frame's payload: whole columns and rows from 1 to 500; null if they aren't numbers. */
export function resizePayload(cols: number, rows: number): Uint8Array | null {
  const size = { cols: termSize(cols), rows: termSize(rows) };
  return size.cols === null || size.rows === null ? null : utf8.encode(JSON.stringify(size));
}

function safely(f: () => void): void {
  try {
    f();
  } catch (e) {
    console.error(e);
  }
}

/** api.ts's TermHandle over phone/wasm's Term, once the PC has answered `term-ok`. */
export class LinkTerm implements TermHandle {
  /** The latest title: term-ok's, then each title frame's. */
  title: string;
  /** Closed here, or ended by the PC or the connection: nothing is sent or reported after it. */
  private over = false;

  constructor(
    private readonly term: WasmTerm,
    readonly id: string,
    title: string,
    private readonly on: TermEvents,
    later: (f: () => void) => void = (f) => setTimeout(f, 0),
  ) {
    this.title = title;
    // Frames start once whoever opened it holds this handle; the first are the terminal's recent output.
    later(() => {
      if (!this.over) this.term.onFrame((kind, payload) => this.frame(kind, payload), () => this.ended());
    });
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? utf8.encode(data) : data;
    if (!this.over && bytes.length) this.term.send(TERM_DATA, bytes);
  }

  resize(cols: number, rows: number): void {
    const payload = resizePayload(cols, rows);
    if (!this.over && payload) this.term.send(TERM_RESIZE, payload);
  }

  close(): void {
    if (this.over) return;
    this.over = true;
    this.term.close();
    this.free();
  }

  private frame(kind: number, payload: Uint8Array): void {
    const f = this.over ? null : readTermFrame(kind, payload);
    if (!f) return;
    if (f.k === 'data') return safely(() => this.on.data(f.bytes));
    if (f.k === 'title') {
      this.title = f.title;
      return safely(() => this.on.title(f.title));
    }
    safely(() => this.on.exit(f.code));
  }

  private ended(): void {
    if (this.over) return;
    this.over = true;
    this.free();
    safely(() => this.on.closed());
  }

  private free(): void {
    // Not from inside one of its own calls.
    queueMicrotask(() => this.term.free());
  }
}
