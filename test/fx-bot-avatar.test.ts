// The avatar's timing table (catalog.ts, motionSeconds) checked against the engine itself, so the
// avatar never puts its frame loop to sleep while the picture is still moving, and the moods the
// island uses checked to look different from the resting bot.

import { describe, expect, it } from 'vitest';
import { BOT_STATES, ISLAND_SKIN, botStateFor, motionSeconds, nextBlinkDelayMs, resolveSkin, type BotMood, type BotState } from '../src/fx/bot/catalog';
import { BotEngine } from '../src/fx/bot/engine';
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from '../src/fx/bot/expressions';
import { RAYON } from '../src/fx/bot/repere';
import { SHAPE_BY_ID } from '../src/fx/bot/skins';

/** An engine set up like the avatar's: the island's shape, the default face, no drifting gaze or blinks. */
function engine(): BotEngine {
  const e = new BotEngine(RAYON, 'idle', SHAPE_BY_ID.get(ISLAND_SKIN.shape)!.radii, EXPRESSION_BY_ID.get(DEFAULT_EXPRESSION) ?? null);
  e.ambient = false;
  return e;
}

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

/** The on-curve points of a closedPath() outline ("M x y" then "C c1 c2 x y" per segment). */
function anchors(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const head = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (head) out.push([+head[1]!, +head[2]!]);
  for (const seg of d.matchAll(/C[-\d. ]+? (-?[\d.]+) (-?[\d.]+)(?=C|Z)/g)) out.push([+seg[1]!, +seg[2]!]);
  return out;
}

/**
 * A frame as numbers, the body reduced to what can be seen of it: its extent and how far its edge
 * is from its centre, sorted. A spinning round body has a moving path start but a still picture.
 */
function numbers(e: BotEngine, t: number): number[] {
  const { bodyPath, ...rest } = e.sample(t);
  const pts = anchors(bodyPath);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (box[0]! + box[1]!) / 2;
  const cy = (box[2]! + box[3]!) / 2;
  const edge = pts.map(([x, y]) => Math.hypot(x - cx, y - cy)).sort((a, b) => a - b);
  return [...box, ...edge, ...(JSON.stringify(rest).match(NUMBER) ?? []).map(Number)];
}

/** How far apart two frames are, in viewBox units (240 across, so 1 unit is about 0.1 px at 24 px). */
function distance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  return a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);
}

/** The engine `state` was switched to at time 0, sampled at `t`. */
function after(state: BotState, t: number): number[] {
  const e = engine();
  e.setState(state, 0);
  return numbers(e, t);
}

describe('motionSeconds', () => {
  it.each(BOT_STATES.filter((s) => Number.isFinite(motionSeconds(s))))('%s stands still once its motion time is over', (state) => {
    const settled = motionSeconds(state) + 0.05;
    expect(distance(after(state, settled), after(state, settled + 3.7))).toBeLessThan(1);
  });

  it.each(BOT_STATES.filter((s) => !Number.isFinite(motionSeconds(s))))('%s keeps moving, so the loop never sleeps', (state) => {
    expect(distance(after(state, 10), after(state, 10.37))).toBeGreaterThan(1);
  });

  it('the comparison does see motion: play is still sweeping at 1 s', () => {
    expect(distance(after('play', 1), after('play', motionSeconds('play') + 1))).toBeGreaterThan(1);
  });
});

describe('moods', () => {
  const MOODS: BotMood[] = ['working', 'thinking', 'needs-you', 'done', 'error', 'listening'];

  it.each(MOODS)('%s still looks different from idle once it has settled', (mood) => {
    const state = botStateFor(mood);
    const t = Math.min(motionSeconds(state), 6) + 0.1;
    expect(distance(after(state, t), after('idle', t))).toBeGreaterThan(5);
  });

  it('an unknown mood rests', () => {
    expect(botStateFor('nope' as BotMood)).toBe('idle');
    expect(botStateFor('idle')).toBe('idle');
  });
});

describe('skins and blinks', () => {
  it('keeps what is valid and falls back for the rest', () => {
    expect(resolveSkin({ color: '#abc', eye: 'nope', shape: 'nope' })).toEqual({ shape: ISLAND_SKIN.shape, color: '#aabbcc', eye: ISLAND_SKIN.eye });
    expect(resolveSkin(undefined)).toEqual(ISLAND_SKIN);
  });

  it('blinks every 3 to 6 seconds', () => {
    expect(nextBlinkDelayMs(() => 0)).toBe(3000);
    expect(nextBlinkDelayMs(() => 0.999)).toBeLessThan(6000);
  });
});
