import { describe, expect, it } from 'vitest';
import { buildAgentConfigSchema } from './agent-config.ts';
import { formatIssue, parseAgentConfig } from './parse.ts';
import { fixtureList } from './test-fixtures.ts';
import { CATCH_UP_MINUTES, minuteOfDay, scheduleDue, type ScheduleInput } from './schedule.ts';

const weekdays: ScheduleInput = {
  name: 'morning',
  at: '08:30',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  timezone: 'Asia/Amman',
};
// Asia/Amman is UTC+3 all year. 2026-10-22 is a Thursday.
const at = (iso: string) => new Date(iso);

describe('scheduleDue', () => {
  it('runs at its local time on its days, once a day', () => {
    expect(scheduleDue(weekdays, null, at('2026-10-22T05:29:00Z')).due).toBe(false);
    expect(scheduleDue(weekdays, null, at('2026-10-22T05:30:00Z'))).toEqual({
      due: true,
      date: '2026-10-22',
    });
    expect(scheduleDue(weekdays, '2026-10-22', at('2026-10-22T05:45:00Z')).due).toBe(false);
    expect(scheduleDue(weekdays, '2026-10-22', at('2026-10-23T05:30:00Z')).due).toBe(true);
  });

  it('skips days it is not set for', () => {
    // Saturday 2026-10-24.
    expect(scheduleDue(weekdays, null, at('2026-10-24T05:30:00Z')).due).toBe(false);
  });

  it(`catches up a missed run for ${String(CATCH_UP_MINUTES)} minutes, then waits for the next day`, () => {
    expect(scheduleDue(weekdays, null, at('2026-10-22T06:30:00Z')).due).toBe(true);
    expect(scheduleDue(weekdays, null, at('2026-10-22T06:31:00Z')).due).toBe(false);
  });

  it('uses local time across a daylight saving change', () => {
    const ny: ScheduleInput = {
      name: 'n',
      at: '02:30',
      days: ['sun'],
      timezone: 'America/New_York',
    };
    // 2026-03-08: clocks jump from 02:00 to 03:00, so 02:30 never happens; it runs at 03:00.
    expect(scheduleDue(ny, null, at('2026-03-08T06:59:00Z')).due).toBe(false);
    expect(scheduleDue(ny, null, at('2026-03-08T07:00:00Z'))).toEqual({
      due: true,
      date: '2026-03-08',
    });
    // 2026-11-01: 01:00 to 02:00 happens twice; 09:00 runs once by local date.
    const fallBack: ScheduleInput = { ...ny, at: '09:00' };
    expect(scheduleDue(fallBack, null, at('2026-11-01T14:00:00Z')).due).toBe(true);
    expect(scheduleDue(fallBack, '2026-11-01', at('2026-11-01T14:30:00Z')).due).toBe(false);
  });

  it('reads 24-hour times only', () => {
    expect(minuteOfDay('08:30')).toBe(510);
    expect(minuteOfDay('23:59')).toBe(1439);
    for (const bad of ['8:30', '24:00', '08:60', '0830', '']) expect(minuteOfDay(bad)).toBeNull();
  });
});

describe('spec.checks', () => {
  const schema = buildAgentConfigSchema(fixtureList);
  const parse = (checks: string) => {
    const result = parseAgentConfig(
      `apiVersion: kodra.io/v1alpha1
kind: Agent
metadata:
  name: demo-agent
spec:
  target: compose
  model:
    provider: ollama
    name: some-model
    baseUrl: http://ollama:11434
  policy:
    approvals:
      approvers: ['@omar']
  checks:
${checks}
`,
      schema,
    );
    if (!result.ok) throw new Error(result.issues.map((i) => formatIssue(i)).join('\n'));
    return result.config;
  };

  it('defaults to no schedules, every day when days are left out', () => {
    expect(parse('    schedules: []').spec.checks).toEqual({
      schedules: [],
      quietWhenClean: false,
    });
    const parsed = parse(
      '    schedules: [{name: daily, at: "09:00", timezone: UTC}]\n    quietWhenClean: true',
    );
    expect(parsed.spec.checks.schedules[0]?.days).toEqual([
      'sun',
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
    ]);
    expect(parsed.spec.checks.quietWhenClean).toBe(true);
  });

  it('refuses a bad time, zone, day, or a repeated name', () => {
    expect(() => parse('    schedules: [{name: a, at: "9am", timezone: UTC}]')).toThrow(
      'must be a 24-hour time like 08:30',
    );
    expect(() => parse('    schedules: [{name: a, at: "09:00", timezone: Mars/Base}]')).toThrow(
      'must be a time zone',
    );
    expect(() =>
      parse('    schedules: [{name: a, at: "09:00", days: [monday], timezone: UTC}]'),
    ).toThrow('must be sun, mon');
    expect(() =>
      parse(
        '    schedules: [{name: a, at: "09:00", timezone: UTC}, {name: a, at: "17:00", timezone: UTC}]',
      ),
    ).toThrow('a is used twice');
  });
});
