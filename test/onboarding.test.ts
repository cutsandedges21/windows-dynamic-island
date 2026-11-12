// The first-run setup's rules: what the answers tick, which activities they switch on, and
// how that lands in settings (the Control Center grid, the weather city, setup done); its screens
// on each system, and the look picked on Make it yours.

import { describe, expect, it } from 'vitest';
import { applyPlan, claudeChoices, glanceChoices, planActivities, previewCells, suggestGlance, welcomeSteps, withLook, type Answers, type Facts } from '../src/core/onboarding';
import { defaultSettings, growsOf, migrate } from '../src/core/settings';

const laptop: Facts = { laptop: true, claudeCode: false };
const desktop: Facts = { laptop: false, claudeCode: false };
const answers = (over: Partial<Answers>): Answers => ({ uses: [], glance: [], city: '', ai: false, ...over });

describe('suggestGlance', () => {
  it('ticks what the uses call for, in the order the screen lists them', () => {
    expect(suggestGlance(['school'], desktop)).toEqual(['calendar', 'timer', 'reminders', 'clipboard']);
    expect(suggestGlance(['gaming', 'media'], desktop)).toEqual(['music', 'system', 'network', 'system-controls']);
  });

  it('adds Battery on a laptop and never offers it on a desktop', () => {
    expect(suggestGlance(['school'], laptop)).toContain('battery');
    expect(glanceChoices(desktop).map((g) => g.id)).not.toContain('battery');
  });

  it('ticks something sensible when no use was picked', () => {
    expect(suggestGlance([], desktop)).toEqual(['music', 'timer']);
  });
});

describe('planActivities', () => {
  it('puts the picks on the grid and keeps the helpers on but off the grid', () => {
    const plan = planActivities(answers({ uses: ['gaming'], glance: ['system', 'network', 'system-controls'], ai: true }), desktop);
    expect(plan.picked).toEqual(['game', 'system', 'network', 'system-controls']);
    // The bot's brain is on with the AI step, but has no tile: the bot is the way in.
    expect(plan.hidden).toEqual(['downloads', 'screenshots', 'devices', 'external', 'land', 'phone', 'workspaces', 'local']);
    expect(plan.enabled).toEqual([...plan.picked, ...plan.hidden]);
  });

  it('only adds Claude Code when Claude Code is on this PC', () => {
    const withClaude: Facts = { ...desktop, claudeCode: true };
    const coding = (f: Facts) => planActivities(answers({ uses: ['coding'], glance: suggestGlance(['coding'], f) }), f);
    expect(coding(desktop).picked).toEqual(['system', 'servers', 'clipboard']);
    expect(coding(withClaude).picked).toEqual(['claude', 'system', 'servers', 'clipboard']);
    // Ticked from Coding, and unticking it leaves it off.
    expect(planActivities(answers({ uses: ['coding'], glance: ['system'] }), withClaude).picked).toEqual(['system', 'servers']);
    expect(planActivities(answers({ uses: ['coding'], glance: ['claude'] }), desktop).picked).toEqual(['servers']);
  });

  it('on a Mac, plans only what a Mac can run', () => {
    const mac: Facts = { laptop: true, claudeCode: true, platform: 'macos' };
    const plan = planActivities(answers({ uses: ['media', 'coding'], glance: ['music', 'timer', 'calendar'] }), mac);
    expect(plan.enabled).not.toContain('music');
    expect(plan.enabled).not.toContain('claude');
    expect(plan.enabled).not.toContain('battery');
    expect(plan.picked).toContain('timer');
    expect(glanceChoices(mac).map((g) => g.id)).not.toContain('music');
    // Volume and brightness have nothing to show on a Mac yet.
    expect(glanceChoices(mac).map((g) => g.id)).not.toContain('system-controls');
  });

  it('a glance tick the PC cannot have is ignored, and Battery runs on laptops only', () => {
    expect(planActivities(answers({ glance: ['battery', 'weather'] }), desktop).picked).toEqual(['weather']);
    expect(planActivities(answers({}), desktop).enabled).not.toContain('battery');
    expect(planActivities(answers({}), laptop).hidden).toContain('battery');
  });

  it('skipping the AI step leaves Local AI off', () => {
    expect(planActivities(answers({ glance: ['music'] }), desktop).enabled).not.toContain('local');
  });
});

