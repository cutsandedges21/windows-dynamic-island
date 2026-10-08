// The first-run setup: two questions, and the activities their answers put in the Control
// Center (the grid that opens when you click the island). Pure data and rules; the screens
// are in src/welcome.ts.

import type { IconName } from './icons';
import { availableHere, type Platform } from './platform';
import { cloneSettings, type Settings } from './settings';

export type Use = 'school' | 'work' | 'coding' | 'gaming' | 'media' | 'calls' | 'creative';

export interface Option<T extends string = string> {
  id: T;
  label: string;
  sub?: string;
  icon: IconName;
}

/** The first question: what this PC is for. */
export const USES: Option<Use>[] = [
  { id: 'school', label: 'School', sub: 'Classes, homework, studying', icon: 'edit' },
  { id: 'work', label: 'Work', sub: 'Documents, email, deadlines', icon: 'folder' },
  { id: 'coding', label: 'Coding', sub: 'Code, terminals, dev servers', icon: 'code' },
  { id: 'gaming', label: 'Gaming', sub: 'Frame rate and ping while you play', icon: 'gamepad' },
  { id: 'media', label: 'Music and videos', sub: "What's playing, the volume", icon: 'music' },
  { id: 'calls', label: 'Calls and meetings', sub: 'Mic, camera, your next meeting', icon: 'video' },
  { id: 'creative', label: 'Creating', sub: 'Design, photos, video', icon: 'image' },
];

/** Activities a use adds that the second question does not ask about. */
const USE_EXTRAS: Record<Use, string[]> = {
  school: [],
  work: [],
  coding: ['claude', 'ask', 'servers'],
  gaming: ['game'],
  media: [],
  calls: ['calls'],
  creative: [],
};

/** The second question: what to see at a glance. Each choice is one activity's tile. */
export interface Glance extends Option {
  /** Only offered on a PC with a battery. */
  laptop?: boolean;
}

export const GLANCE: Glance[] = [
  { id: 'music', label: "What's playing", icon: 'music' },
  { id: 'calendar', label: 'Your next event', icon: 'calendar' },
  { id: 'weather', label: 'Weather', icon: 'cloud-sun' },
  { id: 'timer', label: 'Timers and focus', icon: 'timer' },
  { id: 'battery', label: 'Battery', icon: 'battery', laptop: true },
  { id: 'system', label: 'CPU and memory', icon: 'cpu' },
  { id: 'network', label: 'Internet speed', icon: 'wifi' },
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'screenshots', label: 'Screenshots', icon: 'screenshot' },
  { id: 'clipboard', label: 'Clipboard', icon: 'clipboard' },
  { id: 'sound', label: 'Volume', icon: 'speaker' },
];

/** What each use ticks in the second question before the user changes anything. */
const USE_GLANCE: Record<Use, string[]> = {
  school: ['calendar', 'timer', 'clipboard'],
  work: ['calendar', 'timer', 'clipboard', 'downloads'],
  coding: ['system', 'clipboard'],
  gaming: ['system', 'network', 'sound'],
  media: ['music', 'sound'],
  calls: ['calendar', 'sound'],
  creative: ['screenshots', 'clipboard', 'downloads'],
};

/** What Island can tell about the PC without asking. */
export interface Facts {
  /** It has a battery. */
  laptop: boolean;
  /** Claude Code is on this PC. */
  claudeCode: boolean;
  /** The system Island runs on (Windows when not given). */
  platform?: Platform;
}

/** The glance choices that make sense on this PC. */
export function glanceChoices(facts: Facts): Glance[] {
  return GLANCE.filter((g) => (!g.laptop || facts.laptop) && availableHere(g.id, facts.platform ?? 'windows'));
}

/** The second question's ticks to start with: what the uses call for, plus Battery on a laptop. */
export function suggestGlance(uses: Use[], facts: Facts): string[] {
  const ids = new Set(uses.length ? uses.flatMap((u) => USE_GLANCE[u]) : ['music', 'timer']);
  if (facts.laptop) ids.add('battery');
  return glanceChoices(facts)
    .map((g) => g.id)
    .filter((id) => ids.has(id));
}

export interface Answers {
  uses: Use[];
  glance: string[];
  /** Where the weather is for. */
  city: string;
  /** A Local AI model was picked in the AI step. */
  ai: boolean;
}

/**
 * On whatever the answers: they pop up for system events (the volume, a USB drive, a
 * finished download, low battery) but only get a tile when picked.
 */
export const HELPERS = ['sound', 'downloads', 'screenshots', 'devices', 'external', 'battery'];

/** Grid order: what you act on first, then what you glance at, then occasional helpers. */
const GRID_ORDER = ['claude', 'local', 'ask', 'music', 'calendar', 'weather', 'timer', 'game', 'calls', 'system', 'network', 'servers', 'battery', 'sound', 'downloads', 'screenshots', 'clipboard'];

/** Activities the setup switches on or off. The rest (integrations with keys, Quick Actions) keep their state. */
const MANAGED = new Set([...GRID_ORDER, ...HELPERS]);

export interface Plan {
  /** Tiles on the grid, in this order. */
  picked: string[];
  /** Switched on: the picked ones and the helpers. */
  enabled: string[];
  /** Switched on but kept off the grid. */
  hidden: string[];
}

export function planActivities(a: Answers, facts: Facts): Plan {
  const offered = new Set(glanceChoices(facts).map((g) => g.id));
  const wanted = new Set([...a.glance.filter((id) => offered.has(id)), ...a.uses.flatMap((u) => USE_EXTRAS[u])]);
  if (!facts.claudeCode) {
    wanted.delete('claude');
    wanted.delete('ask');
  }
  if (a.ai) wanted.add('local');
  const picked = GRID_ORDER.filter((id) => wanted.has(id));
  const helpers = HELPERS.filter((id) => id !== 'battery' || facts.laptop);
  // A Mac switches on only what it can run yet.
  const here = (id: string) => availableHere(id, facts.platform ?? 'windows');
  const enabled = [...new Set([...picked, ...helpers])].filter(here);
  return { picked: picked.filter(here), enabled, hidden: enabled.filter((id) => !picked.includes(id)) };
}

/**
 * `s` with the plan applied: activities on and off, the grid in the plan's order with the
 * helpers kept off it, the weather city saved, and setup marked as done.
 */
export function applyPlan(s: Settings, plan: Plan, city: string): Settings {
  const out = cloneSettings(s);
  for (const [id, cfg] of Object.entries(out.activities.config)) if (MANAGED.has(id)) cfg.enabled = plan.enabled.includes(id);
  out.activities.order = [...plan.picked, ...out.activities.order.filter((id) => !plan.picked.includes(id))];
  out.island.grid = { order: [], sizes: {}, hidden: [...plan.hidden], pages: [] };
  const place = city.trim();
  if (place && out.activities.config.weather) out.activities.config.weather.options.city = place;
  out.general.onboarded = true;
  return out;
}

/** About how many cells each tile takes, for the grid preview on the last screen. */
const PREVIEW_CELLS: Record<string, [number, number]> = {
  music: [2, 2],
  claude: [2, 1],
  local: [2, 1],
  ask: [2, 1],
  calendar: [2, 1],
  weather: [2, 1],
  game: [2, 1],
  calls: [2, 1],
  battery: [2, 1],
  servers: [2, 1],
  downloads: [2, 1],
  clipboard: [2, 1],
};

export function previewCells(id: string): { w: number; h: number } {
  const [w, h] = PREVIEW_CELLS[id] ?? [1, 1];
  return { w, h };
}
