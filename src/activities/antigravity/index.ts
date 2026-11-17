// The Antigravity activity: Google's Antigravity agent (its app, IDE and CLI, on Gemini models; it
// replaced Gemini CLI in 2026) in the island the way Claude Code is (the shared engine,
// src/activities/agent/engine.ts): finished cards, the reply window (a reply keeps the agent going:
// the Stop hook's "continue"), the phone, and, when asked for, Allow or Deny before it runs a
// command (Allow really approves it: auto_approve). Its hook events carry no text: requests and
// answers come from its transcripts. Antigravity shares no plan limits.
// Design: docs/superpowers/specs/2026-10-30-antigravity-in-island-design.md.

import { native, type AntigravityEnv } from '../../core/native';
import type { Block } from '../../core/sheet';
import { PhoneError } from '../../remote/hub';
import type { AgentBrand } from '../agent/brand';
import { AgentActivity } from '../agent/engine';
import { focusSession } from '../claude/focus';
import type { HookEvent } from '../claude/hooks';
import type { ChatRoute } from '../claude/phonechat';
import type { ClosedView, SessionView } from '../claude/tracker';
import type { ChatMessage } from '../claude/transcript';
import { AntigravityTracker, type AgHook } from './tracker';
import { chatMessages, folderOf, parseSteps } from './transcript';

/** The windows a conversation can be brought up in, by product. */
const WINDOW_EXES: Record<string, string[]> = { app: ['antigravity.exe'], ide: ['antigravity ide.exe'], cli: [] };

export class AntigravityActivity extends AgentActivity {
  readonly brand: AgentBrand = { id: 'antigravity', name: 'Antigravity', product: 'Antigravity', icon: 'antigravity', tone: 'antigravity', moments: { asks: 'claude-asks', done: 'claude-done', error: 'claude-error' } };
  private env: AntigravityEnv | null = null;
  protected override tracker: AntigravityTracker | null = null;

  constructor() {
    super('antigravity');
  }

  protected async startAgent(): Promise<void> {
    if (native.demo) return;
    this.env = await native.antigravityEnv();
    if (!this.env || !this.alive) return;
    this.tracker = new AntigravityTracker(this.env);
    this.every(3000, () => void this.pollSessions(), true);
  }

  protected available(): boolean {
    return Boolean(this.env);
  }

  private gateOn(): boolean {
    return this.ctx.options<{ askBeforeCommands?: boolean }>().askBeforeCommands === true;
  }

  // ---------------------------------------------------------------- Antigravity's hooks, in the engine's words

  protected override onHook(ev: HookEvent): void {
    if ((ev.agent ?? 'claude') !== this.brand.id) return;
    const raw = ev as AgHook;
    this.tracker?.noteHook(raw);
    const said = this.translate(raw);
    if (said === 'later') return;
    if (said) super.onHook(said);
    else {
      this.pollSoon(150);
      this.ctx.update();
    }
  }

