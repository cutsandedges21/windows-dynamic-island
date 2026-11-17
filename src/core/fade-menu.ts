// The right-click menu's Fade, opened (Justin): the pill says "Fade the island" with a way back to
// the menu, and the card under it has fading now first, then how long a tap of Ctrl keeps the island
// faded and Smart fade, the two settings from Settings › Behavior, to change on the spot.

import type { Seg } from './segments';
import type { SheetView } from './sheet';

export interface FadeMenuState {
  /** Faded by the menu now (until Show). */
  faded: boolean;
  /** A tap of Ctrl keeps it faded until the pointer comes back, not just until it moves off. */
  peekUntilBack: boolean;
  smartFade: boolean;
}

/** The pill while the Fade card shows: back to the menu, then what this is. */
export function fadeSegments(vertical: boolean): Seg[] {
  const segs: Seg[] = [
    { t: 'button', key: 'fade/back', icon: 'chevron-left', action: 'island:menu', style: 'ghost', prio: 0, tip: 'Back' },
    { t: 'icon', key: 'fade/icon', icon: 'fade', tone: 'muted', prio: 1 },
  ];
  if (!vertical) segs.push({ t: 'text', key: 'fade/text', text: 'Fade the island', weight: 'semibold', prio: 2 });
  return segs;
}

/** The card: fade now (or show), then the two ways the island fades on its own. */
export function fadeSheet(s: FadeMenuState): SheetView {
  return {
    key: 'island/fade',
    blocks: [
      { t: 'head', key: 'head', icon: 'fade', title: 'Fade the island', sub: 'It goes faint and clicks go through it to what is behind.' },
      {
        t: 'choices',
        key: 'now',
        items: [
          s.faded
            ? { key: 'show', label: 'Show the island', detail: 'Bring it back now', action: 'island:fade' }
            : { key: 'fade', label: 'Fade now', detail: 'Until you right-click it and press Show', action: 'island:fade' },
        ],
      },
      { t: 'text', key: 'lasts-label', text: 'A tap of Ctrl keeps it faded', tone: 'muted', size: 'sm' },
      {
        t: 'choices',
        key: 'lasts',
        items: [
          { key: 'off', label: 'Until the pointer moves off', selected: !s.peekUntilBack, action: 'island:peek-lasts', arg: 'off' },
          { key: 'back', label: 'Until it comes back', detail: 'Moved away, then back onto the island', selected: s.peekUntilBack, action: 'island:peek-lasts', arg: 'back' },
        ],
      },
      {
        t: 'choices',
        key: 'smart',
        items: [
          {
            key: 'smart',
            label: s.smartFade ? 'Smart fade: on' : 'Smart fade: off',
            detail: 'Faded until you point at it. Pop-ups, like a finished chat, still show in full.',
            selected: s.smartFade,
            action: 'island:smart-fade',
          },
        ],
      },
    ],
  };
}
