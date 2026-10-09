// The bot's brain: from what every activity reports (Activity.pet), what the bot shows now.
// A mood lasts while something is true; the highest one wins. Moments are short reactions that
// play over the mood and end on their own. Pure, with no clock of its own, so every rule is a test.

export type MoodId =
  | 'listening' | 'pondering' | 'talking' // the bot's own chat: above everything, you woke it up
  | 'asleep' | 'needs-you' | 'drained' | 'offline' | 'on-air' | 'vibing' | 'gaming'
  | 'thinking' | 'overheated' | 'downloading' | 'focused' | 'charging' | 'tired' | 'idle';

/** Highest first: the first of these that anything reports is the mood. */
export const MOOD_ORDER: readonly MoodId[] = [
  'listening', 'pondering', 'talking',
  'asleep', 'needs-you', 'drained', 'offline', 'on-air', 'vibing', 'gaming',
  'thinking', 'overheated', 'downloading', 'focused', 'charging', 'tired', 'idle',
];

export type MomentId =
  | 'volume-up' | 'volume-down' | 'muted' | 'audio-device'
  | 'track' | 'paused' | 'played'
  | 'plugged' | 'unplugged' | 'full' | 'battery-low' | 'battery-critical'
  | 'offline' | 'online' | 'vpn-on' | 'vpn-off' | 'usb-in' | 'usb-out'
  | 'cpu-spike' | 'ram-spike' | 'call-start' | 'mic-muted'
  | 'screenshot' | 'copy' | 'download-done'
  | 'timer-start' | 'focus-start' | 'break-start' | 'timer-done'
  | 'meeting-soon' | 'rain' | 'game-start' | 'new-server'
  | 'good-news' | 'bad-news' | 'warning' | 'info' | 'payment'
  | 'claude-asks' | 'claude-done' | 'claude-error' | 'limits-reset'
  | 'answered' | 'updated' | 'yawn';

/** Something an activity saw. `key` merges repeats (holding volume is one moment); `at` orders them. */
export interface PetMoment {
  id: MomentId;
  key: string;
  at: number;
  /** 0..1, how big (a bigger volume jump bounces higher). */
  strength?: number;
}

/** What an activity reports: its mood while something is true, and the latest moment it saw. */
export interface PetSignal {
  mood?: MoodId | null;
  moment?: PetMoment | null;
}

export interface PetInput {
  signals: PetSignal[];
  /** Quiet (Do not disturb) is on. */
  dnd: boolean;
  now: number;
  /** Local hour, 0..23 (late at night it yawns). */
  hour: number;
}

export interface PetFrame {
  mood: MoodId;
  moment: PetMoment | null;
  /** Counts up each time a new moment starts (not when a repeat extends it): the view restarts its animation on a change. */
  play: number;
  /** An urgent moment woke it in Quiet. */
  startled: boolean;
}

/** How long each moment plays, ms. */
export const MOMENT_MS: Record<MomentId, number> = {
  'volume-up': 1600, 'volume-down': 1600, muted: 2200, 'audio-device': 2600,
  track: 2400, paused: 2400, played: 2200,
  plugged: 2400, unplugged: 2000, full: 3200, 'battery-low': 3000, 'battery-critical': 4000,
  offline: 2800, online: 2600, 'vpn-on': 2600, 'vpn-off': 2200, 'usb-in': 2600, 'usb-out': 2200,
  'cpu-spike': 3000, 'ram-spike': 3000, 'call-start': 2400, 'mic-muted': 2200,
  screenshot: 1600, copy: 1500, 'download-done': 2800,
  'timer-start': 2000, 'focus-start': 2200, 'break-start': 2600, 'timer-done': 4000,
  'meeting-soon': 3000, rain: 3200, 'game-start': 2600, 'new-server': 2600,
  'good-news': 3000, 'bad-news': 3200, warning: 3000, info: 2800, payment: 3000,
  'claude-asks': 3500, 'claude-done': 2400, 'claude-error': 3000, 'limits-reset': 3000,
  answered: 2000, updated: 3000, yawn: 2400,
};

/** Moments that play even in Quiet, startling the bot awake. */
export const URGENT_MOMENTS: ReadonlySet<MomentId> = new Set<MomentId>(['claude-asks', 'timer-done', 'battery-critical']);

/** Between two late-night yawns. */
const YAWN_MIN_MS = 120_000;
const YAWN_MAX_MS = 240_000;

const lateNight = (hour: number) => hour >= 23 || hour < 5;

export class PetBrain {
  private playing: { moment: PetMoment; until: number; startled: boolean } | null = null;
  private plays = 0;
  /** The newest moment time handled per key, so a report seen again is never replayed. */
  private readonly seen = new Map<string, number>();
  private nextYawn = 0;

  constructor(private readonly random: () => number = Math.random) {}

  update(input: PetInput): PetFrame {
    const { now } = input;
    const reported = new Set<MoodId>();
    for (const s of input.signals) if (s.mood) reported.add(s.mood);
    if (input.dnd) reported.add('asleep');
    const mood = MOOD_ORDER.find((m) => reported.has(m)) ?? 'idle';

    // New moments in the order they happened; a stale report (older than its own length) is history.
    const fresh = input.signals
      .map((s) => s.moment)
      .filter((m): m is PetMoment => !!m && m.at > (this.seen.get(m.key) ?? -Infinity) && now - m.at < MOMENT_MS[m.id])
      .sort((a, b) => a.at - b.at);
    for (const m of fresh) {
      this.seen.set(m.key, m.at);
      const urgent = URGENT_MOMENTS.has(m.id);
      if (input.dnd && !urgent) continue; // Quiet: it stays asleep
      const same = this.playing !== null && this.playing.moment.key === m.key && this.playing.until > now;
      if (!same) this.plays += 1;
      this.playing = { moment: m, until: m.at + MOMENT_MS[m.id], startled: same ? this.playing!.startled : input.dnd && urgent };
    }
    if (this.playing && this.playing.until <= now) this.playing = null;

    // Late at night a resting bot yawns now and then.
    if (mood === 'idle' && lateNight(input.hour)) {
      if (!this.playing) {
        if (!this.nextYawn) this.nextYawn = now + YAWN_MIN_MS + this.random() * (YAWN_MAX_MS - YAWN_MIN_MS);
        else if (now >= this.nextYawn) {
          this.nextYawn = 0;
          this.plays += 1;
          this.playing = { moment: { id: 'yawn', key: 'yawn', at: now }, until: now + MOMENT_MS.yawn, startled: false };
        }
      }
    } else {
      this.nextYawn = 0;
    }

    return { mood, moment: this.playing?.moment ?? null, play: this.plays, startled: this.playing?.startled ?? false };
  }
}
