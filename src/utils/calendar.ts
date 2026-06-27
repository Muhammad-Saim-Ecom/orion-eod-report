/**
 * Business-day logic for the report schedule: weekdays only (Mon–Fri),
 * skipping US federal holidays.
 *
 * Holidays are computed deterministically (no external dependency). When a
 * fixed-date holiday falls on a weekend, the federal observed day shifts
 * (Sat → Fri, Sun → Mon); we treat the observed day as the holiday since that
 * is when offices are closed.
 */

/** Parse a local Y/M/D from a timezone-aware date. */
function localYmd(date: Date, timeZone: string): { y: number; m: number; d: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    dow: dowMap[parts.weekday as string] ?? 0,
  };
}

/** nth weekday of a month, e.g. 3rd Monday (dow=1, n=3). Returns the day-of-month. */
function nthWeekday(year: number, month: number, dow: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (dow - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** last weekday of a month (e.g. last Monday of May). Returns the day-of-month. */
function lastWeekday(year: number, month: number, dow: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((lastDow - dow + 7) % 7);
}

/** Set of US federal holidays (observed) for a year, as "M-D" strings. */
function usFederalHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const add = (m: number, d: number) => out.add(`${m}-${d}`);

  // Fixed-date holidays, shifted to the observed weekday.
  const fixed: Array<[number, number]> = [
    [1, 1], // New Year's Day
    [6, 19], // Juneteenth
    [7, 4], // Independence Day
    [11, 11], // Veterans Day
    [12, 25], // Christmas
  ];
  for (const [m, d] of fixed) {
    const dow = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (dow === 6) add(m, d - 1); // Sat → observed Fri
    else if (dow === 0) add(m, d + 1); // Sun → observed Mon
    else add(m, d);
  }

  // Floating holidays.
  add(1, nthWeekday(year, 1, 1, 3)); // MLK Day — 3rd Mon Jan
  add(2, nthWeekday(year, 2, 1, 3)); // Presidents' Day — 3rd Mon Feb
  add(5, lastWeekday(year, 5, 1)); // Memorial Day — last Mon May
  add(9, nthWeekday(year, 9, 1, 1)); // Labor Day — 1st Mon Sep
  add(10, nthWeekday(year, 10, 1, 2)); // Columbus Day — 2nd Mon Oct
  add(11, nthWeekday(year, 11, 4, 4)); // Thanksgiving — 4th Thu Nov

  return out;
}

export interface BusinessDayCheck {
  isBusinessDay: boolean;
  reason?: "weekend" | "holiday";
}

/** The local hour (0–23) in the given timezone for `now`. */
export function localHour(timeZone: string, now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  // "24" can appear for midnight in some locales; normalise to 0.
  const n = Number(h);
  return n === 24 ? 0 : n;
}

/**
 * Whether `now` (interpreted in `timeZone`) is a business day: Mon–Fri, and —
 * when `skipHolidays` is true — not a US federal holiday (observed).
 *
 * Holiday skipping is opt-in (default off); current requirement is weekends
 * only. The holiday machinery is kept for when/if that changes.
 */
export function checkBusinessDay(
  timeZone: string,
  now: Date = new Date(),
  skipHolidays = false,
): BusinessDayCheck {
  const { y, m, d, dow } = localYmd(now, timeZone);
  if (dow === 0 || dow === 6) return { isBusinessDay: false, reason: "weekend" };
  if (skipHolidays && usFederalHolidays(y).has(`${m}-${d}`)) {
    return { isBusinessDay: false, reason: "holiday" };
  }
  return { isBusinessDay: true };
}
