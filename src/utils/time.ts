/**
 * Timezone-aware date helpers.
 *
 * The report is anchored to a wall-clock day in a specific IANA timezone
 * (default America/New_York). Time Doctor expects UTC ISO timestamps, so we
 * compute the day's [start, end) boundary in the report timezone and express
 * it in UTC.
 */

/** Parts of an instant rendered in a given timezone. */
function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Returns the UTC offset (in minutes) of `timeZone` at the given instant.
 * Positive means ahead of UTC.
 */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Given a calendar day (Y/M/D) in `timeZone`, return the UTC Date for local
 * midnight (00:00:00.000) of that day.
 */
function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  // First approximation: treat the local wall time as if it were UTC.
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  // Correct by the zone offset at that instant (handles DST).
  const off = offsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - off * 60000);
}

export interface DayWindow {
  /** Inclusive start, UTC ISO (local midnight). */
  fromIso: string;
  /** Exclusive end, UTC ISO (next local midnight). */
  toIso: string;
  /** The local calendar date label, e.g. "2026-06-27". */
  localDate: string;
}

/**
 * Compute the [start, end) UTC window covering the local day that `now` falls
 * in, for the given timezone.
 */
export function dayWindow(timeZone: string, now: Date = new Date()): DayWindow {
  const p = zonedParts(now, timeZone);
  const start = zonedMidnightUtc(p.year, p.month, p.day, timeZone);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const localDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { fromIso: start.toISOString(), toIso: end.toISOString(), localDate };
}

/** Format a Date as a human report header date in the given timezone, e.g. "Thursday, June 18, 2026". */
export function formatReportDate(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
}

/** ISO timestamp for `days` before the given instant (default now). */
export function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The current billing-cycle window for an account whose cycle starts on
 * `startDay` of each month (e.g. 8 → "8th to 7th of following month").
 * Returns UTC ISO [from, to) bounds, anchored to local midnight in `timeZone`.
 *
 * If today's local day-of-month is >= startDay, the cycle started this month;
 * otherwise it started last month.
 */
export function billingCycleWindow(
  timeZone: string,
  startDay: number,
  now: Date = new Date(),
): { fromIso: string; toIso: string } {
  const p = zonedParts(now, timeZone);
  let startYear = p.year;
  let startMonth = p.month; // 1-based
  if (p.day < startDay) {
    // Cycle began in the previous month.
    startMonth -= 1;
    if (startMonth === 0) {
      startMonth = 12;
      startYear -= 1;
    }
  }
  const start = zonedMidnightUtc(startYear, startMonth, startDay, timeZone);
  // End = same day next month (exclusive), so the cycle is [start, start+1month).
  let endYear = startYear;
  let endMonth = startMonth + 1;
  if (endMonth === 13) {
    endMonth = 1;
    endYear += 1;
  }
  const end = zonedMidnightUtc(endYear, endMonth, startDay, timeZone);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

/**
 * The current week (Monday–Sunday) as UTC ISO [from, to), anchored to local
 * midnight in `timeZone`. `to` is next Monday (exclusive).
 */
export function currentWeekWindow(
  timeZone: string,
  now: Date = new Date(),
): { fromIso: string; toIso: string } {
  const p = zonedParts(now, timeZone);
  const todayMidnight = zonedMidnightUtc(p.year, p.month, p.day, timeZone);
  // Days since Monday, from the local weekday name.
  const wkName = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const daysSinceMon: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const offset = daysSinceMon[wkName] ?? 0;
  const start = new Date(todayMidnight.getTime() - offset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

/** Ordinal form of a day number: 1 -> "1st", 2 -> "2nd", 13 -> "13th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Cycle label like "8th to 7th" for a cycle starting on `startDay`. */
export function cycleRangeLabel(startDay: number): string {
  const endDay = startDay === 1 ? 31 : startDay - 1;
  return `${ordinal(startDay)} to ${ordinal(endDay)}`;
}

/** Convert seconds to a compact "Xh Ym" string (e.g. 30185 -> "8h 23m"). */
export function secondsToHm(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}
