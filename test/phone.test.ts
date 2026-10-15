import { describe, expect, it } from 'vitest';
import { isEcho } from '../src/activities/phone';

describe('phone notifications', () => {
  it("skips Island's own pushes coming back from the phone's ntfy app", () => {
    expect(isEcho({ app: 'ntfy' })).toBe(true);
    expect(isEcho({ app: ' NTFY ' })).toBe(true);
    expect(isEcho({ app: 'Messages' })).toBe(false);
    expect(isEcho({ app: '' })).toBe(false);
  });
});
