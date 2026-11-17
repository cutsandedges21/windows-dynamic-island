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

/**
 * The card, laid out like Hide's: one list, a row each. Fade now (or Show), then the two ways the
 * island fades on its own, each one row with its choices side by side (Justin: not two rows).
 */
export function fadeSheet(s: FadeMenuState): SheetView {
  return {
    key: 'island/fade',
    blocks: [
      { t: 'head', key: 'head', icon: 'fade', title: 'Fade the island', sub: 'It goes faint and clicks go through it to what is behind.' },
      {
        t: 'choices',
        key: 'for',
        items: [
          s.faded
            ? { key: 'show', label: 'Show the island', detail: 'Bring it back now', action: 'island:fade' }
            : { key: 'fade', label: 'Fade now', detail: 'Until you right-click it and press Show', action: 'island:fade' },
          {
            key: 'lasts',
            label: 'Peek lasts',
            detail: 'How long a Ctrl tap fades it',
            action: '',
            options: [
              { key: 'off', label: 'Until the pointer moves off', selected: !s.peekUntilBack, action: 'island:peek-lasts', arg: 'off' },
              { key: 'back', label: 'Until it comes back', selected: s.peekUntilBack, action: 'island:peek-lasts', arg: 'back' },
            ],
          },
          {
            key: 'smart',
            label: 'Smart fade',
            detail: 'Faded until you point at it; pop-ups still show',
            action: '',
            options: [
              { key: 'off', label: 'Off', selected: !s.smartFade, action: 'island:smart-fade', arg: false },
              { key: 'on', label: 'On', selected: s.smartFade, action: 'island:smart-fade', arg: true },
            ],
          },
        ],
      },
    ],
  };
}
