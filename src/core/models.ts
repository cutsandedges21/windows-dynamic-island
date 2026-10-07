// Which model Local AI answers with, and how the model picker describes this PC and each
// model. Pure: the Local AI activity (src/activities/local.ts) and the picker in the
// Activities window (src/models-ui.ts) share it.

import type { IslandModel, LocalBackend, LocalModel, LocalStatus, Machine, ModelsReport, SetupProgress } from './bridge';

/** Local AI's `model` option names one of Island's own models like this: 'island:small'. */
export const ISLAND = 'island:';

/** Answers at 17 tok/s on a laptop CPU (i7-12650H) with no thinking step first. */
export const SUGGESTED_MODEL = 'llama3.2:3b';
export const NO_SERVER = "Ollama isn't running. Start it, or get it from ollama.com.";
export const SET_UP_FIRST = 'Set up Local AI first: tap Set up on its tile.';
export const STILL_DOWNLOADING = 'Your model is still downloading. Ask again once it is done.';
export const NOT_DOWNLOADED = "That model isn't downloaded. Pick one in Activities › Local AI.";

export const isEmbedding = (m: LocalModel) => /embed/i.test(m.name) || /bert$/i.test(m.family);

/** The model to ask: the one named in the options, or else the smallest chat model installed. */
export function pickModel(models: LocalModel[], wanted: unknown): { model: string } | { error: string } {
  const name = typeof wanted === 'string' ? wanted.trim() : '';
  if (name) {
    const found = models.find((m) => m.name === name || m.name === `${name}:latest`);
    return found ? { model: found.name } : { error: `${name} is not installed. Run: ollama pull ${name}` };
  }
  const chat = models.filter((m) => !isEmbedding(m)).sort((a, b) => a.size - b.size);
  return chat.length ? { model: chat[0].name } : { error: `No chat model yet. Run: ollama pull ${SUGGESTED_MODEL}` };
}

/** Who answers: the backend, the model id it is asked for, and the name people see. */
export interface Choice {
  backend: LocalBackend;
  model: string;
  label: string;
}

/**
 * Who answers and with which model. An option naming one of Island's own models
 * ('island:small') gets that model once it is downloaded. Until then, or with no Island
 * model named, Ollama answers when it runs with a chat model, else Island's recommended
 * model if it is downloaded, else the best one that is.
 */
export function chooseBackend(status: LocalStatus, wanted: unknown): Choice | { error: string } {
  const name = typeof wanted === 'string' ? wanted.trim() : '';
  const own = name.startsWith(ISLAND) ? name.slice(ISLAND.length) : null;
  const b = status.bundled;
  const ready = b?.ready ?? [];
  const named = own == null ? undefined : ready.find((r) => r.id === own);
  if (named) return { backend: 'island', model: named.id, label: named.name };
  const pick = status.running ? pickModel(status.models, own == null ? name : '') : null;
  if (pick && 'model' in pick) return { backend: 'ollama', model: pick.model, label: pick.model };
  const best = ready.find((r) => r.id === b?.recommended) ?? ready[0];
  if (best) return { backend: 'island', model: best.id, label: best.name };
  if (own != null) return { error: b?.settingUp ? STILL_DOWNLOADING : NOT_DOWNLOADED };
  if (pick) return pick;
  return { error: b?.model ? SET_UP_FIRST : NO_SERVER };
}

/** The option value of the model that answers right now ('island:small' or an Ollama name), or '' when none can. */
export function activeValue(status: LocalStatus | null, option: string): string {
  if (!status) return '';
  const pick = chooseBackend(status, option);
  if ('error' in pick) return '';
  return pick.backend === 'island' ? `${ISLAND}${pick.model}` : pick.model;
}

// ---------------------------------------------------------------- how the picker words things

const GiB = 2 ** 30;
/** Memory sizes PCs come with, in GB. */
const MEMORY_SIZES = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
/** A card with this much memory of its own is a graphics card; less is built-in graphics. */
const DEDICATED = 2 * GiB;
/** Adapters that are not graphics hardware. */
const VIRTUAL = /basic (display|render)|remote display|virtual|parsec|citrix|vmware|hyper-v|indirect display/i;
/** Room a download leaves free on the disk (Rust refuses below it too). */
const SPARE = 500_000_000;

