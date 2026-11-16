// The Cursor activity: Cursor's agent in the island the way Claude Code is (the shared engine,
// src/activities/agent/engine.ts): finished cards, the reply window (a reply goes in as the
// chat's next message: the stop hook's followup_message), the phone, and, when asked for,
// Allow or Deny before Cursor runs a command. Cursor's hook events have their own names and
// shapes: they are turned into the engine's here. Cursor shares no plan limits.
// Design: docs/superpowers/specs/2026-10-30-cursor-in-island-design.md.

import { native, type CursorEnv } from '../../core/native';
import type { Block } from '../../core/sheet';
import { PhoneError } from '../../remote/hub';
import type { AgentBrand } from '../agent/brand';
import { AgentActivity } from '../agent/engine';
import { focusSession } from '../claude/focus';
import type { HookEvent } from '../claude/hooks';
import type { ChatRoute } from '../claude/phonechat';
import { EDITOR_HOSTS } from '../claude/procinfo';
import type { ClosedView, SessionView } from '../claude/tracker';
import type { ChatMessage } from '../claude/transcript';
import { CursorTracker, type CursorHook } from './tracker';
import { chatMessages, folderOf, parseLines } from './transcript';

export class CursorActivity extends AgentActivity {
  readonly brand: AgentBrand = { id: 'cursor', name: 'Cursor', product: 'Cursor', icon: 'cursor', tone: 'cursor', moments: { asks: 'claude-asks', done: 'claude-done', error: 'claude-error' } };
  private env: CursorEnv | null = null;
  protected override tracker: CursorTracker | null = null;

  constructor() {
    super('cursor');
  }

  // ---------------------------------------------------------------- lifecycle

  protected async startAgent(): Promise<void> {
    if (native.demo) return;
    this.env = await native.cursorEnv();
    if (!this.env || !this.alive) return;
    this.tracker = new CursorTracker(this.env);
    this.every(3000, () => void this.pollSessions(), true);
  }

  protected available(): boolean {
    return Boolean(this.env);
  }

  /** Ask me here before Cursor runs a command (its command hooks are installed only then). */
  private gateOn(): boolean {
    return this.ctx.options<{ askBeforeCommands?: boolean }>().askBeforeCommands === true;
  }

  // ---------------------------------------------------------------- Cursor's hooks, in the engine's words

  protected override onHook(ev: HookEvent): void {
    if ((ev.agent ?? 'claude') !== this.brand.id) return;
    const raw = ev as CursorHook;
    this.tracker?.noteHook(raw);
    const said = this.translate(raw);
    if (said === 'later') return;
    if (said) super.onHook(said);
    else {
      this.pollSoon(150);
      this.ctx.update();
    }
  }

