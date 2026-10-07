import { describe, expect, it } from 'vitest';
import { expand, parseIcs } from '../src/activities/ics';

/** A calendar with one VEVENT per argument; each is a list of content lines. */
const cal = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

/** A UTC instant, month 1-12. */
const D = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

/** Everything in 2026 unless the window is given. */
const all = (text: string, from = D(2026, 1, 1), to = D(2027, 1, 1)) => expand(parseIcs(text), from, to);

describe('times', () => {
  it('reads UTC times and unescapes text', () => {
    const [o] = all(
      cal([
        'UID:a1',
        'SUMMARY:Team sync\\, weekly',
        'LOCATION:Room 4',
        'DESCRIPTION:Line one\\nLine two',
        'URL:https://example.com/x',
        'DTSTART:20260930T130000Z',
        'DTEND:20260930T140000Z',
      ]),
    );
    expect(o).toMatchObject({ uid: 'a1', title: 'Team sync, weekly', location: 'Room 4', description: 'Line one\nLine two', url: 'https://example.com/x', allDay: false });
    expect(o.start).toBe(D(2026, 9, 30, 13));
    expect(o.end).toBe(D(2026, 9, 30, 14));
  });

  it('reads floating times as local time', () => {
    const [o] = all(cal(['UID:l1', 'SUMMARY:Lunch', 'DTSTART:20260930T120000', 'DTEND:20260930T130000']));
    expect(o.start).toBe(new Date(2026, 8, 30, 12, 0).getTime());
    expect(o.end - o.start).toBe(3600000);
  });

  it('converts TZID times, including daylight saving and Windows zone names', () => {
    const start = (line: string) => all(cal(['UID:z', 'SUMMARY:Z', line]))[0].start;
    expect(start('DTSTART;TZID=America/New_York:20260930T090000')).toBe(D(2026, 9, 30, 13)); // EDT, UTC-4
    expect(start('DTSTART;TZID=America/New_York:20261215T090000')).toBe(D(2026, 12, 15, 14)); // EST, UTC-5
    expect(start('DTSTART;TZID="America/New_York":20260930T090000')).toBe(D(2026, 9, 30, 13));
    expect(start('DTSTART;TZID=Europe/Paris:20261001T100000')).toBe(D(2026, 10, 1, 8)); // CEST, UTC+2
    expect(start('DTSTART;TZID=Asia/Kolkata:20260930T090000')).toBe(D(2026, 9, 30, 3, 30)); // UTC+5:30
    expect(start('DTSTART;TZID=Eastern Standard Time:20260930T090000')).toBe(D(2026, 9, 30, 13)); // Outlook's name for it
    expect(start('DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20260930T090000')).toBe(D(2026, 9, 30, 13));
  });

  it('falls back to local time for a zone it does not know', () => {
    const [o] = all(cal(['UID:z', 'SUMMARY:Z', 'DTSTART;TZID=Not/AZone:20260930T090000']));
    expect(o.start).toBe(new Date(2026, 8, 30, 9, 0).getTime());
  });

  it('reads all-day events as local dates', () => {
    const [o] = all(cal(['UID:d1', 'SUMMARY:Conference', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261002']));
    expect(o.allDay).toBe(true);
    expect(o.start).toBe(new Date(2026, 8, 30).getTime());
    expect(o.end).toBe(new Date(2026, 9, 2).getTime()); // DTEND is the day after the last day
    const [one] = all(cal(['UID:d2', 'SUMMARY:One day', 'DTSTART;VALUE=DATE:20260930']));
    expect(one.end).toBe(new Date(2026, 9, 1).getTime());
  });

  it('uses DURATION when there is no DTEND', () => {
    const [o] = all(cal(['UID:u1', 'SUMMARY:Dur', 'DTSTART:20260930T130000Z', 'DURATION:PT1H30M']));
    expect(o.end - o.start).toBe(90 * 60000);
  });
});

describe('parsing', () => {
  it('unfolds long lines and ignores alarms inside the event', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:f1',
      'SUMMARY:Planning',
      'DESCRIPTION:Join us at https://meet.google.com/abc-',
      ' defg-hij for the kickoff',
      'DTSTART:20260930T130000Z',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT10M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [o] = all(text);
    expect(o.description).toBe('Join us at https://meet.google.com/abc-defg-hij for the kickoff');
  });

  it('skips what it cannot read instead of throwing', () => {
    expect(parseIcs('this is not a calendar')).toEqual([]);
    expect(all(cal(['UID:x', 'SUMMARY:No start']))).toEqual([]);
    expect(all(cal(['UID:x', 'SUMMARY:Bad start', 'DTSTART:tomorrow']))).toEqual([]);
  });
});

describe('recurrence', () => {
  it('expands weekly BYDAY rules and stops at COUNT', () => {
    const occ = all(
      cal([
        'UID:w1',
        'SUMMARY:Standup',
        'DTSTART;TZID=America/New_York:20260929T100000',
        'DTEND;TZID=America/New_York:20260929T103000',
        'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=5',
      ]),
    );
    expect(occ.map((o) => o.start)).toEqual([D(2026, 9, 29, 14), D(2026, 10, 1, 14), D(2026, 10, 6, 14), D(2026, 10, 8, 14), D(2026, 10, 13, 14)]);
    expect(occ.every((o) => o.end - o.start === 30 * 60000)).toBe(true);
  });

  it('keeps the wall-clock time across a daylight saving change', () => {
    const occ = all(cal(['UID:w2', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261027T100000', 'DTEND;TZID=America/New_York:20261027T110000', 'RRULE:FREQ=WEEKLY;COUNT=3']));
    // US clocks go back on 1 November: 10:00 stays 10:00 locally, so it moves from 14:00Z to 15:00Z.
    expect(occ.map((o) => o.start)).toEqual([D(2026, 10, 27, 14), D(2026, 11, 3, 15), D(2026, 11, 10, 15)]);
  });

  it('honours INTERVAL, UNTIL and a two-week BYDAY pattern', () => {
    const every2 = all(cal(['UID:i1', 'SUMMARY:Pills', 'DTSTART:20260930T080000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261006T080000Z']));
    expect(every2.map((o) => o.start)).toEqual([D(2026, 9, 30, 8), D(2026, 10, 2, 8), D(2026, 10, 4, 8), D(2026, 10, 6, 8)]);

    // Monday 28 September: every other week on Monday and Wednesday.
    const biweekly = all(cal(['UID:i2', 'SUMMARY:Bi', 'DTSTART:20260928T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4']));
    expect(biweekly.map((o) => o.start)).toEqual([D(2026, 9, 28, 9), D(2026, 9, 30, 9), D(2026, 10, 12, 9), D(2026, 10, 14, 9)]);
  });

  it('skips EXDATE instances', () => {
    const utc = all(cal(['UID:e1', 'SUMMARY:Daily', 'DTSTART:20260930T090000Z', 'DTEND:20260930T093000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20261001T090000Z']));
    expect(utc.map((o) => o.start)).toEqual([D(2026, 9, 30, 9), D(2026, 10, 2, 9), D(2026, 10, 3, 9)]);

    const zoned = all(
      cal(['UID:e2', 'SUMMARY:Zoned', 'DTSTART;TZID=America/New_York:20260930T090000', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/New_York:20261001T090000']),
    );
    expect(zoned.map((o) => o.start)).toEqual([D(2026, 9, 30, 13), D(2026, 10, 2, 13)]);
  });

  it('drops cancelled events and cancelled instances', () => {
    const occ = all(
      cal(
        ['UID:c1', 'SUMMARY:Called off', 'DTSTART:20260930T130000Z', 'STATUS:CANCELLED'],
        ['UID:c2', 'SUMMARY:Series', 'DTSTART:20260930T150000Z', 'RRULE:FREQ=DAILY;COUNT=3'],
        ['UID:c2', 'SUMMARY:Series', 'DTSTART:20261001T150000Z', 'RECURRENCE-ID:20261001T150000Z', 'STATUS:CANCELLED'],
      ),
    );
    expect(occ.map((o) => [o.title, o.start])).toEqual([
      ['Series', D(2026, 9, 30, 15)],
      ['Series', D(2026, 10, 2, 15)],
    ]);
  });

  it('replaces a moved instance with its override', () => {
    const occ = all(
      cal(
        ['UID:m1', 'SUMMARY:Sync', 'DTSTART:20260930T150000Z', 'DTEND:20260930T160000Z', 'RRULE:FREQ=DAILY;COUNT=3'],
        ['UID:m1', 'SUMMARY:Sync (moved)', 'RECURRENCE-ID:20261001T150000Z', 'DTSTART:20261001T180000Z', 'DTEND:20261001T190000Z'],
      ),
    );
    expect(occ.map((o) => [o.title, o.start])).toEqual([
      ['Sync', D(2026, 9, 30, 15)],
      ['Sync (moved)', D(2026, 10, 1, 18)],
      ['Sync', D(2026, 10, 2, 15)],
    ]);
  });

  it('expands monthly rules, on a numbered weekday or a day that some months lack', () => {
    // Second Tuesday of the month.
    const second = all(cal(['UID:mo1', 'SUMMARY:Monthly', 'DTSTART:20260908T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4']));
    expect(second.map((o) => o.start)).toEqual([D(2026, 9, 8, 9), D(2026, 10, 13, 9), D(2026, 11, 10, 9), D(2026, 12, 8, 9)]);

    // The 31st: months without one are skipped.
    const last = all(cal(['UID:mo2', 'SUMMARY:Month end', 'DTSTART:20260131T090000Z', 'RRULE:FREQ=MONTHLY;COUNT=3']));
    expect(last.map((o) => o.start)).toEqual([D(2026, 1, 31, 9), D(2026, 3, 31, 9), D(2026, 5, 31, 9)]);

    // The last Friday.
    const friday = all(cal(['UID:mo3', 'SUMMARY:Last Fri', 'DTSTART:20260925T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=2']));
    expect(friday.map((o) => o.start)).toEqual([D(2026, 9, 25, 9), D(2026, 10, 30, 9)]);
  });

  it('expands yearly all-day events', () => {
    const occ = all(cal(['UID:y1', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20200615', 'RRULE:FREQ=YEARLY']));
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ allDay: true, start: new Date(2026, 5, 15).getTime(), end: new Date(2026, 5, 16).getTime() });
  });

  it('finds instances of a long-running series without counting from the start', () => {
    const occ = all(cal(['UID:long', 'SUMMARY:Daily', 'DTSTART:20200101T090000Z', 'RRULE:FREQ=DAILY']), D(2026, 9, 30), D(2026, 10, 3));
    expect(occ.map((o) => o.start)).toEqual([D(2026, 9, 30, 9), D(2026, 10, 1, 9), D(2026, 10, 2, 9)]);
  });
});

describe('expand', () => {
  const text = cal(
    ['UID:b', 'SUMMARY:B', 'DTSTART:20260930T150000Z', 'DTEND:20260930T160000Z'],
    ['UID:a', 'SUMMARY:A', 'DTSTART:20260930T130000Z', 'DTEND:20260930T140000Z'],
    ['UID:c', 'SUMMARY:C', 'DTSTART:20261001T130000Z', 'DTEND:20261001T140000Z'],
  );

  it('returns events that overlap the window, sorted by start', () => {
    // The window opens half-way through A.
    expect(all(text, D(2026, 9, 30, 13, 30), D(2026, 9, 30, 15, 30)).map((o) => o.title)).toEqual(['A', 'B']);
  });

  it('treats the window as half-open', () => {
    expect(all(text, D(2026, 9, 30, 0), D(2026, 9, 30, 15)).map((o) => o.title)).toEqual(['A']); // B starts as it closes
    expect(all(text, D(2026, 9, 30, 14), D(2026, 9, 30, 14, 30))).toEqual([]); // A ended as it opens
  });
});
