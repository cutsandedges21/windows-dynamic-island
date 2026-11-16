// The Codex activity: OpenAI's Codex in the island the way Claude Code is (the shared engine,
// src/activities/agent/engine.ts): permission cards, the reply window, finished cards, the
// plan's limits, the phone. Here: Codex's chats (tracker.ts, from hooks and session files),
// and how a chat is opened, continued and reopened where it lives (open.ts).
// Design: docs/superpowers/specs/2026-10-30-codex-in-island-design.md.

import { agoText } from '../../core/format';
import { native, type CodexEnv } from '../../core/native';
import type { Block } from '../../core/sheet';
import type { AgentBrand } from '../agent/brand';
import { AgentActivity } from '../agent/engine';
import { focusSession } from '../claude/focus';
import type { HookEvent } from '../claude/hooks';
import type { ChatRoute } from '../claude/phonechat';
import { EDITOR_HOSTS } from '../claude/procinfo';
import type { ClosedView, SessionView } from '../claude/tracker';
import type { ChatMessage } from '../claude/transcript';
import { weekWindowStart } from '../claude/usage';
import { chatRoute, codexArgs, codexRouteHint, openRoute, threadUrl, type CodexChat } from './open';
import { chatMessages } from './rollout';
import { CodexTracker } from './tracker';

/** Limits older than this get a line saying when Codex last read them. */
const LIMITS_STALE_MS = 5 * 60_000;

export class CodexActivity extends AgentActivity {
  readonly brand: AgentBrand = { id: 'codex', name: 'Codex', product: 'Codex', icon: 'codex', tone: 'codex', moments: { asks: 'claude-asks', done: 'claude-done', error: 'claude-error' } };
  private env: CodexEnv | null = null;
  protected override tracker: CodexTracker | null = null;
  /** When Codex last read the plan's limits (they come with its turns). */
  private limitsAsOf: number | null = null;

  constructor() {
    super('codex');
  }

  // ---------------------------------------------------------------- lifecycle

  protected async startAgent(): Promise<void> {
    if (native.demo) return;
    this.env = await native.codexEnv();
    if (!this.env || !this.alive) return;
    void this.refreshTerms();
    this.tracker = new CodexTracker(this.env);
    // A turn written to a session file: look at once.
    void native.watch('codex-sessions', this.env.sessionsDir, true);
    this.onDispose(() => void native.unwatch('codex-sessions'));
    this.listen<{ id: string }>('fs-change', (c) => {
      if (c.id === 'codex-sessions') this.pollSoon(300);
    });
    this.every(3000, () => void this.pollSessions().then(() => this.readUsage()), true);
    this.every(1000, () => this.checkResets());
  }

  protected available(): boolean {
    return Boolean(this.env);
  }

  /** Hooks make a chat live the moment they arrive, before the engine shows anything for it. */
  protected override onHook(ev: HookEvent): void {
    if ((ev.agent ?? 'claude') === this.brand.id) this.tracker?.noteHook(ev);
    super.onHook(ev);
  }

  /** The plan's limits and the week's tokens, from what the session files said last. */
  private readUsage(): void {
    if (!this.tracker) return;
    const l = this.tracker.limits();
    this.limitsAsOf = l.asOf;
    this.usageState = l.data ? { data: l.data, error: null, source: null, fetchedAt: l.asOf } : null;
    this.tokenTotals = this.tracker.weekTokens(weekWindowStart(l.data?.sevenDay?.resetsAt ?? null));
    this.ctx.update();
  }

  // ---------------------------------------------------------------- limits

  /** Codex reads the limits with each turn: say how old they are, or why there are none. */
  protected override limitBlocks(now: number): Block[] {
    if (!this.usageState?.data) {
      return [{ t: 'text', key: 'limits-none', text: 'Plan limits show here after a Codex turn on a ChatGPT plan.', tone: 'muted', size: 'sm' }];
    }
    const blocks = super.limitBlocks(now);
    if (this.limitsAsOf && now - this.limitsAsOf > LIMITS_STALE_MS) {
      blocks.push({ t: 'text', key: 'limits-age', text: `As of ${agoText(now - this.limitsAsOf)}. Codex updates them after each turn.`, tone: 'muted', size: 'sm' });
    }
    return blocks;
  }

  // ---------------------------------------------------------------- opening and continuing

