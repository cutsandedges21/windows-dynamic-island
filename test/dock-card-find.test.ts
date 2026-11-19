import { describe, expect, it } from 'vitest';
import { keepBefore } from '../src/core/dock';

/** A tiny stand-in for a parent element: its children in order, and how often one was moved. */
function parentOf(...names: string[]) {
  const kids: Array<{ name: string; parentNode: unknown; nextSibling: unknown }> = [];
  const parent = {
    moves: 0,
    kids,
    insertBefore(node: unknown, before: unknown) {
      parent.moves++;
      const n = node as (typeof kids)[number];
      const at = kids.indexOf(n);
      if (at >= 0) kids.splice(at, 1);
      kids.splice(kids.indexOf(before as (typeof kids)[number]), 0, n);
      link();
      return node;
    },
  };
  const link = () =>
    kids.forEach((k, i) => {
      k.parentNode = parent;
      k.nextSibling = kids[i + 1] ?? null;
    });
  for (const name of names) kids.push({ name, parentNode: null, nextSibling: null });
  link();
  const get = (name: string) => kids.find((k) => k.name === name)! as unknown as Node;
  const order = () => kids.map((k) => k.name).join(' ');
  return { parent: parent as typeof parent & Pick<Node, 'insertBefore'>, get, order };
}

describe('the Apps card keeps its search field in place while typing', () => {
  it('does not move the field when it is already where it belongs (moving it takes the keyboard off it)', () => {
    const { parent, get, order } = parentOf('head', 'find', 'grid', 'empty', 'found');
    for (let i = 0; i < 5; i++) keepBefore(parent, get('find'), get('grid'));
    expect(parent.moves).toBe(0);
    expect(order()).toBe('head find grid empty found');
  });

  it('moves it under the apps when Edit is pressed, and back over them after Done', () => {
    const { parent, get, order } = parentOf('head', 'find', 'grid', 'empty', 'found');
    keepBefore(parent, get('find'), get('found'));
    expect(order()).toBe('head grid empty find found');
    keepBefore(parent, get('find'), get('found'));
    expect(parent.moves).toBe(1);
    keepBefore(parent, get('find'), get('grid'));
    expect(order()).toBe('head find grid empty found');
    expect(parent.moves).toBe(2);
  });
});
