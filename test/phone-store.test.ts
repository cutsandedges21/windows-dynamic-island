import { describe, expect, it } from 'vitest';
import type { SavedIsland } from '../phone/web/src/link/api';
import { IslandStore, type KeyValue } from '../phone/web/src/store';

function kv(): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}
const pc = (id: string, name = id): SavedIsland => ({ id, name, relays: ['https://r.example/'], pairedAt: 1, lastSeen: null });

describe('the phone keeps its paired islands', () => {
  it('saves under island:phone:islands and opens the one paired last', () => {
    const s = kv();
    const store = new IslandStore(s);
    expect(store.current()).toBeNull();
    store.add(pc('a', 'Laptop'));
    store.add(pc('b', 'Desktop'));
    expect(store.list().map((x) => x.id)).toEqual(['a', 'b']);
    expect(store.current()?.id).toBe('b');
    expect(s.map.has('island:phone:islands')).toBe(true);
    expect(s.map.get('island:phone:current')).toBe('b');
    // A fresh pairing with a known island replaces it rather than doubling it.
    store.add({ ...pc('a', 'Laptop 2'), pairedAt: 5 });
    expect(store.list().filter((x) => x.id === 'a')).toHaveLength(1);
    expect(store.get('a')?.name).toBe('Laptop 2');
  });

  it('switches, renames, records last seen and forgets', () => {
    const store = new IslandStore(kv());
    store.add(pc('a'));
    store.add(pc('b'));
    store.use('a');
    expect(store.current()?.id).toBe('a');
    store.use('nope');
    expect(store.current()?.id).toBe('a');
    store.seen('a', 1234);
    store.rename('a', 'MossLaptop');
    expect(store.get('a')).toMatchObject({ lastSeen: 1234, name: 'MossLaptop' });
    expect(store.forget('a')?.id).toBe('b');
    expect(store.forget('b')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('survives damaged or unusable storage', () => {
    const s = kv();
    s.map.set('island:phone:islands', '{oops');
    expect(new IslandStore(s).list()).toEqual([]);
    s.map.set('island:phone:islands', JSON.stringify([pc('ok'), { id: 3 }, null, { ...pc('x'), relays: [1] }]));
    expect(new IslandStore(s).list().map((x) => x.id)).toEqual(['ok']);
    const broken: KeyValue = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => undefined,
    };
    const store = new IslandStore(broken);
    expect(() => store.add(pc('a'))).not.toThrow();
    expect(store.current()).toBeNull();
  });
});
