// Ask Claude: type a question in the pill, see "Thinking…", read the answer in place. The chat
// keeps its history, so a follow-up is one more question, and Copy and New chat sit beside the
// answer. The answer comes from Claude Code (headless, on your own Claude login) or from the
// Messages API (a key in the Credential Manager), chosen in the options. src-tauri/src/chat.rs
// does the asking, so a key never reaches the webview and the question travels only to Claude.

import type { PetSignal } from '../core/pet';
import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { bridge, type AskBackend, type AskBackends, type AskReply, type ChatTurn } from '../core/bridge';
import { clip, plainText } from '../core/format';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetButton, SheetView, Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Phase = 'idle' | 'compose' | 'thinking' | 'answer' | 'error';

export const NO_BACKEND = 'Install Claude Code, or add an Anthropic API key in Activities › Ask Claude.';
/** Messages kept in a chat; the oldest go first. */
const MAX_HISTORY = 20;
/** How long "Copied" stays on the button. */
const COPIED_MS = 1800;

/** The backend to use: the one chosen, or the other when it is the only one that works, or none. */
export function pickBackend(choice: unknown, have: AskBackends): AskBackend | null {
  const wanted: AskBackend = choice === 'api' ? 'api' : 'claude-code';
  const works = (b: AskBackend) => (b === 'api' ? have.api : have.claudeCode);
  if (works(wanted)) return wanted;
  const other: AskBackend = wanted === 'api' ? 'claude-code' : 'api';
  return works(other) ? other : null;
}

