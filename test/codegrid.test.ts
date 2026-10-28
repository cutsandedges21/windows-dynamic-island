import { describe, expect, it } from 'vitest';
import { TEAMS } from '../src/activities/nhl';
import { groupChoices } from '../src/codegrid';

describe('team grid', () => {
  it('has the 32 teams, four divisions of eight, every code once', () => {
    expect(TEAMS).toHaveLength(32);
    expect(new Set(TEAMS.map((t) => t.value)).size).toBe(32);
    for (const t of TEAMS) expect(t.value).toMatch(/^[A-Z]{3}$/);
    const groups = groupChoices(TEAMS);
    expect(groups.map((g) => [g.group, g.items.length])).toEqual([
      ['Atlantic', 8],
      ['Metropolitan', 8],
      ['Central', 8],
      ['Pacific', 8],
    ]);
    expect(TEAMS.find((t) => t.value === 'MTL')).toMatchObject({ label: 'Montréal Canadiens', group: 'Atlantic' });
  });

  it('groups in the order the choices come, ungrouped ones together', () => {
    expect(groupChoices([{ value: 'a', label: 'A', group: 'X' }, { value: 'b', label: 'B', group: 'X' }, { value: 'c', label: 'C', group: 'Y' }, { value: 'd', label: 'D' }])).toEqual([
      { group: 'X', items: [{ value: 'a', label: 'A', group: 'X' }, { value: 'b', label: 'B', group: 'X' }] },
      { group: 'Y', items: [{ value: 'c', label: 'C', group: 'Y' }] },
      { group: '', items: [{ value: 'd', label: 'D' }] },
    ]);
  });
});
