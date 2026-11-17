// Sound packs that ship with Island: recorded chimes, offered in Settings › Notifications as
// styles beside the synthesized ones (src/core/sounds.ts).
//
// To add one: put its two files in public/sounds/<id>/ (Vite copies public/ into the build as
// is), one for "something finished" and one for "something needs you", and add a line below.
// MP3, WAV, OGG, M4A, AAC, FLAC or Opus; a second or two each; trimmed of silence at the start.

export interface SoundPack {
  /** Saved in settings: keep it once shipped. Not one of the built-in style ids. */
  id: string;
  /** Its button in Settings. */
  label: string;
  /** Paths under public/. */
  done: string;
  attention: string;
}

export const SOUND_PACKS: readonly SoundPack[] = [
  // { id: 'moss', label: 'Moss', done: 'sounds/moss/done.mp3', attention: 'sounds/moss/attention.mp3' },
];
