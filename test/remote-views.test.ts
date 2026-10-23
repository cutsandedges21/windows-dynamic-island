// What phones are shown and may press (src/remote/views.ts).

import { describe, expect, it } from 'vitest';
import type { ActivityStatus } from '../src/core/activity';
import type { MirrorFrame } from '../src/core/mirror';
import type { Placed } from '../src/core/segments';
import type { SheetView } from '../src/core/sheet';
import { HELLO_GUARDED, mayPress, pressables, stripActions, stripPill, urgentIds } from '../src/remote/views';

const card: SheetView = {
  key: 'mixed',
  blocks: [
    { t: 'head', key: 'h', title: 'Hi', buttons: [{ key: 'x', action: 'act:land:close' }, { key: 'a', action: 'act:claude:allow', arg: 'r1' }] },
    { t: 'buttons', key: 'b', items: [{ key: 'deny', action: 'act:claude:deny', arg: 'r1' }, { key: 'allow', action: 'act:claude:allow', arg: 'r1' }] },
    { t: 'buttons', key: 'only', items: [{ key: 'allow', action: 'act:claude:allow', arg: 'r2' }] },
    { t: 'input', key: 'i', placeholder: 'Reply', action: 'act:claude:reply:r1', engage: 'act:claude:hold:r1' },
    { t: 'choices', key: 'c', items: [{ key: 'o1', label: 'Yes', action: 'act:claude:pick', arg: { requestId: 'r1', q: 0, label: 'Yes' } }] },
    { t: 'rows', key: 'r', items: [{ key: 'f', title: 'photo.jpg', action: 'act:land:open', arg: 'C:\\photo.jpg', button: { key: 'rm', action: 'act:land:unstage', arg: 'C:\\photo.jpg' } }] },
    { t: 'player', key: 'p', art: null, title: 't', artist: 'a', playing: true, position: 1, duration: 9, color: null, actions: { prev: 'act:music:prev', toggle: 'act:music:toggle', next: 'act:music:next', seek: 'act:music:seek' } },
  ],
};

describe('what a phone may press', () => {
  const shown = pressables(card);

  it('is each action with the argument it was shown with', () => {
    expect(mayPress(shown, 'act:claude:deny', 'r1')).toBe(true);
    expect(mayPress(shown, 'act:claude:deny', 'r9')).toBe(false);
    expect(mayPress(shown, 'act:land:close', undefined)).toBe(true);
    expect(mayPress(shown, 'act:land:close', null)).toBe(true);
    expect(mayPress(shown, 'act:land:open', 'C:\\photo.jpg')).toBe(true);
    expect(mayPress(shown, 'act:land:open', 'C:\\Windows\\System32\\cmd.exe')).toBe(false);
    expect(mayPress(shown, 'act:land:unstage', 'C:\\photo.jpg')).toBe(true);
    expect(mayPress(shown, 'act:claude:pick', { requestId: 'r1', q: 0, label: 'Yes' })).toBe(true);
    expect(mayPress(shown, 'act:claude:pick', { requestId: 'r1', q: 0, label: 'No' })).toBe(false);
    expect(mayPress(shown, 'act:nothing:here', undefined)).toBe(false);
  });

  it('takes any text in an input and any time on the scrubber, and the rest only bare', () => {
    expect(mayPress(shown, 'act:claude:reply:r1', 'whatever was typed')).toBe(true);
    expect(mayPress(shown, 'act:claude:hold:r1', null)).toBe(true);
    expect(mayPress(shown, 'act:music:seek', 42.5)).toBe(true);
    expect(mayPress(shown, 'act:music:toggle', undefined)).toBe(true);
    expect(mayPress(shown, 'act:music:toggle', 'C:\\x')).toBe(false);
  });

  it("reads a pill's segments too, an input's cancel included", () => {
    const placed = [
      { seg: { t: 'chip', key: 'chip/land', label: '', action: 'act:land:card' }, x: 0, w: 20 },
      { seg: { t: 'input', key: 'in', placeholder: 'Ask', action: 'act:claude:send', cancel: 'act:claude:cancel-input' }, x: 20, w: 200 },
    ];
    const p = pressables(placed);
    expect(mayPress(p, 'act:land:card', undefined)).toBe(true);
    expect(mayPress(p, 'act:claude:send', 'go on')).toBe(true);
    expect(mayPress(p, 'act:claude:cancel-input', null)).toBe(true);
  });
});

describe('Allow held back from phones', () => {
  const blocked = new Set(HELLO_GUARDED);

  it("takes Claude's Allow out of every card, and a row of buttons that held only it", () => {
    const out = stripActions(card, blocked);
    expect(JSON.stringify(out)).not.toContain('act:claude:allow');
    expect(out.blocks.find((b) => b.key === 'only')).toBeUndefined();
    expect(JSON.stringify(out)).toContain('act:claude:deny');
    expect(out.blocks).toHaveLength(card.blocks.length - 1);
    // Nothing to take out: the same card.
    expect(stripActions(card, new Set())).toBe(card);
  });

  it('leaves tiles and rows in place, not pressable', () => {
    const grid: SheetView = {
      key: 'g',
      blocks: [{ t: 'tiles', key: 't', cols: 4, rows: 1, pages: 1, cell: 80, items: [{ key: 'claude/c', action: 'act:claude:allow', body: { k: 'actions', label: 'x', buttons: [{ key: 'a', action: 'act:claude:allow' }, { key: 'd', action: 'act:claude:deny' }] } }] }],
    };
    const out = stripActions(grid, blocked);
    const tile = out.blocks[0].t === 'tiles' ? out.blocks[0].items[0] : null;
    expect(tile?.action).toBeUndefined();
    expect(tile?.body.k === 'actions' ? tile.body.buttons.map((b) => b.action) : []).toEqual(['act:claude:deny']);
  });

  it('takes such a segment off the pill', () => {
    const frame = { sig: 's', placed: [{ seg: { t: 'button', key: 'b', action: 'act:claude:allow' }, x: 0, w: 10 }, { seg: { t: 'text', key: 't', text: 'hi' }, x: 10, w: 10 }] as unknown as Placed[] } as MirrorFrame;
    expect(stripPill(frame, blocked).placed).toHaveLength(1);
    expect(stripPill(frame, new Set())).toBe(frame);
  });
});

describe('urgent cards on a phone', () => {
  it("are every activity's urgent moment nobody tapped away, in the user's order", () => {
    const st = new Map<string, ActivityStatus>([
      ['land', { active: true, urgent: { key: 'ask:t1' } }],
      ['claude', { active: true, urgent: { key: 'perm:r1' } }],
      ['music', { active: true }],
      ['timer', { active: true, urgent: { key: 'done' } }],
    ]);
    expect(urgentIds(['claude', 'music', 'timer', 'land'], st, new Set(['timer:done']))).toEqual(['claude', 'land']);
    expect(urgentIds(['weather'], st, new Set())).toEqual([]);
  });
});
