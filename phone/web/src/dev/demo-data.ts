// The demo island (?demo): what a PC running Island would send, built the way the island builds
// it. The pill is laid out with segments.ts at the PC's own pill size, the Control Center is
// packed with grid.ts and namespaced with mapActions like island.ts gridSheet/arrange do, and
// the cards copy the shapes the activities make (Claude's permission card, the player, the
// sessions list). No DOM, no timers: fake-link.ts drives it, the tests check it.

import { DEFAULT_WIDTHS, bubbleSize, heightFor, innerPadding, levelWidth, type Area, type Level } from '../../../../src/core/layout';
import type { GlowSpec } from '../../../../src/core/glow';
import { packGrid, pageCount, rowsUsed } from '../../../../src/core/grid';
import { MOMENT_LOOKS, MOOD_LOOKS } from '../../../../src/core/looks';
import type { MirrorFrame } from '../../../../src/core/mirror';
import { fitSegments, signature, type Seg } from '../../../../src/core/segments';
import { mapActions, type Block, type SheetView, type Tile } from '../../../../src/core/sheet';
import type { BotState, IslandMsg, Nav } from '../../../../src/remote/protocol';

/** The demo PC: a 1920×1080 laptop screen at 125 %, as the island sees it. */
const AREA: Area = { width: 1536, height: 864 };
const EDGE = 8;
export const DEMO_NAME = 'MossLaptop';

/** Album art: a sunset, as the island's own preview uses. */
const ART =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1a14"/><stop offset=".6" stop-color="#e2581c"/><stop offset="1" stop-color="#160c09"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="62" r="13" fill="#ffb36b"/></svg>',
  );

export const TRACKS = [
  { title: 'Midnight City', artist: 'M83', duration: 243 },
  { title: 'Roman to Integer - LeetCode #13', artist: 'CodingNinja', duration: 300 },
  { title: 'Nights', artist: 'Frank Ocean', duration: 307 },
] as const;

export interface DemoState {
  playing: boolean;
  track: number;
  /** Seconds into the track at `posAt` (epoch ms). */
  pos: number;
  posAt: number;
  /** Claude is working on a chat. */
  working: boolean;
  /** A permission request waiting for an answer (the urgent card). */
  ask: { id: string; at: number } | null;
  timer: { label: string; until: number; total: number; pausedLeft: number | null } | null;
  dnd: boolean;
  battery: number;
  /** Bumped by each new moment, so the bot replays it. */
  play: number;
  moment: keyof typeof MOMENT_LOOKS | null;
}

export function initialDemo(now: number): DemoState {
  return { playing: true, track: 0, pos: 96, posAt: now, working: true, ask: null, timer: null, dnd: false, battery: 72, play: 1, moment: null };
}

/** The second pretend PC (?demo&two): a quieter desk, so switching PCs visibly changes the island. */
export const DESKTOP_NAME = 'MossDesktop';

export function desktopDemo(now: number): DemoState {
  return { ...initialDemo(now), playing: false, track: 2, pos: 41, working: false, battery: 100 };
}

/** Seconds into the current track. */
export function position(d: DemoState, now: number): number {
  const dur = TRACKS[d.track].duration;
  const p = d.playing ? d.pos + (now - d.posAt) / 1000 : d.pos;
  return Math.max(0, Math.min(dur, p));
}

export const PERMISSION_MS = 108_000;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function timerLeft(d: DemoState, now: number): number {
  const t = d.timer;
  if (!t) return 0;
  return Math.max(0, t.pausedLeft ?? t.until - now);
}

// ---------------------------------------------------------------- the pill

function frame(level: Level, viewKey: string, segs: Seg[], glow: GlowSpec | null): MirrorFrame {
  const w = levelWidth(AREA, DEFAULT_WIDTHS, level, EDGE);
  const h = heightFor(level);
  const placed = fitSegments(segs, Math.max(40, w - innerPadding(h) * 2), h);
  return {
    sig: `horizontal|${viewKey}|${w}|${h}|${signature(placed)}`,
    swap: false,
    bump: false,
    placed,
    w,
    h,
    orient: 'horizontal',
    anchor: 'top',
    edge: EDGE,
    hidden: false,
    fsHide: false,
    fullscreen: null,
    glow,
    speed: 'medium',
    accent: '#e8845f',
    color: 'black',
    reduce: false,
    bot: { d: bubbleSize('medium') },
  };
}

function botFor(d: DemoState): BotState {
  if (d.moment) return { look: MOMENT_LOOKS[d.moment], play: d.play, strength: 0.7 };
  const look = d.ask ? MOMENT_LOOKS['claude-asks'] : d.playing ? MOOD_LOOKS.vibing : d.working ? MOOD_LOOKS.thinking : MOOD_LOOKS.idle;
  return { look, play: d.play, strength: 0.6 };
}

