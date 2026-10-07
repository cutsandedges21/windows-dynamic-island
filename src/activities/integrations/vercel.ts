// Vercel: a deployment that starts, finishes or fails, and your latest deployments in the
// open island. The poll lists deployments for your account or one team (src-tauri/src/
// integrations.rs) using a token from the Credential Manager.

import { agoText, clip } from '../../core/format';
import type { Tone } from '../../core/segments';
import type { SheetRow } from '../../core/sheet';
import { IntegrationActivity, type TileContent } from './base';
import { isRecent, MINUTE, safeUrl, type Change, type Glance } from './util';

export interface Deployment {
  id: string;
  project: string;
  /** The host, without a scheme: "site-abc.vercel.app". */
  url: string;
  inspectorUrl: string;
  state: string;
  target: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  commit: string | null;
  branch: string | null;
}

export interface VercelSnapshot {
  /** Newest first. */
  deployments: Deployment[];
}

export type DeployState = 'building' | 'ready' | 'error' | 'canceled';

/** A deployment that shows up already finished is news only when it finished lately. */
const RECENT_MS = 10 * MINUTE;

export function deployState(state: string): DeployState {
  switch (state.toUpperCase()) {
    case 'READY':
      return 'ready';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
      return 'canceled';
    default:
      return 'building'; // QUEUED, INITIALIZING, BUILDING
  }
}

/** The live site, from the host Vercel reports. */
export function siteUrl(d: Deployment): string | null {
  return /^[a-z0-9.-]+$/i.test(d.url) ? `https://${d.url}` : null;
}

/** Where to look: the build log when it failed or is running, the site when it is live. */
function pageOf(d: Deployment): string | undefined {
  const inspector = safeUrl(d.inspectorUrl) ?? undefined;
  return deployState(d.state) === 'ready' ? (siteUrl(d) ?? inspector) : (inspector ?? siteUrl(d) ?? undefined);
}

const detailOf = (d: Deployment) => clip([d.target === 'production' ? 'production' : 'preview', d.branch, d.commit].filter(Boolean).join(' · '), 70);

/** Deployments that started, finished or failed since the last poll. */
export function compareVercel(prev: VercelSnapshot, next: VercelSnapshot, now: number): Change[] {
  const before = new Map(prev.deployments.map((d) => [d.id, d]));
  const changes: Change[] = [];
  for (const d of next.deployments) {
    const state = deployState(d.state);
    const was = before.get(d.id);
    if (was ? deployState(was.state) === state : !isRecent(d.createdAt, now, RECENT_MS)) continue;
    const base = { key: `vercel:${d.id}:${state}`, icon: 'globe', detail: detailOf(d), url: pageOf(d) };
    if (state === 'ready') changes.push({ ...base, tone: 'good', title: `${d.project} deployed`, level: 'compact' });
    else if (state === 'error') changes.push({ ...base, tone: 'bad', title: `${d.project} deploy failed` });
    else if (state === 'building' && !was) changes.push({ ...base, tone: 'info', title: `${d.project} deploying`, level: 'compact' });
  }
  return changes;
}

const TONE: Record<DeployState, Tone> = { ready: 'good', error: 'bad', building: 'info', canceled: 'muted' };
const WORD: Record<DeployState, string> = { ready: 'live', error: 'failed', building: 'deploying', canceled: 'canceled' };
const BADGE: Record<DeployState, string> = { ready: 'Ready', error: 'Failed', building: 'Building', canceled: 'Canceled' };

export function vercelGlance(s: VercelSnapshot): Glance | null {
  const d = s.deployments[0];
  if (!d) return null;
  const state = deployState(d.state);
  return { icon: 'globe', tone: TONE[state], title: `${d.project} ${WORD[state]}`, detail: detailOf(d), url: pageOf(d) };
}

export function vercelTile(s: VercelSnapshot, now: number): TileContent {
  const rows: SheetRow[] = s.deployments.slice(0, 3).map((d) => {
    const state = deployState(d.state);
    return {
      key: d.id,
      dot: TONE[state],
      pulse: state === 'building',
      title: d.project,
      detail: [d.branch, agoText(now - d.createdAt)].filter(Boolean).join(' · '),
      badge: BADGE[state],
      action: 'open',
      arg: pageOf(d),
      tip: d.commit ?? undefined,
    };
  });
  const latest = s.deployments[0];
  const tone = latest ? TONE[deployState(latest.state)] : 'muted';
  return { span: 2, rows: 2, tone, body: { k: 'list', icon: 'globe', label: 'Vercel', rows, empty: 'No deployments yet' } };
}

export class VercelActivity extends IntegrationActivity<VercelSnapshot> {
  constructor() {
    super('vercel', { secret: 'vercel.token', everyMs: 30_000, home: 'https://vercel.com/dashboard' });
  }

  protected override pollOptions(): Record<string, unknown> {
    const team = this.ctx.options<{ team?: string }>().team;
    return { team: typeof team === 'string' ? team.trim() : '' };
  }

  protected compare(prev: VercelSnapshot, next: VercelSnapshot, now: number): Change[] {
    return compareVercel(prev, next, now);
  }

  protected headline(s: VercelSnapshot): Glance | null {
    return vercelGlance(s);
  }

  protected tileFor(s: VercelSnapshot, now: number): TileContent {
    return vercelTile(s, now);
  }
}