  /**
   * The engine's event for a Cursor hook; null for what only the tracker needs; 'later' when it
   * is handled once the chat list caught up. Waiting hooks the island won't hold are let go here.
   */
  private translate(raw: CursorHook): HookEvent | null | 'later' {
    const sid = CursorTracker.chatOf(raw);
    const base: HookEvent = { ...raw, session_id: sid, cwd: folderOf(raw.workspace_roots?.[0]) || raw.cwd || '' };
    switch (raw.hook_event_name) {
      case 'sessionStart':
        return { ...base, hook_event_name: 'SessionStart' };
      case 'sessionEnd':
        return { ...base, hook_event_name: 'SessionEnd' };
      case 'beforeSubmitPrompt':
        return { ...base, hook_event_name: 'UserPromptSubmit' };
      case 'stop': {
        const words = this.tracker?.lastWords(sid) ?? undefined;
        if (raw.status === 'completed' || !raw.status) return { ...base, hook_event_name: 'Stop', last_assistant_message: words };
        // Stopped by the user, or failed: nothing to reply to.
        if (raw.request_id) void native.hookReply(raw.request_id, 'pass');
        if (raw.status === 'error') {
          void this.pollSessions().then(() => super.onHook({ ...base, request_id: undefined, hook_event_name: 'Stop', last_assistant_message: words }));
          return 'later';
        }
        return null;
      }
      case 'beforeShellExecution':
      case 'beforeMCPExecution': {
        if (!this.gateOn()) {
          if (raw.request_id) void native.hookReply(raw.request_id, 'pass');
          return null;
        }
        if (raw.hook_event_name === 'beforeShellExecution') {
          return { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: raw.command ?? '' }, cwd: raw.cwd || base.cwd };
        }
        let input: unknown = raw.tool_input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input) as unknown;
          } catch {
            /* shown as it came */
          }
        }
        return { ...base, hook_event_name: 'PermissionRequest', tool_name: `mcp__${raw.mcp_server_name ?? 'mcp'}__${raw.tool_name ?? 'tool'}`, tool_input: input };
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- limits

  /** Cursor keeps its plan's usage to itself. */
  protected override limitBlocks(): Block[] {
    return [];
  }

  // ---------------------------------------------------------------- opening and continuing

  private chatOf(id: string): (SessionView | ClosedView) | null {
    return this.tracker?.get(id) ?? this.tracker?.getClosed(id) ?? null;
  }

  /** Brings up the Cursor window a chat lives in (its window for that folder), else opens the folder in Cursor. */
  private async raiseCursor(chat: SessionView | ClosedView): Promise<boolean> {
    if (!this.tracker) return false;
    const probe = this.tracker.probe;
    await native.allowForeground();
    if ('pid' in chat && chat.alive && chat.pid) {
      const ok = await focusSession({ sessionId: chat.sessionId, pid: chat.pid, cwd: chat.cwd, title: chat.title, name: chat.name, entrypoint: chat.entrypoint, host: chat.host }, probe, (...p) => this.ctx.log(...p));
      if (ok) return true;
    }
    probe.load(await native.procSnapshot());
    const pids = [...probe.table].filter(([, p]) => EDITOR_HOSTS.get(p.name) === 'Cursor').map(([pid]) => pid);
    const windows = await native.winEnum();
    const project = chat.project.toLowerCase();
    const hwnd = windows.find((w) => pids.includes(w.pid) && project && w.title.toLowerCase().includes(project))?.hwnd;
    if (hwnd != null && (await native.activate(hwnd))) return true;
    if (chat.cwd) return native.cursorOpen(chat.cwd);
    const any = windows.find((w) => pids.includes(w.pid))?.hwnd;
    return any != null && (await native.activate(any));
  }

  async switchTo(id: string, source = 'click'): Promise<boolean> {
    const chat = this.chatOf(id);
    if (!chat) return false;
    let ok = false;
    try {
      ok = await this.raiseCursor(chat);
    } catch (err) {
      this.ctx.log('switch error', String(err));
    }
    this.ctx.log('switch', { source, session: id.slice(0, 8), ok });
    if (!ok) {
      this.flash("Couldn't find Cursor's window", 'bad', 'alert');
      this.ctx.alert('shake');
    }
    return ok;
  }

  async reopen(id: string): Promise<boolean> {
    return this.switchTo(id, 'reopen');
  }

  /** Cursor takes no text from outside its window: the reply goes on the clipboard, and Cursor comes up. */
  protected async continueSession(id: string, text: string): Promise<void> {
    const chat = this.chatOf(id);
    this.inputFor = null;
    if (!chat) {
      this.flash('That chat is gone', 'bad', 'alert');
      return;
    }
    let ok = false;
    try {
      await native.clipboardSetText(text);
      ok = await this.raiseCursor(chat);
    } catch (err) {
      this.ctx.log('continue error', String(err));
    }
    this.ctx.log('continue', { session: id.slice(0, 8), how: 'clipboard', ok });
    this.finished.delete(id);
    if (ok) this.flash('Cursor is up. Paste your reply in its chat (copied)', 'warn', 'enter', 7000);
    else this.flash('Reply copied. Paste it in Cursor', 'warn', 'clipboard', 6000);
    this.pollSoon(500);
  }

  protected openText(): string {
    return 'Open Cursor';
  }

  protected lateHint(): string {
    return 'Brings up Cursor with your reply copied: paste it in the chat.';
  }

  protected override reopenTip(): string {
    return 'Brings up Cursor at this folder';
  }

  // ---------------------------------------------------------------- Cursor's card on a phone

  /** A message from the phone reaches a Cursor chat only while it waits for a reply (its stop hook). */
  protected override routeOf(chat: SessionView | ClosedView): ChatRoute {
    return this.hooks.holds.some((h) => h.sessionId === chat.sessionId) ? { how: 'inject', pid: 0 } : { how: 'resume', sessionId: chat.sessionId, cwd: chat.cwd };
  }

  protected override routeHint(route: ChatRoute): string {
    return route.how === 'inject' ? 'Goes to Cursor as your reply.' : 'Cursor takes a message from here only while a chat waits for your reply.';
  }

  /** Nowhere to start a Cursor chat from a phone: no folders to offer. */
  override recentFolders(): string[] {
    return [];
  }

  override async messageChat(id: string | null, text: string): Promise<ChatRoute> {
    const words = text.trim();
    if (!words) throw new PhoneError('Type a message first');
    if (id === null) throw new PhoneError('New Cursor chats start in Cursor on your PC.');
    const hold = this.hooks.holds.find((h) => h.sessionId === id);
    if (!hold) throw new PhoneError("This chat isn't waiting for a reply. Write in it in Cursor on your PC.");
    this.pending = { pane: `chat:${id}`, text: words, at: Date.now() };
    await this.sendReply(hold.requestId, words);
    return { how: 'inject', pid: 0 };
  }

  protected async chatFile(chat: SessionView | ClosedView): Promise<string | null> {
    return this.tracker?.transcriptOf(chat.sessionId) ?? ('transcript' in chat ? chat.transcript : null);
  }

  protected async readChatMessages(file: string, max: number): Promise<ChatMessage[]> {
    const text = await native.readText(file, 4 * 1024 * 1024);
    return text ? chatMessages(parseLines(text), max) : [];
  }

  /** Never started from Island: messageChat sends only through a waiting stop hook. */
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
          hooks: await native.cursorHooksStatus(),
          gate: this.gateOn(),
        };
      case 'hooks-preview': {
        const a = (arg ?? {}) as { install?: boolean; gate?: boolean };
        return native.cursorHooksPreview(Boolean(a.install), Boolean(a.gate));
      }
      case 'hooks-write': {
        const a = (arg ?? {}) as { install?: boolean; gate?: boolean; fingerprint?: string };
        return native.cursorHooksWrite(Boolean(a.install), Boolean(a.gate), String(a.fingerprint ?? ''));
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
