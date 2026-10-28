// Hockey: parse a real NHL scoreboard, goals, the final, polling, against a fake native layer.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: {} as Record<string, any>, opts: { team: 'MTL' } as Record<string, unknown> }));

vi.mock('../src/core/native', () => ({ native: h.native, on: async () => () => {}, emitLocal: () => {} }));

import { FINAL_MS, IDLE_POLL, LIVE_POLL, parseGames, SportsActivity, type Game } from '../src/activities/sports';
import type { ActivityContext, RenderEnv } from '../src/core/activity';
import { hasIcon } from '../src/core/icons';
import type { Level } from '../src/core/layout';
import { fitSegments, fitVertical } from '../src/core/segments';
import { defaultSettings } from '../src/core/settings';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nhl-scoreboard.json', import.meta.url), 'utf8'));
const env = (level: Level, over: Partial<RenderEnv> = {}): RenderEnv => ({ level, width: 400, height: 40, now: Date.now(), open: false, hover: false, surfaced: null, interactive: true, vertical: false, ...over });

const game = (state: string, away: number, home: number, start = Date.now() - 3600_000): Game => ({ id: 1, state, start, home: { abbrev: 'MTL', score: home }, away: { abbrev: 'TOR', score: away }, period: 2, clock: '12:34', intermission: false });
const board = (g: Game) => ({ gamesByDate: [{ games: [{ id: g.id, gameState: g.state, startTimeUTC: new Date(g.start).toISOString(), homeTeam: g.home, awayTeam: g.away, periodDescriptor: { number: g.period }, clock: { timeRemaining: g.clock, inIntermission: g.intermission } }] }] });

async function boot() {
  const settings = defaultSettings();
  const surface: Array<Record<string, unknown>> = [];
  const act = new SportsActivity();
  const ctx = {
    id: 'sports',
    config: () => settings.activities.config.sports,
    options: () => h.opts,
    settings: () => settings,
    update: () => {},
    surface: (o?: Record<string, unknown>) => void surface.push(o ?? {}),
    alert: () => {},
    open: () => {},
    close: () => {},
    isOpen: () => false,
    isPrimary: () => true,
    notify: () => {},
    log: () => {},
  } as unknown as ActivityContext;
  await act.start(ctx);
  await vi.advanceTimersByTimeAsync(0);
  return { act, surface };
}

const texts = (act: SportsActivity, e: RenderEnv) => act.render(e).flatMap((s) => (s.t === 'text' ? [s.text] : []));
let reply: unknown = { gamesByDate: [] };

beforeEach(() => {
  vi.useFakeTimers();
  h.opts = { team: 'MTL' };
  reply = { gamesByDate: [] };
  for (const k of Object.keys(h.native)) delete h.native[k];
  h.native.httpGet = vi.fn(async () => ({ status: 200, body: JSON.stringify(reply) }));
});
afterEach(() => vi.useRealTimers());

