// Who an agent is, for everything the shared engine says and draws about it.

import type { MomentId } from '../../core/pet';
import type { Tone } from '../../core/segments';

export interface AgentBrand {
  /** The activity id, and the `agent` island-hook stamps on its hook events. */
  id: 'claude' | 'codex' | 'cursor' | 'antigravity';
  /** The short name in sentences: "Claude finished", "Codex is asking". */
  name: string;
  /** The product, where a chat has no title of its own: "Claude Code", "Codex". */
  product: string;
  /** Its mark (src/core/icons.ts). */
  icon: string;
  /** Its colour on the pill. Orange is Claude's alone. */
  tone: Tone;
  /** How the bot reacts (src/core/looks.ts). */
  moments: { asks: MomentId; done: MomentId; error: MomentId };
}