export function demoPill(d: DemoState, now: number): Extract<IslandMsg, { t: 'pill' }> {
  const track = TRACKS[d.track];
  if (d.ask) {
    // Urgent: the pill opens all the way and says what is asked; the others ride along as chips.
    const segs: Seg[] = [
      { t: 'icon', key: 'claude/perm-icon', icon: 'claude', tone: 'claude', anim: 'pulse', prio: 0 },
      { t: 'text', key: 'claude/perm-ask', text: 'Run this command?', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'claude/perm-title', text: 'island-phone', tone: 'muted', prio: 4, max: 200 },
      { t: 'chip', key: 'chip/music', label: track.title, icon: 'music', tone: d.playing ? 'accent' : 'muted', action: 'island:select', arg: 'music', side: 'end', prio: 6, max: 150, tip: `${track.title} · ${track.artist}` },
    ];
    if (d.timer) segs.push({ t: 'chip', key: 'chip/timer', label: clock(timerLeft(d, now) / 1000), icon: 'timer', action: 'island:select', arg: 'timer', side: 'end', prio: 7, max: 150 });
    return { t: 'pill', frame: frame('maximum', 'act:claude', segs, { tone: 'claude', motion: 'pulse' }), bot: botFor(d) };
  }
  const segs: Seg[] = [
    { t: 'art', key: 'music/art', src: ART, icon: 'music', prio: 3 },
    { t: 'bars', key: 'music/bars', active: d.playing, tone: 'accent', color: '#e2581c', side: 'end', prio: 2 },
  ];
  if (d.working) segs.push({ t: 'icon', key: 'chip/claude', icon: 'claude', tone: 'claude', size: 'sm', side: 'end', prio: 8, tip: 'Claude is working' });
  if (d.timer) segs.push({ t: 'icon', key: 'chip/timer', icon: 'timer', tone: 'accent', size: 'sm', side: 'end', prio: 9, tip: d.timer.label });
  const glow: GlowSpec | null = d.working ? { tone: 'claude', motion: 'orbit' } : null;
  return { t: 'pill', frame: frame('compact', 'act:music', segs, glow), bot: botFor(d) };
}

// ---------------------------------------------------------------- Control Center

/** An activity's tile, namespaced as island.ts gridSheet does. */
function tile(id: string, t: Tile): Tile {
  const [mapped] = mapActions([{ t: 'tiles', key: 'one', items: [t], cols: 1, rows: 1, pages: 1, cell: 0 }], (a) => (a.startsWith('island:') ? a : `act:${id}:${a}`));
  const items = mapped.t === 'tiles' ? mapped.items : [t];
  return { ...items[0], key: `${id}/${t.key}` };
}

