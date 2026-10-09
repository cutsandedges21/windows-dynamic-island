// The Claude Code activity. The logic is Usage Clip's (main.js orchestration:
// polling cadence, switching, reopening, alerts, hotkeys, tray), plus hooks for
// answering from the island: permission prompts, Claude's questions, and the
// reply window (a finished chat waits briefly for a reply typed here, which
// then lands in that same chat). The views are the island's own.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../../core/activity';
import { agoText, baseName, clip, elapsed, pace, plainText, resetsIn, resetsOn, SESSION_WINDOW_MS, tokens as fmtTokens, WEEK_WINDOW_MS } from '../../core/format';
import { requireHello } from '../../core/hello';
import { native, type ClaudeEnv, type MenuItem } from '../../core/native';
import type { Seg, Tone } from '../../core/segments';
import type { BotMood } from '../../fx';
import type { Block, SheetButton, SheetRow, SheetView, Tile } from '../../core/sheet';
import { BaseActivity, chime } from '../base';
import { chatUrl, DesktopChats, type DesktopChat } from './desktop';
import { afterModifiersReleased, deepLink, focusSession, selectWindow } from './focus';
import { HookState, questionsOf, type HookEvent, type PermissionCard, type ReplyHold } from './hooks';
import { EDITOR_HOSTS } from './procinfo';
import { describeTool, joinPath } from './status';
import { ClosedHistory, SessionTracker, type ClosedView, type SessionView, type TrackerEvent } from './tracker';
import { UsageClient, WeeklyTokens, weekWindowStart, type UsageData, type UsageState } from './usage';

interface Options {
  sessionHotkeys: boolean;
  notifications: boolean;
  showLimits: boolean;
  showDesktop: boolean;
  finishedSeconds: number;
  /** A chat that finishes while the user is looking at it does not pop the island open. */
  onlyOtherChats: boolean;
  /** The bot at the front of the pill instead of the status dot and Claude mark. */
  avatar: boolean;
  replyWindowSeconds: number;
  requireHello: boolean;
  resetAlerts: boolean;
  /** Session ids the user hid from Island. */
  hiddenSessions: string[];
  /** Closed chats up to this time are cleared from "Closed recently". */
  closedClearedAt: number;
}

/** Which limit resets the user was already told about (survives restarts). */
const RESET_SEEN_KEY = 'island.claude.resetSeen';
/** A reset older than this when first noticed is old news: recorded, not announced. */
const RESET_NEWS_MS = 12 * 3600_000;

/** island-hook waits 110 s for a permission answer; the pipe answers at 108 s. */
const PERMISSION_MS = 108_000;
/** Clicking the reply box keeps the chat waiting this long… */
const HOLD_MS = 240_000;
/** …but never past this, measured from the Stop (the pipe's own ceiling is 280 s). */
const HOLD_CEILING_MS = 270_000;

const TONE: Record<string, Tone> = { needs: 'claude', working: 'good', turn: 'info', error: 'bad', muted: 'muted' };

/** The Claude mark that leads the pill when the avatar is off. */
const MARK: Seg = { t: 'icon', key: 'mark', icon: 'claude', tone: 'claude', prio: 0 };

/** What the avatar shows for a chat: it waits on you, it is busy, it hit an error, or it rests. */
export function moodOf(s: Pick<SessionView, 'status' | 'needsYou'>): BotMood {
  if (s.needsYou) return 'needs-you';
  if (s.status === 'working') return 'thinking';
  if (s.status === 'errored') return 'error';
  return 'idle';
}

/** One avatar for several chats shows the most pressing of their moods. */
export function moodOfAll(sessions: Array<Pick<SessionView, 'status' | 'needsYou'>>): BotMood {
  const moods = new Set(sessions.map(moodOf));
  return (['needs-you', 'error', 'thinking'] as const).find((m) => moods.has(m)) ?? 'idle';
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "a:b:c" → ["a", "b:c"]: action names carry their target after the first colon. */
function splitOnce(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + sep.length)];
}

