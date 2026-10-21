// A new workspace handed from the island to the Activities window ("Make it a workspace" on
// something Trail noticed). Both windows share the browser storage, so the island leaves the
// seed there and opens the window; the Workspaces page takes it on load or on 'ws-seed'.

const KEY = 'island:ws-seed';
/** A seed older than this was left by a window that never opened: dropped. */
const FRESH_MS = 10 * 60 * 1000;

export interface Seed {
  name: string;
  description?: string;
  cwd?: string;
  /** Programs (full paths) to start. */
  apps?: string[];
}

export function leaveSeed(seed: Seed): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...seed, at: Date.now() }));
  } catch {
    // Storage off: the window opens without it.
  }
}

export function takeSeed(): Seed | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const v = JSON.parse(raw) as Partial<Seed> & { at?: number };
    if (typeof v.name !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > FRESH_MS) return null;
    return {
      name: v.name.slice(0, 80),
      description: typeof v.description === 'string' ? v.description.slice(0, 300) : undefined,
      cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
      apps: Array.isArray(v.apps) ? v.apps.filter((a): a is string => typeof a === 'string').slice(0, 10) : undefined,
    };
  } catch {
    return null;
  }
}
