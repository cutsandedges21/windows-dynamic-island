// The island engine: springs, layout (all four anchors, vertical), the space
// budget, priorities and settings migration.

import { describe, expect, it } from 'vitest';
import { contentOrigin, expansionVector, levelWidth, normalizeWidths, orientationFor, pillRect, pillSize } from '../src/core/layout';
import { choosePrimary, rankOf, type Candidate } from '../src/core/priority';
import { timeLike } from '../src/core/renderer';
import { fitSegments, fitVertical, type Seg } from '../src/core/segments';
import { accentColor, defaultActivityConfig, migrate } from '../src/core/settings';
import { solve, Spring, springEasing, springs } from '../src/core/spring';

describe('springs', () => {
  it('settles exactly on its target and keeps velocity when retargeted', () => {
    const s = new Spring(0, springs.shell);
    s.setTarget(100);
    for (let i = 0; i < 20; i++) s.step(1 / 60);
    const v = s.velocity;
    expect(Math.abs(v)).toBeGreaterThan(0);
    s.setTarget(50);
    expect(s.velocity).toBe(v);
    for (let i = 0; i < 600 && !s.settled; i++) s.step(1 / 60);
    expect(s.settled).toBe(true);
    expect(s.value).toBe(50);
  });

  it('underdamped overshoots, critically damped does not', () => {
    const peak = (damping: number) => {
      let x = -1;
      let v = 0;
      let max = -Infinity;
      for (let i = 0; i < 400; i++) {
        [x, v] = solve(x, v, { response: 0.5, damping }, 1 / 240);
        max = Math.max(max, x);
      }
      return max;
    };
    expect(peak(0.6)).toBeGreaterThan(0.01);
    expect(peak(1)).toBeLessThanOrEqual(1e-9);
    expect(peak(1.4)).toBeLessThanOrEqual(1e-9);
  });

  it('a big frame step is stable (exact solution, no blow-up)', () => {
    const [x] = solve(-100, 0, springs.bouncy, 5);
    expect(Math.abs(x)).toBeLessThan(1e-3);
  });

  it('samples into a CSS linear() easing that ends at 1', () => {
    const { easing, duration } = springEasing(springs.content);
    expect(easing.startsWith('linear(0')).toBe(true);
    expect(easing.endsWith(', 1)')).toBe(true);
    expect(duration).toBeGreaterThan(100);
  });
});

describe('layout', () => {
  const area = { width: 1536, height: 816 };
  const widths = normalizeWidths(null);

  it('widths are shares of the display and stay ordered', () => {
    expect(levelWidth(area, widths, 'compact', 8)).toBe(Math.round(1536 * 0.12));
    expect(levelWidth(area, widths, 'maximum', 8)).toBe(Math.round(1536 * 0.45));
    expect(levelWidth({ width: 3840, height: 2000 }, widths, 'maximum', 8)).toBe(Math.round(3840 * 0.45));
    const w = normalizeWidths({ compact: 0.5, expanded: 0.2, maximum: 0.1 });
    expect(w.compact).toBeLessThan(w.expanded);
    expect(w.expanded).toBeLessThan(w.maximum);
  });

  it('every anchor pins its own edge and grows away from it', () => {
    const top = pillRect(area, 'top', 400, 40, 8);
    expect(top).toEqual({ x: 568, y: 8, w: 400, h: 40 });
    const bottom = pillRect(area, 'bottom', 400, 40, 8);
    expect(bottom.y + bottom.h).toBe(816 - 8);
    const left = pillRect(area, 'left', 40, 300, 8);
    expect(left.x).toBe(8);
    expect(left.y).toBe((816 - 300) / 2);
    const right = pillRect(area, 'right', 40, 300, 8);
    expect(right.x + right.w).toBe(1536 - 8);
    expect(expansionVector('top')).toEqual({ x: 0, y: 1 });
    expect(expansionVector('bottom')).toEqual({ x: 0, y: -1 });
    expect(expansionVector('left')).toEqual({ x: 1, y: 0 });
    expect(expansionVector('right')).toEqual({ x: -1, y: 0 });
  });

  it('left and right pills stand vertical; top and bottom lie flat', () => {
    expect(orientationFor('left')).toBe('vertical');
    expect(orientationFor('top')).toBe('horizontal');
    const v = pillSize(area, widths, 'maximum', 8, 'medium', 'vertical');
    expect(v.h).toBeGreaterThan(v.w * 3);
    expect(v.h).toBe(Math.round(Math.max(300, 816 * 0.45)));
    const hz = pillSize(area, widths, 'maximum', 8, 'medium', 'horizontal');
    expect(hz.w).toBeGreaterThan(hz.h * 5);
    expect(contentOrigin('right', 'vertical', 72, 300)).toEqual({ x: 36, y: 150 });
    expect(contentOrigin('left', 'horizontal', 300, 40)).toEqual({ x: 0, y: 20 });
  });
});

