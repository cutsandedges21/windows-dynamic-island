// Island on your phone: the PC settings a phone may change (its Activities and Settings
// screens), and nothing else. The hub runs a phone's `pref` line only through `applyPref`, which
// knows each key here by name and checks the value's type and range: a phone can never write any
// other setting. Left out on purpose: pairing, terminals and phone pushes, Land, hotkeys, start
// with Windows, auto-update, privacy, screens and widths, the grid, the menu, and every
// activity's own options (keys, paths, accounts).

import { CATALOG_BY_ID } from '../activities/catalog';
import { growsChoices, type Grows, type Settings } from '../core/settings';
import type { PrefActivity, PrefChoice, PrefRow, PrefValue } from './protocol';

interface PrefDef {
  key: string;
  section: string;
  label: string;
  kind: PrefRow['kind'];
  choices?: PrefChoice[];
  min?: number;
  max?: number;
  get(s: Settings): PrefValue;
  /** Called only with a value `fits` passed. */
  set(s: Settings, v: never): void;
}

type Isl = Settings['island'];

const pick = (...pairs: Array<[string, string]>): PrefChoice[] => pairs.map(([value, label]) => ({ value, label }));

const GROWS_LABEL: Record<Grows, string> = { wide: 'Sideways', card: 'Into a card', below: 'Below', more: 'Card with more' };

/** The allow-list, in the order and sections the phone shows them (as the PC's Settings nav groups them). */
export const PREFS: readonly PrefDef[] = [
  { key: 'island.anchor', section: 'Look', label: 'Position', kind: 'choice', choices: pick(['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']), get: (s) => s.island.anchor, set: (s, v: Isl['anchor']) => void (s.island.anchor = v) },
  { key: 'island.size', section: 'Look', label: 'Size', kind: 'choice', choices: pick(['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']), get: (s) => s.island.size, set: (s, v: Isl['size']) => void (s.island.size = v) },
  { key: 'island.color', section: 'Look', label: 'Colour', kind: 'choice', choices: pick(['black', 'Black'], ['matte-black', 'Matte black'], ['white', 'White'], ['matte-white', 'Matte white'], ['glass', 'Glass']), get: (s) => s.island.color, set: (s, v: Isl['color']) => void (s.island.color = v) },
  { key: 'island.glass', section: 'Look', label: 'Glass tint', kind: 'range', min: 0, max: 100, get: (s) => s.island.glass, set: (s, v: number) => void (s.island.glass = Math.round(v)) },
  { key: 'island.glow', section: 'Look', label: 'Border glow', kind: 'choice', choices: pick(['off', 'Off'], ['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']), get: (s) => s.island.glow, set: (s, v: Isl['glow']) => void (s.island.glow = v) },
  { key: 'island.reduceMotion', section: 'Look', label: 'Reduce motion', kind: 'choice', choices: pick(['system', 'System'], ['on', 'On'], ['off', 'Off']), get: (s) => s.island.reduceMotion, set: (s, v: Isl['reduceMotion']) => void (s.island.reduceMotion = v) },
  { key: 'island.bot', section: 'Look', label: 'Bot beside the pill', kind: 'bool', get: (s) => s.island.bot, set: (s, v: boolean) => void (s.island.bot = v) },
  { key: 'island.hoverExpand', section: 'Behavior', label: 'Grow when pointed at', kind: 'bool', get: (s) => s.island.hoverExpand, set: (s, v: boolean) => void (s.island.hoverExpand = v) },
  { key: 'island.hoverCard', section: 'Behavior', label: 'Hover shows', kind: 'choice', choices: pick(['pointer', 'What is pointed at'], ['claude', "Claude's stats"]), get: (s) => s.island.hoverCard, set: (s, v: Isl['hoverCard']) => void (s.island.hoverCard = v) },
  { key: 'island.defaultGrows', section: 'Behavior', label: 'When pointed at', kind: 'choice', choices: pick(['wide', GROWS_LABEL.wide], ['card', GROWS_LABEL.card]), get: (s) => s.island.defaultGrows, set: (s, v: Isl['defaultGrows']) => void (s.island.defaultGrows = v) },
  { key: 'island.showSecondary', section: 'Behavior', label: 'Second activity beside the first', kind: 'bool', get: (s) => s.island.showSecondary, set: (s, v: boolean) => void (s.island.showSecondary = v) },
  { key: 'island.hideInFullscreen', section: 'Behavior', label: 'Hide in full screen', kind: 'bool', get: (s) => s.island.hideInFullscreen, set: (s, v: boolean) => void (s.island.hideInFullscreen = v) },
  { key: 'island.peekThrough', section: 'Behavior', label: 'Ctrl peeks through', kind: 'bool', get: (s) => s.island.peekThrough, set: (s, v: boolean) => void (s.island.peekThrough = v) },
  { key: 'general.dnd', section: 'General', label: 'Quiet', kind: 'bool', get: (s) => s.general.dnd, set: (s, v: boolean) => void (s.general.dnd = v) },
  { key: 'general.notifications', section: 'General', label: 'Notifications', kind: 'bool', get: (s) => s.general.notifications, set: (s, v: boolean) => void (s.general.notifications = v) },
  { key: 'general.sounds', section: 'General', label: 'Sounds', kind: 'bool', get: (s) => s.general.sounds, set: (s, v: boolean) => void (s.general.sounds = v) },
];

