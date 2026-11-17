// A card opened from Control Center always has a way back to it (Justin: Phone's card had none).

import { describe, expect, it } from 'vitest';
import { withBack } from '../src/core/island';
import type { SheetView } from '../src/core/sheet';

const card = (blocks: SheetView['blocks']) => ({ owner: 'phone', view: { key: 'open', blocks } });

describe('a card opened from Control Center', () => {
  it('gets Back before its title', () => {
    const c = withBack(card([{ t: 'head', key: 'h', title: 'Phone', sub: 'No notifications' }, { t: 'text', key: 't', text: 'x' }]));
    expect(c.view.blocks[0]).toMatchObject({ t: 'head', title: 'Phone', back: { action: 'island:card-close', icon: 'chevron-left' } });
    expect(c.view.blocks).toHaveLength(2);
  });

  it("keeps the activity's own Back", () => {
    const own = card([{ t: 'head', key: 'h', title: 'Lyrics', back: { key: 'b', action: 'act:music:lyrics-back' } }]);
    expect(withBack(own)).toBe(own);
  });

  it('with no head, a Control Center button goes first', () => {
    const c = withBack(card([{ t: 'text', key: 't', text: 'x' }]));
    expect(c.view.blocks[0]).toMatchObject({ t: 'buttons', items: [{ action: 'island:card-close', label: 'Control Center' }] });
  });
});
