// Recent chats from the Claude desktop app, read locally with no login. Ported
// from Usage Clip's desktop-chats.js. The app persists its React Query cache
// (which holds the sidebar's conversation list) into IndexedDB as a blob file:
//   %APPDATA%\Claude\IndexedDB\https_claude.ai_0.indexeddb.blob\<db>\<xx>\<n>
// = 0xFF 0x11 0x02 + snappy + a V8-serialized value. The newest file that
// decodes to the cache shape wins; anything unexpected yields no chats.

import { native } from '../../core/native';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BLOB_BYTES = 40 * 1024 * 1024;
const MAX_TRIES = 3;

// ------------------------------------------------------------------ snappy

function varint(buf: Uint8Array, p: number): [number, number] {
  let r = 0;
  let shift = 0;
  let b: number;
  do {
    if (p >= buf.length) throw new Error('varint past end');
    b = buf[p++];
    r += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [r, p];
}

export function snappyDecompress(src: Uint8Array): Uint8Array {
  const [len, start] = varint(src, 0);
  if (len > 256 * 1024 * 1024) throw new Error('snappy length too large');
  const out = new Uint8Array(len);
  let p = start;
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const bytes = l - 59;
        l = 0;
        for (let i = 0; i < bytes; i++) l += src[p++] * 2 ** (8 * i);
      }
      l += 1;
      if (o + l > len || p + l > src.length) throw new Error('snappy literal overflow');
      out.set(src.subarray(p, p + l), o);
      p += l;
      o += l;
    } else {
      let l: number;
      let off: number;
      if (kind === 1) {
        l = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | src[p++];
      } else if (kind === 2) {
        l = (tag >> 2) + 1;
        off = src[p] | (src[p + 1] << 8);
        p += 2;
      } else {
        l = (tag >> 2) + 1;
        off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
        p += 4;
      }
      if (off === 0 || off > o || o + l > len) throw new Error('snappy copy out of range');
      for (let i = 0; i < l; i++, o++) out[o] = out[o - off];
    }
  }
  if (o !== len) throw new Error('snappy length mismatch');
  return out;
}

// ------------------------------------------------------- V8 value deserializer
// Enough of V8's ValueSerializer format for JSON-like data: primitives,
// strings, objects, arrays, dates, maps, sets and back-references.

const latin1 = new TextDecoder('latin1');
const utf16 = new TextDecoder('utf-16le');
const utf8 = new TextDecoder('utf-8');

export function deserialize(buf: Uint8Array): unknown {
  let p = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const objects: unknown[] = [];
  const rd = () => {
    const [v, np] = varint(buf, p);
    p = np;
    return v;
  };
  const str = (n: number, dec: TextDecoder) => {
    if (p + n > buf.length) throw new Error('string past end');
    const s = dec.decode(buf.subarray(p, p + n));
    p += n;
    return s;
  };
  function value(depth: number): unknown {
    if (depth > 200) throw new Error('too deep');
    for (;;) {
      if (p >= buf.length) throw new Error('unexpected end');
      const tag = buf[p++];
      switch (tag) {
        case 0x00:
          continue; // padding
        case 0xff:
          rd();
          continue; // version header
        case 0xfe:
          p += 12;
          continue; // Blink trailer offset/size
        case 0x5f:
          return undefined;
        case 0x30:
          return null;
        case 0x54:
          return true;
        case 0x46:
          return false;
        case 0x49: {
          const z = rd();
          return z % 2 ? -(z + 1) / 2 : z / 2;
        }
        case 0x55:
          return rd();
        case 0x4e: {
          const d = view.getFloat64(p, true);
          p += 8;
          return d;
        }
        case 0x5a: {
          const bitfield = rd();
          p += Math.floor(bitfield / 2);
          return null;
        }
        case 0x22:
          return str(rd(), latin1);
        case 0x63:
          return str(rd(), utf16);
        case 0x53:
          return str(rd(), utf8);
        case 0x44: {
          const d = view.getFloat64(p, true);
          p += 8;
          objects.push(d);
          return d;
        }
        case 0x5e:
          return objects[rd()];
        case 0x6f: {
          const o: Record<string, unknown> = {};
          objects.push(o);
          for (;;) {
            if (buf[p] === 0x7b) {
              p++;
              rd();
              return o;
            }
            const k = value(depth + 1) as string;
            o[k] = value(depth + 1);
          }
        }
        case 0x41: {
          const n = rd();
          if (n > buf.length) throw new Error('array length exceeds data');
          const a: unknown[] = new Array(n);
          objects.push(a);
          for (let i = 0; i < n; i++) {
            if (buf[p] === 0x2d) {
              p++;
              continue;
            }
            a[i] = value(depth + 1);
          }
          for (;;) {
            if (buf[p] === 0x24) {
              p++;
              rd();
              rd();
              return a;
            }
            const k = value(depth + 1) as number;
            a[k] = value(depth + 1);
          }
        }
        case 0x61: {
          const n = rd();
          if (n > buf.length) throw new Error('array length exceeds data');
          const a: unknown[] = [];
          objects.push(a);
          for (;;) {
            if (buf[p] === 0x40) {
              p++;
              rd();
              rd();
              return a;
            }
            const k = value(depth + 1) as number;
            a[k] = value(depth + 1);
          }
        }
        case 0x3b: {
          const m = new Map<unknown, unknown>();
          objects.push(m);
          for (;;) {
            if (buf[p] === 0x3a) {
              p++;
              rd();
              return m;
            }
            const k = value(depth + 1);
            m.set(k, value(depth + 1));
          }
        }
        case 0x27: {
          const s = new Set<unknown>();
          objects.push(s);
          for (;;) {
            if (buf[p] === 0x2c) {
              p++;
              rd();
              return s;
            }
            s.add(value(depth + 1));
          }
        }
        default:
          throw new Error(`unsupported tag 0x${tag.toString(16)} at ${p - 1}`);
      }
    }
  }
  return value(0);
}

