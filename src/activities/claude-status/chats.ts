// Conversations in the Claude desktop app and Chrome, from what UI Automation
// shows each second (claude_status.rs: open chats and the app sidebar's status
// labels). Ported from the Claude Sessions widget's ui_watcher.ps1: a chat is
// listed once it runs, keeps its row across renames, and when it leaves the
// screen it is either finished (the app's sidebar would still say otherwise)
// or frozen as hidden. Seconds, like the widget.

import type { UiChat, UiScan } from '../../core/native';
import type { Prog } from './work';

export type ChatState = UiChat['state'];

export interface ChatRecord {
  id: string;
  source: 'app' | 'chrome';
  /** The chat's title. */
  title: string;
  state: ChatState;
  since: number;
  updated: number;
  visible: boolean;
  hwnd: number;
  ord: number;
  unread: boolean;
  chatId: string;
  prog: Prog | null;
  /** When it left the screen. */
  gone: number | null;
}

/** New chats start with a temporary title that Claude replaces a few seconds later. */
function provisional(t: string): boolean {
  return t.endsWith('…') || ['New chat', 'Untitled', 'New session', 'New conversation'].includes(t);
}

/**
 * Claude often refines a title ("Source files access" -> "Project source files access"),
 * and Claude in Chrome starts from the prompt and trims it ("go to API key" -> "API key").
 */
export function renameLike(old: string, title: string): boolean {
  if (provisional(old)) return true;
  const words = (s: string) => s.toLowerCase().split(/\W+/).filter(Boolean);
  const within = (a: string[], b: string[]) => a.length > 0 && a.every((w) => b.includes(w));
  const ow = words(old);
  const nw = words(title);
  return within(ow, nw) || within(nw, ow);
}

/** A stable id per conversation: app chats by title and row, Chrome ones by window and title. */
export function chatKey(c: Pick<UiChat, 'source' | 'title' | 'ord' | 'hwnd'>): string {
  const text = c.source === 'app' ? `app|${c.title}|${c.ord}` : `chrome|${c.hwnd}|${c.title}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ch, 2246822519) >>> 0;
  }
  return `ui-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0').slice(0, 4)}`;
}

/** Forget a row this long after it left the screen. */
const FORGET_AFTER = 3600;

export class ChatWatcher {
  readonly known = new Map<string, ChatRecord>();
  /** Timing of the app's "Step X of Y" for agentic runs. */
  private steps = new Map<string, { steps: number; step: number; base: number; start: number; last: number }>();
  /** Ids that have run at least once while watched. */
  private activated = new Set<string>();
  /** Chat titles seen running since the watcher started. */
  private ranTitles = new Set<string>();
  /** "source|hwnd" -> id of the chat open in that window last pass. */
  private lastOpen = new Map<string, string>();

  /** `addRun` gets how long a chat ran (seconds) when it finishes. */
  constructor(private readonly addRun: (seconds: number) => void = () => {}) {}

  private move(from: string, to: string): void {
    if (!this.known.has(to)) {
      this.known.set(to, { ...this.known.get(from)!, id: to });
      if (this.activated.has(from)) this.activated.add(to);
      const si = this.steps.get(from);
      if (si) this.steps.set(to, si);
    }
    this.known.delete(from);
    this.activated.delete(from);
    this.steps.delete(from);
  }

  update(scan: UiScan, now: number): ChatRecord[] {
    const obs = scan.chats;
    // The open conversation beats its own sidebar row (it knows about errors);
    // sidebar rows for Claude in Chrome tasks are already covered by Chrome.
    const openApp = new Set(obs.filter((o) => o.source === 'app' && o.open).map((o) => o.title));
    const chromeTitles = new Set(obs.filter((o) => o.source === 'chrome').map((o) => o.title));
    const obsIds = new Set(obs.map(chatKey));
    const seen = new Set<string>();

    for (const o of obs) {
      if (o.source === 'app' && chromeTitles.has(o.title)) continue;
      if (!o.open && openApp.has(o.title)) continue;
      const id = chatKey(o);
      if (seen.has(id)) continue;
      const wkey = `${o.source}|${o.hwnd}`;
      // Same chat id under another title: a rename, whatever the new title is.
      if (o.open && o.chat) {
        for (const [k, r] of [...this.known]) if (k !== id && r.chatId === o.chat) this.move(k, id);
      }
      // Renamed while open (temporary or refined title): carry its row over.
      if (o.open && !this.known.has(id)) {
        const oldId = this.lastOpen.get(wkey);
        const old = oldId ? this.known.get(oldId) : undefined;
        if (oldId && oldId !== id && old && !obsIds.has(oldId) && renameLike(old.title, o.title)) this.move(oldId, id);
      }
      if (o.open) this.lastOpen.set(wkey, id);
      // Listed once it runs (a prompt was sent) or waits on you mid-run. Opening a
      // chat, or an old "Unread response", doesn't count on its own.
      if (o.state === 'running') this.ranTitles.add(o.title);
      if (!this.activated.has(id)) {
        if (!(o.state === 'running' || (o.state === 'input' && this.ranTitles.has(o.title)))) continue;
        this.activated.add(id);
      }
      seen.add(id);
      const prev = this.known.get(id);
      const since = prev && prev.state === o.state ? prev.since : now;
      if (prev && prev.gone == null && prev.state === 'running' && (o.state === 'done' || o.state === 'failed')) this.addRun(now - prev.since);

      let prog: Prog | null = null;
      if (o.steps) {
        // Time each step change; it becomes a step-based estimate.
        let si = this.steps.get(id);
        if (!si || si.steps !== o.steps || (o.step ?? 0) < si.step) {
          si = { steps: o.steps, step: o.step ?? 1, base: (o.step ?? 1) - 1, start: now, last: now };
          this.steps.set(id, si);
        } else if ((o.step ?? 0) > si.step) {
          si.step = o.step!;
          si.last = now;
        }
      } else if (o.state !== 'running') {
        this.steps.delete(id);
      }
      const si = this.steps.get(id);
      if (si && o.state === 'running') prog = { total: si.steps, done: si.step - 1, baseDone: si.base, lastDoneAt: si.last, countStart: si.start };

      this.known.set(id, {
        id, source: o.source, title: o.title, state: o.state, since, updated: now, visible: true, hwnd: o.hwnd, ord: o.ord,
        unread: o.unread, chatId: o.chat || prev?.chatId || '', prog, gone: null,
      });
    }

    // Gone from view. Desktop-app chats: with the sidebar open it would still label
    // them if they were running or waiting, so they're finished; with it collapsed
    // we can't tell, so they're hidden. Chrome: running/waiting ones are hidden
    // until they reappear. Rows gone for an hour are forgotten.
    for (const [id, r] of [...this.known]) {
      if (seen.has(id)) continue;
      if (r.gone != null) {
        if (now - r.gone > FORGET_AFTER) {
          this.known.delete(id);
          this.activated.delete(id);
          this.steps.delete(id);
        }
        continue;
      }
      r.gone = now;
      r.unread = false;
      r.prog = null;
      if (r.source === 'app' && (r.state === 'running' || r.state === 'input') && scan.sidebarOpen) {
        if (r.state === 'running') this.addRun(now - r.since);
        r.state = 'done';
        r.since = now;
      } else if (r.state === 'running' || r.state === 'input') {
        r.visible = false;
      }
      r.updated = now;
    }
    return [...this.known.values()];
  }
}
