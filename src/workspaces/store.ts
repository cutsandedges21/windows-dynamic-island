// Workspaces as a window sees them. A change applies here at once (the page redraws without
// waiting), goes to Rust, and comes back to every window as the 'workspaces' event with a
// revision number. Each event replaces what this window holds, with this window's changes
// that are still on their way applied again on top, so a change from the other window never
// hides one made here.

import { isTauri, native, on, type Tried, type WsLoaded } from '../core/native';
import { applyOp, emptyDoc, readDoc, WS_VERSION, type Workspace, type WsDoc, type WsOp } from './model';

export interface Backend {
  load(): Promise<WsLoaded | null>;
  init(doc: WsDoc): Promise<Tried<WsLoaded>>;
  replace(doc: WsDoc, rev: number, origin: string): Promise<Tried<number>>;
  op(op: WsOp, origin: string): Promise<Tried<number>>;
  listen(cb: (doc: unknown, rev: number, origin: string) => void): Promise<void>;
}

export const tauriBackend: Backend = {
  load: () => native.wsLoad(),
  init: (doc) => native.wsInit(doc),
  replace: (doc, rev, origin) => native.wsReplace(doc, rev, origin),
  op: (op, origin) =>
    op.t === 'upsert' ? native.wsUpsert(op.id, op.fields, origin) : op.t === 'remove' ? native.wsRemove(op.id, origin) : native.wsReorder(op.ids, origin),
  listen: async (cb) => {
    await on<{ doc: unknown; rev: number; origin: string }>('workspaces', (e) => cb(e.doc, e.rev, e.origin));
  },
};

const GOOD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What Rust does, on a string kept somewhere else: the browser preview (localStorage) and
 * the tests. Events arrive a moment later, like Tauri's.
 */
export function localBackend(storage: { get(): string | null; set(text: string): void }): Backend {
  let rev = 0;
  const listeners: Array<(doc: unknown, rev: number, origin: string) => void> = [];
  const read = (): unknown => {
    try {
      return JSON.parse(storage.get() ?? 'null');
    } catch {
      return null;
    }
  };
  const write = (doc: unknown, origin: string): number => {
    storage.set(JSON.stringify(doc));
    const at = ++rev;
    queueMicrotask(() => listeners.forEach((l) => l(doc, at, origin)));
    return at;
  };
  const loaded = (): WsLoaded => ({ doc: read(), rev, recovered: null, blocked: null });
  return {
    load: async () => loaded(),
    init: async (doc) => {
      if (read() === null) write(doc, 'init');
      return { ok: true, value: loaded() };
    },
    replace: async (doc, at, origin) => (at === rev ? { ok: true, value: write(doc, origin) } : { ok: false, error: 'changed' }),
    op: async (op, origin) => {
      const doc = read() as { workspaces?: unknown } | null;
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.workspaces)) return { ok: false, error: "Workspaces aren't set up yet." };
      if (op.t !== 'reorder' && !GOOD_ID.test(op.id)) return { ok: false, error: 'Bad workspace id.' };
      return { ok: true, value: write(applyOp(doc as { workspaces: unknown[] }, op), origin) };
    },
    listen: async (cb) => {
      listeners.push(cb);
    },
  };
}

interface Pending {
  op: WsOp;
  /** The revision Rust gave it; it is in every document from that revision on. */
  rev: number | null;
}

