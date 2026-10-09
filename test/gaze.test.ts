// The bot's eyes: in the middle unless the pointer is close, and then only a small turn toward it.

import { describe, expect, it } from 'vitest';
import { FOLLOW_RADIUS, REST_GAZE, gazeToward } from '../src/core/gaze';

describe('the bot\'s gaze', () => {
  it('ignores a pointer out of range', () => {
    expect(gazeToward(FOLLOW_RADIUS + 1, 0)).toBeNull();
    expect(gazeToward(0, -400)).toBeNull();
    expect(gazeToward(Number.NaN, 0)).toBeNull();
  });

  it('turns toward a close pointer, right and up, left and down', () => {
    const right = gazeToward(40, 0)!;
    expect(right.yaw).toBeGreaterThan(5);
    const up = gazeToward(0, -40)!;
    expect(up.pitch).toBeGreaterThan(REST_GAZE.pitch);
    const leftDown = gazeToward(-30, 30)!;
    expect(leftDown.yaw).toBeLessThan(0);
    expect(leftDown.pitch).toBeLessThan(REST_GAZE.pitch);
  });

  it('never turns far: the face stays calm', () => {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      for (const r of [2, 10, 30, 60, 100]) {
        const g = gazeToward(Math.cos(a) * r, Math.sin(a) * r)!;
        expect(Math.abs(g.yaw)).toBeLessThanOrEqual(18);
        expect(Math.abs(g.pitch)).toBeLessThanOrEqual(14);
      }
    }
  });

  it('barely moves at the edge of the range, more right next to the bot', () => {
    const edge = gazeToward(FOLLOW_RADIUS - 5, 0)!;
    const near = gazeToward(20, 0)!;
    expect(Math.abs(edge.yaw)).toBeLessThan(3);
    expect(near.yaw).toBeGreaterThan(edge.yaw * 3);
  });
});
