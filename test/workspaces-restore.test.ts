import { describe, expect, it } from 'vitest';
import type { LiveWindow, MonitorInfo, Tried, WinPlaced } from '../src/core/native';
import type { WorkspaceCheck } from '../src/workspaces/checks';
import { captureLayout, fit, matchWindows, planPlacement, targetFor } from '../src/workspaces/layout';
import { newResource, newWorkspace, type Resource, type Workspace } from '../src/workspaces/model';
import { jobSummary, outcomeOf, Restorer, runRecord, type Answer, type Job, type JobStep, type RestoreDeps } from '../src/workspaces/restore';

const mon = (id: string, x: number, width: number, height: number, extra: Partial<MonitorInfo> = {}): MonitorInfo => ({
  id,
  name: `Screen ${id}`,
  primary: x === 0,
  bounds: { x, y: 0, width, height },
  work: { x, y: 0, width, height: height - 48 },
  scale: 1,
  portrait: false,
  taskbar: 'bottom',
  ...extra,
});
const win = (hwnd: number, exe: string, title: string, rect = { x: 100, y: 100, width: 800, height: 600 }, extra: Partial<LiveWindow> = {}): LiveWindow => ({
  hwnd,
  pid: hwnd,
  exe,
  title,
  className: 'Chrome_WidgetWin_1',
  rect,
  state: 'normal',
  monitor: 'A',
  dpi: 96,
  ...extra,
});

const CODE = 'C:\\Programs\\VS Code\\Code.exe';
const SPOTIFY = 'C:\\Users\\m\\AppData\\Roaming\\Spotify\\Spotify.exe';