  private chatOf(id: string): (SessionView | ClosedView) | null {
    return this.tracker?.get(id) ?? this.tracker?.getClosed(id) ?? null;
  }

  private target(chat: SessionView | ClosedView): CodexChat {
    const live = 'pid' in chat && chat.alive ? chat : null;
    return { sessionId: chat.sessionId, cwd: chat.cwd, entrypoint: chat.entrypoint, pid: live?.pid ?? 0, alive: live !== null };
  }

  private async openInApp(sessionId: string): Promise<boolean> {
    const url = threadUrl(sessionId);
    if (!url) return false;
    await native.allowForeground();
    return native.openUrl(url);
  }

  /** Brings up the editor a chat lives in (its window for that folder, when there are several). */
  private async raiseEditor(chat: SessionView | ClosedView): Promise<boolean> {
    if (!this.tracker) return false;
    const probe = this.tracker.probe;
    if ('pid' in chat && chat.alive && chat.pid) {
      return focusSession({ sessionId: chat.sessionId, pid: chat.pid, cwd: chat.cwd, title: chat.title, name: chat.name, entrypoint: chat.entrypoint, host: chat.host }, probe, (...p) => this.ctx.log(...p));
    }
    probe.load(await native.procSnapshot());
    const editor = chat.editorHost || probe.runningEditor();
    const pids = [...probe.table].filter(([, p]) => EDITOR_HOSTS.get(p.name) === editor).map(([pid]) => pid);
    const windows = await native.winEnum();
    const hwnd = windows.find((w) => pids.includes(w.pid) && w.title.toLowerCase().includes(chat.project.toLowerCase()))?.hwnd ?? windows.find((w) => pids.includes(w.pid))?.hwnd;
    return hwnd != null && (await native.activate(hwnd));
  }

  async switchTo(id: string, source = 'click'): Promise<boolean> {
    const chat = this.chatOf(id);
    if (!chat || !this.tracker) return false;
    const t = this.target(chat);
    const route = openRoute(t);
    let ok = false;
    try {
      if (route === 'app') ok = await this.openInApp(chat.sessionId);
      else if (route === 'editor') ok = await this.raiseEditor(chat);
      else if (route === 'terminal' && 'pid' in chat && this.islandTerm(chat)) {
        // Started from the phone in an Island terminal, with no window of its own: the Codex app can show it.
        ok = await this.openInApp(chat.sessionId);
      } else if (route === 'terminal' && 'pid' in chat) {
        ok = await focusSession({ sessionId: chat.sessionId, pid: chat.pid, cwd: chat.cwd, title: chat.title, name: chat.name, entrypoint: chat.entrypoint, host: chat.host }, this.tracker.probe, (...p) => this.ctx.log(...p));
      } else ok = await native.codexResume(chat.sessionId, chat.cwd, null, false);
    } catch (err) {
      this.ctx.log('switch error', String(err));
    }
    this.ctx.log('switch', { source, session: id.slice(0, 8), route, ok });
    if (!ok) {
      this.flash(route === 'app' ? "Couldn't open the Codex app" : "Couldn't find that window", 'bad', 'alert');
      this.ctx.alert('shake');
    }
    return ok;
  }

  async reopen(id: string): Promise<boolean> {
    return this.switchTo(id, 'reopen');
  }

  protected async continueSession(id: string, text: string): Promise<void> {
    const chat = this.chatOf(id);
    this.inputFor = null;
    if (!chat) {
      this.flash('That chat is gone', 'bad', 'alert');
      return;
    }
    const t = this.target(chat);
    const route = openRoute(t);
    let ok = false;
    let how: string = route;
    try {
      if (route === 'app' || route === 'editor') {
        // Neither has a way in for text from outside: it goes on the clipboard, the chat comes up.
        await native.clipboardSetText(text);
        ok = route === 'app' ? await this.openInApp(chat.sessionId) : await this.raiseEditor(chat);
      } else if (route === 'terminal' && 'pid' in chat) {
        const term = this.islandTerm(chat);
        if (term) {
          ok = (await this.typeInto(term.id, text)) === null;
          how = 'island';
        } else {
          const r = await native.claudeInject(chat.pid, text);
          ok = r.ok;
          if (!ok) {
            await native.clipboardSetText(text);
            await this.switchTo(id, 'continue');
            this.flash('Prompt copied: paste it with Ctrl+V', 'warn', 'clipboard', 5000);
            return;
          }
        }
      } else ok = await native.codexResume(chat.sessionId, chat.cwd, text, true);
    } catch (err) {
      this.ctx.log('continue error', String(err));
    }
    this.ctx.log('continue', { session: id.slice(0, 8), how, ok });
    this.finished.delete(id);
    if (ok && (route === 'app' || route === 'editor')) {
      this.flash(route === 'app' ? 'Chat opened. Paste your reply there (copied)' : 'Codex panel up. Paste your reply there (copied)', 'warn', 'enter', 7000);
    } else if (ok) {
      this.hooks.turnStart.set(chat.sessionId, Date.now());
      this.flash('Sent. Codex is on it', 'good', 'check');
    } else this.flash("Couldn't send that prompt", 'bad', 'alert');
    this.pollSoon(500);
  }