const BY_KEY = new Map(PREFS.map((p) => [p.key, p]));

/** A value fits a setting: the right type, one of its choices, within its range. */
function fits(def: PrefDef, value: PrefValue): boolean {
  switch (def.kind) {
    case 'bool':
      return typeof value === 'boolean';
    case 'choice':
      return typeof value === 'string' && (def.choices ?? []).some((c) => c.value === value);
    case 'range':
      return typeof value === 'number' && Number.isFinite(value) && value >= (def.min ?? 0) && value <= (def.max ?? 100);
  }
}

/** An activity the phone may switch: in the catalog and in these settings. */
function activityOf(s: Settings, id: string) {
  return CATALOG_BY_ID.has(id) && Object.prototype.hasOwnProperty.call(s.activities.config, id) ? s.activities.config[id] : undefined;
}

/** What the phone's Activities and Settings screens show: the allow-listed settings and every activity, with their values now. */
export function prefsOf(s: Settings): { rows: PrefRow[]; acts: PrefActivity[] } {
  const rows: PrefRow[] = PREFS.map((d) => {
    const row: PrefRow = { key: d.key, section: d.section, label: d.label, kind: d.kind, value: d.get(s) };
    if (d.choices) row.choices = d.choices;
    if (d.min !== undefined) row.min = d.min;
    if (d.max !== undefined) row.max = d.max;
    return row;
  });
  const acts: PrefActivity[] = [];
  for (const id of s.activities.order) {
    const c = activityOf(s, id);
    const meta = CATALOG_BY_ID.get(id);
    if (!c || !meta) continue;
    const offered = growsChoices(id);
    const grows = c.grows && offered.includes(c.grows) ? c.grows : id === 'claude' ? 'more' : s.island.defaultGrows;
    acts.push({ id, name: meta.name, enabled: c.enabled, grows, choices: offered.map((g) => ({ value: g, label: GROWS_LABEL[g] })) });
  }
  return { rows, acts };
}

/**
 * Changes one setting a phone asked for, in `s`. False (and `s` untouched) for a key not on the
 * allow-list, an activity that isn't there, or a value of the wrong type or out of range.
 */
export function applyPref(s: Settings, key: string, value: PrefValue): boolean {
  const def = BY_KEY.get(key);
  if (def) {
    if (!fits(def, value)) return false;
    def.set(s, value as never);
    return true;
  }
  const m = /^act:([a-z0-9-]{1,64}):(enabled|grows)$/.exec(key);
  if (!m) return false;
  const c = activityOf(s, m[1]);
  if (!c) return false;
  if (m[2] === 'enabled') {
    if (typeof value !== 'boolean') return false;
    c.enabled = value;
    return true;
  }
  if (typeof value !== 'string' || !(growsChoices(m[1]) as string[]).includes(value)) return false;
  c.grows = value as Grows;
  return true;
}
