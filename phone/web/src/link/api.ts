// The phone site's connection to an island: the contract between the link (this folder, over the
// iroh endpoint in phone/wasm) and the app (phone/web/src). The app never touches iroh; the link
// never draws anything. Messages are src/remote/protocol.ts's.

import type { FileHeader, IslandMsg, PairPayload, PhoneControl, PhoneMsg, TermHeader } from '../../../../src/remote/protocol';

/** An island this phone is paired with. The app keeps the list (localStorage); the link only dials it. */
export interface SavedIsland {
  /** The island's EndpointId (Display form). */
  id: string;
  name: string;
  /** Relay URLs to dial it through, its home relay first, never with a trailing dot. */
  relays: string[];
  pairedAt: number;
  lastSeen: number | null;
}

export type LinkState =
  | { s: 'idle' }
  | { s: 'connecting'; attempt: number }
  | { s: 'online'; since: number }
  /** Couldn't reach it (PC asleep, Island closed, relay down); `retryAt` is when the next try starts. */
  | { s: 'offline'; retryAt: number; why: string }
  /** The island said no; the link doesn't retry. */
  | { s: 'denied'; why: 'code' | 'expired' | 'unknown' | 'version' }
  /** The PC removed this phone (`bye`); the link doesn't retry. */
  | { s: 'removed' };

/** A file the PC sent to this phone (phase 2), whole, in memory. */
export interface IncomingFile {
  header: FileHeader;
  blob: Blob;
}

/**
 * A terminal on the PC, open on a stream of its own (openTerm). The terminal keeps running on the
 * PC when the stream closes; open it again with its id to pick it up.
 */
export interface TermHandle {
  readonly id: string;
  /** Its title: term-ok's, then the latest the PC sent. */
  readonly title: string;
  write(data: Uint8Array | string): void; // a data frame (strings as UTF-8)
  resize(cols: number, rows: number): void; // a resize frame
  close(): void; // finishes the stream; the terminal keeps running on the PC
}

/** Lines to the PC that its Rust handles itself (the rest of PhoneControl the link sends on its own). */
export type LinkControl = Extract<PhoneControl, { t: 'push-sub' | 'term-list' | 'term-kill' }>;

export interface Link {
  /** This phone's EndpointId: the public half of its key, made once and kept in localStorage. */
  readonly phoneId: string;
  readonly state: LinkState;
  /**
   * Pairs with the island in `pair`: dials it, sends `pair` with the code and `phoneName`, and
   * resolves with the island to save once it answers `paired` (rejects on `denied` or no answer
   * in 20 s). The connection then stays open as with open().
   */
  pair(pair: PairPayload, phoneName: string): Promise<SavedIsland>;
  /**
   * Connects to a paired island (sends `hi`) and keeps it connected: reconnects with backoff
   * (1 s, 2 s, 4 s … 30 s) while the page shows, sends `ping` every PING_MS, drops the
   * connection HIDDEN_CLOSE_MS after the page is hidden and reconnects when it shows again.
   * Opening another island closes the first.
   */
  open(island: SavedIsland): void;
  close(): void;
  onState(cb: (s: LinkState) => void): () => void;
  /** Lines from the island, checked with readIslandMsg (pong is kept inside the link). */
  onMessage(cb: (m: IslandMsg) => void): () => void;
  /** Sends a control line; false (and nothing sent) unless online. `term-list` and `term-kill` are answered with `terms`. */
  send(m: PhoneMsg | LinkControl): boolean;
  /** Phase 2: a file to the PC on its own stream; progress 0..1; resolves with the name it was saved under. */
  sendFile(file: File, onProgress?: (p: number) => void): Promise<{ name: string }>;
  /** Phase 2: files the PC sends to this phone. */
  onFile(cb: (f: IncomingFile) => void): () => void;
  /**
   * Opens a terminal stream (new when header.id is null); resolves after term-ok, rejects with term-error's text.
   * `data` starts with the terminal's recent output (up to 256 KiB), so clear the screen before
   * opening; then live output. `exit` comes when its program ends, then `closed`. `closed` comes
   * once when the stream ends for any other reason too (the connection dropped, the terminal was
   * ended), never after close().
   */
  openTerm(header: TermHeader, on: { data(bytes: Uint8Array): void; title(t: string): void; exit(code: number | null): void; closed(): void }): Promise<TermHandle>;
}

/** What phone/web/src/link/index.ts exports: makes the link, loading the wasm once. */
export type CreateLink = () => Promise<Link>;
