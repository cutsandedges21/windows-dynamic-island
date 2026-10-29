// The terminal: a shell on the PC, on the phone (full screen over the island; Back returns), drawn
// by xterm.js. The tabs along the top are the PC's terminals (a dot: running or ended; ✕ ends one),
// + opens a new one, and the bar above the keyboard has what a phone keyboard lacks (Esc, Tab, a
// sticky Ctrl, arrows, ^C, Paste), the text size, and the keyboard itself. The screen follows the
// part of the page the keyboard leaves free and tells the PC each new size. Terminals keep running
// on the PC while the phone is away: back online, this screen opens the same one again and the PC
// replays its recent output onto a fresh screen.
// Design: docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md.

import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import type { TermHeader, TermInfo } from '../../../../src/remote/protocol';
import type { Link, LinkState, TermHandle } from '../link/api';
import { barKey, clampFont, dragLines, endedLine, pickTerm, readFont, tabOrder, tabTitle, termSize, withCtrl, type BarKey } from '../term';
import { button, confirmSheet, h, ico, spinner, toast } from '../ui';
import { openNewTerm, type NewTerm } from './term-new';

type TermEvents = Parameters<Link['openTerm']>[1];

export interface TerminalHooks {
  link: Link;
  /** The PC's name. */
  pc: string;
  /** The island this phone shows (the terminal shown last is kept per PC). */
  islandId: string;
  platform: 'windows' | 'macos';
  back(): void;
}

export interface TerminalStart {
  state: LinkState;
  /** Terminals allowed from phones (hello's `term`); null until the PC has said. */
  allowed: boolean | null;
  /** Folders Claude worked in, newest first (hello's `folders`). */
  folders: readonly string[];
  /** The PC's list of terminals, if one came already. */
  terms: { items: TermInfo[]; allowed: boolean } | null;
}

const FONT_KEY = 'island:phone:term-font';
const LAST_KEY = 'island:phone:term-last:';
const FONT_FAMILY = 'ui-monospace, Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace';
/** A stream the PC closed by itself is opened again at most this many times in a row. */
const RETRIES = 3;
/** Typing with no terminal to type into says so, at most this often. */
const SAY_EVERY_MS = 3000;
/** The replay is over once no output came for this long (and xterm has drawn all of it)... */
const REPLAY_QUIET_MS = 300;
/** ...or this long after asking, whatever comes. */
const REPLAY_MAX_MS = 8000;

/** The island's dark look, its accent for the cursor. */
const THEME: ITheme = {
  background: '#060708',
  foreground: '#e9e8e3',
  cursor: '#e8845f',
  cursorAccent: '#060708',
  selectionBackground: 'rgba(232, 132, 95, 0.35)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.14)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.22)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.3)',
  overviewRulerBorder: 'transparent',
  black: '#1d1f23',
  red: '#f2695d',
  green: '#5fd39b',
  yellow: '#efbd52',
  blue: '#6cb0f2',
  magenta: '#c49cf0',
  cyan: '#5cc8d6',
  white: '#d9d8d2',
  brightBlack: '#6e727a',
  brightRed: '#ff8b80',
  brightGreen: '#82e6b4',
  brightYellow: '#ffd57a',
  brightBlue: '#93c7fa',
  brightMagenta: '#d8b8fa',
  brightCyan: '#86dfe9',
  brightWhite: '#f6f5f0',
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage off: forgotten next time */
  }
}

/**
 * A key on the bar. It acts on the tap without taking the focus from the terminal, so the
 * keyboard stays up; a drag scrolls the bar instead. `repeat`: held down, it goes again and again.
 */
