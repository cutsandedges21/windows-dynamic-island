// Workspaces › Notice what I work on: remembers what you work on across apps, so coming back to
// something doesn't mean rebuilding it in your head. Every few seconds it reads the window in
// front (its program and title, src/workspaces/notice/detect.ts), works out the project and
// file, and which workspace that is. Switching into a workspace shows its next step and notes
// on the pill; leaving one you worked on for a while asks where you stopped; a project you keep
// coming back to without a workspace gets a "make it a workspace" offer. Off until switched on
// (the option); everything stays on this PC in recent-work.json, and only what's worked out is
// kept unless "Keep window titles" is on. The Workspaces activity (workspaces.ts) builds on this.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { native, sendTo } from '../core/native';
import type { Seg } from '../core/segments';
import type { Block, SheetRow, SheetView, Tile } from '../core/sheet';
import { workspaceEngine } from '../workspaces/engine';
import { appName, baseName, displayName, inUseText, type Workspace } from '../workspaces/model';
import { detect, matchWorkspace, sameIds, workspacesInUse } from '../workspaces/notice/detect';
import { addSample, contextName, contexts, dayStart, duration, emptyTrail, prune, readTrail, settled, type Context, type TrailDoc } from '../workspaces/notice/model';
import { leaveSeed } from '../workspaces/seed';
import { workspaceSpans } from '../workspaces/time';
import { BaseActivity } from './base';

const SAMPLE_MS = 5000;
/** No input for this long: away, not working. */
const IDLE_MS = 3 * 60_000;
const SAVE_MS = 60_000;
/** Time in one place before it counts as being there. */
const HOLD_MS = 20_000;
/** A visit this long earns the "where did you stop?" question on leaving. */
const LEAVE_MIN_MS = 10 * 60_000;
/** Back within this long: no "welcome back" on the pill. */
const RETURN_QUIET_MS = 30 * 60_000;
/** A project without a workspace, this long today, gets the offer. */
const SUGGEST_MS = 20 * 60_000;
const SHOW_MS = 7000;
/** How often Control Center's "In use" rows look at the open windows. */
const IN_USE_MS = 4000;

interface NoticeOptions {
  notice: boolean;
  titles: boolean;
  leaveNote: boolean;
  suggest: boolean;
  days: number;
}

export abstract class NoticeActivity extends BaseActivity {
  private doc: TrailDoc = emptyTrail();
  private loaded = false;
  private dirty = false;
  /** Where the user has settled (a context key), and since when. */
  private current: string | null = null;
  private since = 0;
  private readonly lastSeen = new Map<string, number>();
  private arrived: { key: string; at: number } | null = null;
  private leaving: { ws: string; ms: number; at: number } | null = null;
  private offer: Context | null = null;
  private saved: { text: string; at: number } | null = null;
  /** Workspaces with a window open (workspacesInUse), read again while the island is open. */
  private inUse = new Set<string>();
  private inUseAt = 0;

  protected noticeOptions(): NoticeOptions {
    const o = this.ctx.options<Partial<NoticeOptions>>();
    return { notice: o.notice === true, titles: o.titles === true, leaveNote: o.leaveNote !== false, suggest: o.suggest !== false, days: Math.min(60, Math.max(1, Number(o.days) || 14)) };
  }

  protected async init(): Promise<void> {
    this.doc = prune(readTrail(await native.noticeLoad()), Date.now(), this.noticeOptions().days);
    this.loaded = true;
    // The Activities window asks the engine for "today" and "forget"; the engine asks here.
    workspaceEngine().notice = this;
    this.onDispose(() => {
      if (workspaceEngine().notice === this) workspaceEngine().notice = null;
    });
    this.every(SAMPLE_MS, () => void this.sample());
    this.every(SAVE_MS, () => this.save());
    this.onDispose(() => this.save());
    // Control Center's "In use" rows keep up while it's open (and cost nothing while it's closed).
    this.every(IN_USE_MS, () => {
      if (this.ctx.isOpen()) void this.checkInUse();
    });
  }

