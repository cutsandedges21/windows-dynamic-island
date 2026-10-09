// Where the bot's eyes point. They rest in the middle, looking at you; only a pointer that comes
// close to the bot pulls them, and only a little, so the face stays calm (Moss: "it should be in
// the middle mostly", "only follow when the mouse gets within a certain range").

/** Resting gaze: straight ahead, a touch up. Degrees: yaw > 0 looks right, pitch > 0 looks up. */
export const REST_GAZE = { yaw: 0, pitch: 4 };

/** Distance from the bot's centre, CSS px, inside which the eyes follow the pointer. */
export const FOLLOW_RADIUS = 110;

/** How far the eyes may turn toward the pointer. */
const MAX_YAW = 18;
const MAX_PITCH = 14;

export interface Gaze {
  yaw: number;
  pitch: number;
}

/**
 * The gaze toward a pointer at (dx, dy) from the bot's centre, or null when the pointer is out
 * of range (the eyes go back to rest). Closer pulls harder: at the edge of the range the eyes
 * barely move, right next to the bot they reach the limit.
 */
export function gazeToward(dx: number, dy: number): Gaze | null {
  const dist = Math.hypot(dx, dy);
  if (!(dist <= FOLLOW_RADIUS)) return null;
  if (dist < 1) return { ...REST_GAZE };
  const pull = 1 - dist / FOLLOW_RADIUS;
  const reach = Math.min(1, pull * 2.2);
  return {
    yaw: (dx / dist) * MAX_YAW * reach + REST_GAZE.yaw * (1 - reach),
    pitch: (-dy / dist) * MAX_PITCH * reach + REST_GAZE.pitch * (1 - reach),
  };
}
