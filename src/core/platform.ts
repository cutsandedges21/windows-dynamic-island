// Which system Island runs on, and which activities that system can run yet.

import { CATALOG_BY_ID } from '../activities/catalog';

export type Platform = 'windows' | 'macos';

export function detectPlatform(userAgent: string): Platform {
  return /Macintosh|Mac OS X/.test(userAgent) ? 'macos' : 'windows';
}

export const platform: Platform = typeof navigator === 'undefined' ? 'windows' : detectPlatform(navigator.userAgent);

/** Why this activity cannot run here, in words for the Activities page; null when it can. */
export function unavailableReason(id: string, on: Platform = platform): string | null {
  const mac = CATALOG_BY_ID.get(id)?.mac;
  if (on !== 'macos' || !mac) return null;
  return mac === 'never' ? 'Windows only' : 'Coming to Mac';
}

export function availableHere(id: string, on: Platform = platform): boolean {
  return unavailableReason(id, on) === null;
}
