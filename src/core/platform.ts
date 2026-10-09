// Which system Island runs on, and which activities that system can run yet.

import { CATALOG_BY_ID } from '../activities/catalog';

export type Platform = 'windows' | 'macos';

export function detectPlatform(userAgent: string): Platform {
  return /Macintosh|Mac OS X/.test(userAgent) ? 'macos' : 'windows';
}

export const platform: Platform = typeof navigator === 'undefined' ? 'windows' : detectPlatform(navigator.userAgent);

/** This computer in the UI's words: "this Mac" or "this PC". */
export function thisComputer(on: Platform = platform): string {
  return on === 'macos' ? 'this Mac' : 'this PC';
}

/** The Ctrl key as its keycap says it. */
export function ctrlKey(on: Platform = platform): string {
  return on === 'macos' ? 'Control' : 'Ctrl';
}

/** Whether an activity option can be offered here: options marked `mac: 'never'` are Windows only. */
export function optionHere(o: { mac?: 'never' }, on: Platform = platform): boolean {
  return on !== 'macos' || o.mac !== 'never';
}

/** Why this activity cannot run here, in words for the Activities page; null when it can. */
export function unavailableReason(id: string, on: Platform = platform): string | null {
  const mac = CATALOG_BY_ID.get(id)?.mac;
  if (on !== 'macos' || !mac) return null;
  return mac === 'never' ? 'Windows only' : 'Coming to Mac';
}

export function availableHere(id: string, on: Platform = platform): boolean {
  return unavailableReason(id, on) === null;
}