describe('space budget', () => {
  const measure = (text: string) => text.length * 7;
  const text = (key: string, t: string, prio = 5): Seg => ({ t: 'text', key, text: t, prio });

  it('everything fits: start, centre and end sides', () => {
    const placed = fitSegments([text('a', 'aaaa', 0), { ...text('m', 'mid'), side: 'center' }, { ...text('z', 'zz'), side: 'end' }], 300, 40, measure);
    const a = placed.find((p) => p.seg.key === 'a')!;
    const z = placed.find((p) => p.seg.key === 'z')!;
    expect(a.x).toBe(0);
    expect(z.x + z.w).toBe(300);
  });

  it('squeezes text first, then drops the least important, never prio 0', () => {
    const segs: Seg[] = [text('title', 'a very long title that will not fit', 0), text('detail', 'detail text here', 4), text('extra', 'extra', 8)];
    const placed = fitSegments(segs, 200, 40, measure);
    const keys = placed.map((p) => p.seg.key);
    expect(keys).toContain('title');
    expect(keys).not.toContain('extra');
    const total = placed.reduce((s, p) => s + p.w, 0) + 8 * (placed.length - 1);
    expect(total).toBeLessThanOrEqual(200);
  });

  it('an input takes the leftover room', () => {
    const placed = fitSegments([{ t: 'icon', key: 'i', icon: 'claude', prio: 0 }, { t: 'input', key: 'in', placeholder: 'x', action: 'send', prio: 0 }], 400, 50, measure);
    const input = placed.find((p) => p.seg.key === 'in')!;
    expect(input.x + input.w).toBe(400);
  });

  it('vertical: stacks along the pill and cuts text to its width', () => {
    const placed = fitVertical([{ t: 'icon', key: 'i', icon: 'music', prio: 0 }, text('t', 'SICKO MODE', 1), { t: 'button', key: 'b', icon: 'play', action: 'toggle', side: 'end', prio: 2 }], 200, 50, measure);
    const t = placed.find((p) => p.seg.key === 't')!;
    expect(t.w).toBeLessThanOrEqual(50);
    const b = placed.find((p) => p.seg.key === 'b')!;
    expect(b.x + (b.h ?? 0)).toBe(200);
  });
});

