// The Island engine. It decides what should happen (which activity, which
// level, which view), asks the layout engine where things go, and hands the
// result to the renderer, whose springs decide how it gets there.
//
//   activities ─► priority ─► level ─► segments ─► fit ─► shell rect ─► renderer
//                                   └─► sheet (the card under the pill)

import { CATALOG_BY_ID } from '../activities/catalog';
import type { Activity, ActivityContext, ActivityStatus, RenderEnv, SheetEnv, SurfaceOptions } from './activity';
import { setReducedMotion } from './animator';
import { BorderGlow, type GlowSpec } from './glow';
import { dropBefore, hiddenTest, leadFirst, moveBefore, packGrid, pageCount, rowsUsed, sizeOf, unhide, type GridSlot } from './grid';
import { innerPadding, LEVELS, orientationFor, pillRect, pillSize, tuckedRect, union, type Anchor, type Area, type Level, type Orientation, type Rect } from './layout';
import { native, on, sendTo, type MenuItem } from './native';
import { choosePrimary, type Candidate, type Choice as Picked, type Surface } from './priority';
import type { MirrorFrame } from './mirror';
import { PillRenderer } from './renderer';
import { fitSegments, fitVertical, signature, type Placed, type Seg } from './segments';
import { ACCENTS, migrate, TILE_SIZES, type Settings, type TileSize } from './settings';
import { mapActions, SheetRenderer, type SheetView, type Tile } from './sheet';
import { springs } from './spring';
import { clip, timeOfDay } from './format';

type View = 'main' | 'overflow' | 'menu';

const levelIdx = (l: Level) => LEVELS.indexOf(l);
/** Tile kinds that read well in a single column. */
const NARROW_OK = new Set(['stat', 'actions', 'dots']);
/** Cell size in px for each island size, so a small island gets a small grid. */
/** Row height per island size (the width comes from the pill). */
const CELL_PX = { small: 80, medium: 92, large: 106 } as const;
const SIZE_SCALE = { small: 0.88, medium: 1, large: 1.14 } as const;
const GRID_GAP = 8;
const GRID_PAD = 14;
const ROWS_PER_PAGE = 4;
const atLeast = (a: Level, b: Level): Level => (levelIdx(a) >= levelIdx(b) ? a : b);

export class Island {
  settings!: Settings;
  private area: Area = { width: 1280, height: 720 };
  private monitorId: string | null = null;
  private readonly renderer: PillRenderer;
  private readonly running = new Map<string, Activity>();
  private readonly contexts = new Map<string, ActivityContext>();
  private surfaces: Surface[] = [];
  private view: View = 'main';
  private open = false;
  private hover = false;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private selected: string | null = null;
  private lastPrimary: string | null | undefined = undefined;
  private lastViewKey = '';
  private lastSig = '';
  private lastAnchor: Anchor | null = null;
  private lastOrientation: Orientation | null = null;
  private scheduled = false;
  private fullscreenOn: string | null = null;
  private inputActive = false;
  /** The pill itself shows an input (Continue Session, Ask). */
  private pillInput = false;
  private previewLevel: Level | null = null;
  private moving = false;
  private pendingBump = false;
  private hotkeyFailures: string[] = [];
  private appSubscribedUntil = 0;
  private lastTraySig = '';
  private lastHitAt = 0;
  private cursorMonitorCandidate: string | null = null;
  private visibleIds: string[] = [];
  private primaryId: string | null = null;
  /** `${activity}:${urgent key}` the user tapped away; they stop forcing the pill open. */
  private readonly dismissedUrgent = new Set<string>();
  private readonly sheet: SheetRenderer;
  /** Who owns the card under the pill right now ('island' for the grid). */
  private sheetOwner: string | null = null;
  /** The user clicked into an input on the card: the island holds the keyboard. */
  private sheetEngaged = false;
  /** The grid is in edit mode (a tile was long-pressed). */
  private gridEditing = false;
  /** The packing of the last grid drawn, and the order it came from (for drops). */
  private gridSlots: GridSlot[] = [];
  private gridOrder: string[] = [];
  /** A drag changed the order; saved when the tile is dropped. */
  private gridDirty = false;
  /** Segment key under the pointer: tells whose card a hover asks for. */
  private hoverKey: string | null = null;
  /** Light on the pill's edge and on an urgent card's, in the tone of whatever is happening. */
  private readonly pillGlow: BorderGlow;
  private readonly cardGlow: BorderGlow;
  /** Duplicate mode: how many copies of the pill run on other screens, and the last frame sent to them. */
  private mirrorCount = 0;
  private mirrorKey = '';
  private mirrorFrame: MirrorFrame | null = null;
  /** Monitor with a full-screen app in front (any monitor, for the copies). */
  private fullscreenAny: string | null = null;

  constructor(
    stage: HTMLElement,
    private readonly factories: Map<string, () => Activity>,
  ) {
    this.renderer = new PillRenderer(stage, (action, arg, el) => this.handleAction(action, arg, el));
    this.sheet = new SheetRenderer(
      stage,
      (action, arg, el) => this.handleAction(action, arg, el),
      () => {
        const card = this.sheet?.rect;
        if (card) this.cardGlow?.place(card);
        this.publishHit(this.renderer.rect, false);
      },
    );
    // The light is drawn above the pill and the card, not inside them, so it can spill over their edges.
    this.pillGlow = new BorderGlow(stage);
    this.cardGlow = new BorderGlow(stage, 24);
    this.renderer.onFrame((r) => {
      this.sheet.follow(r);
      this.pillGlow.place(r);
      this.publishHit(r, false);
    });
  }

  // ---------------------------------------------------------------- boot

