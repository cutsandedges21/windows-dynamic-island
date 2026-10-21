// Workspaces: named sets of apps, files, folders, sites and commands that open together,
// with notes on where the work stands. This file is the data model, the file format and
// the pure operations on it. Rust keeps the file (src-tauri/src/workspaces/mod.rs) and
// applies the same three operations (upsert, remove, reorder), so the two windows never
// overwrite each other's changes. See docs/WORKSPACES.md.

import { hasIcon, type IconName } from '../core/icons';
import { ACCENTS } from '../core/settings';

/** The file format's version. Bump it with a step in MIGRATIONS when the shape changes. */
export const WS_VERSION = 1;
/** Restores remembered per workspace, newest first. */
export const HISTORY_MAX = 10;
export const MAX_WORKSPACES = 500;
export const MAX_ITEMS = 100;

export type ResourceKind = 'app' | 'file' | 'folder' | 'url' | 'command';
export const RESOURCE_KINDS: ResourceKind[] = ['app', 'file', 'folder', 'url', 'command'];
/** 'auto': opens on its own when the workspace is restored. 'ask': waits for a yes first. */
export type RunMode = 'auto' | 'ask';
export type Shell = 'powershell' | 'pwsh' | 'cmd';
/** Where a command runs: a Windows Terminal tab, or a console window of its own. */
export type CommandHost = 'terminal' | 'console';

interface ItemBase {
  id: string;
  /** What the user calls it; '' = made from the path or address. */
  label: string;
  enabled: boolean;
  mode: RunMode;
  /** Seconds to wait after it starts before the next item (a dev server booting). */
  wait: number;
}
export interface AppItem extends ItemBase {
  kind: 'app';
  /** An .exe, a shortcut, or a program name Windows finds on its own ("code", "wt"). */
  path: string;
  args: string;
  /** Start in this folder; '' = the workspace's project folder. */
  cwd: string;
  /** Already running: true = bring its window up instead of starting another copy. */
  reuse: boolean;
}
export interface FileItem extends ItemBase {
  kind: 'file';
  path: string;
  /** Open with this program; '' = the file's default app. */
  openWith: string;
}
export interface FolderItem extends ItemBase {
  kind: 'folder';
  path: string;
}
export interface UrlItem extends ItemBase {
  kind: 'url';
  url: string;
}
export interface CommandItem extends ItemBase {
  kind: 'command';
  command: string;
  shell: Shell;
  host: CommandHost;
  /** Run in this folder; '' = the workspace's project folder. */
  cwd: string;
}
export type Resource = AppItem | FileItem | FolderItem | UrlItem | CommandItem;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A display as it was when a layout was saved (physical pixels, virtual-screen coordinates). */
export interface MonitorShot {
  id: string;
  name: string;
  primary: boolean;
  bounds: Rect;
  work: Rect;
  scale: number;
}
/** One saved window. Process ids change between sessions, so it is found again by program, class and title. */
export interface WindowSpot {
  id: string;
  /** Full path of the program that owned it. */
  exe: string;
  title: string;
  className: string;
  monitor: string;
  rect: Rect;
  /** The same rectangle as shares of its monitor's work area, for a display that changed. */
  rel: { x: number; y: number; w: number; h: number };
  state: 'normal' | 'maximized' | 'minimized';
  /** The item that opens this window, when one does. */
  resource: string | null;
  enabled: boolean;
}
export interface WindowLayout {
  savedAt: number;
  monitors: MonitorShot[];
  windows: WindowSpot[];
}

export type StepStatus = 'done' | 'skipped' | 'failed' | 'cancelled';
export interface RunStep {
  resource: string;
  label: string;
  status: StepStatus;
  /** What happened, in words: "Not found: D:\\music\\set.als". */
  why: string;
}
export type RunOutcome = 'done' | 'partial' | 'failed' | 'cancelled';
export interface RestoreRun {
  id: string;
  at: number;
  ms: number;
  outcome: RunOutcome;
  steps: RunStep[];
}

export interface Notes {
  /** Where the work stands. */
  text: string;
  /** The one thing to do next. */
  next: string;
  savedAt: number | null;
}
export interface Prefs {
  /** Put windows back where the saved layout has them. */
  placeWindows: boolean;
  /** Ask for a note when switching to another workspace. */
  remindOnLeave: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  /** A key of ACCENTS, or '' for Island's accent. */
  color: string;
  favorite: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  /** The project folder: commands and apps start here unless they say otherwise. */
  cwd: string;
  /** In the order they open. */
  resources: Resource[];
  notes: Notes;
  prefs: Prefs;
  layout: WindowLayout | null;
  history: RestoreRun[];
}

