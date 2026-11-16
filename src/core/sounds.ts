// Island's chime: a short synthesized tune in one of a few styles, a recorded pack that ships
// with Island (src/core/sound-packs.ts), or your own sound file (src-tauri/src/sounds.rs keeps a
// copy), at the volume set in Settings › Notifications.

import { native } from './native';
import { SYNTH_STYLES, type Settings, type SoundStyle, type SynthStyle } from './settings';
import { SOUND_PACKS } from './sound-packs';

/** Something finished, or something needs you. */
export type ChimeKind = 'done' | 'attention';
export type SoundPrefs = Settings['general']['sound'];

/** One tone: `f` Hz (gliding to `to`), starting `at` s in, fading out over `len` s. */
export interface Note {
  f: number;
  to?: number;
  at: number;
  len: number;
  wave: OscillatorType;
  peak: number;
}

/** The styles offered in Settings, in order: synthesized, the packs, your own. */
export function styleChoices(): Array<[SoundStyle, string]> {
  return [
    ['soft', 'Soft'],
    ['glass', 'Glass'],
    ['pop', 'Pop'],
    ['bell', 'Bell'],
    ['retro', 'Retro'],
    ...SOUND_PACKS.map((p): [SoundStyle, string] => [p.id, p.label]),
    ['custom', 'Your own'],
  ];
}

/** Your own sound is cut (with a fade) after this long: a chime, not a song. */
export const MAX_FILE_SECONDS = 6;
const ATTACK = 0.02;

const tone = (f: number, at: number, len: number, peak: number, wave: OscillatorType = 'sine', to?: number): Note => ({ f, at, len, wave, peak, ...(to ? { to } : {}) });

/** A bell: the strike and two quieter, faster-fading partials above it. */
const strike = (f: number, at: number): Note[] => [tone(f, at, 1.4, 0.12), tone(f * 2.76, at, 0.9, 0.045), tone(f * 5.4, at, 0.5, 0.02)];

/** Glass: each tone with a faint octave shimmer. */
const ping = (f: number, at: number): Note[] => [tone(f, at, 0.6, 0.09), tone(f * 2.01, at, 0.35, 0.03)];

/** The tones of a built-in style. */
export function notes(style: SynthStyle, kind: ChimeKind): Note[] {
  const done = kind === 'done';
  switch (style) {
    case 'soft':
      return (done ? [880, 1174.7] : [659.3, 880]).map((f, i) => tone(f, i * 0.14, 0.5, 0.12));
    case 'glass':
      return (done ? [1318.5, 1975.5] : [1975.5, 1318.5, 1975.5]).flatMap((f, i) => ping(f, i * (done ? 0.1 : 0.12)));
    case 'pop':
      return (done ? [520, 780] : [620, 620, 620]).map((f, i) => tone(f, i * (done ? 0.11 : 0.1), 0.09, 0.16, 'sine', f * 1.9));
    case 'bell':
      return done ? strike(1046.5, 0) : [...strike(880, 0), ...strike(880, 0.3)];
    case 'retro':
      return done
        ? [1046.5, 1318.5, 1568, 2093].map((f, i, all) => tone(f, i * 0.07, i === all.length - 1 ? 0.22 : 0.1, 0.05, 'square'))
        : [988, 1319, 988, 1319].map((f, i) => tone(f, i * 0.08, 0.09, 0.05, 'square'));
  }
}

/** Seconds from the first tone's start to the last one's end. */
export function length(list: Note[]): number {
  return list.reduce((end, n) => Math.max(end, n.at + n.len), 0);
}

/** The volume setting as a 0 to 1 level. */
export function soundLevel(volume: number): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) / 100 : 0.5;
}

/** Plays `list` with every peak times `scale`; how long it lasts, in seconds. */
function playNotes(ac: AudioContext, list: Note[], scale: number): number {
  for (const n of list) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = n.wave;
    const t = ac.currentTime + n.at;
    o.frequency.setValueAtTime(n.f, t);
    if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, t + n.len * 0.6);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(n.peak * scale, t + ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.len);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + n.len + 0.05);
  }
  return length(list) + 0.05;
}

/** Recorded sounds' bytes: your own by kind and the setting's rev (a new pick loads again),
 *  a pack's by its path. */
const files = new Map<string, Promise<ArrayBuffer | null>>();

function cached(key: string, load: () => Promise<ArrayBuffer | null>, drop?: string): Promise<ArrayBuffer | null> {
  let got = files.get(key);
  if (!got) {
    if (drop) for (const k of [...files.keys()]) if (k.startsWith(drop)) files.delete(k);
    got = load();
    files.set(key, got);
  }
  return got;
}

async function fetchBytes(path: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(new URL(path, document.baseURI));
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** The recorded sound `prefs` pick for `kind`, if any. */
function recorded(kind: ChimeKind, prefs: SoundPrefs): Promise<ArrayBuffer | null> | null {
  if (prefs.style === 'custom') return prefs[kind] ? cached(`own:${kind}:${prefs.rev}`, () => native.soundRead(kind), `own:${kind}:`) : null;
  const pack = SOUND_PACKS.find((p) => p.id === prefs.style);
  return pack ? cached(`pack:${pack[kind]}`, () => fetchBytes(pack[kind])) : null;
}

/** The synthesized style to play: a recorded one that is missing or broken falls back to Soft. */
function synthOf(style: SoundStyle): SynthStyle {
  return (SYNTH_STYLES as string[]).includes(style) ? (style as SynthStyle) : 'soft';
}

/** Plays your own file; how long it lasts, or null when it can't be played. */
async function playFile(ac: AudioContext, bytes: ArrayBuffer, level: number): Promise<number | null> {
  let buf: AudioBuffer;
  try {
    // decodeAudioData takes the buffer over: a copy keeps the cached one whole.
    buf = await ac.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  const t = ac.currentTime;
  const seconds = Math.min(buf.duration, MAX_FILE_SECONDS);
  g.gain.setValueAtTime(level, t);
  if (buf.duration > MAX_FILE_SECONDS) {
    g.gain.setValueAtTime(level, t + seconds - 0.5);
    g.gain.linearRampToValueAtTime(0, t + seconds);
    src.stop(t + seconds);
  }
  src.connect(g).connect(ac.destination);
  src.start(t);
  return seconds;
}

/** Plays the `kind` chime as `prefs` say, whether sounds are on or not (Settings' preview). */
export async function playSound(kind: ChimeKind, prefs: SoundPrefs): Promise<void> {
  const level = soundLevel(prefs.volume);
  if (level <= 0) return;
  let ac: AudioContext;
  try {
    ac = new AudioContext();
  } catch {
    return; // no audio device
  }
  try {
    const bytes = await recorded(kind, prefs);
    let seconds = bytes ? await playFile(ac, bytes, level) : null;
    // The tones are quiet sine waves: 50 plays them at their first loudness.
    seconds ??= playNotes(ac, notes(synthOf(prefs.style), kind), level * 2);
    setTimeout(() => void ac.close(), (seconds + 0.3) * 1000);
  } catch {
    void ac.close();
  }
}

/** The chime for a moment, when Settings › Notifications › Sounds is on. */
export function chime(kind: ChimeKind, general: Settings['general']): void {
  if (general.sounds) void playSound(kind, general.sound);
}
