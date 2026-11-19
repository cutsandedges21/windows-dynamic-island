import { describe, expect, it } from 'vitest';
import { meltEnds, meltMasks } from '../src/core/dock';
import { barOutline, faviconOf, notchTop, sideOf } from '../src/core/frame';
import { defaultSettings, frameAvailable, frameOn, migrate, notchesOn, siteOf } from '../src/core/settings';

describe('screen border', () => {
  it('is only offered while the taskbar and the island both sit on their edges', () => {
    const s = defaultSettings().island;
    expect(frameAvailable(s)).toBe(false);
    s.blend = true;
    s.taskbar.on = true;
    expect(frameAvailable(s)).toBe(false);
    s.taskbar.edge = true;
    expect(frameAvailable(s)).toBe(true);
    expect(frameOn(s)).toBe(false);
    s.frame.on = true;
    expect(frameOn(s)).toBe(true);
    s.blend = false;
    expect(frameOn(s)).toBe(false);
  });

  it('lets the notches run without it', () => {
    const s = defaultSettings().island;
    s.frame.shelf.on = true;
    expect(frameOn(s)).toBe(false);
    expect(notchesOn(s)).toBe(true);
  });

  it('starts off, Websites bottom left and the Shelf bottom right, both small and off, the light on the island', () => {
    const s = migrate({ version: 6, island: {} }).island;
    expect(s.frame).toEqual({ on: false, glow: 'island', sites: { on: false, corner: 'bottom-left', size: 'small', at: null, free: false }, shelf: { on: false, corner: 'bottom-right', size: 'small', at: null, free: false } });
    expect(notchesOn(s)).toBe(false);
    expect(s.sites).toEqual([]);
    expect(s.taskbar.side).toBe('bottom');
  });

  it('keeps what was saved and drops junk', () => {
    const s = migrate({
      version: 6,
      island: {
        taskbar: { side: 'left' },
        frame: { on: true, glow: 'screen', sites: { on: false, corner: 'top-right', size: 'large', at: { side: 'right', y: 0.4 }, free: true }, shelf: { on: true, corner: 'nowhere', size: 'huge', at: { side: 'up', y: 2 } } },
        sites: [{ url: 'github.com', title: 'GitHub' }, { url: 'javascript:alert(1)' }, { url: 'github.com' }, 'x'],
      },
    }).island;
    expect(s.taskbar.side).toBe('left');
    expect(s.frame.glow).toBe('screen');
    expect(s.frame.sites).toEqual({ on: false, corner: 'top-right', size: 'large', at: { side: 'right', y: 0.4 }, free: true });
    expect(s.frame.shelf).toEqual({ on: true, corner: 'bottom-right', size: 'small', at: null, free: false });
    expect(s.sites).toEqual([{ url: 'https://github.com/', title: 'GitHub' }]);
    expect(migrate({ version: 6, island: { taskbar: { side: 'middle' } } }).island.taskbar.side).toBe('bottom');
  });
});

describe('pinned websites', () => {
  it('takes a link as typed or pasted', () => {
    expect(siteOf('github.com')).toEqual({ url: 'https://github.com/', title: 'github.com' });
    expect(siteOf('  https://www.youtube.com/watch?v=1 more')).toEqual({ url: 'https://www.youtube.com/watch?v=1', title: 'youtube.com' });
    expect(siteOf('http://localhost:5173', 'Dev')).toEqual({ url: 'http://localhost:5173/', title: 'Dev' });
  });

  it('turns down what is not a web address', () => {
    expect(siteOf('')).toBeNull();
    expect(siteOf('hello')).toBeNull();
    expect(siteOf('javascript:alert(1)')).toBeNull();
    expect(siteOf('file:///C:/x.txt')).toBeNull();
  });

  it('gets each site its icon by its name', () => {
    expect(faviconOf('https://mail.google.com/x')).toBe('https://www.google.com/s2/favicons?domain=mail.google.com&sz=64');
    expect(faviconOf('nope')).toBe('');
  });
});

describe('notches', () => {
  it('come out of the side their corner names', () => {
    expect(sideOf('top-left')).toBe('left');
    expect(sideOf('bottom-right')).toBe('right');
  });

  it('sit near their corner, stacked outward when two share it', () => {
    expect(notchTop('top-left', 1080, 200, 0)).toBe(28);
    expect(notchTop('top-left', 1080, 200, 214)).toBe(28 + 214);
    expect(notchTop('bottom-right', 1080, 200, 0)).toBe(1080 - 28 - 200);
    expect(notchTop('bottom-right', 1080, 200, 214)).toBe(1080 - 28 - 214 - 200);
  });
});

describe('melted ends on the border', () => {
  it('flatten onto the border instead of the screen edge', () => {
    const e = meltEnds(72, 34, 3);
    const path = decodeURIComponent(e.left.fill);
    expect(path).toContain('M0 49A72 31 0 0 0 72 18');
    // the border's strip under the foot is part of the shape
    expect(path).toContain('L90 52L0 52Z');
    expect(decodeURIComponent(meltEnds(72, 34).left.fill)).toContain('M0 52A72 34 0 0 0 72 18L72 18A18 18 0 0 1 90 0L90 52Z');
  });

  it('turn to the bar side, the feet at its ends along the edge', () => {
    const left = meltMasks('left', 72, 34);
    expect(left.end).toBe(90);
    expect(left.fill).toContain('left top / 100% 90px');
    expect(left.fill).toContain('left bottom / 100% 90px');
    expect(left.rim).toContain('right center / 1px');
    expect(decodeURIComponent(left.fill.split('"')[1])).toContain("width='52' height='90'");
    expect(decodeURIComponent(left.fill.split('"')[1])).toContain('matrix(0 1 -1 0 52 0)');
    const top = meltMasks('top', 72, 34);
    expect(top.fill).toContain('left top / 90px 100%');
    expect(top.rim).toContain('center bottom /');
    expect(meltMasks('bottom', 72, 34).rim).toContain('center top /');
  });

  it("outline a bar for the light's path, feet and all", () => {
    expect(barOutline(100, 52, 18, null, 3)).toBe('M0 52L0 18A18 18 0 0 1 18 0L82 0A18 18 0 0 1 100 18L100 52Z');
    const melted = barOutline(100, 52, 18, { out: 72, up: 34 }, 3);
    expect(melted.startsWith('M-72 49A72 31 0 0 0 0 18')).toBe(true);
    expect(melted).toContain('L100 18A72 31 0 0 0 172 49L172 52L-72 52Z');
  });
});