describe('window layouts', () => {
  const two = [mon('A', 0, 1920, 1080), mon('B', 1920, 2560, 1440)];

  it('saves where windows are, also as shares of their screen', () => {
    const code = newResource('app', { path: 'code' });
    const layout = captureLayout([win(1, CODE, 'app.ts - island - Visual Studio Code', { x: 1920, y: 0, width: 1280, height: 1392 }, { monitor: 'B' })], two, [code], 5);
    const [w] = layout.windows;
    expect(layout.savedAt).toBe(5);
    expect(layout.monitors.map((m) => m.id)).toEqual(['A', 'B']);
    expect(w).toMatchObject({ exe: CODE, monitor: 'B', resource: code.id, state: 'normal', enabled: true });
    expect(w.rel).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('finds each saved window again by program, then title', () => {
    const layout = captureLayout([win(1, CODE, 'a.ts - island - Visual Studio Code'), win(2, CODE, 'notes.md - school - Visual Studio Code'), win(3, SPOTIFY, 'Spotify')], two, []);
    const live = [win(10, CODE, 'b.ts - island - Visual Studio Code'), win(11, CODE, 'notes.md - school - Visual Studio Code'), win(12, 'C:\\x\\Other.exe', 'Spotify')];
    const m = matchWindows(layout.windows, live);
    expect(m.get(layout.windows[0].id)?.hwnd).toBe(10);
    expect(m.get(layout.windows[1].id)?.hwnd).toBe(11);
    expect(m.has(layout.windows[2].id)).toBe(false);
  });

  it('puts a window back exactly when its screen is unchanged', () => {
    const layout = captureLayout([win(1, CODE, 'x', { x: 2000, y: 40, width: 1000, height: 700 }, { monitor: 'B' })], two, []);
    expect(targetFor(layout.windows[0], layout.monitors, two)).toEqual({ rect: { x: 2000, y: 40, width: 1000, height: 700 }, monitor: 'B', note: null });
  });

  it('moves a window to the main screen, same share, when its screen is gone', () => {
    const layout = captureLayout([win(1, CODE, 'x', { x: 1920 + 1280, y: 0, width: 1280, height: 696 }, { monitor: 'B' })], two, []);
    const t = targetFor(layout.windows[0], layout.monitors, [two[0]])!;
    expect(t.monitor).toBe('A');
    expect(t.rect).toEqual({ x: 960, y: 0, width: 960, height: 516 });
    expect(t.note).toMatch(/Screen B isn't connected, so it went on the main screen/);
  });

  it('follows a screen that came back with a new id, or a new resolution', () => {
    const layout = captureLayout([win(1, CODE, 'x', { x: 1920, y: 0, width: 1280, height: 696 }, { monitor: 'B' })], two, []);
    const renamed = [two[0], { ...two[1], id: 'C' }];
    expect(targetFor(layout.windows[0], layout.monitors, renamed)).toMatchObject({ monitor: 'C', note: null, rect: { x: 1920, width: 1280 } });
    const smaller = [two[0], mon('B', 1920, 1920, 1080)];
    expect(targetFor(layout.windows[0], layout.monitors, smaller)).toMatchObject({ monitor: 'B', note: null, rect: { x: 1920, width: 960 } });
  });

  it('never leaves a window out of reach', () => {
    const work = { x: 0, y: 0, width: 1920, height: 1032 };
    expect(fit({ x: -7, y: 0, width: 974, height: 1039 }, work)).toEqual({ x: -7, y: 0, width: 974, height: 1039 });
    expect(fit({ x: 5000, y: -300, width: 3000, height: 2000 }, work)).toEqual({ x: -16, y: 0, width: 1952, height: 1048 });
    expect(fit({ x: 10, y: 10, width: 20, height: 20 }, work)).toEqual({ x: 10, y: 10, width: 160, height: 100 });
  });

  it('plans only switched-on windows and lists what is not open', () => {
    const layout = captureLayout([win(1, CODE, 'x'), win(2, SPOTIFY, 'Spotify'), win(3, 'C:\\a\\Off.exe', 'off')], two, []);
    layout.windows[2].enabled = false;
    const plan = planPlacement(layout, [win(9, CODE, 'y')], two);
    expect(plan.places.map((p) => p.hwnd)).toEqual([9]);
    expect(plan.missing.map((s) => s.exe)).toEqual([SPOTIFY]);
  });
});

// ------------------------------------------------------------------ restoring

interface Fake {
  deps: RestoreDeps;
  log: string[];
  answers: Answer[];
  live: LiveWindow[];
  placed: Array<{ hwnd: number }>;
  problems: Map<string, string>;
  running: Map<string, number>;
  failLaunch: Set<string>;
  clock: number;
}

function fake(): Fake {
  const f: Fake = { log: [], answers: [], live: [], placed: [], problems: new Map(), running: new Map(), failLaunch: new Set(), clock: 1000, deps: null as unknown as RestoreDeps };
  f.deps = {
    check: async (ws): Promise<WorkspaceCheck> => ({ items: new Map(ws.resources.map((r) => [r.id, { problem: f.problems.get(r.id) ?? null, found: null }])), cwd: null }),
    launch: async (r: Resource): Promise<Tried<{ pid: number | null; note: string | null }>> => {
      f.log.push(`launch ${r.id}`);
      return f.failLaunch.has(r.id) ? { ok: false, error: 'Windows refused to open it (access denied).' } : { ok: true, value: { pid: 1, note: null } };
    },
    openUrl: async (url) => (f.log.push(`url ${url}`), true),
    running: async (r) => (f.running.has(r.id) ? { pid: 5, hwnd: f.running.get(r.id)! } : null),
    focus: async (hwnd) => (f.log.push(`focus ${hwnd}`), true),
    windows: async () => ({ ok: true, value: f.live }),
    monitors: async () => [mon('A', 0, 1920, 1080)],
    place: async (places): Promise<Tried<WinPlaced[]>> => {
      f.placed.push(...places);
      return { ok: true, value: places.map((p) => ({ hwnd: p.hwnd, ok: true, why: null })) };
    },
    ask: async (_job: Job, step: JobStep) => {
      f.log.push(`ask ${step.id}`);
      return f.answers.shift() ?? 'yes';
    },
    sleep: async (ms) => {
      f.clock += ms;
      f.log.push(`wait ${ms}`);
    },
    now: () => f.clock,
    fileManager: 'Explorer',
  };
  return f;
}

function workspace(resources: Resource[], extra: Partial<Workspace> = {}): Workspace {
  return { ...newWorkspace({ name: 'Dev' }), resources, ...extra };
}

describe('restoring', () => {
  it('opens items in order, asks first where it should, waits where told', async () => {
    const f = fake();
    const app = newResource('app', { path: 'code', wait: 2 });
    const cmd = newResource('command', { command: 'npm run dev' });
    const site = newResource('url', { url: 'http://localhost:5173' });
    const off = newResource('file', { path: 'x', enabled: false });
    const jobs: string[] = [];
    const r = new Restorer(f.deps, (j) => jobs.push(j.state));
    const job = await r.run(workspace([app, cmd, off, site]));
    expect(f.log).toEqual([`launch ${app.id}`, 'wait 2000', `ask ${cmd.id}`, `launch ${cmd.id}`, 'url http://localhost:5173']);
    expect(job.steps.map((s) => [s.id, s.state])).toEqual([[app.id, 'done'], [cmd.id, 'done'], [site.id, 'done']]);
    expect(job.state).toBe('done');
    expect(jobSummary(job)).toBe('All 3 opened');
    expect(jobs.at(-1)).toBe('done');
    expect(job.steps[1].why).toBe('Running in Windows Terminal.');
  });

  it('says why something failed, skips what was skipped, and goes on', async () => {
    const f = fake();
    const missing = newResource('file', { path: 'D:\\gone.txt' });
    const refused = newResource('app', { path: 'admin.exe' });
    const skipped = newResource('command', { command: 'rm -rf build' });
    const fine = newResource('folder', { path: 'C:\\x' });
    f.problems.set(missing.id, 'Not found: D:\\gone.txt');
    f.failLaunch.add(refused.id);
    f.answers.push('skip');
    const job = await new Restorer(f.deps, () => {}).run(workspace([missing, refused, skipped, fine]));
    expect(job.steps.map((s) => s.state)).toEqual(['failed', 'failed', 'skipped', 'done']);
    expect(job.steps[0].why).toBe('Not found: D:\\gone.txt');
    expect(job.steps[1].why).toMatch(/access denied/);
    expect(job.steps[3].why).toBe('Opened in Explorer.');
    expect(f.log).not.toContain(`launch ${missing.id}`);
    expect(job.state).toBe('partial');
    expect(jobSummary(job)).toBe("1 of 4 opened; 2 didn't");
    const run = runRecord(job);
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'skipped', 'done']);
    expect(run.outcome).toBe('partial');
  });

  it('brings an app that is already running to the front instead of starting another', async () => {
    const f = fake();
    const app = newResource('app', { path: 'code' });
    f.running.set(app.id, 77);
    const job = await new Restorer(f.deps, () => {}).run(workspace([app]));
    expect(f.log).toEqual(['focus 77']);
    expect(job.steps[0].why).toBe('Already running: brought to the front.');
  });

  it('stops when asked to, and only one restore runs at a time', async () => {
    const f = fake();
    const a = newResource('command', { command: 'one' });
    const b = newResource('app', { path: 'two' });
    let release: (a: Answer) => void = () => {};
    f.deps.ask = () => new Promise<Answer>((res) => (release = res));
    const r = new Restorer(f.deps, () => {});
    const running = r.run(workspace([a, b]));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.busy).toBe(true);
    await expect(r.run(workspace([b]))).rejects.toThrow(/Already restoring/);
    r.cancel();
    const job = await running;
    expect(job.steps.map((s) => s.state)).toEqual(['cancelled', 'cancelled']);
    expect(job.state).toBe('cancelled');
    expect(f.log).toEqual([]);
    expect(release).toBeTypeOf('function');
  });

  it('puts windows back once the apps it started show them', async () => {
    const f = fake();
    const app = newResource('app', { path: 'code' });
    const layout = captureLayout([win(1, CODE, 'island - Visual Studio Code', { x: 0, y: 0, width: 960, height: 1032 }), win(2, SPOTIFY, 'Spotify')], [mon('A', 0, 1920, 1080)], [app]);
    let looks = 0;
    f.deps.windows = async () => {
      looks++;
      // Code's window shows on the third look; Spotify never opens.
      return { ok: true, value: looks >= 3 ? [win(50, CODE, 'island - Visual Studio Code')] : [] };
    };
    const job = await new Restorer(f.deps, () => {}).run(workspace([app], { layout }));
    const step = job.steps.find((s) => s.id === 'layout')!;
    expect(step.state).toBe('done');
    expect(step.why).toBe('Put 1 of 2 windows back. Not open: Spotify.');
    expect(f.placed).toEqual([{ hwnd: 50, rect: { x: 0, y: 0, width: 960, height: 1032 }, state: 'normal' }]);
    expect(job.state).toBe('done');
  });

  it('retries only what it is given', async () => {
    const f = fake();
    const a = newResource('app', { path: 'a' });
    const b = newResource('app', { path: 'b' });
    const job = await new Restorer(f.deps, () => {}).run(workspace([a, b]), [b.id]);
    expect(job.steps.map((s) => s.id)).toEqual([b.id]);
  });

  it('calls a run with nothing tried a failure, and one with a failure among successes partial', () => {
    const s = (state: JobStep['state']): JobStep => ({ id: state, label: '', kind: 'app', state, why: '', detail: '' });
    expect(outcomeOf([s('failed'), s('skipped')])).toBe('failed');
    expect(outcomeOf([s('failed'), s('done')])).toBe('partial');
    expect(outcomeOf([s('skipped')])).toBe('done');
  });
});
