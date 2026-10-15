/**
 * Freeze windows (PLAN-v0.2 M11): weekly ranges or date ranges, each in its own time zone.
 * Times are compared as local wall-clock time in that zone, so daylight saving time changes
 * nothing about when a window starts or ends.
 */
export interface FreezeInput {
  name: string;
  timezone: string;
  weekly?: { from: string; to: string } | undefined;
  dates?: { from: string; to: string } | undefined;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKLY = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Minutes since Sunday 00:00 for "Thu 18:00", or null when it is not that shape. */
export function weeklyMinute(text: string): number | null {
  const m = WEEKLY.exec(text);
  if (!m) return null;
  const day = WEEKDAYS.indexOf(m[1] as (typeof WEEKDAYS)[number]);
  return day * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

/** Whether a date is a real calendar date like 2026-12-28. */
export function isCalendarDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]);
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The local weekday, date, and time of an instant in a time zone. */
export function localTime(now: Date, timeZone: string): { minuteOfWeek: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS.indexOf(get('weekday') as (typeof WEEKDAYS)[number]);
  return {
    minuteOfWeek: day * 1440 + Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

export interface ActiveFreeze {
  name: string;
  timezone: string;
  /** When it ends, in the freeze's own words: "Sat 23:59" or "2027-01-02". */
  until: string;
}

/**
 * The freeze in effect at `now`, or null. A weekly range whose end comes before its start
 * wraps past Saturday (Fri 18:00 to Mon 06:00); both ends are included, to the minute. A
 * date range covers whole local days, both included.
 */
export function activeFreeze(freezes: readonly FreezeInput[], now: Date): ActiveFreeze | null {
  for (const f of freezes) {
    const local = localTime(now, f.timezone);
    if (f.weekly) {
      const from = weeklyMinute(f.weekly.from);
      const to = weeklyMinute(f.weekly.to);
      if (from === null || to === null) continue;
      const t = local.minuteOfWeek;
      const inside = from <= to ? t >= from && t <= to : t >= from || t <= to;
      if (inside) return { name: f.name, timezone: f.timezone, until: f.weekly.to };
    } else if (f.dates) {
      if (local.date >= f.dates.from && local.date <= f.dates.to) {
        return { name: f.name, timezone: f.timezone, until: f.dates.to };
      }
    }
  }
  return null;
}