  private async checkInUse(): Promise<void> {
    this.inUseAt = Date.now();
    const r = await native.wsWindows();
    if (!r.ok) return;
    const now = workspacesInUse(r.value, workspaceEngine().store.list);
    if (sameIds(now, this.inUse)) return;
    this.inUse = now;
    this.ctx.update();
  }

  /** Whether a window of `ws` is open; a stale answer is checked again (the tile redraws if it changed). */
  protected inUseNow(ws: Workspace): boolean {
    if (Date.now() - this.inUseAt > IN_USE_MS) void this.checkInUse();
    return this.inUse.has(ws.id);
  }

  /** A Control Center row's light and line for a workspace in use: the green light flashing, "In use". */
  protected inUseRow(ws: Workspace): Pick<SheetRow, 'dot' | 'pulse' | 'detail'> | null {
    return this.inUseNow(ws) ? { dot: 'good', pulse: true, detail: inUseText(ws) } : null;
  }

  private save(): void {
    if (!this.loaded || !this.dirty) return;
    this.dirty = false;
    this.doc = prune(this.doc, Date.now(), this.noticeOptions().days);
    void native.noticeSave(this.doc);
  }

  private wsOf(key: string | null): Workspace | undefined {
    return key?.startsWith('ws:') ? workspaceEngine().store.get(key.slice(3)) : undefined;
  }

  private async sample(): Promise<void> {
    if (!this.loaded || !this.noticeOptions().notice) return;
    const now = Date.now();
    const n = await native.noticeNow();
    if (n.window && n.idleMs < IDLE_MS) {
      const w = n.window;
      const sig = detect(w.exe, w.title, w.className);
      const ws = matchWorkspace(sig, w.title, workspaceEngine().store.list);
      this.doc = addSample(this.doc, { at: now, app: w.exe, project: sig.project, ws: ws?.id ?? null, file: sig.file, title: this.noticeOptions().titles ? w.title.slice(0, 300) : '' });
      this.dirty = true;
    }
    this.settle(now);
  }

  /** Reacts to settling somewhere new: welcome to a workspace, ask about the one left, offer one. */
  private settle(now: number): void {
    const key = settled(this.doc.spans, now, HOLD_MS);
    if (!key || key === this.current) {
      this.maybeOffer(now);
      return;
    }
    const prev = this.current;
    const stayed = now - this.since;
    if (prev) this.lastSeen.set(prev, now);
    this.current = key;
    this.since = now;
    const left = this.wsOf(prev);
    if (left && stayed >= LEAVE_MIN_MS && this.noticeOptions().leaveNote) {
      this.leaving = { ws: left.id, ms: stayed, at: now };
      this.ctx.surface({ key: `notice-leave:${left.id}:${now}`, ms: 12000, level: 'expanded' });
    } else if (this.wsOf(key) && now - (this.lastSeen.get(key) ?? 0) > RETURN_QUIET_MS) {
      this.arrived = { key, at: now };
      this.ctx.surface({ key: `notice-arrive:${key}:${now}`, ms: SHOW_MS, level: 'expanded' });
      this.saw('info', `notice:${key}`);
    }
    this.ctx.update();
  }

  private maybeOffer(now: number): void {
    if (!this.noticeOptions().suggest || this.offer || !this.current?.startsWith('project:')) return;
    const quietKey = `offer:${this.current}`;
    if ((this.doc.quiet[quietKey] ?? 0) > now) return;
    const today = contexts(this.doc.spans, dayStart(now)).find((c) => c.key === this.current);
    if (!today || today.ms < SUGGEST_MS) return;
    this.offer = today;
    // Asked once a day at most, whatever the answer.
    this.doc = { ...this.doc, quiet: { ...this.doc.quiet, [quietKey]: dayStart(now) + 86_400_000 } };
    this.dirty = true;
    this.ctx.surface({ key: `notice-offer:${today.key}`, ms: 12000, level: 'expanded' });
    this.ctx.update();
  }

