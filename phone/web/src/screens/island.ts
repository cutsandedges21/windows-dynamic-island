// The island screen: the live copy of the island at the top, the card or Control Center under it,
// a Back button under a card, the bar at the bottom (Claude, Terminal, Screen, Send, More; the
// Clipboard and Lock PC are in More), and, while the PC can't be reached, its name and when it was
// last seen.

import type { Tone } from '../../../../src/core/segments';
import type { IslandMsg } from '../../../../src/remote/protocol';
import { lastSeenText, retryText } from '../format';
import { IslandView } from '../island-view';
import type { LinkState } from '../link/api';
import { button, h, ico, spinner } from '../ui';

type PillMsg = Extract<IslandMsg, { t: 'pill' }>;
type ViewMsg = Extract<IslandMsg, { t: 'view' }>;

export interface IslandHooks {
  action(action: string, arg: unknown): void;
  back(): void;
  /** Claude's card (chats, and a box to message one). */
  claude(): void;
  terminal(): void;
  /** The PC's screen (Chrome Remote Desktop). */
  screen(): void;
  send(): void;
  menu(): void;
  retry(): void;
}

/** Room under a card for the Back button. */
const BACK_ROOM = 56;

export class IslandScreen {
  readonly el: HTMLElement;
  readonly inbox: HTMLElement;
  private readonly main: HTMLElement;
  private readonly view: IslandView;
  private readonly backBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly barButtons: HTMLButtonElement[] = [];
  private name = '';
  private state: LinkState = { s: 'idle' };
  private lastSeen: number | null = null;
  private hasPill = false;
  private glowTone: Tone | null = null;
  private back = false;
  private noteText = '';
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly onResize = () => this.view.measure();