export interface WsDoc {
  version: number;
  workspaces: Workspace[];
}

/**
 * What the editor writes on Save. Everything else has its own writer (the star, archiving,
 * restores, saving a layout), so saving an edit never undoes those.
 */
export const EDITOR_FIELDS = ['name', 'description', 'icon', 'color', 'cwd', 'resources', 'notes', 'prefs', 'updatedAt'] as const;

/** Icons offered for a workspace (all from Island's set). */
export const WS_ICONS: IconName[] = [
  'grid', 'spaces', 'code', 'terminal', 'book', 'music', 'headphones', 'globe', 'chat', 'calendar', 'image',
  'video', 'gamepad', 'file', 'folder', 'laptop', 'spark', 'branch', 'server', 'user', 'pin',
];

export const KIND_META: Record<ResourceKind, { icon: IconName; one: string; many: string; add: string }> = {
  app: { icon: 'window', one: 'app', many: 'apps', add: 'App' },
  file: { icon: 'file', one: 'file', many: 'files', add: 'File' },
  folder: { icon: 'folder', one: 'folder', many: 'folders', add: 'Folder' },
  url: { icon: 'globe', one: 'site', many: 'sites', add: 'Website' },
  command: { icon: 'terminal', one: 'command', many: 'commands', add: 'Command' },
};

/** Ready-made starting points for the empty page: a name, a look and a hint of what goes in. */
export const STARTERS: Array<{ key: string; name: string; icon: IconName; color: string; description: string }> = [
  { key: 'dev', name: 'Development', icon: 'code', color: 'sky', description: 'Editor, terminal, dev server and the docs you keep open.' },
  { key: 'school', name: 'School', icon: 'book', color: 'mint', description: 'Course notes, assignments, research tabs and your calendar.' },
  { key: 'music', name: 'Music production', icon: 'music', color: 'violet', description: 'Your DAW, the project, reference tracks and audio tools.' },
];

/**
 * Link kinds a Website item may open: the web, plus the app links Island already opens
 * elsewhere. Keep in step with SCHEMES in src-tauri/src/shell.rs (Rust checks again).
 */
export const URL_SCHEMES = ['http', 'https', 'vscode', 'vscode-insiders', 'vscodium', 'cursor', 'windsurf', 'claude', 'spotify', 'msteams', 'zoommtg', 'zoomus', 'mailto'];

// ------------------------------------------------------------------ making things

