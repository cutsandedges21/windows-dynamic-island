// Saving where a workspace's windows are and putting them back. A program gets a new process id
// every time it starts, so a saved window is found again by its program, then its window class
// and title. Where it goes: the same place on the same monitor if that monitor is still there as
// it was, else the same share of a monitor's work area (a monitor that's gone means the main
// one), and always fully reachable.

import type { LiveWindow, MonitorInfo } from '../core/native';
import { appName, newId, type MonitorShot, type Rect, type Resource, type WindowLayout, type WindowSpot } from './model';

const lower = (s: string) => s.trim().toLowerCase();

/** The app item that starts this program, if any (same path, or same program name). */
export function itemFor(exe: string, items: Resource[]): string | null {
  const name = appName(exe).toLowerCase();
  const hit = items.find((r) => r.kind === 'app' && (lower(r.path) === lower(exe) || (name !== '' && appName(r.path).toLowerCase() === name)));
  return hit?.id ?? null;
}

function shot(m: MonitorInfo): MonitorShot {
  return { id: m.id, name: m.name, primary: m.primary, bounds: { ...m.bounds }, work: { ...m.work }, scale: m.scale };
}

/** The windows chosen, as a layout: where each is, also as shares of its monitor's work area. */
export function captureLayout(windows: LiveWindow[], monitors: MonitorInfo[], items: Resource[], now = Date.now()): WindowLayout {
  const spots: WindowSpot[] = windows.map((w) => {
    const m = monitors.find((x) => x.id === w.monitor) ?? monitors.find((x) => x.primary) ?? monitors[0];
    const work = m?.work ?? { x: 0, y: 0, width: Math.max(1, w.rect.width), height: Math.max(1, w.rect.height) };
    return {
      id: newId('win'),
      exe: w.exe,
      title: w.title,
      className: w.className,
      monitor: m?.id ?? w.monitor,
      rect: { ...w.rect },
      rel: { x: (w.rect.x - work.x) / work.width, y: (w.rect.y - work.y) / work.height, w: w.rect.width / work.width, h: w.rect.height / work.height },
      state: w.state,
      resource: itemFor(w.exe, items),
      enabled: true,
    };
  });
  return { savedAt: now, monitors: monitors.map(shot), windows: spots };
}

function words(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
}

/** How alike a saved window and a live one of the same program are. */
function likeness(spot: WindowSpot, w: LiveWindow): number {
  let score = 1;
  if (spot.className === w.className) score += 2;
  if (spot.title === w.title) score += 6;
  else {
    const a = words(spot.title);
    for (const word of words(w.title)) if (a.has(word)) score += 1;
  }
  return score;
}

/**
 * Which live window each saved one is: same program only; the most alike pairs first, each
 * window used once, ties to the window nearer the front.
 */
export function matchWindows(spots: WindowSpot[], live: LiveWindow[]): Map<string, LiveWindow> {
  const pairs: Array<{ spot: WindowSpot; w: LiveWindow; score: number; z: number }> = [];
  for (const spot of spots) {
    live.forEach((w, z) => {
      if (lower(w.exe) === lower(spot.exe)) pairs.push({ spot, w, score: likeness(spot, w), z });
    });
  }
  pairs.sort((a, b) => b.score - a.score || a.z - b.z);
  const out = new Map<string, LiveWindow>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.spot.id) || used.has(p.w.hwnd)) continue;
    out.set(p.spot.id, p.w);
    used.add(p.w.hwnd);
  }
  return out;
}

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameSize = (a: Rect, b: Rect) => a.width === b.width && a.height === b.height;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A rectangle moved and shrunk to be reachable in a work area. Windows' frames have invisible
 * borders a few pixels wide, so a little overhang at the sides and bottom is allowed; the top
 * (the title bar) never goes above the work area.
 */
export function fit(r: Rect, work: Rect, slack = 16): Rect {
  const width = clamp(Math.round(r.width), Math.min(160, work.width), work.width + 2 * slack);
  const height = clamp(Math.round(r.height), Math.min(100, work.height), work.height + slack);
  const x = clamp(Math.round(r.x), work.x - slack, work.x + work.width + slack - width);
  const y = clamp(Math.round(r.y), work.y, Math.max(work.y, work.y + work.height + slack - height));
  return { x, y, width, height };
}

/** Where a saved window goes on today's monitors, and what to say if its monitor is gone. */
export function targetFor(spot: WindowSpot, saved: MonitorShot[], current: MonitorInfo[]): { rect: Rect; monitor: string; note: string | null } | null {
  if (!current.length) return null;
  const was = saved.find((m) => m.id === spot.monitor);
  // The same monitor: its id, or (ids change when monitors are plugged in again) its name and size.
  let m = was ? current.find((c) => c.id === was.id && sameSize(c.bounds, was.bounds)) ?? current.find((c) => c.name === was.name && sameSize(c.bounds, was.bounds)) : undefined;
  let note: string | null = null;
  let rect: Rect;
  if (m && was && same(m.bounds, was.bounds) && same(m.work, was.work)) rect = { ...spot.rect };
  else {
    if (!m) {
      // Same id with another resolution: the same monitor, set differently. Otherwise it's gone.
      m = current.find((c) => c.id === spot.monitor);
      if (!m) {
        m = current.find((c) => c.primary) ?? current[0];
        note = `${was?.name ? `${was.name} isn't connected` : "Its screen isn't connected"}, so it went on ${m.primary ? 'the main screen' : m.name}.`;
      }
    }
    const work = m.work;
    rect = { x: work.x + spot.rel.x * work.width, y: work.y + spot.rel.y * work.height, width: spot.rel.w * work.width, height: spot.rel.h * work.height };
  }
  return { rect: fit(rect, m.work), monitor: m.id, note };
}

export interface PlacementPlan {
  places: Array<{ spot: WindowSpot; hwnd: number; rect: Rect; state: WindowSpot['state'] }>;
  /** Saved windows with no live window of their program. */
  missing: WindowSpot[];
  notes: string[];
}

/** Every switched-on saved window that's open now, with where it goes. */
export function planPlacement(layout: WindowLayout, live: LiveWindow[], monitors: MonitorInfo[]): PlacementPlan {
  const spots = layout.windows.filter((w) => w.enabled);
  const matches = matchWindows(spots, live);
  const plan: PlacementPlan = { places: [], missing: [], notes: [] };
  for (const spot of spots) {
    const w = matches.get(spot.id);
    const target = w ? targetFor(spot, layout.monitors, monitors) : null;
    if (!w || !target) {
      plan.missing.push(spot);
      continue;
    }
    if (target.note && !plan.notes.includes(target.note)) plan.notes.push(target.note);
    plan.places.push({ spot, hwnd: w.hwnd, rect: target.rect, state: spot.state });
  }
  return plan;
}

/** "Code", "Spotify" for a list of saved windows. */
export function programNames(spots: WindowSpot[]): string {
  const names = [...new Set(spots.map((s) => appName(s.exe)).filter(Boolean))];
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}