  /** The current workspace, with how long today. */
  private here(): { ws: Workspace; today: number } | null {
    if (!this.noticeOptions().notice) return null;
    const ws = this.wsOf(this.current);
    if (!ws) return null;
    const c = contexts(this.doc.spans, dayStart(Date.now())).find((x) => x.key === this.current);
    return { ws, today: c?.ms ?? 0 };
  }

  status(): ActivityStatus {
    const now = Date.now();
    const showing = Boolean(this.leaving || this.offer || (this.arrived && now - this.arrived.at < SHOW_MS) || (this.saved && now - this.saved.at < 3000));
    const here = this.here();
    if (!showing && !here) return { active: false };
    return {
      active: true,
      weight: showing ? 'foreground' : 'background',
      summary: here ? `Working on ${displayName(here.ws)}` : 'Workspaces',
    };
  }

  chip(): ChipView | null {
    const here = this.here();
    return here ? { icon: here.ws.icon, label: displayName(here.ws), tone: 'accent' } : null;
  }

  render(env: RenderEnv): Seg[] {
    const now = Date.now();
    if (this.saved && now - this.saved.at < 3000) return [{ t: 'icon', key: 'i', icon: 'check', tone: 'good', prio: 0 }, { t: 'text', key: 't', text: this.saved.text, prio: 1 }];
    if (this.leaving) {
      const ws = workspaceEngine().store.get(this.leaving.ws);
      return [
        { t: 'icon', key: 'i', icon: ws?.icon ?? 'history', tone: 'accent', prio: 0 },
        { t: 'text', key: 't', text: `Where did you stop on ${ws ? displayName(ws) : 'it'}?`, weight: 'medium', prio: 1, min: 80 },
      ];
    }
    if (this.offer) {
      const segs: Seg[] = [
        { t: 'icon', key: 'i', icon: 'grid', tone: 'accent', prio: 0 },
        { t: 'text', key: 't', text: `Make ${contextName(this.offer)} a workspace?`, weight: 'medium', prio: 1, min: 80 },
      ];
      if (env.interactive && env.level !== 'compact') segs.push({ t: 'button', key: 'make', label: 'Make it', action: 'make', arg: this.offer.key, style: 'primary', side: 'end', prio: 2 });
      return segs;
    }
    const here = this.here();
    if (!here) return [];
    const segs: Seg[] = [
      { t: 'icon', key: 'i', icon: here.ws.icon, tone: 'accent', prio: 0 },
      { t: 'text', key: 't', text: displayName(here.ws), weight: 'semibold', prio: 1, min: 50 },
    ];
    const next = here.ws.notes.next.trim();
    if (next && env.level !== 'compact' && !env.vertical) segs.push({ t: 'text', key: 'next', text: `Next: ${next}`, tone: 'muted', prio: 3, min: 80 });
    return segs;
  }

