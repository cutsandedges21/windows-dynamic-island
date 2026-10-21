// Whether a workspace's items can open: what's missing from an item (no path, a bad
// address), then whether the files, folders and programs it names are there. Only
// existence and kind are asked of the disk (ws_check), never contents.

import { native, type PathCheck } from '../core/native';
import { itemPaths, itemProblem, type Workspace } from './model';

export interface ItemCheck {
  /** What stops it opening, in words; null when nothing does (as far as can be told). */
  problem: string | null;
  /** Where its program or file was found, when not exactly as typed. */
  found: string | null;
}

export interface WorkspaceCheck {
  items: Map<string, ItemCheck>;
  /** What's wrong with the project folder, if anything. */
  cwd: string | null;
}

export type Checker = (paths: string[], base: string) => Promise<PathCheck[]>;

const FIELD_NAMES: Record<string, string> = { cwd: 'Start-in folder', openWith: 'The program to open it with' };

/** One path's answer, as a problem for this kind of field; null when it's what was wanted. */
export function pathProblem(c: PathCheck, want: 'file' | 'dir' | 'any', path: string, field = 'path'): string | null {
  const what = FIELD_NAMES[field];
  switch (c.state) {
    case 'unknown':
      return null;
    case 'invalid':
      return `${what ?? 'That'} can't be a path: ${path}`;
    case 'missing':
      return what ? `${what} not found: ${path}` : `Not found: ${path}`;
    case 'dir':
      // A Mac app is a folder (Something.app).
      return want === 'file' && !/\.app\/?$/i.test(path) ? `${what ?? 'That'} is a folder, not a file: ${path}` : null;
    case 'file':
      return want === 'dir' ? `${what ?? 'That'} is a file, not a folder: ${path}` : null;
  }
}

/** Every item's problem, and the project folder's. */
export async function checkWorkspace(ws: Pick<Workspace, 'cwd' | 'resources'>, checker: Checker = native.wsCheck): Promise<WorkspaceCheck> {
  const items = new Map<string, ItemCheck>();
  const asks: Array<{ path: string; want: 'file' | 'dir' | 'any'; item: string | null; field: string }> = [];
  for (const r of ws.resources) {
    const problem = itemProblem(r);
    items.set(r.id, { problem, found: null });
    if (problem) continue;
    for (const p of itemPaths(r)) asks.push({ ...p, item: r.id });
  }
  const cwd = ws.cwd.trim();
  const [own, rest] = await Promise.all([
    cwd ? checker([cwd], '') : Promise.resolve([] as PathCheck[]),
    asks.length ? checker(asks.map((a) => a.path), cwd) : Promise.resolve([] as PathCheck[]),
  ]);
  const cwdProblem = own[0] ? pathProblem(own[0], 'dir', cwd)?.replace(/^Not found/, 'Folder not found') ?? null : null;
  asks.forEach((a, i) => {
    const c = rest[i];
    if (!c || !a.item) return;
    const entry = items.get(a.item)!;
    const problem = pathProblem(c, a.want, a.path, a.field);
    if (problem && !entry.problem) entry.problem = problem;
    if (!problem && a.field === 'path' && c.resolved) entry.found = c.resolved;
  });
  return { items, cwd: cwdProblem };
}
