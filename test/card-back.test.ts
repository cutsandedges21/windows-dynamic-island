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
    expect(withBack(own).view.blocks[0]).toMatchObject({ back: { key: 'b', action: 'act:music:lyrics-back' } });
  });

  it("drops the card's own Control Center button, which did what Back does (Justin: the grid icon at the right)", () => {
    const c = withBack(card([{ t: 'head', key: 'h', title: 'Apps', buttons: [{ key: 'edit', label: 'Edit', action: 'edit' }, { key: 'back', icon: 'grid', action: 'island:card-close' }] }]));
    expect(c.view.blocks[0]).toMatchObject({ back: { icon: 'chevron-left' }, buttons: [{ key: 'edit' }] });
    expect((c.view.blocks[0] as { buttons: unknown[] }).buttons).toHaveLength(1);
    const only = withBack(card([{ t: 'head', key: 'h', title: 'Reminders', buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close' }] }]));
    expect((only.view.blocks[0] as { buttons?: unknown[] }).buttons).toBeUndefined();
  });

  it('with no head, a Control Center button goes first', () => {
    const c = withBack(card([{ t: 'text', key: 't', text: 'x' }]));
    expect(c.view.blocks[0]).toMatchObject({ t: 'buttons', items: [{ action: 'island:card-close', label: 'Control Center' }] });
  });
});
