// Settings v2 migration, priority with non-persistent busy activities, and the
// Games activity's views (native layer faked).

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));
vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import type { ActivityContext, RenderEnv } from '../src/core/activity';
import { choosePrimary, type Candidate } from '../src/core/priority';
import { defaultSettings, migrate, SETTINGS_VERSION } from '../src/core/settings';
import { fpsText, GameActivity, pingTone, stripItems } from '../src/activities/game';

describe('settings v2', () => {
  it('frees orange for Claude and takes Claude off the main screen, once', () => {
    const old = defaultSettings() as unknown as Record<string, any>;
    old.version = 1;
    old.island.accent = 'ember';
    old.activities.config.claude.persistent = true;
    const s = migrate(old);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.island.accent).toBe('sky');
    expect(s.activities.config.claude.persistent).toBe(false);
    // Chosen again after the migration: kept.
    s.island.accent = 'ember';
    s.activities.config.claude.persistent = true;
    const again = migrate(JSON.parse(JSON.stringify(s)));
    expect(again.island.accent).toBe('ember');
    expect(again.activities.config.claude.persistent).toBe(true);
  });

  it('v7: a Claude chat finishing in the window in front stops popping up, once, also where it was saved off', () => {
    const old = defaultSettings() as unknown as Record<string, any>;
    old.version = 6;
    old.activities.config.claude.options.onlyOtherChats = false;
    const s = migrate(old);
    expect(s.activities.config.claude.options.onlyOtherChats).toBe(true);
    // Turned off again after the migration: kept.
    s.activities.config.claude.options.onlyOtherChats = false;
    expect(migrate(JSON.parse(JSON.stringify(s))).activities.config.claude.options.onlyOtherChats).toBe(false);
    expect(defaultSettings().activities.config.claude.options.onlyOtherChats).toBe(true);
  });

  it('v8: settings a development build stamped version 7 with that switch still off get it on, once', () => {
    const stamped = defaultSettings() as unknown as Record<string, any>;
    stamped.version = 7;
    stamped.activities.config.claude.options.onlyOtherChats = false;
    const s = migrate(stamped);
    expect(s.version).toBe(8);
    expect(s.activities.config.claude.options.onlyOtherChats).toBe(true);
    s.activities.config.claude.options.onlyOtherChats = false;
    expect(migrate(JSON.parse(JSON.stringify(s))).activities.config.claude.options.onlyOtherChats).toBe(false);
  });

  it('keeps a well-formed grid layout and drops the rest', () => {
    const raw = defaultSettings() as unknown as Record<string, any>;
    raw.island.grid = {
      order: ['claude/claude', 7, 'island/day', 'claude/claude'],
      sizes: { 'music/music': '2x2', bad: '9x9' },
      hidden: ['weather/weather', null],
      pages: [['island/day', null, 'claude/claude', 5], 'junk', [null, 'claude/claude', 'music/music', '']],
    };
    const s = migrate(raw);
    expect(s.island.grid).toEqual({
      order: ['claude/claude', 'island/day'],
      sizes: { 'music/music': '2x2' },
      hidden: ['weather/weather'],
      // Empty cells stay; a key already on an earlier page, numbers and blanks go.
      pages: [['island/day', null, 'claude/claude'], [null, 'music/music']],
    });
  });

  it('0.3.0: what Ask Claude answered with moves into the bot chat, and the removed activities go', () => {
    const raw = defaultSettings() as unknown as Record<string, any>;
    // Saved by 0.2.9: Ask Claude had the choice, Local AI had no such option.
    delete raw.activities.config.local.options.backend;
    raw.activities.config.ask = { enabled: true, options: { backend: 'api' } };
    raw.activities.config.stripe = { enabled: true, options: {} };
    raw.activities.order = ['stripe', 'ask', ...raw.activities.order];
    const s = migrate(raw);
    expect(s.activities.config.local.options.backend).toBe('api');
    expect(s.activities.config.ask).toBeUndefined();
    expect(s.activities.config.stripe).toBeUndefined();
    expect(s.activities.order).not.toContain('ask');
    expect(s.activities.order).not.toContain('stripe');
    // A choice already made in the bot chat wins.
    raw.activities.config.local = { ...raw.activities.config.local, options: { backend: 'claude-code' } };
    expect(migrate(raw).activities.config.local.options.backend).toBe('claude-code');
  });
});

describe('priority', () => {
  const cfg = (persistent: boolean) => ({ ...defaultSettings().activities.config.music, persistent });
  it('a busy activity that is not persistent shows as a chip, never as the main screen', () => {
    const candidates: Candidate[] = [
      { id: 'claude', status: { active: true, weight: 'foreground' }, config: { ...cfg(false), priority: 'high' }, order: 0 },
      { id: 'music', status: { active: true, weight: 'foreground' }, config: cfg(true), order: 1 },
    ];
    const c = choosePrimary(candidates, { selected: null, surfaces: [], now: 0, dnd: false });
    expect(c.primary).toBe('music');
    expect(c.visible).toContain('claude');
    const alone = choosePrimary([candidates[0]], { selected: null, surfaces: [], now: 0, dnd: false });
    expect(alone.primary).toBeNull();
  });
});