/** Blob bytes → JS value (IndexedDB wrapping + optional snappy + V8 format). */
export function decodeBlob(buf: Uint8Array): unknown {
  let data = buf;
  if (data[0] === 0xff && data[1] === 0x11) {
    if (data[2] === 0x02) data = snappyDecompress(data.subarray(3));
    else if (data[2] === 0x01) data = data.subarray(3);
  }
  return deserialize(data);
}

// ------------------------------------------------------------- cache → chats

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

type Conv = Record<string, unknown>;

/** Every conversation held by chat_conversation_list queries, deduped by uuid. */
export function conversationsFromCache(cache: unknown): Conv[] | null {
  const queries = (cache as { clientState?: { queries?: unknown } } | null)?.clientState?.queries;
  if (!Array.isArray(queries)) return null;
  const byId = new Map<string, Conv>();
  const take = (c: unknown) => {
    if (!c || typeof c !== 'object') return;
    const conv = c as Conv;
    if (!UUID_RE.test(String(conv.uuid || ''))) return;
    const prev = byId.get(conv.uuid as string);
    if (!prev || (toMs(conv.updated_at) || 0) > (toMs(prev.updated_at) || 0)) byId.set(conv.uuid as string, conv);
  };
  for (const q of queries as Array<Record<string, unknown>>) {
    const key = q?.queryKey;
    if (!Array.isArray(key) || key[0] !== 'chat_conversation_list') continue;
    const data = (q.state as { data?: unknown } | undefined)?.data as Record<string, unknown> | unknown[] | undefined;
    if (!data) continue;
    if (Array.isArray(data)) data.forEach(take);
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) (obj.data as unknown[]).forEach(take);
    if (Array.isArray(obj.pages)) {
      for (const page of obj.pages as unknown[]) {
        if (Array.isArray(page)) page.forEach(take);
        else if (page && Array.isArray((page as Conv).data)) ((page as Conv).data as unknown[]).forEach(take);
        else if (page && Array.isArray((page as Conv).conversations)) ((page as Conv).conversations as unknown[]).forEach(take);
      }
    }
  }
  return [...byId.values()];
}

export interface DesktopChat {
  id: string;
  uuid: string;
  displayTitle: string;
  project: string | null;
  updatedAt: number;
  starred: boolean;
  status: string;
  label: string | null;
  tone: string;
}

/** Status from fields claude.ai keeps per conversation; empty means "no signal". */
export function chatStatus(c: Conv): { status: string; label: string | null; tone: string } {
  if (c.needs_input) return { status: 'awaiting_permission', label: 'Needs you', tone: 'needs' };
  const live = typeof c.live_status === 'string' ? c.live_status.toLowerCase() : null;
  if (live && !['idle', 'settled', 'complete', 'completed', 'done', 'none'].includes(live)) return { status: 'working', label: 'Working', tone: 'working' };
  const output = toMs(c.latest_assistant_output_at);
  const read = toMs(c.last_read_at);
  if (output && (!read || output > read)) return { status: 'awaiting_input', label: 'Your turn', tone: 'turn' };
  return { status: 'idle', label: null, tone: 'muted' };
}

function toView(c: Conv): DesktopChat {
  const s = chatStatus(c);
  const project = c.project && typeof c.project === 'object' && typeof (c.project as Conv).name === 'string' ? ((c.project as Conv).name as string) : null;
  return {
    id: `desktop:${c.uuid}`,
    uuid: c.uuid as string,
    displayTitle: (typeof c.name === 'string' && c.name.trim()) || 'Untitled chat',
    project,
    updatedAt: toMs(c.updated_at) || toMs(c.created_at) || 0,
    starred: Boolean(c.is_starred),
    ...s,
  };
}

export class DesktopChats {
  private sig: string | null = null;
  chats: DesktopChat[] = [];

  constructor(
    private readonly dirs: string[],
    private readonly windowMs = 24 * 3600000,
    private readonly max = 6,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Re-read only when the newest blobs changed. Returns true if the list changed. */
  async poll(): Promise<boolean> {
    const files = (await Promise.all(this.dirs.map((d) => native.listFiles(d, true, '', 0))))
      .flat()
      .filter((f) => f.size > 16 && f.size <= MAX_BLOB_BYTES)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sig = files.slice(0, MAX_TRIES).map((f) => `${f.path}|${f.mtimeMs}|${f.size}`).join(';') || 'none';
    if (sig === this.sig) return false;
    let cache: unknown = null;
    for (const f of files.slice(0, MAX_TRIES)) {
      try {
        const bytes = await native.readBytes(f.path, MAX_BLOB_BYTES);
        if (!bytes) continue;
        const v = decodeBlob(bytes);
        if (conversationsFromCache(v)) {
          cache = v;
          break;
        }
      } catch {
        /* mid-write, or another kind of blob */
      }
    }
    this.sig = sig;
    const before = JSON.stringify(this.chats);
    if (!cache) this.chats = [];
    else {
      const cutoff = this.now() - this.windowMs;
      this.chats = (conversationsFromCache(cache) ?? [])
        .filter((c) => !c.is_archived && !c.is_temporary)
        .map(toView)
        .filter((c) => c.updatedAt >= cutoff || c.status !== 'idle')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, this.max);
    }
    return JSON.stringify(this.chats) !== before;
  }
}

export function chatUrl(uuid: string): string | null {
  return UUID_RE.test(uuid || '') ? `claude://claude.ai/chat/${uuid.toLowerCase()}` : null;
}
