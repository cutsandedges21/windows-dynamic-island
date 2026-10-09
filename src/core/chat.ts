// Talking to the bot: a thin bar under the bot and the pill (Moss's option A; see chatBarRect in
// layout.ts) and, past it, a card with the answer. The island itself never opens for it. Local AI
// does the answering (src/activities/local.ts, its chat()); with the Claude switch on, Ask
// Claude's backend answers instead. Text goes in through textContent only.

import { SpringSet } from './animator';
import { icon } from './icons';
import type { Anchor, Rect } from './layout';
import { BUBBLE_GAP } from './layout';
import { springs } from './spring';

/** What the bar and its card show; Local AI's chat() builds it. */
export interface ChatView {
  phase: 'idle' | 'setup' | 'thinking' | 'streaming' | 'answer' | 'error';
  /** The last question asked. */
  question: string;
  /** The answer so far (streaming) or in full. */
  answer: string;
  error: string;
  /** Who answers: the local model's name, or "Claude". */
  model: string;
  brain: 'local' | 'claude';
  /** Ask Claude has a backend (Claude Code, or an API key): the switch can offer it. */
  canClaude: boolean;
  /** No local model yet: the one Set up would download, and its size (null when Island can't run one). */
  needsModel: { model: string | null; download: string | null } | null;
  /** A model download under way, 0..1, or null before its first numbers. */
  setupShare: number | null;
  copied: boolean;
  /** Questions and answers so far in this chat. */
  turns: number;
}

export type ChatAction = 'send' | 'stop' | 'new' | 'copy' | 'brain' | 'setup' | 'retry' | 'close';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function button(cls: string, label: string, iconName?: Parameters<typeof icon>[0]): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.innerHTML = icon(iconName); // static icon markup only
  const span = el('span', '');
  span.textContent = label;
  b.append(span);
  return b;
}

export class ChatBar {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly bar: HTMLElement;
  private readonly card: HTMLElement;
  private readonly local: HTMLButtonElement;
  private readonly claude: HTMLButtonElement;
  private readonly set: SpringSet<'x' | 'y' | 'w' | 'o'>;
  private open = false;
  private anchor: Anchor = 'top';
  private barRect: Rect | null = null;
  private cardH = 0;
  private view: ChatView | null = null;
  private lastCardSig = '';

