// Which light runs round the pill's edge. Its own activity's, unless an activity
// behind it keeps a light on (Claude running: blue all the time), or something
// behind is busy while the pill's own activity has no light.

import type { ActivityStatus } from './activity';

type Beam = ActivityStatus['beam'];

/** A light that wants the user (waiting, urgent, a finish flash) stays, even over one kept on from behind. */
function asks(b: Beam): boolean {
  return !!b && (b.urgent === true || b.motion === 'pulse' || b.motion === 'still');
}

/**
 * `ids`: activities in the order they count (the ones on the pill first, then the
 * user's order); `primary` is the one in front.
 */
export function pillBeam(primary: string | null, ids: string[], statuses: Map<string, ActivityStatus>): Beam {
  const own = primary ? (statuses.get(primary)?.beam ?? null) : null;
  if (!asks(own)) {
    for (const id of ids) {
      const st = statuses.get(id);
      if (id !== primary && st?.active && st.beamBehind) return st.beamBehind;
    }
  }
  if (own) return own;
  // Something busy elsewhere may still circle the edge. Only orbits: a fill or a pulse
  // belongs to whatever is on the pill.
  for (const id of ids) {
    const st = statuses.get(id);
    const motion = st?.beam ? (st.beam.motion ?? (st.beam.urgent ? 'pulse' : 'orbit')) : null;
    if (st?.active && st.weight === 'foreground' && motion === 'orbit') return st.beam;
  }
  return null;
}