  protected openText(s: SessionView | null | undefined): string {
    if (!s) return 'Open the chat';
    const route = openRoute(this.target(s));
    if (route === 'app') return 'Open in the Codex app';
    if (route === 'resume') return 'Reopen in a terminal';
    return `Open ${s.host}`;
  }

  protected lateHint(s: SessionView): string {
    const route = openRoute(this.target(s));
    if (route === 'app') return 'Opens the chat in the Codex app with your reply copied: paste it there.';
    if (route === 'editor') return `Brings up ${s.host} with your reply copied: paste it in the Codex panel.`;
    if (route === 'resume') return 'Reopens the chat in a terminal with your reply.';
    if (this.islandTerm(s)) return 'Types your reply into the chat in its Island terminal.';
    return 'Types your reply into its terminal and sends it.';
  }

  protected override reopenTip(c: ClosedView): string {
    const route = openRoute(this.target(c));
    if (route === 'app') return 'Reopens in the Codex app';
    if (route === 'editor') return `Brings up ${c.editorHost || c.host || 'your editor'}`;
    return 'Reopens in a new terminal';
  }

  // ---------------------------------------------------------------- Codex's card on a phone

  protected override routeOf(chat: SessionView | ClosedView): ChatRoute {
    const t = this.target(chat);
    return chatRoute(t, t.alive && 'pid' in chat ? this.islandTerm(chat) : null);
  }

  protected override routeHint(route: ChatRoute): string {
    return codexRouteHint(route);
  }

  protected async chatFile(chat: SessionView | ClosedView): Promise<string | null> {
    return this.tracker?.transcriptOf(chat.sessionId) ?? ('transcript' in chat ? chat.transcript : null);
  }

  protected async readChatMessages(file: string, max: number): Promise<ChatMessage[]> {
    const scan = await native.codexRolloutScan(file, 0);
    return scan ? chatMessages(scan.lines, max) : [];
  }

  protected chatProgram(route: ChatRoute, words: string): { program: string; args: string[]; claude: boolean } {
    return { program: this.env?.codexExe ?? 'codex', args: codexArgs(route, words) ?? [], claude: false };
  }

  // ---------------------------------------------------------------- Activities window

  async command(cmd: string, arg: unknown): Promise<unknown> {
    switch (cmd) {
      case 'snapshot':
        return {
          available: Boolean(this.env) || native.demo,
          env: this.env,
          usage: this.usageState ? { ...this.usageState, data: this.limitsNow() } : null,
          asOf: this.limitsAsOf,
          tokens: this.tokenTotals,
          sessions: this.sessions,
          closed: this.closed,
          cards: this.hooks.cards.length,
          hooksSeenAt: this.hooks.lastEventAt,
          hooks: await native.codexHooksStatus(),
        };
      case 'hooks-preview':
        return native.codexHooksPreview(Boolean(arg));
      case 'hooks-write': {
        const a = (arg ?? {}) as { install?: boolean; fingerprint?: string };
        return native.codexHooksWrite(Boolean(a.install), String(a.fingerprint ?? ''));
      }
      case 'hooks-trust':
        return native.codexHooksTrust(Boolean(arg));
      case 'refresh':
        await this.pollSessions();
        this.readUsage();
        return true;
      case 'switch':
        return this.switchTo(String(arg));
      case 'reopen':
        return this.reopen(String(arg));
      default:
        return null;
    }
  }
}

