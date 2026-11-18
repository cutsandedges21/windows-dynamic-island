// Browser preview only: the screen border (/?frame), drawn from a made-up frame as the island would
// send it. &dock&edge=1&melt=1&border=1 puts the taskbar on it too; &look=white (or matte-black,
// matte-white, glass) its colour; &sites=bottom-left and &shelf=bottom-right place the notches (off:
// none); &size=small|medium|large their size; &out=sites,shelf slides them out; &glow=claude runs
// the light round everything; &island=1 puts a stand-in island on top.

import { FRAME_W, type NotchCorner, type NotchSize, type PillColor } from '../core/settings';
import type { emitLocal as EmitLocal } from '../core/native';
import { meltMasks } from '../core/dock';
import type { FrameFrame, FramePart } from '../core/frame';
import type { Tone } from '../core/segments';

const SITES = [
  { url: 'https://github.com', title: 'GitHub' },
  { url: 'https://www.youtube.com', title: 'YouTube' },
  { url: 'https://mail.google.com', title: 'Gmail' },
  { url: 'https://claude.ai', title: 'Claude' },
];

/** The island's melted ends, as frame.ts draws them for the light (ISLAND_MELT in island.ts). */
const ISLAND = { w: 200, h: 37, melt: { out: 30, up: 22 } };

export function framePreview(emitLocal: typeof EmitLocal): void {
  const q = new URLSearchParams(location.search);
  const corner = (k: string, d: NotchCorner) => (q.get(k) === 'off' ? null : ((q.get(k) as NotchCorner | null) ?? d));
  const size = (q.get('size') as NotchSize | null) ?? 'small';
  const sitesAt = corner('sites', 'bottom-left');
  const shelfAt = corner('shelf', 'bottom-right');
  const glow = q.get('glow');
  const frame: FrameFrame = {
    width: FRAME_W,
    color: (q.get('look') as PillColor | null) ?? 'black',
    glass: 50,
    accent: '#6aa6e8',
    reduce: false,
    sites: { on: Boolean(sitesAt), corner: sitesAt ?? 'bottom-left', size, list: SITES },
    shelf: {
      on: Boolean(shelfAt),
      corner: shelfAt ?? 'bottom-right',
      size,
      files: [
        { path: 'C:\\a\\notes.pdf', name: 'notes.pdf', thumb: null, dir: false, missing: false },
        { path: 'C:\\a\\photos', name: 'photos', thumb: null, dir: true, missing: false },
      ],
      undo: false,
    },
    glow: glow ? { spec: { tone: glow as Tone, motion: (q.get('motion') as 'orbit' | 'still' | null) ?? 'orbit' }, speed: 'medium' } : null,
  };
  document.documentElement.classList.add('frame-preview');
  const send = () => {
    emitLocal('frame-screen', { width: innerWidth, height: innerHeight });
    emitLocal('frame-frame', frame);
  };
  setTimeout(send, 300);
  setTimeout(send, 1300);
  if (q.has('out'))
    setTimeout(() => {
      for (const k of (q.get('out') ?? '').split(',')) document.querySelector(`.notch.n-${k}`)?.classList.add('out');
    }, 1500);
  if (q.get('island') === '1') {
    // A stand-in for the island blended into the top, its ends melted into the border.
    const pill = document.createElement('div');
    const m = meltMasks('top', ISLAND.melt.out, ISLAND.melt.up, FRAME_W);
    pill.className = 'fp-island';
    pill.style.cssText = `position:fixed;top:0;left:50%;width:${ISLAND.w}px;height:${ISLAND.h}px;margin-left:${-ISLAND.w / 2}px;z-index:5`;
    const bg = document.createElement('i');
    bg.style.cssText = `position:absolute;top:0;bottom:0;left:${-ISLAND.melt.out}px;right:${-ISLAND.melt.out}px;background:var(--pill);-webkit-mask:${m.fill};mask:${m.fill}`;
    pill.append(bg);
    document.body.append(pill);
    const part: FramePart = {
      rect: [window.screenX + innerWidth / 2 - ISLAND.w / 2, window.screenY, ISLAND.w, ISLAND.h],
      side: 'top',
      zoom: 1,
      melt: ISLAND.melt,
      thick: ISLAND.h,
      radius: 18,
    };
    setTimeout(() => emitLocal('frame-island', [part]), 1400);
  }
}
