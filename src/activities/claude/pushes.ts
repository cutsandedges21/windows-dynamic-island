// Claude's moments on the phone (Settings › Notifications › Send to my phone): what each
// push says, and a gate that sends each moment once. Hooks and polling often report the
// same moment two or three times: a PermissionRequest, then its permission_prompt
// notification, then the session list noticing the chat waits.

import { questionsOf } from './hooks';
import { describeTool } from './status';

export type PushKind = 'done' | 'error' | 'asks' | 'permission' | 'needs' | 'waiting';

export interface PhonePush {
  title: string;
  body: string;
  /** ntfy emoji shortcode, shown before the title. */
  tag: string;
  /** ntfy priority: 3 is the default, 4 high. */
  priority: number;
}

const BODY_MAX = 400;

/** A long message cut to about what a phone notification shows. */
export function clipBody(text: string, max = BODY_MAX): string {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** An AskUserQuestion's questions, each with its numbered options. */
export function askText(input: unknown): string {
  return questionsOf(input)
    .map((q) => [q.question, ...(q.options ?? []).map((o, i) => `${i + 1}. ${o.label}`)].join('\n'))
    .join('\n\n');
}

/** What a permission request is for, in the island's words ("Running command: npm test"). */
export function permissionText(tool: string | undefined, input: unknown): string {
  const d = describeTool(tool, input);
  return d.detail ? `${d.verb}: ${d.detail}` : d.verb;
}

/** The push for one moment of the chat titled `chat`. */
export function pushFor(kind: PushKind, chat: string, detail: string): PhonePush {
  const body = clipBody(detail);
  switch (kind) {
    case 'done':
      return { title: `Done · ${chat}`, body: body || 'Your turn.', tag: 'white_check_mark', priority: 3 };
    case 'error':
      return { title: `Error · ${chat}`, body: body || 'The chat stopped on an error.', tag: 'x', priority: 4 };
    case 'asks':
      return { title: `Question · ${chat}`, body: body || 'Claude has a question for you.', tag: 'question', priority: 4 };
    case 'permission':
      return { title: `Needs permission · ${chat}`, body: body || 'Claude wants to use a tool.', tag: 'lock', priority: 4 };
    case 'needs':
      return { title: `Needs you · ${chat}`, body: body || 'Claude is waiting for you.', tag: 'bell', priority: 4 };
    case 'waiting':
      return { title: `Your turn · ${chat}`, body: body || 'Claude is waiting for your reply.', tag: 'hourglass', priority: 3 };
  }
}

/** Reports of "needs you" this close together are one moment. */
const NEEDS_MS = 30_000;
/** The same question or request reported again (PreToolUse, then PermissionRequest). */
const SAME_MS = 120_000;
/** A finished turn comes from the Stop hook and from polling. */
const DONE_MS = 5_000;
/** "Waiting for your input" comes a minute after a turn ends: news only after a quiet spell. */
const QUIET_MS = 600_000;

export class PushGate {
  private readonly at = new Map<string, number>();

  /**
   * True when this moment is news for the chat `sid`: send it. `key` tells questions and
   * permission requests apart; a different one is a new moment even right after another.
   */
  allow(sid: string, kind: PushKind, now: number, key = ''): boolean {
    const since = (k: string) => now - (this.at.get(`${sid}|${k}`) ?? -Infinity);
    const asking = kind === 'asks' || kind === 'permission';
    const fresh = asking
      ? since(`${kind}:${key}`) > SAME_MS
      : kind === 'needs'
        ? since('needs') > NEEDS_MS
        : kind === 'waiting'
          ? since('any') > QUIET_MS
          : since('done') > DONE_MS;
    if (!fresh) return false;
    const mark = (k: string) => this.at.set(`${sid}|${k}`, now);
    mark('any');
    if (asking) mark(`${kind}:${key}`);
    if (asking || kind === 'needs') mark('needs');
    if (kind === 'done' || kind === 'error') mark('done');
    if (this.at.size > 400) for (const [k, t] of this.at) if (now - t > QUIET_MS) this.at.delete(k);
    return true;
  }
}