function key(face: string | HTMLElement, label: string, act: () => void, cls = '', repeat = false): HTMLButtonElement {
  const b = h('button', { class: `ph-term-key${cls ? ` ${cls}` : ''}`, type: 'button', 'aria-label': label }, [typeof face === 'string' ? h('span', { text: face }) : face]);
  let at: { x: number; y: number } | null = null;
  let held: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const stop = () => {
    clearTimeout(held);
    held = undefined;
  };
  b.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      at = { x: t.clientX, y: t.clientY };
      fired = false;
      stop();
      if (repeat) {
        const again = (ms: number) => {
          held = setTimeout(() => {
            fired = true;
            act();
            again(70);
          }, ms);
        };
        again(420);
      }
    },
    { passive: true },
  );
  b.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (at && Math.hypot(t.clientX - at.x, t.clientY - at.y) > 10) {
        at = null;
        stop();
      }
    },
    { passive: true },
  );
  b.addEventListener('touchend', (e) => {
    stop();
    const was = at;
    at = null;
    if (!was) return;
    // No mouse events after it: the terminal keeps the focus, and the keyboard stays up.
    e.preventDefault();
    if (!fired) act();
  });
  b.addEventListener('touchcancel', () => {
    at = null;
    stop();
  });
  // A mouse (or a keyboard's Enter on the button): the same, keeping the focus where it is.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => act());
  return b;
}

export class TerminalScreen {
  readonly el: HTMLElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly tabs: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly banner: HTMLElement;
  private readonly host: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly ctrlBtn: HTMLButtonElement;
  private readonly kbBtn: HTMLButtonElement;
  private readonly link: Link;

  private state: LinkState;
  private allowed: boolean | null;
  private folders: readonly string[];
  /** The PC's terminals, in the order they were opened; null until it has said. */
  private items: TermInfo[] | null = null;
  /** The terminal shown, or being opened (null while a new one opens). */
  private activeId: string | null = null;
  /** Whose output is on the screen. */
  private shownId: string | null = null;
  private handle: TermHandle | null = null;
  /** Bumped by every open and drop: callbacks of an older stream are ignored. */
  private gen = 0;
  private opening = false;
  /** The shown terminal's program ended. */
  private exited = false;
  /** Opening the shown terminal again: its replay replaces the screen when it starts. */
  private resetOnData = false;
  private replaying = false;
  private replayPending = 0;
  private openedAt = 0;
  private tries = 0;
  /** Gave up opening it again (the banner offers Try again). */
  private lost = false;
  /** Terminals that failed to open since the link came online (not picked by themselves again). */
  private readonly failed = new Set<string>();
  /** Terminals this phone ended (✕): when the shown one goes, another shows. */
  private readonly killed = new Set<string>();
  private error: string | null = null;
  private ctrl = false;
  private typing = false;
  private font: number;
  private sent = { cols: 0, rows: 0 };
  private saidAt = 0;
  private destroyed = false;
  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private replayTimer: ReturnType<typeof setTimeout> | undefined;
  private replayCap: ReturnType<typeof setTimeout> | undefined;
  private fling = 0;
  private readonly resizeObs: ResizeObserver | null;

