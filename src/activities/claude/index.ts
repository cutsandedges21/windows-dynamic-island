// The Claude activity, shown as Claude Status: every Claude session at a glance (Claude Code,
// the Claude app and claude.ai in Chrome, Justin's Claude Sessions widget, worked out by
// ../claude-status) and Claude Code answered from the island (Moss's: the logic is Usage
// Clip's main.js orchestration, plus hooks for permission prompts, Claude's questions and the
// reply window, where a finished chat waits briefly for a reply typed here, which then lands in
// that same chat). Claude Code and Claude Status were two activities until 2026-11; Claude
// Code's own features are now options of this one (Activities › Claude Status › Claude Code).
// Every moment pops the island once, however many ways it is reported (moments.ts). On a
// phone, its card is a chat with Claude (phonechat.ts). The views are the island's own.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../../core/activity';
import { agoText, baseName, clip, pace, plainText, resetsIn, resetsOn, SESSION_WINDOW_MS, tokens as fmtTokens, WEEK_WINDOW_MS } from '../../core/format';
import { requireHello } from '../../core/hello';
import { native, type ClaudeEnv, type MenuItem } from '../../core/native';
import type { PetSignal } from '../../core/pet';
import type { Seg, Tone } from '../../core/segments';
import { growsOf, hiddenNow, type Grows } from '../../core/settings';
import type { Block, SheetButton, SheetRow, SheetView, Tile } from '../../core/sheet';
import { PhoneError } from '../../remote/hub';
import type { TermInfo } from '../../remote/protocol';
import { BaseActivity, chime } from '../base';
import { sessionCount, SHOW_MS, statusRows, statusSegments, statusSub, toneOf, waitingRows } from '../claude-status';
import { StatusEngine, type StatusRow, type StatusState } from '../claude-status/engine';
import { chatUrl, DesktopChats, type DesktopChat } from './desktop';
import { afterModifiersReleased, deepLink, focusSession, selectWindow } from './focus';
import { HookState, questionsOf, type HookEvent, type PermissionCard, type ReplyHold } from './hooks';
import { MomentGate } from './moments';
import { claudeArgs, oneLine, recentFolders, routeFor, routeHint, sameText, terminalFor, type ChatPane, type ChatRoute } from './phonechat';
import { EDITOR_HOSTS } from './procinfo';
import { askText, permissionText, PushGate, pushFor, type PushKind } from './pushes';
import { describeTool, joinPath, projectName } from './status';
import { ClosedHistory, findTranscript, SessionTracker, type ClosedView, type SessionView, type TrackerEvent } from './tracker';
import { readChat, type ChatMessage } from './transcript';
import { UsageClient, WeeklyTokens, weekWindowStart, type UsageData, type UsageState } from './usage';

interface Options {
  /** A session that finishes or fails pops the island up for a moment (Claude Status's). */
  showDone: boolean;
  /** Once Auto model is on, the card's header has a button that pauses it. */
  showAutoModel: boolean;
  /** While a session runs, its blue glow stays on round the island whatever is in front. */
  glowInFront: boolean;
  /** Claude Code's permission prompts wait in the island with Allow and Deny. */
  permissions: boolean;
  /** Claude's questions wait in the island to be answered there. */
  questions: boolean;
  /** A finished Claude Code chat's pop-up has a box to reply to it. */
  replyBox: boolean;
  sessionHotkeys: boolean;
  notifications: boolean;
  /** Its moments also go to the phone (Settings › Notifications › Send to my phone). */
  phone: boolean;
  showLimits: boolean;
  showDesktop: boolean;
  finishedSeconds: number;
  /** A chat that finishes while the user is looking at it does not pop the island open. */
  onlyOtherChats: boolean;
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

/**
 * A chat's status in the island's tones, the colours of Justin's Claude Status: blue while
 * Claude works, green when it's your turn, amber when it needs you, red for an error or a
 * turn stopped with Esc, dim when idle. The Claude mark and the limits stay Claude's orange.
 */
const TONE: Record<string, Tone> = { needs: 'warn', working: 'info', turn: 'good', error: 'bad', stopped: 'bad', muted: 'dim' };

/** A chat's dot: its status colour (statusTone's name, or desktop.ts's for the Claude app). */
export function chatTone(tone: string): Tone {
  return TONE[tone] ?? 'dim';
}

/** Claude's card on a phone: chats in its list (live and closed together), folders to start a new one in, messages of one chat. */
const PHONE_CHATS = 8;
const PHONE_FOLDERS = 4;
const CHAT_MESSAGES = 12;
/** Enter goes into an Island terminal this long after the text: in the same write it would read as part of a paste. */
const ENTER_GAP_MS = 150;
/** A Claude started in an Island terminal is followed this long at most (it may wait in its terminal for an answer)… */
const FOLLOW_MS = 10 * 60_000;
/** …and after this long the phone is told it is taking a while. */
const SLOW_START_MS = 45_000;
/** A message from the phone shows under its chat until the transcript has it, at most this long (a working Claude queues it). */
const PENDING_MS = 10 * 60_000;
/** The size an Island terminal for a chat starts at; a phone that attaches resizes it. */
const TERM_COLS = 120;
const TERM_ROWS = 36;
/** After ending a chat's Claude in its Island terminal, this long before its editor opens it. */
const MOVE_GAP_MS = 400;
/** Back to the list of chats, from one chat or a new one. */
const CHATS_BACK: SheetButton = { key: 'back', icon: 'chevron-left', action: 'chat-back', style: 'ghost', tip: 'All chats' };

/** How often the sessions are looked at: Claude Status's pace (its rows, colours and bars), which also serves Claude Code's list. */
const POLL_MS = 1000;
/** Auto model's state is read from Claude Code's settings.json: no need to every second. */
const AUTO_POLL_MS = 5000;
/** Pointing at a finished chat's reply box keeps its pop-up this long at most… */
const POINT_MS = 120_000;
/** …and it goes this long after the pointer leaves the box untouched. */
const POINT_LEAVE_MS = 1500;
/** The hover card folds back up once it has not been asked for this long (the pointer left). */
const UNFOLD_FORGET_MS = 1500;

/** The Claude mark that leads the pill. */
const MARK: Seg = { t: 'icon', key: 'mark', icon: 'claude', tone: 'claude', prio: 0 };

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
  /** Claude Status's rows: every Claude session (Claude Code, the app, Chrome) and background shells. */
  private engine: StatusEngine | null = null;
  rows: StatusRow[] = [];
  private rowsBusy = false;
  /** Each row's state at the last look, to see it change. */
  private lastState = new Map<string, StatusState>();
  /** A session just finished (green), failed or was stopped (red): the island glows that colour for a moment. */
  private glowing: { tone: Tone; until: number } | null = null;
  /** Auto model (src-tauri/src/auto_model.rs): installed from Activities, paused from the card's button. */
  private auto = { installed: false, on: true };
  /** Each moment pops the island once, however many ways it is reported. */
  private readonly moments = new MomentGate();
  /** Pointed at with Grows › "Card with more": whether its ⌄ opened the rest, and when the card was last asked for. */
  private unfold = { on: false, asked: 0 };
  /** Finished chats whose reply box the user clicked into: pointing away from it no longer lets the pop-up go. */
  private readonly typing = new Set<string>();

  sessions: SessionView[] = [];
  closed: ClosedView[] = [];
  chats: DesktopChat[] = [];
  usageState: UsageState | null = null;
  tokenTotals: { fresh: number; cached: number; output: number } | null = null;

  private inputFor: string | null = null;
  private readonly finished = new Map<string, number>();
  /** Each moment goes to the phone once. */
  private readonly pushes = new PushGate();
  /** One-time codes on the phone's Allow and Deny buttons, and the request each answers. */
  private readonly phoneCodes = new Map<string, string>();
  private notice: { text: string; tone: Tone; icon: string; until: number } | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chats that finished while the user was looking at them: no card, they saw it. */
  private readonly looking = new Set<string>();
  /** Answers picked so far on a question card: request id → question index → labels. */
  private readonly picks = new Map<string, Map<number, string[]>>();

  // Claude's card on a phone (phonechat.ts).
  private projectsDir = '';
  /** Island's terminals (src-tauri/src/term), as Rust last listed them: chats from the phone run in them. */
  private terms: TermInfo[] = [];
  /** Chats Island started in its terminals: session id → terminal id. */
  private readonly started = new Map<string, string>();
  /** A chat the phone continued in a copy (a VS Code chat): original → the copy, which the phone's card follows. */
  readonly forks = new Map<string, string>();
  /** Claude just started in an Island terminal, until the tracker sees its chat there. `from`: the chat it continues; null for a new one. */
  private follows: Array<{ term: string; pid: number; from: string | null; cwd: string; at: number }> = [];
  /** What the card shows on the phone: every chat, one chat, or a new one. One for every phone. */
  private pane: ChatPane = { kind: 'list' };
  /** The open chat's last messages, as last read from its transcript. */
  private chatLog: { id: string; file: string | null; size: number; messages: ChatMessage[] } | null = null;
  private chatReading = false;
  private chatAgain = false;
  /** The phone's last message, under its chat until the transcript has it. */
  private pending: { pane: string; text: string; at: number } | null = null;
  /** Something a chat's card says for a while (Claude stopped before the chat began). */
  private chatNote: { pane: string; text: string; until: number } | null = null;