describe('games', () => {
  const env = (level: RenderEnv['level'], vertical = false): RenderEnv => ({ level, width: 400, height: 40, now: 0, open: false, hover: false, surfaced: null, interactive: true, vertical });

  async function boot(state: unknown, options: Record<string, unknown> = {}) {
    for (const k of Object.keys(h.native)) delete h.native[k];
    Object.assign(h.native, {
      demo: false,
      gameState: vi.fn(async () => state),
      gameFpsSetup: vi.fn(async () => ({ ok: true, message: 'ok' })),
      sysSample: vi.fn(async () => ({ cpu: 31.2, memUsed: 8, memTotal: 16, gpu: 58, top: null })),
      netSample: vi.fn(async () => ({ rxBps: 2.3 * 1024 * 1024, txBps: 1.1 * 1024 * 1024, connected: true, internet: true, name: 'Wi-Fi', wifi: true, vpn: false })),
      audioState: vi.fn(async () => ({ micMuted: false })),
      gameBar: vi.fn(async () => true),
      micSetMute: vi.fn(async () => true),
    });
    const act = new GameActivity();
    const settings = defaultSettings();
    const ctx = {
      id: 'game', config: () => settings.activities.config.game, options: () => options, settings: () => settings, update: () => {}, surface: () => {},
      alert: () => {}, open: () => {}, close: () => {}, isOpen: () => false, isPrimary: () => true, notify: () => {}, log: () => {},
    } as unknown as ActivityContext;
    vi.useFakeTimers();
    await act.start(ctx);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    return act;
  }

  const playing = { game: { name: 'Hades II', appId: 1145350, pid: 4242, source: 'steam' }, fps: 143.6, fpsSource: 'frames', fpsNeedsSetup: false, ping: 24, pingTarget: '155.133.248.34', pingKind: 'server' };

  it('shows FPS and ping in the smallest pill, and stays over full-screen games', async () => {
    const act = await boot(playing);
    const st = act.status();
    expect(st.active).toBe(true);
    expect(st.overFullscreen).toBe(true);
    const texts = act.render(env('compact')).filter((s) => s.t === 'text').map((s) => (s.t === 'text' ? s.text : ''));
    expect(texts).toEqual(['144', 'FPS', '24 ms']);
    expect(act.render(env('expanded')).some((s) => s.t === 'text' && s.text === 'Hades II')).toBe(true);
    expect(act.render(env('compact', true)).map((s) => (s.t === 'text' ? s.text : ''))).toEqual(['144', 'FPS', '24', 'ms']);
  });

  it('game mode: the open card has CPU, GPU and RAM, and Game Bar buttons that press its shortcuts', async () => {
    const act = await boot(playing, {});
    const open = { reason: 'open' as const, now: Date.now(), width: 400, vertical: false, interactive: true, surfaced: null };
    expect(act.tile!(open)).toMatchObject({ action: 'card' });
    const card = act.sheet!(open)!;
    const stats = card.blocks.find((b) => b.t === 'stats');
    expect(stats && stats.t === 'stats' ? stats.items.map((i) => [i.label, i.value]) : []).toEqual([
      ['FPS', '144'],
      ['Ping', '24 ms'],
      ['CPU', '31%'],
      ['GPU', '58%'],
      ['RAM', '50%'],
    ]);
    const bar = card.blocks.find((b) => b.t === 'buttons' && b.key === 'bar');
    expect(bar && bar.t === 'buttons' ? bar.items.map((b) => [b.action, b.arg ?? null]) : []).toEqual([
      ['bar', 'screenshot'],
      ['bar', 'clip'],
      ['bar', 'record'],
      ['mic', null],
    ]);
    await act.action!('bar', 'clip');
    expect(h.native.gameBar).toHaveBeenCalledWith('clip');
    // Nothing else is pressed for it.
    await act.action!('bar', 'format');
    expect(h.native.gameBar).toHaveBeenCalledTimes(1);
    await act.action!('mic');
    expect(h.native.micSetMute).toHaveBeenCalledWith(true);
  });

  it('set to a strip, a full-screen game gets the numbers along the top and the pill leaves', async () => {
    const island = await boot(playing, {});
    expect(island.strip(0)).toBeNull();
    const act = await boot(playing, { display: 'strip', stripStyle: 'glass' });
    expect(act.status().overFullscreen).toBe(false);
    const view = act.strip(new Date(2026, 10, 12, 10, 30).getTime())!;
    expect(view.style).toBe('glass');
    expect(view.items.map((i) => `${i.label ?? ''} ${i.value}`.trim())).toEqual(['FPS 144', 'CPU 31%', 'GPU 58%', 'RAM 50%', 'Ping 24 ms', '↓ 2.3 MB/s', '↑ 1.1 MB/s', '10:30 AM']);
    expect(stripItems({ ...playing, fps: null } as never, null, null, null, 0).map((i) => i.key)).toEqual(['fps', 'time']);
  });

  it('offers the one-time setup when Windows refuses frame timing', async () => {
    const act = await boot({ ...playing, fps: null, fpsSource: null, fpsNeedsSetup: true });
    expect(act.render(env('compact')).find((s) => s.key === 'fps')).toMatchObject({ text: '—' });
    expect(act.render(env('maximum')).some((s) => s.t === 'button' && s.action === 'setup')).toBe(true);
    const card = act.sheet!({ reason: 'hover', now: 0, width: 400, vertical: false, interactive: true, surfaced: null })!;
    expect(card.blocks.some((b) => b.t === 'buttons' && b.items[0].action === 'setup')).toBe(true);
  });

  it('is quiet when nothing is played', async () => {
    const act = await boot({ game: null, fps: null, fpsSource: null, fpsNeedsSetup: false, ping: null, pingTarget: null, pingKind: null });
    expect(act.status().active).toBe(false);
    expect(act.tile!({ reason: 'open', now: 0, width: 400, vertical: false, interactive: true, surfaced: null })).toBeNull();
  });

  it('colours ping like games do and never prints NaN', () => {
    expect([pingTone(20), pingTone(80), pingTone(200), pingTone(null)]).toEqual(['good', 'warn', 'bad', 'muted']);
    expect(fpsText(NaN)).toBe('—');
    expect(fpsText(59.6)).toBe('60');
  });
});
