// Browser preview only: the taskbar (/?dock), drawn from a made-up frame as the island would send it.
// /?dock=charging and /?dock=low show the battery's other looks; &hide=clock,start takes items off;
// &look=white (or matte-black, matte-white, glass) picks its colour.

import type { DockFrame } from '../core/dock';
import type { emitLocal as EmitLocal } from '../core/native';
import { DOCK_ITEMS, type DockItem, type PillColor } from '../core/settings';

export function dockPreview(emitLocal: typeof EmitLocal): void {
  const q = new URLSearchParams(location.search);
  const mode = q.get('dock') ?? '';
  const hide = (q.get('hide') ?? '').split(',').filter((k): k is DockItem => (DOCK_ITEMS as readonly string[]).includes(k));
  const app = (key: string, name: string, open: boolean, front = false) => ({ key, name, icon: null, windows: open ? [1] : [], front, pinned: true });
  const frame: DockFrame = {
    apps: [app('code', 'Visual Studio Code', true, true), app('chrome', 'Chrome', true), app('spotify', 'Spotify', true), app('explorer', 'File Explorer', false)],
    music: { title: 'Blinding Lights', artist: 'The Weeknd', playing: mode !== 'paused', art: null },
    timer: '4:32',
    battery: { percent: mode === 'low' ? 9 : 76, charging: mode === 'charging' },
    muted: false,
    wifi: true,
    hidden: hide,
    accent: '#6aa6e8',
    color: (q.get('look') as PillColor | null) ?? 'black',
    glass: 50,
    locked: false,
  };
  document.documentElement.classList.add('dock-preview');
  // The dock window asks for its frame once it is ready; send it then, and again in case it was early.
  setTimeout(() => emitLocal('dock-frame', frame), 300);
  setTimeout(() => emitLocal('dock-frame', frame), 1200);
}
