import { describe, expect, it } from 'vitest';
import { activeFreeze, isCalendarDate, isTimeZone, localTime, weeklyMinute } from './freeze.ts';
import { resolvePolicy } from './policy.ts';

const at = (iso: string) => new Date(iso);

describe('freeze times', () => {
  it('reads a weekday and a time', () => {
    expect(weeklyMinute('Sun 00:00')).toBe(0);
    expect(weeklyMinute('Thu 18:00')).toBe(4 * 1440 + 18 * 60);
    expect(weeklyMinute('thu 18:00')).toBeNull();
    expect(weeklyMinute('Thu 24:00')).toBeNull();
  });

  it('checks dates and time zones', () => {
    expect(isCalendarDate('2026-12-28')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isTimeZone('Asia/Amman')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('reads local time in the zone', () => {
    // 15:00 UTC on Thursday is 18:00 in Amman (UTC+3).
    expect(localTime(at('2026-10-15T15:00:00Z'), 'Asia/Amman')).toEqual({
      minuteOfWeek: 4 * 1440 + 18 * 60,
      date: '2026-10-15',
    });
  });
});

describe('activeFreeze', () => {
  const weekend = {
    name: 'weekend',
    timezone: 'Asia/Amman',
    weekly: { from: 'Thu 18:00', to: 'Sat 23:59' },
  };

  it('covers a weekly range, both ends included', () => {
    expect(activeFreeze([weekend], at('2026-10-15T14:59:00Z'))).toBeNull();
    expect(activeFreeze([weekend], at('2026-10-15T15:00:00Z'))).toEqual({
      name: 'weekend',
      timezone: 'Asia/Amman',
      until: 'Sat 23:59',
    });
    expect(activeFreeze([weekend], at('2026-10-17T20:59:00Z'))).not.toBeNull();
    expect(activeFreeze([weekend], at('2026-10-17T21:00:00Z'))).toBeNull();
  });

  it('wraps a weekly range past the end of the week', () => {
    const overWeekend = {
      name: 'weekend',
      timezone: 'UTC',
      weekly: { from: 'Fri 18:00', to: 'Mon 06:00' },
    };
    expect(activeFreeze([overWeekend], at('2026-10-17T12:00:00Z'))).not.toBeNull(); // Sat
    expect(activeFreeze([overWeekend], at('2026-10-19T05:59:00Z'))).not.toBeNull(); // Mon
    expect(activeFreeze([overWeekend], at('2026-10-19T06:01:00Z'))).toBeNull();
    expect(activeFreeze([overWeekend], at('2026-10-14T12:00:00Z'))).toBeNull(); // Wed
  });

  it('covers whole local days in a date range', () => {
    const yearEnd = {
      name: 'year-end',
      timezone: 'Asia/Amman',
      dates: { from: '2026-12-28', to: '2027-01-02' },
    };
    // 22:00 UTC on 27 December is already 28 December in Amman.
    expect(activeFreeze([yearEnd], at('2026-12-27T22:00:00Z'))).not.toBeNull();
    expect(activeFreeze([yearEnd], at('2026-12-27T20:59:00Z'))).toBeNull();
    expect(activeFreeze([yearEnd], at('2027-01-02T20:59:00Z'))).not.toBeNull();
    expect(activeFreeze([yearEnd], at('2027-01-02T21:00:00Z'))).toBeNull();
  });

  it('follows local time across daylight saving changes', () => {
    // Europe/Berlin moves from UTC+1 to UTC+2 on 29 March 2026 at 02:00 local time.
    const sundayMorning = {
      name: 'sunday maintenance',
      timezone: 'Europe/Berlin',
      weekly: { from: 'Sun 01:00', to: 'Sun 03:30' },
    };
    expect(activeFreeze([sundayMorning], at('2026-03-28T23:59:00Z'))).toBeNull(); // 00:59 CET
    expect(activeFreeze([sundayMorning], at('2026-03-29T00:30:00Z'))).not.toBeNull(); // 01:30 CET
    expect(activeFreeze([sundayMorning], at('2026-03-29T01:30:00Z'))).not.toBeNull(); // 03:30 CEST
    expect(activeFreeze([sundayMorning], at('2026-03-29T01:31:00Z'))).toBeNull(); // 03:31 CEST
    // And back to UTC+1 on 25 October 2026 at 03:00 local time.
    const evening = {
      name: 'release',
      timezone: 'Europe/Berlin',
      weekly: { from: 'Sun 18:00', to: 'Sun 20:00' },
    };
    expect(activeFreeze([evening], at('2026-10-25T16:59:00Z'))).toBeNull(); // 17:59 CET
    expect(activeFreeze([evening], at('2026-10-25T17:00:00Z'))).not.toBeNull(); // 18:00 CET
    // The week before, the same local time was an hour earlier in UTC.
    expect(activeFreeze([evening], at('2026-10-18T16:00:00Z'))).not.toBeNull(); // 18:00 CEST
  });

  it('is part of each environment, and strict production needs a change reference', () => {
    const effective = resolvePolicy({
      profile: 'strict',
      policy: { approvals: { approvers: ['U01', 'U02', 'U03'], expiresAfterMinutes: 15 } },
      environments: [
        {
          name: 'production',
          production: true,
          namespaces: ['shop'],
          repos: [],
          freezes: [weekend],
        },
        { name: 'test', production: false, namespaces: ['test'], repos: [] },
      ],
    });
    expect(effective.policyChanges).toBe('second-approver');
    expect(
      effective.environments.map((e) => [e.name, e.requireChangeRef, e.freezes.length]),
    ).toEqual([
      ['production', true, 1],
      ['test', false, 0],
    ]);
    expect(effective.default.requireChangeRef).toBe(false);
    for (const [profile, mode] of [
      ['starter', 'audited'],
      ['team', 'announced'],
    ] as const) {
      expect(
        resolvePolicy({
          ...effective,
          profile,
          policy: { approvals: { approvers: ['U01'], expiresAfterMinutes: 15 } },
          environments: [],
        }).policyChanges,
      ).toBe(mode);
    }
  });
});
