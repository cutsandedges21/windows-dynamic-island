// The pill's edge light: its own activity's, or Claude's blue kept on from behind.

import { describe, expect, it } from 'vitest';
import type { ActivityStatus } from '../src/core/activity';
import { pillBeam } from '../src/core/beam';

const claudeRunning: ActivityStatus = {
  active: true, weight: 'foreground',
  beam: { tone: 'info', motion: 'progress', value: 0.4 },
  beamBehind: { tone: 'info', motion: 'orbit' },
};
const map = (o: Record<string, ActivityStatus>) => new Map(Object.entries(o));
const order = ['music', 'claudeStatus', 'timer', 'battery'];

describe('pillBeam', () => {
  it('keeps Claude running blue while music, with no light of its own, is in front', () => {
    const st = map({ music: { active: true, weight: 'foreground' }, claudeStatus: claudeRunning });
    expect(pillBeam('music', order, st)).toEqual({ tone: 'info', motion: 'orbit' });
  });

  it('wins over the front activity’s own steady light (a running timer, charging)', () => {
    const st = map({
      timer: { active: true, weight: 'foreground', beam: { tone: 'accent', motion: 'progress', value: 0.5 } },
      claudeStatus: claudeRunning,
    });
    expect(pillBeam('timer', order, st)).toEqual({ tone: 'info', motion: 'orbit' });
  });

  it('gives way to a light that wants the user', () => {
    const low = { tone: 'bad' as const, motion: 'pulse' as const };
    expect(pillBeam('battery', order, map({ battery: { active: true, beam: low }, claudeStatus: claudeRunning }))).toEqual(low);
    const done = { tone: 'good' as const, motion: 'still' as const };
    expect(pillBeam('timer', order, map({ timer: { active: true, beam: done }, claudeStatus: claudeRunning }))).toEqual(done);
  });

  it('in front, Claude Status shows its own light (the task bar fill)', () => {
    expect(pillBeam('claudeStatus', order, map({ claudeStatus: claudeRunning }))).toEqual(claudeRunning.beam);
  });

  it('without Claude running: the pill’s own light, else an orbit busy elsewhere, else none', () => {
    const fill = { tone: 'accent' as const, motion: 'progress' as const, value: 0.5 };
    expect(pillBeam('timer', order, map({ timer: { active: true, beam: fill } }))).toEqual(fill);
    const orbit = { tone: 'info' as const, motion: 'orbit' as const };
    expect(pillBeam('music', order, map({ music: { active: true }, downloads: { active: true, weight: 'foreground', beam: orbit } }))).toBe(null); // not in the order
    expect(pillBeam('music', [...order, 'downloads'], map({ music: { active: true }, downloads: { active: true, weight: 'foreground', beam: orbit } }))).toEqual(orbit);
    expect(pillBeam('music', order, map({ music: { active: true }, timer: { active: true, weight: 'foreground', beam: fill } }))).toBe(null); // a fill stays with its own pill
    expect(pillBeam(null, order, map({}))).toBe(null);
  });

  it('an inactive activity keeps no light on', () => {
    expect(pillBeam('music', order, map({ music: { active: true }, claudeStatus: { ...claudeRunning, active: false } }))).toBe(null);
  });
});