export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12)}`;
}

export function newWorkspace(fields: Partial<Pick<Workspace, 'name' | 'description' | 'icon' | 'color'>> = {}, now = Date.now()): Workspace {
  return {
    id: newId('ws'),
    name: fields.name ?? '',
    description: fields.description ?? '',
    icon: fields.icon ?? 'grid',
    color: fields.color ?? '',
    favorite: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: null,
    cwd: '',
    resources: [],
    notes: { text: '', next: '', savedAt: null },
    prefs: { placeWindows: true, remindOnLeave: false },
    layout: null,
    history: [],
  };
}

export function newResource(kind: ResourceKind, fields: Record<string, unknown> = {}): Resource {
  const base = { id: newId('it'), label: '', enabled: true, mode: 'auto' as RunMode, wait: 0 };
  const made = ((): Resource => {
    switch (kind) {
      case 'app':
        return { ...base, kind, path: '', args: '', cwd: '', reuse: true };
      case 'file':
        return { ...base, kind, path: '', openWith: '' };
      case 'folder':
        return { ...base, kind, path: '' };
      case 'url':
        return { ...base, kind, url: '' };
      case 'command':
        // A command never runs without a yes unless the user says so.
        return { ...base, kind, mode: 'ask', command: '', shell: 'powershell', host: 'terminal', cwd: '' };
    }
  })();
  return normalizeResource({ ...made, ...fields, kind, id: made.id }) ?? made;
}

/** A copy with new ids, named "<name> copy", never opened. */
export function duplicateWorkspace(ws: Workspace, now = Date.now()): Workspace {
  const copy = structuredClone(ws);
  copy.id = newId('ws');
  copy.name = clip(`${ws.name} copy`, 80);
  copy.favorite = false;
  copy.archived = false;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.lastOpenedAt = null;
  copy.history = [];
  const ids = new Map<string, string>();
  for (const r of copy.resources) {
    const next = newId('it');
    ids.set(r.id, next);
    r.id = next;
  }
  if (copy.layout) {
    for (const w of copy.layout.windows) {
      w.id = newId('win');
      w.resource = w.resource ? ids.get(w.resource) ?? null : null;
    }
  }
  return copy;
}

// ------------------------------------------------------------------ reading the file

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const str = (v: unknown, max: number, def = ''): string => (typeof v === 'string' ? clip(v, max) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const num = (v: unknown, def: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return allowed.includes(v as T) ? (v as T) : def;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const goodId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

function rect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const r = { x: num(v.x, NaN), y: num(v.y, NaN), width: num(v.width, NaN), height: num(v.height, NaN) };
  return Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null;
}

/** One item as saved, checked field by field; null when it is not an item Island knows. */
export function normalizeResource(v: unknown): Resource | null {
  if (!isObj(v) || !RESOURCE_KINDS.includes(v.kind as ResourceKind)) return null;
  const kind = v.kind as ResourceKind;
  const base = {
    id: goodId(v.id) ? v.id : newId('it'),
    label: str(v.label, 120),
    enabled: bool(v.enabled, true),
    mode: oneOf<RunMode>(v.mode, ['auto', 'ask'], kind === 'command' ? 'ask' : 'auto'),
    wait: num(v.wait, 0, 0, 600),
  };
  switch (kind) {
    case 'app':
      return { ...base, kind, path: str(v.path, 4096), args: str(v.args, 8192), cwd: str(v.cwd, 4096), reuse: bool(v.reuse, true) };
    case 'file':
      return { ...base, kind, path: str(v.path, 4096), openWith: str(v.openWith, 4096) };
    case 'folder':
      return { ...base, kind, path: str(v.path, 4096) };
    case 'url':
      return { ...base, kind, url: str(v.url, 8192) };
    case 'command':
      return {
        ...base,
        kind,
        command: str(v.command, 8192),
        shell: oneOf<Shell>(v.shell, ['powershell', 'pwsh', 'cmd'], 'powershell'),
        host: oneOf<CommandHost>(v.host, ['terminal', 'console'], 'terminal'),
        cwd: str(v.cwd, 4096),
      };
  }
}

function normalizeLayout(v: unknown): WindowLayout | null {
  if (!isObj(v) || !Array.isArray(v.windows)) return null;
  const monitors: MonitorShot[] = [];
  for (const m of Array.isArray(v.monitors) ? v.monitors : []) {
    if (!isObj(m)) continue;
    const bounds = rect(m.bounds);
    const work = rect(m.work);
    if (!bounds || !work || typeof m.id !== 'string') continue;
    monitors.push({ id: str(m.id, 200), name: str(m.name, 200), primary: bool(m.primary, false), bounds, work, scale: num(m.scale, 1, 0.5, 5) });
  }
  const windows: WindowSpot[] = [];
  for (const w of v.windows.slice(0, 200)) {
    if (!isObj(w)) continue;
    const r = rect(w.rect);
    if (!r || typeof w.exe !== 'string' || !w.exe) continue;
    const rel = isObj(w.rel) ? w.rel : {};
    windows.push({
      id: goodId(w.id) ? w.id : newId('win'),
      exe: str(w.exe, 4096),
      title: str(w.title, 500),
      className: str(w.className, 256),
      monitor: str(w.monitor, 200),
      rect: r,
      rel: { x: num(rel.x, 0, -1, 2), y: num(rel.y, 0, -1, 2), w: num(rel.w, 0.5, 0.01, 3), h: num(rel.h, 0.5, 0.01, 3) },
      state: oneOf(w.state, ['normal', 'maximized', 'minimized'] as const, 'normal'),
      resource: goodId(w.resource) ? w.resource : null,
      enabled: bool(w.enabled, true),
    });
  }
  return { savedAt: num(v.savedAt, 0, 0), monitors, windows };
}

function normalizeRun(v: unknown): RestoreRun | null {
  if (!isObj(v) || time(v.at) === null) return null;
  const steps: RunStep[] = [];
  for (const s of Array.isArray(v.steps) ? v.steps.slice(0, MAX_ITEMS + 50) : []) {
    if (!isObj(s)) continue;
    steps.push({
      resource: str(s.resource, 64),
      label: str(s.label, 200),
      status: oneOf(s.status, ['done', 'skipped', 'failed', 'cancelled'] as const, 'failed'),
      why: str(s.why, 500),
    });
  }
  return {
    id: goodId(v.id) ? v.id : newId('run'),
    at: time(v.at)!,
    ms: num(v.ms, 0, 0),
    outcome: oneOf(v.outcome, ['done', 'partial', 'failed', 'cancelled'] as const, 'failed'),
    steps,
  };
}

/** One workspace as saved, every field checked; null when it has no usable id. Counts dropped items. */
export function normalizeWorkspace(v: unknown, dropped = { items: 0 }): Workspace | null {
  if (!isObj(v) || !goodId(v.id)) return null;
  const now = Date.now();
  const created = time(v.createdAt) ?? now;
  const notes = isObj(v.notes) ? v.notes : {};
  const prefs = isObj(v.prefs) ? v.prefs : {};
  const resources: Resource[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v.resources) ? v.resources : []) {
    const r = normalizeResource(raw);
    if (!r || resources.length >= MAX_ITEMS) {
      dropped.items++;
      continue;
    }
    // An id seen twice (a hand-edited file) gets a new one, so editing one never edits the other.
    if (seen.has(r.id)) r.id = newId('it');
    seen.add(r.id);
    resources.push(r);
  }
  const history = (Array.isArray(v.history) ? v.history : []).map(normalizeRun).filter((r): r is RestoreRun => r !== null);
  history.sort((a, b) => b.at - a.at);
  return {
    id: v.id,
    name: str(v.name, 80),
    description: str(v.description, 300),
    icon: typeof v.icon === 'string' && hasIcon(v.icon) ? v.icon : 'grid',
    color: typeof v.color === 'string' && (v.color === '' || v.color in ACCENTS) ? v.color : '',
    favorite: bool(v.favorite, false),
    archived: bool(v.archived, false),
    createdAt: created,
    updatedAt: time(v.updatedAt) ?? created,
    lastOpenedAt: time(v.lastOpenedAt),
    cwd: str(v.cwd, 4096),
    resources,
    notes: { text: str(notes.text, 4000), next: str(notes.next, 300), savedAt: time(notes.savedAt) },
    prefs: { placeWindows: bool(prefs.placeWindows, true), remindOnLeave: bool(prefs.remindOnLeave, false) },
    layout: normalizeLayout(v.layout),
    history: history.slice(0, HISTORY_MAX),
  };
}

type Migration = (doc: Obj) => Obj;
/** MIGRATIONS[n] turns a version-n document into version n+1. None yet: version 1 is the first. */
export const MIGRATIONS: Record<number, Migration> = {};

export function emptyDoc(): WsDoc {
  return { version: WS_VERSION, workspaces: [] };
}

export interface ReadResult {
  doc: WsDoc;
  /** The version the file had; null when nothing was saved yet. */
  from: number | null;
  /** Saved by a newer Island: shown, but never written back (it could lose what this one doesn't know). */
  tooNew: boolean;
  /** Workspaces and items that could not be read. */
  dropped: { workspaces: number; items: number };
}

/** The file as Rust hands it over: upgraded step by step to WS_VERSION, then checked. */
export function readDoc(raw: unknown, migrations: Record<number, Migration> = MIGRATIONS, target = WS_VERSION): ReadResult {
  const dropped = { workspaces: 0, items: 0 };
  if (!isObj(raw)) return { doc: { version: target, workspaces: [] }, from: null, tooNew: false, dropped };
  const from = Number.isInteger(raw.version) && (raw.version as number) >= 1 ? (raw.version as number) : 1;
  let doc: Obj = raw;
  let tooNew = from > target;
  for (let v = from; v < target; v++) {
    const step = migrations[v];
    if (!step) {
      // No way up from here: treat it like a newer file and leave it as it is.
      tooNew = true;
      break;
    }
    doc = step(structuredClone(doc));
  }
  const workspaces: Workspace[] = [];
  const seen = new Set<string>();
  for (const w of Array.isArray(doc.workspaces) ? doc.workspaces : []) {
    const ws = normalizeWorkspace(w, dropped);
    if (!ws || seen.has(ws.id) || workspaces.length >= MAX_WORKSPACES) {
      dropped.workspaces++;
      continue;
    }
    seen.add(ws.id);
    workspaces.push(ws);
  }
  return { doc: { version: target, workspaces }, from, tooNew, dropped };
}

// ------------------------------------------------------------------ the three operations (Rust applies the same)

export type WsOp =
  | { t: 'upsert'; id: string; fields: Record<string, unknown> }
  | { t: 'remove'; id: string }
  | { t: 'reorder'; ids: string[] };

/**
 * Applies an operation to a document and returns the new document (the old one is left alone).
 * upsert: merges the given top-level fields into the workspace with that id, or adds it first
 * in the list. remove: drops it. reorder: the listed ids first, in that order, then the rest as
 * they were. All three can run twice without changing the result.
 */
export function applyOp<D extends { workspaces: unknown[] }>(doc: D, op: WsOp): D {
  const list = doc.workspaces.slice() as Array<Obj>;
  const idOf = (w: Obj) => w.id;
  if (op.t === 'upsert') {
    const fields = { ...op.fields };
    delete fields.id;
    const at = list.findIndex((w) => idOf(w) === op.id);
    if (at >= 0) list[at] = { ...list[at], ...fields };
    else list.unshift({ id: op.id, ...fields });
  } else if (op.t === 'remove') {
    const at = list.findIndex((w) => idOf(w) === op.id);
    if (at >= 0) list.splice(at, 1);
  } else {
    const byId = new Map(list.map((w) => [idOf(w), w]));
    const out: Obj[] = [];
    for (const id of op.ids) {
      const w = byId.get(id);
      if (w) {
        out.push(w);
        byId.delete(id);
      }
    }
    for (const w of list) if (byId.has(idOf(w))) out.push(w);
    return { ...doc, workspaces: out };
  }
  return { ...doc, workspaces: list };
}

/** The fields of a workspace that the editor owns. */
export function editorFields(ws: Workspace): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EDITOR_FIELDS) out[k] = structuredClone(ws[k]);
  return out;
}

/**
 * The new full order after moving `id` to just before `before` (null = the end) within a
 * section of the list: the others keep their places.
 */
export function moveBefore(order: string[], id: string, before: string | null): string[] {
  const out = order.filter((x) => x !== id);
  const at = before === null ? -1 : out.indexOf(before);
  if (at < 0) out.push(id);
  else out.splice(at, 0, id);
  return out;
}

// ------------------------------------------------------------------ reading a workspace

export function wsColor(ws: Pick<Workspace, 'color'>, fallback: string): string {
  return (ws.color && ACCENTS[ws.color]) || fallback;
}

export function displayName(ws: Pick<Workspace, 'name'>): string {
  return ws.name.trim() || 'Untitled workspace';
}

/** How many items of each kind are switched on, in the usual order, kinds with none left out. */
export function contents(ws: Pick<Workspace, 'resources'>): Array<{ kind: ResourceKind; count: number }> {
  return RESOURCE_KINDS.map((kind) => ({ kind, count: ws.resources.filter((r) => r.enabled && r.kind === kind).length })).filter((c) => c.count > 0);
}

export function countText(kind: ResourceKind, count: number): string {
  const m = KIND_META[kind];
  return `${count} ${count === 1 ? m.one : m.many}`;
}

/** "3 apps · 2 sites · 1 command", or "Nothing to open yet". */
export function contentsText(ws: Pick<Workspace, 'resources'>): string {
  const c = contents(ws);
  return c.length ? c.map((x) => countText(x.kind, x.count)).join(' · ') : 'Nothing to open yet';
}

export function baseName(path: string): string {
  const parts = path.trim().replace(/^"|"$/g, '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** "Code" for C:\...\Code.exe, "Visual Studio Code" for its Start menu shortcut. */
export function appName(path: string): string {
  return baseName(path).replace(/\.(exe|lnk|bat|cmd|com|msc|appref-ms|url)$/i, '');
}

/** "github.com/moss/island" for https://www.github.com/moss/island/. */
export function urlText(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    const path = u.pathname.replace(/\/$/, '');
    return `${u.host.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

export function itemTitle(r: Resource): string {
  if (r.label.trim()) return r.label.trim();
  switch (r.kind) {
    case 'app':
      return appName(r.path) || 'App';
    case 'file':
      return baseName(r.path) || 'File';
    case 'folder':
      return baseName(r.path) || r.path.trim() || 'Folder';
    case 'url':
      return urlText(r.url.trim()) || 'Website';
    case 'command': {
      const line = r.command.trim().split(/\r?\n/)[0] ?? '';
      return line ? (line.length > 48 ? `${line.slice(0, 47)}…` : line) : 'Command';
    }
  }
}

/** A long path with its middle left out, keeping where it starts and what it ends in. */
export function shortPath(path: string, max = 56): string {
  const p = path.trim();
  if (p.length <= max) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]/);
  // The root and the first folder: "C:\Users", "/Users", or "\\server\share" (two blanks first).
  const keep = parts[0] === '' ? (parts[1] === '' ? 4 : 2) : 2;
  if (parts.length <= keep + 1) return p;
  const head = parts.slice(0, keep).join(sep);
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= keep; i--) {
    const longer = `${parts[i]}${sep}${tail}`;
    if (head.length + longer.length + 3 > max) break;
    tail = longer;
  }
  const out = `${head}${sep}…${sep}${tail}`;
  return out.length < p.length ? out : p;
}

