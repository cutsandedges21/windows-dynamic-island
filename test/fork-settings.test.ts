// Both forks' whole saved settings files, loaded with every migration the merged branches added:
// System Controls (Sound, Brightness, Caps Lock), System Stats' priority and "On the pill",
// hover-cards' Grows, the timer's Quiet clean-up and the Glass slider. Each fixture is that fork's
// defaultSettings() with a user's changes on top (Moss's 0.4.2 at 9bf7ae2, Justin's 0.2.11 at 28ea7ab).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/activities/catalog';
import { parseOrder, pickedStats } from '../src/activities/system';
import { GLASS_DEFAULT } from '../src/core/glass';
import { hoverGrows } from '../src/core/grow';
import { growsOf, migrate, SETTINGS_VERSION, type Settings } from '../src/core/settings';

const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const grows = (s: Settings, id: string) => growsOf(s.activities.config[id], s.island.defaultGrows, id);

describe("Moss's 0.4.2 settings file", () => {
  const s = migrate(load('settings-moss-0.4.2.json'));

  it('keeps the island as it was, with the glass it had', () => {
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.general).toMatchObject({ dnd: true, onboarded: true, toggleHotkey: 'Alt+Shift+Space' });
    expect(s.island).toMatchObject({ color: 'glass', glass: GLASS_DEFAULT, hoverCard: 'claude', glow: 'medium', defaultGrows: 'card' });
    expect(s.island.menu).toMatchObject({ quiet: true, hide: true });
  });

  it('Sound, Brightness and Caps Lock become System Controls, in Sound\'s place', () => {
    const sc = s.activities.config['system-controls'];
    expect(sc).toMatchObject({ enabled: true, priority: 'medium', interactive: true, options: { volume: true, device: true, brightness: false, caps: true, num: false } });
    expect(sc.grows).toBeUndefined();
    for (const id of ['sound', 'brightness', 'keys']) {
      expect(s.activities.config[id]).toBeUndefined();
      expect(s.activities.order).not.toContain(id);
    }
    expect(s.activities.order.indexOf('system-controls')).toBe(s.activities.order.indexOf('battery') + 1);
    expect(s.activities.order).toHaveLength(CATALOG.length);
  });

  it('Control Center keeps its tiles, renamed, and their sizes', () => {
    expect(s.island.grid.pages).toEqual([['music/music', 'system-controls/sound', 'system-controls/brightness', null, 'timer/timer']]);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1', 'timer/timer': '1x1' });
    // Caps Lock never had a tile: hiding it hides nothing now.
    expect(s.island.grid.hidden).toEqual([]);
  });

  it('System Stats keeps the stats picked for the pill, in the default priority', () => {
    const o = s.activities.config.system.options;
    expect(s.activities.config.system.enabled).toBe(true);
    expect(o.show).toEqual(['cpu', 'ram']);
    expect(pickedStats(o.show, parseOrder(o.order))).toEqual(['cpu', 'mem']);
    expect(o.hoverCard).toBe(true);
  });

  it("keeps the timer's lengths and the flag the timer clears Quiet with", () => {
    expect(s.activities.config.timer.options).toMatchObject({ focusMinutes: 50, breakMinutes: 5, quietByFocus: true });
  });

  it("nothing saved how it grows: Claude's card with more, the rest grow into a card", () => {
    expect(grows(s, 'claude')).toBe('more');
    expect(grows(s, 'weather')).toBe('card');
    expect(grows(s, 'system-controls')).toBe('card');
    // This music had "Player on hover" off: pointing at it widens the pill.
    expect(s.activities.config.music.options.hoverPlayer).toBe(false);
    expect(hoverGrows('music', grows(s, 'music'), s.activities.config.music.options)).toBe('wide');
  });

  it("Claude Code is Claude now (shown as Claude Status): still on, his options as he had them, Claude Status's switches at their defaults", () => {
    expect(s.activities.config.claudeStatus).toBeUndefined();
    expect(s.activities.order).not.toContain('claudeStatus');
    expect(s.activities.order[0]).toBe('claude');
    expect(s.activities.config.claude).toMatchObject({
      enabled: true, priority: 'high', persistent: true, interrupt: true,
      options: { resetAlerts: true, sessionHotkeys: true, notifications: true, phone: true, showLimits: true, showDesktop: true, finishedSeconds: 8, onlyOtherChats: false, replyWindowSeconds: 0, requireHello: false },
    });
    // His saved 45 s Reply window (Claude Code's old default) went off once, with settings version 6.
    expect(s.activities.config.claude.options).toMatchObject({ showDone: true, showAutoModel: true, glowInFront: true, permissions: true, questions: true, replyBox: true });
    // The heading over Claude Code's options holds no value.
    expect('code' in s.activities.config.claude.options).toBe(false);
  });

  it('loading it again changes nothing', () => {
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("Justin's 0.2.11 settings file", () => {
  const s = migrate(load('settings-justin-0.2.11.json'));

  it('keeps his glass, and Sideways as what pointing does', () => {
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.island).toMatchObject({ color: 'glass', glass: 40, defaultGrows: 'wide', hoverCard: 'pointer' });
    // Moss's settings he never had start at their defaults.
    expect(s.island.menu).toMatchObject({ quiet: true, hide: true });
    expect(s.island.hiddenUntil).toBe(0);
  });

  it("Sound becomes System Controls with its switch, buttons, priority and Grows; the parts he didn't have start on", () => {
    const sc = s.activities.config['system-controls'];
    expect(sc).toMatchObject({ enabled: true, priority: 'high', interactive: false, grows: 'card', options: { volume: true, device: true, brightness: true, caps: true, num: true } });
    expect(s.activities.config.sound).toBeUndefined();
    expect(s.activities.order.indexOf('system-controls')).toBe(s.activities.order.indexOf('battery') + 1);
    expect(s.island.grid.pages).toEqual([['music/music', 'system-controls/sound', null, 'battery/battery', 'timer/timer']]);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1' });
  });

  it('System Stats keeps his priority, expanded switches and hover card, with nothing picked for the pill', () => {
    const o = s.activities.config.system.options;
    expect(parseOrder(o.order)).toEqual(['gpu', 'cpu', 'mem']);
    expect(o).toMatchObject({ expandedCpu: true, expandedRam: true, expandedGpu: false, hoverCard: false });
    expect(pickedStats(o.show, parseOrder(o.order))).toEqual([]);
  });

  it("keeps the timer dial's length", () => {
    expect(s.activities.config.timer.options).toMatchObject({ timerSeconds: 5430, focusMinutes: 25 });
  });

  it('keeps how each activity grows; anything else follows his Sideways', () => {
    expect(grows(s, 'music')).toBe('card');
    expect(hoverGrows('music', grows(s, 'music'), s.activities.config.music.options)).toBe('card');
    expect(grows(s, 'claude')).toBe('wide');
    expect(grows(s, 'system-controls')).toBe('card');
    expect(grows(s, 'weather')).toBe('wide');
  });

  it("his Claude Code and Claude Status are one Claude, on, in Claude Code's place, with both one's options", () => {
    expect(s.activities.config.claudeStatus).toBeUndefined();
    expect(s.activities.order).not.toContain('claudeStatus');
    expect(s.activities.order[0]).toBe('claude');
    expect(s.activities.config.claude).toMatchObject({
      enabled: true, priority: 'high', autoShow: true, persistent: true, interactive: true, interrupt: true, grows: 'wide',
      options: { showDone: true, showAutoModel: true, glowInFront: true, finishedSeconds: 8, replyWindowSeconds: 0, requireHello: false, sessionHotkeys: true },
    });
  });

  it("Claude Status's switches he turned off stay off", () => {
    const saved = load('settings-justin-0.2.11.json') as { activities: { config: Record<string, { options: Record<string, unknown> }> } };
    saved.activities.config.claudeStatus.options = { showDone: false, showAutoModel: false, glowInFront: false };
    expect(migrate(saved).activities.config.claude.options).toMatchObject({ showDone: false, showAutoModel: false, glowInFront: false });
  });

  it('loading it again changes nothing', () => {
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('Claude Code and Claude Status become one activity', () => {
  type Saved = { activities: { order: string[]; config: Record<string, Record<string, unknown>> }; island: { grid: Record<string, unknown> } };
  const justin = () => load('settings-justin-0.2.11.json') as Saved;

  it("only Claude Status on: Claude is on with its priority, behaviour, Grows, place and tile, and keeps Claude Code's options", () => {
    const saved = justin();
    saved.activities.config.claude.enabled = false;
    saved.activities.config.claudeStatus = { ...saved.activities.config.claudeStatus, priority: 'low', persistent: true, autoShow: false, grows: 'card' };
    saved.island.grid = { order: [], sizes: { 'claudeStatus/claudeStatus': '2x2', 'claude/claude': '2x1' }, hidden: [], pages: [['music/music', 'claude/claude', 'claudeStatus/claudeStatus']] };
    const s = migrate(saved);
    expect(s.activities.config.claude).toMatchObject({ enabled: true, priority: 'low', persistent: true, autoShow: false, grows: 'card', options: { finishedSeconds: 8, showDone: true } });
    expect(s.activities.order.indexOf('claude')).toBe(s.activities.order.indexOf('system') + 1);
    expect(s.activities.order.filter((id) => id === 'claude')).toHaveLength(1);
    expect(s.island.grid.pages).toEqual([['music/music', 'claude/claude']]);
    expect(s.island.grid.sizes).toEqual({ 'claude/claude': '2x2' });
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("both on, or Claude Code alone: Claude Code's behaviour, place and tile; Claude Status's tile goes", () => {
    const saved = justin();
    saved.island.grid = { order: [], sizes: { 'claudeStatus/claudeStatus': '2x2', 'claude/claude': '2x1' }, hidden: ['claudeStatus'], pages: [['claudeStatus/claudeStatus', 'claude/claude']] };
    const s = migrate(saved);
    expect(s.activities.config.claude).toMatchObject({ enabled: true, priority: 'high', grows: 'wide' });
    expect(s.island.grid.pages).toEqual([['claude/claude']]);
    expect(s.island.grid.sizes).toEqual({ 'claude/claude': '2x1' });
    expect(s.island.grid.hidden).toEqual([]);
    saved.activities.config.claudeStatus.enabled = false;
    expect(migrate(saved).activities.config.claude).toMatchObject({ enabled: true, priority: 'high' });
  });

  it('both off: off', () => {
    const saved = justin();
    saved.activities.config.claude.enabled = false;
    saved.activities.config.claudeStatus.enabled = false;
    expect(migrate(saved).activities.config.claude.enabled).toBe(false);
  });
});

describe('settings version 6: the Reply window', () => {
  const withReply = (version: number, seconds: number) => {
    const saved = load('settings-moss-0.4.2.json') as { version: number; activities: { config: Record<string, { options: Record<string, unknown> }> } };
    saved.version = version;
    saved.activities.config.claude.options.replyWindowSeconds = seconds;
    return migrate(saved).activities.config.claude.options.replyWindowSeconds;
  };

  it("the old 45 s default goes off once; a length someone chose stays, and so does 45 chosen after", () => {
    expect(withReply(5, 45)).toBe(0);
    expect(withReply(5, 60)).toBe(60);
    expect(withReply(6, 45)).toBe(45);
  });
});

describe('a new install', () => {
  it("Claude gets Claude Status's defaults: medium and persistent", () => {
    const claude = CATALOG.find((m) => m.id === 'claude')!;
    expect(claude.priority).toBe('medium');
    expect(claude.behavior).toMatchObject({ persistent: true, interrupt: true });
  });
});
