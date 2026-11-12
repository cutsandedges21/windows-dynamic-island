// Sound, Brightness and Caps Lock became one activity, System Controls: saved settings from
// both forks (Moss's 0.4.2 had all three, Justin's 0.2.11 only Sound) keep what they said.

import { describe, expect, it } from 'vitest';
import { CATALOG_BY_ID } from '../src/activities/catalog';
import { createRegistry } from '../src/activities/registry';
import { migrate } from '../src/core/settings';

const cfg = (enabled: boolean, over: Record<string, unknown> = {}) => ({ enabled, priority: 'low', autoShow: true, persistent: false, interactive: false, interrupt: false, options: {}, ...over });

/** Moss's 0.4.2 saved shape, cut down to what matters here. */
const moss = (config: Record<string, unknown>, grid: Record<string, unknown> = {}) => ({
  version: 5,
  island: { anchor: 'top', grid: { order: [], sizes: {}, hidden: [], pages: [], ...grid } },
  activities: { order: ['claude', 'music', 'battery', 'sound', 'keys', 'brightness', 'screenshots'], config },
});

describe('System Controls in place of Sound, Brightness and Caps Lock', () => {
  it('the old three are gone from the catalog and the registry', () => {
    const registry = createRegistry();
    for (const id of ['sound', 'brightness', 'keys']) {
      expect(CATALOG_BY_ID.has(id)).toBe(false);
      expect(registry.has(id)).toBe(false);
    }
    expect(registry.has('system-controls')).toBe(true);
    const meta = CATALOG_BY_ID.get('system-controls')!;
    expect(meta.options.map((o) => o.key)).toEqual(['volume', 'device', 'brightness', 'caps', 'num']);
    expect(meta.options.every((o) => o.default === true)).toBe(true);
    // Caps Lock flashes on a Mac too, so the activity runs there; volume and brightness are Windows only for now.
    expect(meta.mac).toBeUndefined();
    expect(meta.options.filter((o) => o.mac === 'never').map((o) => o.key)).toEqual(['volume', 'device', 'brightness', 'num']);
  });

  it('new settings: on, every part on', () => {
    const s = migrate({});
    expect(s.activities.config['system-controls']).toMatchObject({ enabled: true, interactive: true, options: { volume: true, device: true, brightness: true, caps: true, num: true } });
    expect(s.activities.config.sound).toBeUndefined();
  });

  it("Moss's settings: each old switch becomes its part's option, and its place in the order", () => {
    const s = migrate(moss({ sound: cfg(true, { interactive: true, priority: 'medium' }), keys: cfg(true, { options: { caps: true, num: false } }), brightness: cfg(false) }));
    const sc = s.activities.config['system-controls'];
    expect(sc).toMatchObject({ enabled: true, priority: 'medium', interactive: true, options: { volume: true, device: true, brightness: false, caps: true, num: false } });
    expect(s.activities.order.slice(0, 5)).toEqual(['claude', 'music', 'battery', 'system-controls', 'screenshots']);
    expect(s.activities.order.filter((id) => id === 'system-controls')).toHaveLength(1);
  });

  it('a flash with Auto-show off never showed: that part stays off', () => {
    const s = migrate(moss({ sound: cfg(true, { autoShow: false }), keys: cfg(true), brightness: cfg(true) }));
    expect(s.activities.config['system-controls'].options).toMatchObject({ volume: false, device: false, brightness: true, caps: true, num: true });
  });

  it('all three off: System Controls off, and so is each part', () => {
    const s = migrate(moss({ sound: cfg(false), keys: cfg(false), brightness: cfg(false) }));
    expect(s.activities.config['system-controls']).toMatchObject({ enabled: false, options: { volume: false, device: false, brightness: false, caps: false, num: false } });
  });

  it("Justin's settings (only Sound): Sound's switch carries, the parts he never had start on", () => {
    const justin = {
      version: 5,
      island: { grid: { order: [], sizes: { 'sound/sound': '2x1' }, hidden: [], pages: [['music/music', 'sound/sound', null, 'battery/battery']] } },
      activities: { order: ['claude', 'claudeStatus', 'music', 'sound', 'battery'], config: { sound: cfg(false, { interactive: true }), claudeStatus: cfg(true) } },
    };
    const s = migrate(justin);
    expect(s.activities.config['system-controls']).toMatchObject({ enabled: true, options: { volume: false, device: false, brightness: true, caps: true, num: true } });
    // His Claude Status is part of Claude now, which keeps its place.
    expect(s.activities.order.slice(0, 3)).toEqual(['claude', 'music', 'system-controls']);
    expect(s.activities.config.claude.enabled).toBe(true);
    expect(s.island.grid.pages).toEqual([['music/music', 'system-controls/sound', null, 'battery/battery']]);
    expect(s.island.grid.sizes).toEqual({ 'system-controls/sound': '2x1' });
  });

  it('Control Center keeps the Speakers and Brightness tiles where they were, hidden or not', () => {
    const s = migrate(
      moss(
        { sound: cfg(true), keys: cfg(true), brightness: cfg(true) },
        {
          order: ['sound/sound', 'brightness/brightness'],
          sizes: { 'sound/sound': '2x1', 'brightness/brightness': '1x1' },
          // Setup hides helpers by activity id; Caps Lock never had a tile.
          hidden: ['brightness', 'keys', 'weather/weather'],
          pages: [['sound/sound', 'brightness/brightness']],
        },
      ),
    );
    expect(s.island.grid).toEqual({
      order: ['system-controls/sound', 'system-controls/brightness'],
      sizes: { 'system-controls/sound': '2x1', 'system-controls/brightness': '1x1' },
      hidden: ['system-controls/brightness', 'weather/weather'],
      pages: [['system-controls/sound', 'system-controls/brightness']],
    });
  });

  it('settings that already have System Controls are left as they are', () => {
    const saved = moss({ 'system-controls': cfg(true, { options: { volume: false } }), sound: cfg(false), keys: cfg(false) });
    const s = migrate(saved);
    expect(s.activities.config['system-controls']).toMatchObject({ enabled: true, options: { volume: false, device: true, caps: true } });
    // Migrating twice changes nothing.
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