  constructor(root: HTMLElement, private readonly hooks: IslandHooks) {
    this.main = h('div', { class: 'ph-main' });
    this.view = new IslandView(this.main, (action, arg) => hooks.action(action, arg));
    this.backBtn = h('button', { class: 'ph-back', type: 'button' }, [ico('chevron-left'), h('span', { text: 'Control Center' })]);
    this.backBtn.addEventListener('click', () => hooks.back());
    this.note = h('div', { class: 'ph-note' });
    this.hint = h('div', { class: 'ph-hint', text: 'Tap the island for Control Center' });
    this.overlay = h('div', { class: 'ph-overlay' });
    this.view.onCard = (r) => this.placeUnderCard(r);
    this.main.append(this.hint, this.backBtn, this.note, this.overlay);

    const item = (label: string, iconName: string, fn: () => void, needsLink: boolean) => {
      const b = h('button', { class: 'ph-tab', type: 'button' }, [ico(iconName), h('span', { text: label })]);
      b.addEventListener('click', fn);
      if (needsLink) this.barButtons.push(b);
      return b;
    };
    // Five across fit a 320 px wide iPhone (Display Zoom): an icon over a one-word label.
    const bar = h('nav', { class: 'ph-bar' }, [
      item('Claude', 'claude', () => hooks.claude(), true),
      item('Terminal', 'terminal', () => hooks.terminal(), true),
      item('Screen', 'laptop', () => hooks.screen(), false),
      item('Send', 'upload', () => hooks.send(), true),
      item('More', 'more', () => hooks.menu(), false),
    ]);
    this.inbox = h('div', { class: 'ph-inbox' });
    this.el = h('div', { class: 'ph-screen-island' }, [this.main, this.inbox, bar]);
    root.append(this.el);
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.view.measure());
    this.render();
  }

  setName(name: string): void {
    this.name = name;
    this.render();
  }

  /** The connection: online, connecting, offline (with when the PC was last seen). */
  setLink(state: LinkState, lastSeen: number | null): void {
    this.state = state;
    this.lastSeen = lastSeen;
    clearInterval(this.ticker);
    if (state.s === 'offline') this.ticker = setInterval(() => this.render(), 1000);
    this.render();
  }

  /** Words under an urgent card (Allow only on the PC), or none. */
  setNote(text: string): void {
    this.noteText = text;
    this.layoutExtras();
  }

  pill(m: PillMsg): void {
    this.hasPill = true;
    this.glowTone = m.frame.glow?.tone ?? null;
    this.view.drawPill(m.frame, m.bot);
    this.render();
  }

  /** A view to draw; `back` shows the Back button under it. */
  draw(m: ViewMsg, back: boolean): void {
    const tone: Tone | null = m.urgent ? (m.urgent === 'claude' ? 'claude' : (this.glowTone ?? 'accent')) : null;
    this.back = back && m.view !== null && !m.urgent;
    this.view.drawView(m.view, tone);
    this.hint.classList.toggle('on', m.view === null && this.hasPill);
    this.layoutExtras();
  }

  /** Nothing under the pill, at once (the island's answer follows). */
  clear(): void {
    this.back = false;
    this.view.drawView(null, null);
    this.hint.classList.toggle('on', this.hasPill);
    this.layoutExtras();
  }

  private layoutExtras(): void {
    const urgent = this.main.querySelector('.ph-stage.ph-urgent') !== null;
    this.note.textContent = urgent ? this.noteText : '';
    this.view.setReserve(this.back || (urgent && this.noteText) ? BACK_ROOM : 0);
    this.backBtn.classList.toggle('on', this.back);
    this.note.classList.toggle('on', urgent && Boolean(this.noteText));
  }

  /** The Back button and the note ride just under the card as it moves. */
  private placeUnderCard(r: { x: number; y: number; w: number; h: number } | null): void {
    const y = r ? `${Math.round(r.y + r.h + 12)}px` : '';
    this.backBtn.style.top = y;
    this.note.style.top = y;
    if (!r) {
      this.backBtn.classList.remove('on');
      this.note.classList.remove('on');
    } else this.layoutExtras();
  }

  private render(): void {
    const s = this.state;
    const online = s.s === 'online';
    for (const b of this.barButtons) b.disabled = !online;
    this.main.classList.toggle('ph-dim', !online && this.hasPill);
    const show = !online || !this.hasPill;
    this.overlay.classList.toggle('on', show);
    if (!show) return;
    const name = this.name || 'Your PC';
    let line = '';
    let sub: Array<HTMLElement | string> = [];
    let why = '';
    let retry = false;
    switch (s.s) {
      case 'idle':
      case 'connecting':
        line = s.s === 'connecting' && s.attempt > 1 ? `Connecting again (try ${s.attempt})` : 'Connecting…';
        sub = [spinner()];
        if (this.lastSeen) why = `Last seen ${lastSeenText(this.lastSeen, Date.now())}`;
        break;
      case 'online':
        line = 'Connected';
        sub = [spinner(), 'Waiting for the island…'];
        break;
      case 'offline':
        line = `${name} is offline · last seen ${lastSeenText(this.lastSeen, Date.now())}`;
        sub = [spinner(), retryText(s.retryAt, Date.now())];
        why = s.why ? `${s.why}. Island must be running on the PC, and the PC awake.` : 'Island must be running on the PC, and the PC awake.';
        retry = true;
        break;
      case 'denied':
        line = s.why === 'version' ? 'Island on your PC speaks a different version' : `${name} said no`;
        why = s.why === 'version' ? 'Update Island on your PC (or reload this page), then try again.' : '';
        retry = true;
        break;
      case 'removed':
        line = `${name} removed this phone`;
        break;
    }
    const card = h('div', { class: 'ph-ov-card' }, [
      ico('laptop', 'ph-ov-icon'),
      h('div', { class: 'ph-ov-name', text: name }),
      h('div', { class: 'ph-ov-line', text: line }),
      sub.length ? h('div', { class: 'ph-ov-sub' }, sub) : null,
      why ? h('div', { class: 'ph-ov-why', text: why }) : null,
      retry ? button('Try now', { icon: 'refresh', style: 'secondary', onclick: () => this.hooks.retry() }) : null,
    ]);
    this.overlay.replaceChildren(card);
  }

  destroy(): void {
    clearInterval(this.ticker);
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.view.destroy();
    this.el.remove();
  }
}
