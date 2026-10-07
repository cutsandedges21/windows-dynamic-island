// The island's visual effects, ported from four MIT libraries into framework-free TypeScript:
// a bot avatar (bloub), thinking orbs, a travelling border beam and a liquid goo filter.
// Import from here; the folders behind it are implementation.

export { BotAvatar, type BotAvatarOptions } from './bot/avatar';
export {
  BOT_COLORS,
  BOT_SHAPES,
  BOT_STATES,
  ISLAND_SKIN,
  botStateFor,
  type BotColor,
  type BotMood,
  type BotShape,
  type BotSkin,
  type BotState,
} from './bot/catalog';

export { ThinkingOrb, type ThinkingOrbOptions } from './orbs/orb';
export { ORB_STATES, type OrbState, type OrbTheme } from './orbs/states';

export { attachBorderBeam, type BorderBeam, type BorderBeamOptions } from './beam';
export { ensureGooeyFilter } from './gooey';
