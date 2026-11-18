// The Island engine. It decides what should happen (which activity, which
// level, which view), asks the layout engine where things go, and hands the
// result to the renderer, whose springs decide how it gets there.
//
//   activities ─► priority ─► level ─► segments ─► fit ─► shell rect ─► renderer
//                                   └─► sheet (the card under the pill)

import { CATALOG_BY_ID } from '../activities/catalog';
import { ShelfActivity } from '../activities/shelf';
import { ShelfBubble } from './shelf-bubble';
import type { Activity, ActivityContext, ActivityStatus, RenderEnv, SheetEnv, SurfaceOptions } from './activity';
import { reducedMotion, setReducedMotion } from './animator';
import { pillBeam } from './beam';
import { BubbleView } from './bubble';
import { ChatBar, type ChatAction, type ChatView } from './chat';
import { lookFor } from './looks';
import { PetBrain, type PetSignal } from './pet';
import { beamSpec, BorderGlow, type GlowSpec } from './glow';
import { loadShapes, restingTile, saveShapes, type TileShape } from './resting';
import { cellsOf, CELLS, hiddenTest, moveTile, pageCount, rowsUsed, settle, sizeOf, unhide, withNew, type GridDims, type GridPages, type GridSlot } from './grid';
import { bubbleRect, bubbleSize, chatBarRect, innerPadding, LEVELS, orientationFor, pillRect, pillSize, shelfRect, tuckedRect, union, type Anchor, type Area, type Level, type Orientation, type Rect } from './layout';
import { native, on, onFileDrop, onTermOpened, sendTo, type FileDrop, type MenuItem, type PowerState, type TermOpened } from './native';
import { cardChips, choosePrimary, type Candidate, type Choice as Picked, type Surface } from './priority';
import type { MirrorFrame } from './mirror';
import { Strip, type StripView } from './strip';
import { lookOf, WidgetHost } from './widgets';
import { DockHost, type DockCard, type DockFrame } from './dock';
import { PillRenderer } from './renderer';
import { menuMain, menuSegments } from './menu';
import { fadeSegments, fadeSheet } from './fade-menu';
import { quietMoon } from './quiet';
import { fitSegments, fitVertical, signature, type Placed, type Seg } from './segments';
import { applyGlass } from './glass';
import { accentColor, backAt, growsOf, HIDE_CHOICES, hiddenNow, hideUntil, migrate, ALL_TILE_SIZES, FULL_WIDTH_SIZES, TILE_SIZES, type GridLayout, type Grows, type HideChoice, type Settings, type TileSize } from './settings';
import { availableHere, platform } from './platform';
import { mapActions, SheetRenderer, type Block, type DropZone, type SheetButton, type SheetChip, type SheetView, type Tile } from './sheet';
import { chatView, flatView, GROW_MS, hoverGrows, hoverView, phoneHoverView } from './grow';
import { tileCard } from './tilecard';
import { pillMotion } from './spring';
import { WheelGesture } from './wheel';
import { workspaceEngine } from '../workspaces/engine';
import { clip, timeOfDay } from './format';
import { PhoneActs, PhoneError, PhoneHub, termAllowed, type PhoneDelivery, type PhoneIslandHooks } from '../remote/hub';
import { applyPref, prefsOf } from '../remote/prefs';
import { phoneNative } from '../remote/native';
import { HELLO_FOLDERS, PHONE_ISLAND_ACTIONS, readSwipe, type BotState, type Nav, type ScreenState } from '../remote/protocol';
import { urgentIds } from '../remote/views';

type View = 'main' | 'overflow' | 'menu' | 'hide' | 'fade';

const levelIdx = (l: Level) => LEVELS.indexOf(l);
/** Tile kinds that read well in a single column. */
const NARROW_OK = new Set(['stat', 'actions', 'dots']);
/** A pop-up the pointer holds (SurfaceOptions.hoverHolds) goes this long after the pointer leaves the island. */
const HOVER_HOLD_MS = 600;



/** The sizes a list, card or player can take: two columns at least. */
const WIDE_SIZES: TileSize[] = ['2x1', '2x2'];
/** Music's lyrics: tall, so every line shows in full (Moss, 2026-11-13). */
// Every size (Justin: 1x1, 1x2, 2x1, 2x2 and the tall ones); the line being sung stays in the middle of any of them.
// Music stretches across 2 or 4 columns (Moss, 2026-11-17).
const LYRIC_SIZES: TileSize[] = [...ALL_TILE_SIZES, ...FULL_WIDTH_SIZES];
/** Music's player: two columns or the whole width, one row or two. */
const MEDIA_SIZES: TileSize[] = [...WIDE_SIZES, '4x1', '4x2'];
/** Island set Windows' taskbar to hide (kept across restarts and crashes, to put it back). */
const HID_BAR_KEY = 'island.taskbar.hidWindows';
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* the next start can't tell, and leaves the taskbar as it is */
  }
}

const sizesOfKind = (k: string): TileSize[] => (k === 'lyrics' ? LYRIC_SIZES : k === 'media' ? MEDIA_SIZES : NARROW_OK.has(k) ? TILE_SIZES : WIDE_SIZES);
/** Row height per island size (the width comes from the pill). */
const CELL_PX = { small: 80, medium: 92, large: 106 } as const;
const SIZE_SCALE = { small: 0.88, medium: 1, large: 1.14 } as const;
/** A card grown out of the pill (Music's player) at the medium size, about an iPhone's expanded island against the pill. */
const MORPH_W = 372;
const GRID_GAP = 8;
/** The drop card's boxes (the Shelf, Land), CSS px tall. */
const DROP_ZONE_H = 96;
const GRID_PAD = 14;
/** Every page of the grid is this many cells: always four across. */
const GRID_COLS = 4;
const GRID_ROWS = 4;
/** Narrowest grid that still gives each of the four columns 90 px. */
const GRID_MIN_W = GRID_COLS * 90 + GRID_GAP * (GRID_COLS - 1) + GRID_PAD * 2;
/** Every size inside a tile is drawn for this cell and scaled by --k = cell / this (sheet.ts). */
export const TILE_DESIGN_CELL = 92;
/** The width a one-cell tile's content is drawn for: narrower columns shrink the tiles to fit. */
const TILE_DESIGN_W = 120;

/**
 * The grid's row height for a grid `width` px wide (padding included): the island size's own,
 * unless the columns are too narrow for a tile's design; then smaller in proportion. A tile's
 * content scales with it, so it fits its cell at any island width or size instead of being cut off.
 */
