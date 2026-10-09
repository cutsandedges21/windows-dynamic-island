// The Activity contract. Everything the island can show, built in or sent by
// another program, implements this one interface; the island never needs to
// know what an activity represents.

import type { ActivityMeta } from '../activities/catalog';
import type { ChatView } from './chat';
import type { PetSignal } from './pet';
import type { IconName } from './icons';
import type { Level } from './layout';
import type { MenuItem } from './native';
import type { GlowMotion } from './glow';
import type { Seg, Tone } from './segments';
import type { SheetView, Tile } from './sheet';
import type { ActivityConfig, Settings } from './settings';

export interface ActivityStatus {
  /** Something is happening now. */
  active: boolean;
  /** foreground: happening right now (music playing, Claude working). background: present but quiet. */
  weight?: 'foreground' | 'background';
  /** Wants the island now (a permission request, a finished timer). */
  urgent?: { key: string; level?: Level } | null;
  /** One line for the overflow list, chips and the tray. */
  summary?: string;
  /**
   * Light on the pill's edge while this activity is shown, in its own tone:
   * orbit = busy, pulse = waiting on you, progress = filling up (value 0..1).
   * Orange (the claude tone) is Claude's alone.
   */
  beam?: { tone: Tone; motion?: GlowMotion; value?: number; fast?: boolean; urgent?: boolean } | null;
  /** Stay visible over a full-screen app (a game showing its frame rate). */
  overFullscreen?: boolean;
}

/** How an activity looks as a small chip beside another activity. */
export interface ChipView {
  icon: IconName;
  label?: string;
  tone?: Tone;
  dot?: Tone;
  pulse?: boolean;
}

export interface RenderEnv {
  level: Level;
  /** Inner width available for content, CSS px. */
  width: number;
  height: number;
  now: number;
  open: boolean;
  hover: boolean;
  /** Key of the event that surfaced this activity, if that is why it is shown. */
  surfaced: string | null;
  /** Buttons and inputs may be shown (the user's Interactive setting). */
  interactive: boolean;
  /** The pill stands vertical (left/right edge): keep text short. */
  vertical: boolean;
}

/** Why the island is asking for a sheet (the card under the pill). */
export interface SheetEnv {
  /** urgent: the activity holds the island; surfaced: an event raised it; hover: the pointer is on it; open: the user opened the island. */
  reason: 'urgent' | 'surfaced' | 'hover' | 'open';
  now: number;
  /** Card width, CSS px. */
  width: number;
  vertical: boolean;
  interactive: boolean;
  /** Key of the event that surfaced the activity, if any. */
  surfaced: string | null;
}

export interface SurfaceOptions {
  /** How long to stay surfaced, ms. Default 3500. */
  ms?: number;
  level?: Level;
  /** Identifies the event; a newer surface with the same key replaces the old one. */
  key?: string;
  /** Nod the island when it arrives. Default true. */
  bump?: boolean;
}

export interface ActivityContext {
  readonly id: string;
  config(): ActivityConfig;
  options<T extends Record<string, unknown> = Record<string, unknown>>(): T;
  settings(): Settings;
  /** State changed: recompose the island (coalesced to one frame). */
  update(): void;
  /** Something happened: show this activity for a moment (if Auto-show allows). */
  surface(opts?: SurfaceOptions): void;
  /** Shake or glow the island. */
  alert(kind?: 'shake' | 'glow', tone?: Tone): void;
  /** Open (maximum) or close the island. */
  open(): void;
  close(): void;
  isOpen(): boolean;
  isPrimary(): boolean;
  notify(title: string, body: string): void;
  log(...parts: unknown[]): void;
  /** Saves option values the activity keeps for itself (hidden chats, a cleared list). */
  setOptions?(patch: Record<string, unknown>): void;
}

export interface Activity {
  readonly meta: ActivityMeta;
  start(ctx: ActivityContext): void | Promise<void>;
  stop(): void;
  status(): ActivityStatus;
  /** Segments for this level. Keys only need to be unique within the activity. */
  render(env: RenderEnv): Seg[];
  chip?(env: RenderEnv): ChipView | null;
  /** Buttons for the open island when nothing is happening (start a timer, quick actions). */
  home?(env: RenderEnv): Seg[];
  /** A card under the pill for this moment: longer text, a reply box, lists. Null: no card. */
  sheet?(env: SheetEnv): SheetView | null;
  /** This activity's cell in the open island's grid. Null hides it. */
  tile?(env: SheetEnv): Tile | null;
  /** The bot's chat, shown in the bar under the bot (Local AI is the only one). */
  chat?(): ChatView | null;
  /** What this activity tells the bot (src/core/pet.ts): its mood while something is true, and its latest moment. */
  pet?(now: number): PetSignal | null;
  /** A segment with `action` was clicked (or an input submitted). */
  action?(name: string, arg: unknown): void | Promise<void>;
  /** Options changed in the Activities page. */
  reconfigure?(): void;
  /** Tray contributions (Claude adds its sessions). */
  tray?(): { tooltip?: string[]; alert?: boolean; menu?: MenuItem[] } | null;
  /** The user tapped away an urgent moment (its status().urgent.key). */
  dismiss?(urgentKey: string): void;
  /** Hotkey routed to this activity. */
  hotkey?(id: string): void;
  /** Requests from the app window (detail panels). */
  command?(cmd: string, arg: unknown): unknown | Promise<unknown>;
  /** Hotkeys this activity wants registered right now. */
  hotkeys?(): Array<{ id: string; accel: string }>;
}

export type ActivityFactory = () => Activity;
