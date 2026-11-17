import { describe, expect, it } from 'vitest';
import { dayKey, firstWeekday, fromDayKey, googleAddUrl, isoWeek, monthWeeks, parseAdded, weekdayHeads, weekDays, weekStartOf } from '../src/activities/calgrid';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const at = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('calendar grid', () => {
  it('starts weeks where the locale does', () => {
    expect(firstWeekday('en-CA')).toBe(0);
    expect(firstWeekday('en-US')).toBe(0);
    expect(firstWeekday('fr-FR')).toBe(1);
    expect(weekdayHeads(0)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    expect(weekdayHeads(1)[0]).toBe('Mo');
  });

  it('finds the week a day is in', () => {
    // Friday 13 November 2026.
    expect(weekStartOf(day(2026, 11, 13) + 5 * 3600_000, 0)).toBe(day(2026, 11, 8));
    expect(weekStartOf(day(2026, 11, 13), 1)).toBe(day(2026, 11, 9));
    expect(weekDays(day(2026, 11, 13), 0).map((d) => d.num)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('lays out a month in whole weeks', () => {
    const weeks = monthWeeks(day(2026, 11, 13), 0);
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0].num).toBe(1);
    expect(weeks[4].map((d) => d.num)).toEqual([29, 30, 1, 2, 3, 4, 5]);
    expect(weeks[4][2].inMonth).toBe(false);
    // August 2026 starts on a Saturday: six rows.
    expect(monthWeeks(day(2026, 8, 20), 0)).toHaveLength(6);
  });

  it('numbers weeks the ISO way', () => {
    expect(isoWeek(day(2026, 11, 13))).toBe(46);
    expect(isoWeek(day(2026, 1, 1))).toBe(1);
    expect(isoWeek(day(2027, 1, 1))).toBe(53);
  });

  it('keys days and reads them back', () => {
    expect(dayKey(day(2026, 3, 5))).toBe('2026-03-05');
    expect(fromDayKey('2026-03-05')).toBe(day(2026, 3, 5));
    expect(fromDayKey('2026-02-31')).toBeNull();
    expect(fromDayKey('nope')).toBeNull();
  });
});

describe('adding an event', () => {
  const d = day(2026, 11, 13);

  it('takes a time first or last', () => {
    const a = parseAdded('14:30 Dentist', d)!;
    expect(a).toMatchObject({ title: 'Dentist', allDay: false });
    expect(at(a.start)).toBe('14:30');
    expect(a.end - a.start).toBe(3600_000);
    expect(at(parseAdded('Lunch 12:30', d)!.start)).toBe('12:30');
    expect(at(parseAdded('2pm Gym', d)!.start)).toBe('14:00');
    expect(at(parseAdded('9:15am Call with Sam', d)!.start)).toBe('9:15');
    expect(at(parseAdded('12am Launch', d)!.start)).toBe('0:00');
    expect(at(parseAdded('14h30 Dentiste', d)!.start)).toBe('14:30');
  });

  it('takes a range', () => {
    const a = parseAdded('9:00-10:30 Class', d)!;
    expect(a.title).toBe('Class');
    expect([at(a.start), at(a.end)]).toEqual(['9:00', '10:30']);
    const b = parseAdded('Physio 2-3pm', d)!;
    expect([b.title, at(b.start), at(b.end)]).toEqual(['Physio', '14:00', '15:00']);
  });

  it('is all day without a time, and a lone number stays in the name', () => {
    expect(parseAdded("Mom's birthday", d)).toEqual({ title: "Mom's birthday", start: d, end: day(2026, 11, 14), allDay: true });
    expect(parseAdded('9 Gym', d)).toMatchObject({ title: '9 Gym', allDay: true });
    expect(parseAdded('   ', d)).toBeNull();
    // A time and nothing else is no event name: all day, named as typed.
    expect(parseAdded('25:00 Late', d)).toMatchObject({ allDay: true });
  });

  it('opens Google Calendar filled in', () => {
    const url = googleAddUrl({ title: 'Dentist & co', start: Date.UTC(2026, 10, 13, 19, 30), end: Date.UTC(2026, 10, 13, 20, 30), allDay: false });
    expect(url).toBe('https://calendar.google.com/calendar/render?action=TEMPLATE&text=Dentist%20%26%20co&dates=20261113T193000Z/20261113T203000Z');
    expect(googleAddUrl({ title: 'Trip', start: d, end: day(2026, 11, 14), allDay: true })).toContain('dates=20261113/20261114');
  });
});
