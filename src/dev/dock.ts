// Browser preview only: the taskbar (/?dock), drawn from a made-up frame as the island would send it.
// /?dock=charging and /?dock=low show the battery's other looks; &hide=clock,arrow takes items off;
// &look=white (or matte-black, matte-white, glass) picks its colour; &styles=rise,spotlight,glide the
// styles on; &edge=1 blends it into the bottom, &melt=1 melts its ends; &side=left (right, top) moves
// it; &border=1 draws the screen border round the page; &gap=180 leaves room for a 180px island on top.

import type { DockFrame } from '../core/dock';
import type { emitLocal as EmitLocal } from '../core/native';
import { cleanNames, DOCK_ITEMS, DOCK_STYLES, FRAME_W, type DockItem, type DockSide, type DockSize, type DockStyle, type PillColor } from '../core/settings';

export function dockPreview(emitLocal: typeof EmitLocal): void {
  const q = new URLSearchParams(location.search);
  const mode = q.get('dock') ?? '';
  const hide = (q.get('hide') ?? '').split(',').filter((k): k is DockItem => (DOCK_ITEMS as readonly string[]).includes(k));
  const app = (key: string, name: string, open: boolean, front = false) => ({ key, name, icon: null, windows: open ? [1] : [], front, pinned: true });
  const frame: DockFrame = {
    apps: [app('code', 'Visual Studio Code', true, true), app('chrome', 'Chrome', true), app('spotify', 'Spotify', true), app('explorer', 'File Explorer', false)],
    music: { title: 'Blinding Lights', artist: 'The Weeknd', playing: mode !== 'paused', art: null },
    timer: '4:32',
    claude: { session: 42, week: 18 },
    battery: { percent: mode === 'low' ? 9 : 76, charging: mode === 'charging' },
    muted: false,
    wifi: true,
    hidden: hide,
    accent: '#6aa6e8',
    color: (q.get('look') as PillColor | null) ?? 'black',
    glass: 50,
    // &scale=1.2 its own height, &minlen=900 stretched longer (Edit position); &edit=1 starts editing.
    scale: q.has('scale') ? Number(q.get('scale')) : null,
    minLen: Number(q.get('minlen') ?? 0),
    size: (q.get('size') as DockSize | null) ?? 'medium',
    styles: q.has('styles') ? (q.get('styles') ?? '').split(',').filter((k): k is DockStyle => (DOCK_STYLES as readonly string[]).includes(k)) : ['rise'],
    // &names=serif,plain,bold: the names' font, look, and bold (style Names).
    names: cleanNames({ font: (q.get('names') ?? '').split(',')[0], look: (q.get('names') ?? '').split(',')[1], bold: (q.get('names') ?? '').includes('bold') }),
    edge: q.get('edge') === '1',
    melt: q.get('melt') === '1',
    side: (q.get('side') as DockSide | null) ?? 'bottom',
    border: q.get('border') === '1' ? FRAME_W : 0,
    gap: q.has('gap') ? Number(q.get('gap')) : null,
  };
  document.documentElement.classList.add('dock-preview');
  if (frame.border && !q.has('frame')) {
    const f = document.createElement('div');
    f.className = 'dock-preview-frame';
    document.body.append(f);
  }
  if (frame.gap) {
    // A stand-in for the island in the gap.
    const pill = document.createElement('div');
    pill.style.cssText = `position:fixed;top:0;left:50%;width:${frame.gap}px;height:37px;margin-left:${-frame.gap / 2}px;border-radius:0 0 18px 18px;background:#040405;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);z-index:5`;
    document.body.append(pill);
    // As dock.rs does with the window: the gap's middle on the screen's middle.
    setInterval(() => {
      const bar = document.querySelector<HTMLElement>('.dock');
      const gap = document.querySelector<HTMLElement>('.dk-gap');
      if (!bar || !gap || gap.hidden) return;
      const b = bar.getBoundingClientRect();
      const g = gap.getBoundingClientRect();
      const shift = innerWidth / 2 - (g.left + g.width / 2);
      if (Math.abs(shift) > 0.5) bar.style.left = `${b.left + shift}px`;
      bar.style.transform = 'none';
    }, 200);
  }
  // The dock window asks for its frame once it is ready; send it then, and again in case it was early.
  setTimeout(() => emitLocal('dock-frame', frame), 300);
  setTimeout(() => emitLocal('dock-frame', frame), 1200);
  // &open=1: the island open in the gap (the bar keeps only its apps and the clock).
  if (q.get('edit') === '1') setTimeout(() => emitLocal('dock-edit', true), 1400);
  if (frame.gap && q.get('open') === '1') setTimeout(() => emitLocal('dock-gap', { w: frame.gap, open: true }), 1500);
}
