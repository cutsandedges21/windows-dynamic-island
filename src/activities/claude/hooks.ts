// What Claude Code's hooks tell us (through island-hook and the pipe): the tool
// running right now, permission requests and questions waiting for an answer,
// finished turns waiting for a reply typed in the island, notifications, and
// each chat's final message. Polling stays the source of truth for the session
// list; hooks make it instant and make answering from the island possible.

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  request_id?: string;
  prompt?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  hook_pid?: number;
  hook_ppid?: number;
}

/** A PermissionRequest waiting in the island. AskUserQuestion arrives this way too. */
export interface PermissionCard {
  requestId: string;
  sessionId: string;
  tool: string;
  input: unknown;
  cwd: string;
  at: number;
}

/** A finished turn whose Stop hook waits for a reply typed in the island. */
export interface ReplyHold {
  requestId: string;
  sessionId: string;
  /** The chat's final message (last_assistant_message). */
  message: string;
  at: number;
  /** When island-hook lets go unless the user replies or holds it longer. */
  until: number;
  /** Length of the current window, for the countdown. */
  total: number;
  /** The user clicked into the reply box. */
  held: boolean;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

/** What a Notification hook said (permission_prompt, idle_prompt, elicitation_dialog…). */
export interface Note {
  message: string;
  title?: string;
  kind: string;
  at: number;
}

/** Questions from AskUserQuestion's tool input, however they arrived. */
export function questionsOf(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string')
    .map((q) => ({
      question: q.question as string,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as unknown[])
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
            .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : undefined }))
        : [],
    }));
}

export class HookState {
  cards: PermissionCard[] = [];
  holds: ReplyHold[] = [];
  readonly current = new Map<string, { tool: string; input: unknown; at: number }>();
  readonly turnStart = new Map<string, number>();
  readonly notes = new Map<string, Note>();
  /** AskUserQuestion seen in PreToolUse: shown even when no permission prompt follows. */
  readonly asks = new Map<string, { questions: AskQuestion[]; at: number }>();
  /** Each chat's final message, straight from the Stop hook. */
  readonly lastMessage = new Map<string, { text: string; at: number }>();
  lastEventAt = 0;

  /** Folds one event in; returns what kind of moment it was. */
  apply(ev: HookEvent, now = Date.now()): 'permission' | 'stop' | 'prompt' | 'tool' | 'note' | 'other' {
    this.lastEventAt = now;
    const sid = ev.session_id ?? '';
    switch (ev.hook_event_name) {
      case 'PermissionRequest':
        if (ev.request_id) {
          this.cards.push({ requestId: ev.request_id, sessionId: sid, tool: ev.tool_name ?? 'tool', input: ev.tool_input ?? null, cwd: ev.cwd ?? '', at: now });
        }
        return 'permission';
      case 'PreToolUse':
        if (sid) {
          this.current.set(sid, { tool: ev.tool_name ?? 'tool', input: ev.tool_input ?? null, at: now });
          if (ev.tool_name === 'AskUserQuestion') {
            const questions = questionsOf(ev.tool_input);
            if (questions.length) this.asks.set(sid, { questions, at: now });
          }
        }
        return 'tool';
      case 'PostToolUse':
        if (sid) {
          this.current.delete(sid);
          this.asks.delete(sid);
          this.notes.delete(sid);
        }
        // A tool ran, so any card for this session was answered (here or in the terminal).
        this.cards = this.cards.filter((c) => c.sessionId !== sid);
        return 'tool';
      case 'UserPromptSubmit':
        if (sid) {
          this.turnStart.set(sid, now);
          this.current.delete(sid);
          this.forget(sid);
        }
        return 'prompt';
      case 'Stop':
        if (sid) {
          this.current.delete(sid);
          this.asks.delete(sid);
          this.notes.delete(sid);
          this.cards = this.cards.filter((c) => c.sessionId !== sid);
          // A new turn ended: an older reply window for this chat is stale.
          this.holds = this.holds.filter((h) => h.sessionId !== sid);
          const text = typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message.trim() : '';
          if (text) this.lastMessage.set(sid, { text, at: now });
        }
        return 'stop';
      case 'Notification':
        if (sid && ev.message) this.notes.set(sid, { message: ev.message, title: ev.title, kind: ev.notification_type ?? '', at: now });
        return 'note';
      case 'SessionEnd':
        if (sid) {
          this.current.delete(sid);
          this.cards = this.cards.filter((c) => c.sessionId !== sid);
          this.forget(sid);
        }
        return 'other';
      default:
        return 'other';
    }
  }

  /** The chat moved on (new prompt, closed): nothing it said before still waits on the user. */
  private forget(sid: string): void {
    this.asks.delete(sid);
    this.notes.delete(sid);
    this.holds = this.holds.filter((h) => h.sessionId !== sid);
  }

  take(requestId: string): PermissionCard | null {
    const card = this.cards.find((c) => c.requestId === requestId) ?? null;
    this.cards = this.cards.filter((c) => c.requestId !== requestId);
    return card;
  }

  hold(requestId: string): ReplyHold | null {
    return this.holds.find((h) => h.requestId === requestId) ?? null;
  }

  takeHold(requestId: string): ReplyHold | null {
    const hold = this.hold(requestId);
    this.holds = this.holds.filter((h) => h.requestId !== requestId);
    return hold;
  }
}