  constructor() {
    super('claude');
  }

  /** How it grows when pointed at (Activities › Grows): Claude's default is the card with more. */
  private growsNow(): Grows {
    return growsOf(this.ctx.config(), this.ctx.settings().island.defaultGrows, 'claude');
  }

  private opts(): Options {
    const o = this.ctx.options<Partial<Options>>();
    return {
      showDone: o.showDone !== false,
      showAutoModel: o.showAutoModel !== false,
      glowInFront: o.glowInFront !== false,
      permissions: o.permissions !== false,
      questions: o.questions !== false,
      replyBox: o.replyBox !== false,
      sessionHotkeys: o.sessionHotkeys !== false,
      notifications: o.notifications !== false,
      phone: o.phone !== false,
      showLimits: o.showLimits !== false,
      showDesktop: o.showDesktop !== false,
      finishedSeconds: Number(o.finishedSeconds) || 8,
      onlyOtherChats: o.onlyOtherChats === true,
      replyWindowSeconds: Math.max(0, Math.min(240, Number(o.replyWindowSeconds ?? 0) || 0)),
      requireHello: o.requireHello === true,
      resetAlerts: o.resetAlerts !== false,
      hiddenSessions: Array.isArray(o.hiddenSessions) ? o.hiddenSessions.filter((x): x is string => typeof x === 'string') : [],
      closedClearedAt: Number(o.closedClearedAt) || 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle (main.js start())

  protected async init(): Promise<void> {
    this.listen<HookEvent>('hook', (ev) => this.onHook(ev));
    // Allow or Deny tapped on the phone (Settings › Notifications › Answer Claude from my phone).
    this.listen<{ message: string }>('phone-reply', (r) => this.fromPhone(String(r?.message ?? '')));
    // Unanswered in time: the terminal asks now (or the chat ends its turn), so the card goes.
    this.listen<{ request_id: string }>('hook-expired', ({ request_id }) => {
      const card = this.hooks.take(request_id);
      const hold = this.hooks.takeHold(request_id);
      this.picks.delete(request_id);
      if (card) this.answeredFor(card.sessionId);
      if (card || hold) this.ctx.update();
    });
    // Switching to a chat's own window means the user will answer it there: let it go at once.
    this.listen<{ pid: number }>('foreground', ({ pid }) => this.onForeground(pid));
    // Chats from the phone run in Island's terminals: their list says which chat runs where.
    this.listen<TermInfo[]>('term-changed', (list) => this.onTerms(list));
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
    this.projectsDir = projectsDir;
    void this.refreshTerms();
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
    // Claude Status's rows come from the same tracker: one scan serves both.
    this.engine = new StatusEngine(root, (...p) => this.ctx.log(...p), this.tracker);
    await this.engine.importWidget(root);
    if (!this.alive) return;

    // A chat opening or closing rewrites/removes its registry file: react at once.
    void native.watch('claude-sessions', sessionsDir, false);
    this.onDispose(() => void native.unwatch('claude-sessions'));
    this.listen<{ id: string }>('fs-change', (c) => {
      if (c.id === 'claude-sessions') this.pollSoon(120);
    });

    // Hooks report Claude Code's moments the instant they happen; the scan keeps the rows,
    // their colours and bars, and the Claude app and Chrome, which have no hooks, up to date.
    this.every(POLL_MS, () => void this.pollSessions(), true);
    this.every(AUTO_POLL_MS, () => void this.pollAuto(), true);
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
    // A chat in an Island terminal has no window of its own: it says Island where others say their terminal.
    this.sessions = this.visibleSessions(result.sessions).map((s) => (this.islandTerm(s) ? { ...s, host: 'Island' } : s));
    this.closed = this.visibleClosed(result.closed);
    for (const ev of result.events) this.onTrackerEvent(ev);
    const keepMs = this.opts().finishedSeconds * 1000 + 2000;
    for (const [id, at] of this.finished) if (Date.now() - at > keepMs) this.finished.delete(id);
    this.followChats();
    // A phone showing a chat sees it move: its transcript is read again once it grew.
    if (this.pane.kind === 'chat' && this.ctx.cardOpen?.()) void this.loadChat();
    await this.pollRows();
    this.ctx.update();
  }

  private onTrackerEvent(ev: TrackerEvent): void {
    if (ev.type === 'needs-you') this.needsYou(ev.session.id, undefined, true);
    else if (ev.type === 'finished') this.markFinished(ev.session.id);
    else if (ev.type === 'closed') this.ctx.log('closed', { session: ev.session.id, title: ev.session.displayTitle });
  }

  /** Claude Status's rows from the sessions just polled, plus the Claude app and Chrome; one look at a time. */
  private async pollRows(): Promise<void> {
    if (!this.engine || this.rowsBusy) return;
    this.rowsBusy = true;
    let rows: StatusRow[];
    try {
      rows = await this.engine.poll(this.sessions);
    } catch (err) {
      this.ctx.log('poll error', String(err));
      return;
    } finally {
      this.rowsBusy = false;
    }
    if (!this.alive) return;
    this.onRows(rows);
  }

  /**
   * A row changing colour is a moment: green or red, the turn ended; orange, it needs you; blue
   * again, a new run began. Claude Code's are usually told already by their hooks or the
   * tracker (moments.ts keeps it to one pop-up); the Claude app's and Chrome's only come this way.
   */
  onRows(rows: StatusRow[]): void {
    for (const r of rows) {
      const st = r.state;
      const before = this.lastState.get(r.id);
      // No longer waiting: the next time it waits is news.
      if (st !== 'input' && !r.parent) this.moments.stopped(r.id);
      if (!before || before === st || r.parent) continue;
      if (st === 'running') this.moments.ran(r.id, r.since * 1000);
      // Stopping one yourself (Esc) is no news: it only turns red, and glows red a moment.
      if (r.stopped) {
        this.glow('bad');
        continue;
      }
      if (st === 'done' || st === 'failed') {
        if (this.isCode(r.id)) this.markFinished(r.id, undefined, st === 'failed');
        else this.endOfTurn(r.id, st === 'failed');
      } else if (st === 'input') this.needsYou(r.id, undefined, true);
    }
    this.lastState = new Map(rows.map((r) => [r.id, r.state]));
    if (JSON.stringify(rows) !== JSON.stringify(this.rows)) {
      this.rows = rows;
      this.ctx.update();
    }
  }

  /** A Claude Code session (Island can answer and type into it), not the Claude app's or Chrome's. */
  private isCode(id: string): boolean {
    return this.sessions.some((s) => s.id === id);
  }

  /** Whether Auto model is installed (Activities) and paused (the card's button). */
  private async pollAuto(): Promise<void> {
    const s = await native.autoModel();
    if (!this.alive || (s.installed === this.auto.installed && s.on === this.auto.on)) return;
    this.auto = { installed: s.installed, on: s.on };
    this.ctx.update();
  }

  /** The island glows this colour all round for a moment (Claude Status's still glow). */
  private glow(tone: Tone): void {
    this.glowing = { tone, until: Date.now() + SHOW_MS };
    this.later(SHOW_MS + 50, () => this.ctx.update());
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
      this.saw('limits-reset', `claude:reset:${key}`);
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
    // Prompts this event takes away (answered in the chat, the turn ended): their moment is over.
    const waitingBefore = new Set(this.hooks.cards.map((c) => c.sessionId));
    const kind = this.hooks.apply(ev);
    const sid = ev.session_id ?? '';
    for (const id of waitingBefore) if (!this.hooks.cards.some((c) => c.sessionId === id)) this.answeredFor(id);
    if (kind === 'permission' && ev.request_id) {
      const question = ev.tool_name === 'AskUserQuestion';
      const early = ev.hook_event_name === 'PreToolUse';
      const o = this.opts();
      if (question && !early && this.hooks.askedEarly(sid)) {
        // The island held this question before Claude Code asked it and let it go to the chat: it is asked there now.
        this.hooks.take(ev.request_id);
        void native.hookReply(ev.request_id, 'decline');
      } else {
        const cfg = this.ctx.config();
        // Activities › Claude Status › Claude Code: Allow and Deny, and answering questions, each can be off.
        const wanted = question ? o.questions : o.permissions;
        const canShow = wanted && cfg.enabled && cfg.interactive && cfg.interrupt && !this.ctx.settings().general.dnd && !hiddenNow(this.ctx.settings().island, Date.now());
        if (question) this.askToPhone(sid, ev);
        // Only a request that waits for an answer gets buttons on the phone.
        else this.toPhone(sid, 'permission', permissionText(ev.tool_name, ev.tool_input), `${ev.tool_name}:${JSON.stringify(ev.tool_input ?? null).slice(0, 300)}`, ev.cwd, canShow ? ev.request_id : undefined);
        if (!canShow) {
          // Nobody will see the card: let the terminal ask right away.
          this.hooks.take(ev.request_id);
          void native.hookReply(ev.request_id, 'decline');
        } else if (early) {
          void this.holdQuestion(ev.request_id, sid, ev);
        } else {
          void native.hookReply(ev.request_id, 'ack');
          this.needsYou(sid, ev);
        }
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
      this.typing.delete(sid);
      // A new turn: its end and anything it asks are news again.
      this.moments.ran(sid, Date.now());
    }
    // A question or a notification is the chat asking for the user: say so, with what it asks.
    if (sid && ((kind === 'tool' && ev.tool_name === 'AskUserQuestion' && ev.hook_event_name === 'PreToolUse') || kind === 'note')) {
      // "Waiting for your input" a minute after a turn ended is no new moment: the phone hears it after a quiet spell, the island stays put.
      if (kind === 'note' && ev.notification_type === 'idle_prompt') this.toPhone(sid, 'waiting', ev.message ?? '', '', ev.cwd);
      else if (kind === 'note' && ev.notification_type === 'auth_success') {
        // Signed in: nothing waits on the user.
      } else {
        // What it asks goes to the phone first (the moment's own push says less).
        if (kind === 'note') this.toPhone(sid, 'needs', ev.message ?? '', '', ev.cwd);
        else this.askToPhone(sid, ev);
        // The card shows as long as it waits (status().urgent); this is its one pop-up.
        this.needsYou(sid, ev);
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
    if (o.replyWindowSeconds <= 0 || !o.replyBox || !cfg.enabled || !cfg.interactive || this.ctx.settings().general.dnd) return pass('off');
    if (hiddenNow(this.ctx.settings().island, Date.now())) return pass('hidden');
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
      this.ctx.alert('glow', 'good');
      if (this.ctx.settings().general.sounds) chime('attention');
    }
    this.ctx.update();
  }

  /**
   * A question before Claude Code asks it. A user looking at its chat answers it there, as
   * always: it goes at once. Anyone else gets the card, and the chat waits for the answer.
   * The answer must come within the pipe's 900 ms, like a Stop's.
   */
  private async holdQuestion(requestId: string, sid: string, ev: HookEvent): Promise<void> {
    let looking = false;
    try {
      looking = await this.isLookingAt(sid, ev);
    } catch (err) {
      this.ctx.log('question: foreground check failed', String(err));
    }
    if (looking) {
      this.hooks.take(requestId);
      void native.hookReply(requestId, 'decline');
      this.ctx.log('question', { session: sid.slice(0, 8), held: false, why: 'looking' });
      this.ctx.update();
      return;
    }
    void native.hookReply(requestId, 'ack');
    this.ctx.log('question', { session: sid.slice(0, 8), held: true });
    this.needsYou(sid, ev);
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
    // A held question goes to its chat once the user is there: Claude Code asks it as usual.
    for (const c of this.hooks.cards.filter((x) => x.early)) {
      const s = this.sessions.find((x) => x.id === c.sessionId);
      if (!s || !this.chainOf(s.pid).includes(pid)) continue;
      this.hooks.take(c.requestId);
      this.picks.delete(c.requestId);
      this.answeredFor(c.sessionId);
      void native.hookReply(c.requestId, 'decline');
      this.ctx.log('question released', { session: c.sessionId.slice(0, 8), why: 'switched to the chat' });
      this.ctx.update();
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
    this.answeredFor(card.sessionId);
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
    this.answeredFor(card.sessionId);
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
    this.answeredFor(card.sessionId);
    void native.hookReply(requestId, 'decline');
    await this.switchTo(card.sessionId, 'answer-in-chat');
  }

  /** The island dismissed an urgent moment (tap outside). */
  dismiss(key: string): void {
    const [kind, ref] = splitOnce(key, ':');
    if (kind === 'perm') {
      // Hand the question back to the terminal instead of leaving Claude Code waiting.
      const card = this.hooks.take(ref);
      if (card) {
        this.answeredFor(card.sessionId);
        void native.hookReply(ref, 'decline');
      }
      this.picks.delete(ref);
    } else if (kind === 'reply') {
      const h = this.hooks.hold(ref);
      if (h) this.release(h, 'dismissed');
    } else if (kind === 'note' || kind === 'needs') {
      // Tapped away: the session list may say it waits a while longer, which is the same moment.
      this.answeredFor(ref);
    } else if (kind === 'ask') {
      for (const id of ref.split(',')) this.answeredFor(id);
    } else if (kind === 'input') {
      this.inputFor = null;
    }
    this.ctx.update();
  }

  // ---------------------------------------------------------------- moments

  /**
   * A Claude Code turn ended (its Stop hook, the tracker, or its row turning green or red).
   * "Only pop up for other chats" keeps a chat the user is looking at from popping up.
   */
  private markFinished(id: string, ev?: HookEvent, failed = false): void {
    if (this.moments.has(id, 'end')) return;
    if (this.opts().onlyOtherChats) void this.endUnlessLooking(id, ev, failed);
    else this.endOfTurn(id, failed, ev);
  }

  /** "Only pop up for other chats": a chat the user is looking at finishes quietly. */
  private async endUnlessLooking(id: string, ev: HookEvent | undefined, failed: boolean): Promise<void> {
    let looking = this.looking.has(id);
    if (!looking) {
      try {
        looking = await this.isLookingAt(id, ev);
      } catch (err) {
        this.ctx.log('finish: foreground check failed', String(err));
      }
    }
    if (!looking) return this.endOfTurn(id, failed, ev);
    // Told, quietly: a later report of the same finish pops nothing either.
    if (!this.moments.allow(id, 'end', Date.now())) return;
    this.looking.add(id);
    this.ctx.log('finished quietly', { session: id.slice(0, 8) });
    this.ctx.update();
  }

  /**
   * A session's turn ended, well or on an error: its one pop-up. It shows for a moment (Claude
   * Status's rule; Show "finished" for, for a Claude Code chat, whose card has the reply box),
   * not at all with "Pop up when a session finishes" off, and not over a reply window, which
   * already holds the island open for that chat.
   */
  private endOfTurn(id: string, failed: boolean, ev?: HookEvent): void {
    const now = Date.now();
    if (!this.moments.allow(id, 'end', now)) return;
    const s = this.sessions.find((x) => x.id === id);
    const errored = failed || s?.status === 'errored';
    this.finished.set(id, now);
    this.glow(errored ? 'bad' : 'good');
    this.saw(errored ? 'claude-error' : 'claude-done', `claude:done:${id}`);
    if (s || ev) {
      if (this.ctx.settings().general.sounds) chime('done');
      const said = ev?.last_assistant_message?.trim() || s?.lastAssistantText || '';
      this.toPhone(id, errored ? 'error' : 'done', errored ? [s?.label, said].filter(Boolean).join('\n') : said, '', ev?.cwd);
    }
    const o = this.opts();
    if (o.showDone && !this.hooks.holds.some((h) => h.sessionId === id)) {
      this.ctx.surface({ key: `done:${id}`, ms: s || ev ? o.finishedSeconds * 1000 : SHOW_MS, level: 'expanded' });
    }
    this.ctx.update();
  }

  /**
   * A session waits on the user (a permission prompt, a question, a notification, or its row
   * turning orange): told once. The island stays open on it while it waits (status().urgent);
   * this glows, tells the bot, and for a Claude Code chat sounds, shows a Windows notification
   * and goes to the phone.
   */
  private needsYou(id: string, ev?: HookEvent, polled = false): void {
    if (!this.moments.allow(id, 'needs', Date.now(), polled)) return;
    this.ctx.alert('glow', 'warn');
    this.saw('claude-asks', `claude:needs:${id}`);
    const s = this.sessions.find((x) => x.id === id);
    if (!s && !ev) return;
    if (this.ctx.settings().general.sounds) chime('attention');
    const title = s?.displayTitle || (ev?.cwd ? projectName(ev.cwd) : '') || 'Claude Code';
    // The phone gets this from toPhone, once, however many ways the moment is reported.
    if (this.opts().notifications) this.ctx.notify(title, `Needs you${s ? ` in ${s.project}` : ''}. Alt+Shift+0 to switch.`, false);
    this.toPhone(id, 'needs', s ? `${s.label} · ${s.project}` : '', '', s?.cwd ?? ev?.cwd);
  }

  /**
   * A moment of this chat on the phone, once: hooks and polling report the same one twice.
   * `requestId`: a permission request waiting here, which the phone can answer.
   */
  private toPhone(sid: string, kind: PushKind, detail: string, key = '', cwd?: string, requestId?: string): void {
    const o = this.opts();
    if (!sid || !o.phone || !this.ctx.push || o.hiddenSessions.includes(sid)) return;
    if (!this.pushes.allow(sid, kind, Date.now(), key)) return;
    const s = this.sessions.find((x) => x.id === sid);
    const p = pushFor(kind, s?.displayTitle || (cwd ? projectName(cwd) : '') || 'Claude Code', detail);
    this.ctx.push(p.title, p.body, { tag: p.tag, priority: p.priority, buttons: requestId ? this.phoneButtons(requestId) : undefined });
  }

  /**
   * Allow and Deny for the phone, each posting its word and a one-time code. With Windows
   * Hello asked before Allow, the phone can't skip it: Deny only.
   */
  private phoneButtons(requestId: string): Array<{ label: string; reply: string }> | undefined {
    if (!this.ctx.settings().general.phoneApprove) return undefined;
    const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.phoneCodes.set(code, requestId);
    // Only the requests that can still be waiting are kept.
    if (this.phoneCodes.size > 40) this.phoneCodes.delete(this.phoneCodes.keys().next().value!);
    const deny = { label: 'Deny', reply: `deny ${code}` };
    return this.opts().requireHello ? [deny] : [{ label: 'Allow', reply: `allow ${code}` }, deny];
  }

  /** A button tapped on the phone: answers the request it was for, if that still waits. */
  private fromPhone(message: string): void {
    const m = /^(allow|deny) ([0-9a-f]{32})$/.exec(message.trim());
    if (!m) return;
    const requestId = this.phoneCodes.get(m[2]);
    if (!requestId) return;
    this.phoneCodes.delete(m[2]);
    if (!this.hooks.cards.some((c) => c.requestId === requestId)) return;
    // The phone never answers Allow past Windows Hello (it was only given Deny then).
    if (m[1] === 'allow' && this.opts().requireHello) return;
    this.ctx.log('permission answered from the phone', { decision: m[1] });
    this.answer(requestId, m[1] === 'allow' ? 'allow' : 'deny');
    this.flash(m[1] === 'allow' ? 'Allowed from your phone' : 'Denied from your phone', m[1] === 'allow' ? 'good' : 'warn', m[1] === 'allow' ? 'check' : 'x');
  }

  private askToPhone(sid: string, ev: HookEvent): void {
    const text = askText(ev.tool_input);
    this.toPhone(sid, 'asks', text, text.slice(0, 160), ev.cwd);
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
    // A chat started from the phone runs in an Island terminal, with no window: Open moves it to VS Code.
    if (s.alive && this.islandTerm(s)) return this.moveToEditor(s, source);
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

  /**
   * A row clicked: a Claude Code chat goes where Open takes it (its window, its editor, or out
   * of an Island terminal); the Claude app's, Chrome's and a shell's where the widget took them.
   */
  private async jump(id: string): Promise<void> {
    if (!this.engine || !id) return;
    if (this.isCode(id)) {
      this.engine.markRead(id);
      await this.switchTo(id, 'row');
      return;
    }
    if (!(await this.engine.jump(id))) this.ctx.alert('shake');
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

  /**
   * Open, on a chat running in an Island terminal (started from the phone): Island ends its Claude
   * there and opens the chat in VS Code, which picks it up with everything said from the phone.
   */
  private async moveToEditor(s: SessionView, source: string): Promise<boolean> {
    const term = this.islandTerm(s);
    let ok = false;
    try {
      if (term) {
        await native.termKill(term.id);
        this.started.delete(s.sessionId);
        // Its process lets go of the chat before the editor opens it.
        await sleep(MOVE_GAP_MS);
      }
      ok = await this.openInEditor(s.sessionId, null, s.project);
    } catch (err) {
      this.ctx.log('switch error', String(err));
    }
    this.ctx.log('switch', { source, session: s.id, island: true, ok });
    if (!ok) this.flash(`Couldn't open it in ${this.editorName()}`, 'bad', 'alert');
    return ok;
  }

  /** The editor a chat moves to: the one running, else VS Code. */
  private editorName(): string {
    return this.tracker?.probe.runningEditor() ?? 'VS Code';
  }

  /** What Open does for a chat: brings up its window, or, for a chat in an Island terminal, moves it to the editor. */
  private openText(s: SessionView | null | undefined): string {
    if (s?.alive && this.islandTerm(s)) return `Open in ${this.editorName()}`;
    return `Open ${s?.host ?? 'the chat'}`;
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
      } else if (live && this.islandTerm(live)) {
        // Started from the phone: it runs in an Island terminal, typed into like any other.
        ok = (await this.typeInto(this.islandTerm(live)!.id, text)) === null;
        how = 'island';
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
    this.typing.delete(id);
    if (ok && how === 'editor') {
      this.flash('Chat opened. Press Enter there to send (also copied)', 'warn', 'enter', 7000);
    } else if (ok) {
      this.hooks.turnStart.set(s.sessionId, Date.now());
      this.flash('Sent. Claude is on it', 'good', 'check');
    } else this.flash("Couldn't send that prompt", 'bad', 'alert');
    this.pollSoon(500);
  }

  // ---------------------------------------------------------------- what the island asks

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

  /** Claude Code chats that wait on the user (polled, so without a hook card), not one just answered. */
  private needing(): SessionView[] {
    return this.sessions.filter((s) => s.needsYou && !this.moments.settling(s.id));
  }

  /** Rows waiting on you that Island can't answer (the Claude app, Chrome): Claude Code's wait in their own cards. */
  private askingRows(): StatusRow[] {
    return this.rows.filter((r) => !r.grey && r.state === 'input' && !r.parent && !this.isCode(r.id) && !this.moments.settling(r.id));
  }

  /**
   * A session's prompt was answered (in the island, on the phone, in the chat) or handed back to
   * the chat: what it said it waited for is over, and the session list saying it still waits is
   * the same moment, not a new pop-up.
   */
  private answeredFor(sid: string): void {
    this.moments.answered(sid);
    this.hooks.notes.delete(sid);
    this.hooks.asks.delete(sid);
  }

  /** A session that just finished, failed or was stopped glows that colour, still, for a moment. */
  private glowNow(now: number): Tone | null {
    return this.glowing && now < this.glowing.until ? this.glowing.tone : null;
  }

  status(): ActivityStatus {
    const now = Date.now();
    const card = this.hooks.cards[0];
    const hold = this.hooks.holds[0];
    const note = this.waitingNote();
    const needs = this.needing();
    const asking = this.askingRows();
    const rows = this.rows.filter((r) => !r.grey);
    const running = rows.some((r) => r.state === 'running') || this.sessions.some((s) => s.status === 'working');
    const shell = rows.some((r) => r.state === 'shell');
    const waiting = waitingRows(this.rows).length;
    const red = rows.some((r) => r.state === 'failed');
    const noticing = this.notice !== null && this.notice.until > now;
    const active = this.rows.length > 0 || this.sessions.length > 0 || !!card || !!hold || !!note || this.inputFor !== null || this.finished.size > 0 || noticing;
    if (!active) return { active: false };
    // Whatever waits on the user holds the island open, Quiet or not, until it is answered or
    // tapped away: Claude Code's prompts with their answers, then a row the island can only point at.
    let urgent: ActivityStatus['urgent'] = null;
    if (this.inputFor) urgent = { key: `input:${this.inputFor}`, level: 'maximum' };
    else if (card) urgent = { key: `perm:${card.requestId}`, level: 'expanded' };
    else if (hold) urgent = { key: `reply:${hold.requestId}`, level: 'expanded' };
    else if (note) urgent = { key: `note:${note.sessionId}`, level: 'expanded' };
    else if (needs.length) urgent = { key: `needs:${needs[0].id}`, level: 'expanded' };
    else if (asking.length) urgent = { key: `ask:${asking.map((r) => r.id).join(',')}`, level: 'expanded' };
    const weight = urgent || running || shell || waiting || red ? 'foreground' : 'background';
    const barRow = this.rows.find((r) => r.progress);
    const flash = this.glowNow(now);
    // Border light: an amber pulse when something needs you, a still green glow while a finished
    // chat holds for your reply, a finish's or failure's still glow for a moment, a progress bar,
    // a blue comet while Claude works.
    const beam: ActivityStatus['beam'] =
      card || note || needs.length
        ? { tone: 'warn', urgent: true }
        : hold
          ? { tone: 'good', motion: 'still', urgent: true }
          : flash
            ? { tone: flash, motion: 'still' }
            : waiting
              ? { tone: 'warn', motion: 'pulse' }
              : barRow?.progress
                ? { tone: barRow.state === 'shell' ? 'purple' : 'info', motion: 'progress', value: barRow.progress.value }
                : running
                  ? { tone: 'info', motion: 'orbit' }
                  : null;
    const n = sessionCount(this.rows) || this.sessions.length;
    // A prompt from a hook can come before its row turns orange.
    const awaiting = Math.max(waiting, card || hold || note || needs.length ? 1 : 0);
    return {
      active: true,
      weight,
      urgent,
      summary: awaiting ? `${awaiting} awaiting you` : `${n} Claude session${n === 1 ? '' : 's'}`,
      beam,
      // Running, the blue light stays on round the pill whatever is in front (unless switched off).
      beamBehind: running && this.opts().glowInFront ? { tone: 'info', motion: 'orbit' } : null,
    };
  }

  /** Claude working: the bot thinks along; a session waiting on the user needs you. */
  override pet(): PetSignal {
    const needs = this.hooks.cards.length > 0 || this.waitingNote() !== null || this.needing().length > 0 || this.askingRows().length > 0;
    const working = this.sessions.some((s) => s.status === 'working') || this.rows.some((r) => !r.grey && r.state === 'running');
    return { mood: needs ? 'needs-you' : working ? 'thinking' : null, moment: this.petMoment };
  }

  chip(): ChipView | null {
    const t = this.rows[0];
    const waits = this.hooks.cards.length > 0 || this.hooks.holds.length > 0 || this.waitingNote() !== null;
    if (!t && !waits) return null;
    const n = sessionCount(this.rows) || this.sessions.length;
    return {
      icon: 'claude',
      label: String(n || 1),
      dot: waits ? 'warn' : t ? toneOf(t) : 'warn',
      pulse: waits || (t?.state === 'running' && !t.grey),
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
    const note = this.waitingNote();
    if (note && (env.level === 'maximum' || env.level === 'expanded')) return this.noteView(note.sessionId, env);
    // Claude Status's pill: a dot per session; a session that just finished (or was picked by its hotkey) leads it.
    const surfaced = env.surfaced ?? '';
    const focus = surfaced.startsWith('done:') ? surfaced.slice(5) : surfaced.startsWith('slot:') ? surfaced.slice(5) : null;
    const segs = statusSegments(this.rows, env, focus);
    if (!segs.length) return [MARK, { t: 'text', key: 'none', text: 'Claude', weight: 'semibold', prio: 0 }];
    // Limits in the island: the session and weekly bars when it opens all the way.
    if (env.level === 'maximum' && !env.vertical) segs.push(...this.meters(now, 7));
    return segs;
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
      { t: 'icon', key: 'perm-icon', icon: card.tool === 'AskUserQuestion' ? 'chat' : 'claude', tone: card.tool === 'AskUserQuestion' ? 'warn' : 'claude', anim: 'pulse', prio: 0 },
      { t: 'text', key: 'perm-ask', text: this.askOf(card), weight: 'semibold', prio: 0 },
      { t: 'text', key: 'perm-title', text: s?.displayTitle || baseName(card.cwd) || 'Claude Code', tone: 'muted', prio: 4, max: env.vertical ? 60 : 200 },
    ];
    if (more > 0) segs.push({ t: 'chip', key: 'perm-more', label: `+${more}`, side: 'end', prio: 7, tip: `${more} more waiting` });
    return segs;
  }

  private replyView(h: ReplyHold, env: RenderEnv): Seg[] {
    const s = this.sessions.find((x) => x.id === h.sessionId);
    return [
      { t: 'icon', key: 'reply-icon', icon: 'check', tone: 'good', prio: 0 },
      { t: 'text', key: 'reply-done', text: 'Claude finished', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'reply-title', text: s?.displayTitle ?? 'your chat', tone: 'muted', prio: 4, max: env.vertical ? 60 : 220 },
    ];
  }

  private inputView(env: RenderEnv): Seg[] {
    const id = this.inputFor!;
    const s = this.tracker?.get(id) ?? this.tracker?.getClosed(id) ?? this.sessions.find((x) => x.id === id) ?? null;
    void env;
    return [
      { t: 'icon', key: 'in-icon', icon: 'claude', tone: 'claude', prio: 0 },
      { t: 'input', key: 'prompt', placeholder: `Continue ${clip(s?.displayTitle ?? 'this session', 40)}…`, action: 'send', cancel: 'cancel-input', prio: 0, min: 220 },
      { t: 'button', key: 'in-cancel', icon: 'x', action: 'cancel-input', style: 'ghost', side: 'end', prio: 1, tip: 'Cancel (Esc)' },
    ];
  }

  private noteView(sid: string, env: RenderEnv): Seg[] {
    const s = this.sessions.find((x) => x.id === sid);
    const ask = this.hooks.asks.get(sid);
    return [
      { t: 'icon', key: 'note-icon', icon: ask ? 'chat' : 'bell', tone: 'warn', anim: 'pulse', prio: 0 },
      { t: 'text', key: 'note-what', text: ask ? 'Claude is asking' : 'Claude needs you', weight: 'semibold', prio: 0 },
      { t: 'text', key: 'note-title', text: s?.displayTitle ?? 'a chat', tone: 'muted', prio: 4, max: env.vertical ? 60 : 220 },
    ];
  }

  // ---------------------------------------------------------------- the card under the pill

  sheet(env: SheetEnv): SheetView | null {
    // Claude Code's prompt, question or reply window, with every session's row under it: Claude Status's pop-up with Claude Code's answers in it.
    if (env.reason === 'urgent') {
      const card = this.hooks.cards[0];
      if (card) return this.withRows(card.tool === 'AskUserQuestion' ? this.questionSheet(card) : this.permissionSheet(card), env.now);
      const hold = this.hooks.holds[0];
      if (hold) return this.withRows(this.replySheet(hold), env.now);
      const note = this.waitingNote();
      if (note) return this.withRows(this.noteSheet(note.sessionId), env.now);
      const needs = this.needing()[0];
      if (needs) return this.withRows(this.noteSheet(needs.id), env.now);
      return this.askingRows().length ? this.statusCard('status', env.now) : null;
    }
    if (env.reason === 'surfaced') {
      const key = env.surfaced ?? '';
      if (key.startsWith('done:')) {
        const id = key.slice(5);
        // Finished in the window the user is in: they saw it (the pill only says so).
        if (this.looking.has(id)) return null;
        // A Claude Code chat's has its last message and the reply box; the Claude app's and Chrome's, the rows.
        const done = this.isCode(id) ? this.finishedSheet(id) : null;
        return done ? this.withRows(done, env.now) : this.statusCard('status', env.now);
      }
      if (key.startsWith('slot:')) return this.statusCard('status', env.now);
      return null;
    }
    if (env.reason === 'hover') return this.hoverSheet(env);
    // Only a phone opens Claude's own card (its Claude button): a chat with Claude.
    return this.phoneSheet(env.now);
  }

  /** Claude Status's header: how many sessions or how many wait, the Auto model button, and `extra` buttons. */
  private statusHead(extra: SheetButton[] = []): Block {
    const o = this.opts();
    const buttons: SheetButton[] = [];
    // Only once Auto model is installed (Activities › Claude Status); "Show Auto model button" there hides it.
    if (this.auto.installed && o.showAutoModel) {
      buttons.push({
        key: 'router',
        label: this.auto.on ? 'Auto model: on' : 'Auto model: off',
        action: 'router',
        style: this.auto.on ? 'secondary' : 'ghost',
        tip: this.auto.on
          ? 'Warns you before a prompt runs on a far too strong or too weak Claude model, and checks a chat when it compacts, passes 500k tokens or ends: was it on the right model. Click to pause.'
          : 'Paused: Claude runs every prompt on the model you picked, with no checks. Click to turn back on.',
      });
    }
    return { t: 'head', key: 'head', icon: 'claude', tone: 'claude', title: 'Claude', sub: this.rows.length ? statusSub(this.rows) : 'No Claude sessions right now', buttons: [...buttons, ...extra] };
  }

  /** Every session's row, each with its progress bar on its second line; Claude Code's carry their Alt+Shift number. */
  private rowsBlock(now: number): Block {
    return { t: 'rows', key: 'rows', items: statusRows(this.rows, now, true, (id) => this.sessions.find((s) => s.id === id)?.slot ?? null) };
  }

  /** Claude Status's own card: the header and the rows. */
  private statusCard(key: string, now: number, extra: SheetButton[] = []): SheetView {
    const blocks: Block[] = [this.statusHead(extra)];
    if (this.rows.length) blocks.push(this.rowsBlock(now));
    return { key, blocks };
  }

  /** A moment's card (Claude Code's answers) with the session rows under it. */
  private withRows(view: SheetView | null, now: number): SheetView | null {
    if (!view || !this.rows.length) return view;
    return { ...view, blocks: [...view.blocks, this.rowsBlock(now)] };
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
      { t: 'countdown', key: 'left', until: card.at + PERMISSION_MS, total: PERMISSION_MS, tone: 'warn' },
    );
    return { key: `perm:${card.requestId}`, blocks };
  }

  private questionSheet(card: PermissionCard): SheetView {
    const s = this.sessions.find((x) => x.id === card.sessionId);
    const qs = questionsOf(card.input);
    const chosen = this.picks.get(card.requestId);
    const blocks: Block[] = [{ t: 'head', key: 'h', icon: 'chat', tone: 'warn', title: this.askOf(card), sub: [s?.displayTitle || baseName(card.cwd), s?.host].filter(Boolean).join(' · ') }];
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
    blocks.push({ t: 'buttons', key: 'b', items: buttons }, { t: 'countdown', key: 'left', until: card.at + PERMISSION_MS, total: PERMISSION_MS, tone: 'warn' });
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
          buttons: [{ key: 'open', icon: 'external', action: 'open-chat', arg: h.requestId, style: 'ghost', tip: this.openText(s) }],
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
    const failed = s.status === 'errored';
    const blocks: Block[] = [
      {
        t: 'head',
        key: 'h',
        icon: failed ? 'alert' : 'check',
        tone: failed ? 'bad' : 'good',
        title: s.displayTitle,
        sub: this.where(s, failed ? 'Failed' : 'Finished'),
        buttons: [{ key: 'open', icon: 'external', action: 'switch', arg: sid, style: 'ghost', tip: this.openText(s) }],
      },
      { t: 'text', key: 'msg', text, bubble: true, lines: 7 },
    ];
    // Pointing at the box, or clicking into it, keeps the pop-up up while you write.
    if (this.opts().replyBox) {
      blocks.push({ t: 'input', key: 'reply', placeholder: 'Reply to this chat…', action: `continue:${sid}`, engage: `keep:${sid}`, point: `point:${sid}`, hint: this.lateHint(s) });
    }
    return { key: `done:${sid}`, blocks };
  }

  private lateHint(s: SessionView): string {
    if (!s.alive) return 'Reopens the chat in a terminal with your reply.';
    if (s.entrypoint === 'claude-vscode') return `Opens the chat in ${s.editorHost || s.host} with your reply ready: press Enter there.`;
    if (this.islandTerm(s)) return 'Types your reply into the chat in its Island terminal.';
    return 'Types your reply into its terminal and sends it.';
  }

  /** A chat waiting on the user without a prompt the island can answer: show what it asks. */
  private noteSheet(sid: string): SheetView | null {
    const s = this.sessions.find((x) => x.id === sid) ?? null;
    const ask = this.hooks.asks.get(sid);
    const note = this.hooks.notes.get(sid);
    const blocks: Block[] = [
      { t: 'head', key: 'h', icon: ask ? 'chat' : 'bell', tone: 'warn', title: ask ? 'Claude is asking' : note?.title || 'Claude needs you', sub: [s?.displayTitle, s?.host].filter(Boolean).join(' · ') },
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
    blocks.push({ t: 'buttons', key: 'b', items: [{ key: 'open', label: this.openText(s), icon: 'external', action: 'switch', arg: sid, style: 'primary' }] });
    return { key: `note:${sid}:${ask?.at ?? note?.at ?? 0}`, blocks };
  }

  /** The limits with their pace (session, week, per model), as the hover card and a phone's list of chats show them. */
  private limitBlocks(now: number): Block[] {
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
    return blocks;
  }

  /**
   * Pointing at Claude: Claude Status's card. With Grows › "Card with more" (the default) a ⌄
   * at its bottom edge opens the rest under the rows: the limits with their pace, this week's
   * tokens, chats closed recently and the Claude app's recent chats (⌃ folds it again, and so
   * does pointing away). Below and Sideways show it all at once; Into a card, the small card.
   */
  private hoverSheet(env: SheetEnv): SheetView {
    const now = env.now;
    const grows = this.growsNow();
    if (now - this.unfold.asked > UNFOLD_FORGET_MS) this.unfold.on = false;
    this.unfold.asked = now;
    const more = grows === 'more';
    const full = grows === 'below' || grows === 'wide' || (more && this.unfold.on);
    const view = this.statusCard('hover', now, []);
    if (full) view.blocks.push(...this.moreBlocks(now));
    // The arrow sits at the card's bottom edge, where the card grows when it is pressed (Justin).
    if (more) {
      const button: SheetButton = { key: 'more', icon: this.unfold.on ? 'chevron-up' : 'chevron-down', action: 'unfold', style: 'ghost', tip: this.unfold.on ? 'Less' : 'Limits, tokens and closed chats' };
      view.blocks.push({ t: 'buttons', key: 'more', align: 'center', items: [button] });
    }
    return view;
  }

  /** What Claude Code's card under the pill had besides the chats: limits, tokens, closed chats, the Claude app's, hidden chats. */
  private moreBlocks(now: number): Block[] {
    const blocks: Block[] = this.limitBlocks(now);
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
    return blocks;
  }

  /** Claude's cell in the open island: every session's row, with the limits in its label. */
  tile(env: SheetEnv): Tile | null {
    if (!this.rows.length) return null;
    const d = this.opts().showLimits ? this.limitsNow(env.now) : null;
    const limits = [d?.fiveHour ? `S ${Math.round(d.fiveHour.pct)}%` : null, d?.sevenDay ? `W ${Math.round(d.sevenDay.pct)}%` : null].filter(Boolean).join(' · ');
    return {
      key: 'claude',
      span: 2,
      rows: 2,
      tone: 'claude',
      body: { k: 'list', icon: 'claude', label: limits ? `Claude sessions · ${limits}` : 'Claude sessions', rows: statusRows(this.rows, env.now), empty: 'All quiet' },
    };
  }

  // ---------------------------------------------------------------- Claude's card on a phone (phonechat.ts)

  /** The folders Claude chats ran in, newest first: a phone's New chat, and its terminal's folder picker (hello). */
  recentFolders(max: number): string[] {
    return recentFolders([...this.sessions.map((s) => ({ cwd: s.cwd, at: s.lastActivityMs })), ...this.closed.map((c) => ({ cwd: c.cwd, at: c.closedAt }))], max);
  }

  /** The card a phone shows for Claude: the chats, one chat, or a new chat in a folder. */
  private phoneSheet(now: number): SheetView {
    const pane = this.pane;
    if (pane.kind === 'chat') {
      const view = this.chatSheet(pane.id, now);
      if (view) return view;
    }
    if (pane.kind === 'new') return this.newChatSheet(pane.folder, now);
    return this.chatsSheet(now);
  }

  /** "Working…", "Your turn", "Needs you": a chat's state in a word or two. */
  private statusWord(s: SessionView): string {
    return s.status === 'working' ? 'Working…' : s.label;
  }

  /** The limits, then every chat (live ones, then the closed recently: 8 at most), then a new chat in a recent folder. */
  private chatsSheet(now: number): SheetView {
    const blocks = this.limitBlocks(now);
    const live = this.sessions.slice(0, PHONE_CHATS);
    const closed = this.closed.slice(0, PHONE_CHATS - live.length);
    blocks.push({ t: 'text', key: 'chats-h', text: 'Chats', tone: 'muted', size: 'sm' });
    if (live.length || closed.length) {
      blocks.push({
        t: 'rows',
        key: 'chats',
        items: [
          ...live.map((s): SheetRow => ({ key: s.id, dot: chatTone(s.tone), pulse: s.needsYou, title: s.displayTitle, detail: [this.statusWord(s), s.project].filter(Boolean).join(' · '), action: 'chat', arg: s.id })),
          ...closed.map((c): SheetRow => ({ key: c.id, icon: 'history', title: c.displayTitle, detail: [`Closed ${agoText(now - c.closedAt)}`, c.project].filter(Boolean).join(' · '), action: 'chat', arg: c.id })),
        ],
      });
    } else blocks.push({ t: 'text', key: 'chats-none', text: 'No Claude Code chats yet', tone: 'muted', size: 'sm' });
    const folders = this.recentFolders(PHONE_FOLDERS);
    if (folders.length) {
      blocks.push(
        { t: 'text', key: 'new-h', text: 'New chat', tone: 'muted', size: 'sm' },
        { t: 'buttons', key: 'new', align: 'start', items: folders.map((f): SheetButton => ({ key: f, label: clip(projectName(f), 24), icon: 'plus', action: 'chat-new', arg: f, style: 'ghost', tip: f })) },
      );
    }
    return { key: 'chats', blocks };
  }

  /** One chat: its last messages, what it is doing, and the box to message it, with where a message goes. */
  private chatSheet(id: string, now: number): SheetView | null {
    const live = this.sessions.find((s) => s.id === id) ?? null;
    const chat = live ?? this.closed.find((c) => c.id === id) ?? null;
    if (!chat) return null;
    const pane = `chat:${id}`;
    const log = this.chatLog?.id === id ? this.chatLog : null;
    if (!log) void this.loadChat();
    const blocks: Block[] = [
      { t: 'head', key: 'h', icon: 'claude', tone: 'claude', title: chat.displayTitle, sub: [chat.project, live ? this.statusWord(live) : 'Closed'].filter(Boolean).join(' · '), buttons: [CHATS_BACK] },
      ...this.messageBlocks(log?.messages ?? [], pane, now, log ? 'No messages yet' : 'Reading the chat…'),
    ];
    if (live?.status === 'working') blocks.push({ t: 'text', key: 'working', text: 'Claude is working…', tone: 'muted', size: 'sm' });
    const card = this.hooks.cards.find((c) => c.sessionId === id);
    if (card) blocks.push({ t: 'text', key: 'waiting', text: card.tool === 'AskUserQuestion' ? 'Claude asked you something: its card has the question.' : 'Claude waits for your OK: its card has Allow and Deny.', tone: 'warn', size: 'sm' });
    blocks.push(...this.startBlocks(pane, now, { t: 'input', key: 'say', placeholder: 'Message Claude…', action: `say:${id}`, hint: routeHint(this.routeOf(chat)) }));
    return { key: pane, blocks };
  }

  /** A new chat in a folder: what Claude should do. */
  private newChatSheet(folder: string, now: number): SheetView {
    const pane = `new:${folder}`;
    const blocks: Block[] = [
      { t: 'head', key: 'h', icon: 'claude', tone: 'claude', title: `New chat in ${projectName(folder)}`, sub: folder, buttons: [CHATS_BACK] },
      ...this.messageBlocks([], pane, now, ''),
      ...this.startBlocks(pane, now, { t: 'input', key: 'say', placeholder: 'What should Claude do?', action: `say:new:${folder}`, hint: routeHint({ how: 'new', cwd: folder }) }),
    ];
    return { key: pane, blocks };
  }

  /** A chat's messages, oldest first, and the phone's own message after them until the chat has it. */
  private messageBlocks(messages: ChatMessage[], pane: string, now: number, empty: string): Block[] {
    const out = messages.map((m): Block => {
      const key = `m:${m.key}`;
      if (m.kind === 'claude') return { t: 'text', key, text: plainText(m.text), bubble: true, lines: 9 };
      if (m.kind === 'you') return { t: 'text', key, text: `You: ${m.text}` };
      return { t: 'text', key, text: m.text, tone: m.kind === 'note' ? 'bad' : 'muted', size: 'sm' };
    });
    const p = this.pending;
    if (p?.pane === pane && now - p.at < PENDING_MS) out.push({ t: 'text', key: 'pending', text: `You: ${p.text}` });
    else if (!out.length && empty) out.push({ t: 'text', key: 'none', text: empty, tone: 'muted', size: 'sm' });
    return out;
  }

  /** The box to message the chat, or, while Claude starts for it in an Island terminal, a line saying so; and a note when that failed. */
  private startBlocks(pane: string, now: number, input: Block): Block[] {
    const out: Block[] = [];
    const note = this.chatNote?.pane === pane && this.chatNote.until > now ? this.chatNote : null;
    if (note) out.push({ t: 'text', key: 'note', text: note.text, tone: 'warn', size: 'sm' });
    const start = this.follows.find((f) => (f.from ? `chat:${f.from}` : `new:${f.cwd}`) === pane);
    // Until the chat shows up, a second message would start Claude a second time.
    if (start) out.push({ t: 'text', key: 'starting', text: now - start.at > SLOW_START_MS ? 'Still starting on your PC. Its terminal (Terminal) shows if it waits for something.' : 'Starting Claude on your PC…', tone: 'muted', size: 'sm' });
    else out.push(input);
    return out;
  }

  /** A chat on the list by its id: live, else closed recently. */
  private findChat(id: string): SessionView | ClosedView | null {
    return this.sessions.find((s) => s.id === id) ?? this.tracker?.get(id) ?? this.closed.find((c) => c.id === id) ?? this.tracker?.getClosed(id) ?? null;
  }

  /** The running Island terminal a live chat is in: Island started it there, or its process is the terminal's child. */
  private islandTerm(s: Pick<SessionView, 'sessionId' | 'pid'>): TermInfo | null {
    if (!this.terms.length) return null;
    const mine = this.started.get(s.sessionId);
    const t = mine ? this.terms.find((x) => x.id === mine && x.exit === null) : undefined;
    return t ?? terminalFor(s.pid, this.terms, (pid) => this.chainOf(pid));
  }

  /** Where a message to this chat goes now (phonechat.ts routeFor). */
  private routeOf(chat: SessionView | ClosedView): ChatRoute {
    const live = 'pid' in chat && chat.alive ? chat : null;
    return routeFor({ sessionId: chat.sessionId, cwd: chat.cwd, entrypoint: chat.entrypoint, pid: live?.pid ?? 0, alive: live !== null }, live ? this.islandTerm(live) : null);
  }

  /** Types a message into an Island terminal and presses Enter; why it couldn't, or null. */
  private async typeInto(term: string, text: string): Promise<string | null> {
    const typed = await native.termWrite(term, oneLine(text));
    if (!typed.ok) return typed.error;
    // Enter on its own, a moment later: in the same write it would read as part of a paste.
    await sleep(ENTER_GAP_MS);
    const entered = await native.termWrite(term, '\r');
    return entered.ok ? null : entered.error;
  }

  /**
   * A message from the phone's chat box, sent where its chat lives (phonechat.ts routeFor): typed
   * into the Island terminal it runs in, or into its own terminal; a VS Code chat or a closed one
   * continues in an Island terminal running `claude --resume` (a copy, with --fork-session, while
   * the VS Code panel still holds it); `id` null starts a new chat in `folder`. The phone's card
   * follows a chat started this way once the tracker sees it. A failure throws a PhoneError,
   * which the phone shows.
   */
  async messageChat(id: string | null, text: string, folder = ''): Promise<ChatRoute> {
    const words = text.trim();
    if (!words) throw new PhoneError('Type a message first');
    const chat = id === null ? null : this.findChat(id);
    if (id !== null && !chat) throw new PhoneError('That chat is gone');
    if (id === null && !folder) throw new PhoneError('Pick a folder first');
    const route: ChatRoute = chat ? this.routeOf(chat) : { how: 'new', cwd: folder };
    const pane = id === null ? `new:${folder}` : `chat:${id}`;
    this.ctx.log('phone message', { session: id?.slice(0, 8) ?? 'new', how: route.how });
    if (route.how === 'term') {
      const why = await this.typeInto(route.term, words);
      if (why !== null) throw new PhoneError(`Couldn't send it: ${why}`);
    } else if (route.how === 'inject') {
      const r = await native.claudeInject(route.pid, words);
      if (!r.ok) throw new PhoneError(`Couldn't type it into its terminal: ${r.error ?? 'no answer'}`);
    } else {
      if (!route.cwd) throw new PhoneError("Couldn't start Claude: that chat's folder isn't known");
      const title = chat ? clip(chat.displayTitle, 60) : clip(oneLine(words), 60);
      const r = await native.termOpen({ cwd: route.cwd, shell: null, program: 'claude', args: claudeArgs(route, words) ?? [], cols: TERM_COLS, rows: TERM_ROWS, title, claude: true });
      if (!r.ok) throw new PhoneError(`Couldn't start Claude: ${r.error}`);
      this.follows.push({ term: r.value.id, pid: r.value.pid, from: route.how === 'new' ? null : route.sessionId, cwd: route.cwd, at: Date.now() });
      void this.refreshTerms();
    }
    if (id !== null && (route.how === 'term' || route.how === 'inject')) {
      this.finished.delete(id);
      this.hooks.turnStart.set(id, Date.now());
    }
    this.pending = { pane, text: words, at: Date.now() };
    if (this.chatNote?.pane === pane) this.chatNote = null;
    this.pollSoon(400);
    return route;
  }

  /**
   * Claude started in an Island terminal: once the tracker sees its chat there (its process is the
   * terminal's child), Island remembers it, and the phone's card moves to it from the chat it
   * continues (or the new chat). A terminal that ended first says so on that card.
   */
  private followChats(now = Date.now()): void {
    if (!this.follows.length) return;
    // Their terminals' list moves meanwhile (started, ended): asked again with every poll.
    void this.refreshTerms();
    for (const f of [...this.follows]) {
      const pane = f.from ? `chat:${f.from}` : `new:${f.cwd}`;
      const s = f.pid > 0 ? this.sessions.find((x) => x.alive && x.pid > 0 && this.chainOf(x.pid).includes(f.pid)) : undefined;
      if (s) {
        this.follows = this.follows.filter((x) => x !== f);
        this.started.set(s.sessionId, f.term);
        if (f.from && f.from !== s.id) this.forks.set(f.from, s.id);
        const next = `chat:${s.id}`;
        if (this.paneKey() === pane) this.pane = { kind: 'chat', id: s.id };
        if (this.pending?.pane === pane) this.pending.pane = next;
        if (this.chatNote?.pane === pane) this.chatNote = null;
        this.ctx.log('phone chat started', { session: s.id.slice(0, 8), from: f.from?.slice(0, 8) ?? 'new' });
        if (this.pane.kind === 'chat' && this.pane.id === s.id) void this.loadChat();
        continue;
      }
      const term = this.terms.find((t) => t.id === f.term);
      // Ended, or not listed a while after it started: it is gone.
      const ended = term ? term.exit !== null : now - f.at > 15_000;
      if (!ended && now - f.at < FOLLOW_MS) continue;
      this.follows = this.follows.filter((x) => x !== f);
      if (this.pending?.pane === pane) this.pending = null;
      const code = term?.exit != null ? ` (exit code ${term.exit})` : '';
      this.chatNote = { pane, text: ended ? `Claude stopped on your PC before the chat began${code}. Its terminal shows why.` : "Claude didn't start on your PC. Its terminal shows why.", until: now + 5 * 60_000 };
      this.ctx.log('phone chat did not start', { term: f.term, ended, exit: term?.exit ?? null });
    }
  }

  private paneKey(): string {
    const p = this.pane;
    return p.kind === 'chat' ? `chat:${p.id}` : p.kind === 'new' ? `new:${p.folder}` : 'list';
  }

  /** Island's terminals, asked again (after starting one, while following one). */
  private async refreshTerms(): Promise<void> {
    this.onTerms(await native.termList());
  }

  private onTerms(list: unknown): void {
    this.terms = Array.isArray(list) ? list.filter((t): t is TermInfo => typeof t === 'object' && t !== null && typeof (t as TermInfo).id === 'string' && typeof (t as TermInfo).pid === 'number') : [];
    // A terminal that went: whatever Island started in it is no longer there.
    for (const [sid, term] of this.started) if (!this.terms.some((t) => t.id === term && t.exit === null)) this.started.delete(sid);
    this.ctx.update();
  }

  /** Reads the phone's open chat from its transcript again (only once it grew); one read at a time, the last asked always done. */
  private async loadChat(): Promise<void> {
    if (this.chatReading) {
      this.chatAgain = true;
      return;
    }
    this.chatReading = true;
    try {
      do {
        this.chatAgain = false;
        await this.readOpenChat();
      } while (this.chatAgain);
    } catch (err) {
      this.ctx.log('chat read failed', String(err));
    } finally {
      this.chatReading = false;
    }
  }

  private async readOpenChat(): Promise<void> {
    if (this.pane.kind !== 'chat') return;
    const id = this.pane.id;
    const chat = this.findChat(id);
    if (!chat) return;
    const file = ('transcript' in chat && chat.transcript) || (this.projectsDir ? await findTranscript(this.projectsDir, chat.sessionId, chat.cwd) : null);
    const [st] = file ? await native.statMany([file]) : [null];
    const size = st?.size ?? 0;
    const log = this.chatLog;
    if (log && log.id === id && log.file === file && log.size === size) return;
    const messages = file && st ? await readChat(file, CHAT_MESSAGES) : [];
    this.chatLog = { id, file, size, messages };
    // The phone's message is in the chat now: it shows as the chat's own line.
    const p = this.pending;
    if (p?.pane === `chat:${id}` && messages.some((m) => m.kind === 'you' && m.at >= p.at - 60_000 && sameText(m.text, p.text))) this.pending = null;
    this.ctx.update();
  }

  // ---------------------------------------------------------------- actions

  async action(name: string, arg: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : '';
    // Card inputs name their target after a colon ("reply:<request id>"); the typed text is the arg.
    const [verb, ref] = splitOnce(name, ':');
    switch (verb) {
      case 'jump':
        // A row of Claude Status's: Claude Code's go where Claude Code would (Open), the rest where the widget did.
        await this.jump(id);
        break;
      case 'dismiss':
        if (!this.engine || !id) break;
        this.engine.dismiss(id);
        this.rows = this.rows.filter((r) => r.id !== id);
        break;
      case 'router':
        this.auto = { ...this.auto, on: await native.setRouter(!this.auto.on) };
        break;
      case 'unfold':
        this.unfold = { on: !this.unfold.on, asked: Date.now() };
        break;
      case 'point':
        // The pointer on a finished chat's reply box holds its pop-up; off it, untouched, the pop-up goes soon after.
        if (arg === true) this.ctx.surface({ key: `done:${ref}`, ms: POINT_MS, level: 'expanded', bump: false });
        else if (!this.typing.has(ref)) this.ctx.surface({ key: `done:${ref}`, ms: POINT_LEAVE_MS, level: 'expanded', bump: false });
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
        this.typing.add(ref);
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
      // Claude's card on a phone. Its card opens on the phone that tapped (a phone-started action).
      case 'chat':
        if (!id) break;
        this.pane = { kind: 'chat', id };
        await this.loadChat();
        this.ctx.openCard?.();
        break;
      case 'chat-new':
        if (!id) break;
        this.pane = { kind: 'new', folder: id };
        this.ctx.openCard?.();
        break;
      case 'chat-back':
        this.pane = { kind: 'list' };
        break;
      case 'say':
        // The chat box: "say:<session id>", or "say:new:<folder>" for a new chat; the typed text is the arg.
        if (!id.trim()) break;
        try {
          await (ref.startsWith('new:') ? this.messageChat(null, id, ref.slice(4)) : this.messageChat(ref, id));
        } finally {
          this.ctx.update();
        }
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
        // Not a moment of its own, so it shows every time it is pressed.
        this.ctx.alert('shake');
        this.ctx.alert('glow', 'warn');
        if (s && this.opts().notifications) this.ctx.notify(`${s.displayTitle} (test)`, `Needs you in ${s.project}. Alt+Shift+0 to switch.`, false);
        this.flash('Test alert: a session that needs you looks like this', 'warn', 'bell', 4000);
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
      slot: 1, tool: null, operation: null, turnStartMs: now - 754000, lastAssistantText: null, transcript: null, version: null,
      context: { used: 197_000, window: 1_000_000, share: 0.197, fullIn: 2 * 3600_000 }, turns: [200_000, 900_000, 1_200_000], ...over,
    });
    this.later(2500, () => {
      this.sessions = [
        base({ id: 'a1', sessionId: 'a1', displayTitle: 'Implement the island UI', operation: 'Editing renderer.ts', slot: 1 }),
        base({ id: 'b2', sessionId: 'b2', displayTitle: 'Schedule Matcher export', status: 'awaiting_input', label: 'Your turn', tone: 'turn', project: 'schedule-matcher', slot: 2, lastActivityMs: now - 180000, lastAssistantText: 'Added the CSV export and tests.' }),
      ];
      this.usageState = { data: { fiveHour: { pct: 41, resetsAt: now + 3 * 3600000 }, sevenDay: { pct: 60, resetsAt: now + 5 * 86400000 }, models: [] }, error: null, source: 'api', fetchedAt: now };
      this.tokenTotals = { fresh: 4100000, cached: 182000000, output: 900000 };
      // Claude Status's rows for them, and a Claude app chat beside them.
      this.rows = [
        { id: 'a1', label: 'Implement the island UI', where: 'Terminal', tag: 'TERMINAL', state: 'running', word: 'running', since: (now - 754000) / 1000, grey: false, unread: false, hidden: false, progress: { value: 0.62, text: '~4 min left', method: 'history est.' } },
        { id: 'b2', label: 'Schedule Matcher export', where: 'Terminal', tag: 'TERMINAL', state: 'done', word: 'done', since: (now - 180000) / 1000, grey: false, unread: true, hidden: false, progress: null },
        { id: 'app:1', label: 'Trip ideas', where: 'Claude app', tag: 'APP CHAT', state: 'idle', word: 'idle', since: (now - 3600000) / 1000, grey: true, unread: false, hidden: false, progress: null },
      ];
      this.ctx.update();
    });
  }
}
