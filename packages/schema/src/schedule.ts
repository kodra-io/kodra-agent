import { localTime } from './freeze.ts';

/**
 * Check schedules (M27): a local time on some weekdays, in a time zone. Like freezes, times
 * are compared as wall-clock time in that zone, so daylight saving time changes nothing.
 */
export const SCHEDULE_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type ScheduleDay = (typeof SCHEDULE_DAYS)[number];

export interface ScheduleInput {
  name: string;
  /** "08:30", 24-hour local time. */
  at: string;
  days: readonly ScheduleDay[];
  timezone: string;
}

/** A run missed while the agent was down still happens within this many minutes. */
export const CATCH_UP_MINUTES = 60;

const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for "08:30", or null when it is not that shape. */
export function minuteOfDay(at: string): number | null {
  const m = AT.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Whether a schedule should run now: today is one of its days, its time has come in its zone,
 * at most CATCH_UP_MINUTES ago, and it has not run on this local date yet. `date` is that
 * local date, to remember as the last run.
 */
export function scheduleDue(
  schedule: ScheduleInput,
  lastRunDate: string | null,
  now: Date,
): { due: boolean; date: string } {
  const local = localTime(now, schedule.timezone);
  const at = minuteOfDay(schedule.at);
  const day = SCHEDULE_DAYS[Math.floor(local.minuteOfWeek / 1440)];
  const minute = local.minuteOfWeek % 1440;
  const due =
    at !== null &&
    day !== undefined &&
    schedule.days.includes(day) &&
    minute >= at &&
    minute - at <= CATCH_UP_MINUTES &&
    lastRunDate !== local.date;
  return { due, date: local.date };
}
