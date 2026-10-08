// The first-run setup's rules: what the answers tick, which activities they switch on, and
// how that lands in settings (the Control Center grid, the weather city, setup done).

import { describe, expect, it } from 'vitest';
import { applyPlan, glanceChoices, planActivities, suggestGlance, type Answers, type Facts } from '../src/core/onboarding';
import { defaultSettings, migrate } from '../src/core/settings';

const laptop: Facts = { laptop: true, claudeCode: false };
const desktop: Facts = { laptop: false, claudeCode: false };
const answers = (over: Partial<Answers>): Answers => ({ uses: [], glance: [], city: '', ai: false, ...over });

describe('suggestGlance', () => {
  it('ticks what the uses call for, in the order the screen lists them', () => {
    expect(suggestGlance(['school'], desktop)).toEqual(['calendar', 'timer', 'clipboard']);
    expect(suggestGlance(['gaming', 'media'], desktop)).toEqual(['music', 'system', 'network', 'sound']);
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
    const plan = planActivities(answers({ uses: ['gaming'], glance: ['system', 'network', 'sound'], ai: true }), desktop);
    expect(plan.picked).toEqual(['local', 'game', 'system', 'network', 'sound']);
    expect(plan.hidden).toEqual(['downloads', 'screenshots', 'devices', 'external']);
    expect(plan.enabled).toEqual([...plan.picked, ...plan.hidden]);
  });

  it('only adds Claude Code and Ask Claude when Claude Code is on this PC', () => {
    expect(planActivities(answers({ uses: ['coding'] }), desktop).picked).toEqual(['servers']);
    expect(planActivities(answers({ uses: ['coding'] }), { ...desktop, claudeCode: true }).picked).toEqual(['claude', 'ask', 'servers']);
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
