// The bot's brain: which mood wins, how moments play over it, and the Quiet and late-night rules.

import { describe, expect, it } from 'vitest';
import { COSTUMES } from '../src/fx/bot/costumes';
import { BOT_STATES } from '../src/fx/bot/catalog';
import { EXPRESSION_BY_ID } from '../src/fx/bot/expressions';
import { MOMENT_LOOKS, MOOD_LOOKS, lookFor } from '../src/core/looks';
import { MOMENT_MS, MOOD_ORDER, PetBrain, type MomentId, type MoodId, type PetMoment, type PetSignal } from '../src/core/pet';

const NOON = 12;
const T = 1_000_000;
const mood = (m: MoodId): PetSignal => ({ mood: m });
const moment = (id: MomentId, at: number, key: string = id, strength?: number): PetSignal => ({ moment: { id, key, at, strength } as PetMoment });

describe('moods', () => {
  it('the highest one reported wins; nothing reported is idle', () => {
    const b = new PetBrain();
    expect(b.update({ signals: [], dnd: false, now: T, hour: NOON }).mood).toBe('idle');
    expect(b.update({ signals: [mood('charging'), mood('vibing')], dnd: false, now: T, hour: NOON }).mood).toBe('vibing');
    expect(b.update({ signals: [mood('thinking'), mood('needs-you'), mood('vibing')], dnd: false, now: T, hour: NOON }).mood).toBe('needs-you');
  });

  it('Quiet puts it to sleep over everything but its own chat', () => {
    const b = new PetBrain();
    expect(b.update({ signals: [mood('vibing'), mood('needs-you')], dnd: true, now: T, hour: NOON }).mood).toBe('asleep');
    expect(b.update({ signals: [mood('listening')], dnd: true, now: T, hour: NOON }).mood).toBe('listening');
  });

  it('the order is the spec\'s: chat, asleep, needs you … idle last', () => {
    expect(MOOD_ORDER[0]).toBe('listening');
    expect(MOOD_ORDER.indexOf('asleep')).toBeLessThan(MOOD_ORDER.indexOf('needs-you'));
    expect(MOOD_ORDER.indexOf('vibing')).toBeLessThan(MOOD_ORDER.indexOf('charging'));
    expect(MOOD_ORDER.at(-1)).toBe('idle');
  });
});

describe('moments', () => {
  it('plays a new moment over the mood for its length, then the mood shows again', () => {
    const b = new PetBrain();
    const f = b.update({ signals: [mood('vibing'), moment('volume-down', T)], dnd: false, now: T, hour: NOON });
    expect(f).toMatchObject({ mood: 'vibing', moment: { id: 'volume-down' } });
    expect(b.update({ signals: [mood('vibing'), moment('volume-down', T)], dnd: false, now: T + MOMENT_MS['volume-down'] - 1, hour: NOON }).moment?.id).toBe('volume-down');
    expect(b.update({ signals: [mood('vibing'), moment('volume-down', T)], dnd: false, now: T + MOMENT_MS['volume-down'] + 1, hour: NOON }).moment).toBeNull();
  });

  it('a repeat on the same key carries on (one long bounce), a different moment takes over', () => {
    const b = new PetBrain();
    const first = b.update({ signals: [moment('volume-up', T, 'volume', 0.2)], dnd: false, now: T, hour: NOON });
    const again = b.update({ signals: [moment('volume-up', T + 300, 'volume', 0.4)], dnd: false, now: T + 300, hour: NOON });
    expect(again.play).toBe(first.play);
    expect(again.moment?.strength).toBe(0.4);
    // Still playing past the first one's end, because the repeat extended it.
    expect(b.update({ signals: [], dnd: false, now: T + MOMENT_MS['volume-up'] + 200, hour: NOON }).moment?.id).toBe('volume-up');
    const other = b.update({ signals: [moment('copy', T + 500)], dnd: false, now: T + 500, hour: NOON });
    expect(other.moment?.id).toBe('copy');
    expect(other.play).toBeGreaterThan(first.play);
  });

  it('never replays a report it has seen, nor one too old to matter', () => {
    const b = new PetBrain();
    b.update({ signals: [moment('copy', T)], dnd: false, now: T, hour: NOON });
    expect(b.update({ signals: [moment('copy', T)], dnd: false, now: T + MOMENT_MS.copy + 10, hour: NOON }).moment).toBeNull();
    const late = new PetBrain();
    expect(late.update({ signals: [moment('screenshot', T)], dnd: false, now: T + 60_000, hour: NOON }).moment).toBeNull();
  });

  it('in Quiet only urgent moments play, and they startle it awake', () => {
    const b = new PetBrain();
    expect(b.update({ signals: [moment('volume-up', T)], dnd: true, now: T, hour: NOON }).moment).toBeNull();
    const f = b.update({ signals: [moment('timer-done', T + 10)], dnd: true, now: T + 10, hour: NOON });
    expect(f).toMatchObject({ mood: 'asleep', moment: { id: 'timer-done' }, startled: true });
  });
});

describe('late at night', () => {
  it('a resting bot yawns every few minutes, but not by day or while busy', () => {
    const b = new PetBrain(() => 0); // the shortest wait
    const night = 23;
    let yawned = false;
    for (let t = 0; t <= 130_000; t += 1000) {
      if (b.update({ signals: [], dnd: false, now: T + t, hour: night }).moment?.id === 'yawn') yawned = true;
    }
    expect(yawned).toBe(true);
    const day = new PetBrain(() => 0);
    const busy = new PetBrain(() => 0);
    for (let t = 0; t <= 300_000; t += 1000) {
      expect(day.update({ signals: [], dnd: false, now: T + t, hour: NOON }).moment).toBeNull();
      expect(busy.update({ signals: [mood('vibing')], dnd: false, now: T + t, hour: night }).moment).toBeNull();
    }
  });
});

describe('looks', () => {
  it('every mood and every moment has one, made of things that exist', () => {
    const looks = [...MOOD_ORDER.map((m) => MOOD_LOOKS[m]), ...(Object.keys(MOMENT_MS) as MomentId[]).map((m) => MOMENT_LOOKS[m])];
    for (const l of looks) {
      expect(l, 'a look for every mood and moment').toBeDefined();
      expect(BOT_STATES).toContain(l.state);
      expect(EXPRESSION_BY_ID.has(l.face), l.face).toBe(true);
      for (const c of l.costume) expect(COSTUMES[c], c).toBeTruthy();
    }
  });

  it("the moment's look while one plays, the mood's otherwise; music keeps the headphones on", () => {
    expect(lookFor({ mood: 'asleep', moment: null }).costume).toEqual(['zzz']);
    expect(lookFor({ mood: 'idle', moment: { id: 'copy', key: 'copy', at: 0 } }).costume).toEqual(['clipboard']);
    expect(lookFor({ mood: 'vibing', moment: { id: 'volume-up', key: 'v', at: 0 } }).costume).toEqual(['headphones', 'waves']);
    expect(lookFor({ mood: 'vibing', moment: { id: 'paused', key: 'p', at: 0 } }).costume).toEqual(['headphones-down']);
  });

  it('every costume is markup, with no script in it', () => {
    for (const [id, svg] of Object.entries(COSTUMES)) {
      expect(svg, id).toMatch(/^</);
      expect(svg, id).not.toMatch(/script|onw+=/i);
    }
  });
});