describe('hockey', () => {
  it('parses a real scoreboard', () => {
    const games = parseGames(fixture);
    expect(games.length).toBeGreaterThan(3);
    expect(games[0]).toMatchObject({ id: 2026020141, state: 'OFF', away: { abbrev: 'SJS', score: 4 }, home: { abbrev: 'MTL', score: 3 } });
    expect(games.find((g) => g.state === 'FUT')).toMatchObject({ home: { score: 0 }, away: { score: 0 } });
  });

  it('flashes goals for and against, then shows the final for 10 minutes', async () => {
    reply = board(game('LIVE', 0, 0));
    const { act, surface } = await boot();
    expect(act.status()).toMatchObject({ active: true, summary: 'TOR 0 – 0 MTL' });
    expect(texts(act, env('expanded'))).toEqual(['TOR 0 – 0 MTL', 'P2 12:34']);

    reply = board(game('LIVE', 0, 1));
    await vi.advanceTimersByTimeAsync(LIVE_POLL);
    expect(surface.at(-1)).toMatchObject({ key: 'goal', level: 'expanded' });
    expect(texts(act, env('expanded'))[0]).toBe('Goal! MTL');

    reply = board(game('LIVE', 1, 1));
    await vi.advanceTimersByTimeAsync(LIVE_POLL);
    expect(texts(act, env('expanded'))[0]).toBe('Goal! TOR');

    reply = board(game('FINAL', 1, 2));
    await vi.advanceTimersByTimeAsync(LIVE_POLL);
    expect(act.status()).toMatchObject({ active: true, summary: 'Final TOR 1 – 2 MTL' });
    await vi.advanceTimersByTimeAsync(FINAL_MS);
    expect(act.status().active).toBe(false);
  });

  it('polls often while live and rarely otherwise, and refetches on a team change', async () => {
    reply = board(game('FUT', 0, 0, Date.now() + 5 * 3600_000));
    const { act } = await boot();
    expect(act.nextDelay()).toBe(IDLE_POLL);
    expect(act.status().active).toBe(false);
    expect(act.tile({ interactive: true } as never)?.body).toMatchObject({ label: 'Next game' });
    const calls = h.native.httpGet.mock.calls.length;
    h.opts = { team: 'TOR' };
    act.reconfigure();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.native.httpGet.mock.calls.length).toBe(calls + 1);
    expect(h.native.httpGet.mock.calls.at(-1)[0]).toContain('/scoreboard/TOR/now');
    reply = board(game('LIVE', 0, 0));
    await act.poll();
    expect(act.nextDelay()).toBe(LIVE_POLL);
  });

  it('renders valid segments at every size and on a side edge', async () => {
    reply = board(game('LIVE', 1, 2));
    const { act } = await boot();
    for (const level of ['compact', 'expanded', 'maximum'] as const) {
      for (const vertical of [false, true]) {
        const segs = act.render(env(level, { vertical }));
        for (const s of segs) if (s.t === 'icon') expect(hasIcon(s.icon)).toBe(true);
        expect(new Set(segs.map((s) => s.key)).size).toBe(segs.length);
        if (vertical) fitVertical(segs, 200, 40);
        else fitSegments(segs, level === 'compact' ? 150 : 400, 40);
      }
    }
  });

  it('names playoff overtimes, not a shootout', () => {
    const g = parseGames({ gamesByDate: [{ games: [{ id: 9, gameState: 'LIVE', startTimeUTC: '2026-05-01T23:00:00Z', homeTeam: { abbrev: 'MTL', score: 1 }, awayTeam: { abbrev: 'TOR', score: 1 }, periodDescriptor: { number: 5, periodType: 'OT' }, clock: { timeRemaining: '08:00' } }] }] })[0];
    expect(g.kind).toBe('OT');
  });

  it('stays quiet on a game already over, on junk replies, and keeps polling', async () => {
    reply = board(game('OFF', 2, 3));
    const { act } = await boot();
    expect(act.status().active).toBe(false);
    expect(act.render(env('expanded'))).toEqual([]);
    h.native.httpGet = vi.fn(async () => ({ status: 200, body: 'not json' }));
    await vi.advanceTimersByTimeAsync(IDLE_POLL);
    expect(act.nextDelay()).toBeGreaterThan(LIVE_POLL);
    h.native.httpGet = vi.fn(async () => null);
    await vi.advanceTimersByTimeAsync(IDLE_POLL);
    expect(h.native.httpGet).toHaveBeenCalled();
    expect(parseGames({ gamesByDate: [{ games: [{ startTimeUTC: 'x' }, null] }] })).toEqual([]);
    expect(parseGames(null)).toEqual([]);
  });

  it('shows 2OT in a playoff game and SO in a shootout', async () => {
    reply = board({ ...game('LIVE', 1, 1), period: 5 });
    (reply as any).gamesByDate[0].games[0].periodDescriptor.periodType = 'OT';
    const { act } = await boot();
    expect(texts(act, env('expanded'))[1]).toBe('2OT 12:34');
    reply = board({ ...game('LIVE', 1, 1), period: 5 });
    (reply as any).gamesByDate[0].games[0].periodDescriptor.periodType = 'SO';
    await vi.advanceTimersByTimeAsync(LIVE_POLL);
    expect(texts(act, env('expanded'))[1]).toBe('SO 12:34');
  });
});
