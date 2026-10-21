import { describe, expect, it } from 'vitest';
import type { PathCheck, Tried, WsLoaded } from '../src/core/native';
import { checkWorkspace, pathProblem } from '../src/workspaces/checks';
import {
  applyOp,
  contentsText,
  duplicateWorkspace,
  editorFields,
  HISTORY_MAX,
  itemDetail,
  itemPaths,
  itemProblem,
  itemTitle,
  matchScore,
  moveBefore,
  newResource,
  newWorkspace,
  normalizeUrl,
  readDoc,
  shortPath,
  sortWorkspaces,
  WS_VERSION,
  type Workspace,
  type WsDoc,
  type WsOp,
} from '../src/workspaces/model';
import { localBackend, WorkspaceStore, type Backend } from '../src/workspaces/store';

const tick = () => new Promise((r) => setTimeout(r, 0));

function memory(initial: string | null = null) {
  let text = initial;
  return { get: () => text, set: (t: string) => void (text = t), peek: () => (text ? JSON.parse(text) : null) };
}

function ws(name: string, extra: Partial<Workspace> = {}): Workspace {
  return { ...newWorkspace({ name }), ...extra };
}

describe('workspace model', () => {
  it('makes workspaces and items with safe defaults', () => {
    const w = newWorkspace({ name: 'School', icon: 'book', color: 'mint' });
    expect(w).toMatchObject({ name: 'School', icon: 'book', color: 'mint', favorite: false, archived: false, lastOpenedAt: null, resources: [], history: [] });
    expect(w.id).toMatch(/^ws_[a-z0-9]+$/);
    expect(newWorkspace().id).not.toBe(w.id);
    expect(newResource('app')).toMatchObject({ kind: 'app', mode: 'auto', reuse: true, enabled: true });
    // A command never runs on its own unless the user says so.
    expect(newResource('command')).toMatchObject({ kind: 'command', mode: 'ask', shell: 'powershell', host: 'terminal' });
    expect(newResource('url', { url: 'https://a.example' })).toMatchObject({ kind: 'url', url: 'https://a.example' });
  });

  it('reads nothing saved as an empty document to set up', () => {
    for (const raw of [null, undefined, 'text', [1]]) {
      const r = readDoc(raw);
      expect(r.from).toBeNull();
      expect(r.doc).toEqual({ version: WS_VERSION, workspaces: [] });
    }
  });

  it('checks every field of a saved file, keeping what it can', () => {
    const raw = {
      version: 1,
      workspaces: [
        {
          id: 'ws_a',
          name: 'A'.repeat(200),
          icon: 'no-such-icon',
          color: 'chartreuse',
          favorite: 'yes',
          resources: [
            { id: 'it_1', kind: 'app', path: 'C:\\code.exe', mode: 'sometimes' },
            { id: 'it_1', kind: 'url', url: 'https://x.example' },
            { kind: 'teleporter' },
            'junk',
            { kind: 'command', command: 'npm run dev', shell: 'fish' },
          ],
          history: Array.from({ length: 14 }, (_, i) => ({ at: 1000 + i, outcome: 'done', steps: [] })),
          layout: { savedAt: 5, monitors: [], windows: [{ exe: 'C:\\code.exe', rect: { x: 0, y: 0, width: 800, height: 600 } }, { exe: '', rect: null }] },
        },
        { id: 'ws_a', name: 'same id again' },
        { name: 'no id' },
      ],
    };
    const r = readDoc(raw);
    expect(r.from).toBe(1);
    expect(r.tooNew).toBe(false);
    expect(r.dropped).toEqual({ workspaces: 2, items: 2 });
    const [w] = r.doc.workspaces;
    expect(w.name).toHaveLength(80);
    expect(w.icon).toBe('grid');
    expect(w.color).toBe('');
    expect(w.favorite).toBe(false);
    expect(w.resources.map((x) => x.kind)).toEqual(['app', 'url', 'command']);
    expect(w.resources[0].mode).toBe('auto');
    // Two items with one id: the second gets its own, so editing one never edits the other.
    expect(w.resources[1].id).not.toBe('it_1');
    expect(w.resources[2]).toMatchObject({ mode: 'ask', shell: 'powershell' });
    expect(w.history).toHaveLength(HISTORY_MAX);
    expect(w.history[0].at).toBe(1013);
    expect(w.layout?.windows).toHaveLength(1);
  });

  it('leaves a file from a newer Island as it is', () => {
    const r = readDoc({ version: 99, workspaces: [{ id: 'ws_a', name: 'A' }] });
    expect(r.tooNew).toBe(true);
    expect(r.doc.workspaces[0].name).toBe('A');
  });

  it('upgrades an old file step by step', () => {
    const steps = { 1: (d: Record<string, unknown>) => ({ ...d, workspaces: (d.workspaces as Array<Record<string, unknown>>).map((w) => ({ ...w, name: w.title })) }) };
    const r = readDoc({ version: 1, workspaces: [{ id: 'ws_a', title: 'Renamed field' }] }, steps, 2);
    expect(r.from).toBe(1);
    expect(r.doc.version).toBe(2);
    expect(r.doc.workspaces[0].name).toBe('Renamed field');
    // No step from here: treated as too new, never written back.
    expect(readDoc({ version: 1, workspaces: [] }, {}, 3).tooNew).toBe(true);
  });

  it('applies the three operations like Rust does, twice without harm', () => {
    const doc: WsDoc = { version: 1, workspaces: [ws('A', { id: 'a' }), ws('B', { id: 'b' }), ws('C', { id: 'c' })] };
    const ops: WsOp[] = [
      { t: 'upsert', id: 'n', fields: { name: 'New', id: 'evil' } },
      { t: 'upsert', id: 'b', fields: { name: 'B2' } },
      { t: 'reorder', ids: ['c', 'zzz', 'a'] },
      { t: 'remove', id: 'a' },
    ];
    let once = doc;
    for (const op of ops) once = applyOp(once, op);
    let twice = doc;
    for (const op of ops) twice = applyOp(applyOp(twice, op), op);
    expect(once.workspaces.map((w) => w.id)).toEqual(['c', 'n', 'b']);
    expect(once.workspaces[2].name).toBe('B2');
    expect(once.workspaces[2].favorite).toBe(false);
    expect(twice).toEqual(once);
    expect(doc.workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('moves an id before another, or to the end', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveBefore(['a', 'b', 'c', 'd'], 'a', null)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveBefore(['a', 'b'], 'a', 'gone')).toEqual(['b', 'a']);
  });

  it('duplicates with new ids and no history', () => {
    const app = newResource('app', { path: 'C:\\code.exe' });
    const src = ws('Dev', {
      favorite: true,
      lastOpenedAt: 5,
      resources: [app],
      history: [{ id: 'run_1', at: 5, ms: 1, outcome: 'done', steps: [] }],
      layout: { savedAt: 1, monitors: [], windows: [{ id: 'win_1', exe: 'C:\\code.exe', title: '', className: '', monitor: '', rect: { x: 0, y: 0, width: 1, height: 1 }, rel: { x: 0, y: 0, w: 1, h: 1 }, state: 'normal', resource: app.id, enabled: true }] },
    });
    const copy = duplicateWorkspace(src);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('Dev copy');
    expect(copy).toMatchObject({ favorite: false, lastOpenedAt: null, history: [] });
    expect(copy.resources[0].id).not.toBe(app.id);
    expect(copy.layout?.windows[0].resource).toBe(copy.resources[0].id);
    expect(src.resources[0].id).toBe(app.id);
  });

  it('names items from what they open', () => {
    expect(itemTitle(newResource('app', { path: 'C:\\Users\\m\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' }))).toBe('Code');
    expect(itemTitle(newResource('app', { path: '"C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk"' }))).toBe('Visual Studio Code');
    expect(itemTitle(newResource('url', { url: 'https://www.github.com/moss/island/' }))).toBe('github.com/moss/island');
    expect(itemTitle(newResource('folder', { path: 'D:\\Music\\Sets\\' }))).toBe('Sets');
    expect(itemTitle(newResource('command', { command: 'npm run dev\nnpm test' }))).toBe('npm run dev');
    expect(itemTitle(newResource('file', { path: 'C:\\a.txt', label: 'Essay' }))).toBe('Essay');
    expect(itemDetail(newResource('app', { path: 'code', args: '.' }))).toBe('code  .');
    expect(itemTitle(newResource('url', { url: 'http://localhost:5173' }))).toBe('localhost:5173');
  });

  it('shortens long paths in the middle, keeping both ends', () => {
    const long = 'C:\\Users\\sport\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\bin\\Code.exe';
    const short = shortPath(long, 40);
    expect(short.startsWith('C:\\Users\\…\\')).toBe(true);
    expect(short.endsWith('\\Code.exe')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(40);
    expect(shortPath('C:\\short\\path.txt', 40)).toBe('C:\\short\\path.txt');
    expect(shortPath('/Users/moss/Music/Projects/2026/Album/Mix/final-final-v3.als', 30)).toBe('/Users/…/final-final-v3.als');
    expect(shortPath('\\\\server\\share\\very\\deep\\folder\\with\\a\\file.txt', 34)).toBe('\\\\server\\share\\…\\with\\a\\file.txt');
    expect(itemDetail(newResource('file', { path: long }), true)).toBe(shortPath(long));
  });

  it('cleans up typed addresses and refuses what it should not open', () => {
    expect(normalizeUrl('github.com/moss')).toBe('https://github.com/moss');
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('https://a.example')).toBe('https://a.example');
    expect(normalizeUrl('vscode://file/C:/x')).toBe('vscode://file/C:/x');
    const url = (u: string) => itemProblem(newResource('url', { url: u }));
    expect(url('https://a.example/x?y=1')).toBeNull();
    expect(url('vscode://anthropic.claude-code/open')).toBeNull();
    expect(url('javascript:alert(1)')).not.toBeNull();
    expect(url('file:///C:/Windows/System32/cmd.exe')).not.toBeNull();
    expect(url('not a url')).not.toBeNull();
    expect(url('')).toBe('Type the address.');
    expect(itemProblem(newResource('command'))).toBe('Type the command to run.');
    expect(itemProblem(newResource('app', { path: 'code' }))).toBeNull();
    // Store apps are started by id: nothing on disk to look for.
    expect(itemPaths(newResource('app', { path: 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }))).toEqual([]);
  });

  it('searches names first, then the rest', () => {
    const a = ws('School', { description: 'Calculus' });
    const b = ws('Music production', { notes: { text: 'school concert mix', next: '', savedAt: null } });
    const c = ws('Dev', { resources: [newResource('url', { url: 'https://school.example' })] });
    const d = ws('Games');
    const scored = [a, b, c, d].map((w) => matchScore(w, 'school'));
    expect(scored[0]).toBeGreaterThan(scored[1]);
    expect(scored[1]).toBeGreaterThan(scored[2]);
    expect(scored[2]).toBeGreaterThan(0);
    expect(scored[3]).toBe(0);
    expect(matchScore(b, 'prod')).toBe(80);
  });

  it('sorts by the user’s order, the last opened, or the name', () => {
    const list = [ws('beta', { lastOpenedAt: 10 }), ws('Alpha', { lastOpenedAt: null }), ws('gamma 2', { lastOpenedAt: 30 }), ws('Gamma 10', { lastOpenedAt: 20 })];
    expect(sortWorkspaces(list, 'manual').map((w) => w.name)).toEqual(['beta', 'Alpha', 'gamma 2', 'Gamma 10']);
    expect(sortWorkspaces(list, 'recent').map((w) => w.name)).toEqual(['gamma 2', 'Gamma 10', 'beta', 'Alpha']);
    expect(sortWorkspaces(list, 'name').map((w) => w.name)).toEqual(['Alpha', 'beta', 'gamma 2', 'Gamma 10']);
  });

  it('says what a workspace holds', () => {
    const w = ws('Dev', {
      resources: [newResource('app', { path: 'code' }), newResource('app', { path: 'wt' }), newResource('url', { url: 'https://a.example' }), newResource('command', { command: 'x', enabled: false })],
    });
    expect(contentsText(w)).toBe('2 apps · 1 site');
    expect(contentsText(ws('Empty'))).toBe('Nothing to open yet');
  });

  it("gives the editor only the fields it owns", () => {
    const w = ws('Dev', { favorite: true, lastOpenedAt: 9 });
    const f = editorFields(w);
    expect(Object.keys(f).sort()).toEqual(['color', 'cwd', 'description', 'icon', 'name', 'notes', 'prefs', 'resources', 'updatedAt']);
  });
});

describe('workspace checks', () => {
  // A disk with one project folder, a file in it, and a program found by name.
  const disk: Record<string, PathCheck> = {
    'D:\\proj': { state: 'dir', resolved: null },
    'D:\\proj\\notes.md': { state: 'file', resolved: null },
    'notes.md': { state: 'file', resolved: 'D:\\proj\\notes.md' },
    code: { state: 'file', resolved: 'C:\\Programs\\VS Code\\Code.exe' },
  };
  const checker = async (paths: string[]) => paths.map((p) => disk[p] ?? { state: 'missing' as const, resolved: null });

  it('says what can’t open and why, item by item', async () => {
    const items = [
      newResource('app', { path: 'code' }),
      newResource('file', { path: 'notes.md' }),
      newResource('file', { path: 'D:\\proj' }),
      newResource('folder', { path: 'D:\\proj\\notes.md' }),
      newResource('folder', { path: 'E:\\unplugged' }),
      newResource('app', { path: 'code', cwd: 'D:\\gone' }),
      newResource('url', { url: 'ftp://x' }),
      newResource('command', { command: 'npm run dev' }),
    ];
    const r = await checkWorkspace({ cwd: 'D:\\proj', resources: items }, checker);
    const problem = (i: number) => r.items.get(items[i].id)?.problem;
    expect(r.cwd).toBeNull();
    expect(problem(0)).toBeNull();
    expect(r.items.get(items[0].id)?.found).toBe('C:\\Programs\\VS Code\\Code.exe');
    expect(problem(1)).toBeNull();
    expect(problem(2)).toMatch(/folder, not a file/);
    expect(problem(3)).toMatch(/file, not a folder/);
    expect(problem(4)).toBe('Not found: E:\\unplugged');
    expect(problem(5)).toBe('Start-in folder not found: D:\\gone');
    expect(problem(6)).toMatch(/web addresses/);
    expect(problem(7)).toBeNull();
  });

  it('checks the project folder, and says nothing outside the app', async () => {
    const r = await checkWorkspace({ cwd: 'Z:\\nowhere', resources: [] }, checker);
    expect(r.cwd).toBe('Folder not found: Z:\\nowhere');
    expect(pathProblem({ state: 'unknown', resolved: null }, 'file', 'x')).toBeNull();
    expect(pathProblem({ state: 'dir', resolved: null }, 'file', '/Applications/Notes.app')).toBeNull();
  });
});

describe('workspace store', () => {
  it('sets up an empty file on first use', async () => {
    const mem = memory();
    const store = new WorkspaceStore('app', localBackend(mem));
    await store.load();
    expect(store.ready).toBe(true);
    expect(store.list).toEqual([]);
    expect(mem.peek()).toEqual({ version: WS_VERSION, workspaces: [] });
  });

  it('shows a change at once and keeps it', async () => {
    const mem = memory();
    const store = new WorkspaceStore('app', localBackend(mem));
    await store.load();
    let redraws = 0;
    store.subscribe(() => redraws++);
    const w = ws('School');
    const saving = store.add(w);
    expect(store.list.map((x) => x.name)).toEqual(['School']);
    expect(await saving).toBe(true);
    await tick();
    expect(store.list.map((x) => x.name)).toEqual(['School']);
    expect(mem.peek().workspaces[0].name).toBe('School');
    expect(redraws).toBe(1);
    // Quiet changes (typing a note) don't redraw this window.
    await store.update(w.id, { notes: { text: 'half done', next: '', savedAt: 1 } }, true);
    await tick();
    expect(redraws).toBe(1);
    expect(store.get(w.id)?.notes.text).toBe('half done');
  });

  it('keeps both windows in step', async () => {
    const mem = memory();
    const backend = localBackend(mem);
    const app = new WorkspaceStore('app', backend);
    const island = new WorkspaceStore('island', backend);
    await app.load();
    await island.load();
    const w = ws('Dev');
    await app.add(w);
    await island.update(w.id, { lastOpenedAt: 1234 });
    await app.update(w.id, { name: 'Development' });
    await tick();
    for (const s of [app, island]) {
      expect(s.get(w.id)).toMatchObject({ name: 'Development', lastOpenedAt: 1234 });
    }
  });

  it('never loses its own change to an older document arriving late', async () => {
    let listener: (doc: unknown, rev: number, origin: string) => void = () => {};
    const backend: Backend = {
      load: async (): Promise<WsLoaded> => ({ doc: { version: 1, workspaces: [] }, rev: 3, recovered: null, blocked: null }),
      init: async (): Promise<Tried<WsLoaded>> => ({ ok: false, error: 'unused' }),
      replace: async (): Promise<Tried<number>> => ({ ok: false, error: 'unused' }),
      // Rust took the change as revision 5; revision 4 (the other window's) is still on its way.
      op: async (): Promise<Tried<number>> => ({ ok: true, value: 5 }),
      listen: async (cb) => void (listener = cb),
    };
    const store = new WorkspaceStore('app', backend);
    await store.load();
    const mine = ws('Mine', { id: 'ws_mine' });
    await store.add(mine);
    const theirs = { id: 'ws_theirs', name: 'Theirs' };
    listener({ version: 1, workspaces: [theirs] }, 4, 'island');
    expect(store.list.map((w) => w.id).sort()).toEqual(['ws_mine', 'ws_theirs']);
    listener({ version: 1, workspaces: [{ ...mine }, theirs] }, 5, 'app');
    expect(store.list.map((w) => w.id)).toEqual(['ws_mine', 'ws_theirs']);
    // An echo older than what it has changes nothing.
    listener({ version: 1, workspaces: [] }, 4, 'island');
    expect(store.list).toHaveLength(2);
  });

  it('takes a failed save back and says why', async () => {
    const errors: string[] = [];
    const store = new WorkspaceStore('app', localBackend(memory()), (m) => errors.push(m));
    await store.load();
    expect(await store.add(ws('Bad', { id: 'not a good id' }))).toBe(false);
    expect(store.list).toEqual([]);
    expect(errors[0]).toMatch(/Couldn't save/);
  });

  it('only shows workspaces from a newer Island', async () => {
    const errors: string[] = [];
    const mem = memory(JSON.stringify({ version: 99, workspaces: [{ id: 'ws_a', name: 'From the future' }] }));
    const store = new WorkspaceStore('app', localBackend(mem), (m) => errors.push(m));
    await store.load();
    expect(store.readOnly).toMatch(/newer version/);
    expect(store.list[0].name).toBe('From the future');
    expect(await store.update('ws_a', { name: 'x' })).toBe(false);
    expect(mem.peek().workspaces[0].name).toBe('From the future');
    expect(errors).toHaveLength(1);
  });
});
