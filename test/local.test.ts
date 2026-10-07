// Local AI against a fake bridge: a question streams into the pill, Stop keeps what was
// written, a late answer to an old question is ignored, and the activity hides itself
// while no local model server is running.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bus: new Map<string, Set<(p: unknown) => void>>(), bridge: {} as Record<string, any>, native: {} as Record<string, any> }));

vi.mock('../src/core/native', () => ({
  native: h.native,
  on: async (event: string, cb: (p: unknown) => void) => {
    let set = h.bus.get(event);
    if (!set) h.bus.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
  emitLocal: () => {},
}));
vi.mock('../src/core/bridge', () => ({ bridge: h.bridge, inTauri: true }));

import type { ActivityContext, RenderEnv, SheetEnv } from '../src/core/activity';
import { clip } from '../src/core/format';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical, type Seg } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';
import { countdown, deviceFacts, LocalActivity, NO_SERVER, pickModel, visibleAnswer } from '../src/activities/local';

const T0 = Date.parse('2026-10-06T12:00:00Z');

const MODELS = [
  { name: 'llama3.1:8b', size: 4_920_753_328, family: 'llama', params: '8.0B' },
  { name: 'nomic-embed-text:latest', size: 274_302_450, family: 'nomic-bert', params: '137M' },
  { name: 'qwen3:1.7b', size: 1_359_000_000, family: 'qwen3', params: '1.7B' },
];

const GB = 2 ** 30;
const INFO = { computer: 'MOSS-PC', user: 'sport', os: 'Windows 11 Home 24H2 (build 26300.1)', cpu: '12th Gen Intel(R) Core(TM) i7-12650H', threads: 16, uptimeSecs: 5 * 3600 + 20 * 60, drives: [{ root: 'C:\\', free: 624 * GB, total: 953 * GB }] };
const SNAPSHOT = {
  info: INFO,
  power: { hasBattery: true, percent: 82, ac: true, charging: true, saver: false, secondsLeft: null },
  sys: { cpu: 23, memUsed: 14 * GB, memTotal: 32 * GB, gpu: 12, top: { name: 'chrome.exe', cpu: 9 } },
  net: { rxBps: 150_000, txBps: 12_000, connected: true, internet: true, name: 'HomeWifi', wifi: true, vpn: false },
  audio: { volume: 0.45, muted: false, device: 'Speakers', deviceId: 'x', micMuted: false, micDevice: 'Microphone' },
  media: { available: true, app: 'Spotify', appId: 'spotify', title: 'Song', artist: 'Artist', album: '', status: 'playing' as const, position: null, duration: null, updatedAt: 0, canPlay: true, canPause: true, canNext: true, canPrev: true },
  agenda: { ok: true, reason: null, calendars: ['Work'], events: [{ id: '1', title: 'Team sync', location: '', start: T0 + 3 * 3600_000, end: T0 + 4 * 3600_000, allDay: false, link: '', calendar: 'Work' }] },
  dnd: false,
  window: 'local.ts - Visual Studio Code',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let reply = deferred<{ ok: boolean; text?: string; error?: string; cancelled: boolean }>();

const NOT_SET_UP = { model: 'Qwen3 4B', recommended: 'small', installed: false, ready: [] as Array<{ id: string; name: string }>, download: 2_533_400_000, gpu: null, settingUp: false };
const SET_UP = { ...NOT_SET_UP, installed: true, ready: [{ id: 'small', name: 'Qwen3 4B' }], download: 0 };
let bundled: Record<string, unknown> = NOT_SET_UP;

function resetBridge(running = true, island: Record<string, unknown> = NOT_SET_UP) {
  bundled = island;
  for (const k of Object.keys(h.bridge)) delete h.bridge[k];
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.bus.clear();
  reply = deferred();
  Object.assign(h.bridge, {
    localStatus: vi.fn(async () => ({ running, models: running ? MODELS : [], bundled })),
    localSetup: vi.fn(async () => ({ ok: true })),
    localRemove: vi.fn(async () => ({ ok: true })),
    localAsk: vi.fn(() => reply.promise),
    localCancel: vi.fn(async () => {}),
    localDeviceInfo: vi.fn(async () => SNAPSHOT.info),
    localWarm: vi.fn(async () => true),
  });
  Object.assign(h.native, {
    clipboardSetText: vi.fn(async () => true),
    powerState: vi.fn(async () => SNAPSHOT.power),
    sysSample: vi.fn(async () => SNAPSHOT.sys),
    netSample: vi.fn(async () => SNAPSHOT.net),
    audioState: vi.fn(async () => SNAPSHOT.audio),
    mediaState: vi.fn(async () => SNAPSHOT.media),
    agendaRead: vi.fn(async () => SNAPSHOT.agenda),
    dndGet: vi.fn(async () => SNAPSHOT.dnd),
    foreground: vi.fn(async () => 42),
    winEnum: vi.fn(async () => [{ hwnd: 7, pid: 1, title: 'Other' }, { hwnd: 42, pid: 2, title: SNAPSHOT.window }]),
  });
}

const emit = (event: string, payload: unknown) => {
  for (const cb of [...(h.bus.get(event) ?? [])]) cb(payload);
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function boot(options: Record<string, unknown> = {}) {
  const act = new LocalActivity();
  const settings = defaultSettings();
  const calls = { surface: [] as Array<{ key?: string }>, close: 0 };
  const ctx: ActivityContext = {
    id: 'local',
    config: () => settings.activities.config.local,
    options: () => options as never,
    settings: () => settings,
    update: () => {},
    surface: (o) => void calls.surface.push(o ?? {}),
    alert: () => {},
    open: () => {},
    close: () => void calls.close++,
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: () => {},
  };
  await act.start(ctx);
  await tick(0);
  return { act, calls };
}

const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });
const sheetEnv: SheetEnv = { reason: 'urgent', now: T0, width: 360, vertical: false, interactive: true, surfaced: null };

