// What macOS 12's Safari engine (Safari 15.0, the oldest Island runs on) lacks and Island's code uses.
// Only the Mac build loads this (vite.config.ts puts it in front of each page's code); each piece is
// added only where the engine doesn't have it, so a newer Mac keeps its own.

// color-mix() where the engine lacks it (Safari before 16.2): a module of its own, switched on there only.
import './colormix';

type Indexed<T> = { readonly length: number; readonly [i: number]: T };

function at<T>(this: Indexed<T>, index: number): T | undefined {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

function define(target: object, name: string, value: unknown): void {
  if (name in target) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** A deep copy of plain data (what Island clones: settings, layouts, workspaces), as structuredClone does. */
export function cloneData<T>(value: T, seen = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(cloneData(k, seen), cloneData(v, seen));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(cloneData(v, seen));
    return out as T;
  }
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice() as T;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(cloneData(v, seen));
    return out as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'function') out[k] = cloneData(v, seen);
  }
  return out as T;
}

/**
 * The text before the first lone `|` (a pipe that isn't half of `||`): what
 * `text.split(/(?<!\|)\|(?!\|)/)[0]` gives, without the lookbehind Safari only reads from 16.4 on.
 * The Mac build swaps it in for that expression (vite.config.ts).
 */
export function beforeLonePipe(text: string): string {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|' && text[i - 1] !== '|' && text[i + 1] !== '|') return text.slice(0, i);
  }
  return text;
}

export function installCompat(scope: typeof globalThis = globalThis): void {
  define(Array.prototype, 'at', at);
  define(String.prototype, 'at', at);
  for (const typed of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
    define(typed.prototype, 'at', at);
  }
  define(Object, 'hasOwn', (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k));
  define(Array.prototype, 'findLast', function <T>(this: T[], fn: (v: T, i: number, a: T[]) => unknown, self?: unknown) {
    for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return this[i];
    return undefined;
  });
  define(Array.prototype, 'findLastIndex', function <T>(this: T[], fn: (v: T, i: number, a: T[]) => unknown, self?: unknown) {
    for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return i;
    return -1;
  });
  define(scope, 'structuredClone', <T>(value: T) => cloneData(value));
  define(scope, '__islandBeforeLonePipe', beforeLonePipe);
}

installCompat();