  constructor(
    stage: HTMLElement,
    private readonly onAction: (action: ChatAction, arg?: unknown) => void,
    /** The card changed size: the island republishes its hit area. */
    private readonly onResize: () => void,
  ) {
    this.el = el('div', 'chat');
    this.bar = el('div', 'chat-bar');
    this.input = el('input', 'chat-input');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.placeholder = 'Ask me anything…';
    const brain = el('div', 'chat-brain');
    this.local = button('chat-brain-opt', 'Local');
    this.claude = button('chat-brain-opt', 'Claude');
    brain.append(this.local, this.claude);
    this.bar.append(this.input, brain);
    this.card = el('div', 'chat-card');
    this.el.append(this.bar, this.card);
    stage.append(this.el);

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value.trim();
        const busy = this.view?.phase === 'thinking' || this.view?.phase === 'streaming';
        if (!text || busy) return;
        this.input.value = '';
        this.onAction('send', text);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.onAction('close');
      }
    });
    this.local.addEventListener('click', () => this.onAction('brain', 'local'));
    this.claude.addEventListener('click', () => this.onAction('brain', 'claude'));
    this.card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b) this.onAction(b.dataset.act as ChatAction, b.dataset.arg);
    });
    new ResizeObserver(() => {
      const h = this.card.offsetHeight;
      if (h === this.cardH) return;
      this.cardH = h;
      this.onResize();
    }).observe(this.card);

    this.set = new SpringSet(
      { x: 0, y: 0, w: 200, o: 0 },
      (v) => {
        const st = this.el.style;
        st.transform = `translate3d(${v.x}px, ${v.y}px, 0)`;
        st.width = `${Math.max(0, v.w)}px`;
        st.opacity = String(Math.max(0, Math.min(1, v.o)));
        this.el.style.pointerEvents = v.o > 0.5 && this.open ? 'auto' : 'none';
      },
      springs.shell,
      { o: 0.002 },
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Shows the bar at `bar` (null closes it). A card past it carries the answer. */
  place(anchor: Anchor, bar: Rect | null, opts: { immediate?: boolean } = {}): void {
    const opening = bar !== null && !this.open;
    this.open = bar !== null;
    this.el.classList.toggle('up', anchor === 'bottom');
    this.anchor = anchor;
    if (!bar) {
      this.barRect = null;
      this.set.set({ o: 0 }, { config: springs.fade, immediate: opts.immediate });
      this.input.blur();
      return;
    }
    this.barRect = bar;
    // Opening, it rises out of the gap under the island rather than sliding in from where it last was.
    if (opening) this.set.set({ x: bar.x, y: bar.y + (anchor === 'bottom' ? 6 : -6), w: bar.w }, { immediate: true });
    this.set.set({ x: bar.x, y: bar.y, w: bar.w, o: 1 }, { config: { x: springs.shell, y: springs.shell, w: springs.shell, o: springs.fade }, immediate: opts.immediate });
  }

  focus(): void {
    if (this.open) this.input.focus({ preventScroll: true });
  }

  /** The bar and, when it shows, the card: where the island must take the mouse. */
  hitRects(): Rect[] {
    const bar = this.barRect;
    if (!bar) return [];
    const out = [bar];
    if (this.cardH > 0) {
      out.push(this.anchor === 'bottom' ? { x: bar.x, y: bar.y - BUBBLE_GAP - this.cardH, w: bar.w, h: this.cardH } : { x: bar.x, y: bar.y + bar.h + BUBBLE_GAP, w: bar.w, h: this.cardH });
    }
    return out;
  }

  render(view: ChatView): void {
    this.view = view;
    this.local.classList.toggle('on', view.brain === 'local');
    this.claude.classList.toggle('on', view.brain === 'claude');
    this.claude.disabled = !view.canClaude;
    this.claude.title = view.canClaude ? 'Ask Claude instead (Ask Claude\'s login or API key)' : 'Set up Ask Claude in Activities to use it here';
    this.input.placeholder = view.turns ? 'Follow up…' : 'Ask me anything…';
    this.renderCard(view);
  }

  /** The card: rebuilt only when what it shows changes, the streaming text patched in place. */
  private renderCard(v: ChatView): void {
    const busy = v.phase === 'thinking' || v.phase === 'streaming';
    let kind: string;
    if (v.phase === 'setup') kind = 'setup';
    else if (v.needsModel && v.brain === 'local' && !busy && v.phase !== 'answer' && v.phase !== 'error') kind = 'needs';
    else if (busy || v.phase === 'answer' || v.phase === 'error') kind = v.phase;
    else kind = 'none';
    const sig = `${kind}|${v.brain}|${v.copied}|${v.canClaude}|${v.needsModel?.model ?? ''}|${v.turns > 0}`;
    if (sig !== this.lastCardSig) {
      this.lastCardSig = sig;
      this.card.replaceChildren(...this.cardParts(kind, v));
    }
    this.card.classList.toggle('shown', kind !== 'none');
    const text = this.card.querySelector<HTMLElement>('.chat-text');
    if (text) {
      const want = kind === 'error' ? v.error : kind === 'thinking' ? '' : v.answer;
      if (text.textContent !== want) text.textContent = want;
      if (kind === 'streaming') text.scrollTop = text.scrollHeight;
    }
    const share = this.card.querySelector<HTMLElement>('.chat-share');
    if (share) {
      const value = v.setupShare;
      share.textContent = value == null ? 'Starting…' : `${Math.round(value * 100)}%`;
      const fill = this.card.querySelector<HTMLElement>('.chat-progress i');
      if (fill) fill.style.transform = `scaleX(${value ?? 0})`;
    }
  }

  private cardParts(kind: string, v: ChatView): HTMLElement[] {
    const head = (title: string, sub?: string) => {
      const h = el('div', 'chat-head');
      const t = el('div', 'chat-title');
      t.textContent = title;
      h.append(t);
      if (sub) {
        const s = el('div', 'chat-sub');
        s.textContent = sub;
        h.append(s);
      }
      return h;
    };
    const act = (label: string, action: ChatAction, style = '', iconName?: Parameters<typeof icon>[0], arg?: string) => {
      const b = button(`chat-btn ${style}`.trim(), label, iconName);
      b.dataset.act = action;
      if (arg) b.dataset.arg = arg;
      return b;
    };
    const row = (...items: HTMLElement[]) => {
      const r = el('div', 'chat-btns');
      r.append(...items);
      return r;
    };
    const via = v.brain === 'claude' ? 'via Claude' : v.model;
    switch (kind) {
      case 'needs': {
        const m = v.needsModel!;
        const what = m.model ? `${m.model}${m.download ? ` · ${m.download} download` : ''}` : 'Install Ollama, or pick a model in Activities › Local AI.';
        const parts = [head('I need a brain first', what)];
        const buttons: HTMLElement[] = [];
        if (m.model) buttons.push(act('Set up', 'setup', 'primary', 'download'));
        if (v.canClaude) buttons.push(act('Ask Claude instead', 'brain', '', undefined, 'claude'));
        if (buttons.length) parts.push(row(...buttons));
        return parts;
      }
      case 'setup': {
        const bar = el('div', 'chat-progress');
        bar.append(el('i', ''));
        const share = el('div', 'chat-share');
        return [head('Getting my brain', 'Downloading the model'), bar, share];
      }
      case 'thinking':
        return [head('Thinking…', via), row(act('Stop', 'stop', '', 'stop'))];
      case 'streaming':
        return [head('Writing…', via), el('div', 'chat-text'), row(act('Stop', 'stop', '', 'stop'))];
      case 'answer':
        return [el('div', 'chat-text'), row(act(v.copied ? 'Copied' : 'Copy', 'copy', '', v.copied ? 'check' : 'copy'), act('New chat', 'new', 'ghost', 'plus')), this.sig(via)];
      case 'error':
        return [head('That did not work'), el('div', 'chat-text'), row(act('Retry', 'retry', '', 'refresh'))];
      default:
        return [];
    }
  }

  private sig(text: string): HTMLElement {
    const s = el('div', 'chat-model');
    s.textContent = text;
    return s;
  }
}
