// The phone site's one controller: which screen shows (Add to Home Screen, pairing, the island,
// the terminal over it), what the link says (online, offline, denied, removed), what the island
// sends (hello, pill, view, toasts, clipboard, text, files, terminals), and where a tap goes
// (routing.ts, nav.ts).

import type { IslandMsg, Nav, PairPayload, TermInfo } from '../../../src/remote/protocol';
import { NavKeeper, navMsg } from './nav';
import { deniedText, pairErrorText, phoneName } from './pairing';
import { pushFlag, pushOff, pushOn, pushResend, pushState } from './push';
import { actMsg, routeAction } from './routing';
import type { IslandStore } from './store';
import type { IncomingFile, Link, LinkState, SavedIsland } from './link/api';
import { ClipSheet } from './screens/clipboard';
import { inboxFile, inboxText } from './screens/inbox';
import { installScreen, platformOf } from './screens/install';
import { IslandScreen } from './screens/island';
import { openMenu } from './screens/menu';
import { PairScreen } from './screens/pair';
import { openScreen } from './screens/pc-screen';
import { openSend } from './screens/send';
// Only its type here: xterm.js loads with the terminal, the first time it opens.
import type { TerminalScreen } from './screens/terminal';
import { CARD_MARGIN } from './island-view';
import { closeSheet, confirmSheet, toast } from './ui';

type Hello = Extract<IslandMsg, { t: 'hello' }>;

export interface AppOptions {
  demo: boolean;
  /** Shown once at start (the demo standing in for a missing link). */
  notice: string | null;
  /** Start on Add to Home Screen. */
  install: boolean;
  /** A pairing code from the page's address, to confirm. */
  pending: PairPayload | null;
  /** The address had a code, but a damaged one. */
  pendingBroken: boolean;
  /** `?open=<activity>` (a tapped notification): that card once online. */
  open: string | null;
  version: string;
}

/** Every this often while online, the island's "last seen" moves on. */
const SEEN_EVERY_MS = 30_000;
/** Under an urgent card when the PC strips Allow from phones (Windows Hello before Allow). */
const ALLOW_NOTE = 'Allow is only on your PC: Windows Hello asks there first.';

