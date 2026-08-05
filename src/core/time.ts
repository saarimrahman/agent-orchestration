import * as chrono from 'chrono-node';
import { CronExpressionParser } from 'cron-parser';

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;

const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function durationUnit(raw: string): string {
  const u = raw.toLowerCase();
  if (u.startsWith('mi') || u === 'm') return 'm';
  if (u.startsWith('h')) return 'h';
  if (u.startsWith('d')) return 'd';
  return 'w';
}

/** Parse `30m`, `2h`, `3d`, `1w` into milliseconds. Returns null if unrecognised. */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * DURATION_MS[durationUnit(match[2])];
}

/**
 * Parse a point in time from a duration (`3d`), an ISO date, or natural
 * language (`friday`, `tomorrow 9am`, `in 2 weeks`). Always resolves forward.
 */
export function parseWhen(input: string, from = new Date()): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ms = parseDuration(trimmed);
  if (ms !== null) return new Date(from.getTime() + ms);

  return chrono.parseDate(trimmed, from, { forwardDate: true });
}

/** Like `parseWhen`, but throws with usable guidance instead of returning null. */
export function parseWhenOrThrow(input: string, from = new Date()): Date {
  const date = parseWhen(input, from);
  if (!date) {
    throw new Error(
      `Could not understand the time "${input}".\n` +
        `Try a duration (3d, 2h, 30m, 1w), a date (2026-08-12), or plain English ` +
        `("friday", "tomorrow 9am", "in two weeks").`,
    );
  }
  return date;
}

export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/** Next fire time strictly after `from` for a 5-field cron expression. */
export function nextCronFire(expr: string, from = new Date()): Date {
  try {
    return CronExpressionParser.parse(expr, { currentDate: from }).next().toDate();
  } catch (err) {
    throw new Error(
      `Invalid cron expression "${expr}": ${(err as Error).message}\n` +
        `Use 5 fields: minute hour day-of-month month day-of-week. ` +
        `For example "0 9 * * 1" is every Monday at 9am.`,
    );
  }
}

/** Compact relative rendering: "3d ago", "in 2h", "just now". */
export function relative(iso: string, from = new Date()): string {
  const delta = new Date(iso).getTime() - from.getTime();
  const abs = Math.abs(delta);
  if (abs < 60_000) return 'just now';

  const units: [number, string][] = [
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return delta < 0 ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return 'just now';
}

/** Start of the local day, as a UTC ISO string. */
export function startOfLocalDay(from = new Date()): string {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** End of the local day, as a UTC ISO string. */
export function endOfLocalDay(from = new Date()): string {
  const d = new Date(from);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
