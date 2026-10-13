// The card's blocks and the island's own elements share one page: their class names must not meet.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISLAND_CLASSES, textClass } from '../src/core/sheet';

describe('card blocks', () => {
  it("a boxed message (a chat's last words, an answer) never takes a class of the island's own elements", () => {
    for (const bubble of [false, true]) {
      const classes = textClass({ t: 'text', key: 'm', text: 'x', bubble }).split(' ');
      for (const c of ISLAND_CLASSES) expect(classes, c).not.toContain(c);
    }
    expect(textClass({ t: 'text', key: 'm', text: 'x', bubble: true }).split(' ')).toContain('boxed');
    // The boxed look is styled under the name the renderer gives it.
    expect(readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8')).toContain('.sb-text.boxed .tx');
  });
});