  private translate(raw: AgHook): HookEvent | null | 'later' {
    const sid = AntigravityTracker.chatOf(raw);
    const base: HookEvent = { ...raw, session_id: sid, cwd: folderOf(raw.workspacePaths?.[0]), transcript_path: raw.transcriptPath ?? null, model: raw.modelName };
    switch (raw.hook_event_name) {
      case 'SessionStart':
        return { ...base, hook_event_name: 'SessionStart' };
      case 'PreInvocation':
        // The first model call of a turn: the user just sent something.
        return raw.invocationNum === 0 ? { ...base, hook_event_name: 'UserPromptSubmit' } : null;
      case 'Stop': {
        // Its last answer is in the transcript: read it first (well inside the pipe's 900 ms).
        const failed = raw.terminationReason === 'error';
        if (failed && raw.request_id) void native.hookReply(raw.request_id, 'pass');
        void (this.tracker?.refresh(sid) ?? Promise.resolve(null))
          .catch(() => null)
          .then((sum) => {
            const ev: HookEvent = { ...base, hook_event_name: 'Stop', last_assistant_message: sum?.lastAssistant ?? undefined };
            if (failed) return this.pollSessions().then(() => super.onHook({ ...ev, request_id: undefined }));
            super.onHook(ev);
          });
        return 'later';
      }
      case 'PreToolUse': {
        if (!this.gateOn()) {
          if (raw.request_id) void native.hookReply(raw.request_id, 'decline');
          return null;
        }
        const call = raw.toolCall ?? {};
        const command = typeof call.args?.CommandLine === 'string' ? call.args.CommandLine : '';
        if (call.name === 'run_command' || command) return { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } };
        return { ...base, hook_event_name: 'PermissionRequest', tool_name: call.name ?? 'tool', tool_input: call.args ?? {} };
      }
      default:
        return null;
    }
  }

  protected override limitBlocks(): Block[] {
    return [];
  }

  // ---------------------------------------------------------------- opening and continuing

  private chatOf(id: string): (SessionView | ClosedView) | null {
    return this.tracker?.get(id) ?? this.tracker?.getClosed(id) ?? null;
  }

  private productOf(chat: SessionView | ClosedView): string {
    return (chat.entrypoint ?? 'antigravity-app').replace('antigravity-', '');
  }

  /** Brings up the window a conversation lives in: the CLI's terminal, else the app's or the IDE's window. */
  private async raise(chat: SessionView | ClosedView): Promise<boolean> {
    if (!this.tracker) return false;
    const probe = this.tracker.probe;
    await native.allowForeground();
    const product = this.productOf(chat);
    if (product === 'cli' && 'pid' in chat && chat.alive && chat.pid) {
      return focusSession({ sessionId: chat.sessionId, pid: chat.pid, cwd: chat.cwd, title: chat.title, name: chat.name, entrypoint: chat.entrypoint, host: chat.host }, probe, (...p) => this.ctx.log(...p));
    }
    probe.load(await native.procSnapshot());
    const names = WINDOW_EXES[product] ?? WINDOW_EXES.app;
    const pids = [...probe.table].filter(([, p]) => names.includes(p.name.toLowerCase())).map(([pid]) => pid);
    const windows = await native.winEnum();
    const project = chat.project.toLowerCase();
    const hwnd = windows.find((w) => pids.includes(w.pid) && project && w.title.toLowerCase().includes(project))?.hwnd ?? windows.find((w) => pids.includes(w.pid))?.hwnd;
    if (hwnd != null && (await native.activate(hwnd))) return true;
    if (product === 'cli') return false;
    return native.antigravityOpen(product, product === 'ide' ? chat.cwd : '');
  }

  async switchTo(id: string, source = 'click'): Promise<boolean> {
    const chat = this.chatOf(id);
    if (!chat) return false;
    let ok = false;
    try {
      ok = await this.raise(chat);
    } catch (err) {
      this.ctx.log('switch error', String(err));
    }
    this.ctx.log('switch', { source, session: id.slice(0, 8), ok });
    if (!ok) {
      this.flash("Couldn't find Antigravity's window", 'bad', 'alert');
      this.ctx.alert('shake');
    }
    return ok;
  }

  async reopen(id: string): Promise<boolean> {
    return this.switchTo(id, 'reopen');
  }

  /** A running CLI conversation gets the text typed in; the app and the IDE get it on the clipboard. */
  protected async continueSession(id: string, text: string): Promise<void> {
    const chat = this.chatOf(id);
    this.inputFor = null;
    if (!chat) {
      this.flash('That chat is gone', 'bad', 'alert');
      return;
    }
    const live = 'pid' in chat && chat.alive && chat.pid ? chat : null;
    let ok = false;
    let how = 'clipboard';
    try {
      if (live && this.productOf(chat) === 'cli') {
        const r = await native.claudeInject(live.pid, text);
        ok = r.ok;
        how = 'typed';
      }
      if (!ok) {
        how = 'clipboard';
        await native.clipboardSetText(text);
        ok = await this.raise(chat);
      }
    } catch (err) {
      this.ctx.log('continue error', String(err));
    }
    this.ctx.log('continue', { session: id.slice(0, 8), how, ok });
    this.finished.delete(id);
    if (ok && how === 'typed') {
      this.hooks.turnStart.set(chat.sessionId, Date.now());
      this.flash('Sent. Antigravity is on it', 'good', 'check');
    } else if (ok) this.flash('Antigravity is up. Paste your reply there (copied)', 'warn', 'enter', 7000);
    else this.flash('Reply copied. Paste it in Antigravity', 'warn', 'clipboard', 6000);
    this.pollSoon(500);
  }

  protected openText(s: SessionView | null | undefined): string {
    return s ? `Open ${s.host}` : 'Open Antigravity';
  }

  protected lateHint(s: SessionView): string {
    return this.productOf(s) === 'cli' ? 'Types your reply into its terminal and sends it.' : `Brings up ${s.host} with your reply copied: paste it there.`;
  }

  protected override reopenTip(c: ClosedView): string {
    return `Brings up ${c.host || 'Antigravity'}`;
  }

  // ---------------------------------------------------------------- the phone

  protected override routeOf(chat: SessionView | ClosedView): ChatRoute {
    return this.hooks.holds.some((h) => h.sessionId === chat.sessionId) ? { how: 'inject', pid: 0 } : { how: 'resume', sessionId: chat.sessionId, cwd: chat.cwd };
  }

  protected override routeHint(route: ChatRoute): string {
    return route.how === 'inject' ? 'Goes to Antigravity as your reply.' : 'Antigravity takes a message from here only while a chat waits for your reply.';
  }

  override recentFolders(): string[] {
    return [];
  }

  override async messageChat(id: string | null, text: string): Promise<ChatRoute> {
    const words = text.trim();
    if (!words) throw new PhoneError('Type a message first');
    if (id === null) throw new PhoneError('New Antigravity chats start in Antigravity on your PC.');
    const hold = this.hooks.holds.find((h) => h.sessionId === id);
    if (!hold) throw new PhoneError("This chat isn't waiting for a reply. Write in it in Antigravity on your PC.");
    this.pending = { pane: `chat:${id}`, text: words, at: Date.now() };
    await this.sendReply(hold.requestId, words);
    return { how: 'inject', pid: 0 };
  }

  protected async chatFile(chat: SessionView | ClosedView): Promise<string | null> {
    return this.tracker?.transcriptOf(chat.sessionId) ?? ('transcript' in chat ? chat.transcript : null);
  }

  protected async readChatMessages(file: string, max: number): Promise<ChatMessage[]> {
    const text = await native.readText(file, 8 * 1024 * 1024);
    return text ? chatMessages(parseSteps(text), max) : [];
  }

  protected chatProgram(): { program: string; args: string[]; claude: boolean } {
    return { program: '', args: [], claude: false };
  }

  // ---------------------------------------------------------------- Activities window

  async command(cmd: string, arg: unknown): Promise<unknown> {
    switch (cmd) {
      case 'snapshot':
        return {
          available: Boolean(this.env) || native.demo,
          env: this.env,
          sessions: this.sessions,
          closed: this.closed,
          cards: this.hooks.cards.length,
          hooksSeenAt: this.hooks.lastEventAt,
          hooks: await native.antigravityHooksStatus(),
          gate: this.gateOn(),
        };
      case 'hooks-preview': {
        const a = (arg ?? {}) as { install?: boolean; gate?: boolean };
        return native.antigravityHooksPreview(Boolean(a.install), Boolean(a.gate));
      }
      case 'hooks-write': {
        const a = (arg ?? {}) as { install?: boolean; gate?: boolean; fingerprint?: string };
        return native.antigravityHooksWrite(Boolean(a.install), Boolean(a.gate), String(a.fingerprint ?? ''));
      }
      case 'refresh':
        await this.pollSessions();
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
