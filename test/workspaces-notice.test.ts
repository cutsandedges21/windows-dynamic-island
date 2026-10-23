import { describe, expect, it } from 'vitest';
import { detect, matchWorkspace, sameIds, workspacesInUse } from '../src/workspaces/notice/detect';
import { addSample, contexts, duration, emptyTrail, GAP_MS, prune, readTrail, settled, type Sample, type TrailDoc } from '../src/workspaces/notice/model';
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
