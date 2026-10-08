// Settings v2 migration, priority with non-persistent busy activities, and the
// Games activity's views (native layer faked).

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any> }));
vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import type { ActivityContext, RenderEnv } from '../src/core/activity';
import { choosePrimary, type Candidate } from '../src/core/priority';
import { defaultSettings, migrate, SETTINGS_VERSION } from '../src/core/settings';
import { fpsText, GameActivity, pingTone } from '../src/activities/game';

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

  async function boot(state: unknown) {
    for (const k of Object.keys(h.native)) delete h.native[k];
    Object.assign(h.native, { demo: false, gameState: vi.fn(async () => state), gameFpsSetup: vi.fn(async () => ({ ok: true, message: 'ok' })) });
    const act = new GameActivity();
    const settings = defaultSettings();
    const ctx = {
      id: 'game', config: () => settings.activities.config.game, options: () => ({}), settings: () => settings, update: () => {}, surface: () => {},
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