  sheet(env: SheetEnv): SheetView | null {
    if (this.leaving) {
      const ws = workspaceEngine().store.get(this.leaving.ws);
      if (!ws) return null;
      const blocks: Block[] = [
        { t: 'head', key: 'head', icon: ws.icon, title: `Leaving ${displayName(ws)}`, sub: `You were on it for ${duration(this.leaving.ms)}` },
        { t: 'input', key: 'note', placeholder: ws.notes.next.trim() ? `Next step (now: ${ws.notes.next.trim()})` : 'Where you stopped, or the next step', action: 'leave-note' },
      ];
      if (env.interactive) blocks.push({ t: 'buttons', key: 'b', items: [{ key: 'skip', label: 'Not now', action: 'leave-skip', style: 'ghost' }] });
      return { key: `notice-leave:${ws.id}`, blocks };
    }
    if (this.offer) {
      const c = this.offer;
      const apps = [...new Set(c.apps.map(appName))].slice(0, 3).join(', ');
      const blocks: Block[] = [
        { t: 'head', key: 'head', icon: 'grid', title: `You keep coming back to ${contextName(c)}`, sub: `${duration(c.ms)} today${apps ? ` in ${apps}` : ''}` },
        { t: 'text', key: 'why', text: 'Make it a workspace: its apps open in one click, and Island keeps its notes and next step for you.', tone: 'muted', size: 'sm' },
      ];
      if (env.interactive) {
        blocks.push({
          t: 'buttons',
          key: 'b',
          items: [
            { key: 'make', label: 'Make a workspace', action: 'make', arg: c.key, style: 'primary' },
            { key: 'later', label: 'Not now', action: 'offer-skip', arg: c.key, style: 'ghost' },
          ],
        });
      }
      return { key: `notice-offer:${c.key}`, blocks };
    }
    const here = this.here();
    if (!here) return null;
    return this.workspaceCard(here.ws, here.today, env);
  }

  /** A workspace at a glance: next step, notes, the files worked on today, Restore. */
  private workspaceCard(ws: Workspace, today: number, env: SheetEnv): SheetView {
    const c = contexts(this.doc.spans, dayStart(Date.now())).find((x) => x.ws === ws.id);
    const blocks: Block[] = [{ t: 'head', key: 'head', icon: ws.icon, title: displayName(ws), sub: today ? `${duration(today)} today` : undefined }];
    const next = ws.notes.next.trim();
    if (next) blocks.push({ t: 'text', key: 'next', text: `Next: ${next}`, size: 'md' });
    if (ws.notes.text.trim()) blocks.push({ t: 'text', key: 'notes', text: ws.notes.text.trim(), tone: 'muted', size: 'sm', bubble: true, lines: 4 });
    const files = c?.files ?? [];
    if (files.length) {
      const known = new Map(ws.resources.filter((r) => r.kind === 'file').map((r) => [baseName(r.path).toLowerCase(), r]));
      const rows: SheetRow[] = files.slice(0, 5).map((f) => {
        const item = known.get(f.toLowerCase());
        return { key: f, icon: 'file', title: f, action: env.interactive && item ? 'open-file' : undefined, arg: item?.id, tip: item ? 'Open it' : undefined };
      });
      blocks.push({ t: 'rows', key: 'files', items: rows });
    }
    if (env.interactive) {
      blocks.push({
        t: 'buttons',
        key: 'b',
        items: [
          { key: 'restore', label: 'Restore the rest', action: 'restore', arg: ws.id, style: 'secondary', tip: 'Open what this workspace opens; apps already running come to the front' },
          { key: 'open', label: 'Notes', action: 'open-app', style: 'ghost' },
        ],
      });
    }
    return { key: `notice-ws:${ws.id}`, blocks };
  }

  /** Pick up where you left off: the last places worked on this week (null with noticing off). */
  protected pickUpTile(env: SheetEnv): Tile | null {
    if (!this.noticeOptions().notice) return null;
    const recent = contexts(this.doc.spans, Date.now() - 7 * 86_400_000).slice(0, 4);
    if (!recent.length) return null;
    const rows: SheetRow[] = recent.map((c) => {
      const ws = c.ws ? workspaceEngine().store.get(c.ws) : undefined;
      return {
        key: c.key,
        icon: ws?.icon ?? 'history',
        title: ws ? displayName(ws) : contextName(c),
        detail: ws?.notes.next.trim() ? `Next: ${ws.notes.next.trim()}` : `${duration(c.ms)} this week`,
        action: env.interactive ? (ws ? 'restore' : 'make') : undefined,
        arg: ws ? ws.id : c.key,
        tip: ws ? `Restore ${displayName(ws)}` : 'Make it a workspace',
        ...(ws ? this.inUseRow(ws) : null),
      };
    });
    return { key: 'workspaces', span: 2, rows: rows.length > 2 ? 2 : 1, body: { k: 'list', icon: 'grid', label: 'Pick up', rows } };
  }