  constructor(
    root: HTMLElement,
    private readonly hooks: TerminalHooks,
    start: TerminalStart,
  ) {
    this.link = hooks.link;
    this.state = start.state;
    this.allowed = start.allowed;
    this.folders = start.folders;
    this.font = readFont(read(FONT_KEY));

    const back = h('button', { class: 'ph-term-back', type: 'button', 'aria-label': 'Back' }, [ico('chevron-left')]);
    back.addEventListener('click', () => hooks.back());
    this.tabs = h('div', { class: 'ph-term-tabs', role: 'tablist' });
    this.newBtn = h('button', { class: 'ph-term-new', type: 'button', 'aria-label': 'New terminal' }, [ico('plus')]);
    this.newBtn.addEventListener('click', () => this.openNew());
    this.banner = h('div', { class: 'ph-term-banner', role: 'status' });
    this.host = h('div', { class: 'ph-term-host' });
    this.panel = h('div', { class: 'ph-term-panel' });
    this.ctrlBtn = key('Ctrl', 'Control: the next key goes with Ctrl', () => this.setCtrl(!this.ctrl), 'ph-term-ctrl');
    this.ctrlBtn.setAttribute('aria-pressed', 'false');
    this.kbBtn = key(ico('keyboard'), 'Keyboard', () => this.toggleKeyboard(), 'ph-term-kb');
    const keys = h('div', { class: 'ph-term-keyscroll' }, [
      key('Esc', 'Escape', () => this.press('esc')),
      key('Tab', 'Tab', () => this.press('tab')),
      this.ctrlBtn,
      key(ico('arrow-up'), 'Up', () => this.press('up'), '', true),
      key(ico('arrow-down'), 'Down', () => this.press('down'), '', true),
      key(ico('arrow-left'), 'Left', () => this.press('left'), '', true),
      key(ico('arrow-right'), 'Right', () => this.press('right'), '', true),
      key('^C', 'Control C: stop what runs', () => this.press('ctrl-c')),
      key(ico('clipboard'), "Paste this phone's clipboard", () => void this.paste()),
      key('A−', 'Smaller text', () => this.setFont(this.font - 1), 'ph-term-font'),
      key('A+', 'Bigger text', () => this.setFont(this.font + 1), 'ph-term-font'),
    ]);
    this.el = h('div', { class: 'ph-term' }, [
      h('header', { class: 'ph-term-head' }, [back, this.tabs, this.newBtn]),
      this.banner,
      h('div', { class: 'ph-term-body' }, [this.host, this.panel]),
      h('div', { class: 'ph-term-keys' }, [keys, this.kbBtn]),
    ]);
    root.append(this.el);
    this.layout();

    this.term = new Terminal({
      fontSize: this.font,
      fontFamily: FONT_FAMILY,
      theme: THEME,
      cursorBlink: true,
      scrollback: 5000,
      // A thin scrollbar: the fit leaves this much room for it (14 px otherwise, two columns on a phone).
      overviewRuler: { width: 6 },
      // ConPTY on the PC; its Windows build is unknown, so xterm keeps its safe line-wrapping rules.
      windowsPty: hooks.platform === 'windows' ? { backend: 'conpty' } : undefined,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.host);
    const ta = this.term.textarea;
    if (ta) {
      ta.setAttribute('autocomplete', 'off');
      ta.addEventListener('focus', () => this.setTyping(true));
      ta.addEventListener('blur', () => this.setTyping(false));
    }
    this.term.onData((d) => this.typed(d));
    this.term.onBinary((d) => this.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff), false));
    this.fitNow();

