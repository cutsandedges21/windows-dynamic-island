// The orb vocabulary: its nine states, the two tuned sizes and the two inks, plus the rule that
// maps any pixel size onto a tuned preset. Types and doc comments follow thinking-orbs'
// types.ts (MIT, Jakub Antalik) without its React props; see THIRD_PARTY_NOTICES.md.

/**
 * The nine shipped states, each a hand-tuned animation:
 * - `working`    particles on tilted orbits
 * - `searching`  a scan meridian sweeps a dotted globe
 * - `solving`    bands scramble in quarter turns, then click back
 * - `listening`  a waveform rolls through latitude rings
 * - `connecting` a constellation wires itself, packets running the edges
 * - `weaving`    three strands plait around the sphere
 * - `composing`  an undulating multi-band sash
 * - `breathing`  a face-on ring slowly morphing
 * - `shaping`    a dotted outline morphs circle, triangle, square
 */
export type OrbState =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping';

export const ORB_STATES: readonly OrbState[] = [
  'working',
  'searching',
  'solving',
  'listening',
  'connecting',
  'weaving',
  'composing',
  'breathing',
  'shaping',
];

/**
 * The two sizes the animations are tuned for, in CSS px: 64 (chat-avatar scale) and 20
 * (inline-text scale). Each carries its own dot count, dot size and speed: they are separate
 * designs, not a scale factor.
 */
export type OrbSize = 64 | 20;

/**
 * Dark renders light ink on the transparent canvas (for dark backgrounds, like the island's
 * pill); light renders dark ink (for light backgrounds).
 */
export type OrbTheme = 'dark' | 'light';

/**
 * The tuned preset closest to a pixel size, by ratio: up to 35 px uses the 20 preset, above
 * that the 64 preset. The orb is still drawn at exactly the requested size; only its dot
 * count, dot size and speed come from the preset.
 */
export function presetSizeFor(size: number): OrbSize {
  return size < Math.sqrt(20 * 64) ? 20 : 64;
}
