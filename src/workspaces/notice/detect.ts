// Workspaces' reading of the window in front (Notice what I work on): which project it belongs
// to and which file it shows,
// from the program and the window title alone (editors put "file - folder - Editor" in their
// titles, Office "Report.docx - Word", terminals a path), and which workspace that is. Pure: the
// tests feed it titles. Titles are only read here; what's kept is decided in model.ts.

import { appName, baseName, type Workspace } from '../model';

export interface Signal {
  /** The program's file name ("Code.exe"). */
  app: string;
  /** The project or folder the window is about, as its title names it; null when it doesn't. */
  project: string | null;
  /** The file it shows, when its title says (with an extension). */
  file: string | null;
}

const lower = (s: string) => s.trim().toLowerCase();

/** VS Code and the editors built on it: "● file — folder — Visual Studio Code". */
const CODE_EDITORS = new Set(['code', 'code - insiders', 'cursor', 'windsurf', 'vscodium', 'codium', 'zed', 'sublime_text']);
/** JetBrains IDEs: "project – file". */
const JETBRAINS = /^(idea|pycharm|webstorm|phpstorm|rider|clion|goland|rubymine|datagrip|studio|fleet)(64)?$/;
const TERMINALS = new Set(['windowsterminal', 'powershell', 'pwsh', 'cmd', 'wezterm-gui', 'alacritty', 'conhost', 'mintty', 'git-bash']);
const OFFICE = new Set(['winword', 'excel', 'powerpnt', 'onenote', 'acrord32', 'acrobat', 'notepad', 'notepad++', 'wordpad', 'obsidian', 'typora']);
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'zen']);
const FILE_RE = /^[^\\/:*?"<>|]+\.[A-Za-z0-9]{1,8}$/;

/** "a - b - c" or "a — b — c" into its parts. */
function parts(title: string): string[] {
  return title
    .split(/\s+[-—–]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A file name from a title part: "● app.ts" (unsaved), "app.ts (Working Tree)" both give "app.ts". */
function fileName(part: string | undefined): string | null {
  if (!part) return null;
  const clean = part.replace(/^[●•*]\s*/, '').replace(/\s*\((Working Tree|Index|Read-only|Preview|Compatibility Mode|Protected View)\)$/i, '').trim();
  return FILE_RE.test(clean) ? clean : null;
}

/** A folder name from an editor's title part: "island [WSL: Ubuntu]" or "site (Workspace)" give the name. */
function folderName(part: string | undefined): string | null {
  if (!part) return null;
  const clean = part.replace(/\s*\[[^\]]*\]$/, '').replace(/\s*\((Workspace|Admin)\)$/i, '').trim();
  return clean && clean.length <= 80 ? clean : null;
}

/** The last folder of a path in a title ("PS C:\code\island>", "MINGW64:/c/code/island"). */
function pathTail(title: string): string | null {
  const m = title.match(/([A-Za-z]:\\[^<>|"?*]*|\/[^<>|"?*]*)/);
  if (!m) return null;
  const tail = baseName(m[1].replace(/[>\s]+$/, ''));
  return tail && !/^[A-Za-z]:$/.test(tail) ? tail : null;
}

/** What a window is about, from its program and title. */
export function detect(exe: string, title: string, className = ''): Signal {
  const app = baseName(exe);
  const name = lower(appName(exe));
  const p = parts(title);
  let project: string | null = null;
  let file: string | null = null;
  if (CODE_EDITORS.has(name)) {
    // [file, folder, app] or [folder, app] or [file, app] (a loose file).
    if (p.length >= 3) {
      file = fileName(p[0]);
      project = folderName(p[p.length - 2]);
    } else if (p.length === 2) {
      file = fileName(p[0]);
      project = file ? null : folderName(p[0]);
    }
  } else if (JETBRAINS.test(name)) {
    project = folderName(p[0]);
    file = fileName(p[1]);
  } else if (name === 'devenv') {
    project = folderName(p[0]?.replace(/\s*\(Running\)$/i, ''));
  } else if (name === 'explorer' && (className === 'CabinetWClass' || className === '')) {
    project = p.length === 1 ? folderName(p[0]) : null;
  } else if (TERMINALS.has(name)) {
    project = pathTail(title);
  } else if (OFFICE.has(name)) {
    file = fileName(p[0]);
  } else if (BROWSERS.has(name)) {
    // A page title says nothing reliable about projects.
  } else if (p.length >= 2) {
    // Most apps: "Document - App". Only a real file name counts.
    file = fileName(p[0]);
  }
  return { app, project, file };
}

/** How sure a workspace is the one a window belongs to; 0 = not this one. */
export function workspaceScore(sig: Signal, title: string, ws: Workspace): number {
  if (ws.archived) return 0;
  const folder = lower(baseName(ws.cwd));
  const project = sig.project ? lower(sig.project) : '';
  let score = 0;
  if (folder && project === folder) score += 6;
  for (const r of ws.resources) {
    if (r.kind === 'folder' && project && lower(baseName(r.path)) === project) score += 5;
    if (r.kind === 'file' && sig.file && lower(baseName(r.path)) === lower(sig.file)) score += 5;
  }
  // The project folder's name in the title as a word ("island" in "PS C:\code\island>").
  if (folder.length >= 3 && !score) {
    const words = lower(title).split(/[^\p{L}\p{N}._-]+/u);
    if (words.includes(folder)) score += 3;
  }
  // The app alone is only a tiebreaker: a browser belongs to every workspace.
  if (score && ws.resources.some((r) => r.kind === 'app' && lower(appName(r.path)) === lower(appName(sig.app)))) score += 1;
  return score;
}

/** The workspace a window belongs to, if one clearly does (ties: the one opened last). */
export function matchWorkspace(sig: Signal, title: string, list: Workspace[]): Workspace | null {
  let best: Workspace | null = null;
  let bestScore = 0;
  for (const ws of list) {
    const s = workspaceScore(sig, title, ws);
    if (s > bestScore || (s === bestScore && s > 0 && best && (ws.lastOpenedAt ?? 0) > (best.lastOpenedAt ?? 0))) {
      best = ws;
      bestScore = s;
    }
  }
  return bestScore >= 3 ? best : null;
}

/**
 * The workspaces in use: those with a window open now, each window going to the workspace it
 * clearly belongs to (read the way the window in front is). Nothing is kept.
 */
export function workspacesInUse(windows: ReadonlyArray<{ exe: string; title: string; className?: string }>, list: Workspace[]): Set<string> {
  const ids = new Set<string>();
  for (const w of windows) {
    const ws = matchWorkspace(detect(w.exe, w.title, w.className), w.title, list);
    if (ws) ids.add(ws.id);
  }
  return ids;
}

export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
