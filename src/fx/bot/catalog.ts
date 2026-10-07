// What a host needs to pick a bot look: the states, shapes and colours it can ask for, the
// mood-to-state mapping, the island's own skin, and the pure helpers that validate and time them.
// No DOM in here, so it is covered by plain vitest.

import { COLOR_BY_ID, COLORS, SHAPE_BY_ID, SHAPES, type BotColor, type ShapeId } from './skins';
import { STATE_BY_ID, STATES, type StateId } from './states';

export type { BotColor };

/** One of bloub's animation states; the ids are upstream's own names. */
export type BotState = StateId;

/** A body shape id, one of BOT_SHAPES. */
export type BotShape = ShapeId;

/** Every state, in upstream's catalogue order. `swirl` is a UI transition rather than a mood. */
export const BOT_STATES: readonly BotState[] = STATES.map((state) => state.id);

/** Every body shape id (upstream's French names: cercle, galet, squircle, capsule...). */
export const BOT_SHAPES: readonly BotShape[] = SHAPES.map((shape) => shape.id);

/** The palette: an id (usable as `color` or `eye`) and the hex it stands for. */
export const BOT_COLORS: readonly BotColor[] = COLORS;

/** What the island is telling the user, in the island's words. */
export type BotMood = 'idle' | 'working' | 'thinking' | 'needs-you' | 'done' | 'error' | 'listening';

// Each mood gets the bloub state that reads closest AND still looks different from idle once its
// entrance has played (one-shot states settle on their final pose, so a ball that returns to
// idle's face would be indistinguishable). `thinking` is the only state that loops forever.
const STATE_FOR_MOOD: Record<BotMood, BotState> = {
  idle: 'idle',
  // The triangle "play" body: a swoosh of rings sweeps over it, then it stays a triangle.
  working: 'play',
  // The ball becomes three pulsing dots, the universal "busy" mark.
  thinking: 'thinking',
  // A blue notification dot pops on the body and the eyes look away from it.
  'needs-you': 'notify',
  // A content wink.
  done: 'wink',
  // The slanted "!" glyph that slides across, buzzes and settles.
  error: 'alert',
  // Big round eyes, wide open.
  listening: 'wide',
};

/** The bloub state for a mood. Unknown moods (a string from outside) fall back to idle. */
export function botStateFor(mood: BotMood): BotState {
  return STATE_FOR_MOOD[mood] ?? 'idle';
}

/** The input a host can give: any part may be left out. */
export interface BotSkin {
  /** A BOT_SHAPES id. */
  shape?: string;
  /** Body colour: a BOT_COLORS id or a `#rgb` / `#rrggbb` string. */
  color?: string;
  /** Colour seen through the eye holes: a BOT_COLORS id or a `#rgb` / `#rrggbb` string. */
  eye?: string;
}

/** A skin after validation: a known shape and two `#rrggbb` colours. */
export interface ResolvedSkin {
  shape: BotShape;
  color: string;
  eye: string;
}

// The island's look. Deliberately not x.ai's: a rounded square (squircle) rather than their
// circle, in a warm cream that glows on the near-black pill, with warm near-black eyes.
export const ISLAND_SKIN: ResolvedSkin = { shape: 'squircle', color: '#f6e1bd', eye: '#17120e' };

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A BOT_COLORS id or a `#rgb` / `#rrggbb` string as `#rrggbb`, or null if it is neither. */
export function resolveColor(value: string | undefined): string | null {
  if (value === undefined) return null;
  const named = COLOR_BY_ID.get(value);
  if (named) return named.hex;
  const match = HEX_COLOR.exec(value.trim());
  if (!match) return null;
  const digits = match[1]!.toLowerCase();
  if (digits.length === 6) return `#${digits}`;
  return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
}

/** Checks each part of `input`; anything missing or invalid keeps its value from `base`. */
export function resolveSkin(input: BotSkin | undefined, base: ResolvedSkin = ISLAND_SKIN): ResolvedSkin {
  const shape = input?.shape !== undefined && SHAPE_BY_ID.has(input.shape) ? (input.shape as BotShape) : base.shape;
  return {
    shape,
    color: resolveColor(input?.color) ?? base.color,
    eye: resolveColor(input?.eye) ?? base.eye,
  };
}

// Seconds of a state's own time after which its pose no longer changes visibly (Infinity = it
// loops for as long as it is shown). Read off the pose functions in states.ts, and checked
// against them by test/fx-bot-avatar.test.ts, so a new state cannot silently drift from this.
const SETTLES_AFTER: Record<BotState, number> = {
  idle: 0,
  thinking: Infinity,
  wink: 0,
  wide: 0,
  // The "!" is back in place at 2.0 s; after that only a 0.5 % buzz is left, far below a pixel.
  alert: 2,
  notify: 0.45,
  exclaim: 0,
  sleep: Infinity,
  egg: 0,
  hexagon: 0,
  play: 2.2,
  orbit: 3.6,
  swirl: 1.22,
  burst: 2.4,
  comet: 2.45,
};

/**
 * How long, in seconds after switching to `state`, frames can still differ from each other:
 * the blend from the previous state, or the state's own animation if that lasts longer.
 * Infinity means the state never stands still.
 */
export function motionSeconds(state: BotState): number {
  const morph = STATE_BY_ID.get(state)?.morph ?? 0;
  return Math.max(morph, SETTLES_AFTER[state] ?? 0);
}

/** How long the engine's one-off blink lasts, in seconds (the 0.2 s hard-coded in engine.ts). */
export const BLINK_SECONDS = 0.2;

/** Delay before the next idle blink: 3 to 6 seconds. `random` is injectable for tests. */
export function nextBlinkDelayMs(random: () => number = Math.random): number {
  return 3000 + random() * 3000;
}
