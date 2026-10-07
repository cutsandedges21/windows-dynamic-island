// Which model answers (an Island model by name, Ollama, or the best one downloaded), and how
// the picker describes this PC and each model.

import { describe, expect, it } from 'vitest';
import type { Bundled, IslandModel, LocalStatus, ModelsReport } from '../src/core/bridge';
import { activeValue, chooseBackend, cleanName, memoryClass, modelView, NOT_DOWNLOADED, sizeText, specs, STILL_DOWNLOADING } from '../src/core/models';

const GiB = 2 ** 30;
const bundled = (over: Partial<Bundled> = {}): Bundled => ({ model: 'gpt-oss 20B', recommended: 'medium', installed: true, ready: [{ id: 'medium', name: 'gpt-oss 20B' }, { id: 'small', name: 'Qwen3 4B' }], download: 0, gpu: null, settingUp: false, ...over });
const status = (running: boolean, b: Bundled = bundled()): LocalStatus => ({ running, models: running ? [{ name: 'llama3.2:3b', size: 2e9, family: 'llama', params: '3B' }] : [], bundled: b });

describe('chooseBackend', () => {
  it('an Island model named in the options answers once it is downloaded, even with Ollama running', () => {
    expect(chooseBackend(status(true), 'island:small')).toEqual({ backend: 'island', model: 'small', label: 'Qwen3 4B' });
  });

  it('with nothing named, Ollama answers when it runs, else the recommended Island model', () => {
    expect(chooseBackend(status(true), '')).toMatchObject({ backend: 'ollama', model: 'llama3.2:3b' });
    expect(chooseBackend(status(false), '')).toEqual({ backend: 'island', model: 'medium', label: 'gpt-oss 20B' });
    expect(chooseBackend(status(false, bundled({ ready: [{ id: 'tiny', name: 'Qwen3 1.7B' }] })), '')).toMatchObject({ model: 'tiny' });
  });

  it('while the named model downloads, another one answers; with none, it says so', () => {
    const downloading = bundled({ ready: [{ id: 'small', name: 'Qwen3 4B' }], settingUp: true });
    expect(chooseBackend(status(false, downloading), 'island:medium')).toMatchObject({ model: 'small' });
    expect(chooseBackend(status(false, bundled({ ready: [], installed: false, settingUp: true })), 'island:medium')).toEqual({ error: STILL_DOWNLOADING });
    expect(chooseBackend(status(false, bundled({ ready: [], installed: false })), 'island:medium')).toEqual({ error: NOT_DOWNLOADED });
  });

  it('an Ollama name still means Ollama', () => {
    expect(chooseBackend(status(true), 'llama3.2:3b')).toMatchObject({ backend: 'ollama', model: 'llama3.2:3b' });
  });

  it('activeValue names what answers now, as an option value', () => {
    expect(activeValue(status(false), '')).toBe('island:medium');
    expect(activeValue(status(true), '')).toBe('llama3.2:3b');
    expect(activeValue(status(false, bundled({ ready: [], installed: false })), '')).toBe('');
    expect(activeValue(null, 'island:small')).toBe('');
  });
});

describe('wording', () => {
  it('memory sizes read like a shop label', () => {
    expect(memoryClass(31.7 * GiB)).toBe('32 GB');
    expect(memoryClass(15.7 * GiB)).toBe('16 GB');
    expect(memoryClass(12.11e9 / 0.4)).toBe('32 GB');
    expect(memoryClass(18.56e9 / 0.4)).toBe('48 GB');
    expect(memoryClass(1.107e9 / 0.4)).toBe('4 GB');
  });

  it('sizes and names', () => {
    expect(sizeText(12.11e9)).toBe('12.1 GB');
    expect(sizeText(33_400_000)).toBe('33 MB');
    expect(cleanName('12th Gen Intel(R) Core(TM) i7-12650H')).toBe('12th Gen Intel Core i7-12650H');
    expect(cleanName('Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz')).toBe('Intel Core i5-8250U');
  });
});

const model = (over: Partial<IslandModel>): IslandModel => ({ id: 'small', name: 'Qwen3 4B', about: '', size: 2.5e9, needs: 6.25e9, downloaded: false, partial: 0, fits: true, gpu: null, recommended: false, ...over });
const report = (over: Partial<ModelsReport> = {}): ModelsReport => ({
  machine: { cpu: '12th Gen Intel(R) Core(TM) i7-12650H', threads: 16, ram: 31.7 * GiB, gpus: [{ name: 'Intel(R) UHD Graphics', vram: 128 * 2 ** 20 }, { name: 'Microsoft Basic Display Adapter', vram: 0 }], diskFree: 600e9, disk: 'C:' },
  models: [],
  runtime: true,
  runtimeSize: 33_400_000,
  downloading: null,
  ...over,
});

describe('specs', () => {
  it('describes a PC with built-in graphics', () => {
    const s = specs(report().machine, [model({ id: 'medium', recommended: true })]);
    expect(s).toMatchObject({ cpu: 'Intel Core i7-12650H', threads: '16 threads', memory: '32 GB', graphics: 'Intel UHD Graphics (built in)', disk: '600 GB free on C:' });
    expect(s.note).toMatch(/processor/);
  });

  it('names a graphics card and says when models run on it', () => {
    const m = { ...report().machine, gpus: [{ name: 'NVIDIA GeForce RTX 4070', vram: 12 * GiB }] };
    expect(specs(m, [model({ recommended: true, gpu: 'NVIDIA GeForce RTX 4070' })])).toMatchObject({ graphics: 'NVIDIA GeForce RTX 4070 · 12 GB' });
    expect(specs(m, [model({ recommended: true, gpu: 'NVIDIA GeForce RTX 4070' })]).note).toMatch(/RTX 4070/);
    expect(specs(m, []).note).toMatch(/too little memory/);
  });
});

describe('modelView', () => {
  it('a model that is too big says what it needs', () => {
    const v = modelView(model({ fits: false, needs: 46.4e9 }), report(), null, false);
    expect(v).toMatchObject({ status: 'too-big', detail: 'Needs 48 GB of memory. This PC has 32 GB.' });
  });

  it('downloaded: in use or ready to use', () => {
    expect(modelView(model({ downloaded: true }), report(), null, true).status).toBe('in-use');
    expect(modelView(model({ downloaded: true }), report(), null, false)).toMatchObject({ status: 'ready', detail: '2.5 GB · runs on the processor' });
    expect(modelView(model({ downloaded: true }), report({ runtime: false }), null, false)).toMatchObject({ status: 'get', detail: '33 MB download · runs on the processor' });
  });

  it('shows the progress of its own download only', () => {
    const r = report({ downloading: 'small' });
    expect(modelView(model({}), r, { stage: 'model', model: 'small', done: 1.25e9, total: 2.5e9 }, false)).toMatchObject({ status: 'downloading', progress: 0.5, detail: '1.3 GB of 2.5 GB' });
    expect(modelView(model({}), r, null, false)).toMatchObject({ status: 'downloading', progress: null });
    expect(modelView(model({ id: 'tiny' }), r, { stage: 'model', model: 'small', done: 1, total: 2 }, false).status).toBe('get');
  });

  it('a stopped download can carry on; a full disk cannot take a model', () => {
    expect(modelView(model({ partial: 1e9 }), report(), null, false)).toMatchObject({ status: 'paused', detail: 'Paused at 1.0 GB of 2.5 GB' });
    const full = report({ machine: { ...report().machine, diskFree: 2e9 } });
    expect(modelView(model({}), full, null, false).status).toBe('no-room');
  });
});
