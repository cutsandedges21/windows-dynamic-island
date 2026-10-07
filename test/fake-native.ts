// A Node-backed stand-in for src/core/native.ts in tests. File commands mirror
// the Rust implementations in src-tauri/src/fsx.rs (same line rules, same
// partial-line handling), so the TypeScript readers are exercised for real.

import fs from 'node:fs';
import path from 'node:path';

export const isTauri = false;
export const demo = false;

export const fake = {
  configDir: '',
  usageReply: { status: 200, retryAfter: null as number | null, body: null as unknown },
  lastVersion: null as string | null,
  usageCalls: 0,
};

function statOf(p: string) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() };
  } catch {
    return null;
  }
}

function walk(dir: string, recursive: boolean, ext: string, maxAgeMs: number, out: Array<{ name: string; path: string; dir: boolean; size: number; mtimeMs: number }>, depth: number) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < 6) walk(p, recursive, ext, maxAgeMs, out, depth + 1);
      continue;
    }
    if (ext && !e.name.toLowerCase().endsWith(ext)) continue;
    const st = fs.statSync(p);
    if (maxAgeMs > 0 && now - st.mtimeMs > maxAgeMs) continue;
    out.push({ name: e.name, path: p, dir: false, size: st.size, mtimeMs: st.mtimeMs });
  }
}

function scanLines(file: string, offset: number, each: (line: Buffer) => void): { consumed: number; size: number } {
  const buf = fs.readFileSync(file);
  const size = buf.length;
  const start = offset > size ? 0 : offset;
  let lineStart = start;
  for (let i = start; i < size; i++) {
    if (buf[i] === 10) {
      each(buf.subarray(lineStart, i));
      lineStart = i + 1;
    }
  }
  return { consumed: lineStart, size };
}

function leadingText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return null;
    for (const b of content) if (b && b.type === 'text') return typeof b.text === 'string' ? b.text : null;
  }
  return null;
}

export const native = {
  isTauri,
  demo,
  log: async () => {},
  readDir: async (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).map((d) => {
        const fp = path.join(p, d.name);
        const st = fs.statSync(fp);
        return { name: d.name, path: fp, dir: d.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
      });
    } catch {
      return null;
    }
  },
  listFiles: async (dir: string, recursive: boolean, ext: string, maxAgeMs: number) => {
    const out: Array<{ name: string; path: string; dir: boolean; size: number; mtimeMs: number }> = [];
    walk(dir, recursive, ext.toLowerCase(), maxAgeMs, out, 0);
    return out;
  },
  statMany: async (paths: string[]) => paths.map((p) => (p ? statOf(p) : null)),
  readText: async (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  readBytes: async (p: string, max: number) => {
    try {
      const b = fs.readFileSync(p);
      return b.length > max ? null : new Uint8Array(b);
    } catch {
      return null;
    }
  },
  readTail: async (p: string, maxBytes: number) => {
    try {
      const st = fs.statSync(p);
      const buf = fs.readFileSync(p);
      const start = Math.max(0, buf.length - maxBytes);
      const lines = buf.subarray(start).toString('utf8').split('\n');
      if (start > 0) lines.shift();
      return { size: st.size, mtimeMs: st.mtimeMs, lines };
    } catch {
      return null;
    }
  },
  transcriptMeta: async (p: string, offset: number, needUser: boolean) => {
    try {
      const out = { consumed: 0, size: 0, aiTitle: null as string | null, customTitle: null as string | null, permissionMode: null as string | null, userTexts: [] as string[] };
      const r = scanLines(p, offset, (raw) => {
        const s = raw.toString('utf8');
        const interesting = s.includes('ai-title') || s.includes('custom-title') || s.includes('permissionMode');
        const user = needUser && out.userTexts.length < 24 && s.includes('"user"');
        if (!interesting && !user) return;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(s);
        } catch {
          return;
        }
        const side = e.isSidechain === true;
        const meta = e.isMeta === true;
        if (!side && typeof e.permissionMode === 'string' && e.permissionMode) out.permissionMode = e.permissionMode;
        if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle) out.aiTitle = e.aiTitle;
        else if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle) out.customTitle = e.customTitle;
        else if (e.type === 'user' && user && !side && !meta) {
          const t = leadingText((e.message as { content?: unknown } | undefined)?.content);
          if (t != null) out.userTexts.push(t);
        }
      });
      out.consumed = r.consumed;
      out.size = r.size;
      return out;
    } catch {
      return null;
    }
  },
  usageEntries: async (p: string, offset: number) => {
    try {
      const entries: Array<[string, number, number, number, number, number]> = [];
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      const r = scanLines(p, offset, (raw) => {
        const s = raw.toString('utf8');
        if (!s.includes('"usage":')) return;
        let e: Record<string, any>;
        try {
          e = JSON.parse(s);
        } catch {
          return;
        }
        if (e.type !== 'assistant') return;
        const u = e.message?.usage;
        if (!u || typeof u !== 'object') return;
        const ts = Date.parse(e.timestamp);
        if (!Number.isFinite(ts)) return;
        const id = e.message.id || '';
        const req = e.requestId || '';
        const key = id || req ? `${id}:${req}` : e.uuid;
        if (!key) return;
        entries.push([key, ts, num(u.input_tokens), num(u.cache_creation_input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens)]);
      });
      return { consumed: r.consumed, size: r.size, entries };
    } catch {
      return null;
    }
  },
  usageFetch: async (version: string | null) => {
    fake.lastVersion = version;
    fake.usageCalls += 1;
    if (!fs.existsSync(path.join(fake.configDir, '.credentials.json'))) return { status: 0, retryAfter: null, body: null, noToken: true };
    return { status: fake.usageReply.status, retryAfter: fake.usageReply.retryAfter, body: fake.usageReply.body, noToken: false };
  },
};

export const on = async () => () => {};
export const emitLocal = () => {};
export const sendTo = async () => {};
