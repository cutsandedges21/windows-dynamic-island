// Settings › Your phone's words (src/remote/settings.ts): the steps beside the code, when a phone
// was last there, and the code's countdown.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/native', () => ({ native: {}, on: async () => () => {} }));

import { defaultSettings } from '../src/core/settings';
import { PHONE_SITE, type TermInfo } from '../src/remote/protocol';
import { codeLeft, PAIR_STEPS, phoneDetail, screenWords, seenText, SITE_HOST, termDetail, termHelp } from '../src/remote/settings';

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

  it('Terminal from your phone says what it allows, and why phones get none while Windows Hello guards Allow', () => {
    const s = defaultSettings();
    expect(termHelp(s)).toBe('A paired phone can open a terminal on this PC and run any command.');
    s.activities.config.claude.options.requireHello = true;
    expect(termHelp(s)).toBe('A paired phone can open a terminal on this PC and run any command.');
    s.general.phoneTerminal = true;
    expect(termHelp(s)).toBe('A paired phone can open a terminal on this PC and run any command. Off for phones while Windows Hello is asked before Allow (Activities › Claude Code).');
  });

  it('lists each terminal: who started it, whether it runs, where', () => {
    const t: TermInfo = { id: 'a1b2c3d4', title: 'PowerShell', cwd: 'C:\\Users\\moss', shell: 'powershell', pid: 1, started: new Date(2026, 9, 28, 14, 14).getTime(), exit: null, attached: 1, claude: false };
    expect(termDetail(t)).toBe('Running since 2:14 PM · Open on your phone · C:\\Users\\moss');
    expect(termDetail({ ...t, claude: true, attached: 0, exit: 0, cwd: 'C:\\code\\app' })).toBe('Claude chat · Ended, exit code 0 · C:\\code\\app');
  });

  it('says whether Chrome Remote Desktop is ready, or how to set it up', () => {
    expect(screenWords('ready')).toMatchObject({ title: 'Chrome Remote Desktop: ready', button: 'Open' });
    expect(screenWords('off')).toMatchObject({ title: 'Chrome Remote Desktop: not set up', button: 'Set it up' });
    expect(screenWords('off').help).toContain('installed but turned off');
    expect(screenWords('missing')).toMatchObject({ title: 'Chrome Remote Desktop: not set up', button: 'Set it up' });
    expect(screenWords('missing').help).toContain('remotedesktop.google.com/access');
    expect(screenWords(null).title).toBe('Chrome Remote Desktop');
  });
});