  /** The noticing actions; true when the action was one of them. */
  protected async noticeAction(name: string, arg: unknown): Promise<boolean> {
    const now = Date.now();
    if (name === 'leave-note' && this.leaving && typeof arg === 'string' && arg.trim()) {
      const ws = workspaceEngine().store.get(this.leaving.ws);
      if (ws) {
        await workspaceEngine().store.update(ws.id, { notes: { ...ws.notes, next: arg.trim().slice(0, 300), savedAt: now } });
        this.saved = { text: `Saved for ${displayName(ws)}`, at: now };
        this.later(3200, () => this.ctx.update());
      }
      this.leaving = null;
    } else if (name === 'leave-note' || name === 'leave-skip') this.leaving = null;
    else if (name === 'offer-skip' && typeof arg === 'string') {
      this.doc = { ...this.doc, quiet: { ...this.doc.quiet, [`offer:${arg}`]: now + 7 * 86_400_000 } };
      this.dirty = true;
      this.offer = null;
    } else if (name === 'make' && typeof arg === 'string') {
      const c = contexts(this.doc.spans).find((x) => x.key === arg);
      if (c) {
        leaveSeed({ name: contextName(c), description: 'Started from what Island noticed you work on.', apps: c.apps.filter((a) => /\.exe$/i.test(a)).slice(0, 4) });
        void native.openApp('workspaces');
        // An open window takes it now; a new one finds it when it loads.
        void sendTo('app', 'ws-seed', null);
      }
      this.offer = null;
      this.ctx.close();
    } else if (name === 'open-app') {
      void native.openApp('workspaces');
      this.ctx.close();
    } else if (name === 'open-file' && typeof arg === 'string') {
      const ws = this.wsOf(this.current);
      const item = ws?.resources.find((r) => r.id === arg);
      if (ws && item?.kind === 'file') void native.wsLaunch({ kind: 'file', path: item.path, openWith: item.openWith }, ws.cwd);
    } else return false;
    this.ctx.update();
    return true;
  }

  dismiss(key: string): void {
    if (key.startsWith('notice-leave')) this.leaving = null;
    if (key.startsWith('notice-offer')) this.offer = null;
  }

  /** "today", "week", "spans" and "forget" for the Activities window (through the engine). */
  noticeCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'today') return contexts(this.doc.spans, dayStart(Date.now()));
    if (cmd === 'week') return contexts(this.doc.spans, Date.now() - 7 * 86_400_000);
    if (cmd === 'spans') {
      // The Workspaces page's Time tab: when each workspace was in front, [start, end, id], up to this sample.
      const a = (arg ?? {}) as { since?: unknown; until?: unknown };
      return workspaceSpans(this.doc.spans, Number(a.since) || 0, Number(a.until) || Infinity);
    }
    if (cmd === 'forget') {
      this.doc = emptyTrail();
      this.dirty = false;
      this.current = null;
      this.lastSeen.clear();
      this.leaving = this.offer = null;
      void native.noticeForget();
      this.ctx.update();
      return true;
    }
    return null;
  }

  /** Options changed: noticing off clears what's on the pill; titles off erases the ones kept. */
  reconfigure(): void {
    const o = this.noticeOptions();
    if (!o.notice) {
      this.current = null;
      this.leaving = this.offer = this.arrived = null;
    }
    if (!o.titles && this.doc.spans.some((s) => s.title)) {
      this.doc = { ...this.doc, spans: this.doc.spans.map((s) => (s.title ? { ...s, title: '' } : s)) };
      this.dirty = true;
      this.save();
    }
    this.ctx.update();
  }
}
