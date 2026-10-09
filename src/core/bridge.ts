// Typed wrappers for the commands behind secrets, integration polls, Ask Claude and Local AI
// (src-tauri/src/secrets.rs, integrations.rs, chat.rs, local.rs). native.ts keeps its own call()
// private, so these invoke directly. Outside Tauri (npm run dev in a browser) they
// resolve to quiet stand-ins: secrets live in memory for the life of the page, polls
// say nothing is connected, and an ask answers with a note, so the Activities page and
// the pill can still be built and screenshotted.

import { invoke } from '@tauri-apps/api/core';
import { emitLocal } from './native';
import { thisComputer } from './platform';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** A secret was stored or removed, or why it was not. The value itself never comes back. */
export type SecretResult = { ok: true } | { ok: false; error: string };

/** A poll that got nothing. `code` is no-key, config, auth, limit, http, network (or demo outside Tauri). */
export interface PollFailure {
  ok: false;
  code: string;
  error: string;
  /** Seconds the service asked us to wait, when it said. */
  retryAfter?: number | null;
}

/** One snapshot of one service: `ok: true` plus that service's own fields. */
export type PollReply = ({ ok: true } & Record<string, unknown>) | PollFailure;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AskBackend = 'claude-code' | 'api';

export interface AskReply {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface AskBackends {
  claudeCode: boolean;
  api: boolean;
}

/** A model the local server has (src-tauri/src/local.rs). */
export interface LocalModel {
  name: string;
  /** Bytes on disk. */
  size: number;
  family: string;
  /** Parameter count as the server labels it ("1.7B"). */
  params: string;
}

/** Island's own runtime (src-tauri/src/llama.rs), for PCs without Ollama. */
export interface Bundled {
  /** The model recommended for this PC ("gpt-oss 20B"), or null when it has too little memory. */
  model: string | null;
  /** Its id ("medium"). */
  recommended: string | null;
  /** Island can answer: the runtime and a model this PC can run are downloaded. */
  installed: boolean;
  /** The downloaded models this PC can run, best first. */
  ready: Array<{ id: string; name: string }>;
  /** Bytes still to download for the recommended model. */
  download: number;
  gpu: string | null;
  settingUp: boolean;
}

export interface LocalStatus {
  /** Ollama answered. */
  running: boolean;
  models: LocalModel[];
  bundled: Bundled;
}

/** Who answers: Ollama, or Island's own runtime. */
export type LocalBackend = 'ollama' | 'island';

/** A download's progress, sent as the 'local-setup' event to every window. */
export interface SetupProgress {
  stage: 'runtime' | 'model';
  /** The model being set up ("small"). */
  model: string;
  done: number;
  total: number;
}

/** How a download ended, sent as 'local-setup-end'. */
export interface SetupEnd {
  model: string;
  ok: boolean;
  error: string | null;
  cancelled: boolean;
}

/** One model Island can download, as this PC sees it (src-tauri/src/llama.rs TIERS). */
export interface IslandModel {
  id: string;
  name: string;
  about: string;
  /** Download size in bytes, about what it takes in memory. */
  size: number;
  /** The memory a PC needs to run it on its processor. */
  needs: number;
  downloaded: boolean;
  /** Bytes an unfinished download already has. */
  partial: number;
  /** This PC can run it. */
  fits: boolean;
  /** The graphics card it runs on; null: the processor. */
  gpu: string | null;
  recommended: boolean;
}

/** What this PC has. */
export interface Machine {
  cpu: string;
  threads: number;
  /** Bytes of RAM. */
  ram: number;
  gpus: Array<{ name: string; vram: number }>;
  /** Free bytes on the disk the models go to, and its name ("C:"). */
  diskFree: number;
  disk: string;
}

/** The model picker's view: this PC, every model, and what is downloading. */
export interface ModelsReport {
  machine: Machine;
  models: IslandModel[];
  /** llama-server is downloaded. */
  runtime: boolean;
  /** What the runtime adds to the first download. */
  runtimeSize: number;
  downloading: string | null;
}

const NO_BUNDLE: Bundled = { model: null, recommended: null, installed: false, ready: [], download: 0, gpu: null, settingUp: false };

export interface LocalReply {
  ok: boolean;
  text?: string;
  error?: string;
  /** Stopped with localCancel: not an error. */
  cancelled: boolean;
}

/** What Rust reads about the PC for Local AI (local_device_info). */
export interface DeviceInfo {
  computer: string;
  user: string;
  /** "Windows 11 Home 24H2 (build 26300.1234)" */
  os: string;
  cpu: string;
  threads: number;
  uptimeSecs: number;
  /** Local disks only, sizes in bytes. */
  drives: Array<{ root: string; free: number; total: number }>;
}

/** The answer so far, sent as the 'local-delta' event while the model writes it. */
export interface LocalDelta {
  id: number;
  text: string;
}

const demoSecrets = new Set<string>();
const demoStopped = new Set<number>();
const DEMO_ANSWER = 'Demo answer, written word by word. No local model runs in the browser preview.';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GB = 1e9;
/** The browser preview's PC: 32 GB and built-in graphics, like the one Island was built on. */
const demoModels: ModelsReport = {
  machine: { cpu: '12th Gen Intel(R) Core(TM) i7-12650H', threads: 16, ram: 34e9, gpus: [{ name: 'Intel(R) UHD Graphics', vram: 128 * 2 ** 20 }], diskFree: 600 * GB, disk: 'C:' },
  models: [
    { id: 'large', name: 'Qwen3 30B', about: 'The best answers. Slow to load the first time.', size: 18.56 * GB, needs: 46.4 * GB, downloaded: false, partial: 0, fits: false, gpu: null, recommended: false },
    { id: 'medium', name: 'gpt-oss 20B', about: 'Smart. Thinks for a moment before it answers.', size: 12.11 * GB, needs: 30.28 * GB, downloaded: false, partial: 0, fits: true, gpu: null, recommended: true },
    { id: 'small', name: 'Qwen3 4B', about: 'Quick, good everyday answers.', size: 2.5 * GB, needs: 6.25 * GB, downloaded: true, partial: 0, fits: true, gpu: null, recommended: false },
    { id: 'tiny', name: 'Qwen3 1.7B', about: 'The fastest and lightest. Fine for short, simple questions.', size: 1.11 * GB, needs: 2.77 * GB, downloaded: false, partial: 0, fits: true, gpu: null, recommended: false },
  ],
  runtime: true,
  runtimeSize: 33_400_000,
  downloading: null,
};
/** Bumped to stop the demo download under way. */
let demoRun = 0;

function demoBundled(): Bundled {
  const ready = demoModels.models.filter((m) => m.downloaded && m.fits).map((m) => ({ id: m.id, name: m.name }));
  const best = demoModels.models.find((m) => m.recommended)!;
  return { model: best.name, recommended: best.id, installed: ready.length > 0, ready, download: best.downloaded ? 0 : best.size, gpu: null, settingUp: demoModels.downloading != null };
}

/** A pretend download, so the welcome flow and the model list can be tried in a browser. */
function demoSetup(id: string): SecretResult {
  const m = demoModels.models.find((x) => x.id === (id || demoBundled().recommended));
  if (!m?.fits) return { ok: false, error: `This model is too big for ${thisComputer()}.` };
  if (demoModels.downloading === m.id) return { ok: true };
  const run = ++demoRun;
  demoModels.downloading = m.id;
  void (async () => {
    for (let done = m.partial; done < m.size; done = Math.min(m.size, done + m.size / 14)) {
      await sleep(260);
      if (run !== demoRun) {
        m.partial = done;
        if (demoModels.downloading === m.id) demoModels.downloading = null;
        emitLocal<SetupEnd>('local-setup-end', { model: m.id, ok: false, error: null, cancelled: true });
        return;
      }
      emitLocal<SetupProgress>('local-setup', { stage: 'model', model: m.id, done, total: m.size });
    }
    Object.assign(m, { downloaded: true, partial: 0 });
    demoModels.downloading = null;
    emitLocal<SetupEnd>('local-setup-end', { model: m.id, ok: true, error: null, cancelled: false });
  })();
  return { ok: true };
}

/** What an invoke rejection says, as one short line. */
function reason(err: unknown): string {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  return text.trim().slice(0, 200) || 'Something went wrong';
}

export const bridge = {
  inTauri,

  secretHas: async (name: string): Promise<boolean> => {
    if (!inTauri) return demoSecrets.has(name);
    try {
      return await invoke<boolean>('secret_has', { name });
    } catch {
      return false;
    }
  },

  secretSet: async (name: string, value: string): Promise<SecretResult> => {
    if (!inTauri) {
      demoSecrets.add(name);
      return { ok: true };
    }
    try {
      await invoke('secret_set', { name, value });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  },

  secretDelete: async (name: string): Promise<SecretResult> => {
    if (!inTauri) {
      demoSecrets.delete(name);
      return { ok: true };
    }
    try {
      await invoke('secret_delete', { name });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  },

  /** One snapshot of a service. `options` carries that activity's non-secret settings. */
  integrationPoll: async (id: string, options: Record<string, unknown>): Promise<PollReply> => {
    if (!inTauri) return { ok: false, code: 'demo', error: 'Nothing is connected in the browser preview' };
    try {
      return await invoke<PollReply>('integration_poll', { id, options });
    } catch (err) {
      return { ok: false, code: 'http', error: reason(err) };
    }
  },

  askClaude: async (backend: AskBackend, messages: ChatTurn[]): Promise<AskReply> => {
    if (!inTauri) {
      await sleep(700);
      return { ok: true, text: 'Demo answer. Claude is not connected in the browser preview.' };
    }
    try {
      return await invoke<AskReply>('ask_claude', { backend, messages });
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  },

  askBackends: async (): Promise<AskBackends> => {
    if (!inTauri) return { claudeCode: true, api: false };
    try {
      return await invoke<AskBackends>('ask_backends');
    } catch {
      return { claudeCode: false, api: false };
    }
  },

  localStatus: async (): Promise<LocalStatus> => {
    if (!inTauri) return { running: true, models: [{ name: 'demo:1b', size: 1e9, family: 'demo', params: '1B' }], bundled: demoBundled() };
    try {
      return await invoke<LocalStatus>('local_status');
    } catch {
      return { running: false, models: [], bundled: NO_BUNDLE };
    }
  },

  /** Loads the model so the question being typed does not wait for it. */
  localWarm: async (model: string, backend: LocalBackend = 'ollama'): Promise<boolean> => {
    if (!inTauri) return true;
    try {
      return await invoke<boolean>('local_warm', { model, backend });
    } catch {
      return false;
    }
  },

  localDeviceInfo: async (): Promise<DeviceInfo | null> => {
    if (!inTauri) return null;
    try {
      return await invoke<DeviceInfo>('local_device_info');
    } catch {
      return null;
    }
  },

  /**
   * Resolves with the whole answer; meanwhile 'local-delta' events carry the answer so far.
   * `context` (what Island sees on the PC) goes into the model's system prompt.
   */
  localAsk: async (id: number, model: string, messages: ChatTurn[], context = '', backend: LocalBackend = 'ollama'): Promise<LocalReply> => {
    if (!inTauri) {
      let text = '';
      for (const word of DEMO_ANSWER.split(' ')) {
        await sleep(90);
        if (demoStopped.has(id)) return { ok: false, cancelled: true };
        text = text ? `${text} ${word}` : word;
        emitLocal<LocalDelta>('local-delta', { id, text });
      }
      return { ok: true, text, cancelled: false };
    }
    try {
      return await invoke<LocalReply>('local_ask', { id, model, messages, context, backend });
    } catch (err) {
      return { ok: false, error: reason(err), cancelled: false };
    }
  },

  /** This PC and every model Island can download, for the model picker. */
  localModels: async (): Promise<ModelsReport | null> => {
    if (!inTauri) return structuredClone(demoModels);
    try {
      return await invoke<ModelsReport>('local_models');
    } catch {
      return null;
    }
  },

  /**
   * Starts downloading Island's runtime and the model `model` (empty: the one recommended for
   * this PC). Resolves once it has begun, or with why it could not; 'local-setup' events then
   * carry the progress and one 'local-setup-end' says how it ended, in every window.
   */
  localSetup: async (model = ''): Promise<SecretResult> => {
    if (!inTauri) return demoSetup(model);
    try {
      await invoke('local_setup', { model: model || null });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  },

  /** Stops the download under way; the next try carries on from where it stopped. */
  localSetupCancel: async (): Promise<void> => {
    if (!inTauri) {
      demoRun++;
      return;
    }
    try {
      await invoke('local_setup_cancel');
    } catch {
      /* nothing downloading */
    }
  },

  /** Deletes one of Island's own models, or with no id the runtime and every model. */
  localRemove: async (model = ''): Promise<SecretResult> => {
    if (!inTauri) {
      for (const m of demoModels.models) if (!model || m.id === model) Object.assign(m, { downloaded: false, partial: 0 });
      return { ok: true };
    }
    try {
      await invoke('local_remove', { model: model || null });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  },

  localCancel: async (id: number): Promise<void> => {
    if (!inTauri) {
      demoStopped.add(id);
      return;
    }
    try {
      await invoke('local_cancel', { id });
    } catch {
      /* nothing to stop */
    }
  },
};

export type Bridge = typeof bridge;