export class App {
  private screen: { destroy(): void } | null = null;
  private islandScreen: IslandScreen | null = null;
  private island: SavedIsland | null = null;
  private state: LinkState;
  private hello: Hello | null = null;
  /** The newest pill and view, kept for a screen mounted after they came (right after pairing). */
  private lastPill: Extract<IslandMsg, { t: 'pill' }> | null = null;
  private lastView: Extract<IslandMsg, { t: 'view' }> | null = null;
  private readonly nav = new NavKeeper();
  private pairing = false;
  private clip: ClipSheet | null = null;
  private seenTimer: ReturnType<typeof setInterval> | undefined;
  private width = 0;
  private openId: string | null;
  /** The terminal screen, over the island while it shows. */
  private termScreen: TerminalScreen | null = null;
  private termLoading = false;
  /** The PC's newest list of terminals, kept for the terminal screen's next opening. */
  private terms: { items: TermInfo[]; allowed: boolean } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly link: Link,
    private readonly store: IslandStore,
    private readonly opts: AppOptions,
  ) {
    this.state = link.state;
    this.openId = opts.open;
    link.onState((s) => this.onState(s));
    link.onMessage((m) => this.onMessage(m));
    link.onFile((f) => this.onFile(f));
    window.addEventListener('resize', () => this.resized());
    // A tapped notification while the app was open already (sw.js posts it).
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const open = (e.data as { open?: unknown } | null)?.open;
      if (typeof open === 'string' && open) this.openCard(open);
    });
  }

  start(): void {
    if (this.opts.notice) toast(this.opts.notice, 'info', 7000);
    if (this.opts.install) this.showInstall();
    else this.route();
  }

  private mount(s: { destroy(): void } | null): void {
    closeSheet();
    this.closeTerminal();
    this.screen?.destroy();
    this.screen = s;
    this.islandScreen = s instanceof IslandScreen ? s : null;
  }

  private route(reason?: string): void {
    if (this.opts.pending || this.opts.pendingBroken) {
      const pending = this.opts.pending;
      const broken = this.opts.pendingBroken;
      this.opts.pending = null;
      this.opts.pendingBroken = false;
      this.showPair(broken ? 'That pairing link was cut short or damaged. Scan the code again, or copy its link once more.' : null, pending);
      return;
    }
    const cur = this.store.current();
    if (cur) this.showIsland(cur, false);
    else this.showPair(reason ?? null, null);
  }

  // ---------------------------------------------------------------- screens

  private showInstall(): void {
    const el = installScreen(this.root, {
      platform: platformOf(navigator.userAgent, navigator.maxTouchPoints ?? 0),
      fromCode: this.opts.pending?.name ?? null,
      onContinue: () => {
        try {
          sessionStorage.setItem('island:phone:in-browser', '1');
        } catch {
          /* fine: it asks again next time */
        }
        this.route();
      },
    });
    this.mount({ destroy: () => el.remove() });
  }

  private showPair(reason: string | null, pending: PairPayload | null): void {
    this.island = null;
    this.hello = null;
    const s = new PairScreen(
      this.root,
      {
        saved: this.store.list(),
        demo: this.opts.demo,
        open: (id) => {
          this.store.use(id);
          const it = this.store.get(id);
          if (it) this.showIsland(it, false);
        },
        pair: (p) => this.pair(p),
      },
      { pending, reason },
    );
    this.mount(s);
  }

  private async pair(p: PairPayload): Promise<void> {
    this.pairing = true;
    try {
      const saved = await this.link.pair(p, phoneName(navigator.userAgent, navigator.maxTouchPoints ?? 0));
      this.store.add({ ...saved, lastSeen: saved.lastSeen ?? Date.now() });
      // Ask iOS to keep this app's storage (the pairing) even when space runs low.
      void navigator.storage?.persist?.().catch(() => undefined);
      toast(`Paired with ${saved.name}`, 'good');
      this.pairing = false;
      // The link stays connected after pairing: no second dial.
      this.showIsland(this.store.get(saved.id) ?? saved, true);
    } catch (err) {
      this.pairing = false;
      throw new Error(pairErrorText(err, p.name || 'your PC'));
    }
  }

  private showIsland(island: SavedIsland, connected: boolean): void {
    this.island = island;
    if (!connected) {
      this.hello = null;
      this.lastPill = null;
      this.lastView = null;
      this.terms = null;
    }
    this.clip = null;
    const s = new IslandScreen(this.root, {
      action: (a, arg) => this.action(a, arg),
      back: () => this.go(this.nav.back(Date.now())),
      claude: () => this.claude(),
      terminal: () => void this.openTerminal(),
      screen: () => openScreen(this.hello?.screen ?? null, this.island?.name ?? 'your PC'),
      send: () => this.island && openSend(this.link, this.island.name),
      menu: () => this.menu(),
      retry: () => this.island && this.link.open(this.island),
    });
    s.setName(this.hello?.name || island.name);
    this.mount(s);
    this.state = this.link.state;
    s.setLink(this.state, island.lastSeen);
    if (this.hello) s.setNote(this.hello.allow ? '' : ALLOW_NOTE);
    if (this.lastPill) s.pill(this.lastPill);
    if (this.lastView) s.draw(this.lastView, this.lastView.nav.open === 'card');
    if (!connected) this.link.open(island);
    else if (this.state.s === 'online') this.went('online');
  }

  // ---------------------------------------------------------------- the link

  private onState(s: LinkState): void {
    const was = this.state;
    this.state = s;
    if (this.pairing || !this.island) return;
    const id = this.island.id;
    if (s.s === 'online' && was.s !== 'online') this.went('online');
    if (s.s !== 'online' && was.s === 'online') this.went('offline');
    if (s.s === 'removed' || (s.s === 'denied' && s.why === 'unknown')) {
      const name = this.island.name;
      const why = s.s === 'removed' ? `${name} removed this phone. To use it here again, pair it again.` : deniedText('unknown', name);
      this.store.forget(id);
      this.link.close();
      if (this.store.current()) toast(why, 'info', 7000);
      this.route(why);
      return;
    }
    this.islandScreen?.setLink(s, this.store.get(id)?.lastSeen ?? this.island.lastSeen);
    this.termScreen?.setLink(s);
  }

  private went(to: 'online' | 'offline'): void {
    const island = this.island;
    if (!island) return;
    this.store.seen(island.id, Date.now());
    clearInterval(this.seenTimer);
    if (to === 'online') {
      this.seenTimer = setInterval(() => this.island && this.store.seen(this.island.id, Date.now()), SEEN_EVERY_MS);
      // A fresh session: the island draws nothing for this phone until it says what it shows.
      this.sendNav(this.nav.resend(Date.now()));
    }
  }

  private onMessage(m: IslandMsg): void {
    const s = this.islandScreen;
    switch (m.t) {
      case 'hello':
        this.hello = m;
        if (this.island && m.name && m.name !== this.island.name) {
          this.store.rename(this.island.id, m.name);
          this.island = { ...this.island, name: m.name };
          s?.setName(m.name);
        }
        s?.setNote(m.allow ? '' : ALLOW_NOTE);
        this.termScreen?.setHello(m.term === true, m.folders ?? []);
        this.sendNav(this.nav.resend(Date.now()));
        if (this.openId) this.openCard(this.openId);
        void this.resendPush();
        return;
      case 'terms':
        this.terms = { items: m.items, allowed: m.allowed };
        this.termScreen?.setTerms(m.items, m.allowed);
        return;
      case 'pill':
        this.lastPill = m;
        s?.pill(m);
        return;
      case 'view':
        // An urgent card shows whatever the phone asked for; anything else must answer the latest ask.
        if (!m.urgent && !this.nav.accept(m.nav, Date.now())) return;
        this.lastView = m;
        s?.draw(m, m.nav.open === 'card');
        return;
      case 'toast':
        toast(m.text, m.tone);
        return;
      case 'clip':
        if (this.clip?.alive) this.clip.show(m.text);
        return;
      case 'text':
        if (s) inboxText(s.inbox, m.text, m.from);
        return;
      default:
        // paired, denied, pong, bye: the link's own business.
        return;
    }
  }

  private onFile(f: IncomingFile): void {
    const s = this.islandScreen;
    if (s) inboxFile(s.inbox, f, this.island?.name ?? 'your PC');
  }

  // ---------------------------------------------------------------- taps and navigation

  private action(action: string, arg: unknown): void {
    const now = Date.now();
    const r = routeAction(action, arg);
    switch (r.to) {
      case 'island':
        if (!this.link.send(actMsg(action, arg))) toast('Not connected', 'bad');
        return;
      case 'toggle':
        this.go(this.nav.toggle(now));
        return;
      case 'grid':
        this.go(this.nav.go({ open: 'grid' }, now));
        return;
      case 'card':
        this.go(this.nav.go({ open: 'card', id: r.id }, now));
        return;
      case 'pc-only':
        toast('That one works on your PC only', 'info');
        return;
      case 'none':
        return;
    }
  }

  /** Asks the island for `nav`; nothing under the pill shows at once. */
  private go(nav: Nav): void {
    if (nav.open === 'none') this.islandScreen?.clear();
    this.sendNav(nav);
  }

  private sendNav(nav: Nav): void {
    this.width = this.cardWidth();
    this.link.send(navMsg(nav, this.width));
  }

  private openCard(id: string): void {
    if (this.state.s !== 'online' || !this.hello) {
      this.openId = id;
      return;
    }
    this.openId = null;
    if (new URLSearchParams(location.search).has('open')) {
      const url = new URL(location.href);
      url.searchParams.delete('open');
      history.replaceState(null, '', url);
    }
    // A tapped notification shows its card, also from the terminal.
    this.closeTerminal();
    this.go(this.nav.go({ open: 'card', id }, Date.now()));
  }

  /** The card's width on this screen, CSS px (the island packs the grid for it). */
  private cardWidth(): number {
    return Math.round(Math.max(200, document.documentElement.clientWidth - CARD_MARGIN * 2));
  }

  private resized(): void {
    if (this.state.s !== 'online' || !this.island) return;
    if (Math.abs(this.cardWidth() - this.width) >= 8) this.sendNav(this.nav.want);
  }

  // ---------------------------------------------------------------- the bar

  /** Claude's card: the island draws it (its chats, a box to message one), like any card. */
  private claude(): void {
    if (this.state.s !== 'online') {
      toast('Not connected', 'bad');
      return;
    }
    this.go(this.nav.go({ open: 'card', id: 'claude' }, Date.now()));
  }

  private async openTerminal(): Promise<void> {
    if (this.termScreen || this.termLoading || !this.island) return;
    this.termLoading = true;
    let mod: typeof import('./screens/terminal');
    try {
      mod = await import('./screens/terminal');
    } catch (err) {
      console.error('the terminal failed to load', err);
      toast("Couldn't load the terminal. Close Island and open it again.", 'bad', 5000);
      return;
    } finally {
      this.termLoading = false;
    }
    const island = this.island;
    // Gone to another screen (or PC) while it loaded.
    if (!island || !this.islandScreen || this.termScreen) return;
    closeSheet();
    this.termScreen = new mod.TerminalScreen(
      this.root,
      { link: this.link, pc: this.hello?.name || island.name, islandId: island.id, platform: this.hello?.platform ?? 'windows', back: () => this.closeTerminal() },
      { state: this.state, allowed: this.hello ? this.hello.term === true : null, folders: this.hello?.folders ?? [], terms: this.terms },
    );
  }

  private closeTerminal(): void {
    this.termScreen?.destroy();
    this.termScreen = null;
  }

  private async lock(): Promise<void> {
    const name = this.island?.name ?? 'your PC';
    const yes = await confirmSheet({ title: `Lock ${name}?`, text: 'It locks right away; getting back in takes your password, PIN or Windows Hello.', ok: 'Lock', icon: 'lock' });
    if (yes && !this.link.send({ t: 'lock' })) toast('Not connected', 'bad');
  }

  private menu(): void {
    const island = this.island;
    if (!island) return;
    openMenu({
      islands: this.store.list(),
      current: this.store.get(island.id) ?? island,
      state: this.state,
      version: this.hello?.version ?? this.opts.version,
      demo: this.opts.demo,
      clipboard: () => {
        if (this.island) this.clip = new ClipSheet(this.link, this.island.name);
      },
      lock: () => void this.lock(),
      switchTo: (id) => {
        const it = this.store.get(id);
        if (!it) return;
        this.store.use(id);
        this.showIsland(it, false);
      },
      pairAnother: () => {
        this.link.close();
        this.showPair(null, null);
      },
      remove: () => void this.remove(island),
      push: {
        state: () => pushState(island.id, this.hello?.vapid ?? null),
        set: async (on) => {
          if (on) {
            const vapid = this.hello?.vapid;
            if (!vapid) throw new Error('Update Island on your PC first.');
            const sub = await pushOn(island.id, vapid);
            if (!this.link.send({ t: 'push-sub', sub })) throw new Error('Not connected: try again once the PC is online.');
            toast('Notifications on', 'good');
          } else {
            await pushOff(island.id, this.store.list().some((x) => x.id !== island.id && pushFlag(x.id)));
            this.link.send({ t: 'push-sub', sub: null });
            toast('Notifications off', 'info');
          }
        },
      },
    });
  }

  private async remove(island: SavedIsland): Promise<void> {
    const yes = await confirmSheet({
      title: `Remove ${island.name}?`,
      text: `This phone forgets ${island.name}. To also take this phone off the PC's list: Island on the PC, Settings › Your phone.`,
      ok: 'Remove',
      icon: 'x',
      danger: true,
    });
    if (!yes) return;
    if (pushFlag(island.id)) {
      this.link.send({ t: 'push-sub', sub: null });
      await pushOff(island.id, this.store.list().some((x) => x.id !== island.id && pushFlag(x.id))).catch(() => undefined);
    }
    this.link.close();
    const next = this.store.forget(island.id);
    toast(`Removed ${island.name}`, 'info');
    if (next) this.showIsland(next, false);
    else this.showPair(null, null);
  }

  private async resendPush(): Promise<void> {
    const island = this.island;
    if (!island) return;
    try {
      const sub = await pushResend(island.id);
      if (sub) this.link.send({ t: 'push-sub', sub });
    } catch {
      /* no service worker here (dev): nothing to resend */
    }
  }
}