/** "32 GB": the smallest usual memory size that holds `bytes` (Windows shows a 32 GB PC as 31.7). */
export function memoryClass(bytes: number): string {
  const gib = bytes / GiB;
  return `${MEMORY_SIZES.find((s) => s >= gib - 0.05) ?? Math.ceil(gib)} GB`;
}

/** "12.1 GB", or "33 MB" under a gigabyte. */
export function sizeText(bytes: number): string {
  return bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Names without the trademark noise: "12th Gen Intel Core i7-12650H", "Intel UHD Graphics". */
export function cleanName(name: string): string {
  return name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s+CPU\b/g, '')
    .replace(/\s*@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Specs {
  cpu: string;
  memory: string;
  graphics: string;
  disk: string;
  /** Where models run on this PC, in a sentence. */
  note: string;
}

/** This PC in four short lines and a sentence. */
export function specs(m: Machine, models: IslandModel[]): Specs {
  const real = m.gpus.filter((g) => g.name && !VIRTUAL.test(g.name));
  const cards = real.filter((g) => g.vram >= DEDICATED).sort((a, b) => b.vram - a.vram);
  const graphics = cards.length ? `${cleanName(cards[0].name)} · ${Math.round(cards[0].vram / GiB)} GB` : real.length ? `${cleanName(real[0].name)} (built in)` : 'Built-in graphics';
  const best = models.find((x) => x.recommended);
  let note: string;
  if (!best) note = 'This PC has too little memory for a local model.';
  else if (best.gpu) note = `Models run on your ${cleanName(best.gpu)}, which is the fastest place for them.`;
  else if (cards.length) note = `Models run on the processor. ${cleanName(cards[0].name)} can take the smaller ones.`;
  else note = 'No graphics card with memory of its own, so models run on the processor.';
  return {
    cpu: `${cleanName(m.cpu) || 'Processor'}${m.threads ? ` · ${m.threads} threads` : ''}`,
    memory: `${memoryClass(m.ram)} memory`,
    graphics,
    disk: `${Math.round(m.diskFree / 1e9)} GB free${m.disk ? ` on ${m.disk}` : ''}`,
    note,
  };
}

/** Where a model stands on this PC, and so which button it gets. */
export type ModelStatus = 'in-use' | 'ready' | 'downloading' | 'paused' | 'get' | 'no-room' | 'too-big';

export interface ModelView {
  status: ModelStatus;
  /** One short line: the download size and where it runs, or why it cannot. */
  detail: string;
  /** 0..1 while downloading; null before the first numbers. */
  progress: number | null;
}

/** How the picker shows `m`. `active`: it is the model answering now. */
export function modelView(m: IslandModel, report: ModelsReport, progress: SetupProgress | null, active: boolean): ModelView {
  const where = m.gpu ? `runs on your ${cleanName(m.gpu)}` : 'runs on the processor';
  if (!m.fits) return { status: 'too-big', detail: `Needs ${memoryClass(m.needs)} of memory. This PC has ${memoryClass(report.machine.ram)}.`, progress: null };
  if (report.downloading === m.id) {
    const p = progress?.model === m.id ? progress : null;
    const share = p && p.total > 0 ? Math.min(1, p.done / p.total) : null;
    const detail = !p ? 'Starting the download…' : p.stage === 'runtime' ? 'Getting the model runtime first…' : `${sizeText(p.done)} of ${sizeText(p.total)}`;
    return { status: 'downloading', detail, progress: share };
  }
  if (m.downloaded && report.runtime) return { status: active ? 'in-use' : 'ready', detail: `${sizeText(m.size)} · ${where}`, progress: null };
  const left = (m.downloaded ? 0 : m.size - m.partial) + (report.runtime ? 0 : report.runtimeSize);
  const free = report.machine.diskFree;
  if (free > 0 && left + SPARE > free) return { status: 'no-room', detail: `Needs ${sizeText(left + SPARE)} free. ${report.machine.disk || 'The disk'} has ${sizeText(free)}.`, progress: null };
  if (m.partial > 0 && !m.downloaded) return { status: 'paused', detail: `Paused at ${sizeText(m.partial)} of ${sizeText(m.size)}`, progress: m.partial / m.size };
  return { status: 'get', detail: `${sizeText(left)} download · ${where}`, progress: null };
}
