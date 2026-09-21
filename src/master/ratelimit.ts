// Last edited: 2026-09-20 23:20 CDT
// Decision 3: parse "Resets at <time>" from a rate limit's error_details; when that fails, pause
// a fixed `rateLimitProbeMinutes` and probe by resuming the job when the pause ends.

import type { Config } from "../config.ts";

/** The longest a parsed reset time may lie ahead before it is treated as a parse failure. */
const MAX_PARSED_PAUSE_MS = 6 * 3_600_000;

const RESET_AT = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * The next local wall-clock moment named by "Resets at 3pm" / "Resets at 15:30", after `now`.
 * Null when the text names no time, or the time is more than six hours out (a bad parse).
 */
export function parseResetTime(details: string | undefined, now: Date): Date | null {
  if (!details) return null;
  const match = RESET_AT.exec(details);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  if (at.getTime() - now.getTime() > MAX_PARSED_PAUSE_MS) return null;
  return at;
}

/** When the pause ends: the parsed reset time, else `now + rateLimitProbeMinutes`. */
export function pauseUntilFor(
  details: string | undefined,
  now: Date,
  config: Pick<Config, "rateLimitProbeMinutes">,
): { until: Date; parsed: boolean } {
  const parsed = parseResetTime(details, now);
  if (parsed) return { until: parsed, parsed: true };
  return { until: new Date(now.getTime() + config.rateLimitProbeMinutes * 60_000), parsed: false };
}