describe('Claude Code and Claude Status', () => {
  const withClaude: Facts = { ...desktop, claudeCode: true };

  it('offers both when Claude Code is on this PC, and Claude Status alone for Coding without it', () => {
    expect(claudeChoices(withClaude, []).map((c) => c.id)).toEqual(['claude', 'claudeStatus']);
    expect(claudeChoices(desktop, ['coding']).map((c) => c.id)).toEqual(['claudeStatus']);
    expect(claudeChoices(desktop, ['school'])).toEqual([]);
    // A line each on what sets them apart.
    for (const c of claudeChoices(withClaude, [])) expect(c.sub).toBeTruthy();
  });

  it('Claude Status is off unless picked, and a picked one gets its tile after Claude Code', () => {
    expect(suggestGlance(['coding'], withClaude)).not.toContain('claudeStatus');
    expect(planActivities(answers({ uses: ['coding'], glance: ['claude'] }), withClaude).enabled).not.toContain('claudeStatus');
    const plan = planActivities(answers({ uses: ['coding'], glance: ['claude', 'claudeStatus', 'system'] }), withClaude);
    expect(plan.picked).toEqual(['claude', 'claudeStatus', 'system', 'servers']);
    expect(plan.asked).toEqual(['claudeStatus']);
    expect(applyPlan(defaultSettings(), plan, '').activities.config.claudeStatus.enabled).toBe(true);
  });

  it('run again, one already on starts ticked, and unticking it switches it off', () => {
    expect(suggestGlance(['coding'], withClaude, ['claude', 'claudeStatus'])).toContain('claudeStatus');
    const s = defaultSettings();
    s.activities.config.claudeStatus.enabled = true;
    const out = applyPlan(s, planActivities(answers({ uses: ['coding'], glance: ['claude'] }), withClaude), '');
    expect(out.activities.config.claudeStatus.enabled).toBe(false);
  });

  it('run again where it is not asked about, Claude Status stays as it was', () => {
    const s = defaultSettings();
    s.activities.config.claudeStatus.enabled = true;
    const plan = planActivities(answers({ uses: ['school'], glance: ['claudeStatus', 'timer'] }), desktop);
    expect(plan.asked).toEqual([]);
    expect(plan.picked).toEqual(['timer']);
    expect(applyPlan(s, plan, '').activities.config.claudeStatus.enabled).toBe(true);
    // Nor is it switched on by a tick the screen never showed.
    expect(applyPlan(defaultSettings(), plan, '').activities.config.claudeStatus.enabled).toBe(false);
  });

  it('a Mac is offered neither, and its Claude Status is left alone', () => {
    const mac: Facts = { laptop: true, claudeCode: true, platform: 'macos' };
    expect(claudeChoices(mac, ['coding'])).toEqual([]);
    const plan = planActivities(answers({ uses: ['coding'], glance: suggestGlance(['coding'], mac, ['claudeStatus']) }), mac);
    expect(plan.enabled).not.toContain('claudeStatus');
    expect(plan.asked).toEqual([]);
  });
});

describe('System Controls', () => {
  it('is a helper: on whatever the answers, a tile only when picked', () => {
    const none = planActivities(answers({}), desktop);
    expect(none.hidden).toContain('system-controls');
    expect(none.picked).not.toContain('system-controls');
    expect(planActivities(answers({ glance: ['system-controls'] }), desktop).picked).toEqual(['system-controls']);
  });

  it('the old Sound, Brightness and Caps Lock are not offered or switched any more', () => {
    const ids = [...glanceChoices(laptop), ...claudeChoices({ ...laptop, claudeCode: true }, ['coding'])].map((g) => g.id);
    for (const old of ['sound', 'brightness', 'keys']) {
      expect(ids).not.toContain(old);
      expect(planActivities(answers({ glance: [old] }), laptop).enabled).not.toContain(old);
    }
  });

  it('a Mac still runs it as a helper (Caps Lock), without the volume and brightness tick', () => {
    const mac: Facts = { laptop: true, claudeCode: false, platform: 'macos' };
    expect(planActivities(answers({}), mac).hidden).toContain('system-controls');
    expect(planActivities(answers({ glance: ['system-controls'] }), mac).picked).not.toContain('system-controls');
  });
});

describe('the preview', () => {
  it('sizes the tiles as Control Center does: Timer 2×1, Music and Claude Status 2×2', () => {
    expect(previewCells('timer')).toEqual({ w: 2, h: 1 });
    expect(previewCells('music')).toEqual({ w: 2, h: 2 });
    expect(previewCells('claudeStatus')).toEqual({ w: 2, h: 2 });
    expect(previewCells('system')).toEqual({ w: 1, h: 1 });
  });
});