export class WorkspaceStore {
  /** What this window shows: Rust's last document plus the changes still on their way. */
  doc: WsDoc = emptyDoc();
  ready = false;
  /** Why changes can't be saved (a file from a newer Island, one Rust can't read). */
  readOnly: string | null = null;
  /** Where an unreadable file was moved, to say so once. */
  recovered: string | null = null;
  private base: WsDoc = emptyDoc();
  private rev = 0;
  private pending: Pending[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly origin: string,
    private readonly backend: Backend,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Reads the file (setting it up, or upgrading it, when needed) and starts hearing changes. */
  async load(): Promise<void> {
    await this.backend.listen((doc, rev) => this.heard(doc, rev));
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await this.backend.load();
      if (!got) {
        this.readOnly = "Island couldn't load your workspaces. Restart Island and try again.";
        break;
      }
      this.recovered = got.recovered;
      const read = readDoc(got.doc);
      if (read.dropped.workspaces || read.dropped.items) {
        void native.log(`workspaces: skipped ${read.dropped.workspaces} workspaces and ${read.dropped.items} items that could not be read`);
      }
      if (got.blocked || read.tooNew) {
        this.readOnly = got.blocked ?? 'These workspaces were saved by a newer version of Island. Update Island to change them; nothing is lost meanwhile.';
        this.settle(read.doc, got.rev);
        break;
      }
      if (read.from === null) {
        const made = await this.backend.init(read.doc);
        if (!made.ok) {
          this.readOnly = made.error;
          break;
        }
        this.settle(readDoc(made.value.doc).doc, made.value.rev);
        break;
      }
      if (read.from < WS_VERSION) {
        const up = await this.backend.replace(read.doc, got.rev, this.origin);
        if (!up.ok && up.error === 'changed') continue;
        if (!up.ok) this.readOnly = up.error;
        this.settle(read.doc, up.ok ? up.value : got.rev);
        break;
      }
      this.settle(read.doc, got.rev);
      break;
    }
    this.ready = true;
    this.emit();
  }

  get list(): Workspace[] {
    return this.doc.workspaces;
  }

  get(id: string): Workspace | undefined {
    return this.doc.workspaces.find((w) => w.id === id);
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Adds a whole workspace (new, duplicated, or put back), first in the list. */
  add(ws: Workspace): Promise<boolean> {
    return this.run({ t: 'upsert', id: ws.id, fields: structuredClone(ws) as unknown as Record<string, unknown> });
  }

  /** Changes some top-level fields of one workspace. `quiet`: this window doesn't redraw for it (typing). */
  update(id: string, fields: Partial<Workspace>, quiet = false): Promise<boolean> {
    return this.run({ t: 'upsert', id, fields: structuredClone(fields) as Record<string, unknown> }, quiet);
  }

  remove(id: string): Promise<boolean> {
    return this.run({ t: 'remove', id });
  }

  reorder(ids: string[]): Promise<boolean> {
    return this.run({ t: 'reorder', ids });
  }

  private async run(op: WsOp, quiet = false): Promise<boolean> {
    if (this.readOnly) {
      this.onError(this.readOnly);
      return false;
    }
    const entry: Pending = { op, rev: null };
    this.pending.push(entry);
    this.rebuild(!quiet);
    const r = await this.backend.op(op, this.origin);
    if (r.ok) {
      // Its event may already be here; then it's in the base and no longer pending.
      if (r.value <= this.rev) this.drop(entry);
      else entry.rev = r.value;
      return true;
    }
    this.drop(entry);
    this.rebuild(true);
    this.onError(`Couldn't save: ${r.error}`);
    return false;
  }

  private drop(entry: Pending): void {
    const at = this.pending.indexOf(entry);
    if (at >= 0) this.pending.splice(at, 1);
  }

  private settle(doc: WsDoc, rev: number): void {
    this.base = doc;
    this.rev = Math.max(this.rev, rev);
    this.rebuild(false);
  }

  /** A document from Rust. Revisions arrive in order; an older one (a late echo) changes nothing. */
  private heard(raw: unknown, rev: number): void {
    if (rev <= this.rev) return;
    this.rev = rev;
    this.base = readDoc(raw).doc;
    this.pending = this.pending.filter((p) => p.rev === null || p.rev > rev);
    if (this.ready) this.rebuild(true);
  }

  private rebuild(notify: boolean): void {
    let doc: WsDoc = this.base;
    for (const p of this.pending) doc = applyOp(doc, p.op);
    const next = this.pending.length ? readDoc(doc).doc : doc;
    const changed = JSON.stringify(next) !== JSON.stringify(this.doc);
    this.doc = next;
    if (changed && notify) this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** The store for this window: Rust's file in the app, the browser's storage in the preview. */
export function createStore(origin: string, onError?: (message: string) => void): WorkspaceStore {
  if (isTauri) return new WorkspaceStore(origin, tauriBackend, onError);
  const key = 'island:workspaces';
  return new WorkspaceStore(
    origin,
    localBackend({ get: () => localStorage.getItem(key), set: (text) => localStorage.setItem(key, text) }),
    onError,
  );
}
