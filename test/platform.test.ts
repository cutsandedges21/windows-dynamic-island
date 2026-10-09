import { describe, expect, it } from 'vitest';
import { CATALOG_BY_ID } from '../src/activities/catalog';
import { availableHere, ctrlKey, detectPlatform, optionHere, thisComputer, unavailableReason } from '../src/core/platform';

describe('platform', () => {
  it('reads the system from the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('macos');
  });

  it('everything runs on Windows', () => {
    for (const id of ['claude', 'music', 'game', 'timer']) expect(availableHere(id, 'windows')).toBe(true);
  });

  it('a Mac runs the OS-free activities and labels the rest', () => {
    for (const id of ['timer', 'weather', 'calendar', 'downloads', 'ask', 'local', 'github', 'notion']) expect(availableHere(id, 'macos')).toBe(true);
    expect(unavailableReason('music', 'macos')).toBe('Coming to Mac');
    expect(unavailableReason('claude', 'macos')).toBe('Coming to Mac');
    expect(unavailableReason('game', 'macos')).toBe('Windows only');
  });

  it('names the computer and its keys the way each system does', () => {
    expect(thisComputer('windows')).toBe('this PC');
    expect(thisComputer('macos')).toBe('this Mac');
    expect(ctrlKey('windows')).toBe('Ctrl');
    expect(ctrlKey('macos')).toBe('Control');
  });

  it('a Mac is not offered the Windows-only options, like Calendar reading Windows accounts', () => {
    const source = CATALOG_BY_ID.get('calendar')!.options.find((o) => o.key === 'source')!;
    expect(optionHere(source, 'windows')).toBe(true);
    expect(optionHere(source, 'macos')).toBe(false);
    const link = CATALOG_BY_ID.get('calendar')!.options.find((o) => o.key === 'ics')!;
    expect(optionHere(link, 'macos')).toBe(true);
  });

  it('activities a Mac can run never say "this PC" in their description', () => {
    for (const [id, meta] of CATALOG_BY_ID) {
      if (!availableHere(id, 'macos')) continue;
      expect(meta.description, id).not.toMatch(/this PC/);
    }
  });
});