/** The chat with the newest messages kept, starting on a question. */
export function trimHistory(turns: ChatTurn[], max = MAX_HISTORY): ChatTurn[] {
  const kept = turns.slice(-max);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export class AskActivity extends BaseActivity {
  private phase: Phase = 'idle';
  private history: ChatTurn[] = [];
  private answer = '';
  private error = '';
  /** Bumps on every question and every New chat, so a late reply to an old one is ignored. */
  private turn = 0;
  /** The user tapped away while waiting: keep working, and come back with the answer. */
  private waitDismissed = false;
  private copiedAt = 0;

  constructor() {
    super('ask');
  }

  protected init(): void {}

  protected override dispose(): void {
    // Closing the activity ends the chat: nothing is kept.
    this.history = [];
    this.phase = 'idle';
    this.turn += 1;
  }

  // ---------------------------------------------------------------- state

  status(): ActivityStatus {
    switch (this.phase) {
      case 'compose':
        return { active: true, weight: 'foreground', urgent: { key: 'ask-input', level: 'maximum' }, summary: 'Ask Claude' };
      case 'thinking':
        return { active: true, weight: 'foreground', urgent: this.waitDismissed ? null : { key: `ask-wait-${this.turn}`, level: 'expanded' }, summary: 'Claude is thinking…' };
      case 'answer':
        return { active: true, weight: 'foreground', urgent: { key: `ask-answer-${this.turn}`, level: 'maximum' }, summary: clip(oneLine(this.answer), 60) };
      case 'error':
        return { active: true, weight: 'foreground', urgent: { key: `ask-error-${this.turn}`, level: 'expanded' }, summary: clip(this.error, 60) };
      default:
        return { active: false };
    }
  }

  chip(): ChipView | null {
    if (this.phase === 'thinking') return { icon: 'chat', label: 'Thinking…', tone: 'claude', pulse: true };
    if (this.phase === 'answer') return { icon: 'chat', label: 'Answered', tone: 'good' };
    return null;
  }

  /** The user tapped away from an urgent moment. */
  dismiss(key: string): void {
    if (key.startsWith('ask-wait')) {
      this.waitDismissed = true;
    } else if ((key === 'ask-input' && this.phase === 'compose') || (key.startsWith('ask-answer') && this.phase === 'answer') || (key.startsWith('ask-error') && this.phase === 'error')) {
      this.endMoment();
    }
    this.ctx.update();
  }

  private lastQuestion(): string {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].role === 'user') return this.history[i].content;
    return '';
  }

  /** Back to rest. A question that never got an answer leaves the chat with it. */
  private endMoment(): void {
    if (this.history.at(-1)?.role === 'user') this.history.pop();
    this.phase = 'idle';
  }

  // ---------------------------------------------------------------- asking

  /** Ask Claude answering: the bot thinks along. */
  override pet(): PetSignal {
    return { mood: this.phase === 'thinking' ? 'thinking' : null, moment: this.petMoment };
  }

  private async send(text: string): Promise<void> {
    const question = text.trim();
    if (!question || this.phase === 'thinking') return;
    this.history = trimHistory([...this.history, { role: 'user', content: question }]);
    const turn = ++this.turn;
    this.phase = 'thinking';
    this.waitDismissed = false;
    this.ctx.update();

    const backend = pickBackend(this.ctx.options<{ backend?: string }>().backend, await bridge.askBackends());
    if (!this.alive || turn !== this.turn) return;
    const reply: AskReply = backend ? await bridge.askClaude(backend, [...this.history]) : { ok: false, error: NO_BACKEND };
    if (!this.alive || turn !== this.turn) return; // cancelled, or a new chat began

    const answer = reply.ok && reply.text ? plainText(reply.text) : '';
    if (answer) {
      this.history = trimHistory([...this.history, { role: 'assistant', content: answer }]);
      this.answer = answer;
      this.phase = 'answer';
      this.ctx.surface({ key: `ask-answer-${turn}`, level: 'maximum', ms: 8000 });
    } else {
      this.error = reply.error || 'Claude sent no answer.';
      this.phase = 'error';
      this.ctx.surface({ key: `ask-error-${turn}`, level: 'expanded', ms: 6000 });
    }
    this.ctx.update();
  }

  async action(name: string, arg: unknown): Promise<void> {
    switch (name) {
      case 'ask':
        if (this.phase === 'thinking') this.waitDismissed = false;
        else this.phase = 'compose';
        this.ctx.open();
        break;
      case 'send':
        await this.send(typeof arg === 'string' ? arg : '');
        return;
      case 'retry': {
        const again = this.lastQuestion();
        if (this.history.at(-1)?.role === 'user') this.history.pop();
        this.phase = 'idle';
        await this.send(again);
        return;
      }
      case 'cancel':
        if (this.phase === 'thinking') this.turn += 1; // the reply, when it comes, is ignored
        this.endMoment();
        this.ctx.close();
        break;
      case 'new':
        this.turn += 1;
        this.history = [];
        this.answer = '';
        this.error = '';
        this.phase = 'compose';
        this.ctx.open();
        break;
      case 'copy':
        if (this.answer) {
          void native.clipboardSetText(this.answer);
          this.copiedAt = Date.now();
          this.later(COPIED_MS, () => this.ctx.update());
        }
        break;
    }
    this.ctx.update();
  }

  // ---------------------------------------------------------------- view

  /** A starter for the open, idle island. */
  home(): Seg[] {
    if (this.phase !== 'idle') return [];
    return [{ t: 'button', key: 'ask', icon: 'chat', label: 'Ask Claude', action: 'ask', style: 'secondary', prio: 5, tip: 'Ask Claude a question' }];
  }

  render(env: RenderEnv): Seg[] {
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const label = (text: string) => (env.vertical ? undefined : text);
    switch (this.phase) {
      case 'compose':
        return [
          { t: 'icon', key: 'icon', icon: 'chat', tone: 'claude', prio: 0 },
          { t: 'input', key: 'prompt', placeholder: this.history.length ? 'Follow up…' : 'Ask Claude…', action: 'send', cancel: 'cancel', prio: 0, min: 220 },
          { t: 'button', key: 'cancel', icon: 'x', action: 'cancel', style: 'ghost', side: 'end', prio: 1, tip: 'Cancel (Esc)' },
        ];
      case 'thinking': {
        const segs: Seg[] = [
          { t: 'icon', key: 'icon', icon: 'chat', tone: 'claude', anim: 'pulse', prio: 0 },
          { t: 'text', key: 'status', text: 'Thinking…', weight: 'semibold', prio: 0 },
        ];
        if (roomy && !env.vertical) segs.push({ t: 'text', key: 'question', text: clip(oneLine(this.lastQuestion()), 90), tone: 'muted', prio: 4, min: 60 });
        if (roomy) segs.push({ t: 'button', key: 'cancel', icon: 'x', action: 'cancel', style: 'ghost', side: 'end', prio: 1, tip: 'Stop waiting' });
        return segs;
      }
      case 'answer': {
        const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'claude', tone: 'claude', prio: 0 }];
        if (!roomy) return [...segs, { t: 'text', key: 'ready', text: 'Claude answered', weight: 'semibold', prio: 0 }];
        if (!env.vertical) segs.push({ t: 'text', key: 'answer', text: oneLine(this.answer), prio: 1, min: 120, max: env.level === 'maximum' ? undefined : 280, tip: this.answer });
        const copied = Date.now() - this.copiedAt < COPIED_MS;
        segs.push(
          { t: 'button', key: 'copy', icon: copied ? 'check' : 'copy', label: label(copied ? 'Copied' : 'Copy'), action: 'copy', style: 'secondary', side: 'end', prio: 2, tip: 'Copy the answer' },
          { t: 'button', key: 'reply', icon: 'enter', label: label('Reply'), action: 'ask', style: 'secondary', side: 'end', prio: 1, tip: 'Ask a follow-up' },
          { t: 'button', key: 'new', icon: 'plus', label: label('New chat'), action: 'new', style: 'ghost', side: 'end', prio: 3, tip: 'Start a new chat' },
        );
        return segs;
      }
      case 'error': {
        const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'alert', tone: 'warn', prio: 0 }];
        if (!env.vertical) segs.push({ t: 'text', key: 'error', text: clip(this.error, 160), prio: 1, min: 80, tip: this.error });
        if (roomy) {
          segs.push(
            { t: 'button', key: 'retry', icon: 'refresh', label: label('Retry'), action: 'retry', style: 'secondary', side: 'end', prio: 1, tip: 'Ask again' },
            { t: 'button', key: 'cancel', icon: 'x', action: 'cancel', style: 'ghost', side: 'end', prio: 2, tip: 'Dismiss' },
          );
        }
        return segs;
      }
      default:
        return [];
    }
  }

  /** The whole answer on a card, with a box for the follow-up. */
  sheet(_env: SheetEnv): SheetView | null {
    if (this.phase !== 'answer') return null;
    const copied = Date.now() - this.copiedAt < COPIED_MS;
    return {
      key: `ask-answer-${this.turn}`,
      blocks: [
        {
          t: 'head',
          key: 'head',
          icon: 'claude',
          tone: 'claude',
          title: 'Claude',
          sub: clip(oneLine(this.lastQuestion()), 70),
          buttons: [
            { key: 'copy', icon: copied ? 'check' : 'copy', label: copied ? 'Copied' : 'Copy', action: 'copy', style: 'secondary' },
            { key: 'new', icon: 'plus', label: 'New chat', action: 'new', style: 'ghost' },
          ],
        },
        { t: 'text', key: 'answer', text: this.answer, bubble: true, lines: 12 },
        { t: 'input', key: 'follow', placeholder: 'Follow up…', action: 'send' },
      ],
    };
  }

  tile(_env: SheetEnv): Tile | null {
    const chatting = this.history.length > 0;
    const buttons: SheetButton[] = [{ key: 'ask', icon: 'chat', label: chatting ? 'Follow up' : 'Ask', action: 'ask', style: 'primary' }];
    if (chatting) buttons.push({ key: 'new', icon: 'plus', label: 'New chat', action: 'new', style: 'ghost' });
    const sub = this.phase === 'thinking' ? 'Thinking…' : this.answer && chatting ? clip(oneLine(this.answer), 48) : 'Ask anything';
    return { key: 'ask', span: 2, tone: 'claude', body: { k: 'actions', icon: 'claude', label: 'Ask Claude', sub, buttons } };
  }
}
