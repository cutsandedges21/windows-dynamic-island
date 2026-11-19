// Land on screen (Justin, 2026-11-18): the offer's text on the pill can be clicked, and the row of
// computers keeps its avatars round and its names whole on a card taller than the screen allows.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles/island.css'), 'utf8').replace(/\r\n/g, '\n');
const renderer = readFileSync(resolve(__dirname, '../src/core/renderer.ts'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`\n${sel} {`);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
};

describe('Land on screen', () => {
  it("the pill gives text with an action its click (the offer's who and what), and the pointer shows it", () => {
    const text = renderer.indexOf("case 'text': {");
    expect(renderer.slice(text, renderer.indexOf("case 'progress':", text))).toContain('e.dataset.action = seg.action');
    expect(css).toContain('.seg-text[data-action] { cursor: pointer; }');
  });

  it('the rows that scroll sideways keep their height: avatars stay round, names and "Waiting" whole', () => {
    // A sideways scroller counts as 0 px tall to the card's flex column, so it took all the squeeze.
    expect(rule('.sb-people')).toContain('flex-shrink: 0;');
    expect(rule('.sb-files')).toContain('flex-shrink: 0;');
    expect(rule('.sb-people .av')).toContain('flex: none;');
  });

  it("an avatar's badge is dark on the accent, so it shows on a white accent too", () => {
    expect(rule('.sb-people .pbadge')).toContain('color: #1a0c06;');
  });
});
