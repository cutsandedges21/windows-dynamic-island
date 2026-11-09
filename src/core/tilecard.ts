// A hover card for an activity that has none of its own: its Control Center
// tile, laid out as a card that grows out of the pill (Activities > Grows > Card).

import type { Block, Tile } from './sheet';

export function tileCard(tile: Tile, name: string, icon: string): Block[] {
  const b = tile.body;
  const pct = (v: number) => `${Math.round(v)}%`;
  switch (b.k) {
    case 'stat':
      return [
        { t: 'head', key: 'head', icon: b.icon, tone: tile.tone, title: b.value, sub: b.label },
        ...(b.progress != null ? [{ t: 'meter', key: 'bar', label: b.label, value: b.progress, text: b.value, sub: b.sub, tone: tile.tone } as Block] : []),
        ...(b.progress == null && b.sub ? [{ t: 'text', key: 'sub', text: b.sub, tone: 'muted', size: 'sm' } as Block] : []),
      ];
    case 'battery':
      return [
        { t: 'head', key: 'head', icon: 'battery', tone: tile.tone, title: pct(b.pct), sub: b.head },
        { t: 'meter', key: 'bar', label: b.head, value: b.pct / 100, text: pct(b.pct), sub: b.sub, tone: tile.tone },
      ];
    case 'media': {
      // Island's player (player.ts) takes its buttons' actions by name; none (not interactive): no buttons.
      const act = (key: string) => b.buttons.find((x) => x.key === key)?.action ?? '';
      return [{ t: 'player', key: 'player', art: b.art ?? null, title: b.title, artist: b.artist, playing: b.playing, position: null, duration: null, color: null, actions: { prev: act('prev'), toggle: act('toggle'), next: act('next') } }];
    }
    case 'week':
      return [{ t: 'head', key: 'head', icon, tone: tile.tone, title: b.title, sub: b.sub }];
    case 'dots':
      return [
        { t: 'head', key: 'head', icon, tone: tile.tone, title: b.label, sub: b.sub },
        { t: 'meter', key: 'bar', label: b.label, value: b.pct / 100, text: pct(b.pct), tone: tile.tone },
      ];
    case 'forecast':
      return [
        { t: 'head', key: 'head', icon: b.icon, tone: tile.tone, title: b.temp, sub: b.label },
        ...(b.hours.length ? [{ t: 'stats', key: 'hours', items: b.hours.map((h) => ({ key: h.t, label: h.t, value: h.temp })) } as Block] : []),
      ];
    case 'actions':
      return [
        { t: 'head', key: 'head', icon: b.icon ?? icon, tone: tile.tone, title: b.label, sub: b.sub },
        ...(b.buttons.length ? [{ t: 'buttons', key: 'buttons', items: b.buttons } as Block] : []),
      ];
    case 'list':
      return [
        { t: 'head', key: 'head', icon: b.icon, tone: tile.tone, title: b.label || name },
        b.rows.length ? { t: 'rows', key: 'rows', items: b.rows } : { t: 'text', key: 'empty', text: b.empty ?? 'Nothing here', tone: 'muted', size: 'sm' },
      ];
  }
}
