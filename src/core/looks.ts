// What the bot looks like for each mood and moment (src/core/pet.ts): a pose from the bot engine
// (a bloub state), a face (one of its 16 resting expressions, shown on the resting pose), costume
// pieces drawn over it (src/fx/bot/costumes.ts) and a motion of the whole bot (island.css).

import type { BotState } from '../fx';
import type { CostumeId } from '../fx/bot/costumes';
import type { MomentId, MoodId, PetFrame } from './pet';

/** bloub's resting expressions (src/fx/bot/expressions.ts), by their own (French) ids. */
export type Face =
  | 'neutre' | 'attentif' | 'surpris' | 'excite' | 'heureux' | 'hilare' | 'colere' | 'triste'
  | 'effraye' | 'mefiant' | 'confus' | 'curieux' | 'fier' | 'timide' | 'blase' | 'somnolent';

/** Loops for moods, one-shots for moments (keyframes in island.css, `.motion-<name>`). */
export type Motion =
  | 'breathe' | 'snooze' | 'sway' | 'talk' | 'bounce' | 'droop' | 'shiver' | 'still' | 'tilt'
  | 'hop' | 'jolt' | 'shake' | 'shrink' | 'stretch' | 'type';

export interface PetLook {
  state: BotState;
  face: Face;
  costume: CostumeId[];
  motion: Motion;
  /** Where its eyes rest instead of on you (degrees, yaw right, pitch up); a pointer nearby still pulls them. */
  gaze?: { yaw: number; pitch: number };
}

const look = (state: BotState, face: Face, costume: CostumeId[], motion: Motion): PetLook => ({ state, face, costume, motion });

/**
 * Claude working, or its own chat thinking: the bot codes at a little laptop, eyes on the screen,
 * typing (Moss: the actual avatar, not three dots).
 */
const CODING: PetLook = { ...look('idle', 'attentif', ['laptop'], 'type'), gaze: { yaw: 0, pitch: -5 } };

export const MOOD_LOOKS: Record<MoodId, PetLook> = {
  listening: look('idle', 'attentif', [], 'still'),
  pondering: CODING,
  talking: look('idle', 'excite', [], 'talk'),
  asleep: look('idle', 'blase', ['zzz'], 'snooze'),
  'needs-you': look('notify', 'neutre', [], 'bounce'),
  drained: look('idle', 'triste', ['battery-empty'], 'droop'),
  offline: look('idle', 'confus', ['cloud-off'], 'tilt'),
  'on-air': look('idle', 'attentif', ['rec'], 'still'),
  vibing: look('idle', 'hilare', ['headphones', 'notes'], 'sway'),
  gaming: look('idle', 'excite', ['controller'], 'still'),
  thinking: CODING,
  overheated: look('idle', 'effraye', ['sweat', 'heat'], 'shiver'),
  downloading: look('idle', 'curieux', ['arrow-down'], 'breathe'),
  focused: look('idle', 'mefiant', ['tomato'], 'still'),
  charging: look('idle', 'heureux', ['bolt'], 'breathe'),
  tired: look('idle', 'somnolent', [], 'snooze'),
  idle: look('idle', 'neutre', [], 'breathe'),
};

export const MOMENT_LOOKS: Record<MomentId, PetLook> = {
  'volume-up': look('idle', 'surpris', ['waves'], 'bounce'),
  'volume-down': look('idle', 'timide', ['shh'], 'shrink'),
  muted: look('idle', 'timide', ['speaker-off'], 'shrink'),
  'audio-device': look('idle', 'curieux', ['speaker'], 'hop'),
  track: look('idle', 'hilare', ['headphones', 'notes-burst'], 'hop'),
  paused: look('idle', 'blase', ['headphones-down'], 'still'),
  played: look('idle', 'heureux', ['headphones', 'notes'], 'hop'),
  plugged: look('idle', 'excite', ['zap'], 'jolt'),
  unplugged: look('idle', 'effraye', [], 'shiver'),
  full: look('wink', 'heureux', ['battery-full', 'sparkle'], 'hop'),
  'battery-low': look('idle', 'somnolent', ['battery-low', 'sweat'], 'droop'),
  'battery-critical': look('idle', 'effraye', ['battery-empty'], 'shake'),
  offline: look('idle', 'triste', ['cloud-off'], 'droop'),
  online: look('idle', 'heureux', ['wifi'], 'hop'),
  'vpn-on': look('idle', 'fier', ['sunglasses'], 'still'),
  'vpn-off': look('idle', 'neutre', [], 'tilt'),
  'usb-in': look('idle', 'surpris', ['plug'], 'hop'),
  'usb-out': look('idle', 'neutre', ['bye'], 'tilt'),
  'cpu-spike': look('idle', 'effraye', ['sweat', 'heat'], 'shiver'),
  'ram-spike': look('idle', 'confus', ['swirl'], 'tilt'),
  'call-start': look('idle', 'attentif', ['rec'], 'jolt'),
  'mic-muted': look('idle', 'timide', ['mic-off'], 'shrink'),
  screenshot: look('idle', 'blase', ['flash'], 'jolt'),
  copy: look('idle', 'curieux', ['clipboard'], 'hop'),
  'download-done': look('idle', 'heureux', ['box', 'sparkle'], 'hop'),
  'timer-start': look('idle', 'fier', ['clock'], 'jolt'),
  'focus-start': look('idle', 'mefiant', ['tomato'], 'still'),
  'break-start': look('idle', 'heureux', [], 'stretch'),
  'timer-done': look('idle', 'effraye', ['alarm'], 'shake'),
  'meeting-soon': look('idle', 'curieux', ['clock'], 'tilt'),
  rain: look('idle', 'neutre', ['umbrella'], 'still'),
  'game-start': look('idle', 'excite', ['controller'], 'hop'),
  'new-server': look('idle', 'surpris', ['code'], 'hop'),
  'good-news': look('idle', 'hilare', ['confetti'], 'hop'),
  'bad-news': look('alert', 'neutre', [], 'shake'),
  warning: look('idle', 'effraye', ['sweat'], 'shiver'),
  info: look('notify', 'curieux', [], 'tilt'),
  payment: look('idle', 'hilare', ['coin'], 'hop'),
  'claude-asks': look('notify', 'neutre', [], 'bounce'),
  'claude-done': look('wink', 'heureux', [], 'hop'),
  'claude-error': look('alert', 'neutre', [], 'shake'),
  'limits-reset': look('idle', 'heureux', ['sparkle'], 'stretch'),
  answered: look('wink', 'heureux', [], 'hop'),
  updated: look('idle', 'fier', ['new', 'sparkle'], 'hop'),
  yawn: look('idle', 'somnolent', ['yawn'], 'stretch'),
};

/**
 * The look for a frame: the moment's while one plays, else the mood's. While music plays the
 * headphones stay on through other moments (unless the moment is about taking them off).
 */
export function lookFor(frame: Pick<PetFrame, 'mood' | 'moment'>): PetLook {
  if (!frame.moment) return MOOD_LOOKS[frame.mood];
  const l = MOMENT_LOOKS[frame.moment.id];
  if (frame.mood === 'vibing' && !l.costume.some((c) => c.startsWith('headphones'))) return { ...l, costume: ['headphones', ...l.costume] };
  return l;
}