  async boot(): Promise<void> {
    this.settings = migrate(await native.settingsGet());
    this.applyLook();
    await this.place(true);
    this.syncActivities();

    await on<{ value: unknown; origin: string }>('settings', ({ value, origin }) => {
      if (origin === 'island') return;
      this.applySettings(migrate(value));
    });
    await on<{ monitor: string; fullscreen: string | null; pid: number }>('foreground', (fg) => this.onForeground(fg));
    await on('pointer-outside', () => this.dismiss());
    await on<boolean>('peek', (on) => this.onPeek(on));
    await on('displays-changed', () => void this.place(false));
    await on('mirror-ready', () => {
      if (this.mirrorFrame) void native.broadcast('mirror-frame', { ...this.mirrorFrame, bump: false });
    });
    await on<{ id: string }>('hotkey', ({ id }) => this.onHotkey(id));
    await on<{ id: string }>('tray-menu', ({ id }) => this.onTrayMenu(id));
    await on<{ id: string; target: string; cmd: string; arg: unknown }>('app-command', (req) => void this.onAppCommand(req));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.dismiss();
    });
    // Rust reports presses outside the window's hit area; this catches the rest
    // (the thin margin around the pill, and everything in the browser preview).
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element | null)?.closest?.('.pill, .sheet')) this.dismiss();
    });
    window.addEventListener('resize', () => {
      if (native.demo) void this.place(false);
    });

    setInterval(() => this.tick(), 1000);
    setInterval(() => this.followCursor(), 1500);
    await this.updateHotkeys();
    void native.setPeek(this.settings.island.peekThrough);
    void native.setAutoUpdate(this.settings.general.autoUpdate);
    this.compose(true);
    await native.show(true);
    native.log(`island ready on ${this.monitorId ?? 'unknown monitor'} ${Math.round(this.area.width)}x${Math.round(this.area.height)}`);
    // First run: the welcome screen asks two questions and sets the Control Center up.
    if (!this.settings.general.onboarded && !native.demo) void native.openApp('welcome');
  }

  private applyLook(): void {
    const s = this.settings.island;
    setReducedMotion(s.reduceMotion === 'on' || (s.reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches));
    document.documentElement.style.setProperty('--accent', ACCENTS[s.accent] ?? s.accent ?? ACCENTS.ember);
  }

  private applySettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    this.applyLook();
    if (prev.island.display !== next.island.display || prev.island.displayId !== next.island.displayId || prev.island.displayIds.join() !== next.island.displayIds.join()) void this.place(false);
    this.syncActivities(prev);
    void this.updateHotkeys();
    if (prev.island.peekThrough !== next.island.peekThrough) void native.setPeek(next.island.peekThrough);
    if (prev.general.autoUpdate !== next.general.autoUpdate) void native.setAutoUpdate(next.general.autoUpdate);
    this.schedule();
  }

  /** Writes settings changed from the island itself (anchor, do not disturb). */
  private saveSettings(): void {
    void native.settingsSet(this.settings, 'island');
  }

  // ---------------------------------------------------------------- monitors

  private pickMonitor(): string | null {
    const s = this.settings.island;
    if (s.display === 'specific' && s.displayId) return s.displayId;
    if ((s.display === 'active' || s.display === 'cursor') && this.monitorId) return this.monitorId;
    return null; // primary
  }

  private async place(first: boolean, monitor?: string | null): Promise<void> {
    let want = monitor !== undefined ? monitor : this.pickMonitor();
    const s = this.settings.island;
    if (monitor === undefined && s.display === 'duplicate') {
      // The island itself lives on the primary screen if it was picked, else the first one picked.
      const chosen = (await native.monitors()).filter((m) => s.displayIds.includes(m.id));
      want = (chosen.find((m) => m.primary) ?? chosen[0])?.id ?? null;
    }
    if (first && (this.settings.island.display === 'cursor' || this.settings.island.display === 'active')) {
      const m = await native.monitorAtCursor();
      if (m) return this.place(false, m.id);
    }
    const p = await native.place(want);
    if (!p) return;
    this.monitorId = p.monitor.id;
    this.area = { width: p.width, height: p.height };
    document.documentElement.style.setProperty('--stage-w', `${p.width}px`);
    document.documentElement.style.setProperty('--stage-h', `${p.height}px`);
    this.schedule();
    void this.syncMirrors();
  }

  /** Duplicate mode: a copy of the pill on every other chosen screen; otherwise none. */
  private async syncMirrors(): Promise<void> {
    const s = this.settings.island;
    let ids: string[] = [];
    if (s.display === 'duplicate' && !native.demo) {
      ids = (await native.monitors()).filter((m) => s.displayIds.includes(m.id) && m.id !== this.monitorId).map((m) => m.id);
    }
    if (!ids.length && !this.mirrorCount) return;
    this.mirrorCount = ids.length;
    this.mirrorKey = '';
    await native.mirrors(ids);
    this.schedule();
  }

  private sendMirror(frame: MirrorFrame): void {
    if (!this.mirrorCount) return;
    const key = `${frame.sig}|${frame.hidden}|${frame.fsHide}|${frame.fullscreen}|${JSON.stringify(frame.glow)}|${frame.speed}|${frame.anchor}|${frame.edge}|${frame.accent}|${frame.reduce}`;
    if (key === this.mirrorKey && !frame.bump) return;
    this.mirrorKey = key;
    this.mirrorFrame = frame;
    void native.broadcast('mirror-frame', frame);
  }

  /** Slide into the edge, hop to the other display, slide back out. */
  private async moveTo(monitorId: string): Promise<void> {
    if (this.moving || monitorId === this.monitorId) return;
    this.moving = true;
    this.compose(false);
    await new Promise((r) => setTimeout(r, 260));
    await this.place(false, monitorId);
    const { w, h } = this.renderer.targetRect;
    this.renderer.setShell(tuckedRect(this.area, this.settings.island.anchor, w, h), { immediate: true });
    this.moving = false;
    this.compose(false);
  }

  private foregroundTimer: ReturnType<typeof setTimeout> | undefined;
  private onForeground(fg: { monitor: string; fullscreen: string | null }): void {
    if (fg.fullscreen !== this.fullscreenAny) {
      this.fullscreenAny = fg.fullscreen;
      if (this.mirrorCount) this.schedule();
    }
    const full = fg.fullscreen && fg.fullscreen === this.monitorId ? fg.fullscreen : null;
    if (full !== this.fullscreenOn) {
      this.fullscreenOn = full;
      this.schedule();
    }
    if (this.settings.island.display === 'active' && fg.monitor && fg.monitor !== this.monitorId) {
      clearTimeout(this.foregroundTimer);
      this.foregroundTimer = setTimeout(() => void this.moveTo(fg.monitor), 500);
    }
  }

  private async followCursor(): Promise<void> {
    if (this.settings?.island.display !== 'cursor' || native.demo) return;
    const m = await native.monitorAtCursor();
    if (!m || m.id === this.monitorId) {
      this.cursorMonitorCandidate = null;
      return;
    }
    // Two polls in a row on the other display: the user really moved there.
    if (this.cursorMonitorCandidate === m.id) {
      this.cursorMonitorCandidate = null;
      void this.moveTo(m.id);
    } else this.cursorMonitorCandidate = m.id;
  }

  // ---------------------------------------------------------------- activities

  private syncActivities(prev?: Settings): void {
    for (const id of this.settings.activities.order) {
      const cfg = this.settings.activities.config[id];
      const running = this.running.get(id);
      if (cfg?.enabled && !running) {
        const factory = this.factories.get(id);
        if (!factory) continue;
        const act = factory();
        this.running.set(id, act);
        const ctx = this.makeContext(id);
        this.contexts.set(id, ctx);
        Promise.resolve()
          .then(() => act.start(ctx))
          .catch((err) => native.log(`activity ${id} failed to start: ${String(err)}`));
      } else if (!cfg?.enabled && running) {
        try {
          running.stop();
        } catch (err) {
          console.error(err);
        }
        this.running.delete(id);
        this.contexts.delete(id);
        this.surfaces = this.surfaces.filter((s) => s.id !== id);
        if (this.selected === id) this.selected = null;
      } else if (running && prev && JSON.stringify(prev.activities.config[id]) !== JSON.stringify(cfg)) {
        running.reconfigure?.();
      }
    }
  }

  private makeContext(id: string): ActivityContext {
    return {
      id,
      config: () => this.settings.activities.config[id],
      options: <T extends Record<string, unknown>>() => (this.settings.activities.config[id]?.options ?? {}) as T,
      settings: () => this.settings,
      update: () => this.schedule(),
      surface: (opts?: SurfaceOptions) => this.surface(id, opts),
      alert: (kind = 'shake', tone = 'accent') => {
        if (kind === 'shake') this.renderer.shake();
        else this.renderer.glow(tone);
      },
      open: () => {
        this.open = true;
        this.view = 'main';
        this.selected = id;
        this.schedule();
      },
      close: () => {
        this.open = false;
        this.view = 'main';
        this.schedule();
      },
      isOpen: () => this.open,
      isPrimary: () => this.primaryId === id,
      notify: (title, body) => {
        if (this.settings.general.notifications && !this.settings.general.dnd) void native.notify(title, body);
      },
      log: (...parts) => void native.log(`${id}: ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`),
      setOptions: (patch) => {
        const cfg = this.settings.activities.config[id];
        if (!cfg) return;
        cfg.options = { ...cfg.options, ...patch };
        this.saveSettings();
        this.schedule();
      },
    };
  }

  private surface(id: string, opts: SurfaceOptions = {}): void {
    const cfg = this.settings.activities.config[id];
    if (!cfg?.enabled || !cfg.autoShow || this.settings.general.dnd) return;
    const now = Date.now();
    const key = opts.key ?? 'event';
    this.surfaces = this.surfaces.filter((s) => !(s.id === id && s.key === key) && s.until > now);
    this.surfaces.push({ id, key, until: now + (opts.ms ?? 3500), level: opts.level ?? 'expanded', at: now });
    if (opts.bump !== false) this.pendingBump = true;
    this.schedule();
    setTimeout(() => this.schedule(), (opts.ms ?? 3500) + 30);
  }

  // ---------------------------------------------------------------- compose

  /** Recompose on the next frame; a timer backs it up when frames are paused (hidden window). */
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      if (!this.scheduled) return;
      this.scheduled = false;
      this.compose(false);
    };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  private statuses(): Map<string, ActivityStatus> {
    const out = new Map<string, ActivityStatus>();
    for (const [id, act] of this.running) {
      try {
        out.set(id, act.status());
      } catch (err) {
        console.error(`status ${id}`, err);
        out.set(id, { active: false });
      }
    }
    return out;
  }

  private compose(immediate: boolean): void {
    if (!this.settings) return;
    const now = Date.now();
    const s = this.settings.island;
    const statuses = this.statuses();
    this.surfaces = this.surfaces.filter((x) => x.until > now && this.running.has(x.id));

    const order = this.settings.activities.order;
    const candidates: Candidate[] = [...this.running.keys()].map((id) => ({
      id,
      status: statuses.get(id) ?? { active: false },
      config: this.settings.activities.config[id],
      order: order.indexOf(id),
    }));
    if (this.selected && !statuses.get(this.selected)?.active) this.selected = null;
    const choice = choosePrimary(candidates, { selected: this.selected, surfaces: this.surfaces, now, dnd: this.settings.general.dnd });
    const primary = choice.primary;
    this.primaryId = primary;
    this.visibleIds = choice.visible;
    const pStatus = primary ? statuses.get(primary) : undefined;

    // Level: resting compact, raised by events, hover, the user, or urgency.
    let level: Level = primary ? 'compact' : 'idle';
    const surf = primary ? this.surfaces.filter((x) => x.id === primary).sort((a, b) => b.at - a.at)[0] : undefined;
    if (surf) level = atLeast(level, surf.level);
    if (this.hover && s.hoverExpand && primary && !this.open) level = atLeast(level, 'expanded');
    if (this.open || this.view !== 'main') level = 'maximum';
    // Urgency raises the pill until a tap outside dismisses it; a new urgent key raises it again.
    const urgentKeys = new Set<string>();
    for (const [id, st] of statuses) if (st.urgent) urgentKeys.add(`${id}:${st.urgent.key}`);
    for (const k of this.dismissedUrgent) if (!urgentKeys.has(k)) this.dismissedUrgent.delete(k);
    if (choice.urgent && pStatus?.urgent && !this.dismissedUrgent.has(`${primary}:${pStatus.urgent.key}`)) {
      level = atLeast(level, pStatus.urgent.level ?? 'maximum');
    }
    if (this.previewLevel) level = this.previewLevel;

    const urgentNow = choice.urgent;
    const fsHide = !urgentNow && s.hideInFullscreen && !pStatus?.overFullscreen;
    const hiddenEverywhere =
      this.moving ||
      (!primary && s.idle === 'hidden' && !this.open && !this.hover && this.view === 'main' && !this.previewLevel);
    const hidden = hiddenEverywhere || (fsHide && this.fullscreenOn !== null);

    const anchor = s.anchor;
    // Left/right pills stand vertical; an inline input needs a horizontal pill to type in.
    const build = (orient: Orientation) => {
      const size = pillSize(this.area, s.widths, level, s.edge, s.size, orient);
      const pad = innerPadding(size.cross);
      const inner = Math.max(40, size.main - pad * 2);
      const crossMax = orient === 'vertical' ? Math.max(16, size.cross - 14) : size.h;
      const vertical = orient === 'vertical';
      let segs: Seg[];
      let viewKey: string;
      if (this.view === 'menu') {
        segs = this.menuSegments();
        viewKey = 'menu';
      } else if (this.view === 'overflow') {
        segs = this.overflowSegments(choice.visible, statuses, vertical);
        viewKey = 'overflow';
      } else if (!primary) {
        segs = this.open ? this.homeSegments(now, statuses, vertical) : [];
        viewKey = this.open ? 'home' : 'idle';
      } else {
        const act = this.running.get(primary)!;
        const cfg = this.settings.activities.config[primary];
        const env: RenderEnv = {
          level,
          width: vertical ? crossMax : inner,
          height: size.cross,
          now,
          open: this.open,
          hover: this.hover,
          surfaced: choice.surfaced,
          interactive: cfg.interactive,
          vertical,
        };
        let own: Seg[] = [];
        try {
          own = act.render(env);
        } catch (err) {
          console.error(`render ${primary}`, err);
        }
        if (!cfg.interactive) own = own.filter((x) => x.t !== 'button' && x.t !== 'input' && !(x.t === 'chip' && x.action));
        segs = this.namespaced(primary, own);
        viewKey = `act:${primary}`;
        if (s.showSecondary && level !== 'idle') segs = segs.concat(this.secondarySegments(choice.visible.filter((id) => id !== primary), statuses, level, now, vertical));
      }
      return { size, inner, crossMax, segs, viewKey };
    };
    let orient: Orientation = orientationFor(anchor);
    let built = build(orient);
    if (orient === 'vertical' && built.segs.some((x) => x.t === 'input')) {
      orient = 'horizontal';
      built = build(orient);
    }
    const { size, inner, crossMax, viewKey } = built;
    let segs = built.segs;
    const { w, h } = size;
    const fit = (list: Seg[]): Placed[] => (orient === 'vertical' ? fitVertical(list, inner, crossMax) : fitSegments(list, inner, h));

    let placed: Placed[] = fit(segs);
    // Secondary chips that did not fit fold into a "+N" chip.
    const offered = segs.filter((x) => x.key.startsWith('chip/')).length;
    const shown = placed.filter((p) => p.seg.key.startsWith('chip/')).length;
    if (offered > shown && this.view === 'main' && level !== 'compact') {
      segs = segs.concat([{ t: 'chip', key: 'island/more', label: `+${offered - shown}`, icon: orient === 'vertical' ? undefined : 'more', action: 'island:overflow', side: 'end', prio: 1, tip: 'More activities' }]);
      placed = fit(segs);
    }

    const target = hidden ? tuckedRect(this.area, anchor, w, h) : pillRect(this.area, anchor, w, h, s.edge);
    const travelling = this.lastAnchor !== null && this.lastAnchor !== anchor;
    const reshaped = this.lastOrientation !== null && this.lastOrientation !== orient;
    this.renderer.setOrientation(orient);
    this.renderer.setAnchor(anchor);
    this.renderer.setShell(target, { config: travelling ? springs.travel : springs.shell, immediate });
    this.lastAnchor = anchor;
    this.lastOrientation = orient;

    const swap = primary !== this.lastPrimary || viewKey !== this.lastViewKey || reshaped;
    const sig = `${orient}|${viewKey}|${w}|${h}|${signature(placed)}`;
    const bump = this.pendingBump;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.renderer.render(placed, w, h, { swap: swap && this.lastPrimary !== undefined, immediate });
    }
    this.lastPrimary = primary;
    this.lastViewKey = viewKey;

    if (this.pendingBump && !hidden) {
      this.pendingBump = false;
      this.renderer.bump();
    }
    this.composeSheet(hidden ? null : choice, statuses, now, orient, w, immediate);
    const beam = pStatus?.beam ?? this.busyElsewhere(choice.visible, statuses);
    this.syncGlow(hidden ? null : beam, !hidden && choice.urgent && this.sheet.visible);
    this.sendMirror({
      sig, swap, bump: bump && !hiddenEverywhere, placed, w, h, orient, anchor, edge: s.edge,
      hidden: hiddenEverywhere, fsHide, fullscreen: this.fullscreenAny,
      glow: beamSpec(beam), speed: s.glow,
      accent: ACCENTS[s.accent] ?? s.accent ?? ACCENTS.ember, reduce: s.reduceMotion === 'on' || (s.reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    });
    this.pillInput = placed.some((p) => p.seg.t === 'input');
    this.syncInput();
    this.publishHit(this.renderer.rect, true, hidden ? this.wakeStrip(w) : null);
    this.updateTray(statuses);
    if (Date.now() < this.appSubscribedUntil) this.pushAppState(statuses, level, primary);
  }

  /** Activity keys and actions get the activity's id, so nothing collides. */
  private namespaced(id: string, segs: Seg[]): Seg[] {
    return segs.map((seg) => {
      const out = { ...seg, key: `${id}/${seg.key}` } as Seg;
      if ('action' in out && out.action && !out.action.startsWith('island:')) (out as { action: string }).action = `act:${id}:${out.action}`;
      if (out.t === 'input' && out.cancel && !out.cancel.startsWith('island:')) out.cancel = `act:${id}:${out.cancel}`;
      return out;
    });
  }

  private secondarySegments(ids: string[], statuses: Map<string, ActivityStatus>, level: Level, now: number, vertical: boolean): Seg[] {
    const out: Seg[] = [];
    const compact = level === 'compact';
    ids.slice(0, compact ? 2 : 8).forEach((id, i) => {
      const act = this.running.get(id);
      if (!act) return;
      const meta = CATALOG_BY_ID.get(id) ?? act.meta;
      const env: RenderEnv = { level: 'compact', width: 200, height: 36, now, open: false, hover: false, surfaced: null, interactive: false, vertical };
      let view = null;
      try {
        view = act.chip?.(env) ?? null;
      } catch {
        view = null;
      }
      const label = compact || vertical ? '' : view?.label ?? clip(statuses.get(id)?.summary ?? meta.name, 18);
      if (compact) {
        out.push({ t: 'icon', key: `chip/${id}`, icon: view?.icon ?? meta.icon, tone: view?.tone ?? 'muted', size: 'sm', side: 'end', prio: 8 + i, tip: statuses.get(id)?.summary ?? meta.name });
      } else {
        out.push({
          t: 'chip',
          key: `chip/${id}`,
          label,
          icon: view?.icon ?? meta.icon,
          dot: view?.dot,
          pulse: view?.pulse,
          tone: view?.tone,
          action: 'island:select',
          arg: id,
          side: 'end',
          prio: 6 + i,
          max: 150,
          tip: statuses.get(id)?.summary ?? meta.name,
        });
      }
    });
    return out;
  }

  private homeSegments(now: number, statuses: Map<string, ActivityStatus>, vertical: boolean): Seg[] {
    const d = new Date(now);
    const segs: Seg[] = [
      { t: 'icon', key: 'home/spark', icon: 'spark', tone: 'accent', prio: 0 },
      { t: 'text', key: 'home/time', text: timeOfDay(now), weight: 'semibold', prio: 0 },
      { t: 'text', key: 'home/date', text: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'muted', size: 'sm', prio: 4 },
    ];
    const quiet = [...statuses.entries()].filter(([id, st]) => st.active && id !== 'quick').length;
    if (quiet) segs.push({ t: 'chip', key: 'home/more', label: `${quiet} active`, icon: 'stack', action: 'island:overflow', side: 'end', prio: 3 });
    const env: RenderEnv = { level: 'maximum', width: 400, height: 50, now, open: true, hover: false, surfaced: null, interactive: true, vertical };
    for (const id of this.settings.activities.order) {
      const act = this.running.get(id);
      if (!act?.home) continue;
      try {
        segs.push(...this.namespaced(id, act.home(env)).map((x) => ({ ...x, side: 'center' as const })));
      } catch (err) {
        console.error(err);
      }
    }
    segs.push(
      { t: 'button', key: 'home/activities', icon: 'grid', label: 'Activities', action: 'island:app', arg: 'activities', side: 'end', prio: 2, style: 'ghost' },
      { t: 'button', key: 'home/settings', icon: 'settings', action: 'island:app', arg: 'settings', side: 'end', prio: 2, style: 'ghost', tip: 'Settings' },
    );
    return segs;
  }

  private menuSegments(): Seg[] {
    const a = this.settings.island.anchor;
    const pos = (anchor: Anchor, iconName: string, tip: string): Seg => ({
      t: 'button',
      key: `menu/${anchor}`,
      icon: iconName,
      action: 'island:anchor',
      arg: anchor,
      style: a === anchor ? 'primary' : 'ghost',
      tip,
      prio: 1,
    });
    return [
      { t: 'text', key: 'menu/label', text: 'Position', tone: 'muted', size: 'sm', prio: 3 },
      pos('top', 'pos-top', 'Top centre'),
      pos('right', 'pos-right', 'Right centre'),
      pos('bottom', 'pos-bottom', 'Bottom centre'),
      pos('left', 'pos-left', 'Left centre'),
      { t: 'sep', key: 'menu/sep' },
      {
        t: 'button',
        key: 'menu/dnd',
        icon: 'moon',
        label: this.settings.general.dnd ? 'Quiet on' : 'Quiet',
        style: this.settings.general.dnd ? 'primary' : 'ghost',
        action: 'island:dnd',
        tip: 'Do not disturb, for Windows and the island: notifications wait and the island stays small',
        prio: 2,
      },
      { t: 'button', key: 'menu/activities', icon: 'grid', label: 'Activities', action: 'island:app', arg: 'activities', side: 'end', style: 'secondary', prio: 1 },
      { t: 'button', key: 'menu/settings', icon: 'settings', action: 'island:app', arg: 'settings', side: 'end', style: 'ghost', tip: 'Settings', prio: 1 },
    ];
  }

  private overflowSegments(ids: string[], statuses: Map<string, ActivityStatus>, vertical: boolean): Seg[] {
    const all = ids.length ? ids : [...statuses.entries()].filter(([, st]) => st.active).map(([id]) => id);
    const segs: Seg[] = [{ t: 'button', key: 'ovf/back', icon: 'chevron-left', action: 'island:back', style: 'ghost', prio: 0, tip: 'Back' }];
    all.forEach((id, i) => {
      const act = this.running.get(id);
      if (!act) return;
      const meta = CATALOG_BY_ID.get(id) ?? act.meta;
      segs.push({
        t: 'chip',
        key: `ovf/${id}`,
        label: vertical ? '' : clip(statuses.get(id)?.summary ?? meta.name, 28),
        icon: meta.icon,
        action: 'island:select',
        arg: id,
        selected: id === this.primaryId,
        prio: 2 + i,
        max: 220,
      });
    });
    if (all.length === 0) segs.push({ t: 'text', key: 'ovf/none', text: 'Nothing else is happening', tone: 'muted', prio: 1 });
    return segs;
  }

  // ---------------------------------------------------------------- the card under the pill

  /**
   * One card at a time: an urgent moment (a permission, a question, a finished
   * chat waiting for a reply), else the grid of everything when the island is
   * open, else a surfaced event's details, else whatever the pointer rests on.
   */
  private composeSheet(choice: Picked | null, statuses: Map<string, ActivityStatus>, now: number, orient: Orientation, pillW: number, immediate: boolean): void {
    const picked = choice ? this.pickSheet(choice, statuses, now, orient, pillW) : null;
    // A different card: whatever was typed into the old one is gone, and so is the keyboard.
    if (this.sheetEngaged && (!picked || picked.view.key !== this.sheet.key)) this.sheetEngaged = false;
    this.sheetOwner = picked?.owner ?? null;
    const width = picked ? this.sheetWidth(picked.view, orient, pillW) : 0;
    this.sheet.show(picked?.view ?? null, { anchor: this.settings.island.anchor, area: this.area, width, immediate });
  }

  private pickSheet(choice: Picked, statuses: Map<string, ActivityStatus>, now: number, orient: Orientation, pillW: number): { owner: string; view: SheetView } | null {
    if (this.view !== 'main' || this.previewLevel) return null;
    const vertical = orient === 'vertical';
    const ask = (id: string, reason: SheetEnv['reason']): { owner: string; view: SheetView } | null => {
      const act = this.running.get(id);
      if (!act?.sheet) return null;
      const interactive = this.settings.activities.config[id]?.interactive ?? true;
      const env: SheetEnv = { reason, now, width: this.sheetWidth(null, orient, pillW) - 28, vertical, interactive, surfaced: id === choice.primary ? choice.surfaced : null };
      try {
        const view = act.sheet(env);
        if (!view) return null;
        let blocks = mapActions(view.blocks, (a) => this.nsAction(id, a));
        if (!interactive) blocks = blocks.filter((b) => b.t !== 'input' && b.t !== 'buttons' && b.t !== 'choices').map((b) => (b.t === 'head' ? { ...b, buttons: undefined } : b));
        return { owner: id, view: { ...view, key: `${id}/${view.key}`, blocks } };
      } catch (err) {
        console.error(`sheet ${id}`, err);
        return null;
      }
    };
    const primary = choice.primary;
    const pStatus = primary ? statuses.get(primary) : undefined;
    if (primary && choice.urgent && pStatus?.urgent && !this.dismissedUrgent.has(`${primary}:${pStatus.urgent.key}`)) {
      const card = ask(primary, 'urgent');
      if (card) return card;
    }
    if (this.open) return this.gridSheet(now, orient, pillW);
    if (primary && choice.surfaced) {
      const card = ask(primary, 'surfaced');
      if (card) return card;
    }
    if (this.hover) {
      // The user can make Claude's stats the card every hover shows.
      const owner = this.settings.island.hoverCard === 'claude' && this.running.has('claude') ? 'claude' : this.ownerOf(this.hoverKey);
      const card = owner ? ask(owner, 'hover') : null;
      if (card) return card;
    }
    return null;
  }

  /**
   * The grid is as wide as the open island, so it looks like it belongs to it,
   * and everything in it scales with the island's size setting.
   */
  private gridGeometry(pillW: number): { cols: number; rows: number; cell: number; width: number } {
    const scale = SIZE_SCALE[this.settings.island.size] ?? 1;
    const width = Math.round(Math.min(this.area.width - 32, Math.max(460, Math.min(pillW, 760)) * scale));
    // Four columns unless that would squeeze the cells too narrow to read.
    let cols = 4;
    const cellW = (c: number) => (width - GRID_PAD * 2 - GRID_GAP * (c - 1)) / c;
    while (cols > 2 && cellW(cols) < 104) cols--;
    return { cols, rows: ROWS_PER_PAGE, cell: Math.round(CELL_PX[this.settings.island.size] ?? CELL_PX.medium), width };
  }

  /** Control Center: one tile per switched-on activity, in the user's order. */
  private gridSheet(now: number, orient: Orientation, pillW: number): { owner: string; view: SheetView } | null {
    void orient;
    const geo = this.gridGeometry(pillW);
    const width = geo.width;
    // The island's own cell: how much of today is gone, at a glance.
    const d = new Date(now);
    const dayPct = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
    const tiles: Tile[] = [
      {
        key: 'island/day',
        tone: 'accent',
        body: { k: 'dots', label: d.toLocaleDateString('en-US', { weekday: 'long' }), pct: dayPct, sub: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
      },
    ];
    for (const id of leadFirst(this.settings.activities.order)) {
      const act = this.running.get(id);
      if (!act?.tile) continue;
      const interactive = this.settings.activities.config[id]?.interactive ?? true;
      const env: SheetEnv = { reason: 'open', now, width: width - 28, vertical: orient === 'vertical', interactive, surfaced: null };
      try {
        const tile = act.tile(env);
        if (!tile) continue;
        // Wrapped in a throwaway grid only so the tile's actions get the activity's name.
        const [mapped] = mapActions([{ t: 'tiles', key: 'one', items: [tile], cols: 1, rows: 1, pages: 1, cell: 0 }], (a) => this.nsAction(id, a));
        if (mapped.t === 'tiles') tiles.push({ ...mapped.items[0], key: `${id}/${tile.key}` });
        this.lastTiles.set(`${id}/${tile.key}`, tile.body.k);
      } catch (err) {
        console.error(`tile ${id}`, err);
      }
    }
    if (!tiles.length) return null;
    return { owner: 'island', view: { key: 'island/grid', wide: true, width, blocks: this.arrange(tiles, geo) } };
  }

  /**
   * The user's grid: their order and their sizes, packed into pages. Tiles they
   * took off the grid wait in the tray while editing. Nothing stores positions:
   * the packing is recomputed, so moving one tile shuffles the rest for free.
   */
  private arrange(natural: Tile[], geo: { cols: number; rows: number; cell: number }): SheetView['blocks'] {
    const layout = this.settings.island.grid;
    const rank = new Map(layout.order.map((k, i) => [k, i]));
    const sized = natural
      .map((t, i) => {
        const saved = layout.sizes[t.key];
        const [sw, sh] = saved ? (saved.split('x').map(Number) as [number, number]) : [t.span ?? 1, t.rows ?? 1];
        // Lists, cards and players need two columns whatever was asked for.
        const w = Math.min(geo.cols, NARROW_OK.has(t.body.k) ? sw : Math.max(2, sw));
        const h = Math.max(1, Math.min(geo.rows, sh));
        return { tile: { ...t, w, h, sizeLabel: `${w}×${h}` }, at: rank.get(t.key) ?? 10_000 + i };
      })
      .sort((a, b) => a.at - b.at)
      .map((x) => x.tile);

    const isHidden = hiddenTest(layout.hidden);
    const shown = sized.filter((t) => !isHidden(t.key));
    const slots = packGrid(shown.map((t) => ({ key: t.key, w: t.w, h: t.h })), geo.cols, geo.rows);
    const where = new Map(slots.map((slot) => [slot.key, slot]));
    this.gridSlots = slots;
    this.gridOrder = shown.map((t) => t.key);
    const items: Tile[] = shown.map((t) => ({ ...t, ...(where.get(t.key) ?? { page: 0, col: 0, row: 0 }) }));
    const tray: Tile[] = this.gridEditing ? sized.filter((t) => isHidden(t.key)).map((t) => ({ ...t, w: 1, h: 1, hidden: true })) : [];
    // The card is only as tall as the rows the tiles reach; editing opens every row to drag into.
    const rows = this.gridEditing ? geo.rows : rowsUsed(slots);

    const blocks: SheetView['blocks'] = [
      { t: 'tiles', key: 'grid', items, tray, cols: geo.cols, rows, cell: geo.cell, pages: pageCount(slots), editing: this.gridEditing },
    ];
    if (this.gridEditing) {
      blocks.push({
        t: 'buttons',
        key: 'grid-edit',
        items: [
          { key: 'reset', label: 'Reset layout', icon: 'refresh', action: 'island:grid-reset', style: 'ghost' },
          { key: 'done', label: 'Done', icon: 'check', action: 'island:grid-done', style: 'primary' },
        ],
      });
    }
    return blocks;
  }

  /** Sizes a tile may take: lists, cards and players need the width of two cells. */
  private sizesFor(key: string): TileSize[] {
    return NARROW_OK.has(this.lastTiles.get(key) ?? '') ? TILE_SIZES : ['2x1', '2x2'];
  }

  private lastTiles = new Map<string, string>();

  private gridAction(action: string, arg: unknown): void {
    const grid = this.settings.island.grid;
    const key = typeof arg === 'string' ? arg : '';
    switch (action) {
      case 'island:grid-edit':
        this.gridEditing = true;
        this.open = true;
        return;
      case 'island:grid-done':
        this.gridEditing = false;
        return;
      case 'island:grid-reset':
        this.settings.island.grid = { order: [], sizes: {}, hidden: [] };
        break;
      case 'island:grid-hide':
        if (key && !grid.hidden.includes(key)) grid.hidden.push(key);
        break;
      case 'island:grid-show':
        grid.hidden = unhide(grid.hidden, key);
        break;
      case 'island:grid-size': {
        const options = this.sizesFor(key);
        const slot = this.gridSlots.find((x) => x.key === key);
        const now = grid.sizes[key] ?? (slot ? sizeOf(slot.w, slot.h) : undefined);
        const i = now ? options.indexOf(now) : -1;
        grid.sizes[key] = options[(i + 1) % options.length];
        break;
      }
      case 'island:grid-move': {
        // Live reflow: the order changes as the tile is dragged over the others.
        const a = (arg ?? {}) as { key?: unknown; page?: unknown; col?: unknown; row?: unknown };
        if (typeof a.key !== 'string' || typeof a.page !== 'number' || typeof a.col !== 'number' || typeof a.row !== 'number') return;
        const before = dropBefore(this.gridSlots, this.gridOrder, a.key, a.page, a.col, a.row);
        const next = moveBefore(this.gridOrder, a.key, before);
        if (next.join('\u0000') === this.gridOrder.join('\u0000')) return;
        this.gridOrder = next;
        grid.order = [...next, ...grid.order.filter((k) => !next.includes(k))];
        this.gridDirty = true;
        this.schedule();
        return;
      }
      case 'island:grid-drop':
        if (!this.gridDirty) return;
        this.gridDirty = false;
        break;
    }
    this.saveSettings();
  }

  private sheetWidth(view: SheetView | null, orient: Orientation, pillW: number): number {
    const W = this.area.width;
    if (view?.width) return Math.min(view.width, W - 24);
    if (orient === 'vertical') return Math.min(W - 120, view?.wide ? 440 : 380);
    const want = view?.wide ? Math.max(460, Math.min(pillW, 760)) : Math.max(340, Math.min(pillW, 560));
    return Math.min(want, W - 32);
  }

  /**
   * The border glow: the primary activity asks for it in its status (orbit while
   * busy, pulse when something waits on the user, progress while filling up); an
   * urgent card gets a slow orbit in the same tone.
   */
  private syncGlow(want: ActivityStatus['beam'], cardUrgent: boolean): void {
    const speed = this.settings.island.glow;
    if (speed === 'off') {
      this.pillGlow.set(null);
      this.cardGlow.set(null);
      return;
    }
    this.pillGlow.setSpeed(speed);
    this.cardGlow.setSpeed(speed);
    this.pillGlow.set(beamSpec(want));
    this.cardGlow.set(cardUrgent ? { tone: want?.tone ?? 'accent', motion: 'orbit' } : null);
  }

  /**
   * The pill's own activity has no glow: something busy elsewhere may still circle
   * the edge (Claude thinking while music has the pill). Only orbits: a fill or a
   * pulse belongs to whatever is on the pill.
   */
  private busyElsewhere(visible: string[], statuses: Map<string, ActivityStatus>): ActivityStatus['beam'] {
    for (const id of [...visible, ...this.settings.activities.order]) {
      const st = statuses.get(id);
      const motion = st?.beam ? (st.beam.motion ?? (st.beam.urgent ? 'pulse' : 'orbit')) : null;
      if (st?.active && st.weight === 'foreground' && motion === 'orbit') return st.beam;
    }
    return null;
  }

  /** Activity actions get the activity's id; island actions pass through. */
  private nsAction(id: string, action: string): string {
    return action.startsWith('island:') ? action : `act:${id}:${action}`;
  }

  /** Whose card a hover asks for: the chip or segment under the pointer, else the pill's own activity. */
  private ownerOf(key: string | null): string | null {
    if (key?.startsWith('chip/')) return key.slice(5);
    const id = key?.split('/')[0];
    if (id && this.running.has(id)) return id;
    return this.primaryId;
  }

  // ---------------------------------------------------------------- input focus

  /** The island takes the keyboard while the pill shows an input or the user is typing on the card. */
  private syncInput(): void {
    const has = this.pillInput || this.sheetEngaged;
    const target = () => (this.pillInput ? this.renderer.focusedInput() : this.sheet.focusedInput());
    if (has === this.inputActive) {
      if (has) requestAnimationFrame(() => target()?.focus({ preventScroll: true }));
      return;
    }
    this.inputActive = has;
    void native.setFocusable(has).then(() => {
      if (has) setTimeout(() => target()?.focus({ preventScroll: true }), 40);
    });
  }

  // ---------------------------------------------------------------- hit testing

  /** A thin strip along the edge where a hidden island can be woken by the cursor. */
  private wakeStrip(w: number): Rect {
    const a = this.settings.island.anchor;
    const { width: W, height: H } = this.area;
    if (a === 'top') return { x: (W - w) / 2, y: 0, w, h: 4 };
    if (a === 'bottom') return { x: (W - w) / 2, y: H - 4, w, h: 4 };
    if (a === 'left') return { x: 0, y: (H - 120) / 2, w: 4, h: 120 };
    return { x: W - 4, y: (H - 120) / 2, w: 4, h: 120 };
  }

  private publishHit(drawn: Rect, force: boolean, strip: Rect | null = null): void {
    const now = performance.now();
    if (!force && now - this.lastHitAt < 50) return;
    this.lastHitAt = now;
    const rects = [union(drawn, this.renderer.targetRect)];
    const card = this.sheet?.hitRect();
    if (card) rects.push(card);
    if (strip) rects.push(strip);
    const hiddenNow = this.renderer.targetRect.y < 0 || this.renderer.targetRect.x < 0 || this.renderer.targetRect.y > this.area.height || this.renderer.targetRect.x > this.area.width;
    void native.setHit(hiddenNow && strip ? [strip] : rects);
  }

  // ---------------------------------------------------------------- interaction

  private setHover(on: boolean): void {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(
      () => {
        if (this.hover === on) return;
        this.hover = on;
        this.schedule();
      },
      on ? 80 : 280,
    );
  }

  /**
   * Peek behind: the island fades while the mouse goes through it. The webview
   * gets no pointer-leave while ignoring the mouse, so a hover card ends here.
   */
  private onPeek(on: boolean): void {
    document.documentElement.classList.toggle('peek', on);
    if (!on) return;
    clearTimeout(this.hoverTimer);
    this.hover = false;
    this.hoverKey = null;
    this.schedule();
  }

  /**
   * A tap anywhere outside the pill (or Escape): back to the resting size,
   * whatever raised it — opened, a menu, a surfaced event, a picked chip, an
   * inline input, or an urgent card. Urgent activities stay on the pill
   * (compact, pulsing) and a tap on it brings their card back; a new urgent
   * event raises the pill again on its own.
   */
  private dismiss(): void {
    const cancel = this.inputActive ? this.findInputCancel() : null;
    if (cancel) this.handleAction(cancel, null, this.renderer.pill);
    clearTimeout(this.hoverTimer);
    this.hover = false;
    this.hoverKey = null;
    this.sheetEngaged = false;
    this.gridEditing = false;
    this.open = false;
    this.view = 'main';
    this.selected = null;
    this.surfaces = [];
    for (const [id, st] of this.statuses()) {
      if (!st.urgent) continue;
      this.dismissedUrgent.add(`${id}:${st.urgent.key}`);
      try {
        this.running.get(id)?.dismiss?.(st.urgent.key);
      } catch (err) {
        console.error(err);
      }
    }
    this.schedule();
  }

  private findInputCancel(): string | null {
    for (const [id, act] of this.running) {
      if (id !== this.primaryId) continue;
      try {
        const segs = act.render({ level: 'maximum', width: 600, height: 50, now: Date.now(), open: true, hover: false, surfaced: null, interactive: true, vertical: false });
        const input = segs.find((x) => x.t === 'input');
        if (input && input.t === 'input') return input.cancel ? `act:${id}:${input.cancel}` : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private handleAction(action: string, arg: unknown, _source: HTMLElement): void {
    if (action.startsWith('act:')) {
      const rest = action.slice(4);
      const i = rest.indexOf(':');
      const id = rest.slice(0, i);
      const name = rest.slice(i + 1);
      const act = this.running.get(id);
      if (act?.action) {
        Promise.resolve(act.action(name, arg)).catch((err) => native.log(`action ${id}:${name} failed: ${String(err)}`));
      }
      this.schedule();
      return;
    }
    switch (action) {
      case 'island:tap':
        if (this.view !== 'main') this.view = 'main';
        else if (!this.inputActive) this.open = !this.open;
        break;
      case 'island:menu':
        this.view = this.view === 'menu' ? 'main' : 'menu';
        break;
      case 'island:hover':
      case 'island:sheet-hover':
        this.setHover(Boolean(arg));
        return;
      case 'island:hover-key': {
        const key = typeof arg === 'string' ? arg : null;
        const moved = this.ownerOf(key) !== this.ownerOf(this.hoverKey);
        this.hoverKey = key;
        if (!moved || !this.hover) return;
        break;
      }
      case 'island:sheet-engage':
        this.sheetEngaged = true;
        this.syncInput();
        return;
      case 'island:sheet-escape':
        this.dismiss();
        return;
      case 'island:grid-edit':
      case 'island:grid-done':
      case 'island:grid-reset':
      case 'island:grid-hide':
      case 'island:grid-show':
      case 'island:grid-size':
      case 'island:grid-order':
        this.gridAction(action, arg);
        break;
      case 'island:wheel':
        this.cycle(Number(arg) || 1);
        break;
      case 'island:select':
        this.selected = String(arg);
        this.view = 'main';
        break;
      case 'island:overflow':
        this.view = 'overflow';
        break;
      case 'island:back':
        this.view = 'main';
        break;
      case 'island:anchor':
        this.settings.island.anchor = arg as Anchor;
        this.view = 'main';
        this.open = false;
        this.saveSettings();
        break;
      case 'island:dnd':
        this.toggleQuiet();
        break;
      case 'island:app':
        void native.openApp(typeof arg === 'string' ? arg : null);
        this.open = false;
        this.view = 'main';
        break;
      case 'island:cancel-input':
        this.open = false;
        break;
      default:
        break;
    }
    this.schedule();
  }

  /** Quiet: the island stays small and holds its notifications, and Windows' Do Not Disturb follows. */
  /** Windows has refused Do Not Disturb once already; do not keep saying so. */
  private dndWarned = false;

  private toggleQuiet(): void {
    this.settings.general.dnd = !this.settings.general.dnd;
    this.saveSettings();
    const quiet = this.settings.general.dnd;
    void native.dndSet(quiet).then((r) => {
      native.log(`quiet ${quiet ? 'on' : 'off'} (windows: ${r.ok ? 'changed' : (r.reason ?? 'no answer')})`);
      // Say it once, the first time Windows refuses, rather than on every toggle.
      if (!r.ok && r.reason && !this.dndWarned) {
        this.dndWarned = true;
        if (this.settings.general.notifications) void native.notify('Quiet is on in Island', r.reason);
      }
    });
  }

  private cycle(dir: number): void {
    const ids = this.visibleIds;
    if (ids.length < 2) return;
    const i = Math.max(0, ids.indexOf(this.primaryId ?? ''));
    this.selected = ids[(i + dir + ids.length) % ids.length];
  }

  private tick(): void {
    if (!this.settings) return;
    // Clocks, elapsed times and countdowns: recompose once a second while anything shows.
    if (this.primaryId || this.open || this.surfaces.length) this.compose(false);
  }

  // ---------------------------------------------------------------- hotkeys + tray

  private async updateHotkeys(): Promise<void> {
    const keys: Array<{ id: string; accel: string }> = [];
    if (this.settings.general.toggleHotkey) keys.push({ id: 'island.toggle', accel: this.settings.general.toggleHotkey });
    if (this.settings.general.activitiesHotkey) keys.push({ id: 'island.activities', accel: this.settings.general.activitiesHotkey });
    for (const act of this.running.values()) {
      try {
        keys.push(...(act.hotkeys?.() ?? []));
      } catch {
        /* ignore */
      }
    }
    const sig = JSON.stringify(keys);
    if (sig === this.hotkeySig) return;
    this.hotkeySig = sig;
    this.hotkeyFailures = await native.hotkeysSet(keys);
    if (this.hotkeyFailures.length) native.log(`hotkeys taken: ${this.hotkeyFailures.join(', ')}`);
  }
  private hotkeySig = '';

  private onHotkey(id: string): void {
    if (id === 'island.toggle') {
      this.open = !this.open;
      this.view = 'main';
      this.schedule();
      return;
    }
    if (id === 'island.activities') {
      void native.openApp('activities');
      return;
    }
    const owner = this.running.get(id.split('.')[0]);
    owner?.hotkey?.(id);
  }

  private updateTray(statuses: Map<string, ActivityStatus>): void {
    const tooltip: string[] = ['Island'];
    const menu: MenuItem[] = [];
    let alert = false;
    for (const id of this.settings.activities.order) {
      const act = this.running.get(id);
      if (!act?.tray) continue;
      try {
        const t = act.tray();
        if (!t) continue;
        tooltip.push(...(t.tooltip ?? []));
        if (t.alert) alert = true;
        if (t.menu?.length) menu.push(...t.menu.map((m) => prefixMenu(id, m)), { separator: true });
      } catch (err) {
        console.error(err);
      }
    }
    const active = [...statuses.values()].filter((s) => s.active && s.summary).length;
    if (tooltip.length === 1 && active) tooltip.push(`${active} active`);
    const a = this.settings.island.anchor;
    menu.push(
      { id: 'island:toggle', label: this.open ? 'Close island' : 'Open island' },
      {
        label: 'Position',
        items: (['top', 'right', 'bottom', 'left'] as Anchor[]).map((x) => ({ id: `island:anchor:${x}`, label: x[0].toUpperCase() + x.slice(1), checked: a === x })),
      },
      { id: 'island:dnd', label: 'Do not disturb', checked: this.settings.general.dnd },
      { separator: true },
      { id: 'island:app:activities', label: 'Activities…' },
      { id: 'island:app:settings', label: 'Settings…' },
      { separator: true },
      { id: 'island:quit', label: 'Quit Island' },
    );
    const sig = JSON.stringify([tooltip, alert, menu]);
    if (sig === this.lastTraySig) return;
    this.lastTraySig = sig;
    void native.trayUpdate(tooltip.join('\n'), alert, menu);
  }

  private onTrayMenu(id: string): void {
    if (id.startsWith('act|')) {
      const [, actId, name, ...rest] = id.split('|');
      const act = this.running.get(actId);
      if (act?.action) void Promise.resolve(act.action(name, rest.join('|')));
      return;
    }
    if (id === 'island:toggle') this.open = !this.open;
    else if (id.startsWith('island:anchor:')) {
      this.settings.island.anchor = id.slice('island:anchor:'.length) as Anchor;
      this.saveSettings();
    } else if (id === 'island:dnd') {
      this.toggleQuiet();
    } else if (id.startsWith('island:app:')) void native.openApp(id.slice('island:app:'.length));
    else if (id === 'island:quit') void native.quit();
    this.schedule();
  }

  // ---------------------------------------------------------------- app window bridge

  private async onAppCommand(req: { id: string; target: string; cmd: string; arg: unknown }): Promise<void> {
    let result: unknown = null;
    try {
      if (req.target === 'island') result = await this.islandCommand(req.cmd, req.arg);
      else {
        const act = this.running.get(req.target);
        result = act?.command ? await act.command(req.cmd, req.arg) : null;
      }
    } catch (err) {
      result = { error: String(err) };
    }
    await sendTo('app', 'app-reply', { id: req.id, result });
  }

  private async islandCommand(cmd: string, arg: unknown): Promise<unknown> {
    switch (cmd) {
      case 'subscribe':
        this.appSubscribedUntil = Date.now() + 6000;
        this.schedule();
        return true;
      case 'preview-level':
        this.previewLevel = (arg as Level | null) ?? null;
        this.schedule();
        return true;
      case 'test-alert':
        this.renderer.shake();
        this.renderer.glow('claude');
        return true;
      case 'state':
        return this.snapshot(this.statuses());
      case 'open':
        // The welcome screen's Finish: show the new Control Center.
        this.open = true;
        this.view = 'main';
        this.schedule();
        return true;
      default:
        return null;
    }
  }

  private snapshot(statuses: Map<string, ActivityStatus>) {
    return {
      monitor: this.monitorId,
      area: this.area,
      primary: this.primaryId,
      open: this.open,
      sheet: this.sheetOwner,
      hotkeyFailures: this.hotkeyFailures,
      activities: [...this.running.keys()].map((id) => ({ id, ...(statuses.get(id) ?? { active: false }) })),
    };
  }

  private lastAppPush = 0;
  private pushAppState(statuses: Map<string, ActivityStatus>, _level: Level, _primary: string | null): void {
    const now = Date.now();
    if (now - this.lastAppPush < 400) return;
    this.lastAppPush = now;
    void sendTo('app', 'island-state', this.snapshot(statuses));
  }
}

function beamSpec(want: ActivityStatus['beam']): GlowSpec | null {
  return want ? { tone: want.tone, motion: want.motion ?? (want.urgent ? 'pulse' : 'orbit'), value: want.value, fast: want.fast } : null;
}

function prefixMenu(id: string, m: MenuItem): MenuItem {
  return {
    ...m,
    id: m.id ? `act|${id}|${m.id}` : undefined,
    items: m.items?.map((x) => prefixMenu(id, x)),
  };
}
