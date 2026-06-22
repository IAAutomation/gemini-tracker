/**
 * PKT (Pakistan Time, Asia/Karachi, UTC+5) date utilities.
 *
 * The server runs in UTC, but the user is in Peshawar. Without this module,
 * "today" would roll over at 5 AM PKT (midnight UTC), and the calendar would
 * show sales on the wrong day. All date math in this app goes through these
 * helpers so that:
 *
 *   - "Today" = midnight PKT to midnight PKT (in UTC terms)
 *   - Calendar day grids show the correct PKT weekday for day 1
 *   - Sale timestamps are displayed in PKT
 *   - Weekly/Monthly/Yearly ranges are PKT-aligned
 *
 * PKT has NO daylight saving time — it's a fixed UTC+5 year-round, so we can
 * safely use Intl.DateTimeFormat with timeZone: "Asia/Karachi" to extract
 * the PKT year/month/day/hour from any UTC Date.
 */

export const PKT_TZ = "Asia/Karachi";
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Extract the PKT year/month/day/hour/etc. parts from a (UTC-stored) Date. */
export function pktParts(date: Date = new Date()): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PKT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some envs return "24" for midnight
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_MAP[map.weekday] ?? 0,
  };
}

/** "YYYY-MM-DD" key in PKT. */
export function pktDateKey(date: Date = new Date()): string {
  const p = pktParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "YYYY-MM" key in PKT. */
export function pktMonthKey(date: Date = new Date()): string {
  const p = pktParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/** PKT year (e.g. 2026). */
export function pktYear(date: Date = new Date()): number {
  return pktParts(date).year;
}

/** PKT month 1-12. */
export function pktMonth(date: Date = new Date()): number {
  return pktParts(date).month;
}

/** PKT day of month 1-31. */
export function pktDay(date: Date = new Date()): number {
  return pktParts(date).day;
}

/** PKT hour 0-23. */
export function pktHour(date: Date = new Date()): number {
  return pktParts(date).hour;
}

/**
 * Compute the UTC Date that corresponds to midnight PKT on the given
 * PKT year/month/day.
 *
 * PKT is UTC+5, so midnight PKT = 19:00 UTC the previous day.
 * Example: 2026-06-21 00:00 PKT = 2026-06-20 19:00 UTC.
 */
export function pktMidnightUtc(year: number, month: number, day: number): Date {
  const utcMidnightSameDay = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return new Date(utcMidnightSameDay.getTime() - PKT_OFFSET_MS);
}

/** Start of today in PKT (as a UTC Date). */
export function startOfTodayPkt(): Date {
  const p = pktParts();
  return pktMidnightUtc(p.year, p.month, p.day);
}

/** End of today in PKT = start of tomorrow in PKT (as a UTC Date). */
export function endOfTodayPkt(): Date {
  const p = pktParts();
  const tomorrowUtcMidnight = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0, 0));
  return new Date(tomorrowUtcMidnight.getTime() - PKT_OFFSET_MS);
}

/** Start of the given (or current) PKT month (as a UTC Date). */
export function startOfMonthPkt(year?: number, month?: number): Date {
  const p = pktParts();
  const y = year ?? p.year;
  const m = month ?? p.month;
  const utcMidnight = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  return new Date(utcMidnight.getTime() - PKT_OFFSET_MS);
}

/** End of the given (or current) PKT month = start of next month (as a UTC Date). */
export function endOfMonthPkt(year?: number, month?: number): Date {
  const p = pktParts();
  const y = year ?? p.year;
  const m = month ?? p.month;
  const utcMidnightNextMonth = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return new Date(utcMidnightNextMonth.getTime() - PKT_OFFSET_MS);
}

/** Start of the given (or current) PKT year (as a UTC Date). */
export function startOfYearPkt(year?: number): Date {
  const p = pktParts();
  const y = year ?? p.year;
  const utcMidnight = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0));
  return new Date(utcMidnight.getTime() - PKT_OFFSET_MS);
}

/** End of the given (or current) PKT year = start of next year (as a UTC Date). */
export function endOfYearPkt(year?: number): Date {
  const p = pktParts();
  const y = year ?? p.year;
  const utcMidnightNextYear = new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));
  return new Date(utcMidnightNextYear.getTime() - PKT_OFFSET_MS);
}

/**
 * Start of the rolling 7-day window ending now (in PKT).
 * Returns 6 days ago at midnight PKT, as a UTC Date.
 */
export function startOfRollingWeekPkt(): Date {
  const p = pktParts();
  // 6 days ago at midnight PKT (so the window covers 7 calendar days including today)
  const sixDaysAgoUtcMidnight = new Date(Date.UTC(p.year, p.month - 1, p.day - 6, 0, 0, 0, 0));
  return new Date(sixDaysAgoUtcMidnight.getTime() - PKT_OFFSET_MS);
}

/** Format a date for display in PKT (e.g. "Jun 21"). */
export function formatPktDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: PKT_TZ,
    month: "short",
    day: "numeric",
  });
}

/** Format a date for display in PKT with weekday (e.g. "Sun, Jun 21"). */
export function formatPktDateWithWeekday(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: PKT_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Format a date for full display in PKT (e.g. "Sunday, June 21, 2026"). */
export function formatPktFullDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: PKT_TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Format a time for display in PKT (e.g. "6:38 PM"). */
export function formatPktTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: PKT_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Format a date+time for display in PKT (e.g. "Jun 21, 6:38 PM"). */
export function formatPktDateTime(date: Date): string {
  return `${formatPktDate(date)}, ${formatPktTime(date)}`;
}

/** Number of days in a PKT month. */
export function daysInMonthPkt(year: number, month: number): number {
  // Day 0 of next month = last day of this month (works the same in any TZ)
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Get the PKT weekday for day 1 of a given (year, month).
 * Returns 0=Sunday, 1=Monday, ..., 6=Saturday.
 */
export function firstWeekdayOfMonthPkt(year: number, month: number): number {
  const midnight = pktMidnightUtc(year, month, 1);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: PKT_TZ, weekday: "short" });
  const weekdayStr = fmt.format(midnight);
  return WEEKDAY_MAP[weekdayStr] ?? 0;
}