/** The second line under an item's name: its path, address or command (`short`: long paths shortened). */
export function itemDetail(r: Resource, short = false): string {
  const path = (p: string) => (short ? shortPath(p) : p);
  switch (r.kind) {
    case 'app':
      return [path(r.path), r.args].filter((s) => s.trim()).join('  ');
    case 'file':
    case 'folder':
      return path(r.path);
    case 'url':
      return r.url;
    case 'command':
      return r.command.trim();
  }
}

/** The paths an item needs to exist, with the kind of thing each must be. */
export function itemPaths(r: Resource): Array<{ path: string; want: 'file' | 'dir' | 'any'; field: string }> {
  const out: Array<{ path: string; want: 'file' | 'dir' | 'any'; field: string }> = [];
  const add = (path: string, want: 'file' | 'dir' | 'any', field: string) => {
    if (path.trim()) out.push({ path: path.trim(), want, field });
  };
  if (r.kind === 'app') {
    // A Store app is started by its id (shell:AppsFolder\Package!App), not found on disk.
    if (!/^shell:appsfolder\\/i.test(r.path.trim())) add(r.path, 'file', 'path');
    add(r.cwd, 'dir', 'cwd');
  } else if (r.kind === 'file') {
    add(r.path, 'file', 'path');
    add(r.openWith, 'file', 'openWith');
  } else if (r.kind === 'folder') add(r.path, 'dir', 'path');
  else if (r.kind === 'command') add(r.cwd, 'dir', 'cwd');
  return out;
}

