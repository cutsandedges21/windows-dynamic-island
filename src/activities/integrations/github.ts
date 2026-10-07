// GitHub: CI runs that fail or pass on the repositories you watch, pull requests waiting on
// your review, and your stars and repositories at a glance. The poll (src-tauri/src/
// integrations.rs) uses a token from the Credential Manager and only ever talks to api.github.com.

import { clip } from '../../core/format';
import { IntegrationActivity, type TileContent } from './base';
import { compactCount, isRecent, MINUTE, parseRepoList, parseTime, repoName, type Change, type Glance } from './util';

export interface Run {
  id: number;
  repo: string;
  /** The workflow's name. */
  name: string;
  /** The commit or pull request title. */
  title: string;
  branch: string;
  status: string;
  conclusion: string | null;
  url: string;
  updatedAt: string;
}

export interface GithubSnapshot {
  login: string;
  profileUrl: string;
  repos: number;
  stars: number | null;
  reviewRequests: number | null;
  watched: string[];
  /** Newest first, a few per watched repository. */
  runs: Run[];
}

export type RunState = 'running' | 'passed' | 'failed' | 'other';

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
/** A run that shows up already finished is news only when it finished lately. */
const RECENT_MS = 10 * MINUTE;

export function runState(run: Pick<Run, 'status' | 'conclusion'>): RunState {
  if (run.status !== 'completed') return 'running';
  if (run.conclusion === 'success') return 'passed';
  return run.conclusion && FAILED.has(run.conclusion) ? 'failed' : 'other';
}

const detailOf = (run: Run) => clip([run.branch, run.title].filter(Boolean).join(' · '), 60);

/** CI runs that finished since the last poll, and review requests that grew. */
export function compareGithub(prev: GithubSnapshot, next: GithubSnapshot, now: number): Change[] {
  const before = new Map(prev.runs.map((r) => [r.id, r]));
  const changes: Change[] = [];
  for (const run of next.runs) {
    const state = runState(run);
    if (state !== 'failed' && state !== 'passed') continue;
    const was = before.get(run.id);
    const finishedNow = was ? runState(was) === 'running' : isRecent(run.updatedAt, now, RECENT_MS);
    if (!finishedNow) continue;
    const name = repoName(run.repo);
    changes.push(
      state === 'failed'
        ? { key: `gh:run:${run.id}:failed`, tone: 'bad', icon: 'branch', title: `${name}: CI failed`, detail: detailOf(run), url: run.url }
        : { key: `gh:run:${run.id}:passed`, tone: 'good', icon: 'check', title: `${name}: CI passed`, detail: detailOf(run), url: run.url, level: 'compact' },
    );
  }
  const asked = next.reviewRequests ?? 0;
  if (prev.reviewRequests !== null && asked > prev.reviewRequests) {
    changes.push({
      key: `gh:review:${asked}`,
      tone: 'info',
      icon: 'user',
      title: 'Review requested',
      detail: `${asked} pull request${asked === 1 ? '' : 's'} waiting on you`,
      url: 'https://github.com/pulls/review-requested',
      level: 'expanded',
    });
  }
  return changes;
}

/** Where CI stands: the newest run of each watched repository. */
export function ciSummary(runs: Run[]): { failing: Run[]; running: Run[]; passing: Run[] } {
  const newest = new Map<string, Run>();
  for (const run of runs) {
    const cur = newest.get(run.repo);
    if (!cur || (parseTime(run.updatedAt) ?? 0) > (parseTime(cur.updatedAt) ?? 0)) newest.set(run.repo, run);
  }
  const latest = [...newest.values()];
  const by = (state: RunState) => latest.filter((r) => runState(r) === state);
  return { failing: by('failed'), running: by('running'), passing: by('passed') };
}

export function githubGlance(s: GithubSnapshot): Glance {
  const { failing, running, passing } = ciSummary(s.runs);
  const run = failing[0] ?? running[0];
  if (run) {
    const bad = failing.length > 0;
    return { icon: 'branch', tone: bad ? 'bad' : 'info', title: `${repoName(run.repo)}: CI ${bad ? 'failed' : 'running'}`, detail: detailOf(run), url: run.url };
  }
  if (passing.length) return { icon: 'branch', tone: 'good', title: 'CI passing', detail: `${passing.length} repositor${passing.length === 1 ? 'y' : 'ies'}`, url: s.profileUrl };
  return { icon: 'branch', tone: 'muted', title: s.login || 'GitHub', detail: summaryLine(s), url: s.profileUrl };
}

function summaryLine(s: GithubSnapshot): string {
  const parts = [s.stars !== null ? `★ ${compactCount(s.stars)}` : '', `${s.repos} repos`, s.reviewRequests ? `${s.reviewRequests} to review` : ''];
  return parts.filter(Boolean).join(' · ');
}

export function githubTile(s: GithubSnapshot): TileContent {
  const { failing, running, passing } = ciSummary(s.runs);
  const stars = s.stars !== null ? `★ ${compactCount(s.stars)}` : '';
  const reviews = s.reviewRequests ? `${s.reviewRequests} to review` : '';
  const open = { action: 'open', arg: failing[0]?.url ?? s.profileUrl };
  if (failing.length || running.length || passing.length) {
    const [value, tone] = failing.length ? ([`${failing.length} failing`, 'bad'] as const) : running.length ? (['CI running', 'info'] as const) : (['All passing', 'good'] as const);
    const sub = [stars, `${s.repos} repos`, reviews].filter(Boolean).join(' · ');
    return { tone, ...open, body: { k: 'stat', icon: 'branch', label: 'GitHub', value, sub } };
  }
  const sub = [stars ? `${s.repos} repos` : '', reviews].filter(Boolean).join(' · ') || s.login;
  return { tone: 'muted', ...open, body: { k: 'stat', icon: 'branch', label: 'GitHub', value: stars || `${s.repos} repos`, sub } };
}

export class GithubActivity extends IntegrationActivity<GithubSnapshot> {
  constructor() {
    super('github', { secret: 'github.token', everyMs: 60_000, home: 'https://github.com' });
  }

  protected override pollOptions(): Record<string, unknown> {
    return { repos: parseRepoList(this.ctx.options<{ repos?: string }>().repos) };
  }

  protected compare(prev: GithubSnapshot, next: GithubSnapshot, now: number): Change[] {
    return compareGithub(prev, next, now);
  }

  protected headline(s: GithubSnapshot): Glance {
    return githubGlance(s);
  }

  protected tileFor(s: GithubSnapshot): TileContent {
    return githubTile(s);
  }
}