describe('applyPlan', () => {
  const base = () => {
    const s = defaultSettings();
    s.activities.config.github.enabled = true; // set up by hand earlier, with a token
    s.island.grid = { order: ['music/music'], sizes: { 'music/music': '2x2' }, hidden: ['timer/timer'], pages: [['music/music']] };
    return s;
  };

  it('switches the planned activities on and the other managed ones off, and leaves integrations alone', () => {
    const plan = planActivities(answers({ uses: ['media'], glance: ['music', 'weather'] }), desktop);
    const s = applyPlan(base(), plan, ' Montreal ');
    const on = Object.entries(s.activities.config).filter(([, c]) => c.enabled).map(([id]) => id);
    expect(on.sort()).toEqual([...plan.enabled, 'github'].sort());
    expect(s.activities.config.claude.enabled).toBe(false);
    expect(s.activities.config.weather.options.city).toBe('Montreal');
  });

  it('orders the grid by the plan, hides the helpers by activity and marks setup done', () => {
    const plan = planActivities(answers({ glance: ['timer', 'music'] }), desktop);
    const s = applyPlan(base(), plan, '');
    expect(s.activities.order.slice(0, 2)).toEqual(['music', 'timer']);
    expect(new Set(s.activities.order).size).toBe(s.activities.order.length);
    expect(s.island.grid).toEqual({ order: [], sizes: {}, hidden: plan.hidden, pages: [] });
    expect(s.general.onboarded).toBe(true);
    expect(s.activities.config.weather.options.city).toBe('');
  });

  it('keeps Land on even with a plan that leaves it out (it is built in)', () => {
    const plan = planActivities(answers({ glance: ['music'] }), desktop);
    const s = applyPlan(base(), { ...plan, enabled: plan.enabled.filter((id) => id !== 'land') }, '');
    expect(s.activities.config.land.enabled).toBe(true);
  });

  it('does not change the settings it was given', () => {
    const s = base();
    applyPlan(s, planActivities(answers({ glance: ['music'] }), desktop), 'Paris');
    expect(s.general.onboarded).toBe(false);
    expect(s.activities.config.github.enabled).toBe(true);
  });
});

describe('first run', () => {
  it('a new install runs setup; settings from before it do not', () => {
    expect(migrate(null).general.onboarded).toBe(false);
    const old = defaultSettings() as unknown as Record<string, any>;
    old.version = 2;
    delete old.general.onboarded;
    expect(migrate(old).general.onboarded).toBe(true);
    const fresh = defaultSettings();
    expect(migrate(JSON.parse(JSON.stringify(fresh))).general.onboarded).toBe(false);
  });
});

describe('the screens', () => {
  it('make it yours first, the phone, Land, Workspaces and how to use it before the end', () => {
    expect(welcomeSteps('windows')).toEqual(['hello', 'look', 'uses', 'glance', 'ai', 'phone', 'land', 'workspaces', 'tour', 'done']);
  });

  it('skip Workspaces where it does not run yet', () => {
    expect(welcomeSteps('macos')).toEqual(['hello', 'look', 'uses', 'glance', 'ai', 'phone', 'land', 'tour', 'done']);
  });
});

describe('make it yours', () => {
  it('saves only what was picked, the rest of the settings as they were', () => {
    const s = defaultSettings();
    const out = withLook(s, { anchor: 'bottom', color: 'glass', accent: 'mint', size: 'large', bot: false });
    expect(out.island).toMatchObject({ anchor: 'bottom', color: 'glass', accent: 'mint', size: 'large', bot: false });
    expect({ ...out.island, anchor: s.island.anchor, color: s.island.color, accent: s.island.accent, size: s.island.size, bot: s.island.bot }).toEqual(s.island);
    expect(out.activities).toEqual(s.activities);
    // The settings it was given stay as they were.
    expect(s.island.anchor).toBe('top');
  });

  it('When pointed at: Sideways or Into a card, the same setting as Settings › Appearance', () => {
    const s = defaultSettings();
    expect(s.island.defaultGrows).toBe('card');
    const out = withLook(s, { defaultGrows: 'wide' });
    expect(out.island.defaultGrows).toBe('wide');
    expect({ ...out.island, defaultGrows: 'card' }).toEqual(s.island);
    expect(withLook(out, { defaultGrows: 'card' }).island.defaultGrows).toBe('card');
    // Claude Code keeps its own Below whatever the island's default.
    expect(growsOf(out.activities.config.claude, out.island.defaultGrows, 'claude')).toBe('below');
  });

  it('a missing value changes nothing', () => {
    const s = defaultSettings();
    expect(withLook(s, { color: undefined, anchor: 'left' }).island).toMatchObject({ color: s.island.color, anchor: 'left' });
  });
});
