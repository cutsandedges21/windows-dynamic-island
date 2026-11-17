import { describe, expect, it } from 'vitest';
import { detect, matchWindow, matchWorkspace, programsOf, sameIds, workspacesInUse, type ItemProgram } from '../src/workspaces/notice/detect';
import { addSample, contexts, duration, emptyTrail, GAP_MS, prune, readTrail, reattribute, settled, type Sample, type TrailDoc } from '../src/workspaces/notice/model';
import { inUseText, newResource, newWorkspace, type Workspace } from '../src/workspaces/model';

const CODE = 'C:\\Users\\m\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';

describe('reading the window in front', () => {
  it('finds the project and file in an editor title', () => {
    expect(detect(CODE, '● app.ts - windows-dynamic-island - Visual Studio Code')).toEqual({ app: 'Code.exe', project: 'windows-dynamic-island', file: 'app.ts' });
    expect(detect(CODE, 'windows-dynamic-island - Visual Studio Code')).toMatchObject({ project: 'windows-dynamic-island', file: null });
    expect(detect(CODE, 'notes.md - Visual Studio Code')).toMatchObject({ project: null, file: 'notes.md' });
    expect(detect(CODE, 'main.rs — island [WSL: Ubuntu] — Visual Studio Code')).toMatchObject({ project: 'island', file: 'main.rs' });
    expect(detect('C:\\x\\Cursor.exe', 'index.ts (Working Tree) - site - Cursor')).toMatchObject({ project: 'site', file: 'index.ts' });
    expect(detect('C:\\JetBrains\\bin\\pycharm64.exe', 'thesis – analysis.py')).toMatchObject({ project: 'thesis', file: 'analysis.py' });
  });

  it('reads terminals, Explorer, Office and leaves browsers alone', () => {
    expect(detect('C:\\x\\WindowsTerminal.exe', 'PS C:\\Users\\m\\code\\island>')).toMatchObject({ project: 'island' });
    expect(detect('C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\system32\\cmd.exe')).toMatchObject({ project: 'cmd.exe' });
    expect(detect('C:\\Windows\\explorer.exe', 'Fall 2026', 'CabinetWClass')).toMatchObject({ project: 'Fall 2026' });
    expect(detect('C:\\Office\\WINWORD.EXE', 'Lab 3 report.docx - Word')).toMatchObject({ project: null, file: 'Lab 3 report.docx' });
    expect(detect('C:\\Edge\\msedge.exe', 'Inbox (3) - Gmail - Microsoft Edge')).toMatchObject({ project: null, file: null });
    expect(detect('C:\\x\\Spotify.exe', 'Spotify Premium')).toMatchObject({ project: null, file: null });
  });

  it('matches the workspace a window belongs to, and only clearly', () => {
    const island: Workspace = { ...newWorkspace({ name: 'Island' }), cwd: 'C:\\code\\windows-dynamic-island', resources: [newResource('app', { path: 'code' })] };
    const school: Workspace = { ...newWorkspace({ name: 'School' }), resources: [newResource('folder', { path: 'D:\\School\\Fall 2026' }), newResource('file', { path: 'D:\\School\\Lab 3 report.docx' })] };
    const list = [island, school];
    const m = (exe: string, title: string, cls = '') => matchWorkspace(detect(exe, title, cls), title, list)?.name ?? null;
    expect(m(CODE, 'app.ts - windows-dynamic-island - Visual Studio Code')).toBe('Island');
    expect(m('C:\\x\\WindowsTerminal.exe', 'PS C:\\code\\windows-dynamic-island>')).toBe('Island');
    expect(m('C:\\Windows\\explorer.exe', 'Fall 2026', 'CabinetWClass')).toBe('School');
    expect(m('C:\\Office\\WINWORD.EXE', 'Lab 3 report.docx - Word')).toBe('School');
    // The editor alone doesn't make it Island's: another project is open in it.
    expect(m(CODE, 'index.ts - other-project - Visual Studio Code')).toBeNull();
    expect(m('C:\\Edge\\msedge.exe', 'Search - Microsoft Edge')).toBeNull();
    // Archived workspaces are left out.
    expect(matchWorkspace(detect(CODE, 'a.ts - windows-dynamic-island - Visual Studio Code'), '', [{ ...island, archived: true }])).toBeNull();
  });

  it('calls a workspace in use while a window of it is open, any window', () => {
    const island: Workspace = { ...newWorkspace({ name: 'Island' }), cwd: 'C:\\code\\windows-dynamic-island' };
    const school: Workspace = { ...newWorkspace({ name: 'School' }), resources: [newResource('file', { path: 'D:\\School\\Lab 3 report.docx' })] };
    const music: Workspace = { ...newWorkspace({ name: 'Music' }), resources: [newResource('app', { path: 'C:\\x\\Spotify.exe' })] };
    const list = [island, school, music];
    const win = (exe: string, title: string, className = '') => ({ exe, title, className });
    const open = [
      win('C:\\Edge\\msedge.exe', 'Inbox - Gmail - Microsoft Edge'),
      // Minimized or behind other windows counts too: it's still open.
      win(CODE, 'app.ts - windows-dynamic-island - Visual Studio Code'),
      win('C:\\x\\WindowsTerminal.exe', 'PS C:\\code\\windows-dynamic-island>'),
      win('C:\\Office\\WINWORD.EXE', 'Lab 3 report.docx - Word'),
      // An app alone doesn't make its workspace in use (a browser belongs to every one).
      win('C:\\x\\Spotify.exe', 'Spotify Premium'),
    ];
    expect([...workspacesInUse(open, list)].sort()).toEqual([island.id, school.id].sort());
    // Closing Word leaves only Island in use.
    expect([...workspacesInUse(open.filter((w) => !w.exe.endsWith('WINWORD.EXE')), list)]).toEqual([island.id]);
    expect(workspacesInUse([], list).size).toBe(0);
    expect(inUseText(island)).toBe('In use');
    expect(inUseText({ notes: { ...island.notes, next: '  finish the lab ' } })).toBe('In use · Next: finish the lab');
    expect(sameIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIds(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});

describe('workspaces made of apps', () => {
  // Shaped like real ones: a browser and a web app for school; two IDEs for a course; an editor on a folder.
  const school: Workspace = { ...newWorkspace({ name: 'School/Class' }), lastOpenedAt: 1, resources: [newResource('app', { path: 'C:\\Users\\m\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe' }), newResource('app', { path: 'C:\\Users\\m\\Desktop\\YouTube Music.lnk' })] };
  const prog: Workspace = { ...newWorkspace({ name: 'Prog' }), lastOpenedAt: 2, resources: [newResource('app', { path: 'C:\\Users\\m\\Desktop\\Apache NetBeans.lnk' }), newResource('app', { path: 'C:\\JetBrains\\IntelliJ IDEA 2026.2\\bin\\idea64.exe' })] };
  const dev: Workspace = { ...newWorkspace({ name: 'Development' }), lastOpenedAt: 3, cwd: 'C:\\Users\\m\\OneDrive\\Documents\\CodingPersonal', resources: [newResource('app', { path: 'C:\\Users\\m\\Desktop\\Cursor.lnk' })] };
  const list = [school, prog, dev];
  // What Rust reads from each app item: shortcuts resolved to their program, a web app's --app-id.
  const items = new Map<string, ItemProgram>([
    [school.resources[1].id, { exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', args: '--profile-directory=Default --app-id=cinhimbnkkaeohfgghhklpknlkffjgod' }],
    [prog.resources[0].id, { exe: 'C:\\Program Files\\NetBeans-25\\netbeans\\bin\\netbeans64.exe', args: '' }],
    [dev.resources[0].id, { exe: 'C:\\Users\\m\\AppData\\Local\\Programs\\cursor\\Cursor.exe', args: '' }],
  ]);
  const programs = new Map(list.map((ws) => [ws.id, programsOf(ws, items)]));
  const m = (exe: string, title: string) => matchWindow(detect(exe, title), title, list, programs)?.name ?? null;

  it('knows each workspace by its programs, and a web app by its name', () => {
    expect([...programs.get(school.id)!.exes]).toEqual(['comet.exe']);
    expect(programs.get(school.id)!.webApps).toEqual(['youtube music']);
    expect([...programs.get(prog.id)!.exes].sort()).toEqual(['idea64.exe', 'netbeans64.exe']);
    expect([...programs.get(dev.id)!.exes]).toEqual(['cursor.exe']);
  });

  it('gives each window to its workspace', () => {
    expect(m('C:\\x\\comet.exe', 'Assignment 3 - Omnivox - Comet')).toBe('School/Class');
    expect(m('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Lofi Beats - YouTube Music')).toBe('School/Class');
    expect(m('C:\\JetBrains\\IntelliJ IDEA 2026.2\\bin\\idea64.exe', 'JavaFXApp – Main.java')).toBe('Prog');
    expect(m('C:\\Program Files\\NetBeans-25\\netbeans\\bin\\netbeans64.exe', 'Lab4 - Apache NetBeans IDE 25')).toBe('Prog');
    expect(m('C:\\x\\Cursor.exe', 'app.ts - CodingPersonal - Cursor')).toBe('Development');
    // A plain Chrome window is nobody's: no workspace lists Chrome itself.
    expect(m('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Inbox - Gmail - Google Chrome')).toBeNull();
    expect(m('C:\\Windows\\explorer.exe', 'Downloads')).toBeNull();
    // An editor on some other project isn't Development's, which has a folder of its own.
    expect(m('C:\\x\\Cursor.exe', 'main.rs - other-thing - Cursor')).toBeNull();
    // Cursor on a loose file is.
    expect(m('C:\\x\\Cursor.exe', 'notes.md - Cursor')).toBe('Development');
  });

  it('settles a program two workspaces share by the title, then by the one opened last', () => {
    const a: Workspace = { ...newWorkspace({ name: 'Essays' }), lastOpenedAt: 5, resources: [newResource('app', { path: 'C:\\Office\\WINWORD.EXE' })] };
    const b: Workspace = { ...newWorkspace({ name: 'Lab' }), lastOpenedAt: 9, resources: [newResource('app', { path: 'C:\\Office\\WINWORD.EXE' })] };
    const both = new Map([a, b].map((ws) => [ws.id, programsOf(ws, new Map())]));
    const pick = (title: string) => matchWindow(detect('C:\\Office\\WINWORD.EXE', title), title, [a, b], both)?.name;
    expect(pick('Document1 - Word')).toBe('Lab');
    expect(pick('Essays draft - Word')).toBe('Essays');
  });

  it('calls app workspaces in use while their programs have a window open', () => {
    const win = (exe: string, title: string) => ({ exe, title, className: '' });
    const open = [win('C:\\x\\comet.exe', 'Omnivox - Comet'), win('C:\\x\\Cursor.exe', 'a.ts - CodingPersonal - Cursor')];
    expect([...workspacesInUse(open, list, programs)].sort()).toEqual([school.id, dev.id].sort());
  });

  it('credits time noticed before its programs were known to the workspace, from when it was made', () => {
    const made = { ...prog, createdAt: 1_000 };
    const progs = new Map([[made.id, programsOf(made, items)]]);
    const doc: TrailDoc = { ...emptyTrail(), spans: [
      { start: 500, end: 900, app: 'C:\\JetBrains\\bin\\idea64.exe', project: 'Lab4', ws: null, file: null, title: '' },
      { start: 2_000, end: 9_000, app: 'C:\\JetBrains\\bin\\idea64.exe', project: 'Lab4', ws: null, file: null, title: '' },
      { start: 9_000, end: 9_500, app: 'C:\\Windows\\explorer.exe', project: null, ws: null, file: null, title: '' },
    ] };
    const after = reattribute(doc, [made], progs);
    expect(after.spans.map((x) => x.ws)).toEqual([null, made.id, null]);
    expect(reattribute(after, [made], progs)).toBe(after);
  });
});

const s = (at: number, project: string | null, extra: Partial<Sample> = {}): Sample => ({ at, app: CODE, project, ws: null, file: null, title: '', ...extra });

function feed(samples: Sample[]): TrailDoc {
  return samples.reduce(addSample, emptyTrail());
}

describe('what Workspaces notices', () => {
  it('gives the time between samples to the window that was in front', () => {
    const doc = feed([s(0, 'island'), s(5000, 'island'), s(10000, 'school'), s(15000, 'school')]);
    expect(doc.spans.map((x) => [x.project, x.start, x.end])).toEqual([
      ['island', 0, 10000],
      ['school', 10000, 15000],
    ]);
  });

  it('ends a span at a long gap (away, asleep)', () => {
    const doc = feed([s(0, 'island'), s(5000, 'island'), s(5000 + GAP_MS + 1, 'island')]);
    expect(doc.spans.map((x) => [x.start, x.end])).toEqual([
      [0, 5000],
      [5000 + GAP_MS + 1, 5000 + GAP_MS + 1],
    ]);
  });

  it('adds up contexts, newest first, with files and apps', () => {
    const word = { ws: 'ws_school', app: 'C:\\W\\WINWORD.EXE' };
    const doc = feed([
      s(0, 'island', { file: 'a.ts' }),
      s(30_000, 'island', { file: 'b.ts' }),
      s(60_000, 'school', word),
      s(90_000, 'school', word),
      s(120_000, 'island', { file: 'a.ts' }),
      s(150_000, 'island', { file: 'a.ts' }),
    ]);
    const c = contexts(doc.spans);
    expect(c.map((x) => [x.key, x.ms])).toEqual([
      ['project:island', 90_000],
      ['ws:ws_school', 60_000],
    ]);
    expect(c[0].files).toEqual(['a.ts', 'b.ts']);
    expect(c[1].apps).toEqual(['C:\\W\\WINWORD.EXE']);
  });

  it('says where you have settled, after a while in one place', () => {
    const doc = feed([s(0, 'island'), s(5000, 'school'), s(10000, 'school'), s(15000, 'school'), s(30000, 'school')]);
    expect(settled(doc.spans, 30000, 20000)).toBe('project:school');
    expect(settled(doc.spans, 30000, 30000)).toBeNull();
    expect(settled(doc.spans, 30000 + GAP_MS + 1, 20000)).toBeNull();
  });

  it('forgets old spans and checks what it reads', () => {
    const day = 86_400_000;
    const doc = feed([s(0, 'old'), s(5000, 'old'), s(20 * day, 'new')]);
    expect(prune(doc, 20 * day, 14).spans.map((x) => x.project)).toEqual(['new']);
    const read = readTrail({ spans: [{ start: 5, end: 1 }, { start: 1, end: 2, app: 'x', project: 7 }, 'junk'], quiet: { a: 1, b: 'no' } });
    expect(read.spans).toEqual([{ start: 1, end: 2, app: 'x', project: null, ws: null, file: null, title: '' }]);
    expect(read.quiet).toEqual({ a: 1 });
  });

  it('says durations in words', () => {
    expect(duration(20_000)).toBe('under a minute');
    expect(duration(25 * 60_000)).toBe('25 min');
    expect(duration(80 * 60_000)).toBe('1 h 20 min');
    expect(duration(120 * 60_000)).toBe('2 h');
  });
});
