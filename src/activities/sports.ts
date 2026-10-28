// Hockey: your NHL team's game, live. The pill shows the score and the period clock
// while it's on, flashes on every goal, and Control Center shows the next game.
// From the NHL's free scoreboard (api-web.nhle.com), no key.

import type { ActivityStatus, RenderEnv, SheetEnv } from '../core/activity';
import { timeOfDay } from '../core/format';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

export type Side = { abbrev: string; score: number };
export type Game = { id: number; state: string; start: number; home: Side; away: Side; period: number; clock: string; intermission: boolean; kind?: string };

export const GOAL_MS = 6000;
export const FINAL_MS = 10 * 60_000;
export const LIVE_POLL = 25_000;
export const IDLE_POLL = 30 * 60_000;
const SOON = 15 * 60_000;

const live = (g: Game) => g.state === 'LIVE' || g.state === 'CRIT';
const done = (g: Game) => g.state === 'FINAL' || g.state === 'OFF';

function side(t: any): Side {
  return { abbrev: String(t?.abbrev ?? '?'), score: typeof t?.score === 'number' ? t.score : 0 };
}

/** Every game in a scoreboard/{TEAM}/now answer, oldest first. */
export function parseGames(json: any): Game[] {
  const out: Game[] = [];
  for (const d of Array.isArray(json?.gamesByDate) ? json.gamesByDate : []) {
    for (const g of Array.isArray(d?.games) ? d.games : []) {
      const start = Date.parse(g?.startTimeUTC ?? '');
      if (!Number.isFinite(start)) continue;
      out.push({
        id: Number(g.id),
        state: String(g.gameState ?? 'FUT'),
        start,
        home: side(g.homeTeam),
        away: side(g.awayTeam),
        period: Number(g.periodDescriptor?.number ?? g.period ?? 0),
        clock: String(g.clock?.timeRemaining ?? ''),
        intermission: !!g.clock?.inIntermission,
        kind: typeof g.periodDescriptor?.periodType === 'string' ? g.periodDescriptor.periodType : undefined,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The game that matters now: one being played, else the next one, else the last one. */
export function pick(games: Game[], now: number): { cur: Game | null; next: Game | null } {
  const cur = games.find(live) ?? [...games].reverse().find(done) ?? null;
  const next = games.find((g) => !live(g) && !done(g) && g.start > now - 3 * 3600_000) ?? null;
  return { cur, next };
}

export function scoreLine(g: Game): string {
  return `${g.away.abbrev} ${g.away.score} – ${g.home.score} ${g.home.abbrev}`;
}

function periodText(g: Game): string {
  if (g.intermission) return 'INT';
  const ot = g.period - 3;
  const p = g.kind === 'SO' || (!g.kind && g.period > 4) ? 'SO' : g.kind === 'OT' || g.period === 4 ? (ot > 1 ? `${ot}OT` : 'OT') : `P${g.period || 1}`;
  return g.clock ? `${p} ${g.clock}` : p;
}

function when(start: number, now: number): string {
  const d = new Date(start);
  const today = new Date(now);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(now + 86400_000);
  if (same(d, today)) return `${d.getHours() >= 17 ? 'Tonight' : 'Today'} ${timeOfDay(start)}`;
  if (same(d, tomorrow)) return `Tomorrow ${timeOfDay(start)}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${timeOfDay(start)}`;
}

export class SportsActivity extends BaseActivity {
  private game: Game | null = null;
  private next: Game | null = null;
  private endedAt = 0;
  private goal: { team: string; at: number } | null = null;
  private fails = 0;
  private team = '';
  private seq = 0;

  constructor() {
    super('sports');
  }

  private myTeam(): string {
    const t = this.ctx.options<{ team?: string }>().team;
    return typeof t === 'string' && /^[A-Z]{3}$/.test(t) ? t : 'MTL';
  }

  protected init(): void {
    this.team = this.myTeam();
    void this.poll();
  }

  /** The team changed in Activities: start over with the new one. */
  reconfigure(): void {
    if (this.myTeam() === this.team) return;
    this.team = this.myTeam();
    this.game = this.next = null;
    this.goal = null;
    this.endedAt = 0;
    this.ctx.update();
    void this.poll();
  }

  /** How long until the next check. */
  nextDelay(now = Date.now()): number {
    if (this.fails) return Math.min(IDLE_POLL, LIVE_POLL * 2 ** Math.min(this.fails, 6));
    const g = this.game;
    if (g && live(g)) return LIVE_POLL;
    const n = this.next;
    if (n && n.start - now <= SOON) return LIVE_POLL;
    return IDLE_POLL;
  }

  async poll(): Promise<void> {
    const mine = ++this.seq;
    const team = this.team;
    const r = await native.httpGet(`https://api-web.nhle.com/v1/scoreboard/${team}/now`, 1024 * 1024);
    if (!this.alive || mine !== this.seq) return;
    let games: Game[] | null = null;
    if (r && r.status === 200) {
      try {
        games = parseGames(JSON.parse(r.body));
      } catch {
        games = null;
      }
    }
    if (!games) this.fails++;
    else {
      this.fails = 0;
      this.apply(games, team, Date.now());
    }
    this.later(this.nextDelay(), () => {
      if (mine === this.seq) void this.poll();
    });
  }

  apply(games: Game[], team: string, now: number): void {
    const { cur, next } = pick(games, now);
    const prev = this.game;
    this.next = next;
    if (cur && prev && cur.id === prev.id && (live(cur) || done(cur))) {
      const scored = cur.home.score > prev.home.score ? cur.home.abbrev : cur.away.score > prev.away.score ? cur.away.abbrev : null;
      if (scored) {
        this.goal = { team: scored, at: now };
        this.ctx.surface({ key: 'goal', ms: GOAL_MS, level: 'expanded' });
        this.saw(scored === team ? 'good-news' : 'bad-news');
      }
      if (done(cur) && live(prev)) {
        this.endedAt = now;
        // Nothing else changes when the Final runs out: say so then, or it stays on the pill.
        this.later(FINAL_MS, () => this.ctx.update());
      }
    } else if (cur && done(cur)) {
      // Finished before we looked: count its end from now only if it just ended.
      this.endedAt = 0;
    }
    this.game = cur;
    this.ctx.update();
  }

  private showFinal(now: number): boolean {
    return !!this.game && done(this.game) && this.endedAt > 0 && now - this.endedAt < FINAL_MS;
  }

  status(): ActivityStatus {
    const g = this.game;
    const now = Date.now();
    if (g && live(g)) return { active: true, weight: 'foreground', summary: scoreLine(g) };
    if (g && this.showFinal(now)) return { active: true, weight: 'foreground', summary: `Final ${scoreLine(g)}` };
    return { active: false };
  }

  render(env: RenderEnv): Seg[] {
    const g = this.game;
    if (!g || !this.status().active) return [];
    const icon: Seg = { t: 'icon', key: 'icon', icon: 'puck', tone: 'accent', prio: 0 };
    const goal = this.goal && Date.now() - this.goal.at < GOAL_MS ? this.goal : null;
    if (env.vertical) {
      return [icon, { t: 'text', key: 'score', text: `${g.away.score}–${g.home.score}`, weight: 'semibold', prio: 0 }];
    }
    if (goal) {
      return [icon, { t: 'text', key: 'goal', text: `Goal! ${goal.team}`, tone: 'accent', weight: 'semibold', prio: 0 }, { t: 'text', key: 'score', text: scoreLine(g), side: 'end', prio: 1 }];
    }
    const score: Seg = { t: 'text', key: 'score', text: scoreLine(g), weight: 'semibold', prio: 0 };
    if (env.level === 'compact' || env.level === 'idle') return [icon, score];
    const tail = done(g) ? 'Final' : periodText(g);
    return [icon, score, { t: 'text', key: 'clock', text: tail, tone: 'muted', side: 'end', prio: 1 }];
  }

  tile(_env: SheetEnv): Tile | null {
    const g = this.game;
    const now = Date.now();
    if (g && (live(g) || this.showFinal(now))) {
      return { key: 'sports', tone: 'accent', body: { k: 'stat', icon: 'puck', label: done(g) ? 'Final' : periodText(g), value: scoreLine(g) } };
    }
    const n = this.next;
    if (!n) return null;
    const team = this.team || 'MTL';
    const vs = n.home.abbrev === team ? `vs ${n.away.abbrev}` : `at ${n.home.abbrev}`;
    return { key: 'sports', tone: 'muted', body: { k: 'stat', icon: 'puck', label: 'Next game', value: `${when(n.start, now)} ${vs}` } };
  }
}