describe('priority', () => {
  const cand = (id: string, over: Partial<Candidate['status']> = {}, priority: 'high' | 'medium' | 'low' = 'low', order = 0, extra: Partial<ReturnType<typeof defaultActivityConfig>> = {}): Candidate => ({
    id,
    status: { active: true, weight: 'foreground', ...over },
    config: { ...defaultActivityConfig('music'), enabled: true, persistent: true, interrupt: true, priority, ...extra },
    order,
  });

  it('happening-now beats quiet, then band, then order', () => {
    expect(rankOf(cand('a', {}, 'low'))).toBeGreaterThan(rankOf(cand('b', { weight: 'background' }, 'high')));
    expect(rankOf(cand('a', {}, 'high'))).toBeGreaterThan(rankOf(cand('b', {}, 'medium')));
    expect(rankOf(cand('a', {}, 'low', 0))).toBeGreaterThan(rankOf(cand('b', {}, 'low', 3)));
  });

  it('music → download → Claude permission → back to download (spec section 17)', () => {
    const now = 1000;
    const music = cand('music', {}, 'low', 2);
    const download = cand('downloads', {}, 'medium', 1);
    const claudeIdle = cand('claude', { weight: 'background' }, 'high', 0);
    let c = choosePrimary([music], { selected: null, surfaces: [], now, dnd: false });
    expect(c.primary).toBe('music');
    c = choosePrimary([music, download, claudeIdle], { selected: null, surfaces: [], now, dnd: false });
    expect(c.primary).toBe('downloads');
    const claudeAsks = cand('claude', { urgent: { key: 'perm:1', level: 'maximum' } }, 'high', 0);
    c = choosePrimary([music, download, claudeAsks], { selected: null, surfaces: [], now, dnd: false });
    expect(c.primary).toBe('claude');
    expect(c.urgent).toBe(true);
    c = choosePrimary([music, download, claudeIdle], { selected: null, surfaces: [], now, dnd: false });
    expect(c.primary).toBe('downloads');
  });

  it('a surfaced event shows briefly unless do-not-disturb is on; interrupts need the setting', () => {
    const music = cand('music', {}, 'low');
    const battery = cand('battery', { weight: 'background' }, 'low', 1, { persistent: false });
    const surfaces = [{ id: 'battery', key: 'plug', until: 5000, level: 'expanded' as const, at: 900 }];
    expect(choosePrimary([music, battery], { selected: null, surfaces, now: 1000, dnd: false }).primary).toBe('battery');
    expect(choosePrimary([music, battery], { selected: null, surfaces, now: 1000, dnd: true }).primary).toBe('music');
    const noInterrupt = cand('timer', { urgent: { key: 'done', level: 'maximum' } }, 'low', 5, { interrupt: false });
    expect(choosePrimary([music, noInterrupt], { selected: null, surfaces: [], now: 1000, dnd: false }).urgent).toBe(false);
  });
});

describe('settings migration', () => {
  it('fills defaults, keeps saved values, repairs bad ones, knows every activity', () => {
    const s = migrate({ island: { anchor: 'sideways', edge: 500, widths: { compact: 0.3 } }, activities: { order: ['music', 'nope'], config: { music: { enabled: false, options: { pausedMinutes: 9 } } } } });
    expect(s.island.anchor).toBe('top');
    expect(s.island.edge).toBe(64);
    expect(s.island.widths.compact).toBe(0.3);
    expect(s.island.widths.expanded).toBeGreaterThan(0.3);
    expect(s.activities.order[0]).toBe('music');
    expect(s.activities.order).not.toContain('nope');
    expect(s.activities.order).toContain('claude');
    expect(s.activities.config.music.enabled).toBe(false);
    expect(s.activities.config.music.options.pausedMinutes).toBe(9);
    expect(s.activities.config.music.options.showArt).toBe(true);
  });

  it('pill colour: black by default, any of the five kept, anything else back to black', () => {
    expect(migrate({}).island.color).toBe('black');
    for (const c of ['white', 'matte-white', 'matte-black', 'glass']) expect(migrate({ island: { color: c } }).island.color).toBe(c);
    // 0.2.4's names carry over.
    expect(migrate({ island: { color: 'silver' } }).island.color).toBe('matte-white');
    expect(migrate({ island: { color: 'blur' } }).island.color).toBe('matte-black');
    expect(migrate({ island: { color: 'pink' } }).island.color).toBe('black');
  });

  it('a white accent turns dark on a white or matte white pill only', () => {
    const island = (color: string) => ({ ...migrate({ island: { color, accent: 'white' } }).island });
    expect(accentColor(island('black'))).toBe('#ffffff');
    expect(accentColor(island('glass'))).toBe('#ffffff');
    expect(accentColor(island('white'))).toBe('#1c1c1e');
    expect(accentColor(island('matte-white'))).toBe('#1c1c1e');
  });
});

describe('time text ticks in place', () => {
  it('recognises clocks, counters and percentages, not words', () => {
    for (const t of ['0:52', '1:37 / 5:12', '12m 43s', '84%', '4.1M', '9:41 PM']) expect(timeLike(t)).toBe(true);
    for (const t of ['Working…', 'Your turn', 'in 10m', 'SICKO MODE']) expect(timeLike(t)).toBe(false);
  });
});