/** 12-hour reset times for the tray: "resets 4:15 PM", "resets Tue 4:00 AM" (Usage Clip's resetText). */
function resetText(ms: number | null | undefined, withDay: boolean): string {
  if (ms == null || !Number.isFinite(ms)) return 'not started';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (!withDay) return `resets ${time}`;
  const today = d.toDateString() === new Date().toDateString();
  return `resets ${today ? 'today' : d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

export class ClaudeActivity extends BaseActivity {
  private env: ClaudeEnv | null = null;
  private tracker: SessionTracker | null = null;
  private history: ClosedHistory | null = null;
  private weekly: WeeklyTokens | null = null;
  private usage: UsageClient | null = null;
  private desktop: DesktopChats | null = null;
  private readonly hooks = new HookState();

  sessions: SessionView[] = [];
  closed: ClosedView[] = [];
  chats: DesktopChat[] = [];
  usageState: UsageState | null = null;
  tokenTotals: { fresh: number; cached: number; output: number } | null = null;

  private selected: string | null = null;
  private inputFor: string | null = null;
  private readonly finished = new Map<string, number>();
  private notice: { text: string; tone: Tone; icon: string; until: number } | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chats that finished while the user was looking at them: no card, they saw it. */
  private readonly looking = new Set<string>();
  /** Answers picked so far on a question card: request id → question index → labels. */
  private readonly picks = new Map<string, Map<number, string[]>>();

  constructor() {
    super('claude');
  }

  private opts(): Options {
    const o = this.ctx.options<Partial<Options>>();
    return {
      sessionHotkeys: o.sessionHotkeys !== false,
      notifications: o.notifications !== false,
      showLimits: o.showLimits !== false,
      showDesktop: o.showDesktop !== false,
      finishedSeconds: Number(o.finishedSeconds) || 8,
      onlyOtherChats: o.onlyOtherChats === true,
      avatar: o.avatar !== false,
      replyWindowSeconds: Math.max(0, Math.min(240, Number(o.replyWindowSeconds ?? 45) || 0)),
      requireHello: o.requireHello === true,
      resetAlerts: o.resetAlerts !== false,
      hiddenSessions: Array.isArray(o.hiddenSessions) ? o.hiddenSessions.filter((x): x is string => typeof x === 'string') : [],
      closedClearedAt: Number(o.closedClearedAt) || 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle (main.js start())

  protected async init(): Promise<void> {
    this.listen<HookEvent>('hook', (ev) => this.onHook(ev));
    // Unanswered in time: the terminal asks now (or the chat ends its turn), so the card goes.
    this.listen<{ request_id: string }>('hook-expired', ({ request_id }) => {
      const card = this.hooks.take(request_id);
      const hold = this.hooks.takeHold(request_id);
      this.picks.delete(request_id);
      if (card || hold) this.ctx.update();
    });
    // Switching to a chat's own window means the user will answer it there: let it go at once.
    this.listen<{ pid: number }>('foreground', ({ pid }) => this.onForeground(pid));
    this.every(1000, () => this.expireHolds());
    if (native.demo) {
      this.demo();
      return;
    }
    this.env = await native.claudeEnv();
    if (!this.env || !this.alive) return;
    const root = this.env.configDir;
    const sessionsDir = joinPath(root, 'sessions');
    const projectsDir = joinPath(root, 'projects');
    this.tracker = new SessionTracker(sessionsDir, projectsDir);
    this.history = new ClosedHistory(projectsDir);
    this.weekly = new WeeklyTokens(projectsDir);
    this.usage = new UsageClient({
      configDir: root,
      usageClipCache: this.env.usageClipCache,
      getVersion: () => this.tracker?.latestVersion ?? null,
      getActivity: () => this.activityKey(),
    });
    if (this.usage.state.data) this.usageState = this.usage.state; // last reading, shown at once
    this.desktop = new DesktopChats(this.env.desktopBlobDirs);

    // A chat opening or closing rewrites/removes its registry file: react at once.
    void native.watch('claude-sessions', sessionsDir, false);
    this.onDispose(() => void native.unwatch('claude-sessions'));
    this.listen<{ id: string }>('fs-change', (c) => {
      if (c.id === 'claude-sessions') this.pollSoon(120);
    });

    // Hooks report what matters the moment it happens, so the scan is a safety net,
    // not the source of truth: every 3 s costs half as much and misses nothing.
    this.every(3000, () => void this.pollSessions(), true);
    this.later(1500, () => void this.pollHistory()); // after the window is up; the first pass reads whole transcripts
    this.every(10000, () => {
      void this.pollTokens();
      void this.pollHistory();
    });
    void this.pollTokens();
    this.every(8000, () => void this.pollDesktop(), true);
    this.every(1000, () => {
      void this.pollUsage(false);
      this.checkResets();
    });
    void this.pollUsage(true);
  }

  reconfigure(): void {
    if (!this.opts().showDesktop) this.chats = [];
    this.ctx.update();
  }

  // ---------------------------------------------------------------- polling (main.js)

  /** Changes whenever any session writes a turn or weekly tokens move. */
  private activityKey(): string {
    let latest = 0;
    for (const s of this.sessions) if (s.alive && s.lastActivityMs > latest) latest = s.lastActivityMs;
    return `${latest}:${this.tokenTotals ? this.tokenTotals.fresh : 0}`;
  }

  private pollSoon(ms: number): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollSessions(), ms);
  }

  private async pollSessions(): Promise<void> {
    if (!this.tracker || !this.alive) return;
    let result;
    try {
      result = await this.tracker.poll();
    } catch (err) {
      this.ctx.log('session poll failed', String(err));
      return;
    }
    this.sessions = this.visibleSessions(result.sessions);
    this.closed = this.visibleClosed(result.closed);
    for (const ev of result.events) this.onTrackerEvent(ev);
    const keepMs = this.opts().finishedSeconds * 1000 + 2000;
    for (const [id, at] of this.finished) if (Date.now() - at > keepMs) this.finished.delete(id);
    if (this.selected && !this.sessions.some((s) => s.id === this.selected)) this.selected = null;
    this.ctx.update();
  }

  private onTrackerEvent(ev: TrackerEvent): void {
    if (ev.type === 'needs-you') this.announceNeedsYou(ev.session);
    else if (ev.type === 'finished') this.markFinished(ev.session.id);
    else if (ev.type === 'closed') this.ctx.log('closed', { session: ev.session.id, title: ev.session.displayTitle });
  }

  /** Chats that closed before we saw them (or while the app was off), from transcripts. */
  private async pollHistory(): Promise<void> {
    if (!this.tracker || !this.history) return;
    try {
      const entries = await this.history.scan(this.tracker.liveIds());
      // Transcripts don't record which editor ran a chat; name the one that is running.
      const editor = this.tracker.probe.runningEditor();
      this.tracker.addHistory(entries.map((e) => (e.entrypoint === 'claude-vscode' && !e.editorHost && editor ? { ...e, editorHost: editor } : e)));
      this.closed = this.visibleClosed(this.tracker.closedList());
      this.ctx.update();
    } catch (err) {
      this.ctx.log('history scan failed', String(err));
    }
  }

  /** Chats the user hid stay out of every list. */
  private visibleSessions(list: SessionView[]): SessionView[] {
    const hidden = new Set(this.opts().hiddenSessions);
    return hidden.size ? list.filter((s) => !hidden.has(s.sessionId)) : list;
  }

  /** "Closed recently", without what the user cleared or hid. */
  private visibleClosed(list: ClosedView[]): ClosedView[] {
    const o = this.opts();
    const hidden = new Set(o.hiddenSessions);
    return list.filter((c) => c.closedAt > o.closedClearedAt && !hidden.has(c.sessionId));
  }

  private async pollDesktop(): Promise<void> {
    if (!this.desktop) return;
    if (!this.opts().showDesktop) {
      if (this.chats.length) {
        this.chats = [];
        this.ctx.update();
      }
      return;
    }
    try {
      if (await this.desktop.poll()) {
        this.chats = this.desktop.chats;
        this.ctx.update();
      }
    } catch (err) {
      this.ctx.log('desktop chats failed', String(err));
    }
  }

  private async pollTokens(): Promise<void> {
    if (!this.weekly) return;
    try {
      await this.weekly.scan();
      this.tokenTotals = this.weekly.totals(weekWindowStart(this.usageState?.data?.sevenDay?.resetsAt ?? null));
      this.ctx.update();
    } catch (err) {
      this.ctx.log('token scan failed', String(err));
    }
  }

  /**
   * The limits as they stand now. A window whose reset time has passed is back at
   * 0%: the API only reports the new window once a message starts it, and the
   * island must not keep showing the old 100% until then.
   */
  private limitsNow(now = Date.now()): UsageData | null {
    const d = this.usageState?.data;
    if (!d) return null;
    const fresh = <W extends { pct: number; resetsAt: number | null } | null | undefined>(w: W): W =>
      w && w.resetsAt != null && w.resetsAt <= now ? ({ ...w, pct: 0, resetsAt: null } as W) : w;
    return { ...d, fiveHour: fresh(d.fiveHour), sevenDay: fresh(d.sevenDay) };
  }

  /** Says so once when the session or weekly limit resets, also if that happened while Island was closed. */
  private checkResets(now = Date.now()): void {
    const d = this.usageState?.data;
    if (!d) return;
    let seen: Record<string, number> = {};
    try {
      seen = JSON.parse(localStorage.getItem(RESET_SEEN_KEY) ?? '{}') as Record<string, number>;
    } catch {
      seen = {};
    }
    let changed = false;
    const windows = [
      ['session', d.fiveHour, 'Session limit'],
      ['week', d.sevenDay, 'Weekly limit'],
    ] as const;
    for (const [key, w, label] of windows) {
      if (!w?.resetsAt || w.resetsAt > now || seen[key] === w.resetsAt) continue;
      seen[key] = w.resetsAt;
      changed = true;
      if (!this.opts().resetAlerts || now - w.resetsAt > RESET_NEWS_MS) continue;
      const was = Math.round(w.pct);
      this.ctx.log('limit reset', { window: key, was });
      this.flash(`${label} reset. Back to 0%`, 'good', 'refresh', 8000);
      this.ctx.notify(`${label} reset`, was ? `It was at ${was}%. A fresh window starts with your next message.` : 'A fresh window starts with your next message.');
    }
    if (!changed) return;
    try {
      localStorage.setItem(RESET_SEEN_KEY, JSON.stringify(seen));
    } catch {
      /* no storage: at worst the alert repeats after a restart */
    }
    this.ctx.update();
  }

  private async pollUsage(force: boolean): Promise<void> {
    if (!this.usage) return;
    const polled = await this.usage.maybePoll(force);
    if (!polled) return;
    this.usageState = this.usage.state;
    const u = this.usageState;
    if (u.error) this.ctx.log('limits', { result: u.error, session: u.data?.fiveHour?.pct ?? null, nextInS: Math.round((this.usage.nextAt - Date.now()) / 1000) });
    // The weekly window start comes from seven_day.resets_at, so refresh totals.
    if (this.weekly) this.tokenTotals = this.weekly.totals(weekWindowStart(u.data?.sevenDay?.resetsAt ?? null));
    this.ctx.update();
  }

  // ---------------------------------------------------------------- hooks

  private onHook(ev: HookEvent): void {
    const kind = this.hooks.apply(ev);
    const sid = ev.session_id ?? '';
    if (kind === 'permission' && ev.request_id) {
      const cfg = this.ctx.config();
      const canShow = cfg.enabled && cfg.interactive && cfg.interrupt && !this.ctx.settings().general.dnd;
      if (canShow) {
        void native.hookReply(ev.request_id, 'ack');
        this.ctx.alert('glow', 'claude');
        if (this.ctx.settings().general.sounds) chime('attention');
      } else {
        // Nobody will see the card: let the terminal ask right away.
        this.hooks.take(ev.request_id);
        void native.hookReply(ev.request_id, 'decline');
      }
    }
    if (kind === 'stop' && sid) {
      // With a request id the hook waits on us: decide first, so a watched chat never flashes a card.
      if (ev.request_id) void this.onStop(ev.request_id, sid, ev).finally(() => this.markFinished(sid, ev));
      else this.markFinished(sid, ev);
    }
    if (kind === 'prompt' && sid) {
      this.finished.delete(sid);
      this.looking.delete(sid);
    }
    // A question or a notification is the chat asking for the user: say so, with what it asks.
    if (sid && ((kind === 'tool' && ev.tool_name === 'AskUserQuestion' && ev.hook_event_name === 'PreToolUse') || kind === 'note')) {
      if (kind === 'note' && ev.notification_type === 'idle_prompt') {
        this.ctx.surface({ key: `note:${sid}`, ms: 6000, level: 'expanded', bump: false });
      } else {
        this.ctx.surface({ key: `note:${sid}`, ms: 15000, level: 'expanded' });
        this.ctx.alert('glow', 'claude');
      }
    }
    this.pollSoon(150);
    this.ctx.update();
  }

  // ---------------------------------------------------------------- the reply window

  /**
   * A chat finished and its Stop hook asks whether to wait. Wait only when the
   * user is not looking at that chat: then the card shows its last message and
   * a reply box, and a reply typed there continues the same chat. The answer
   * must come within the pipe's 900 ms, so this decides from what is known now.
   */
  private async onStop(requestId: string, sid: string, ev: HookEvent): Promise<void> {
    const o = this.opts();
    const cfg = this.ctx.config();
    const pass = (why: string) => {
      this.hooks.takeHold(requestId);
      void native.hookReply(requestId, 'pass');
      this.ctx.log('stop', { session: sid.slice(0, 8), held: false, why });
    };
    if (o.replyWindowSeconds <= 0 || !cfg.enabled || !cfg.interactive || this.ctx.settings().general.dnd) return pass('off');
    let looking = false;
    try {
      looking = await this.isLookingAt(sid, ev);
    } catch (err) {
      this.ctx.log('stop: foreground check failed', String(err));
    }
    if (looking) {
      this.looking.add(sid);
      this.ctx.update();
      return pass('looking');
    }
    this.looking.delete(sid);
    const total = o.replyWindowSeconds * 1000;
    const now = Date.now();
    const message = ev.last_assistant_message?.trim() || this.sessions.find((s) => s.id === sid)?.lastAssistantText || '';
    this.hooks.holds = this.hooks.holds.filter((h) => h.sessionId !== sid);
    this.hooks.holds.push({ requestId, sessionId: sid, message, at: now, until: now + total, total, held: false });
    const waiting = await native.hookReply(requestId, `ack:${total}`);
    if (!waiting && !native.demo) {
      this.hooks.takeHold(requestId);
      this.ctx.log('stop: window already closed', { session: sid.slice(0, 8) });
    } else {
      this.ctx.log('stop', { session: sid.slice(0, 8), held: true, seconds: o.replyWindowSeconds });
      this.ctx.alert('glow', 'claude');
      if (this.ctx.settings().general.sounds) chime('attention');
    }
    this.ctx.update();
  }

  /** The process chain of a chat's Claude Code process, itself first. */
  private chainOf(pid: number): number[] {
    const probe = this.tracker?.probe;
    if (!probe || !pid) return pid ? [pid] : [];
    return [pid, ...probe.ancestors(pid).map((a) => a.pid)];
  }

  /**
   * Is the user looking at this chat? Its window must be in front. Several
   * chats can share one window (editor tabs, terminal tabs): then the one the
   * user last sent a prompt to is the one they are in.
   */
  private async isLookingAt(sid: string, ev?: HookEvent): Promise<boolean> {
    const fg = await native.foregroundPid();
    if (!fg || !this.tracker) return false;
    const probe = this.tracker.probe;
    const pidOf = (id: string) => this.sessions.find((s) => s.id === id)?.pid ?? 0;
    const pid = pidOf(sid) || Number(ev?.hook_ppid) || 0;
    if (!pid) return false;
    if (!probe.table.has(pid)) probe.load(await native.procSnapshot());
    if (!this.chainOf(pid).includes(fg)) return false;
    const sharing = this.sessions.filter((s) => s.alive && s.pid && this.chainOf(s.pid).includes(fg));
    if (sharing.length <= 1) return true;
    const lastPrompt = (s: SessionView) => this.hooks.turnStart.get(s.id) ?? s.turnStartMs ?? 0;
    const current = sharing.reduce((a, b) => (lastPrompt(b) > lastPrompt(a) ? b : a));
    return current.id === sid;
  }

  private onForeground(pid: number): void {
    if (!pid) return;
    for (const h of [...this.hooks.holds]) {
      if (h.held) continue;
      const s = this.sessions.find((x) => x.id === h.sessionId);
      if (s && this.chainOf(s.pid).includes(pid)) this.release(h, 'switched to the chat');
    }
  }

  /** Lets the chat end its turn now (the user will answer it some other way, or not at all). */
  private release(h: ReplyHold, why: string): void {
    if (!this.hooks.takeHold(h.requestId)) return;
    void native.hookReply(h.requestId, 'pass');
    if (why === 'switched to the chat') this.looking.add(h.sessionId);
    this.ctx.log('stop released', { session: h.sessionId.slice(0, 8), why });
    this.ctx.update();
  }

  /** Windows the pipe has already closed (a missed hook-expired) must not linger. */
  private expireHolds(): void {
    const now = Date.now();
    const stale = this.hooks.holds.filter((h) => now > h.until + 2000);
    if (!stale.length) return;
    for (const h of stale) this.hooks.takeHold(h.requestId);
    this.ctx.update();
  }

  /** The user clicked into the reply box: the chat keeps waiting while they type. */
  private holdLonger(requestId: string): void {
    const h = this.hooks.hold(requestId);
    if (!h || h.held) return;
    const now = Date.now();
    const until = Math.min(now + HOLD_MS, h.at + HOLD_CEILING_MS);
    if (until <= now + 1000) return;
    h.held = true;
    h.until = until;
    h.total = until - now;
    void native.hookReply(requestId, `hold:${until - now}`);
    this.ctx.update();
  }

  /** A reply typed in the island: through the waiting hook if it still waits, else the next best way. */
  private async sendReply(requestId: string, text: string): Promise<void> {
    const h = this.hooks.takeHold(requestId);
    if (!h) return;
    const delivered = Date.now() < h.until - 300 && (await native.hookReply(requestId, JSON.stringify({ kind: 'reply', text })));
    this.ctx.log('reply', { session: h.sessionId.slice(0, 8), via: delivered ? 'hook' : 'fallback' });
    if (delivered) {
      this.finished.delete(h.sessionId);
      this.hooks.turnStart.set(h.sessionId, Date.now());
      this.flash('Sent. Claude is on it', 'good', 'check');
      this.pollSoon(400);
      return;
    }
    await this.continueSession(h.sessionId, text);
  }

  // ---------------------------------------------------------------- permission answers

  private answer(requestId: string, decision: 'allow' | 'deny', message?: string): void {
    const card = this.hooks.take(requestId);
    if (!card) return;
    this.picks.delete(requestId);
    const reply = decision === 'deny' && message ? JSON.stringify({ kind: 'deny', message }) : decision;
    void native.hookReply(requestId, reply);
    if (decision === 'allow') this.hooks.current.set(card.sessionId, { tool: card.tool, input: card.input, at: Date.now() });
    this.ctx.log('permission', { tool: card.tool, decision, withMessage: Boolean(message) });
    this.ctx.update();
  }

  /** Taps an option. A lone single-choice question is answered at once; otherwise options toggle. */
  private pick(requestId: string, q: number, label: string): void {
    const card = this.hooks.cards.find((c) => c.requestId === requestId);
    if (!card) return;
    const qs = questionsOf(card.input);
    const question = qs[q];
    if (!question) return;
    const chosen = this.picks.get(requestId) ?? new Map<number, string[]>();
    const now = chosen.get(q) ?? [];
    if (question.multiSelect) chosen.set(q, now.includes(label) ? now.filter((x) => x !== label) : [...now, label]);
    else chosen.set(q, [label]);
    this.picks.set(requestId, chosen);
    if (qs.length === 1 && !question.multiSelect) this.sendAnswers(requestId);
    this.ctx.update();
  }

  /** Free text: answers the first question still without an answer. */
  private answerText(requestId: string, text: string): void {
    const card = this.hooks.cards.find((c) => c.requestId === requestId);
    if (!card) return;
    const qs = questionsOf(card.input);
    const chosen = this.picks.get(requestId) ?? new Map<number, string[]>();
    const open = qs.findIndex((_, i) => !(chosen.get(i)?.length));
    chosen.set(open < 0 ? 0 : open, [text]);
    this.picks.set(requestId, chosen);
    if (qs.every((_, i) => chosen.get(i)?.length)) this.sendAnswers(requestId);
    this.ctx.update();
  }

  /** AskUserQuestion answered in the island: the tool runs with these answers filled in. */
  private sendAnswers(requestId: string): void {
    const card = this.hooks.cards.find((c) => c.requestId === requestId);
    if (!card) return;
    const qs = questionsOf(card.input);
    const chosen = this.picks.get(requestId) ?? new Map<number, string[]>();
    if (!qs.length || !qs.every((_, i) => chosen.get(i)?.length)) return;
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => (answers[q.question] = chosen.get(i)!.join(', ')));
    const input = card.input && typeof card.input === 'object' ? (card.input as Record<string, unknown>) : {};
    this.hooks.take(requestId);
    this.picks.delete(requestId);
    void native.hookReply(requestId, JSON.stringify({ kind: 'answer', updatedInput: { ...input, answers } }));
    this.hooks.asks.delete(card.sessionId);
    this.ctx.log('question answered', { session: card.sessionId.slice(0, 8), questions: qs.length });
    this.flash('Answered. Claude is on it', 'good', 'check');
  }

  /** Hands a prompt back to the chat itself and brings that chat up. */
  private async answerInChat(requestId: string): Promise<void> {
    const card = this.hooks.take(requestId);
    this.picks.delete(requestId);
    if (!card) return;
    void native.hookReply(requestId, 'decline');
    await this.switchTo(card.sessionId, 'answer-in-chat');
  }

  /** The island dismissed an urgent moment (tap outside). */
  dismiss(key: string): void {
    const [kind, ref] = splitOnce(key, ':');
    if (kind === 'perm') {
      // Hand the question back to the terminal instead of leaving Claude Code waiting.
      if (this.hooks.take(ref)) void native.hookReply(ref, 'decline');
      this.picks.delete(ref);
    } else if (kind === 'reply') {
      const h = this.hooks.hold(ref);
      if (h) this.release(h, 'dismissed');
    } else if (kind === 'note') {
      this.hooks.notes.delete(ref);
      this.hooks.asks.delete(ref);
    } else if (kind === 'input') {
      this.inputFor = null;
    }
    this.selected = null;
    this.ctx.update();
  }

  // ---------------------------------------------------------------- moments

  private markFinished(id: string, ev?: HookEvent): void {
    const prev = this.finished.get(id);
    if (prev && Date.now() - prev < 5000) return;
    this.finished.set(id, Date.now());
    if (this.opts().onlyOtherChats) void this.announceUnlessLooking(id, ev);
    else this.announceFinished(id);
  }

  /** "Only pop up for other chats": a chat the user is looking at finishes quietly. */
  private async announceUnlessLooking(id: string, ev?: HookEvent): Promise<void> {
    let looking = this.looking.has(id);
    if (!looking) {
      try {
        looking = await this.isLookingAt(id, ev);
      } catch (err) {
        this.ctx.log('finish: foreground check failed', String(err));
      }
    }
    if (!looking) return this.announceFinished(id);
    this.looking.add(id);
    this.ctx.log('finished quietly', { session: id.slice(0, 8) });
    this.ctx.update();
  }

  private announceFinished(id: string): void {
    this.ctx.surface({ key: `done:${id}`, ms: this.opts().finishedSeconds * 1000, level: 'expanded' });
    if (this.ctx.settings().general.sounds) chime('done');
    this.ctx.update();
  }

  private announceNeedsYou(session: SessionView): void {
    this.ctx.surface({ key: `needs:${session.id}`, ms: 7000, level: 'expanded' });
    this.ctx.alert('shake');
    this.ctx.alert('glow', 'claude');
    if (this.opts().notifications) this.ctx.notify(session.displayTitle, `Needs you in ${session.project}. Alt+Shift+0 to switch.`);
  }

  private flash(text: string, tone: Tone, icon = 'info', ms = 3000): void {
    this.notice = { text, tone, icon, until: Date.now() + ms };
    this.ctx.surface({ key: 'notice', ms, level: 'expanded', bump: false });
    this.ctx.update();
  }

  // ---------------------------------------------------------------- switching (main.js)

  async switchTo(id: string, source = 'click'): Promise<boolean> {
    if (id.startsWith('desktop:')) return this.openDesktop(id.slice('desktop:'.length));
    const s = this.tracker?.get(id);
    if (!s || !this.tracker) return false;
    let ok = false;
    try {
      if (!s.alive) ok = await native.claudeResume(s.sessionId, s.cwd, null, false);
      else if (s.kind !== 'bg') {
        ok = await focusSession(
          { sessionId: s.sessionId, pid: s.pid, cwd: s.cwd, title: s.title, name: s.name, entrypoint: s.entrypoint, host: s.editorHost || s.host },
          this.tracker.probe,
          (...p) => this.ctx.log(...p),
        );
      }
    } catch (err) {
      this.ctx.log('switch error', String(err));
    }
    this.ctx.log('switch', { source, session: id, alive: s.alive, ok });
    if (!ok) {
      this.flash(s.kind === 'bg' ? 'Background sessions have no window' : "Couldn't find that window", 'bad', 'alert');
      this.ctx.alert('shake');
    }
    return ok;
  }

  /** Reopen a closed chat where it lived: editor chats by deep link, CLI chats with claude --resume. */
  async reopen(id: string): Promise<boolean> {
    const c = this.tracker?.getClosed(id);
    if (!c || !this.tracker) return false;
    let ok = false;
    try {
      if (c.entrypoint === 'claude-vscode') ok = await this.openInEditor(c.sessionId, c.editorHost ?? null, c.project);
      else ok = await native.claudeResume(c.sessionId, c.cwd, null, false);
    } catch (err) {
      this.ctx.log('reopen error', String(err));
    }
    this.ctx.log('reopen', { session: id, entrypoint: c.entrypoint, ok });
    if (!ok) this.flash("Couldn't reopen that chat", 'bad', 'alert');
    return ok;
  }

  private async openInEditor(sessionId: string, editorHost: string | null, project: string, prompt?: string): Promise<boolean> {
    const probe = this.tracker!.probe;
    probe.load(await native.procSnapshot());
    const host = editorHost || probe.runningEditor() || 'VS Code';
    const url = deepLink(host, sessionId, prompt);
    if (!url) return false;
    const editorPids = [...probe.table].filter(([, p]) => EDITOR_HOSTS.get(p.name) === host).map(([pid]) => pid);
    const hwnd = selectWindow(await native.winEnum(), editorPids, project);
    if (hwnd != null && (await native.activate(hwnd))) await sleep(250);
    await native.allowForeground();
    return native.openUrl(url);
  }

  private async openDesktop(uuid: string): Promise<boolean> {
    const url = chatUrl(uuid);
    if (!url) return false;
    await native.allowForeground();
    const ok = await native.openUrl(url);
    this.ctx.log('desktop open', { chat: uuid, ok });
    if (!ok) this.flash("Couldn't open the Claude app", 'bad', 'alert');
    return ok;
  }

  /** Continue Session: the prompt goes to the same session, wherever it lives. */
  private async continueSession(id: string, text: string): Promise<void> {
    const live = this.tracker?.get(id) ?? null;
    const closed = live ? null : this.tracker?.getClosed(id) ?? null;
    const s = live ?? closed;
    this.inputFor = null;
    if (!s) {
      this.flash('That session is gone', 'bad', 'alert');
      return;
    }
    let ok = false;
    let how = '';
    try {
      if (s.entrypoint === 'claude-vscode') {
        // The editor opens the chat with the text in its box but never sends it; the
        // clipboard covers editors that ignore the prompt parameter.
        await native.clipboardSetText(text);
        ok = await this.openInEditor(s.sessionId, live?.editorHost ?? closed?.editorHost ?? null, s.project, text);
        how = 'editor';
      } else if (live) {
        const r = await native.claudeInject(live.pid, text);
        ok = r.ok;
        how = 'console';
        if (!ok) {
          // The console refused typed input (e.g. mintty): put the prompt on the clipboard and bring the terminal up.
          await native.clipboardSetText(text);
          await this.switchTo(id, 'continue');
          this.flash('Prompt copied: paste it with Ctrl+V', 'warn', 'clipboard', 5000);
          return;
        }
      } else {
        ok = await native.claudeResume(s.sessionId, s.cwd, text, true);
        how = 'resume';
      }
    } catch (err) {
      this.ctx.log('continue error', String(err));
    }
    this.ctx.log('continue', { session: id, how, ok });
    this.finished.delete(id);
    if (ok && how === 'editor') {
      this.flash('Chat opened. Press Enter there to send (also copied)', 'warn', 'enter', 7000);
    } else if (ok) {
      this.hooks.turnStart.set(s.sessionId, Date.now());
      this.flash('Sent. Claude is on it', 'good', 'check');
    } else this.flash("Couldn't send that prompt", 'bad', 'alert');
    this.pollSoon(500);
  }

  // ---------------------------------------------------------------- what the island asks

  private featured(): SessionView | null {
    if (this.selected) return this.sessions.find((s) => s.id === this.selected) ?? null;
    const card = this.hooks.cards[0];
    if (card) {
      const s = this.sessions.find((x) => x.id === card.sessionId);
      if (s) return s;
    }
    const byRecent = [...this.sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return this.sessions.find((s) => s.needsYou) ?? byRecent.find((s) => s.status === 'working') ?? byRecent[0] ?? null;
  }

  /** A question or a notification that still waits on the user, newest first. */
  private waitingNote(): { sessionId: string; at: number } | null {
    const now = Date.now();
    let best: { sessionId: string; at: number } | null = null;
    const consider = (sessionId: string, at: number) => {
      if (now - at > 10 * 60_000) return;
      if (this.hooks.cards.some((c) => c.sessionId === sessionId) || this.hooks.holds.some((h) => h.sessionId === sessionId)) return;
      if (!best || at > best.at) best = { sessionId, at };
    };
    for (const [sid, a] of this.hooks.asks) consider(sid, a.at);
    for (const [sid, n] of this.hooks.notes) if (n.kind !== 'idle_prompt' && n.kind !== 'auth_success') consider(sid, n.at);
    return best;
  }

  status(): ActivityStatus {
    const card = this.hooks.cards[0];
    const hold = this.hooks.holds[0];
    const note = this.waitingNote();
    const needs = this.sessions.filter((s) => s.needsYou);
    const working = this.sessions.filter((s) => s.status === 'working');
    const active =
      this.sessions.length > 0 || !!card || !!hold || !!note || this.inputFor !== null || this.finished.size > 0 || (this.notice !== null && this.notice.until > Date.now());
    if (!active) return { active: false };
    let urgent: ActivityStatus['urgent'] = null;
    if (this.inputFor) urgent = { key: `input:${this.inputFor}`, level: 'maximum' };
    else if (card) urgent = { key: `perm:${card.requestId}`, level: 'expanded' };
    else if (hold) urgent = { key: `reply:${hold.requestId}`, level: 'expanded' };
    else if (note) urgent = { key: `note:${note.sessionId}`, level: 'expanded' };
    else if (needs.length) urgent = { key: `needs:${needs[0].id}`, level: 'expanded' };
    const weight = card || hold || note || needs.length || working.length || this.inputFor ? 'foreground' : 'background';
    // Border light: brisk when a chat waits on the user, slow while Claude works.
    const beam = card || hold || note || needs.length ? { tone: 'claude' as Tone, urgent: true } : working.length ? { tone: 'claude' as Tone } : null;
    const n = this.sessions.length;
    const summary =
      n > 1
        ? `Claude ×${n}${needs.length ? `, ${needs.length} need${needs.length > 1 ? '' : 's'} you` : working.length ? `, ${working.length} working` : ''}`
        : n === 1
          ? `Claude · ${this.sessions[0].label}`
          : 'Claude';
    return { active: true, weight, urgent, summary, beam };
  }

  chip(): ChipView | null {
    const n = this.sessions.length;
    if (!n) return null;
    const needs = this.sessions.some((s) => s.needsYou) || this.hooks.cards.length > 0 || this.hooks.holds.length > 0 || this.waitingNote() !== null;
    const working = this.sessions.some((s) => s.status === 'working');
    return {
      icon: 'claude',
      label: needs ? 'Needs you' : n > 1 ? `×${n}` : this.sessions[0].label,
      dot: needs ? 'claude' : working ? 'good' : 'info',
      pulse: needs,
      tone: 'claude',
    };
  }

  // ---------------------------------------------------------------- views

  render(env: RenderEnv): Seg[] {
    const now = env.now;
    if (this.inputFor) return this.inputView(env);
    const card = this.hooks.cards[0];
    if (card && (env.level === 'maximum' || env.level === 'expanded')) return this.permissionView(card, env);
    const hold = this.hooks.holds[0];
    if (hold && (env.level === 'maximum' || env.level === 'expanded')) return this.replyView(hold, env);
    if (env.surfaced === 'notice' && this.notice && this.notice.until > now) {
      return [
        { t: 'icon', key: 'notice-icon', icon: this.notice.icon, tone: this.notice.tone, prio: 0 },
        { t: 'text', key: 'notice', text: this.notice.text, weight: 'semibold', prio: 0 },
      ];
    }
    if (env.surfaced?.startsWith('done:')) {
      const s = this.sessions.find((x) => x.id === env.surfaced!.slice(5));
      if (s) return this.finishedView(s, env);
    }
    const note = this.waitingNote();
    if (note && (env.level === 'maximum' || env.level === 'expanded')) return this.noteView(note.sessionId, env);
    if (this.sessions.length > 1 && !this.selected) return this.multiView(env);
    const s = this.featured();
    if (!s) return [this.face('idle', MARK), { t: 'text', key: 'none', text: 'Claude', weight: 'semibold', prio: 0 }];
    return this.sessionView(s, env);
  }

  private dot(s: SessionView): Seg {
    return { t: 'dot', key: `dot`, tone: TONE[s.tone] ?? 'muted', pulse: s.needsYou, prio: 0 };
  }

  /**
   * What leads the pill: the avatar in `mood`, or `plain` (a status dot or icon) with the avatar off.
   * Every view gives the avatar the same key, so moving between views morphs the one bot.
   */
  private face(mood: BotMood, plain: Seg): Seg {
    return this.opts().avatar ? { t: 'bot', key: 'face', mood, prio: 0 } : plain;
  }

  private timing(s: SessionView, now: number): string {
    if (s.status === 'working') {
      const start = this.hooks.turnStart.get(s.id) ?? s.turnStartMs ?? s.lastActivityMs;
      return elapsed(now - start);
    }
    return agoText(now - s.lastActivityMs);
  }

  private operation(s: SessionView): string | null {
    const live = this.hooks.current.get(s.id);
    if (live) {
      const d = describeTool(live.tool, live.input);
      return d.detail ? `${d.verb} · ${d.detail}` : d.verb;
    }
    if (s.operation) return s.operation;
    return s.status === 'working' ? 'Thinking' : null;
  }

  private meters(now: number, prioBase: number): Seg[] {
    const d = this.limitsNow(now);
    if (!d || !this.opts().showLimits) return [];
    const out: Seg[] = [];
    if (d.fiveHour) {
      out.push({
        t: 'meter', key: 'limit-s', label: 'S', value: d.fiveHour.pct / 100, pace: pace(d.fiveHour.resetsAt, SESSION_WINDOW_MS, now),
        text: `${Math.round(d.fiveHour.pct)}%`, tone: d.fiveHour.pct >= 90 ? 'bad' : 'claude', w: 96, side: 'end', prio: prioBase,
        tip: `Session limit ${Math.round(d.fiveHour.pct)}%, ${resetsIn(d.fiveHour.resetsAt, now)}`,
      });
    }
    if (d.sevenDay) {
      out.push({
        t: 'meter', key: 'limit-w', label: 'W', value: d.sevenDay.pct / 100, pace: pace(d.sevenDay.resetsAt, WEEK_WINDOW_MS, now),
        text: `${Math.round(d.sevenDay.pct)}%`, tone: d.sevenDay.pct >= 90 ? 'bad' : 'claude', w: 96, side: 'end', prio: prioBase + 1,
        tip: `Weekly limit ${Math.round(d.sevenDay.pct)}%, ${resetsOn(d.sevenDay.resetsAt, now)}`,
      });
    }
    return out;
  }

  private sessionView(s: SessionView, env: RenderEnv): Seg[] {
    const now = env.now;
    const dot = this.dot(s);
    const lead = this.face(moodOf(s), dot);
    const label: Seg = { t: 'text', key: 'label', text: s.status === 'working' ? 'Working…' : s.label, tone: s.needsYou ? 'claude' : 'muted', prio: 1 };
    if (env.level === 'compact' || env.level === 'idle') {
      // Down a side the bot alone says both who and how; without it, the mark and the dot do.
      if (env.vertical) return lead === dot ? [MARK, dot] : [lead];
      return [lead, { t: 'text', key: 'name', text: 'Claude', weight: 'semibold', prio: 0 }, { ...label, side: 'end' }];
    }
    const segs: Seg[] = [
      lead,
      { t: 'text', key: 'title', text: s.displayTitle, weight: 'semibold', prio: 3, max: env.level === 'expanded' ? 170 : 240 },
      { t: 'sep', key: 'sep1', prio: 6 },
      label,
    ];
    const op = this.operation(s);
    if (env.level === 'maximum' && op) segs.push({ t: 'text', key: 'op', text: op, tone: 'muted', prio: 5, max: 220 });
    segs.push({ t: 'sep', key: 'sep2', prio: 6 }, { t: 'text', key: 'time', text: this.timing(s, now), tone: 'muted', prio: 4 });
    if (env.level !== 'maximum') return segs;

    if (this.selected || this.sessions.length > 1) segs.unshift({ t: 'button', key: 'back', icon: 'chevron-left', action: 'back', style: 'ghost', prio: 2, tip: 'All sessions' });
    segs.push(...this.meters(now, 7));
    if (s.status === 'awaiting_input' || s.status === 'interrupted' || s.status === 'errored') {
      segs.push({ t: 'button', key: 'continue', icon: 'enter', label: 'Continue', action: 'continue', arg: s.id, style: 'primary', side: 'end', prio: 1 });
    }
    segs.push({ t: 'button', key: 'open', icon: 'external', action: 'switch', arg: s.id, style: s.needsYou ? 'primary' : 'ghost', side: 'end', prio: 2, tip: `Open ${s.host}${s.slot ? ` (Alt+Shift+${s.slot})` : ''}` });
    return segs;
  }

  private multiView(env: RenderEnv): Seg[] {
    const n = this.sessions.length;
    const needs = this.sessions.filter((s) => s.needsYou).length;
    const working = this.sessions.filter((s) => s.status === 'working').length;
    const tone: Tone = needs ? 'claude' : working ? 'good' : 'info';
    const mood = moodOfAll(this.sessions);
    if (env.level === 'compact' || env.level === 'idle') {
      if (env.vertical) return [this.face(mood, MARK), { t: 'text', key: 'count', text: `×${n}`, weight: 'semibold', prio: 0 }];
      const lead = this.face(mood, { t: 'dot', key: 'dot', tone, pulse: needs > 0, prio: 0 });
      return [
        lead,
        // Beside Claude's face the count says it all, which leaves a small pill room for the status.
        { t: 'text', key: 'name', text: lead.t === 'bot' ? `×${n}` : `Claude ×${n}`, weight: 'semibold', prio: 0 },
        { t: 'text', key: 'label', text: needs ? `${needs} need${needs > 1 ? '' : 's'} you` : working ? `${working} working` : 'Your turn', tone: needs ? 'claude' : 'muted', side: 'end', prio: 3 },
      ];
    }
    const segs: Seg[] = [this.face(mood, MARK)];
    this.sessions.forEach((s, i) => {
      segs.push({
        t: 'chip',
        key: `s-${s.id}`,
        label: env.level === 'maximum' ? `${clip(s.displayTitle, 26)} · ${s.status === 'working' ? 'Working' : s.label}` : clip(s.displayTitle, 18),
        dot: TONE[s.tone] ?? 'muted',
        pulse: s.needsYou,
        badge: s.slot ? String(s.slot) : undefined,
        action: 'select',
        arg: s.id,
        prio: 2 + i,
        max: env.level === 'maximum' ? 230 : 150,
        tip: `${s.displayTitle}\n${s.label} · ${s.project}${s.slot ? `\nAlt+Shift+${s.slot}` : ''}`,
      });
    });
    if (env.level === 'maximum') {
      segs.push(...this.meters(env.now, 12));
    }
    return segs;
  }

  /** What a permission card asks, in a few words. */
  private askOf(card: PermissionCard): string {
    if (card.tool === 'AskUserQuestion') {
      const n = questionsOf(card.input).length;
      return n > 1 ? `Claude has ${n} questions` : 'Claude is asking';
    }
    if (card.tool === 'Bash' || card.tool === 'PowerShell') return 'Run this command?';
    return `Allow ${describeTool(card.tool, card.input).verb.toLowerCase()}?`;
  }

  /** The pill row says what is asked; the card under it carries the detail and the answers. */
  private permissionView(card: PermissionCard, env: RenderEnv): Seg[] {
    const s = this.sessions.find((x) => x.id === card.sessionId);
    const more = this.hooks.cards.length - 1;
    const segs: Seg[] = [
      this.face('needs-you', { t: 'icon', key: 'perm-icon', icon: card.tool === 'AskUserQuestion' ? 'chat' : 'claude', tone: 'claude', anim: 'pulse', prio: 0 }),
      { t: 'text', key: 'perm-ask', text: this.askOf(card), weight: 'semibold', prio: 0 },
      { t: 'text', key: 'perm-title', text: s?.displayTitle || baseName(card.cwd) || 'Claude Code', tone: 'muted', prio: 4, max: env.vertical ? 60 : 200 },
    ];
    if (more > 0) segs.push({ t: 'chip', key: 'perm-more', label: `+${more}`, side: 'end', prio: 7, tip: `${more} more waiting` });
    return segs;
  }

  private replyView(h: ReplyHold, env: RenderEnv): Seg[] {
    const s = this.sessions.find((x) => x.id === h.sessionId);
    return [
      this.face('done', { t: 'icon', key: 'reply-icon', icon: 'check', tone: 'good', prio: 0 }),
      { t: 'text', key: 'reply-done', text: 'Claude finished', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'reply-title', text: s?.displayTitle ?? 'your chat', tone: 'muted', prio: 4, max: env.vertical ? 60 : 220 },
    ];
  }

  private finishedView(s: SessionView, env: RenderEnv): Seg[] {
    const segs: Seg[] = [
      this.face('done', { t: 'icon', key: 'done-icon', icon: 'check', tone: 'good', prio: 0 }),
      { t: 'text', key: 'done', text: 'Claude finished', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'done-title', text: s.displayTitle, tone: 'muted', prio: 4, max: 200 },
    ];
    if (env.level === 'maximum' && s.lastAssistantText) segs.push({ t: 'text', key: 'done-text', text: s.lastAssistantText, tone: 'dim', size: 'sm', prio: 7, max: 320, tip: s.lastAssistantText });
    if (env.level !== 'compact') {
      segs.push(
        { t: 'button', key: 'continue', icon: 'enter', label: 'Continue', action: 'continue', arg: s.id, style: 'primary', side: 'end', prio: 1 },
        { t: 'button', key: 'open', icon: 'external', action: 'switch', arg: s.id, style: 'ghost', side: 'end', prio: 3, tip: `Open ${s.host}` },
      );
    }
    return segs;
  }

  private inputView(env: RenderEnv): Seg[] {
    const id = this.inputFor!;
    const s = this.tracker?.get(id) ?? this.tracker?.getClosed(id) ?? this.sessions.find((x) => x.id === id) ?? null;
    void env;
    return [
      this.face('listening', { t: 'icon', key: 'in-icon', icon: 'claude', tone: 'claude', prio: 0 }),
      { t: 'input', key: 'prompt', placeholder: `Continue ${clip(s?.displayTitle ?? 'this session', 40)}…`, action: 'send', cancel: 'cancel-input', prio: 0, min: 220 },
      { t: 'button', key: 'in-cancel', icon: 'x', action: 'cancel-input', style: 'ghost', side: 'end', prio: 1, tip: 'Cancel (Esc)' },
    ];
  }

  private noteView(sid: string, env: RenderEnv): Seg[] {
    const s = this.sessions.find((x) => x.id === sid);
    const ask = this.hooks.asks.get(sid);
    return [
      this.face('needs-you', { t: 'icon', key: 'note-icon', icon: ask ? 'chat' : 'bell', tone: 'claude', anim: 'pulse', prio: 0 }),
      { t: 'text', key: 'note-what', text: ask ? 'Claude is asking' : 'Claude needs you', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'note-title', text: s?.displayTitle ?? 'a chat', tone: 'muted', prio: 4, max: env.vertical ? 60 : 220 },
    ];
  }

  // ---------------------------------------------------------------- the card under the pill

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason === 'urgent') {
      const card = this.hooks.cards[0];
      if (card) return card.tool === 'AskUserQuestion' ? this.questionSheet(card) : this.permissionSheet(card);
      const hold = this.hooks.holds[0];
      if (hold) return this.replySheet(hold);
      const note = this.waitingNote();
      if (note) return this.noteSheet(note.sessionId);
      const needs = this.sessions.find((s) => s.needsYou);
      return needs ? this.noteSheet(needs.id) : null;
    }
    if (env.reason === 'surfaced') {
      const key = env.surfaced ?? '';
      if (key.startsWith('done:')) return this.looking.has(key.slice(5)) ? null : this.finishedSheet(key.slice(5));
      if (key.startsWith('note:')) return this.noteSheet(key.slice(5));
      return null;
    }
    if (env.reason === 'hover') return this.hoverSheet(env);
    return null;
  }

  private where(s: SessionView | null | undefined, ...extra: Array<string | null | undefined>): string {
    return [...extra, s?.project, s?.host].filter(Boolean).join(' · ');
  }

  private permissionSheet(card: PermissionCard): SheetView {
    const s = this.sessions.find((x) => x.id === card.sessionId);
    const i = (card.input && typeof card.input === 'object' ? card.input : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
    const shell = card.tool === 'Bash' || card.tool === 'PowerShell';
    const detail = shell
      ? str('command')
      : str('file_path') || str('notebook_path') || str('url') || str('pattern') || str('query') || describeTool(card.tool, card.input).detail || '';
    const more = this.hooks.cards.length - 1;
    const title = s?.displayTitle || baseName(card.cwd) || 'Claude Code';
    const blocks: Block[] = [{ t: 'head', key: 'h', icon: 'claude', tone: 'claude', title: this.askOf(card), sub: [title, s?.host, more > 0 ? `${more} more waiting` : null].filter(Boolean).join(' · ') }];
    if (detail) blocks.push({ t: 'code', key: 'detail', text: detail });
    if (shell && str('description')) blocks.push({ t: 'text', key: 'why', text: str('description'), tone: 'muted', size: 'sm' });
    blocks.push(
      { t: 'input', key: 'deny-why', placeholder: 'Or tell Claude what to do instead…', action: `deny-with:${card.requestId}` },
      {
        t: 'buttons',
        key: 'answer',
        items: [
          { key: 'deny', label: 'Deny', icon: 'x', action: 'deny', arg: card.requestId, style: 'danger' },
          { key: 'allow', label: this.opts().requireHello ? 'Allow with Hello' : 'Allow', icon: 'check', action: 'allow', arg: card.requestId, style: 'primary' },
        ],
      },
      { t: 'countdown', key: 'left', until: card.at + PERMISSION_MS, total: PERMISSION_MS },
    );
    return { key: `perm:${card.requestId}`, blocks };
  }

  private questionSheet(card: PermissionCard): SheetView {
    const s = this.sessions.find((x) => x.id === card.sessionId);
    const qs = questionsOf(card.input);
    const chosen = this.picks.get(card.requestId);
    const blocks: Block[] = [{ t: 'head', key: 'h', icon: 'chat', tone: 'claude', title: this.askOf(card), sub: [s?.displayTitle || baseName(card.cwd), s?.host].filter(Boolean).join(' · ') }];
    qs.forEach((q, n) => {
      blocks.push({ t: 'text', key: `q${n}`, text: q.header ? `${q.header} · ${q.question}` : q.question });
      blocks.push({
        t: 'choices',
        key: `o${n}`,
        items: (q.options ?? []).map((o, j) => ({
          key: `o${n}-${j}`,
          label: o.label,
          detail: o.description,
          selected: chosen?.get(n)?.includes(o.label) ?? false,
          action: 'pick',
          arg: { requestId: card.requestId, q: n, label: o.label },
        })),
      });
    });
    const open = qs.findIndex((_, n) => !chosen?.get(n)?.length);
    const target = open < 0 ? null : qs[open];
    blocks.push({
      t: 'input',
      key: 'own',
      placeholder: qs.length > 1 && target ? `Your own answer to "${clip(target.header || target.question, 28)}"…` : 'Or type your own answer…',
      action: `answer-text:${card.requestId}`,
    });
    const buttons: SheetButton[] = [{ key: 'chat', label: 'Answer in the chat', icon: 'external', action: 'answer-in-chat', arg: card.requestId, style: 'ghost' }];
    if (qs.length > 1 || qs.some((q) => q.multiSelect)) {
      buttons.push({ key: 'send', label: 'Send answers', icon: 'send', action: 'answer', arg: card.requestId, style: qs.length > 0 && open < 0 ? 'primary' : 'secondary' });
    }
    blocks.push({ t: 'buttons', key: 'b', items: buttons }, { t: 'countdown', key: 'left', until: card.at + PERMISSION_MS, total: PERMISSION_MS });
    return { key: `ask:${card.requestId}`, blocks };
  }

  private replySheet(h: ReplyHold): SheetView {
    const s = this.sessions.find((x) => x.id === h.sessionId);
    const text = plainText(h.message || this.hooks.lastMessage.get(h.sessionId)?.text || s?.lastAssistantText || '') || 'Claude finished its turn.';
    return {
      key: `reply:${h.requestId}`,
      blocks: [
        {
          t: 'head',
          key: 'h',
          icon: 'check',
          tone: 'good',
          title: s?.displayTitle || 'Claude finished',
          sub: this.where(s, 'Finished'),
          buttons: [{ key: 'open', icon: 'external', action: 'open-chat', arg: h.requestId, style: 'ghost', tip: `Open ${s?.host ?? 'the chat'}` }],
        },
        { t: 'text', key: 'msg', text, bubble: true, lines: 9 },
        {
          t: 'input',
          key: 'reply',
          placeholder: 'Reply to this chat…',
          action: `reply:${h.requestId}`,
          engage: `hold:${h.requestId}`,
          hint: h.held ? 'The chat waits while you type. Enter sends it there.' : 'Enter sends it straight into this chat.',
        },
        { t: 'countdown', key: 'left', until: h.until, total: h.total, tone: h.held ? 'good' : 'claude' },
      ],
    };
  }

  /** A finished chat after its reply window: the reply goes through the editor, the terminal or a resume. */
  private finishedSheet(sid: string): SheetView | null {
    const s = this.sessions.find((x) => x.id === sid) ?? null;
    const last = this.hooks.lastMessage.get(sid);
    const text = plainText(last?.text || s?.lastAssistantText || '');
    if (!s || !text) return null;
    // Already going again (a reply from the island, or a prompt typed in the chat): nothing to answer.
    if (s.status === 'working' || (this.hooks.turnStart.get(sid) ?? 0) > (last?.at ?? 0)) return null;
    return {
      key: `done:${sid}`,
      blocks: [
        {
          t: 'head',
          key: 'h',
          icon: 'check',
          tone: 'good',
          title: s.displayTitle,
          sub: this.where(s, 'Finished'),
          buttons: [{ key: 'open', icon: 'external', action: 'switch', arg: sid, style: 'ghost', tip: `Open ${s.host}` }],
        },
        { t: 'text', key: 'msg', text, bubble: true, lines: 7 },
        { t: 'input', key: 'reply', placeholder: 'Reply to this chat…', action: `continue:${sid}`, engage: `keep:${sid}`, hint: this.lateHint(s) },
      ],
    };
  }

  private lateHint(s: SessionView): string {
    if (!s.alive) return 'Reopens the chat in a terminal with your reply.';
    if (s.entrypoint === 'claude-vscode') return `Opens the chat in ${s.editorHost || s.host} with your reply ready: press Enter there.`;
    return 'Types your reply into its terminal and sends it.';
  }

  /** A chat waiting on the user without a prompt the island can answer: show what it asks. */
  private noteSheet(sid: string): SheetView | null {
    const s = this.sessions.find((x) => x.id === sid) ?? null;
    const ask = this.hooks.asks.get(sid);
    const note = this.hooks.notes.get(sid);
    const blocks: Block[] = [
      { t: 'head', key: 'h', icon: ask ? 'chat' : 'bell', tone: 'claude', title: ask ? 'Claude is asking' : note?.title || 'Claude needs you', sub: [s?.displayTitle, s?.host].filter(Boolean).join(' · ') },
    ];
    if (ask) {
      ask.questions.forEach((q, n) => {
        blocks.push({ t: 'text', key: `q${n}`, text: q.header ? `${q.header} · ${q.question}` : q.question });
        if (q.options?.length) blocks.push({ t: 'rows', key: `o${n}`, items: q.options.map((o, j) => ({ key: `o${n}-${j}`, icon: 'chevron-right', title: o.label, detail: o.description })) });
      });
    } else if (note) {
      blocks.push({ t: 'text', key: 'msg', text: note.message });
    } else if (s) {
      const op = this.operation(s);
      blocks.push({ t: 'text', key: 'msg', text: op ? `Waiting on you: ${op}` : 'Waiting on you in the chat.', tone: 'muted' });
    } else return null;
    blocks.push({ t: 'buttons', key: 'b', items: [{ key: 'open', label: `Open ${s?.host ?? 'the chat'}`, icon: 'external', action: 'switch', arg: sid, style: 'primary' }] });
    return { key: `note:${sid}:${ask?.at ?? note?.at ?? 0}`, blocks };
  }

  /** Hovering Claude: limits with pace, this week's tokens, every chat, recent closed ones. */
  private hoverSheet(env: SheetEnv): SheetView {
    const now = env.now;
    const blocks: Block[] = [];
    const d = this.limitsNow(now);
    const tone = (pct: number): Tone => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'claude');
    if (d?.fiveHour) {
      blocks.push({
        t: 'meter', key: 'limit-s', label: 'Session (5 h)', value: d.fiveHour.pct / 100, pace: pace(d.fiveHour.resetsAt, SESSION_WINDOW_MS, now),
        text: `${Math.round(d.fiveHour.pct)}%`, sub: d.fiveHour.resetsAt == null ? 'Reset. A new window starts with your next message' : resetsIn(d.fiveHour.resetsAt, now), tone: tone(d.fiveHour.pct), tip: 'The white tick shows how far into the 5-hour window you are.',
      });
    }
    if (d?.sevenDay) {
      blocks.push({
        t: 'meter', key: 'limit-w', label: 'Week', value: d.sevenDay.pct / 100, pace: pace(d.sevenDay.resetsAt, WEEK_WINDOW_MS, now),
        text: `${Math.round(d.sevenDay.pct)}%`, sub: d.sevenDay.resetsAt == null ? 'Reset. A new week starts with your next message' : resetsOn(d.sevenDay.resetsAt, now), tone: tone(d.sevenDay.pct), tip: 'The white tick shows how far into the week you are.',
      });
    }
    for (const m of d?.models ?? []) {
      blocks.push({ t: 'meter', key: `limit-${m.name}`, label: `${m.name} (week)`, value: m.pct / 100, text: `${Math.round(m.pct)}%`, tone: tone(m.pct) });
    }
    if (!d) blocks.push({ t: 'text', key: 'limits-none', text: this.usageState?.message ?? 'Limits not loaded yet', tone: 'muted', size: 'sm' });
    const t = this.tokenTotals;
    if (t) {
      blocks.push({
        t: 'stats',
        key: 'tokens',
        items: [
          { key: 'fresh', label: 'Tokens this week', value: fmtTokens(t.fresh), tip: 'Input, output and cache writes since the weekly window began' },
          { key: 'out', label: 'Output', value: fmtTokens(t.output) },
          { key: 'cache', label: 'Cache reads', value: fmtTokens(t.cached) },
        ],
      });
    }
    if (this.sessions.length) {
      blocks.push({
        t: 'rows',
        key: 'sessions',
        items: this.sessions.map((s): SheetRow => ({
          key: s.id,
          dot: TONE[s.tone] ?? 'muted',
          pulse: s.needsYou,
          title: s.displayTitle,
          detail: [s.status === 'working' ? 'Working' : s.label, s.project, this.timing(s, now)].filter(Boolean).join(' · '),
          badge: s.slot ? String(s.slot) : undefined,
          action: 'switch',
          arg: s.id,
          tip: `Open ${s.host}${s.slot ? ` (Alt+Shift+${s.slot})` : ''}`,
          button: { key: 'hide', icon: 'x', action: 'hide-session', arg: s.sessionId, style: 'ghost', tip: 'Hide this chat from Island' },
        })),
      });
    } else blocks.push({ t: 'text', key: 'sessions-none', text: 'No Claude Code chats open', tone: 'muted', size: 'sm' });
    const closed = this.closed.slice(0, 3);
    if (closed.length) {
      blocks.push(
        { t: 'head', key: 'closed-h', title: 'Closed recently', buttons: [{ key: 'clear', label: 'Clear', action: 'clear-closed', style: 'ghost', tip: 'Start this list fresh' }] },
        {
          t: 'rows',
          key: 'closed',
          items: closed.map((c) => ({
            key: c.id, icon: 'history', title: c.displayTitle, detail: `Closed ${agoText(now - c.closedAt)} · ${c.project}`, action: 'reopen', arg: c.id,
            tip: `Reopens in ${c.entrypoint === 'claude-vscode' ? c.editorHost || 'your editor' : 'a new terminal'}`,
          })),
        },
      );
    }
    if (this.opts().showDesktop && this.chats.length) {
      blocks.push(
        { t: 'text', key: 'app-h', text: 'Claude app', tone: 'muted', size: 'sm' },
        {
          t: 'rows',
          key: 'app',
          items: this.chats.slice(0, 3).map((c) => ({ key: c.uuid, icon: 'chat', title: c.displayTitle, detail: c.label ?? `Updated ${agoText(now - c.updatedAt)}`, action: 'open-desktop', arg: c.uuid })),
        },
      );
    }
    const hiddenCount = this.opts().hiddenSessions.length;
    if (hiddenCount) {
      blocks.push({ t: 'buttons', key: 'hidden', align: 'start', items: [{ key: 'unhide', label: `Show hidden (${hiddenCount})`, icon: 'eye', action: 'unhide-all', style: 'ghost' }] });
    }
    return { key: 'hover', blocks };
  }

  /** Claude's cell in the open island: limits in the label, the chats as rows. */
  tile(env: SheetEnv): Tile | null {
    // Without Claude Code on this PC there is nothing to show: no empty Claude cell for people who don't use it.
    if (!this.env && !native.demo) return null;
    const now = env.now;
    const d = this.limitsNow(now);
    const limits = [d?.fiveHour ? `S ${Math.round(d.fiveHour.pct)}%` : null, d?.sevenDay ? `W ${Math.round(d.sevenDay.pct)}%` : null].filter(Boolean).join(' · ');
    const rows: SheetRow[] = this.sessions.slice(0, 3).map((s) => ({
      key: s.id,
      dot: TONE[s.tone] ?? 'muted',
      pulse: s.needsYou,
      title: s.displayTitle,
      detail: `${s.status === 'working' ? 'Working' : s.label} · ${this.timing(s, now)}`,
      action: 'switch',
      arg: s.id,
    }));
    return {
      key: 'claude',
      span: 2,
      rows: this.sessions.length > 1 ? 2 : 1,
      tone: 'claude',
      body: {
        k: 'list',
        icon: 'claude',
        label: limits ? `Claude Code · ${limits}` : 'Claude Code',
        rows,
        empty: this.tokenTotals ? `No chats open · ${fmtTokens(this.tokenTotals.fresh)} tokens this week` : 'No chats open',
      },
    };
  }

  // ---------------------------------------------------------------- actions

  async action(name: string, arg: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : '';
    // Card inputs name their target after a colon ("reply:<request id>"); the typed text is the arg.
    const [verb, ref] = splitOnce(name, ':');
    switch (verb) {
      case 'select':
        this.selected = id;
        this.ctx.open();
        break;
      case 'back':
        this.selected = null;
        break;
      case 'switch':
        await this.switchTo(id);
        break;
      case 'continue':
        if (ref) {
          // A reply typed on a finished chat's card, after its reply window.
          if (id.trim()) await this.continueSession(ref, id.trim());
          break;
        }
        this.inputFor = id;
        this.finished.delete(id);
        this.ctx.open();
        break;
      case 'keep':
        // The user is typing on a finished chat's card: keep it up.
        this.ctx.surface({ key: `done:${ref}`, ms: 120_000, level: 'expanded', bump: false });
        break;
      case 'reply':
        if (id.trim()) await this.sendReply(ref, id.trim());
        break;
      case 'hold':
        this.holdLonger(ref);
        break;
      case 'open-chat': {
        const h = this.hooks.hold(id);
        if (h) {
          this.release(h, 'switched to the chat');
          await this.switchTo(h.sessionId, 'reply-card');
        }
        break;
      }
      case 'deny-with':
        if (id.trim()) this.answer(ref, 'deny', id.trim());
        break;
      case 'pick': {
        const p = (arg ?? {}) as { requestId?: unknown; q?: unknown; label?: unknown };
        if (typeof p.requestId === 'string' && typeof p.q === 'number' && typeof p.label === 'string') this.pick(p.requestId, p.q, p.label);
        break;
      }
      case 'answer':
        this.sendAnswers(id);
        break;
      case 'hide-session': {
        const hidden = this.opts().hiddenSessions;
        if (id && !hidden.includes(id)) this.ctx.setOptions?.({ hiddenSessions: [...hidden, id] });
        this.sessions = this.sessions.filter((s) => s.sessionId !== id);
        this.closed = this.closed.filter((c) => c.sessionId !== id);
        break;
      }
      case 'unhide-all':
        this.ctx.setOptions?.({ hiddenSessions: [] });
        this.pollSoon(50);
        break;
      case 'clear-closed':
        this.ctx.setOptions?.({ closedClearedAt: Date.now() });
        this.closed = [];
        break;
      case 'answer-text':
        if (id.trim()) this.answerText(ref, id.trim());
        break;
      case 'answer-in-chat':
        await this.answerInChat(id);
        break;
      case 'send':
        if (this.inputFor && id.trim()) await this.continueSession(this.inputFor, id.trim());
        break;
      case 'cancel-input':
        this.inputFor = null;
        break;
      case 'allow': {
        const card = this.hooks.cards.find((c) => c.requestId === id);
        if (!card) break;
        // The user asked for Windows Hello before any Allow: no confirmation, no Allow.
        if (this.opts().requireHello && !(await requireHello(`Allow Claude Code: ${this.askOf(card)}`))) {
          this.flash('Not allowed: Windows Hello did not confirm it', 'warn', 'lock', 4000);
          break;
        }
        this.answer(id, 'allow');
        break;
      }
      case 'deny':
        this.answer(id, 'deny');
        break;
      case 'reopen':
        await this.reopen(id);
        break;
      case 'open-desktop':
        await this.openDesktop(id);
        break;
    }
    this.ctx.update();
  }

  // ---------------------------------------------------------------- hotkeys + tray (main.js)

  hotkeys(): Array<{ id: string; accel: string }> {
    if (!this.opts().sessionHotkeys) return [];
    const keys = Array.from({ length: 9 }, (_, i) => ({ id: `claude.slot.${i + 1}`, accel: `Alt+Shift+${i + 1}` }));
    keys.push({ id: 'claude.needs', accel: 'Alt+Shift+0' });
    return keys;
  }

  async hotkey(id: string): Promise<void> {
    if (!this.tracker) return;
    if (id === 'claude.needs') {
      const s = this.tracker.firstNeedingYou();
      this.ctx.log('hotkey', 'Alt+Shift+0', s ? s.id : 'nobody needs you');
      if (!s) {
        this.flash('Nobody needs you right now', 'muted', 'check');
        return;
      }
      await afterModifiersReleased();
      await this.switchTo(s.id, 'hotkey');
      return;
    }
    const n = Number(id.split('.').pop());
    const s = this.tracker.bySlot(n);
    this.ctx.log('hotkey', `Alt+Shift+${n}`, s ? s.id : 'no session in that slot');
    if (!s) return;
    this.selected = s.id;
    this.ctx.surface({ key: `slot:${s.id}`, ms: 2200, level: 'expanded' });
    await afterModifiersReleased();
    await this.switchTo(s.id, 'hotkey');
  }

  tray(): { tooltip: string[]; alert: boolean; menu: MenuItem[] } {
    const d = this.limitsNow();
    const tooltip: string[] = [];
    if (d?.fiveHour) tooltip.push(`Session ${Math.round(d.fiveHour.pct)}%, ${resetText(d.fiveHour.resetsAt, false)}`);
    if (d?.sevenDay) tooltip.push(`Week ${Math.round(d.sevenDay.pct)}%, ${resetText(d.sevenDay.resetsAt, true)}`);
    const needs = this.sessions.filter((s) => s.needsYou).length;
    if (needs) tooltip.push(`${needs} session${needs > 1 ? 's' : ''} need${needs > 1 ? '' : 's'} you`);
    const menu: MenuItem[] = this.sessions
      .slice(0, 12)
      .map((s) => ({ id: `switch|${s.id}`, label: `${s.slot ? `${s.slot}  ` : ''}${clip(s.displayTitle, 40)}  (${s.label})` }));
    if (!menu.length) menu.push({ label: 'No Claude Code sessions running', enabled: false });
    if (this.chats.length) menu.push({ label: 'Claude app chats', items: this.chats.map((c) => ({ id: `open-desktop|${c.uuid}`, label: clip(c.displayTitle, 44) })) });
    const now = Date.now();
    menu.push({
      label: 'Closed chats',
      items: this.closed.length ? this.closed.slice(0, 10).map((c) => ({ id: `reopen|${c.id}`, label: `${clip(c.displayTitle, 40)}  (closed ${agoText(now - c.closedAt)})` })) : [{ label: 'None in the last day', enabled: false }],
    });
    return { tooltip, alert: needs > 0 || this.hooks.cards.length > 0, menu };
  }

  // ---------------------------------------------------------------- app window

  async command(cmd: string, arg: unknown): Promise<unknown> {
    switch (cmd) {
      case 'snapshot':
        return {
          available: Boolean(this.env) || native.demo,
          env: this.env,
          usage: this.usageState ? { ...this.usageState, data: this.limitsNow() } : null,
          tokens: this.tokenTotals,
          sessions: this.sessions,
          closed: this.closed,
          chats: this.chats,
          cards: this.hooks.cards.length,
          hooksSeenAt: this.hooks.lastEventAt,
          hooks: await native.hooksStatus(),
          nextUsageAt: this.usage?.nextAt ?? null,
        };
      case 'hooks-preview':
        return native.hooksPreview(Boolean(arg));
      case 'hooks-write': {
        const a = (arg ?? {}) as { install?: boolean; fingerprint?: string };
        return native.hooksWrite(Boolean(a.install), String(a.fingerprint ?? ''));
      }
      case 'refresh':
        await this.usage?.maybePoll(true);
        this.usageState = this.usage?.state ?? this.usageState;
        await this.pollTokens();
        return true;
      case 'test-alert': {
        const s = this.sessions[0];
        if (s) this.announceNeedsYou({ ...s, displayTitle: `${s.displayTitle} (test)` });
        else {
          this.ctx.alert('shake');
          this.ctx.alert('glow', 'claude');
          this.flash('Test alert: a session that needs you looks like this', 'claude', 'bell', 4000);
        }
        return true;
      }
      case 'switch':
        return this.switchTo(String(arg));
      case 'reopen':
        return this.reopen(String(arg));
      case 'open-desktop':
        return this.openDesktop(String(arg));
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- browser demo

  private demo(): void {
    const now = Date.now();
    const base = (over: Partial<SessionView>): SessionView => ({
      id: '', sessionId: '', pid: 0, cwd: 'C:\\Users\\you\\Projects\\island', name: '', kind: 'interactive', entrypoint: 'cli', alive: true,
      status: 'working', label: 'Working', tone: 'working', needsYou: false, title: null, displayTitle: '', project: 'island', host: 'Terminal',
      editorHost: null, hostKind: 'terminal', model: 'Opus 5.5', permissionMode: 'default', gitBranch: 'main', lastActivityMs: now, lastAliveAt: now,
      slot: 1, tool: null, operation: null, turnStartMs: now - 754000, lastAssistantText: null, transcript: null, version: null, ...over,
    });
    this.later(2500, () => {
      this.sessions = [
        base({ id: 'a1', sessionId: 'a1', displayTitle: 'Implement the island UI', operation: 'Editing renderer.ts', slot: 1 }),
        base({ id: 'b2', sessionId: 'b2', displayTitle: 'Schedule Matcher export', status: 'awaiting_input', label: 'Your turn', tone: 'turn', project: 'schedule-matcher', slot: 2, lastActivityMs: now - 180000, lastAssistantText: 'Added the CSV export and tests.' }),
      ];
      this.usageState = { data: { fiveHour: { pct: 41, resetsAt: now + 3 * 3600000 }, sevenDay: { pct: 60, resetsAt: now + 5 * 86400000 }, models: [] }, error: null, source: 'api', fetchedAt: now };
      this.tokenTotals = { fresh: 4100000, cached: 182000000, output: 900000 };
      this.ctx.update();
    });
  }
}
