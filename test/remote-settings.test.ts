// Settings › Your phone's words (src/remote/settings.ts): the steps beside the code, when a phone
// was last there, and the code's countdown.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', () => ({ native: {}, on: async () => () => {} }));

import { PHONE_SITE } from '../src/remote/protocol';
import { codeLeft, PAIR_STEPS, phoneDetail, seenText, SITE_HOST } from '../src/remote/settings';

describe('Settings › Your phone', () => {
  it("names the phone site from PHONE_SITE, so a rename touches protocol.ts only", () => {
    expect(SITE_HOST).toBe(new URL(PHONE_SITE).host);
    expect(SITE_HOST).not.toContain('/');
    expect(PAIR_STEPS[0]).toContain(`open ${SITE_HOST} in Safari`);
    expect(PAIR_STEPS).toHaveLength(3);
  });

  it('says when a phone was last there', () => {
    const now = new Date(2026, 9, 22, 16, 30).getTime();
    expect(seenText({ connected: true, lastSeen: now - 5000 }, now)).toBe('Connected now');
    expect(seenText({ connected: false, lastSeen: null }, now)).toBe('Not connected yet');
    expect(seenText({ connected: false, lastSeen: new Date(2026, 9, 22, 14, 14).getTime() }, now)).toBe('Last seen 2:14 PM');
    expect(seenText({ connected: false, lastSeen: new Date(2026, 9, 21, 9, 3).getTime() }, now)).toBe('Last seen yesterday at 9:03 AM');
    expect(seenText({ connected: false, lastSeen: new Date(2026, 9, 2, 9, 3).getTime() }, now)).toBe('Last seen Oct 2');
    const p = { id: 'x', name: 'iPhone', pairedAt: 0, lastSeen: null, connected: true, push: true };
    expect(phoneDetail(p, now)).toBe('Connected now · Notifications: On');
    expect(phoneDetail({ ...p, push: false }, now)).toBe('Connected now · Notifications: Off');
  });

  it("counts the code's ten minutes down", () => {
    expect(codeLeft(1_000_000 + 10 * 60_000, 1_000_000)).toBe('This code works for 10:00 more.');
    expect(codeLeft(1_000_000 + 61_000, 1_000_000)).toBe('This code works for 1:01 more.');
    expect(codeLeft(1_000_000, 1_000_500)).toBe('This code works for 0:00 more.');
  });
});
