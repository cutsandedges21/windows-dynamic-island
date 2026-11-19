// Browser preview of desktop widgets: /?widget=weather|timer|clock|music draws one the way its
// window would, with a pretend tile.

import { emitLocal } from '../core/native';
import { runWidget, type WidgetFrame } from '../core/widgets';
import type { Tile } from '../core/sheet';

const TILES: Record<string, Tile> = {
  weather: { key: 'weather/weather', span: 2, rows: 1, body: { k: 'forecast', icon: 'sun', temp: '14°', label: 'Sunny · Toronto', hours: [{ t: '3 PM', icon: 'sun', temp: '15°' }, { t: '4 PM', icon: 'sun', temp: '14°' }, { t: '5 PM', icon: 'sun', temp: '12°' }] } },
  timer: { key: 'timer/timer', span: 2, rows: 1, body: { k: 'actions', icon: 'timer', label: 'Focus timer', sub: '25:00', buttons: [{ key: 'go', icon: 'play', action: 'act:timer:start', style: 'primary' }] } },
  system: { key: 'system/cpu', span: 2, rows: 1, body: { k: 'dots', label: 'CPU', pct: 31, sub: '61°' } },
  music: { key: 'music/music', span: 2, rows: 2, tint: new URLSearchParams(location.search).get('tint') ?? 'hsl(200 70% 55%)', body: { k: 'media', title: 'Neon Harbor', artist: 'Kavi Rao', playing: true, progress: 0.4, buttons: [{ key: 'p', icon: 'pause', action: 'act:music:toggle', style: 'secondary' }] } },
};

export function widgetPreview(stage: HTMLElement): void {
  const kind = new URLSearchParams(location.search).get('widget') || 'weather';
  document.body.style.background = 'linear-gradient(160deg,#e8643c,#4a1230)';
  void runWidget(stage, 'widget-preview').then(() => {
    const f: WidgetFrame = { kind, tile: kind === 'clock' ? null : (TILES[kind] ?? TILES.weather), accent: '#ff8a3d', color: 'black', reduce: false, locked: false, sizes: [], size: '', idle: null };
    emitLocal('widget-frame-preview', f);
  });
}