function tiles(d: DemoState, now: number): Tile[] {
  const track = TRACKS[d.track];
  const day = new Date(now);
  const dayPct = ((day.getHours() * 60 + day.getMinutes()) / 1440) * 100;
  const week = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(now);
    x.setDate(day.getDate() - day.getDay() + i);
    return { label: x.toLocaleDateString('en-US', { weekday: 'narrow' }), num: x.getDate(), today: i === day.getDay(), busy: [0, 2, 1, 3, 1, 0, 1][i] };
  });
  const left = timerLeft(d, now);
  const timer: Tile = d.timer
    ? {
        key: 'timer',
        tone: d.timer.pausedLeft === null ? 'accent' : undefined,
        body: {
          k: 'actions',
          icon: 'timer',
          label: `${d.timer.label} ${clock(left / 1000)}`,
          sub: d.timer.pausedLeft === null ? 'Running' : 'Paused',
          buttons: [
            { key: 'toggle', icon: d.timer.pausedLeft === null ? 'pause' : 'play', action: 'toggle', style: 'secondary', tip: 'Pause' },
            { key: 'stop', icon: 'x', action: 'stop', style: 'ghost', tip: 'Stop' },
          ],
        },
      }
    : {
        key: 'timer',
        tone: 'accent',
        body: {
          k: 'actions',
          icon: 'timer',
          label: 'Timer',
          buttons: [
            { key: '5m', label: '5m', action: 'start', arg: 300_000, style: 'secondary', tip: '5 minutes' },
            { key: 'focus', icon: 'focus', action: 'focus', style: 'secondary', tip: 'Focus 25 minutes' },
          ],
        },
      };
  return [
    { key: 'island/day', tone: 'accent', body: { k: 'dots', label: day.toLocaleDateString('en-US', { weekday: 'long' }), pct: dayPct, sub: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } },
    tile('music', {
      key: 'music',
      span: 2,
      rows: 2,
      action: 'open',
      body: {
        k: 'media',
        art: ART,
        title: track.title,
        artist: track.artist,
        playing: d.playing,
        progress: Math.round((position(d, now) / track.duration) * 100) / 100,
        buttons: [
          { key: 'prev', icon: 'prev', action: 'prev', style: 'ghost', tip: 'Previous' },
          { key: 'toggle', icon: d.playing ? 'pause' : 'play', action: 'toggle', style: 'secondary', tip: d.playing ? 'Pause' : 'Play' },
          { key: 'next', icon: 'next', action: 'next', style: 'ghost', tip: 'Next' },
        ],
      },
    }),
    tile('battery', { key: 'battery', span: 2, body: { k: 'battery', pct: d.battery, charging: true, head: 'Charging', sub: '1 h 10 min to full' } }),
    tile('system', { key: 'cpu', body: { k: 'stat', icon: 'cpu', label: 'CPU', value: '37%', sub: 'RAM 65%', progress: 0.37 } }),
    tile('network', { key: 'network', body: { k: 'stat', icon: 'wifi', label: 'Network', value: '↓ 2.1 MB/s', sub: '↑ 180 KB/s' } }),
    tile('timer', timer),
    tile('weather', {
      key: 'weather',
      span: 2,
      body: {
        k: 'forecast',
        icon: 'cloud-sun',
        temp: '23°',
        label: 'Partly cloudy, Montreal',
        hours: [
          { t: '3 PM', icon: 'cloud-sun', temp: '23°' },
          { t: '4 PM', icon: 'cloud', temp: '22°' },
          { t: '5 PM', icon: 'cloud', temp: '21°' },
          { t: '6 PM', icon: 'rain', temp: '19°' },
        ],
      },
    }),
    tile('claude', {
      key: 'claude',
      span: 2,
      rows: 2,
      action: 'open',
      tone: 'claude',
      body: {
        k: 'list',
        icon: 'claude',
        label: 'Claude Code',
        rows: [
          { key: 's1', dot: d.ask ? 'warn' : 'claude', pulse: d.working || d.ask !== null, title: 'island-phone', detail: d.ask ? 'Needs you' : d.working ? 'Working · 4 min' : 'Finished', action: 'switch', arg: 's1' },
          { key: 's2', dot: 'good', title: 'degreepilot', detail: 'Finished · 12 min ago', action: 'switch', arg: 's2' },
        ],
      },
    }),
    tile('phone', {
      key: 'phone',
      span: 2,
      rows: 2,
      body: {
        k: 'list',
        icon: 'phone',
        label: 'Phone',
        rows: [
          { key: 'n1', icon: 'chat', title: 'Mom', detail: 'Are you coming home for dinner tonight?' },
          { key: 'n2', icon: 'chat', title: 'Lab group', detail: 'Physics report is due Friday' },
          { key: 'n3', icon: 'bell', title: 'sam.k', detail: 'liked your photo' },
        ],
      },
    }),
    tile('calendar', { key: 'week', span: 2, body: { k: 'week', title: 'Design review', sub: 'in 2 h', days: week } }),
    tile('land', {
      key: 'land',
      span: 2,
      body: {
        k: 'actions',
        icon: 'land',
        label: 'Land',
        sub: 'Send to your phone',
        buttons: [
          { key: 'text', icon: 'link', label: 'Link', action: 'demo-text', style: 'secondary', tip: 'Send a link to this phone' },
          { key: 'file', icon: 'file', label: 'File', action: 'demo-file', style: 'secondary', tip: 'Send a file to this phone' },
        ],
      },
    }),
  ];
}

/** Lists, cards and players take two columns at least (island.ts NARROW_OK). */
const NARROW_OK = new Set(['stat', 'actions', 'dots']);
/** Medium size: a row of the grid is this tall (island.ts CELL_PX). */
const CELL = 92;

function gridView(d: DemoState, now: number, width: number): SheetView {
  const all = tiles(d, now).map((t) => {
    const narrow = NARROW_OK.has(t.body.k);
    return { ...t, w: Math.min(4, narrow ? (t.span ?? 1) : Math.max(2, t.span ?? 1)), h: Math.min(4, t.rows ?? 1) };
  });
  const slots = packGrid(all.map((t) => ({ key: t.key, w: t.w, h: t.h })), 4, 4);
  const at = new Map(slots.map((s) => [s.key, s]));
  const items = all.flatMap((t): Tile[] => {
    const s = at.get(t.key);
    return s ? [{ ...t, page: s.page, col: s.col, row: s.row, w: s.w, h: s.h }] : [];
  });
  return { key: 'island/grid', wide: true, width, blocks: [{ t: 'tiles', key: 'grid', items, cols: 4, rows: rowsUsed(slots), pages: pageCount(slots), cell: CELL }] };
}

// ---------------------------------------------------------------- cards

