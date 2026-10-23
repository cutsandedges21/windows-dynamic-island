// The islands this phone is paired with, kept in localStorage (a Home Screen app has its own,
// which Safari's 7-day wipe of unvisited sites does not touch). The link only dials; the list,
// which one opens, and when each was last seen live here. No DOM: the tests run it on a Map.

import type { SavedIsland } from './link/api';

/** Anything with localStorage's three calls. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The real keys: `island:phone:islands` (the list) and `island:phone:current` (the one that opens). */
export const STORE_PREFIX = 'island:phone:';

function valid(v: unknown): v is SavedIsland {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    Array.isArray(o.relays) &&
    o.relays.every((r) => typeof r === 'string') &&
    typeof o.pairedAt === 'number' &&
    (o.lastSeen === null || typeof o.lastSeen === 'number')
  );
}

export class IslandStore {
  constructor(
    private readonly kv: KeyValue,
    private readonly prefix = STORE_PREFIX,
  ) {}

  private get listKey(): string {
    return `${this.prefix}islands`;
  }

  private get currentKey(): string {
    return `${this.prefix}current`;
  }

  private read(key: string): string | null {
    try {
      return this.kv.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string | null): void {
    try {
      if (value === null) this.kv.removeItem(key);
      else this.kv.setItem(key, value);
    } catch {
      /* private mode or full: the pairing lasts as long as the page */
    }
  }

  /** Every saved island, damaged entries skipped. */
  list(): SavedIsland[] {
    const raw = this.read(this.listKey);
    if (!raw) return [];
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(valid).map((x) => ({ ...x, relays: [...x.relays] })) : [];
    } catch {
      return [];
    }
  }

  private save(list: SavedIsland[]): void {
    this.write(this.listKey, list.length ? JSON.stringify(list) : null);
  }

  get(id: string): SavedIsland | null {
    return this.list().find((x) => x.id === id) ?? null;
  }

  /** The island to open: the one used last, else the first one saved, else none. */
  current(): SavedIsland | null {
    const list = this.list();
    const id = this.read(this.currentKey);
    return list.find((x) => x.id === id) ?? list[0] ?? null;
  }

  /** A new pairing (or a fresh one with an island already here): saved, and it opens from now on. */
  add(island: SavedIsland): void {
    const list = this.list().filter((x) => x.id !== island.id);
    list.push({ ...island, relays: [...island.relays] });
    this.save(list);
    this.write(this.currentKey, island.id);
  }

  /** Opens `id` from now on (the switcher). */
  use(id: string): void {
    if (this.get(id)) this.write(this.currentKey, id);
  }

  /** Forgets `id`; returns the island that opens now, if any is left. */
  forget(id: string): SavedIsland | null {
    const list = this.list().filter((x) => x.id !== id);
    this.save(list);
    if (this.read(this.currentKey) === id) this.write(this.currentKey, list[0]?.id ?? null);
    return this.current();
  }

  /** The island answered at `at` (shown as "last seen" while it is offline). */
  seen(id: string, at: number): void {
    const list = this.list();
    const it = list.find((x) => x.id === id);
    if (!it) return;
    it.lastSeen = at;
    this.save(list);
  }

  /** The PC's name as its hello says it now (renamed on the PC). */
  rename(id: string, name: string): void {
    const list = this.list();
    const it = list.find((x) => x.id === id);
    if (!it || !name || it.name === name) return;
    it.name = name;
    this.save(list);
  }
}
