// Browser preview only: the taskbar (/?dock), drawn from a made-up frame as the island would send it.
// /?dock=charging and /?dock=low show the battery's other looks; &hide=clock,arrow takes items off;
// &look=white (or matte-black, matte-white, glass) picks its colour; &styles=rise,spotlight,glide the
// styles on; &edge=1 blends it into the bottom, &melt=1 melts its ends; &side=left (right, top) moves
// it; &border=1 draws the screen border round the page; &gap=180 leaves room for a 180px island on top.

import { foldApps, moveSlot, unfoldApp, type DockAct, type DockFrame } from '../core/dock';
import { on, type emitLocal as EmitLocal } from '../core/native';
import { barOrder, cleanNames, DOCK_ITEMS, DOCK_STYLES, FRAME_W, type DockItem, type DockSide, type DockSize, type DockStyle, type PillColor } from '../core/settings';

export function dockPreview(emitLocal: typeof EmitLocal): void {
  const q = new URLSearchParams(location.search);
  const mode = q.get('dock') ?? '';
  const hide = (q.get('hide') ?? '').split(',').filter((k): k is DockItem => (DOCK_ITEMS as readonly string[]).includes(k));
  // Each app a coloured square with its initial, as an icon.
  const ico = (c: string, t: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='11' fill='${c}'/><text x='24' y='32' font-family='Segoe UI,sans-serif' font-size='24' font-weight='700' fill='#fff' text-anchor='middle'>${t}</text></svg>`)}`;
  const app = (key: string, name: string, open: boolean, front = false, c = '#666') => ({ key, name, icon: q.get('icons') === '0' ? null : ico(c, name[0]), windows: open ? [1] : [], front, pinned: true });
  const frame: DockFrame = {
    // &unpinned=2: the last two open but not pinned (a short line before them). &more=1: four more apps.
    apps: [
      app('code', 'Visual Studio Code', true, true, '#2f80ed'),
      app('chrome', 'Chrome', true, false, '#e0a526'),
      app('spotify', 'Spotify', true, false, '#1db954'),
      app('explorer', 'File Explorer', false, false, '#d9a441'),
      ...(q.get('more') === '1' ? [app('discord', 'Discord', false, false, '#5865f2'), app('notion', 'Notion', false, false, '#333'), app('figma', 'Figma', true, false, '#a259ff'), app('slack', 'Slack', false, false, '#4a154b')] : []),
    ].map((a, i, all) => ({ ...a, pinned: i < all.length - Number(q.get('unpinned') ?? 0) })),
    // &folder=1: Chrome and Spotify in a folder named Fun.
    folders: q.get('folder') === '1' ? [{ id: 'f1', name: 'Fun', apps: ['chrome', 'spotify'] }] : [],
    music: { title: 'Blinding Lights', artist: 'The Weeknd', playing: mode !== 'paused', art: q.get('art') },
    timer: '4:32',
    claude: { session: 42, week: 18 },
    battery: { percent: mode === 'low' ? 9 : 76, charging: mode === 'charging' },
    muted: false,
    volume: 0.5,
    wifi: true,
    hidden: hide,
    // &accent=43c2c0: its accent colour (hex, no #).
    accent: q.has('accent') ? `#${q.get('accent')}` : '#6aa6e8',
    color: (q.get('look') as PillColor | null) ?? 'black',
    glass: 50,
    // &scale=1.2 its own height, &minlen=900 stretched longer (Edit position); &edit=1 starts editing.
    scale: q.has('scale') ? Number(q.get('scale')) : null,
    minLen: Number(q.get('minlen') ?? 0),
    // &order=clock,apps,...: its items in that order (the rest after, as Settings keeps them).
    order: q.has('order') ? barOrder((q.get('order') ?? '').split(',')) : undefined,
    // &tall=20: stretched taller by its top (Edit position).
    tall: Number(q.get('tall') ?? 0),
    size: (q.get('size') as DockSize | null) ?? 'medium',
    styles: q.has('styles') ? (q.get('styles') ?? '').split(',').filter((k): k is DockStyle => (DOCK_STYLES as readonly string[]).includes(k)) : ['rise'],
    // &names=serif,plain,bold: the names' font, look, and bold (style Names).
    names: cleanNames({ font: (q.get('names') ?? '').split(',')[0], look: (q.get('names') ?? '').split(',')[1], bold: (q.get('names') ?? '').includes('bold') }),
    // &fill=1: filling the width; &square=1 with &edge=1: square on the edge.
    fill: q.get('fill') === '1',
    square: q.get('square') === '1',
    // &border=1 is the screen border's; &accentborder=1: Accent's black line round each icon.
    accentBorder: q.get('accentborder') === '1',
    songTint: q.get('songtint') !== '0',
    barTint: q.get('bartint') === '1',
    edgeTint: q.get('edgetint') === '1',
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
  // What the island does with a drag, a fold, a rename: the same functions, on this made-up frame.
  void on<DockAct>('dock-act', (a) => {
    const pins = frame.apps.filter((x) => x.pinned).map((x) => ({ name: x.name, target: x.key }));
    const folders = frame.folders ?? [];
    const c =
      a.kind === 'move' ? moveSlot(pins, frame.apps, folders, a.key, a.to)
      : a.kind === 'fold' ? foldApps(pins, frame.apps, folders, a.key, a.onto, `f${Date.now()}`)
      : a.kind === 'unfold' ? unfoldApp(pins, folders, a.key)
      : a.kind === 'folder-name' ? { pins: null, folders: folders.map((f) => (f.id === a.id ? { ...f, name: a.name } : f)) }
      : a.kind === 'ungroup' ? { pins: null, folders: folders.filter((f) => f.id !== a.id) }
      : null;
    if (!c) return;
    const byKey = new Map(frame.apps.map((x) => [x.key, x] as const));
    if (c.pins) {
      const pinned = c.pins.map((p) => ({ ...byKey.get(p.target)!, pinned: true }));
      frame.apps = [...pinned, ...frame.apps.filter((x) => !c.pins!.some((p) => p.target === x.key)).map((x) => ({ ...x, pinned: false }))];
    }
    if (c.open) frame.apps = [...frame.apps.filter((x) => x.pinned), ...c.open.map((k) => byKey.get(k)!)];
    if (c.folders) frame.folders = c.folders;
    emitLocal('dock-frame', { ...frame });
  });
  // The dock window asks for its frame once it is ready; send it then, and again in case it was early.
  setTimeout(() => emitLocal('dock-frame', frame), 300);
  setTimeout(() => emitLocal('dock-frame', frame), 1200);
  // &open=1: the island open in the gap (the bar keeps only its apps and the clock).
  // Three tray icons, as trayhost.rs sends them.
  const dot = (c: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${c}'/></svg>`)}`;
  // Island shown on the taskbar; the rest behind the arrow, as Windows keeps them.
  const hiddenTray = ['OneDrive', 'Discord', 'Steam', 'Spotify', 'Zoom', 'ShareX', 'Windhawk'].map((tip, i) => ({ key: `h${i}`, tip, icon: dot(['#3b82f6', '#5865f2', '#1b2838', '#1db954', '#2d8cff', '#d23b3b', '#7c5cff'][i]), pinned: false }));
  setTimeout(() => emitLocal('tray-icons', [{ key: 'a', tip: 'Island', icon: dot('#e8845f'), pinned: true }, ...hiddenTray]), 1300);
  if (q.get('edit') === '1') setTimeout(() => emitLocal('dock-edit', true), 1400);
  if (frame.gap && q.get('open') === '1') setTimeout(() => emitLocal('dock-gap', { w: frame.gap, open: true }), 1500);
}