function ns(id: string, view: SheetView): SheetView {
  return { ...view, key: `${id}/${view.key}`, blocks: mapActions(view.blocks, (a) => (a.startsWith('island:') ? a : `act:${id}:${a}`)) };
}

function permissionCard(d: DemoState): SheetView {
  const id = d.ask!.id;
  return ns('claude', {
    key: `perm:${id}`,
    blocks: [
      { t: 'head', key: 'h', icon: 'claude', tone: 'claude', title: 'Run this command?', sub: 'island-phone · Windows Terminal' },
      { t: 'code', key: 'detail', text: 'npm run build && npx vitest run test/phone-store.test.ts' },
      { t: 'text', key: 'why', text: 'Build the phone site and run its store tests', tone: 'muted', size: 'sm' },
      { t: 'input', key: 'deny-why', placeholder: 'Or tell Claude what to do instead…', action: `deny-with:${id}` },
      {
        t: 'buttons',
        key: 'answer',
        items: [
          { key: 'deny', label: 'Deny', icon: 'x', action: 'deny', arg: id, style: 'danger' },
          { key: 'allow', label: 'Allow', icon: 'check', action: 'allow', arg: id, style: 'primary' },
        ],
      },
      { t: 'countdown', key: 'left', until: d.ask!.at + PERMISSION_MS, total: PERMISSION_MS },
    ],
  });
}

function claudeCard(d: DemoState): SheetView {
  const blocks: Block[] = [
    { t: 'head', key: 'h', icon: 'claude', tone: 'claude', title: 'Claude Code', sub: '2 chats · Opus 5.5' },
    {
      t: 'rows',
      key: 'sessions',
      items: [
        { key: 's1', dot: 'claude', pulse: d.working, title: 'island-phone', detail: d.working ? 'Working · 4 min · Windows Terminal' : 'Finished · Windows Terminal', action: 'switch', arg: 's1', meter: { value: 0.42, text: '42%', tip: 'Context used' } },
        { key: 's2', dot: 'good', title: 'degreepilot', detail: 'Finished · 12 min ago · VS Code', action: 'switch', arg: 's2', button: { key: 'hide', icon: 'x', action: 'hide', arg: 's2', style: 'ghost', tip: 'Hide' } },
      ],
    },
    { t: 'meter', key: 'five', label: '5-hour limit', value: 0.38, pace: 0.5, text: '38%', sub: 'Resets 4:10 PM' },
    {
      t: 'stats',
      key: 'tokens',
      items: [
        { key: 'today', label: 'Today', value: '1.2M' },
        { key: 'week', label: 'This week', value: '8.4M' },
        { key: 'cost', label: 'Cost', value: '$4.20' },
      ],
    },
  ];
  return ns('claude', { key: 'open', blocks });
}

function musicCard(d: DemoState, now: number): SheetView {
  const track = TRACKS[d.track];
  return ns('music', {
    key: 'player',
    blocks: [
      {
        t: 'player',
        key: 'player',
        art: ART,
        title: track.title,
        artist: track.artist,
        playing: d.playing,
        position: Math.round(position(d, now)),
        duration: track.duration,
        color: '#e2581c',
        actions: { prev: 'prev', toggle: 'toggle', next: 'next', seek: 'seek' },
      },
    ],
  });
}

function plainCard(id: string, title: string, text: string): SheetView {
  return ns(id, { key: 'open', blocks: [{ t: 'head', key: 'h', icon: id === 'timer' ? 'timer' : 'spark', title }, { t: 'text', key: 't', text, tone: 'muted', size: 'sm' }] });
}

/** What the phone shows under its pill for `nav` (urgent first, as island.ts phoneView does). */
export function demoView(d: DemoState, nav: Nav, width: number, now: number): Extract<IslandMsg, { t: 'view' }> {
  if (d.ask) return { t: 'view', nav, view: permissionCard(d), urgent: 'claude' };
  let view: SheetView | null = null;
  if (nav.open === 'grid') view = gridView(d, now, width);
  else if (nav.open === 'card') {
    if (nav.id === 'claude') view = claudeCard(d);
    else if (nav.id === 'music') view = musicCard(d, now);
    else if (nav.id === 'timer') view = plainCard('timer', d.timer ? `${d.timer.label} ${clock(timerLeft(d, now) / 1000)}` : 'Timer', d.timer ? 'Counting down on your PC.' : 'No timer running.');
    else view = plainCard(nav.id, nav.id, 'Nothing more to show here.');
  }
  return { t: 'view', nav, view, urgent: null };
}

export function demoHello(name = DEMO_NAME): Extract<IslandMsg, { t: 'hello' }> {
  return { t: 'hello', v: 1, name, platform: 'windows', version: '0.3.1', allow: true, vapid: null };
}