export function gridCell(width: number, sizeCell: number): number {
  const col = (width - GRID_PAD * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const k = Math.min(sizeCell / TILE_DESIGN_CELL, col / TILE_DESIGN_W);
  return Math.max(48, Math.round(TILE_DESIGN_CELL * k));
}
const atLeast = (a: Level, b: Level): Level => (levelIdx(a) >= levelIdx(b) ? a : b);
/** Activities that stay in front once they pop up (a chat finished, a song started), until the user picks another. */
const STAYS_IN_FRONT = new Set(['claude', 'music']);
/** How long opening or closing keeps the pill's shape from overshooting: longer than the motion. */
const CALM_MS = 1200;
/** Chrome Remote Desktop's state is asked this often, for phones' Screen button. */
const SCREEN_POLL_MS = 3 * 60_000;
/** The island's own note on the pill (a phone opened a terminal) shows this long. */
const NOTE_MS = 5000;

/**
 * A card opened from Control Center always has a way back to it (Justin: Phone's card had none): its head
 * gets a Back before the title unless the activity gave it one.
 */
export function withBack(c: { owner: string; view: SheetView }): { owner: string; view: SheetView } {
  const i = c.view.blocks.findIndex((b) => b.t === 'head');
  const back: SheetButton = { key: 'cc-back', icon: 'chevron-left', action: 'island:card-close', style: 'ghost', tip: 'Back to Control Center' };
  if (i < 0) return { ...c, view: { ...c.view, blocks: [{ t: 'buttons', key: 'cc-back', align: 'start', items: [{ ...back, label: 'Control Center' }] }, ...c.view.blocks] } };
  const head = c.view.blocks[i] as Extract<SheetView['blocks'][number], { t: 'head' }>;
  // The card's own way back to Control Center (the grid icon at its right, on Apps, Reminders, Game and
  // Land's cards) does what the arrow does: only the arrow stays (Justin).
  const buttons = head.buttons?.filter((b) => b.action !== 'island:card-close');
  const blocks = [...c.view.blocks];
  blocks[i] = { ...head, back: head.back ?? back, buttons: buttons?.length ? buttons : undefined };
  return { ...c, view: { ...c.view, blocks } };
}

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
  /** When the user picked `selected` (chip, wheel): such a pick outlasts a tap away. 0: an activity opened itself. */
  private pickedAt = 0;
  private lastPrimary: string | null | undefined = undefined;
  private lastViewKey = '';
  private lastSig = '';
  private lastAnchor: Anchor | null = null;
  /** The level last composed, and until when the pill's shape moves without overshoot (opening, closing). */
  private lastLevel: Level | null = null;
  private calmUntil = 0;
  /** Opening from a grown card, or closing back into one: the pill moves on the card's curve till then. */
  private carriedUntil = 0;
  private lastOrientation: Orientation | null = null;
  private scheduled = false;
  private fullscreenOn: string | null = null;
  private readonly strip: Strip;
  private widgets: WidgetHost | null = null;
  private dock: DockHost | null = null;
  /** Windows' taskbar was set to hide by Island (put back when the taskbar is turned off). */
  private hidWindowsBar = false;
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
  /** What scrolling the pill steps through, in rank order (Choice.ranked). */
  private visibleIds: string[] = [];
  /** The scroll gesture in progress: one gesture switches one activity. */
  private readonly wheel = new WheelGesture();
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
  /** The layout when this edit began: Reset layout puts it back (Justin: not the default). */
  private gridBefore: GridLayout | null = null;
  /** The layout of the last grid drawn: its pages and where every tile landed. */
  private gridPages: GridPages = [];
  private gridSlots: GridSlot[] = [];
  /**
   * A tile being dragged or resized: the layout and sizes when it was picked up,
   * its size now, and the layout it would get if dropped this moment (drawn
   * instead of the saved one until the drop).
   */
  private gridDrag: { key: string; snap: GridPages; dims: Map<string, { w: number; h: number }>; size: { w: number; h: number }; preview: GridPages | null } | null = null;
  /** Segment key under the pointer: tells whose card a hover asks for. */
  private hoverKey: string | null = null;
  /** The pointer is on the pill itself (not the card). */
  private pointerOnPill = false;
  /** Pointed at, this activity grows into a card but had none to show: the pill widens for it instead. */
  private hoverBare: string | null = null;
  /** The card on screen is a chat's own (it finished, it needs you), grown out of the pill: pointing at it keeps the pill resting under it. */
  private raisedCard = false;
  /** Rust holds Ctrl+V for Land (the pointer rests on its icon). */
  private pasteArmed = false;
  /** Light on the pill's edge and on an urgent card's, in the tone of whatever is happening. */
  private readonly pillGlow: BorderGlow;
  /** The bot in its bubble beside the pill. */
  private readonly bubble: BubbleView;
  /** The bar under the bot you type to it in, and the card with its answer. */
  private readonly chat: ChatBar;
  /** The bar is open (a click on the bot opens it; a tap away or Escape closes it, the chat kept). */
  private chatOpen = false;
  /** What the bot shows, from what every activity reports (src/core/pet.ts). */
  private readonly brain = new PetBrain();
  private readonly cardGlow: BorderGlow;
  /** The pill's light, moved onto a card grown out of the pill (same corners as .sheet.morph). */
  private readonly grownGlow: BorderGlow;
  /** Duplicate mode: how many copies of the pill run on other screens, and the last frame sent to them. */
  private mirrorCount = 0;
  private mirrorKey = '';
  private mirrorFrame: MirrorFrame | null = null;
  /** Monitor with a full-screen app in front (any monitor, for the copies). */
  private fullscreenAny: string | null = null;
  /** The activity whose own card the open island shows instead of Control Center (Land after a drop). */
  private cardFor: string | null = null;
  /**
   * Files are being dragged over the island (it opens on the drop card: the Shelf | Land) or over
   * the Shelf's circle; `hot`: the side under the pointer; `was`: how the island was before, to go
   * back to when they leave or are dropped on neither side.
   */
  private fileDrag: { where: 'island' | 'circle'; hot: string | null; was: { open: boolean; cardFor: string | null } } | null = null;
  /** Files were just dropped on the Shelf: its card stays open until the pill or its x is clicked (Moss). */
  private shelfPinned = false;
  /** The Shelf's circle beside the pill, opposite the bot. */
  private readonly shelfBubble: ShelfBubble;
  /** The window is hidden because the user hid the island for a while (`island.hiddenUntil`). */
  private windowHidden = false;
  /** Whether Rust holds the menu's Fade right now (it lets go for a right click, which opens the menu). */
  private holdOn = false;
  /** What Rust was last told about smart fade (null: nothing yet). */
  private smartOn: boolean | null = null;
  /** Island on your phone: what phones see of this island and what their taps do (src/remote/hub.ts). */
  private hub: PhoneHub | null = null;
  /** The pill as last composed, and the bot as last shown, for phones (also with no Duplicate copies). */
  private lastFrame: MirrorFrame | null = null;
  private botNow: BotState | null = null;
  /** Activities running what a phone pressed: a card one opens meanwhile opens on that phone. */
  private readonly phoneActs = new PhoneActs();
  /** Phones may open terminals here (what Rust was last told, remote_term_allow). */
  private termOn = false;
  /** Chrome Remote Desktop on this PC, for phones' Screen button (screen_state). */
  private screen: ScreenState = null;
  /** A note of the island's own on the pill for a moment: a phone opened a terminal. */
  private note: { text: string; icon: string; until: number } | null = null;

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
        if (card) {
          this.cardGlow?.place(card);
          this.grownGlow?.place(card);
        }
        this.publishHit(this.renderer.rect, false);
      },
      (cover) => {
        this.renderer.setCover(cover);
        // The card is back in the pill (or the island opened from it): the pill's light comes back to the pill.
        if (cover === 'off' || cover === 'uncovering') this.schedule();
      },
    );
    // The light is drawn above the pill and the card, not inside them, so it can spill over their edges.
    this.pillGlow = new BorderGlow(stage, null, 'of-pill');
    this.strip = new Strip(stage);
    this.bubble = new BubbleView(stage, { interactive: true, onClick: () => this.handleAction('island:bot', null, this.bubble.el) });
    this.shelfBubble = new ShelfBubble(stage, {
      act: (name, arg) => void this.runAct(`act:shelf:${name}`, arg),
      open: () => {
        this.open = true;
        this.view = 'main';
        this.cardFor = 'shelf';
        this.shelfPinned = true;
        this.chatOpen = false;
        this.schedule();
      },
      changed: () => this.schedule(),
    });
    this.chat = new ChatBar(stage, (action, arg) => this.chatAction(action, arg), () => this.publishHit(this.renderer.rect, true));
    this.cardGlow = new BorderGlow(stage, 24);
    this.grownGlow = new BorderGlow(stage, 34, 'of-grown');
    this.renderer.onFrame((r) => {
      this.sheet.follow(r);
      this.pillGlow.place(r);
      this.publishHit(r, false);
    });
  }

  // ---------------------------------------------------------------- boot

  async boot(): Promise<void> {
    this.settings = migrate(await native.settingsGet());
    void native.remoteName().then((n) => (this.systemName = n));
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
    // A right click on the faded island (Rust let go of the hold): its menu, where Fade says Show.
    await on('hold-menu', () => {
      this.holdOn = false;
      this.view = 'menu';
      this.open = false;
      this.schedule();
    });
    // Ctrl+V while the pointer rests on Land's icon: Land opens with what was copied.
    await on('land-paste', () => {
      const land = this.running.get('land');
      if (land?.action) Promise.resolve(land.action('paste', null)).catch((err) => native.log(`land paste failed: ${String(err)}`));
    });
    // The bot's eyes follow the pointer while Rust sees it near the island (the preview has no Rust).
    await on<{ x: number; y: number } | null>('pointer', (p) => {
      this.bubble.lookAt(p);
      this.shelfBubble.pointerAt(p);
    });
    if (native.demo) window.addEventListener('pointermove', (e) => this.bubble.lookAt({ x: e.clientX, y: e.clientY }));
    await on('displays-changed', () => void this.place(false));
    await onFileDrop((e) => this.onFileDrop(e));
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
      if (!(e.target as Element | null)?.closest?.('.pill, .sheet, .bubble, .chat, .shelfb')) this.dismiss();
    });
    window.addEventListener('resize', () => {
      if (native.demo) void this.place(false);
    });

    // Island on your phone: paired phones see this island live and tap it.
    this.widgets = new WidgetHost(
      {
        tiles: (now) => this.gridTiles(now, 460, false),
        act: (action, arg) => void this.runAct(action, arg),
        save: () => this.saveSettings(),
        look: () => ({ accent: this.settings.island.accent, color: this.settings.island.color, glass: this.settings.island.glass, reduce: document.documentElement.classList.contains('reduce') }),
        enabled: (kind) => this.running.has(kind),
      },
      () => this.settings.island.widgets,
    );
    this.widgets.start().catch((err) => native.log(`widgets failed to start: ${String(err)}`));
    setInterval(() => this.widgets?.tick(Date.now()), 1000);
    this.dock = new DockHost(
      {
        pinned: () => {
          const saved = this.settings.activities.config.apps?.options.apps;
          return Array.isArray(saved) ? (saved as Array<{ name: string; target: string }>).filter((a) => a && typeof a.target === 'string') : [];
        },
        setPinned: (apps) => {
          // Through the Apps activity when it runs, so its own list (and the phone's) follows.
          const act = this.running.get('apps');
          if (act?.command) void act.command('set', apps);
          else {
            const cfg = this.settings.activities.config.apps;
            if (!cfg) return;
            cfg.options = { ...cfg.options, apps };
            this.saveSettings();
          }
        },
        music: () => this.dockMusic(),
        timer: () => this.dockTimer(),
        claude: () => this.dockClaude,
        appsCard: () => {
          const act = this.running.get('apps') as unknown as { dockCard?: () => DockCard } | undefined;
          return act?.dockCard?.() ?? { apps: [], editing: false, query: '', found: [], note: null, bad: false, reading: false, off: true };
        },
        appsAct: (name, arg) => this.running.get('apps')?.action?.(name, arg),
        battery: () => this.dockBattery,
        muted: () => this.dockMuted,
        wifi: () => this.dockWifi,
        hidden: () => this.settings.island.taskbar.hidden,
        setHidden: (items) => {
          this.settings.island.taskbar.hidden = items;
          this.saveSettings();
        },
        look: () => ({ accent: this.settings.island.accent, ...lookOf(this.settings.island.taskbar.look, this.settings.island) }),
        act: (action) => void this.runAct(action, null),
        locked: () => this.settings.island.taskbar.locked,
        setLocked: (on) => {
          this.settings.island.taskbar.locked = on;
          this.saveSettings();
        },
        size: () => this.settings.island.taskbar.size,
        setSize: (size) => {
          this.settings.island.taskbar.size = size;
          this.saveSettings();
        },
        style: () => this.settings.island.taskbar.style,
        setStyle: (style) => {
          this.settings.island.taskbar.style = style;
          this.saveSettings();
        },
        edge: () => this.settings.island.taskbar.edge,
        setEdge: (on) => {
          this.settings.island.taskbar.edge = on;
          this.saveSettings();
        },
        open: (id) => {
          this.view = 'main';
          if (id && this.running.has(id)) this.pick(id, Date.now());
          this.open = true;
          this.schedule();
        },
        centre: () => this.settings.island.taskbar.centre,
        saveCentre: (c) => {
          this.settings.island.taskbar.centre = c;
          this.saveSettings();
        },
      },
      () => this.settings.island.taskbar.on,
    );
    void on<{ muted: boolean }>('audio', (a) => {
      if (typeof a?.muted === 'boolean') this.dockMuted = a.muted;
    });
    // The taskbar's battery and Wi-Fi: the battery as Windows reports it, Wi-Fi asked now and then.
    const power = (p: PowerState | null) => {
      this.dockBattery = p?.hasBattery && typeof p.percent === 'number' ? { percent: p.percent, charging: p.charging } : null;
    };
    void on<PowerState>('power', power);
    void native.powerState().then(power);
    const radios = () => void native.radiosState().then((r) => (this.dockWifi = r?.wifi ?? null));
    radios();
    setInterval(() => {
      if (this.settings.island.taskbar.on) radios();
    }, 15000);
    this.dock.start().catch((err) => native.log(`taskbar failed to start: ${String(err)}`));
    setInterval(() => {
      if (this.settings.island.taskbar.on) void this.syncDockClaude();
      void this.dock?.tick();
      this.syncWindowsBar();
    }, 1000);
    this.hub = new PhoneHub(this.phoneHooks(), phoneNative);
    this.hub.start().catch((err) => native.log(`phones failed to start: ${String(err)}`));
    // A phone's terminals: Rust refuses them unless Settings › Your phone allows them.
    this.termOn = termAllowed(this.settings);
    void native.remoteTermAllow(this.termOn);
    await onTermOpened((e) => this.onTermOpened(e));
    // Chrome Remote Desktop, for phones' Screen button: asked now and every few minutes.
    void this.pollScreen();
    setInterval(() => void this.pollScreen(), SCREEN_POLL_MS);

    setInterval(() => this.tick(), 1000);
    setInterval(() => this.followCursor(), 1500);
    await this.updateHotkeys();
    // The native side outlives this page (a reload, an update): a keyboard it was given while typing
    // on the last page, or a smart fade it was told about, would stay, and with the keyboard held
    // Ctrl never peeks and smart fade never fades (Justin: Ctrl stopped fading the island).
    void native.setFocusable(false);
    void native.setSmart(false);
    void native.setPeek(this.settings.island.peekThrough, this.settings.island.peekUntilBack);
    void native.setAutoUpdate(this.settings.general.autoUpdate);
    this.compose(true);
    // Hidden for a while before Island last quit: it stays hidden, and says so once.
    this.windowHidden = hiddenNow(this.settings.island, Date.now());
    await native.show(!this.windowHidden);
    if (this.windowHidden && this.settings.general.notifications && !native.demo) {
      const at = backAt(this.settings.island.hiddenUntil, Date.now());
      void native.notify('Island is hidden', `${at ? `It comes back ${at}.` : 'It stays hidden until you bring it back.'} ${this.showHint()}`);
    }
    native.log(`island ready on ${this.monitorId ?? 'unknown monitor'} ${Math.round(this.area.width)}x${Math.round(this.area.height)}${this.windowHidden ? ' (hidden)' : ''}`);
    // First run: the welcome screen asks two questions and sets the Control Center up.
    if (!this.settings.general.onboarded && !native.demo) void native.openApp('welcome');
  }

  private applyLook(): void {
    const s = this.settings.island;
    const reduce = s.reduceMotion === 'on' || (s.reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    setReducedMotion(reduce);
    document.documentElement.classList.toggle('reduce', reduce);
    document.documentElement.style.setProperty('--accent', accentColor(s));
    this.bubble.colour(accentColor(s));
    document.documentElement.dataset.pill = s.color;
    applyGlass(document.documentElement, s.glass);
  }

  private applySettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    this.applyLook();
    if (prev.island.display !== next.island.display || prev.island.displayId !== next.island.displayId || prev.island.displayIds.join() !== next.island.displayIds.join()) void this.place(false);
    this.syncActivities(prev);
    void this.updateHotkeys();
    if (prev.island.peekThrough !== next.island.peekThrough || prev.island.peekUntilBack !== next.island.peekUntilBack) void native.setPeek(next.island.peekThrough, next.island.peekUntilBack);
    if (prev.general.autoUpdate !== next.general.autoUpdate) void native.setAutoUpdate(next.general.autoUpdate);
    // Terminal from your phone, or Windows Hello for Allow, changed: Rust is told, and phones get a fresh hello.
    const term = termAllowed(next);
    if (term !== this.termOn) {
      this.termOn = term;
      void native.remoteTermAllow(term);
    }
    // Hidden or shown from the Settings page.
    this.syncHidden();
    this.schedule();
  }

  // ---------------------------------------------------------------- hiding for a while

  /** Hides the island (the pill, the bot and every copy) until the chosen time. */
  private hide(choice: HideChoice): void {
    this.dismiss();
    this.settings.island.hiddenUntil = hideUntil(choice, Date.now());
    this.saveSettings();
    native.log(`hidden ${choice}`);
    this.syncHidden();
  }

  private unhide(): void {
    if (!this.settings.island.hiddenUntil) return;
    this.settings.island.hiddenUntil = 0;
    this.saveSettings();
    this.syncHidden();
  }

  /** Shows or hides the window to match `hiddenUntil`; once the time has passed, it clears it. */
  private syncHidden(): void {
    const hide = hiddenNow(this.settings.island, Date.now());
    if (!hide && this.settings.island.hiddenUntil) {
      this.settings.island.hiddenUntil = 0;
      this.saveSettings();
    }
    if (hide === this.windowHidden) return;
    this.windowHidden = hide;
    if (native.demo) document.body.style.visibility = hide ? 'hidden' : '';
    void native.show(!hide);
    if (!hide) this.pendingBump = true;
    this.schedule();
  }

  // ---------------------------------------------------------------- fading (the menu's Fade)

  /**
   * The menu's Fade, and its Show: like tapping Ctrl over the island (it fades, clicks go through to
   * what is under it), but it stays that way until Show. Kept in settings, so it lasts across restarts.
   */
  private setFaded(on: boolean): void {
    this.view = 'main';
    this.open = false;
    if (this.settings.island.faded === on) return;
    this.settings.island.faded = on;
    this.saveSettings();
    native.log(on ? 'faded' : 'unfaded');
    this.syncHold();
  }

  private syncSmart(on: boolean): void {
    if (on === this.smartOn) return;
    this.smartOn = on;
    void native.setSmart(on);
  }

  /** Rust holds the fade while faded, except while the menu it was right-clicked open for shows (then Show is at hand). */

  private syncHold(): void {
    const want = this.settings.island.faded && this.view !== 'menu';
    if (want === this.holdOn) return;
    // The menu's own Show lets go here; a right click already let go in Rust.
    this.holdOn = want;
    void native.setHold(want);
  }

  /** How to bring a hidden island back. */
  private showHint(): string {
    const where = platform === 'macos' ? 'the menu bar icon' : 'the tray icon';
    const key = this.settings.general.toggleHotkey;
    return key ? `Bring it back from ${where} or with ${key}.` : `Bring it back from ${where}.`;
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
    const key = `${frame.sig}|${frame.hidden}|${frame.fsHide}|${frame.fullscreen}|${JSON.stringify(frame.glow)}|${frame.speed}|${frame.anchor}|${frame.edge}|${frame.accent}|${frame.color}|${frame.glass}|${frame.reduce}|${frame.bot?.d ?? 0}`;
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
      if (cfg?.enabled && !running && availableHere(id)) {
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
        // Opened by the activity itself, not picked: a tap away lets it go.
        this.pick(id, 0);
        this.schedule();
      },
      close: () => {
        this.open = false;
        this.view = 'main';
        this.schedule();
      },
      isOpen: () => this.open,
      isPrimary: () => this.primaryId === id,
      openCard: () => {
        // Opened by what a phone pressed: the card opens on that phone, not on this screen.
        const phone = this.phoneActs.phoneFor(id);
        if (phone && this.hub) return this.hub.openCard(phone, id);
        this.open = true;
        this.view = 'main';
        this.cardFor = id;
        this.schedule();
      },
      closeCard: () => {
        const phone = this.phoneActs.phoneFor(id);
        if (phone && this.hub) return this.hub.closeCard(phone, id);
        if (this.cardFor === id) this.cardFor = null;
        this.schedule();
      },
      cardOpen: () => (this.open && this.cardFor === id) || (this.hub?.showsCard(id) ?? false),
      notify: (title, body, phone = true) => {
        const g = this.settings.general;
        if (g.dnd) return;
        if (g.notifications) void native.notify(title, body);
        if (phone) this.toPhone(id, title, body);
      },
      push: (title, body, look) => {
        if (!this.settings.general.dnd) this.toPhone(id, title, body, look);
      },
      log: (...parts) => void native.log(`${id}: ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`),
      setQuiet: (on) => this.setQuiet(on),
      setOptions: (patch) => {
        const cfg = this.settings.activities.config[id];
        if (!cfg) return;
        cfg.options = { ...cfg.options, ...patch };
        this.saveSettings();
        this.schedule();
      },
      tell: async (target, cmd, arg) => {
        const act = target === id ? undefined : this.running.get(target);
        return act?.command ? await act.command(cmd, arg) : undefined;
      },
    };
  }

  /**
   * To the phone: paired phones that turned notifications on (Settings › Your phone; a tap opens
   * activity `id`'s card there), and Settings › Notifications › Send to my phone (ntfy, src-tauri/src/phone.rs).
   */
  private toPhone(id: string, title: string, body: string, look: { tag?: string; priority?: number; buttons?: Array<{ label: string; reply: string }> } = {}): void {
    this.hub?.push(title, body, look.tag ?? '', id, (look.priority ?? 3) >= 4);
    const g = this.settings.general;
    if (!g.phonePush || !g.phoneTopic) return;
    // Buttons only with Answer Claude from my phone on; then Island listens for the taps while the request waits.
    const answers = g.phoneApprove && g.phoneReplyTopic && look.buttons?.length ? look.buttons : null;
    void native.phonePush(g.phoneTopic, title, body, look.tag, look.priority, answers ? g.phoneReplyTopic : undefined, answers ?? undefined);
    if (answers) void native.phoneListen(g.phoneReplyTopic, 130);
  }

  private surface(id: string, opts: SurfaceOptions = {}): void {
    const cfg = this.settings.activities.config[id];
    if (!cfg?.enabled || !cfg.autoShow || this.settings.general.dnd) return;
    const now = Date.now();
    const key = opts.key ?? 'event';
    this.surfaces = this.surfaces.filter((s) => !(s.id === id && s.key === key) && s.until > now);
    this.surfaces.push({ id, key, until: now + (opts.ms ?? 3500), level: opts.level ?? 'expanded', at: now, hoverHolds: opts.hoverHolds });
    // Picked just before its own event, so the event still shows as one (its card), then it stays.
    if (STAYS_IN_FRONT.has(id)) this.pick(id, now - 1);
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
    this.syncHold();
    const now = Date.now();
    const s = this.settings.island;
    const statuses = this.statuses();
    // A pop-up that the pointer holds stays while the pointer is on the island (pill or card),
    // and goes a moment after it leaves.
    if (this.hover) {
      let held = false;
      for (const x of this.surfaces) {
        if (!x.hoverHolds || x.until >= now + HOVER_HOLD_MS) continue;
        x.until = now + HOVER_HOLD_MS;
        held = true;
      }
      if (held) setTimeout(() => this.schedule(), HOVER_HOLD_MS + 20);
    }
    this.surfaces = this.surfaces.filter((x) => x.until > now && this.running.has(x.id));

    const order = this.settings.activities.order;
    const candidates: Candidate[] = [...this.running.keys()].map((id) => ({
      id,
      status: statuses.get(id) ?? { active: false },
      config: this.settings.activities.config[id],
      order: order.indexOf(id),
    }));
    if (this.selected && !statuses.get(this.selected)?.active) this.selected = null;
    const choice = choosePrimary(candidates, { selected: this.selected, pickedAt: this.pickedAt, surfaces: this.surfaces, now, dnd: this.settings.general.dnd });
    const primary = choice.primary;
    // Asking for you pops it up too: once answered, it stays in front.
    if (choice.urgent && primary && STAYS_IN_FRONT.has(primary) && this.selected !== primary) this.pick(primary, now);
    this.primaryId = primary;
    // Scrolling steps through a steady order: the primary-first one would only flip between two.
    this.visibleIds = choice.ranked;
    const pStatus = primary ? statuses.get(primary) : undefined;
    // Chip-only activities (Land's icon) with nothing else on: the pill holds just their chips.
    const loneChips = primary ? [] : choice.visible.filter((id) => statuses.get(id)?.chipOnly);

    // Level: resting compact, raised by events, hover, the user, or urgency.
    let level: Level = primary || loneChips.length ? 'compact' : 'idle';
    const surf = primary ? this.surfaces.filter((x) => x.id === primary).sort((a, b) => b.at - a.at)[0] : undefined;
    // Pointed at, a card grows out of the pill and covers it: the pill underneath stays as it is.
    if (!this.hover || this.hoverOwner() !== this.hoverBare) this.hoverBare = null;
    const morphing = this.hover && !this.open && this.view === 'main' && this.growsCard(this.hoverOwner());
    // A chat's card grown out of the pill (it finished, it needs you) covers it: the pill rests under
    // it, so when the card shrinks back there is no raised layout to swap out for a split second.
    // Under a hover card the pill stays as it is, so it is as it was when the card goes back.
    // Pointing at that chat's card changes nothing: the pill stays resting, so the card keeps its size.
    const underCard = this.sheet.grown && (!morphing || this.raisedCard);
    // Under a card grown out of the pill (the pointer on it) the pill stays too: pausing or skipping
    // from Music's player surfaces the change, and a raised pill under it widened the card (Justin).
    // But a pop-up hanging below the pill (Land's "file arrived": a card that did not grow out of it,
    // while its event is up) keeps the raised pill when pointed at: dropping it narrowed and widened
    // that card as the pointer moved over it (Justin).
    const hangingPopUp = choice.surfaced !== null && this.sheet.visible && !this.sheet.grown;
    if (surf && !underCard && (!morphing || hangingPopUp)) level = atLeast(level, surf.level);
    if (this.hover && s.hoverExpand && primary && !this.open && !morphing) level = atLeast(level, 'expanded');
    if (this.open || this.view !== 'main') level = 'maximum';
    // An activity's own card belongs to the open island; closing the island goes back to Control Center.
    if (!this.open) {
      this.cardFor = null;
      this.shelfPinned = false;
    }
    // The island's own note (a phone opened a terminal) holds the pill for a moment.
    if (this.note && this.note.until <= now) this.note = null;
    const note = this.note && !this.open && this.view === 'main' ? this.note : null;
    if (note) level = atLeast(level, 'expanded');
    // Urgency raises the pill until a tap outside dismisses it; a new urgent key raises it again.
    const urgentKeys = new Set<string>();
    for (const [id, st] of statuses) if (st.urgent) urgentKeys.add(`${id}:${st.urgent.key}`);
    for (const k of this.dismissedUrgent) if (!urgentKeys.has(k)) this.dismissedUrgent.delete(k);
    if (choice.urgent && pStatus?.urgent && !underCard && !this.dismissedUrgent.has(`${primary}:${pStatus.urgent.key}`)) {
      level = atLeast(level, pStatus.urgent.level ?? 'maximum');
    }
    if (this.previewLevel) level = this.previewLevel;

    const urgentNow = choice.urgent;
    const fsHide = !urgentNow && s.hideInFullscreen && !pStatus?.overFullscreen;
    const hiddenEverywhere =
      this.moving ||
      (!primary && s.idle === 'hidden' && !this.open && !this.hover && this.view === 'main' && !this.previewLevel && !this.fileDrag && !note);
    // A strip in place of the pill over a full-screen app (Games set to a strip).
    const strip = this.fullscreenOn !== null && !hiddenEverywhere && !urgentNow ? this.stripView(now) : null;
    this.strip.show(strip);
    const hidden = hiddenEverywhere || ((fsHide || strip !== null) && this.fullscreenOn !== null);

    const anchor = s.anchor;
    // Left/right pills stand vertical; an inline input needs a horizontal pill to type in.
    const build = (orient: Orientation) => {
      let size = pillSize(this.area, s.widths, level, s.edge, s.size, orient);
      const pad = innerPadding(size.cross);
      let inner = Math.max(40, size.main - pad * 2);
      const crossMax = orient === 'vertical' ? Math.max(16, size.cross - 14) : size.h;
      const vertical = orient === 'vertical';
      let segs: Seg[];
      let viewKey: string;
      if (note) {
        segs = this.noteSegments(note, vertical);
        viewKey = 'note';
      } else if (this.view === 'hide') {
        segs = this.hideSegments(vertical);
        viewKey = 'hide';
      } else if (this.view === 'fade') {
        segs = fadeSegments(vertical);
        viewKey = 'fade';
      } else if (this.view === 'menu') {
        const state = { anchor, dnd: this.settings.general.dnd, mac: platform === 'macos', reminders: this.running.has('reminders'), faded: s.faded };
        const look = { order: s.menuOrder, iconOnly: s.menuIconOnly, settingsIconOnly: s.menuSettingsIconOnly };
        segs = menuSegments(s.menu, state, look);
        viewKey = 'menu';
        // The menu pill is only as long as the items the user keeps in it.
        const main = menuMain(s.menu, state, { max: size.main, cross: size.cross, pad, vertical, crossMax }, undefined, look);
        size = vertical ? { ...size, h: main, main } : { ...size, w: main, main };
        inner = main - pad * 2;
      } else if (this.view === 'overflow') {
        segs = this.overflowSegments(choice.visible, statuses, vertical);
        viewKey = 'overflow';
      } else if (!primary) {
        const chips = loneChips.length ? this.secondarySegments(loneChips, statuses, level, now, vertical) : [];
        segs = this.open ? this.homeSegments(now, statuses, vertical).concat(chips) : chips;
        viewKey = this.open ? 'home' : chips.length ? 'chips' : 'idle';
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
      // Quiet on: a small moon at the end of the pill, like the iPhone's Focus icon, so it is never on unnoticed.
      segs = segs.concat(quietMoon(this.settings.general.dnd, viewKey));
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
    // Opening and closing (the menu too) change the pill most: no overshoot for the whole motion,
    // or a few pixels of it visibly settle back. A spring takes the config of every retarget,
    // so it is kept for as long as that motion runs.
    // Out of a grown card, or back into one (the pointer still on the pill), the card carries on in
    // one move (sheet.ts unmorph/remorph) and the pill does not move at all while it can be seen.
    // Opening: it is at once where it will be and what it will show, unseen under the card, which
    // then uncovers it. Closing: it is held as it is till the card has covered it (see below).
    let carryOpen = false;
    let carryBack = false;
    if (this.lastLevel !== null && (level === 'maximum') !== (this.lastLevel === 'maximum')) {
      this.calmUntil = now + CALM_MS;
      const moving = !immediate && !reducedMotion();
      carryOpen = moving && level === 'maximum' && (this.sheet.grown || this.sheet.carrying === 'back');
      carryBack = moving && level !== 'maximum' && morphing && this.sheet.visible && !this.sheet.grown;
      this.carriedUntil = carryOpen ? now + GROW_MS + 60 : 0;
    }
    this.lastLevel = level;
    const motion = pillMotion(travelling, now < this.calmUntil);
    if (carryOpen) this.renderer.release();
    this.renderer.setShell(target, { config: motion.shell, immediate: immediate || carryOpen });
    this.sheet.pillTo = target;
    this.lastAnchor = anchor;
    this.lastOrientation = orient;
    // The bot stays beside where the pill rests, even while the idle pill is tucked away; it goes
    // only while the island moves screens or hides behind a full-screen app.
    const botShown = s.bot && !this.moving && !(fsHide && this.fullscreenOn !== null);
    const botD = bubbleSize(s.size);
    const restPill = pillRect(this.area, anchor, w, h, s.edge);
    // The card is picked now so the bot can step aside when a card grows out of the pill.
    let picked = hidden ? null : this.pickSheet(choice, statuses, now, orient, w);
    // Grown out of the pill, the card covers its chips: it carries them itself.
    if (picked?.view.morph) picked = { ...picked, view: { ...picked.view, blocks: this.withChips(picked.view.blocks, picked.owner, choice, statuses, now) } };
    // Pointed at, it was to grow into a card but there was none: next time the pill widens instead.
    if (morphing && !picked && this.hoverBare === null) {
      this.hoverBare = this.hoverOwner();
      this.schedule();
    }
    const morph = picked?.view.morph ? this.morphRect(restPill, this.sheetWidth(picked.view, orient, w)) : null;
    const botRect = bubbleRect(morph ? union(restPill, morph) : restPill, anchor, botD);
    this.bubble.place(botShown ? botRect : null, { immediate });
    // The Shelf's circle beside the pill is off (Justin: "no extra icon"): what waits on the Shelf
    // shows on its Control Center tile instead.
    const shelf = this.shelf();
    const shelfShown = false;
    if (shelf) this.shelfBubble.show(shelf.files(), shelf.canUndo(now));
    this.shelfBubble.place(shelfShown ? shelfRect(union(restPill, target), anchor, botD) : null, anchor, this.area);
    // The bot's chat: Local AI answers, in the bar under the bot; the island itself stays as it is.
    const chatView = botShown ? (this.running.get('local')?.chat?.() ?? null) : null;
    if (!chatView) this.chatOpen = false;
    this.chat.place(anchor, this.chatOpen ? chatBarRect(anchor, botRect, restPill) : null, { immediate });
    if (chatView && this.chatOpen) this.chat.render(chatView);
    this.syncPet(now, chatView);

    // Closing back into a grown card: the pill bar stays as it is, shape and content, while the card
    // comes back over it, and is the resting pill only once covered.
    if (carryBack && picked?.view.morph) this.renderer.hold(GROW_MS + 40);
    const swap = primary !== this.lastPrimary || viewKey !== this.lastViewKey || reshaped;
    const sig = `${orient}|${viewKey}|${w}|${h}|${signature(placed)}`;
    const bump = this.pendingBump;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.renderer.render(placed, w, h, { swap: swap && this.lastPrimary !== undefined, immediate, move: motion.content, carried: now < this.carriedUntil });
    }
    this.lastPrimary = primary;
    this.lastViewKey = viewKey;

    if (this.pendingBump && !hidden) {
      this.pendingBump = false;
      this.renderer.bump();
    }
    this.composeSheet(picked, orient, w, immediate);
    // The pill rests under a chat's grown card (see underCard): compose once more when that changes.
    if (this.sheet.grown && (!morphing || this.raisedCard) !== underCard) this.schedule();
    const beam: ActivityStatus['beam'] = this.fileDrag ? { tone: 'accent', motion: 'pulse' } : pillBeam(primary, [...choice.visible, ...this.settings.activities.order], statuses);
    this.syncGlow(hidden ? null : beam, !hidden && choice.urgent && this.sheet.visible, morph !== null || this.sheet.covering);
    // Smart fade: faded while the pointer is away, except while something pops up (a surfaced event,
    // an urgent card, a card still showing after the pointer left) or the island is in use.
    const popUp = Boolean(surf) || urgentNow || Boolean(note) || Boolean(this.fileDrag) || (this.sheet.visible && !this.hover);
    this.syncSmart(s.smartFade && !popUp && !this.open && this.view === 'main' && !this.inputActive && !this.sheetEngaged);
    // Every frame is kept for phones, whether or not Duplicate copies run.
    this.lastFrame = {
      sig, swap, bump: bump && !hiddenEverywhere, placed, w, h, orient, anchor, edge: s.edge,
      hidden: hiddenEverywhere, fsHide, fullscreen: this.fullscreenAny,
      glow: beamSpec(beam), speed: s.glow,
      bot: botShown ? { d: botD } : null,
      accent: accentColor(s), color: s.color, glass: s.glass, reduce: s.reduceMotion === 'on' || (s.reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    };
    this.sendMirror(this.lastFrame);
    this.pillInput = placed.some((p) => p.seg.t === 'input');
    this.syncInput();
    this.publishHit(this.renderer.rect, true, hidden ? this.wakeStrip(w) : null);
    this.updateTray(statuses);
    if (Date.now() < this.appSubscribedUntil) this.pushAppState(statuses, level, primary);
    this.hub?.tick();
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

  /**
   * Hovering Land's icon (or Land itself on the pill): Rust holds Ctrl+V for Island meanwhile, and a
   * press opens Land with what was copied (`land-paste`). It lets go the moment the pointer leaves.
   */
  private syncPasteArm(): void {
    const key = this.pointerOnPill ? this.hoverKey : null;
    const armed = key !== null && (key === 'chip/land' || key.startsWith('land/')) && this.running.has('land');
    if (armed === this.pasteArmed) return;
    this.pasteArmed = armed;
    void native.pasteArm(armed);
  }

  private secondarySegments(ids: string[], statuses: Map<string, ActivityStatus>, level: Level, now: number, vertical: boolean): Seg[] {
    const out: Seg[] = [];
    const compact = level === 'compact';
    // Chip-only ones (Land's icon) always come, last in the row, and outrank the other chips:
    // when room runs out, the others fold into "+N" first.
    const only = (id: string) => statuses.get(id)?.chipOnly === true;
    const shown = [...ids.filter((id) => !only(id)).slice(0, compact ? 2 : 8), ...ids.filter(only)];
    shown.forEach((id, i) => {
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
      const prio = only(id) ? 5 : (compact ? 8 : 6) + i;
      if (compact) {
        const tip = statuses.get(id)?.summary ?? meta.name;
        // A chip that keeps its label (a number) shows just that, in place of the icon.
        if (view?.keepLabel && view.label) out.push({ t: 'text', key: `chip/${id}`, text: view.label, tone: view.tone ?? 'muted', size: 'sm', weight: 'semibold', side: 'end', prio, tip });
        else out.push({ t: 'icon', key: `chip/${id}`, icon: view?.icon ?? meta.icon, tone: view?.tone ?? 'muted', size: 'sm', side: 'end', prio, tip });
      } else {
        out.push({
          t: 'chip',
          key: `chip/${id}`,
          label,
          icon: view?.icon ?? meta.icon,
          dot: view?.dot,
          pulse: view?.pulse,
          tone: view?.tone,
          // A chip can do something of its own (Land's opens its card); else a click brings it onto the pill.
          action: view?.action ? `act:${id}:${view.action}` : 'island:select',
          arg: view?.action ? undefined : id,
          side: 'end',
          prio,
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
    const quiet = [...statuses.entries()].filter(([id, st]) => st.active && !st.chipOnly && id !== 'quick').length;
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
      { t: 'button', key: 'home/activities', icon: 'pulse', label: 'Activities', action: 'island:app', arg: 'activities', side: 'end', prio: 2, style: 'ghost' },
      { t: 'button', key: 'home/settings', icon: 'settings', action: 'island:app', arg: 'settings', side: 'end', prio: 2, style: 'ghost', tip: 'Settings' },
    );
    return segs;
  }

  /** The pill while choosing how long to hide: back to the menu, and what the card below is for. */
  private hideSegments(vertical: boolean): Seg[] {
    const segs: Seg[] = [
      { t: 'button', key: 'hide/back', icon: 'chevron-left', action: 'island:menu', style: 'ghost', prio: 0, tip: 'Back' },
      { t: 'icon', key: 'hide/icon', icon: 'eye-off', tone: 'muted', prio: 1 },
    ];
    if (!vertical) segs.push({ t: 'text', key: 'hide/text', text: 'Hide the island', weight: 'semibold', prio: 2 });
    return segs;
  }

  /** How long to hide for, each choice with the time the island comes back. */
  private hideSheet(now: number): { owner: string; view: SheetView } {
    const items = HIDE_CHOICES.map((c) => {
      const at = backAt(hideUntil(c.id, now), now);
      return { key: c.id, label: c.label, detail: at ? `Back ${at}` : this.showHint(), action: 'island:hide', arg: c.id };
    });
    return {
      owner: 'island',
      view: {
        key: 'island/hide',
        blocks: [
          { t: 'head', key: 'head', icon: 'eye-off', title: 'Hide the island', sub: 'The pill and the bot leave the screen. Nothing is lost while they are away.' },
          { t: 'choices', key: 'for', items },
        ],
      },
    };
  }

  /** The pill while the island's own note shows (a phone opened a terminal). */
  private noteSegments(note: { text: string; icon: string }, vertical: boolean): Seg[] {
    const segs: Seg[] = [{ t: 'icon', key: 'note/icon', icon: note.icon, tone: 'accent', prio: 0 }];
    if (!vertical) segs.push({ t: 'text', key: 'note/text', text: note.text, weight: 'semibold', prio: 1 });
    return segs;
  }

  /** Says something on the pill for a moment, with a nod (the island's own news, not an activity's). */
  private showNote(text: string, icon: string): void {
    this.note = { text, icon, until: Date.now() + NOTE_MS };
    this.pendingBump = true;
    this.schedule();
    setTimeout(() => this.schedule(), NOTE_MS + 30);
  }

  /**
   * The drop card: the island opens as it does for Control Center, at the grid's size, split in two:
   * the Shelf on the left (the narrower side) and Land on the right. The side under the pointer lights.
   */
  private dropSheet(pillW: number): { owner: string; view: SheetView } {
    const geo = this.gridGeometry(pillW);
    // Short boxes (Moss: "WAY too big"): the grid's width, about one row of tiles tall.
    const height = DROP_ZONE_H;
    const land = this.running.get('land');
    let landOk = false;
    try {
      landOk = Boolean(land?.accepts?.());
    } catch {
      landOk = false;
    }
    const onShelf = this.shelf()?.files().length ?? 0;
    const items: DropZone[] = [
      { key: 'shelf', icon: 'shelf', title: 'Shelf', sub: onShelf ? `Keep them with the ${onShelf === 1 ? 'file' : `${onShelf} files`} there` : 'Keep them here for later', grow: 1 },
      { key: 'land', icon: 'land', title: 'Land', sub: landOk ? 'Send them to a computer or phone nearby' : land ? 'Land is starting' : 'Land is off', grow: 1, off: !landOk },
    ];
    return { owner: 'island', view: { key: 'island/drop', wide: true, width: geo.width, blocks: [{ t: 'zones', key: 'zones', height, hot: this.fileDrag?.hot ?? null, items }] } };
  }

  /** The Shelf (built in, so always running unless Island is starting or stopping). */
  private shelf(): ShelfActivity | null {
    const s = this.running.get('shelf');
    return s instanceof ShelfActivity ? s : null;
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
  private composeSheet(picked: { owner: string; view: SheetView } | null, orient: Orientation, pillW: number, immediate: boolean): void {
    // A different card: whatever was typed into the old one is gone, and so is the keyboard.
    if (this.sheetEngaged && (!picked || picked.view.key !== this.sheet.key)) this.sheetEngaged = false;
    this.sheetOwner = picked?.owner ?? null;
    const width = picked ? this.sheetWidth(picked.view, orient, pillW) : 0;
    this.sheet.show(picked?.view ?? null, { anchor: this.settings.island.anchor, area: this.area, width, immediate });
  }

  private pickSheet(choice: Picked, statuses: Map<string, ActivityStatus>, now: number, orient: Orientation, pillW: number): { owner: string; view: SheetView } | null {
    this.raisedCard = false;
    if (this.view === 'hide' && !this.previewLevel) return this.hideSheet(now);
    if (this.view === 'fade' && !this.previewLevel) {
      const s = this.settings.island;
      return { owner: 'island', view: fadeSheet({ faded: s.faded, peekUntilBack: s.peekUntilBack, smartFade: s.smartFade }) };
    }
    if (this.view !== 'main' || this.previewLevel) return null;
    if (this.open && this.fileDrag?.where === 'island') return this.dropSheet(pillW);
    const vertical = orient === 'vertical';
    const ask = (id: string, reason: SheetEnv['reason']) => this.askSheet(id, reason, now, this.sheetWidth(null, orient, pillW) - 28, vertical, id === choice.primary ? choice.surfaced : null);
    const primary = choice.primary;
    const pStatus = primary ? statuses.get(primary) : undefined;
    // Claude's finished and needs-you cards grow out of the pill like its hover card, when it grows into one.
    const chat = (card: { owner: string; view: SheetView } | null) => card && { ...card, view: chatView(card.owner, this.grows(card.owner), card.view) };
    if (primary && choice.urgent && pStatus?.urgent && !this.dismissedUrgent.has(`${primary}:${pStatus.urgent.key}`)) {
      const card = chat(ask(primary, 'urgent'));
      if (card) {
        this.raisedCard = Boolean(card.view.morph);
        return card;
      }
    }
    if (this.open) {
      // An activity asked for its own card (Land after a drop); its card, or the grid when it has none.
      const own = this.cardFor && this.running.has(this.cardFor) ? ask(this.cardFor, 'open') : null;
      // The Shelf opened by a drop or its circle closes with its x; opened from its tile it has Back too.
      if (own) return this.cardFor === 'shelf' && this.shelfPinned ? own : withBack(own);
      return this.gridSheet(now, orient, pillW);
    }
    if (primary && choice.surfaced) {
      const card = chat(ask(primary, 'surfaced'));
      if (card) {
        this.raisedCard = Boolean(card.view.morph);
        return card;
      }

    }
    if (this.hover) {
      const owner = this.hoverOwner();
      const card = owner ? this.hoverCardOf(owner, ask(owner, 'hover'), now, vertical) : null;
      if (card) return card;
    }
    return null;
  }

  /**
   * How `id` grows when pointed at: its own choice (Activities › Grows), else Settings › When
   * pointed at; Music without its player on hover widens the pill (grow.ts hoverGrows).
   */
  private grows(id: string): Grows {
    const c = this.settings.activities.config[id];
    return hoverGrows(id, growsOf(c, this.settings.island.defaultGrows, id), c?.options);
  }

  /**
   * Pointing at `id` grows a card out of the pill: it grows into one and has a card to show (its own,
   * or its Control Center tile's). Asked before the card is picked, so the pill under it can rest.
   */
  private growsCard(id: string | null): boolean {
    const grows = id ? this.grows(id) : null;
    if (!id || id === this.hoverBare || (grows !== 'card' && grows !== 'more')) return false;
    const act = this.running.get(id);
    return Boolean(act?.sheet || act?.tile);
  }

  /**
   * The hover card by how the activity grows (grow.ts hoverView): its own card grown out of the
   * pill, or else one made from its Control Center tile; hanging below; or, for Sideways, only an
   * own card that can hang below.
   */
  private hoverCardOf(id: string, own: { owner: string; view: SheetView } | null, now: number, vertical: boolean): { owner: string; view: SheetView } | null {
    const view = hoverView(this.grows(id), own?.view ?? null, () => this.tileCardOf(id, now, vertical));
    return view ? { owner: id, view } : null;
  }

  /** A card made from an activity's Control Center tile, for one with no hover card of its own. */
  private tileCardOf(id: string, now: number, vertical: boolean): SheetView | null {
    const act = this.running.get(id);
    if (!act?.tile) return null;
    const interactive = this.settings.activities.config[id]?.interactive ?? true;
    try {
      const tile = act.tile({ reason: 'hover', now, width: 320, vertical, interactive, surfaced: null });
      if (!tile) return null;
      const meta = CATALOG_BY_ID.get(id) ?? act.meta;
      return { key: `${id}/tile-card`, blocks: mapActions(tileCard(tile, meta.name, meta.icon), (a) => this.nsAction(id, a)) };
    } catch (err) {
      console.error(`tile card ${id}`, err);
      return null;
    }
  }

  /**
   * A card grown out of the pill covers it, chips and all: it carries them itself, so the other
   * activities and "+N" stay one click away. Its top row takes them: a player's, else its heading.
   */
  private withChips(blocks: Block[], owner: string, choice: Picked, statuses: Map<string, ActivityStatus>, now: number): Block[] {
    if (!this.settings.island.showSecondary) return blocks;
    // Everything but the card's own activity: pointing at a chip shows that chip's card, and then
    // the pill's own activity is one of the others.
    const others = choice.visible.filter((id) => id !== owner);
    // Two of the others, plus Land's icon (chip-only), which always comes, as on the pill.
    const { shown, folded } = cardChips(others, (id) => statuses.get(id)?.chipOnly === true, 2);
    const chips: SheetChip[] = [];
    for (const seg of this.secondarySegments(shown, statuses, 'expanded', now, true)) {
      if (seg.t !== 'chip' || !seg.action) continue;
      chips.push({ key: seg.key, icon: seg.icon, dot: seg.dot, pulse: seg.pulse, tone: seg.tone, action: seg.action, arg: seg.arg, tip: seg.tip });
    }
    if (folded > 0) chips.push({ key: 'island/more', icon: 'more', label: `+${folded}`, action: 'island:overflow', tip: 'More activities' });
    if (!chips.length) return blocks;
    const at = blocks.findIndex((b) => b.t === 'player');
    const i = at >= 0 ? at : blocks.findIndex((b) => b.t === 'head');
    if (i < 0) return blocks;
    return blocks.map((b, j) => (j === i && (b.t === 'player' || b.t === 'head') ? { ...b, chips } : b));
  }

  /** An activity's card for `reason`, its actions named for it; for this screen and for phones alike. */
  private askSheet(id: string, reason: SheetEnv['reason'], now: number, width: number, vertical: boolean, surfaced: string | null): { owner: string; view: SheetView } | null {
    const act = this.running.get(id);
    if (!act?.sheet) return null;
    const interactive = this.settings.activities.config[id]?.interactive ?? true;
    const env: SheetEnv = { reason, now, width, vertical, interactive, surfaced };
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
  }

  /**
   * Whose card a hover shows: the activity under the pointer when it claims its hover (Music's
   * player, Phone's list), else Claude's stats when Settings › Hover card says so, else whatever
   * is pointed at.
   */
  private hoverOwner(key = this.hoverKey): string | null {
    const pointed = this.ownerOf(key);
    if (pointed && this.claims(pointed)) return pointed;
    if (this.settings.island.hoverCard === 'claude' && this.running.has('claude')) return 'claude';
    return pointed;
  }

  private claims(id: string | null): boolean | 'morph' {
    if (!id) return false;
    try {
      return this.running.get(id)?.claimsHover?.() ?? false;
    } catch {
      return false;
    }
  }

  /** Where a card that grows out of the pill sits: over the pill, centred on it, `w` wide. */
  private morphRect(pill: Rect, w: number): Rect {
    const W = this.area.width;
    const x = Math.max(8, Math.min(W - w - 8, pill.x + pill.w / 2 - w / 2));
    return { x, y: pill.y, w, h: pill.h };
  }

  /**
   * The grid is as wide as the open island, so it looks like it belongs to it,
   * and everything in it scales with the island's size setting. It is always
   * four cells across and four down per page.
   */
  private gridGeometry(pillW: number): { cols: number; rows: number; cell: number; width: number } {
    const scale = SIZE_SCALE[this.settings.island.size] ?? 1;
    const want = Math.max(460, Math.min(pillW, 760)) * scale;
    const width = Math.round(Math.min(this.area.width - 32, Math.max(GRID_MIN_W, want)));
    return { cols: GRID_COLS, rows: GRID_ROWS, cell: gridCell(width, CELL_PX[this.settings.island.size] ?? CELL_PX.medium), width };
  }

  /** Control Center: one tile per switched-on activity, in the user's order. */
  private gridSheet(now: number, orient: Orientation, pillW: number): { owner: string; view: SheetView } | null {
    const geo = this.gridGeometry(pillW);
    const tiles = this.gridTiles(now, geo.width, orient === 'vertical');
    if (!tiles.length) return null;
    return { owner: 'island', view: { key: 'island/grid', wide: true, width: geo.width, blocks: this.arrange(tiles, geo) } };
  }

  /** Every Control Center tile for a grid `width` wide: the island's day, then one per activity, actions named for it. */
  private gridTiles(now: number, width: number, vertical: boolean): Tile[] {
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
    for (const id of this.settings.activities.order) {
      const act = this.running.get(id);
      if (!act?.tile && !act?.tiles) continue;
      const interactive = this.settings.activities.config[id]?.interactive ?? true;
      const env: SheetEnv = { reason: 'open', now, width: width - 28, vertical, interactive, surfaced: null };
      try {
        const own = act.tiles ? act.tiles(env) : [act.tile?.(env) ?? null];
        for (const tile of own) {
          if (!tile) continue;
          // Wrapped in a throwaway grid only so the tile's actions get the activity's name.
          const [mapped] = mapActions([{ t: 'tiles', key: 'one', items: [tile], cols: 1, rows: 1, pages: 1, cell: 0 }], (a) => this.nsAction(id, a));
          if (mapped.t === 'tiles') tiles.push({ ...mapped.items[0], key: `${id}/${tile.key}` });
          this.lastTiles.set(`${id}/${tile.key}`, tile.body.k);
        }
      } catch (err) {
        console.error(`tile ${id}`, err);
      }
    }
    for (const t of tiles) this.rememberShape(t);
    // A tile the user placed keeps its place: while its activity has nothing to show, it rests
    // there (its name, dimmed) at its usual size instead of leaving a gap the others fill.
    const present = new Set(tiles.map((t) => t.key));
    const layout = this.settings.island.grid;
    // The user's pages (the older single order list only before they ever arranged).
    const placed = layout.pages.length ? layout.pages.flat() : layout.order;
    for (const key of placed) {
      if (!key || present.has(key)) continue;
      const act = this.running.get(key.split('/')[0]);
      if (!act || (!act.tile && !act.tiles)) continue;
      present.add(key);
      tiles.push(restingTile(key, act.meta.name, act.meta.icon, this.tileShapes[key], NARROW_OK));
    }
    return tiles;
  }

  /** Each tile's own size and kind, kept (also across restarts) for its resting stand-in. */
  private tileShapes: Record<string, TileShape> = loadShapes();

  private rememberShape(t: Tile): void {
    const shape: TileShape = { span: t.span ?? 1, rows: t.rows ?? 1, kind: t.body.k };
    const was = this.tileShapes[t.key];
    if (was && was.span === shape.span && was.rows === shape.rows && was.kind === shape.kind) return;
    this.tileShapes[t.key] = shape;
    saveShapes(this.tileShapes);
  }

  /**
   * The user's grid: their pages and their sizes (src/core/grid.ts). Tiles they took
   * off the grid wait in the tray while editing. While a tile is dragged or resized,
   * the grid shows the layout it would get if let go now. `live` false (a phone's copy)
   * never arranges and leaves this screen's drag alone.
   */
  private arrange(natural: Tile[], geo: { cols: number; rows: number; cell: number }, live = true): SheetView['blocks'] {
    const layout = this.settings.island.grid;
    const drag = live ? this.gridDrag : null;
    const editing = live && this.gridEditing;
    const sized = natural.map((t) => {
      const narrow = NARROW_OK.has(t.body.k) || t.body.k === 'lyrics';
      const [sw, sh] = cellsOf(t, layout.sizes[t.key]);
      // Lists, cards and players need two columns whatever was asked for.
      let w = Math.min(geo.cols, narrow ? sw : Math.max(2, sw));
      // A month (Calendar) needs two rows, whatever size its week was given.
      const tall = t.body.k === 'month' ? Math.min(2, geo.rows) : 1;
      let h = Math.max(tall, Math.min(geo.rows, sh));
      if (drag?.key === t.key) ({ w, h } = drag.size);
      h = Math.max(tall, h);
      const sizes = sizesOfKind(t.body.k).map((x): [number, number] => [CELLS[x].w, CELLS[x].h]).filter(([, y]) => y >= tall);
      return { ...t, w, h, sizes };
    });

    const isHidden = hiddenTest(layout.hidden);
    const shown = sized.filter((t) => !isHidden(t.key));
    const dims = new Map(shown.map((t) => [t.key, { w: t.w, h: t.h }]));
    const dimsOf: GridDims = (k) => dims.get(k) ?? null;
    const saved = drag?.preview ?? (layout.pages.length ? layout.pages : layout.order.length ? [layout.order] : []);
    const { pages, slots } = settle(withNew(saved, shown.map((t) => t.key), dimsOf, layout.pages.length > 0), dimsOf, geo.cols, geo.rows);
    if (live) {
      this.gridPages = pages;
      this.gridSlots = slots;
    }
    const where = new Map(slots.map((slot) => [slot.key, slot]));
    const items: Tile[] = shown.flatMap((t) => {
      const slot = where.get(t.key);
      return slot ? [{ ...t, page: slot.page, col: slot.col, row: slot.row, w: slot.w, h: slot.h }] : [];
    });
    // A phone always gets the tray, to arrange from its own copy (the hub never lets it press these).
    // A phone's copy keeps each tray tile's sizes: put back there, it may be resized before Done.
    const tray: Tile[] = editing || !live ? sized.filter((t) => isHidden(t.key)).map((t) => ({ ...t, w: 1, h: 1, hidden: true, sizes: live ? undefined : t.sizes })) : [];
    // The card is only as tall as the rows the tiles reach; editing opens every row to drag into.
    const rows = editing ? geo.rows : rowsUsed(slots);

    const blocks: SheetView['blocks'] = [
      { t: 'tiles', key: 'grid', items, tray, cols: geo.cols, rows, cell: geo.cell, pages: pageCount(slots), editing },
    ];
    if (editing) {
      blocks.push({
        t: 'buttons',
        key: 'grid-edit',
        items: [
          { key: 'reset', label: 'Reset layout', icon: 'refresh', action: 'island:grid-reset', style: 'ghost', tip: 'Back to how it was before you changed it' },
          { key: 'done', label: 'Done', icon: 'check', action: 'island:grid-done', style: 'primary' },
        ],
      });
    }
    return blocks;
  }

  /** Sizes a tile may take: lists, cards and players need the width of two cells. */
  private sizesFor(key: string): TileSize[] {
    return sizesOfKind(this.lastTiles.get(key) ?? '');
  }

  private lastTiles = new Map<string, string>();

  /** Tile keys worth keeping in the saved layout: on the grid now, or from an activity that still exists. */
  private keepKey(key: string, present: Map<string, unknown>): boolean {
    const id = key.split('/')[0];
    return present.has(key) || id === 'island' || CATALOG_BY_ID.has(id) || this.running.has(id);
  }

  private gridAction(action: string, arg: unknown): void {
    const grid = this.settings.island.grid;
    const key = typeof arg === 'string' ? arg : '';
    switch (action) {
      case 'island:grid-edit':
        if (!this.gridEditing) this.gridBefore = structuredClone(grid);
        this.gridEditing = true;
        this.open = true;
        return;
      case 'island:grid-done':
        this.gridEditing = false;
        this.gridDrag = null;
        this.gridBefore = null;
        return;
      case 'island:grid-reset':
        // Back to how it was before this edit; editing goes on.
        this.gridDrag = null;
        this.settings.island.grid = this.gridBefore ? structuredClone(this.gridBefore) : { order: [], sizes: {}, hidden: [], pages: [] };
        break;
      case 'island:grid-hide':
        if (key && !grid.hidden.includes(key)) grid.hidden.push(key);
        break;
      case 'island:grid-show':
        grid.hidden = unhide(grid.hidden, key);
        break;
      case 'island:grid-lift': {
        // A drag or resize begins. Every preview is worked out from the grid as it is
        // now, so dragging back over a spot always gives the same layout.
        const slot = this.gridSlots.find((x) => x.key === key);
        if (!slot) return;
        this.gridDrag = {
          key,
          snap: this.gridPages.map((p) => [...p]),
          dims: new Map(this.gridSlots.map((x) => [x.key, { w: x.w, h: x.h }])),
          size: { w: slot.w, h: slot.h },
          preview: null,
        };
        // The card's hit area reaches past its edges while a tile is held.
        this.publishHit(this.renderer.rect, true);
        return;
      }
      case 'island:grid-move': {
        // Live: the grid shows where everything goes if the tile is let go here.
        const drag = this.gridDrag;
        const a = (arg ?? {}) as { key?: unknown; page?: unknown; col?: unknown; row?: unknown; w?: unknown; h?: unknown };
        if (!drag || a.key !== drag.key || typeof a.page !== 'number' || typeof a.col !== 'number' || typeof a.row !== 'number') return;
        if (typeof a.w === 'number' && typeof a.h === 'number' && a.w <= GRID_COLS && a.h <= 4 && this.sizesFor(drag.key).includes(sizeOf(a.w, a.h))) {
          drag.size = { w: a.w, h: a.h };
        }
        const at = { page: a.page, col: a.col, row: a.row };
        drag.preview = moveTile(drag.snap, drag.key, at, drag.size, (k) => drag.dims.get(k) ?? null, GRID_COLS, GRID_ROWS).pages;
        return;
      }
      case 'island:grid-drop': {
        const drag = this.gridDrag;
        this.gridDrag = null;
        this.publishHit(this.renderer.rect, true);
        if (!drag?.preview || drag.key !== key) return;
        grid.pages = drag.preview.map((p) => p.filter((e) => e === null || this.keepKey(e, drag.dims))).filter((p) => p.length > 0);
        const was = drag.dims.get(drag.key);
        if (was && (was.w !== drag.size.w || was.h !== drag.size.h)) grid.sizes[drag.key] = sizeOf(drag.size.w, drag.size.h);
        break;
      }
      case 'island:grid-cancel':
        this.gridDrag = null;
        this.publishHit(this.renderer.rect, true);
        return;
    }
    this.saveSettings();
  }

  private sheetWidth(view: SheetView | null, orient: Orientation, pillW: number): number {
    const W = this.area.width;
    if (view?.width) return Math.min(view.width, W - 24);
    // Music's player: as wide as an iPhone's against the island's size, and never narrower than the pill it covers.
    if (view?.morph) return Math.min(W - 24, Math.max(pillW, Math.round(MORPH_W * (SIZE_SCALE[this.settings.island.size] ?? 1))));
    if (orient === 'vertical') return Math.min(W - 120, view?.wide ? 440 : 380);
    const want = view?.wide ? Math.max(460, Math.min(pillW, 760)) : Math.max(340, Math.min(pillW, 560));
    return Math.min(want, W - 32);
  }

  /**
   * The border glow: the primary activity asks for it in its status (orbit while
   * busy, pulse when something waits on the user, progress while filling up); an
   * urgent card gets a slow orbit in the same tone.
   */
  private syncGlow(want: ActivityStatus['beam'], cardUrgent: boolean, grown = false): void {
    const speed = this.settings.island.glow;
    if (speed === 'off') {
      this.pillGlow.set(null);
      this.cardGlow.set(null);
      this.grownGlow.set(null);
      return;
    }
    this.pillGlow.setSpeed(speed);
    this.cardGlow.setSpeed(speed);
    this.grownGlow.setSpeed(speed);
    // A still glow (Claude's reply hold) keeps the card still too.
    const urgent: GlowSpec = { tone: want?.tone ?? 'accent', motion: want?.motion === 'still' ? 'still' : 'orbit' };
    // A card grown out of the pill covers it: the light runs round the card's edge, not across its
    // text, also while it shrinks back, until it lands. The pill's is cut at once: fading, its ring
    // would show through the card as it grows.
    this.pillGlow.set(grown ? null : beamSpec(want), grown);
    this.grownGlow.set(grown ? (cardUrgent ? urgent : beamSpec(want)) : null);
    this.cardGlow.set(cardUrgent && !grown ? urgent : null);
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
    const has = this.pillInput || this.sheetEngaged || this.chatOpen;
    const target = () => (this.chatOpen ? this.chat.input : this.pillInput ? this.renderer.focusedInput() : this.sheet.focusedInput());
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
    const bot = this.bubble?.hitRect;
    if (bot) rects.push(bot);
    const shelf = this.shelfBubble?.hitRect;
    if (shelf) rects.push(shelf);
    if (this.chat) rects.push(...this.chat.hitRects());
    const hiddenNow = this.renderer.targetRect.y < 0 || this.renderer.targetRect.x < 0 || this.renderer.targetRect.y > this.area.height || this.renderer.targetRect.x > this.area.width;
    void native.setHit(hiddenNow && strip ? [strip, ...(bot ? [bot] : [])] : rects);
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
    // The Shelf just took files: it stays open until the pill or its x is clicked.
    if (this.shelfPinned && this.open && this.cardFor === 'shelf' && !this.fileDrag) return;
    const cancel = this.inputActive ? this.findInputCancel() : null;
    if (cancel) this.handleAction(cancel, null, this.renderer.pill);
    clearTimeout(this.hoverTimer);
    this.hover = false;
    this.hoverKey = null;
    this.sheetEngaged = false;
    this.gridEditing = false;
    this.gridDrag = null;
    this.gridBefore = null;
    this.open = false;
    this.cardFor = null;
    this.fileDrag = null;
    this.view = 'main';
    // What the user picked stays on the pill; what an activity opened for itself goes.
    if (!this.pickedAt) this.selected = null;
    this.surfaces = [];
    this.chatOpen = false;
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
      void this.runAct(action, arg);
      return;
    }
    switch (action) {
      case 'island:tap':
        if (this.view !== 'main') this.view = 'main';
        else if (!this.inputActive) this.open = !this.open;
        break;
      case 'island:hide-menu':
        this.view = 'hide';
        this.open = false;
        break;
      case 'island:hide':
        if (HIDE_CHOICES.some((c) => c.id === arg)) this.hide(arg as HideChoice);
        return;
      case 'island:fade':
        // Fade and Show are the same button.
        this.setFaded(!this.settings.island.faded);
        break;
      case 'island:pointer-hold':
        // A drag on the card began or ended (sheet.ts pointerHeld): its hit area is the whole screen
        // while it lasts. Let go off the card, the pointer has left it.
        this.publishHit(this.renderer.rect, true);
        if (!arg && !this.sheet.pointerInside()) this.setHover(false);
        return;
      case 'island:fade-menu':
        // The menu's Fade, opened: fade now, and the two ways it fades on its own (fade-menu.ts).
        this.view = 'fade';
        this.open = false;
        break;
      case 'island:peek-lasts': {
        const back = arg === 'back';
        if (this.settings.island.peekUntilBack !== back) {
          this.settings.island.peekUntilBack = back;
          this.saveSettings();
          void native.setPeek(this.settings.island.peekThrough, back);
        }
        break;
      }
      case 'island:smart-fade': {
        // On or Off from the Fade card (a bare press switches it).
        const on = typeof arg === 'boolean' ? arg : !this.settings.island.smartFade;
        if (this.settings.island.smartFade !== on) {
          this.settings.island.smartFade = on;
          this.saveSettings();
        }
        break;
      }
      case 'island:menu':
        this.view = this.view === 'menu' ? 'main' : 'menu';
        break;
      case 'island:reminders':
        // The menu's Reminders: the island opens on its card, at the top of the list.
        this.view = 'main';
        void this.runAct('act:reminders:card', null);
        return;
      case 'island:hover':
      case 'island:sheet-hover':
        if (action === 'island:hover') {
          this.pointerOnPill = Boolean(arg);
          this.syncPasteArm();
        }
        this.setHover(Boolean(arg));
        return;
      case 'island:hover-key': {
        const key = typeof arg === 'string' ? arg : null;
        const moved = this.ownerOf(key) !== this.ownerOf(this.hoverKey);
        this.hoverKey = key;
        this.syncPasteArm();
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
      case 'island:grid-lift':
      case 'island:grid-move':
      case 'island:grid-drop':
      case 'island:grid-cancel':
        this.gridAction(action, arg);
        break;
      case 'island:wheel': {
        const dir = this.wheel.step(Number(arg) || 0, performance.now());
        if (!dir) return;
        this.cycle(dir);
        break;
      }
      case 'island:select':
        // A chip-only activity (Land's icon, picked from the overflow list) never keeps the pill at rest.
        this.pick(String(arg), this.statuses().get(String(arg))?.chipOnly ? 0 : Date.now());
        this.view = 'main';
        // The card follows the pick, not the segment the pointer last crossed (a grown card hides the pill's).
        this.hoverKey = `chip/${String(arg)}`;
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
      case 'island:bot': {
        // Talking to the bot is Local AI's chat, in the bar under the bot (Moss: the island does not open).
        const local = this.running.get('local');
        if (!local?.chat) {
          void native.openApp('activities');
          break;
        }
        this.chatOpen = !this.chatOpen;
        if (this.chatOpen) Promise.resolve(local.action?.('ask', null)).catch((err) => native.log(`bot chat failed: ${String(err)}`));
        break;
      }
      case 'island:cancel-input':
        this.open = false;
        break;
      case 'island:card-close':
        this.cardFor = null;
        break;
      case 'island:shelf-close':
        this.open = false;
        this.shelfPinned = false;
        break;
      default:
        break;
    }
    this.schedule();
  }

  /** `act:<activity>:<name>` goes to that activity; the promise settles when it is done with it. `phone`: a PhoneError rejects it, for the hub to show. */
  private runAct(action: string, arg: unknown, phone = false): Promise<void> {
    const rest = action.slice(4);
    const i = rest.indexOf(':');
    const id = rest.slice(0, i);
    const name = rest.slice(i + 1);
    const act = this.running.get(id);
    const done = act?.action
      ? Promise.resolve(act.action(name, arg)).catch((err) => {
          if (phone && err instanceof PhoneError) throw err;
          native.log(`action ${id}:${name} failed: ${String(err)}`);
        })
      : Promise.resolve();
    this.schedule();
    return done.then(() => undefined);
  }

  // ---------------------------------------------------------------- Island on your phone

  /** What the hub (src/remote/hub.ts) asks of the island. */
  private phoneHooks(): PhoneIslandHooks {
    return {
      pill: () => (this.lastFrame ? { frame: this.lastFrame, bot: this.lastFrame.bot ? this.botNow : null } : null),
      view: (nav, width) => this.phoneView(nav, width),
      act: (phone, action, arg) => this.phoneAction(phone, action, arg),
      setGrid: (l) => {
        // Reset layout on the phone: as on this screen (gridAction 'island:grid-reset').
        if (l.reset) {
          this.settings.island.grid = { order: [], sizes: {}, hidden: [], pages: [] };
          this.saveSettings();
          return;
        }
        // The phone's pages (or its tiles in order, flowed onto pages as the grid fits them) and
        // the sizes it changed; tiles it wasn't shown (an activity off now) stay hidden as they were.
        // An activity hidden whole ('sound') is hidden tile by tile now: the phone saw each of its tiles.
        const grid = this.settings.island.grid;
        const touched = new Set([...l.order, ...l.hidden]);
        const touchedIds = new Set([...touched].map((k) => k.split('/')[0]));
        grid.hidden = [...grid.hidden.filter((k) => !touched.has(k) && !(!k.includes('/') && touchedIds.has(k))), ...l.hidden];
        grid.pages = l.pages ?? [l.order];
        for (const [k, size] of Object.entries(l.sizes ?? {})) grid.sizes[k] = size;
        this.saveSettings();
      },
      facts: () => ({
        name: this.computerName(),
        platform,
        version: __APP_VERSION__,
        // With Windows Hello asked before Allow, a phone can't pass it: no Allow from phones.
        allow: this.settings?.activities.config.claude?.options.requireHello !== true,
        // Nor terminals then; otherwise as Settings › Your phone says.
        term: this.settings ? termAllowed(this.settings) : false,
        screen: this.screen,
        folders: this.recentFolders(),
        power: platform === 'windows',
      }),
      guarded: () => (['claude', 'codex', 'cursor', 'antigravity'] as const).filter((id) => this.settings?.activities.config[id]?.options.requireHello === true).map((id) => `act:${id}:allow`),
      fromPhone: (item) => this.fromPhone(item),
      prefs: () => (this.settings ? prefsOf(this.settings) : null),
      // The phone's Activities and Settings screens: only the allow-list in src/remote/prefs.ts.
      setPref: (key, value) => {
        if (!this.settings) return false;
        const next = structuredClone(this.settings);
        if (!applyPref(next, key, value)) return false;
        this.applySettings(next);
        this.saveSettings();
        return true;
      },
    };
  }

  /** Where Claude chats ran, newest first: a phone's terminal opens in one of these. */
  private recentFolders(): string[] {
    const claude = this.running.get('claude') as (Activity & { recentFolders?(max: number): string[] }) | undefined;
    try {
      return claude?.recentFolders?.(HELLO_FOLDERS) ?? [];
    } catch {
      return [];
    }
  }

  /** Chrome Remote Desktop's state, for hello: a change sends phones a fresh one. */
  private async pollScreen(): Promise<void> {
    const state = await native.screenState();
    if (state === this.screen) return;
    this.screen = state;
    this.hub?.syncHello();
  }

  /** A phone opened a terminal on this PC: the island says so for a moment, the way Land shows an arrival. */
  private onTermOpened(e: TermOpened | null): void {
    if (!e || typeof e.phone !== 'string' || !e.phone) return;
    const who = (typeof e.name === 'string' && e.name) || this.hub?.phoneName(e.phone) || 'Your phone';
    native.log(`terminal opened from ${who}: ${String(e.title ?? e.id ?? '')}`);
    this.showNote(`${who} opened a terminal`, 'terminal');
  }

  /**
   * What a phone shows under its pill: an urgent card first (the one this screen shows for it),
   * else what it asked for: Control Center packed for its width, or an activity's own card (its
   * hover card when it has no other, Control Center when it has neither), or nothing.
   */
  private phoneView(nav: Nav, width: number): { nav: Nav; view: SheetView | null; urgent: string | null } {
    if (!this.settings) return { nav, view: null, urgent: null };
    const now = Date.now();
    // A phone draws every card under its pill: none grows out of it there.
    const card = (id: string, reason: SheetEnv['reason']) => {
      const got = this.askSheet(id, reason, now, width - 28, false, null);
      return got ? flatView(got.view) : null;
    };
    for (const id of urgentIds(this.settings.activities.order, this.statuses(), this.dismissedUrgent)) {
      const view = card(id, 'urgent');
      if (view) return { nav, view, urgent: id };
    }
    if (nav.open === 'none') return { nav, view: null, urgent: null };
    if (nav.open === 'hover') return { nav, view: this.phoneHover(nav.key, now, width), urgent: null };
    if (nav.open === 'card') {
      const view = card(nav.id, 'open') ?? card(nav.id, 'hover');
      if (view) return { nav, view, urgent: null };
    }
    return { nav: { open: 'grid' }, view: this.phoneGrid(now, width), urgent: null };
  }

  /**
   * The pill held on a phone: the card pointing at `key` shows here (Settings › Hover card counted),
   * grown out of the pill whatever the activity's Grows (grow.ts phoneHoverView). Null: that
   * activity has no card of either kind.
   */
  private phoneHover(key: string | null, now: number, width: number): SheetView | null {
    const cardOf = (owner: string) => phoneHoverView(this.askSheet(owner, 'hover', now, width - 28, false, null)?.view ?? null, () => this.tileCardOf(owner, now, false));
    const swipe = readSwipe(key);
    if (!swipe) {
      const owner = this.hoverOwner(key);
      return owner ? cardOf(owner) : null;
    }
    // Swiped across the held card: the activity that many along, in the order scrolling the pill
    // steps through, past any with no card to show.
    const ids = this.visibleIds;
    const start = this.hoverOwner(swipe.base);
    const i = ids.indexOf(start ?? '');
    if (i < 0 || !ids.length) return start ? cardOf(start) : null;
    const dir = Math.sign(swipe.steps) || 1;
    const n = ids.length;
    for (let k = 0; k < n; k++) {
      const owner = ids[(((i + swipe.steps + dir * k) % n) + n) % n];
      const view = cardOf(owner);
      if (view) return view;
    }
    return null;
  }

  /** Control Center on a phone: four columns across its card, the user's pages and sizes, never arranging. */
  private phoneGrid(now: number, width: number): SheetView {
    // Rows as tall as a small island's, or square cells when the columns come out wider.
    const col = (width - GRID_PAD * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
    const geo = { cols: GRID_COLS, rows: GRID_ROWS, cell: Math.round(Math.min(CELL_PX.large, Math.max(CELL_PX.small, col))) };
    return { key: 'island/grid', wide: true, width, blocks: this.arrange(this.gridTiles(now, width, false), geo, false) };
  }

  /**
   * A phone's tap the hub allowed, run as a click here; a card its activity opens meanwhile opens
   * on that phone, and what it says went wrong for the phone (a PhoneError) shows there.
   */
  private async phoneAction(phone: string, action: string, arg: unknown): Promise<void> {
    if (action.startsWith('act:')) return this.phoneActs.run(action.slice(4).split(':')[0], phone, () => this.runAct(action, arg, true));
    if (PHONE_ISLAND_ACTIONS.includes(action)) this.handleAction(action, arg, this.renderer.pill);
  }

  /** What this computer is called: the name Land gives it (what computers nearby see), else the system's name. */
  private computerName(): string {
    const land = this.running.get('land') as (Activity & { computerName?(): string | null }) | undefined;
    return land?.computerName?.() || this.systemName || (platform === 'macos' ? 'Mac' : 'PC');
  }

  /** The computer's own name (remote_name), asked once at boot for when Land is off. */
  private systemName = '';

  /** Text or a file from a phone: Land shows it like what another computer sent; without Land, a notification. */
  private fromPhone(item: PhoneDelivery): void {
    const land = this.running.get('land') as (Activity & { fromPhone?(item: PhoneDelivery): void }) | undefined;
    if (land?.fromPhone) land.fromPhone(item);
    else if (this.settings.general.notifications) void native.notify(`From ${item.from}`, item.kind === 'text' ? clip(item.text, 200) : `${item.name} is in Downloads.`);
  }

  // ---------------------------------------------------------------- files dropped on the island

  /**
   * Files dragged onto the island. While they hover, the pill says which activity takes them
   * (Land); a drop hands them over and opens the island on that activity's card. Nothing
   * happens when no running activity takes files.
   */
  private onFileDrop(e: FileDrop): void {
    if (e.type === 'leave') {
      if (!this.fileDrag) return;
      this.dragBack();
      this.schedule();
      return;
    }
    if (e.type === 'enter' && !e.paths.length) return;
    const where = this.shelfBubble.contains(e.x, e.y) ? 'circle' : 'island';
    if (e.type === 'drop') {
      this.onDrop(e.paths, where, where === 'island' ? (this.zoneAt(e.x, e.y) ?? this.fileDrag?.hot ?? null) : null);
      this.schedule();
      return;
    }
    let fd = this.fileDrag;
    if (!fd) {
      // An 'over' with no 'enter' first counts as one (a drag that started on the island itself).
      fd = this.fileDrag = { where, hot: null, was: { open: this.open, cardFor: this.cardFor } };
      if (where === 'island') this.openForDrop();
      this.shelfBubble.dropping(where === 'circle');
      this.schedule();
      return;
    }
    let changed = false;
    if (fd.where !== where) {
      fd.where = where;
      if (where === 'island') this.openForDrop();
      else {
        this.open = fd.was.open;
        this.cardFor = fd.was.cardFor;
      }
      this.shelfBubble.dropping(where === 'circle');
      changed = true;
    }
    const hot = where === 'island' ? this.zoneAt(e.x, e.y) : null;
    if (hot !== fd.hot) {
      fd.hot = hot;
      changed = true;
    }
    if (changed) this.schedule();
  }

  /** Files dragged over the island open it on the drop card, as a click opens Control Center. */
  private openForDrop(): void {
    this.open = true;
    this.view = 'main';
    this.cardFor = null;
    this.chatOpen = false;
  }

  /** The drag left, or was dropped on neither side: the island as it was before. */
  private dragBack(): void {
    const fd = this.fileDrag;
    this.fileDrag = null;
    this.shelfBubble.dropping(false);
    if (!fd) return;
    this.open = fd.was.open;
    this.cardFor = fd.was.cardFor;
  }

  /** Which side of the drop card is at (x, y), CSS px in the island window. */
  private zoneAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-zone]');
    return el?.dataset.zone ?? null;
  }

  /**
   * Files dropped: on the Shelf's side (or its circle) they go on the Shelf; on Land's, Land takes
   * them as it always has and opens its card; anywhere else nothing happens.
   */
  private onDrop(paths: string[], where: 'island' | 'circle', zone: string | null): void {
    const target = where === 'circle' ? 'shelf' : zone;
    const act = target ? this.running.get(target) : undefined;
    let took = false;
    try {
      took = paths.length > 0 && (target !== 'land' || Boolean(act?.accepts?.())) && (act?.drop?.(paths) ?? false);
    } catch (err) {
      console.error(`drop ${target}`, err);
    }
    if (!took || !target || where === 'circle') {
      this.dragBack();
      if (took) this.shelfBubble.bump();
      return;
    }
    this.fileDrag = null;
    this.shelfBubble.dropping(false);
    this.open = true;
    this.view = 'main';
    this.cardFor = target;
    this.chatOpen = false;
    this.shelfPinned = target === 'shelf';
    this.pendingBump = true;
  }

  /** Windows' own taskbar hides while Island's shows (Settings › Taskbar), and comes back after. */
  /**
   * Windows' own taskbar hides while Island's shows (Settings › Taskbar › Hide Windows' taskbar),
   * and comes back when that is turned off. Island remembers that it hid it (also across a crash),
   * so a taskbar the user set to hide themselves is never shown by Island.
   */
  private syncWindowsBar(): void {
    const t = this.settings.island.taskbar;
    const want = t.on && t.hideWindows;
    if (!this.barSynced) {
      this.barSynced = true;
      this.hidWindowsBar = readFlag(HID_BAR_KEY);
      if (want) {
        this.hidWindowsBar = true;
        writeFlag(HID_BAR_KEY, true);
        void native.dockAutohide(true);
        return;
      }
    }
    if (want && !this.hidWindowsBar) {
      this.hidWindowsBar = true;
      writeFlag(HID_BAR_KEY, true);
      void native.dockAutohide(true);
    } else if (!want && this.hidWindowsBar) {
      this.hidWindowsBar = false;
      writeFlag(HID_BAR_KEY, false);
      void native.dockAutohide(false);
    }
  }

  private barSynced = false;

  private dockMuted = false;
  private dockBattery: { percent: number; charging: boolean } | null = null;
  private dockWifi: boolean | null = null;

  /** What is playing, for the taskbar: from Music's tile. */
  private dockMusic(): { title: string; artist: string; playing: boolean; art: string | null } | null {
    const env = { reason: 'open' as const, now: Date.now(), width: 400, vertical: false, interactive: true, surfaced: null };
    const t = this.running.get('music')?.tile?.(env);
    // Its player, or its lyrics with Lyrics on: both carry the track.
    return t && (t.body.k === 'media' || t.body.k === 'lyrics') ? { title: t.body.title, artist: t.body.artist, playing: t.body.playing, art: t.body.art ?? null } : null;
  }

  /** Claude's limits for the taskbar, asked of the Claude activity once a second. */
  private dockClaude: DockFrame['claude'] = null;

  private async syncDockClaude(): Promise<void> {
    const act = this.running.get('claude');
    try {
      const l = act?.command ? ((await act.command('limits', null)) as DockFrame['claude']) : null;
      this.dockClaude = l && (l.session != null || l.week != null) ? l : null;
    } catch {
      this.dockClaude = null;
    }
  }

  /** The timer running, for the taskbar: the first one's time left. */
  private dockTimer(): string | null {
    const st = this.running.get('timer')?.status();
    return st?.active && st.summary ? (st.summary.match(/\d+:\d{2}(:\d{2})?/)?.[0] ?? null) : null;
  }

  /** The first running activity with a strip to show over a full-screen app. */
  private stripView(now: number): StripView | null {
    for (const [id, act] of this.running) {
      try {
        const v = act.strip?.(now) ?? null;
        if (v) return v;
      } catch (err) {
        console.error(`strip ${id}`, err);
      }
    }
    return null;
  }


  /** Something in the bot's bar or card: close it, or hand it to Local AI. */
  private chatAction(action: ChatAction, arg: unknown): void {
    if (action === 'close') {
      this.chatOpen = false;
    } else {
      const local = this.running.get('local');
      Promise.resolve(local?.action?.(action, arg)).catch((err) => native.log(`bot chat ${action} failed: ${String(err)}`));
    }
    this.schedule();
  }

  /** The bot shows what everything reports: asked on every compose and once a second. */
  private syncPet(now: number, chatView: ChatView | null): void {
    if (!this.settings.island.bot) return;
    const signals: PetSignal[] = [];
    for (const [id, act] of this.running) {
      try {
        const s = act.pet?.(now);
        if (s) signals.push(s);
      } catch (err) {
        console.error(`pet ${id}`, err);
      }
    }
    // With the bar open and nothing on its way, it listens to you.
    if (this.chatOpen && chatView && chatView.phase !== 'thinking' && chatView.phase !== 'streaming') signals.push({ mood: 'listening' });
    const frame = this.brain.update({ signals, dnd: this.settings.general.dnd, now, hour: new Date(now).getHours() });
    // Kept as BubbleView.show takes it: phones draw the same bot.
    this.botNow = { look: lookFor(frame), play: frame.play, strength: frame.moment?.strength ?? 0.5 };
    this.bubble.show(this.botNow.look, this.botNow.play, this.botNow.strength);
  }

  /** Quiet: the island stays small and holds its notifications, and Windows' Do Not Disturb follows. */
  /** Windows has refused Do Not Disturb once already; do not keep saying so. */
  private dndWarned = false;

  private toggleQuiet(): void {
    this.setQuiet(!this.settings.general.dnd);
  }

  private setQuiet(on: boolean): void {
    if (this.settings.general.dnd === on) return;
    this.settings.general.dnd = on;
    this.saveSettings();
    this.schedule();
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
    this.pick(ids[(i + dir + ids.length) % ids.length], Date.now());
  }

  /** Puts an activity in front until the user picks another (a tap away keeps it); `at` 0 lets a tap away clear it. */
  private pick(id: string, at: number): void {
    this.selected = id;
    this.pickedAt = at;
  }

  private tick(): void {
    if (!this.settings) return;
    // A hide that has run its time ends here.
    if (this.windowHidden) this.syncHidden();
    // Clocks, elapsed times and countdowns: recompose once a second while anything shows.
    if (this.primaryId || this.open || this.surfaces.length) this.compose(false);
    else {
      // The bot's moments end, and late at night it yawns, without anything else changing.
      if (this.settings.island.bot) this.syncPet(Date.now(), this.chatOpen ? (this.running.get('local')?.chat?.() ?? null) : null);
      // Phones see that too, and time pass on their cards.
      this.hub?.tick();
    }
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
    if (id === 'island.toggle' && this.windowHidden) {
      this.unhide();
      return;
    }
    // Faded: the toggle key brings it back, as it does a hidden island.
    if (id === 'island.toggle' && this.settings.island.faded) {
      this.setFaded(false);
      this.schedule();
      return;
    }
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
    const active = [...statuses.values()].filter((s) => s.active && s.summary && !s.chipOnly).length;
    if (tooltip.length === 1 && active) tooltip.push(`${active} active`);
    const a = this.settings.island.anchor;
    // Hidden: one item brings it back (and says until when); shown: how long to hide it for.
    const until = this.windowHidden ? backAt(this.settings.island.hiddenUntil, Date.now()) : null;
    const hideItem: MenuItem = this.windowHidden
      ? { id: 'island:unhide', label: until ? `Show island (back ${until})` : 'Show island' }
      : { label: 'Hide island', items: HIDE_CHOICES.map((c) => ({ id: `island:hide:${c.id}`, label: c.label })) };
    menu.push(
      ...(this.windowHidden ? [] : [{ id: 'island:toggle', label: this.open ? 'Close island' : 'Open island' }]),
      hideItem,
      ...(this.windowHidden ? [] : [{ id: 'island:fade', label: this.settings.island.faded ? 'Show island' : 'Fade island' }]),
      {
        label: 'Position',
        items: (['top', 'right', 'bottom', 'left'] as Anchor[]).map((x) => ({ id: `island:anchor:${x}`, label: x[0].toUpperCase() + x.slice(1), checked: a === x })),
      },
      { id: 'island:dnd', label: 'Do not disturb', checked: this.settings.general.dnd },
      { separator: true },
      { id: 'island:app:activities', label: 'Activities…' },
      { id: 'island:app:workspaces', label: 'Workspaces…' },
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
    else if (id === 'island:unhide') this.unhide();
    else if (id === 'island:fade') this.setFaded(!this.settings.island.faded);
    else if (id.startsWith('island:hide:')) {
      const choice = id.slice('island:hide:'.length);
      if (HIDE_CHOICES.some((c) => c.id === choice)) this.hide(choice as HideChoice);
    } else if (id.startsWith('island:anchor:')) {
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
      // Restoring runs here whether or not the Workspaces activity is on.
      else if (req.target === 'workspaces') result = await workspaceEngine().command(req.cmd, req.arg);
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

function prefixMenu(id: string, m: MenuItem): MenuItem {
  return {
    ...m,
    id: m.id ? `act|${id}|${m.id}` : undefined,
    items: m.items?.map((x) => prefixMenu(id, x)),
  };
}
