import { describe, expect, it } from 'vitest';
import type { MirrorFrame } from '../src/core/mirror';
import { actionsIn, readIslandMsg } from '../src/remote/protocol';
import { demoHello, demoPill, demoView, initialDemo } from '../phone/web/src/dev/demo-data';
import { fileSize, lastSeenText, linkIn, retryText } from '../phone/web/src/format';
import { BOT_GAP, PILL_MARGIN, lyingHeight, maxPillWidth, phonePill, placePill } from '../phone/web/src/pill-fit';

const measure = (t: string) => t.length * 7;

describe('the pill on a phone', () => {
  it('lays the frame out again for the room the phone has, folding chips into +N', () => {
    const d = { ...initialDemo(0), ask: { id: 'r', at: 0 }, timer: { label: 'Timer', until: 60_000, total: 60_000, pausedLeft: null } };
    const frame = demoPill(d, 0).frame;
    expect(frame.w).toBeGreaterThan(600);
    const p = phonePill(frame, 250, measure);
    expect(p.w).toBe(250);
    expect(p.h).toBe(frame.h);
    expect(p.placed.map((x) => x.seg.key)).toContain('claude/perm-ask');
    const more = p.placed.find((x) => x.seg.key === 'island/more')?.seg;
    expect(more?.t === 'chip' && more.label).toMatch(/^\+\d$/);
    expect(more?.t === 'chip' && more.action).toBe('island:overflow');
    // A pill that fits stays as wide as the PC's.
    const compact = demoPill(initialDemo(0), 0).frame;
    expect(phonePill(compact, 400, measure).w).toBe(compact.w);
  });

  it('lays a standing pill down, and keeps the bot on screen', () => {
    const standing = { ...demoPill(initialDemo(0), 0).frame, orient: 'vertical', w: 40, h: 130 } as MirrorFrame;
    expect(phonePill(standing, 300, measure).h).toBe(lyingHeight(40));
    expect(lyingHeight(72)).toBe(50);
    const at = placePill(390, maxPillWidth(390, 36), 36, 36);
    expect(at.bot!.x).toBeGreaterThanOrEqual(PILL_MARGIN);
    expect(at.pill.x + at.pill.w).toBeLessThanOrEqual(390 - PILL_MARGIN);
    expect(placePill(390, 184, 36, 36).pill.x).toBe(Math.round((390 - 184) / 2));
  });

  it('upright, puts the bot above the pill and centres both', () => {
    // The bot no longer takes room beside the pill.
    expect(maxPillWidth(320, 36, true)).toBe(320 - PILL_MARGIN * 2);
    expect(maxPillWidth(320, 36, false)).toBeLessThan(320 - PILL_MARGIN * 2);
    const at = placePill(320, 200, 36, 36, true);
    expect(at.bot).toEqual({ x: (320 - 36) / 2, y: 6, w: 36, h: 36 });
    expect(at.pill.x).toBe((320 - 200) / 2);
    expect(at.pill.y).toBe(at.bot!.y + 36 + BOT_GAP);
    // Without a bot, the pill keeps its place at the top.
    expect(placePill(320, 200, 36, null, true).pill.y).toBe(6);
  });
});

describe('the demo island speaks the protocol', () => {
  it('sends lines readIslandMsg accepts, with namespaced actions', () => {
    const d = initialDemo(Date.UTC(2026, 9, 22, 18));
    const now = d.posAt;
    const asking = { ...d, ask: { id: 'r1', at: now } };
    for (const m of [demoHello(), demoPill(d, now), demoPill(asking, now), demoView(d, { open: 'grid' }, 374, now), demoView(d, { open: 'card', id: 'claude' }, 374, now), demoView(asking, { open: 'grid' }, 374, now)]) {
      expect(readIslandMsg(JSON.parse(JSON.stringify(m)))).not.toBeNull();
    }
    const acts = [...actionsIn(demoView(d, { open: 'grid' }, 374, now).view)];
    expect(acts).toContain('act:music:toggle');
    expect(acts.every((a) => a.startsWith('act:'))).toBe(true);
    expect(demoView(asking, { open: 'grid' }, 374, now).urgent).toBe('claude');
  });
});

describe('words and numbers', () => {
  it('says when the PC was last seen, and the rest', () => {
    const now = new Date(2026, 9, 22, 18, 0).getTime();
    expect(lastSeenText(now - 30_000, now)).toBe('just now');
    expect(lastSeenText(new Date(2026, 9, 22, 14, 14).getTime(), now)).toMatch(/^2:14\sPM$/);
    expect(lastSeenText(new Date(2026, 9, 21, 9, 5).getTime(), now)).toMatch(/^yesterday 9:05\sAM$/);
    expect(lastSeenText(new Date(2026, 9, 1, 9, 5).getTime(), now)).toMatch(/^Oct 1, 9:05\sAM$/);
    expect(lastSeenText(null, now)).toBe('not seen yet');
    expect(retryText(now + 7_200, now)).toBe('Trying again in 8 s');
    expect(fileSize(2_400_000)).toBe('2.3 MB');
    expect(linkIn(' https://example.com/a ')).toBe('https://example.com/a');
    expect(linkIn('javascript:alert(1)')).toBeNull();
  });
});
