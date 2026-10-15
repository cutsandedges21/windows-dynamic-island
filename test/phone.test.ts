import { describe, expect, it } from 'vitest';
import { isEcho } from '../src/activities/phone';
import { newPhoneTopic } from '../src/core/settings';

describe('phone notifications', () => {
  it("skips Island's own pushes coming back from the phone's ntfy app", () => {
    expect(isEcho({ app: 'ntfy' })).toBe(true);
    expect(isEcho({ app: ' NTFY ' })).toBe(true);
    expect(isEcho({ app: 'Messages' })).toBe(false);
    expect(isEcho({ app: '' })).toBe(false);
  });

  it('makes a long random topic, the only key to the pushes', () => {
    const a = newPhoneTopic();
    expect(a).toMatch(/^island-[0-9a-f]{24}$/);
    expect(newPhoneTopic()).not.toBe(a);
  });
});