const texts = (segs: Seg[]) => segs.flatMap((s) => (s.t === 'text' ? [s.text] : []));
const sheetText = (act: LocalActivity) => act.sheet(sheetEnv)?.blocks.flatMap((b) => (b.t === 'text' ? [b.text] : [])) ?? [];
const askCall = (n = 0) => h.bridge.localAsk.mock.calls[n] as [number, string, Array<{ role: string; content: string }>];

/** Opens the input and sends a question. `sent` settles once the activity has the reply (wrapped, so awaiting ask() does not wait for it). */
async function ask(act: LocalActivity, text = 'Capital of Canada?') {
  await act.action('ask', undefined);
  const sent = act.action('send', text);
  await tick(0);
  return { sent };
}

/** Every level and orientation renders valid, fittable, icon-only-when-vertical segments. */
function smoke(act: LocalActivity, label: string): void {
  for (const level of ['compact', 'expanded', 'maximum'] as const) {
    for (const vertical of [false, true]) {
      const at = `${label} ${level}${vertical ? ' vertical' : ''}`;
      const segs = act.render(env(level, { vertical }));
      const keys = segs.map((s) => s.key);
      expect(new Set(keys).size, `${at}: unique keys ${keys}`).toBe(keys.length);
      for (const s of segs) {
        if (s.t === 'icon' && s.icon) expect(hasIcon(s.icon), `${at}: icon ${s.icon}`).toBe(true);
        if (s.t === 'button') {
          expect(hasIcon(s.icon!), `${at}: button icon ${s.icon}`).toBe(true);
          if (vertical) expect(s.label, `${at}: vertical button ${s.key} is icon-only`).toBeUndefined();
        }
      }
      if (vertical) fitVertical(segs, 200, 40);
      else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetBridge();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pickModel', () => {
  it('with no model named, picks the smallest chat model and skips embedding models', () => {
    expect(pickModel(MODELS, '')).toEqual({ model: 'qwen3:1.7b' });
    expect(pickModel(MODELS, undefined)).toEqual({ model: 'qwen3:1.7b' });
  });

  it('uses a named model when it is installed, with or without its tag', () => {
    expect(pickModel(MODELS, ' llama3.1:8b ')).toEqual({ model: 'llama3.1:8b' });
    expect(pickModel([{ name: 'mistral:latest', size: 1, family: 'llama', params: '7B' }], 'mistral')).toEqual({ model: 'mistral:latest' });
  });

  it('says how to get a named model that is not installed', () => {
    const pick = pickModel(MODELS, 'gemma3:4b');
    expect('error' in pick && pick.error).toContain('ollama pull gemma3:4b');
  });

  it('says how to get a chat model when there are none', () => {
    const pick = pickModel([MODELS[1]], '');
    expect('error' in pick && pick.error).toContain('ollama pull');
  });
});

describe('visibleAnswer', () => {
  it('drops a finished thinking block', () => {
    expect(visibleAnswer('<think>The user wants a capital.</think>\n\nOttawa.')).toBe('Ottawa.');
  });

  it('hides thinking that is still being written', () => {
    expect(visibleAnswer('<think>The user wants')).toBe('');
  });

  it('flattens markdown', () => {
    expect(visibleAnswer('**Ottawa** is the capital.')).toBe('Ottawa is the capital.');
  });
});

describe('countdown', () => {
  it('counts the estimate down and fills the bar', () => {
    expect(countdown(0, 8000)).toEqual({ value: 0, text: '~8 s' });
    expect(countdown(3000, 8000)).toEqual({ value: 0.375, text: '~5 s' });
  });

  it('says it is almost done once the estimate has run out, rather than a wrong number', () => {
    expect(countdown(7800, 8000)).toEqual({ value: null, text: 'Almost done…' });
    expect(countdown(20_000, 8000)).toEqual({ value: null, text: 'Almost done…' });
  });
});

describe('deviceFacts', () => {
  it('lists what it knows about the PC, one fact per line', () => {
    const facts = deviceFacts(SNAPSHOT, new Date(T0));
    expect(facts).toMatch(/Time: Tuesday, October 6, 2026/);
    for (const fact of ['MOSS-PC', 'Windows 11 Home 24H2', 'i7-12650H', 'Battery: 82%, charging', 'C: 624 GB free of 953 GB', 'HomeWifi', 'Volume: 45%', '"Song" by Artist (Spotify)', 'Team sync', 'local.ts - Visual Studio Code', 'up 5 h 20 min']) {
      expect(facts, fact).toContain(fact);
    }
  });

  it('leaves out what it could not read, but always knows the time', () => {
    const facts = deviceFacts({}, new Date(T0));
    expect(facts).toMatch(/Time: /);
    expect(facts).not.toMatch(/Battery|Volume|Playing/);
  });
});

describe('LocalActivity', () => {
  it('shows a bar and the seconds left while it waits for the answer', async () => {
    const { act } = await boot();
    await ask(act);
    await tick(3000);
    const pill = act.render(env('expanded'));
    expect(pill.find((s) => s.t === 'progress')).toMatchObject({ value: 0.375 });
    expect(texts(pill)).toContain('~5 s');
  });

  it('learns how long answers take on this PC', async () => {
    const { act } = await boot();
    const { sent } = await ask(act);
    await tick(4000);
    reply.resolve({ ok: true, text: 'Ottawa.', cancelled: false });
    await sent;
    reply = deferred();
    h.bridge.localAsk.mockImplementation(() => reply.promise);
    void act.action('send', 'And Quebec?');
    await tick(0);
    // 8 s to start with, then 70% of that and 30% of the 4 s it took: 6.8 s.
    expect(texts(act.render(env('expanded')))).toContain('~7 s');
  });

  it('the card shows the time running down too', async () => {
    const { act } = await boot();
    await ask(act);
    emit('local-delta', { id: askCall()[0], text: 'Otta' });
    expect(act.sheet(sheetEnv)?.blocks.some((b) => b.t === 'countdown')).toBe(true);
  });

  it('uses Ollama when it runs', async () => {
    const { act } = await boot();
    await ask(act);
    expect(askCall()[4]).toBe('ollama');
  });

  it("without Ollama, offers to set up Island's own model with its download size", async () => {
    resetBridge(false);
    const { act } = await boot();
    const tile = act.tile(sheetEnv);
    expect(JSON.stringify(tile)).toContain('"action":"setup"');
    expect(JSON.stringify(tile)).toContain('2.5 GB');
  });

  it("setup shows its progress, then answers with Island's own model", async () => {
    resetBridge(false);
    const { act, calls } = await boot();
    await act.action('setup', undefined);
    expect(h.bridge.localSetup).toHaveBeenCalledWith();
    emit('local-setup', { stage: 'model', model: 'small', done: 1_266_700_000, total: 2_533_400_000 });
    const pill = act.render(env('expanded'));
    expect(pill.some((s) => s.t === 'progress' && Math.abs((s.value ?? 0) - 0.5) < 0.01)).toBe(true);
    expect(texts(pill).join(' ')).toContain('50%');

    bundled = SET_UP;
    emit('local-setup-end', { model: 'small', ok: true, error: null, cancelled: false });
    await tick(0);
    expect(calls.surface.at(-1)?.key).toMatch(/^local-ready/);
    expect(act.home().length).toBe(1);
    await ask(act);
    expect(askCall()[4]).toBe('island');
    expect(askCall()[1]).toBe('small');
  });

  it('a setup that cannot start says why', async () => {
    resetBridge(false);
    h.bridge.localSetup.mockImplementation(async () => ({ ok: false, error: 'Not enough free space: Qwen3 4B needs 3.0 GB, the disk has 1.2 GB free.' }));
    const { act } = await boot();
    await act.action('setup', undefined);
    expect(act.status().summary).toContain('Not enough free space');
  });

  it('a download that fails part-way says why', async () => {
    resetBridge(false);
    const { act } = await boot();
    await act.action('setup', undefined);
    emit('local-setup-end', { model: 'small', ok: false, error: 'The download stopped. Next time it carries on where it left off.', cancelled: false });
    await tick(0);
    expect(act.status().summary).toContain('The download stopped');
  });

  it('follows a download started in the Activities window, and leaves its errors there', async () => {
    resetBridge(false);
    const { act, calls } = await boot();
    emit('local-setup', { stage: 'model', model: 'tiny', done: 1, total: 4 });
    expect(act.status().summary).toBe('Setting up Local AI · 25%');
    emit('local-setup-end', { model: 'tiny', ok: false, error: 'The disk is full.', cancelled: false });
    await tick(0);
    expect(act.status().active).toBe(false);
    expect(calls.surface.filter((s) => /local-(error|ready)/.test(s.key ?? ''))).toHaveLength(0);
  });

  it('an Island model picked in Activities answers, even while Ollama runs', async () => {
    resetBridge(true, SET_UP);
    const { act } = await boot({ model: 'island:small' });
    await ask(act);
    expect(askCall()[4]).toBe('island');
    expect(askCall()[1]).toBe('small');
  });

  it('a PC too small for any model hides Local AI', async () => {
    resetBridge(false, { model: null, recommended: null, installed: false, ready: [], download: 0, gpu: null, settingUp: false });
    const { act } = await boot();
    expect(act.tile(sheetEnv)).toBeNull();
  });

  it('opening the input loads the model, once a minute at most', async () => {
    const { act } = await boot();
    await act.action('ask', undefined);
    await tick(0);
    expect(h.bridge.localWarm).toHaveBeenCalledWith('qwen3:1.7b', 'ollama');
    await act.action('cancel', undefined);
    await act.action('ask', undefined);
    await tick(0);
    expect(h.bridge.localWarm).toHaveBeenCalledTimes(1);
    await act.action('cancel', undefined);
    await tick(61_000);
    await act.action('ask', undefined);
    await tick(0);
    expect(h.bridge.localWarm).toHaveBeenCalledTimes(2);
  });

  it('does not try to load a model while no server runs', async () => {
    resetBridge(false);
    const { act } = await boot();
    await act.action('ask', undefined);
    await tick(0);
    expect(h.bridge.localWarm).not.toHaveBeenCalled();
  });

  it('sends what it knows about the PC with every question', async () => {
    const { act } = await boot();
    await ask(act, 'What time is it?');
    const context = h.bridge.localAsk.mock.calls[0][3] as string;
    expect(context).toContain('Battery: 82%');
    expect(context).toMatch(/Time: Tuesday/);
  });

  it('streams an answer into the pill and keeps the chat for a follow-up', async () => {
    const { act, calls } = await boot();
    const { sent } = await ask(act);
    expect(texts(act.render(env('expanded')))).toContain('Thinking…');
    expect(act.status().beam?.tone).toBe('violet');
    const [id, model, messages] = askCall();
    expect(model).toBe('qwen3:1.7b');
    expect(messages).toEqual([{ role: 'user', content: 'Capital of Canada?' }]);

    emit('local-delta', { id, text: 'Otta' });
    emit('local-delta', { id: id + 1, text: 'someone else' });
    expect(act.chip()?.label).toBe('Writing…');
    // The words go on the card, never in the pill.
    expect(texts(act.render(env('maximum')))).not.toContain('Otta');
    expect(texts(act.render(env('maximum')))[0]).toBe('Writing…');
    expect(sheetText(act)).toEqual(['Otta']);

    reply.resolve({ ok: true, text: 'Ottawa.', cancelled: false });
    await sent;
    expect(act.status().summary).toBe('Ottawa.');
    expect(calls.surface.at(-1)?.key).toMatch(/^local-answer-/);
    expect(texts(act.render(env('maximum')))).toEqual(['Answered']);
    expect(sheetText(act)).toEqual(['Ottawa.']);

    reply = deferred();
    h.bridge.localAsk.mockImplementation(() => reply.promise);
    void act.action('send', 'And Quebec?');
    await tick(0);
    expect(askCall(1)[2].map((t) => t.content)).toEqual(['Capital of Canada?', 'Ottawa.', 'And Quebec?']);
  });

  it('Stop keeps what was written so far', async () => {
    const { act } = await boot();
    const { sent } = await ask(act);
    const [id] = askCall();
    emit('local-delta', { id, text: 'Ottawa is' });
    await act.action('stop', undefined);
    expect(h.bridge.localCancel).toHaveBeenCalledWith(id);
    expect(act.status().summary).toBe('Ottawa is');
    reply.resolve({ ok: false, cancelled: true });
    await sent;
    expect(act.status().summary).toBe('Ottawa is');
    expect(sheetText(act)).toEqual(['Ottawa is']);
  });

  it('Stop before any words ends the moment and forgets the question', async () => {
    const { act, calls } = await boot();
    const { sent } = await ask(act);
    await act.action('stop', undefined);
    expect(h.bridge.localCancel).toHaveBeenCalledWith(askCall()[0]);
    expect(act.status().active).toBe(false);
    expect(calls.close).toBe(1);
    reply.resolve({ ok: true, text: 'too late', cancelled: false });
    await sent;
    expect(act.status().active).toBe(false);

    reply = deferred();
    h.bridge.localAsk.mockImplementation(() => reply.promise);
    void ask(act, 'Hi');
    await tick(0);
    expect(askCall(1)[2]).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('a new chat stops the old answer and ignores it when it arrives', async () => {
    const { act } = await boot();
    const { sent } = await ask(act);
    await act.action('new', undefined);
    expect(h.bridge.localCancel).toHaveBeenCalledWith(askCall()[0]);
    reply.resolve({ ok: true, text: 'Ottawa.', cancelled: false });
    await sent;
    expect(act.status().summary).not.toBe('Ottawa.');
    expect(act.sheet(sheetEnv)).toBeNull();
  });

  it('stopping the activity stops the model', async () => {
    const { act } = await boot();
    await ask(act);
    act.stop();
    expect(h.bridge.localCancel).toHaveBeenCalledWith(askCall()[0]);
  });

  it('shows the reason for a failed answer, and Retry asks again', async () => {
    const { act } = await boot();
    const { sent } = await ask(act);
    reply.resolve({ ok: false, error: 'qwen3:1.7b is not installed. Run: ollama pull qwen3:1.7b', cancelled: false });
    await sent;
    expect(act.status().summary).toContain('not installed');
    reply = deferred();
    h.bridge.localAsk.mockImplementation(() => reply.promise);
    void act.action('retry', undefined);
    await tick(0);
    expect(askCall(1)[2]).toEqual([{ role: 'user', content: 'Capital of Canada?' }]);
  });

  it('hides while no server runs, says why if asked, and shows up once one starts', async () => {
    resetBridge(false, { model: null, installed: false, download: 0, gpu: null, settingUp: false });
    const { act } = await boot();
    expect(act.home()).toEqual([]);
    expect(act.tile(sheetEnv)).toBeNull();
    const { sent } = await ask(act);
    await sent;
    expect(h.bridge.localAsk).not.toHaveBeenCalled();
    expect(act.status().summary).toBe(clip(NO_SERVER, 60));
    await act.action('cancel', undefined);

    h.bridge.localStatus.mockImplementation(async () => ({ running: true, models: MODELS }));
    await tick(30_000);
    expect(act.home().length).toBe(1);
    expect(act.tile(sheetEnv)).not.toBeNull();
  });

  it('renders every phase', async () => {
    const { act } = await boot();
    smoke(act, 'idle');
    await act.action('ask', undefined);
    smoke(act, 'compose');
    const sent = act.action('send', 'Capital of Canada?');
    await tick(0);
    smoke(act, 'thinking');
    emit('local-delta', { id: askCall()[0], text: 'Ottawa is the capital of Canada, on the Ottawa River in Ontario.' });
    smoke(act, 'streaming');
    reply.resolve({ ok: true, text: 'Ottawa.', cancelled: false });
    await sent;
    smoke(act, 'answer');
    await act.action('new', undefined);
    reply = deferred();
    h.bridge.localAsk.mockImplementation(() => reply.promise);
    const failed = act.action('send', 'Again?');
    await tick(0);
    reply.resolve({ ok: false, error: 'Lost the connection to the model.', cancelled: false });
    await failed;
    smoke(act, 'error');
  });
});