/** Adds https:// to an address typed without one ("github.com/moss"). */
export function normalizeUrl(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^:/]+\.[^:/]+:\d+/.test(t) && !/^localhost:\d+/i.test(t)) return t;
  return `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t) ? 'http' : 'https'}://${t}`;
}

/** What is wrong with an item before anything is checked on disk; null when it looks fine. */
export function itemProblem(r: Resource): string | null {
  switch (r.kind) {
    case 'app':
      return r.path.trim() ? null : 'Choose the app to start.';
    case 'file':
      return r.path.trim() ? null : 'Choose a file.';
    case 'folder':
      return r.path.trim() ? null : 'Choose a folder.';
    case 'url': {
      const t = r.url.trim();
      if (!t) return 'Type the address.';
      let u: URL;
      try {
        u = new URL(t);
      } catch {
        return "That address doesn't look right.";
      }
      if (!URL_SCHEMES.includes(u.protocol.replace(/:$/, '').toLowerCase())) return 'Island opens web addresses (http, https) and app links like vscode:.';
      return /[\r\n\0]/.test(t) ? "That address doesn't look right." : null;
    }
    case 'command':
      return r.command.trim() ? null : 'Type the command to run.';
  }
}

/** How well a workspace matches a search: 0 = not at all, higher = better. */
export function matchScore(ws: Workspace, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = ws.name.toLowerCase();
  if (name.startsWith(q)) return 100;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (name.includes(q)) return 60;
  if (ws.description.toLowerCase().includes(q)) return 40;
  if (`${ws.notes.text}\n${ws.notes.next}`.toLowerCase().includes(q)) return 30;
  if (ws.resources.some((r) => `${itemTitle(r)}\n${itemDetail(r)}`.toLowerCase().includes(q))) return 20;
  if (ws.cwd.toLowerCase().includes(q)) return 10;
  return 0;
}

export type WsSort = 'manual' | 'recent' | 'name';

/** The list in the chosen order: 'manual' is the user's own (the file's order). */
export function sortWorkspaces(list: Workspace[], sort: WsSort): Workspace[] {
  if (sort === 'manual') return list.slice();
  if (sort === 'name') return list.slice().sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true }));
  return list.slice().sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.updatedAt - a.updatedAt);
}