    this.resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.fitSoon()) : null;
    this.resizeObs?.observe(this.host);
    window.addEventListener('resize', this.layout);
    window.visualViewport?.addEventListener('resize', this.layout);
    window.visualViewport?.addEventListener('scroll', this.layout);
    this.touchScroll();

    this.render();
    if (start.terms) this.setTerms(start.terms.items, start.terms.allowed);
    if (this.state.s === 'online') this.ask();
  }

  // ---------------------------------------------------------------- from the app

  /** The connection: back online, the terminal shown opens again (the PC replays it). */
  setLink(s: LinkState): void {
    const was = this.state.s === 'online';
    this.state = s;
    const now = s.s === 'online';
    if (now && !was) {
      this.failed.clear();
      this.tries = 0;
      this.lost = false;
      this.ask();
      if (this.allowed !== false && this.activeId && !this.exited) this.attach(this.activeId, undefined, true);
      else this.autoPick();
    } else if (!now && was) {
      // The link's streams went with it.
      this.dropHandle();
    }
    this.render();
  }

  /** What the PC's hello says: terminals allowed from phones, and Claude's folders. */
  setHello(allowed: boolean, folders: readonly string[]): void {
    const was = this.allowed;
    this.folders = folders;
    this.allowed = allowed;
    if (!allowed) this.stopAll();
    else if (was !== true && this.state.s === 'online') this.ask();
    this.render();
  }

  /** The PC's list of terminals (`terms`). */
  setTerms(items: readonly TermInfo[], allowed: boolean): void {
    // Copies: a title or an end shown here before the PC's next list changes only this screen's.
    this.items = tabOrder(items.map((t) => ({ ...t })));
    this.allowed = allowed;
    if (!allowed) this.stopAll();
    else if (this.activeId && !this.opening && !this.handle && !this.items.some((t) => t.id === this.activeId)) {
      // It went: ended and removed on the PC, or ✕ on another phone. (While its stream is open
      // it is there, whatever an older list says.)
      this.forget();
    }
    this.autoPick();
    this.render();
  }

  /** The shown terminal is gone: nothing open, the screen blank, until another shows. */
  private forget(): void {
    this.dropHandle();
    this.activeId = null;
    this.exited = false;
    this.term.reset();
    this.shownId = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gen++;
    this.handle?.close();
    this.handle = null;
    clearTimeout(this.fitTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.replayTimer);
    clearTimeout(this.replayCap);
    cancelAnimationFrame(this.fling);
    this.resizeObs?.disconnect();
    window.removeEventListener('resize', this.layout);
    window.visualViewport?.removeEventListener('resize', this.layout);
    window.visualViewport?.removeEventListener('scroll', this.layout);
    document.documentElement.style.removeProperty('--ph-kb');
    this.term.textarea?.blur();
    this.term.dispose();
    this.el.remove();
  }

  // ---------------------------------------------------------------- streams

  private ask(): void {
    this.link.send({ t: 'term-list' });
  }

  /** The terminal to show when none is: the one shown last on this phone, else the newest running. */
  private autoPick(): void {
    if (this.activeId || this.opening || this.allowed !== true || this.state.s !== 'online' || !this.items) return;
    const id = pickTerm(
      this.items.filter((t) => !this.failed.has(t.id) && !this.killed.has(t.id)),
      read(LAST_KEY + this.hooks.islandId),
    );
    if (id) this.attach(id, undefined, true);
  }

  /**
   * Opens a terminal's stream: `id` null starts a new one (`fresh` says where and which shell).
   * `auto`: not a tap (opening the screen, coming back online); if it fails, another one is
   * picked quietly instead of showing the error.
   */
  private attach(id: string | null, fresh?: NewTerm, auto = false): void {
    if (this.destroyed) return;
    const gen = ++this.gen;
    this.handle?.close();
    this.handle = null;
    clearTimeout(this.retryTimer);
    this.lost = false;
    this.error = null;
    this.exited = false;
    this.activeId = id;
    this.opening = true;
    if (id === null || id !== this.shownId) {
      this.term.reset();
      this.shownId = id;
      this.resetOnData = false;
    } else this.resetOnData = true;
    // The PC replays an existing terminal's recent output. The questions in that old output
    // (where is the cursor? which terminal is this?) must not be answered again as if new.
    this.replayStart(id !== null);
    const size = this.measure();
    const header: TermHeader = { t: 'term', id, cols: size.cols, rows: size.rows, cwd: fresh?.cwd ?? null, shell: fresh?.shell ?? null };
    let closed = false;
    const on: TermEvents = {
      data: (bytes) => {
        if (gen === this.gen) this.output(bytes, gen);
      },
      title: (title) => {
        if (gen === this.gen) this.retitle(title);
      },
      exit: (code) => {
        if (gen !== this.gen) return;
        this.exited = true;
        this.term.write(endedLine(code));
        this.markEnded(code);
      },
      closed: () => {
        closed = true;
        if (gen === this.gen) this.streamClosed();
      },
    };
    this.render();
    this.link.openTerm(header, on).then(
      (hd) => {
        if (gen !== this.gen || this.destroyed) {
          hd.close();
          return;
        }
        this.opening = false;
        this.activeId = hd.id;
        this.shownId = hd.id;
        this.openedAt = Date.now();
        write(LAST_KEY + this.hooks.islandId, hd.id);
        if (hd.title) this.retitle(hd.title);
        this.replayQuiet(gen);
        if (closed) {
          // It closed before this came: as any close.
          this.streamClosed();
          return;
        }
        this.handle = hd;
        this.sent = size;
        // The screen may have changed size while it opened.
        this.fitNow();
        this.render();
      },
      (err: unknown) => {
        if (gen !== this.gen || this.destroyed) return;
        this.opening = false;
        this.replayStop();
        const text = err instanceof Error && err.message ? err.message : "Couldn't open the terminal.";
        this.activeId = null;
        if (id === null) {
          this.shownId = null;
          this.error = text;
          toast(text, 'bad', 5000);
        } else {
          this.failed.add(id);
          if (auto) {
            console.warn(`terminal ${id} didn't open:`, text);
            this.autoPick();
          } else this.error = text;
        }
        this.render();
      },
    );
  }

  /** Lets go of the stream (the terminal keeps running on the PC); the shown one is kept to open again. */
  private dropHandle(): void {
    this.gen++;
    this.handle?.close();
    this.handle = null;
    this.opening = false;
    this.replayStop();
    clearTimeout(this.retryTimer);
  }

  /** Terminals turned off on the PC: nothing open, nothing shown. */
  private stopAll(): void {
    this.dropHandle();
    this.activeId = null;
  }

  /**
   * The PC closed the stream: the program ended, the connection dropped, or something broke. (A
   * replay still being drawn keeps its window: its answers must not go out now either.)
   */
  private streamClosed(): void {
    this.handle = null;
    const id = this.activeId;
    if (id && this.killed.has(id) && !this.destroyed) {
      // Ended with ✕ here: the next one shows (the PC's list may have said so already).
      this.forget();
      this.autoPick();
      this.render();
      return;
    }
    if (this.opening || this.exited || this.destroyed || this.state.s !== 'online' || !id) {
      this.render();
      return;
    }
    if (Date.now() - this.openedAt > 5000) this.tries = 0;
    if (this.tries >= RETRIES) {
      this.lost = true;
      this.render();
      return;
    }
    this.tries++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.activeId === id && !this.handle && !this.opening && this.state.s === 'online') this.attach(id, undefined, true);
    }, 700 * this.tries);
  }

  private output(bytes: Uint8Array, gen: number): void {
    if (this.resetOnData) {
      this.resetOnData = false;
      this.term.reset();
    }
    if (!this.replaying) {
      this.term.write(bytes);
      return;
    }
    this.replayPending++;
    this.term.write(bytes, () => {
      if (gen !== this.gen) return;
      this.replayPending = Math.max(0, this.replayPending - 1);
      this.replayQuiet(gen);
    });
  }

  private replayStart(on: boolean): void {
    clearTimeout(this.replayTimer);
    clearTimeout(this.replayCap);
    this.replaying = on;
    this.replayPending = 0;
    if (on) this.replayCap = setTimeout(() => this.replayStop(), REPLAY_MAX_MS);
  }

  /** Output went quiet: once xterm has drawn it all and nothing more came, the replay is over. */
  private replayQuiet(gen: number): void {
    if (!this.replaying) return;
    clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => {
      if (gen === this.gen && !this.opening && this.replayPending === 0) this.replayStop();
    }, REPLAY_QUIET_MS);
  }

  private replayStop(): void {
    clearTimeout(this.replayTimer);
    clearTimeout(this.replayCap);
    this.replaying = false;
    this.replayPending = 0;
  }

  // ---------------------------------------------------------------- typing

  /** What xterm says was typed (the phone's keyboard, a paste), or its answers to the program. */
  private typed(d: string): void {
    // xterm's answers to the program's questions start with ESC. During a replay they answer old
    // output: dropped. Never worth a "not connected" either.
    const answer = d.charCodeAt(0) === 0x1b;
    if (this.replaying && answer) return;
    if (this.ctrl) {
      d = withCtrl(d);
      this.setCtrl(false);
    }
    this.send(d, !answer);
  }

  /** To the PC; `say`: when there is no terminal to take it, say so (what the user typed or pressed). */
  private send(d: string | Uint8Array, say = true): void {
    if (this.handle) {
      this.handle.write(d);
      return;
    }
    const now = Date.now();
    if (!say || now - this.saidAt < SAY_EVERY_MS) return;
    this.saidAt = now;
    if (this.exited) toast('This one ended. Open a new one with +.', 'info');
    else toast(this.state.s === 'online' ? 'Opening the terminal…' : 'Not connected', 'info');
  }

  private press(k: BarKey): void {
    const ctrl = this.ctrl;
    if (ctrl) this.setCtrl(false);
    this.term.scrollToBottom();
    this.send(barKey(k, { ctrl, appCursor: this.term.modes.applicationCursorKeysMode }));
  }

  private setCtrl(on: boolean): void {
    this.ctrl = on;
    this.ctrlBtn.classList.toggle('on', on);
    this.ctrlBtn.setAttribute('aria-pressed', String(on));
  }

  private async paste(): Promise<void> {
    this.setCtrl(false);
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast("Couldn't read this phone's clipboard", 'bad');
      return;
    }
    if (!text) {
      toast("This phone's clipboard is empty", 'info');
      return;
    }
    // As a paste: bracketed when the program asked for it, so a shell doesn't run each line at once.
    this.term.paste(text);
  }

  private setTyping(on: boolean): void {
    this.typing = on;
    this.kbBtn.classList.toggle('on', on);
    this.kbBtn.setAttribute('aria-label', on ? 'Hide the keyboard' : 'Show the keyboard');
  }

  private toggleKeyboard(): void {
    if (this.typing) this.term.blur();
    else this.term.focus();
  }

  private setFont(n: number): void {
    const f = clampFont(n);
    if (f === this.font) return;
    this.font = f;
    this.term.options.fontSize = f;
    write(FONT_KEY, String(f));
    this.fitSoon();
  }

  // ---------------------------------------------------------------- size

  /** Follows the part of the page the keyboard leaves free (iOS keeps the page full height under it). */
  private readonly layout = (): void => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    this.el.style.height = `${Math.round(height)}px`;
    this.el.style.transform = top > 0.5 ? `translateY(${Math.round(top)}px)` : '';
    const keyboard = window.innerHeight - height > 120;
    this.el.classList.toggle('ph-kb', keyboard);
    // Toasts ride above the keyboard too: from the page's bottom up to the visible part's.
    document.documentElement.style.setProperty('--ph-kb', `${keyboard ? Math.round(Math.max(0, window.innerHeight - height - top)) : 0}px`);
    this.fitSoon();
  };

  private fitSoon(): void {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fitNow(), 60);
  }

  /** Fits the terminal to its box and tells the PC when that changed its columns or rows. */
  private fitNow(): void {
    if (this.destroyed || !this.term) return;
    const { cols, rows } = this.measure();
    if (this.handle && (cols !== this.sent.cols || rows !== this.sent.rows)) {
      this.sent = { cols, rows };
      this.handle.resize(cols, rows);
    }
  }

  private measure(): { cols: number; rows: number } {
    if (this.host.clientWidth >= 20 && this.host.clientHeight >= 20) {
      try {
        this.fit.fit();
      } catch {
        /* not drawn yet: the last size stands */
      }
    }
    return termSize(this.term.cols, this.term.rows);
  }

  // ---------------------------------------------------------------- scrolling with a finger

  /**
   * xterm.js scrolls with a mouse wheel only: a finger's drag scrolls it here, whole lines at a
   * time, with a little glide after a flick. A tap still reaches xterm (it brings the keyboard up).
   */
  private touchScroll(): void {
    let y: number | null = null;
    let rest = 0;
    let at = 0;
    let speed = 0;
    this.host.addEventListener(
      'touchstart',
      (e) => {
        cancelAnimationFrame(this.fling);
        if (e.touches.length !== 1) {
          y = null;
          return;
        }
        y = e.touches[0].clientY;
        rest = 0;
        speed = 0;
        at = e.timeStamp;
      },
      { passive: true },
    );
    this.host.addEventListener(
      'touchmove',
      (e) => {
        if (y === null || e.touches.length !== 1) return;
        const ny = e.touches[0].clientY;
        const dy = ny - y;
        y = ny;
        const dt = Math.max(1, e.timeStamp - at);
        at = e.timeStamp;
        speed = 0.7 * (dy / dt) + 0.3 * speed;
        rest = this.scrollPx(rest + dy);
        e.preventDefault();
      },
      { passive: false },
    );
    const end = () => {
      if (y === null) return;
      y = null;
      if (Math.abs(speed) < 0.25) return;
      let v = speed;
      let last = performance.now();
      const step = (t: number) => {
        const dt = Math.min(48, t - last);
        last = t;
        v *= Math.pow(0.95, dt / 16);
        rest = this.scrollPx(rest + v * dt);
        if (Math.abs(v) > 0.03 && !this.destroyed) this.fling = requestAnimationFrame(step);
      };
      this.fling = requestAnimationFrame(step);
    };
    this.host.addEventListener('touchend', end);
    this.host.addEventListener('touchcancel', end);
  }

  /** Scrolls by a drag of `px` (down positive); returns the part short of a whole line. */
  private scrollPx(px: number): number {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    const rowPx = screen && this.term.rows ? screen.clientHeight / this.term.rows : this.font * 1.2;
    const { lines, rest } = dragLines(px, rowPx);
    if (!lines) return rest;
    if (this.term.buffer.active.type === 'alternate') {
      // A full-screen program (vim, less) has no lines above: arrows move it, as a mouse wheel
      // does on the PC; unless it reads the mouse itself.
      if (this.term.modes.mouseTrackingMode === 'none' && this.handle) {
        const arrow = barKey(lines < 0 ? 'up' : 'down', { appCursor: this.term.modes.applicationCursorKeysMode });
        this.handle.write(arrow.repeat(Math.min(Math.abs(lines), 8)));
      }
      return rest;
    }
    this.term.scrollLines(lines);
    return rest;
  }

  // ---------------------------------------------------------------- tabs, the + sheet

  private retitle(title: string): void {
    const t = this.items?.find((x) => x.id === this.activeId);
    if (t && title) t.title = title;
    this.renderTabs();
  }

  /** Its tab shows it ended at once (the PC's list follows); an unknown code still marks it ended. */
  private markEnded(code: number | null): void {
    const t = this.items?.find((x) => x.id === this.activeId);
    if (t) t.exit = code ?? -1;
    this.renderTabs();
  }

  private choose(id: string): void {
    if (id === this.activeId && (this.handle || this.opening || this.exited)) return;
    this.failed.delete(id);
    this.attach(id);
  }

  private async end(t: TermInfo): Promise<void> {
    if (t.exit === null) {
      const yes = await confirmSheet({
        title: `End ${tabTitle(t, this.hooks.platform)}?`,
        text: `It stops whatever runs in it on ${this.hooks.pc}.`,
        ok: 'End',
        icon: 'terminal',
        danger: true,
      });
      if (!yes) return;
    }
    if (!this.link.send({ t: 'term-kill', id: t.id })) {
      toast('Not connected', 'bad');
      return;
    }
    this.killed.add(t.id);
    // An ended one shown here has no stream to close: it goes now.
    if (t.id === this.activeId && !this.handle && !this.opening) {
      this.forget();
      this.autoPick();
      this.render();
    }
  }

  private openNew(): void {
    if (this.state.s !== 'online') {
      toast('Not connected', 'bad');
      return;
    }
    openNewTerm({ pc: this.hooks.pc, folders: this.folders, platform: this.hooks.platform, open: (t) => this.attach(null, t) });
  }

  // ---------------------------------------------------------------- drawing

  private render(): void {
    if (this.destroyed) return;
    const online = this.state.s === 'online';
    this.el.classList.toggle('ph-term-wait', !online);
    this.newBtn.disabled = !online || this.allowed !== true;
    this.renderBanner();
    this.renderPanel();
    this.renderTabs();
  }

  private renderTabs(): void {
    const items = [...(this.items ?? [])];
    // Just opened, and the PC's newer list hasn't come yet: its tab shows anyway.
    if (this.activeId && this.handle && !items.some((t) => t.id === this.activeId)) {
      items.push({ id: this.activeId, title: this.handle.title, cwd: '', shell: '', pid: 0, started: Date.now(), exit: null, attached: 1, claude: false });
    }
    this.tabs.replaceChildren(...items.map((t) => this.tab(t)));
    const on = this.tabs.querySelector<HTMLElement>('.ph-term-tab.on');
    if (on) {
      const l = on.offsetLeft;
      const r = l + on.offsetWidth;
      if (l < this.tabs.scrollLeft) this.tabs.scrollLeft = l - 8;
      else if (r > this.tabs.scrollLeft + this.tabs.clientWidth) this.tabs.scrollLeft = r - this.tabs.clientWidth + 8;
    }
  }

  private tab(t: TermInfo): HTMLElement {
    const on = t.id === this.activeId;
    const ended = t.exit !== null;
    const title = tabTitle(t, this.hooks.platform);
    const x = h('button', { class: 'ph-term-tab-x', type: 'button', 'aria-label': ended ? `Remove ${title}` : `End ${title}` }, [ico('x')]);
    const el = h('div', { class: `ph-term-tab${on ? ' on' : ''}${ended ? ' ended' : ''}`, role: 'tab', 'aria-selected': String(on), tabindex: '0', title: ended ? `${title} (ended)` : title }, [
      h('i', { class: 'ph-term-dot', 'aria-hidden': 'true' }),
      t.claude ? ico('claude', 'ph-ico ph-term-tab-claude') : null,
      h('span', { class: 'ph-term-tab-title', text: title }),
      x,
    ]);
    el.addEventListener('click', () => this.choose(t.id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.choose(t.id);
      }
    });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.end(t);
    });
    return el;
  }

  private renderBanner(): void {
    const s = this.state;
    const pc = this.hooks.pc;
    let text = '';
    let busy = false;
    let again: HTMLElement | null = null;
    switch (s.s) {
      case 'online':
        if (this.lost && this.activeId) {
          text = 'Lost the terminal.';
          const id = this.activeId;
          again = button('Try again', { icon: 'refresh', style: 'ghost', onclick: () => this.attach(id) });
        }
        break;
      case 'idle':
      case 'connecting':
        text = `Connecting to ${pc}…`;
        busy = true;
        break;
      case 'offline':
        text = `${pc} is offline. Trying again…`;
        busy = true;
        break;
      default:
        text = 'Not connected';
    }
    this.banner.replaceChildren(...[busy ? spinner() : null, text ? h('span', { text }) : null, again].filter((x): x is HTMLElement => x !== null));
    this.banner.classList.toggle('on', text !== '');
  }

  private renderPanel(): void {
    const pc = this.hooks.pc;
    const online = this.state.s === 'online';
    let body: Array<HTMLElement | null> | null = null;
    if (this.allowed === false) {
      body = [
        ico('terminal', 'ph-term-msg-icon'),
        h('div', { class: 'ph-term-msg-title', text: 'The terminal is off' }),
        h('p', { class: 'ph-text', text: `Turn it on at ${pc}: Island › Settings › Your phone › Terminal from your phone.` }),
        h('p', { class: 'ph-small', text: 'It stays off for phones while Windows Hello is asked before Allow. No such switch? Update Island on the PC.' }),
      ];
    } else if (online && (this.allowed === null || (this.items === null && !this.activeId && !this.opening))) {
      body = [h('div', { class: 'ph-pairing' }, [spinner(), h('span', { text: `Asking ${pc}…` })])];
    } else if (this.items !== null && !this.activeId && !this.opening) {
      const none = this.items.length === 0;
      body = [
        ico('terminal', 'ph-term-msg-icon'),
        h('div', { class: 'ph-term-msg-title', text: none ? `No terminals on ${pc}` : 'Pick a terminal above' }),
        h('p', { class: 'ph-text', text: none ? 'Open one to run commands there. It keeps running when you leave.' : 'Or open a new one.' }),
        this.error ? h('p', { class: 'ph-error', text: this.error }) : null,
        online ? button('New terminal', { icon: 'plus', style: 'primary', onclick: () => this.openNew() }) : null,
      ];
    }
    const kids = (body ?? []).filter((x): x is HTMLElement => x !== null);
    this.panel.replaceChildren(...(kids.length ? [h('div', { class: 'ph-term-msg' }, kids)] : []));
    this.panel.classList.toggle('on', kids.length > 0);
  }
}
