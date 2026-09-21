// Last edited: 2026-09-21 00:10 CDT
// The three start caps (concurrency, calendar day, rolling window) and the two pause flags. Pure
// over the DB and an injected clock, so tests pin `now`. `readCapCounts` + `evaluateCaps` are split
// so `marshall queue` can simulate a tick by bumping the counts it would have produced.
//
// Two pauses, two keys: `pause_until` is the rate-limit pause the master agent sets and clears;
// `paused` is `marshall pause`, cleared only by `marshall resume`. Either one stops new starts.

import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import {
  countStartsBetween,
  getFlag,
  liveClaims,
  oldestStartSince,
  setFlag,
} from "./scheduler/store.ts";

export { liveClaims } from "./scheduler/store.ts";

export const PAUSE_FLAG = "pause_until";
/** Set by `marshall pause`; the value is the ISO time it was set. Running agents finish. */
export const MANUAL_PAUSE_FLAG = "paused";

export interface CapCounts {
  /** Claims holding a slot. */
  live: number;
  /** `starts` rows dated today, local time. */
  today: number;
  /** `starts` rows in the last `windowHours`. */
  window: number;
  /** When the oldest start in the window leaves it, as ISO, or null when the window is empty. */
  windowFreesAt: string | null;
  /** The rate-limit pause flag, when it is still in the future. */
  pausedUntil: string | null;
  /** When `marshall pause` was run, or null. */
  pausedAt: string | null;
}

export interface CapCheck {
  ok: boolean;
  /** Human-readable, one per failed rule. Empty when ok. */
  reasons: string[];
}

export interface CapOptions {
  /** False for a bounce or a resume: only the concurrency cap applies (decision 3). */
  firstStart: boolean;
}

/** Local midnight that starts the day `now` is in. */
export function localDayStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Local midnight that ends the day `now` is in (DST-safe: built from calendar fields). */
export function localDayEnd(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export function startsToday(db: Database, now: Date): number {
  return countStartsBetween(db, localDayStart(now).toISOString(), localDayEnd(now).toISOString());
}

export function windowStart(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * 3_600_000);
}

export function startsInWindow(db: Database, now: Date, windowHours: number): number {
  // Half-open on the far side: a start exactly `windowHours` ago has left the window.
  const from = new Date(windowStart(now, windowHours).getTime() + 1).toISOString();
  return countStartsBetween(db, from, new Date(now.getTime() + 1).toISOString());
}

export function pauseUntil(db: Database): Date | null {
  const raw = getFlag(db, PAUSE_FLAG);
  if (!raw) return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** `null` clears the flag. */
export function setPause(db: Database, until: Date | null): void {
  setFlag(db, PAUSE_FLAG, until ? until.toISOString() : null);
}

/** The time `marshall pause` was run, or null when not manually paused. */
export function manualPauseAt(db: Database): string | null {
  return getFlag(db, MANUAL_PAUSE_FLAG);
}

/** `marshall pause` / `marshall resume`. Independent of the rate-limit pause. */
export function setManualPause(db: Database, now: Date | null): void {
  setFlag(db, MANUAL_PAUSE_FLAG, now ? now.toISOString() : null);
}

/** The rate-limit pause alone. A parked agent waits on this one, never on `marshall pause`. */
export function isRateLimitPaused(db: Database, now: Date): boolean {
  const until = pauseUntil(db);
  return until !== null && now.getTime() < until.getTime();
}

/** Either pause holds: no new starts. The rate-limit pause expires; the manual one does not. */
export function isPaused(db: Database, now: Date): boolean {
  return manualPauseAt(db) !== null || isRateLimitPaused(db, now);
}

export function readCapCounts(db: Database, config: Config, now: Date): CapCounts {
  const from = new Date(windowStart(now, config.windowHours).getTime() + 1).toISOString();
  const oldest = oldestStartSince(db, from);
  const until = pauseUntil(db);
  return {
    live: liveClaims(db).length,
    today: startsToday(db, now),
    window: startsInWindow(db, now, config.windowHours),
    windowFreesAt: oldest
      ? new Date(Date.parse(oldest) + config.windowHours * 3_600_000).toISOString()
      : null,
    pausedUntil: until && now.getTime() < until.getTime() ? until.toISOString() : null,
    pausedAt: manualPauseAt(db),
  };
}

/** Apply the rules to a snapshot. Pure. */
export function evaluateCaps(counts: CapCounts, config: Config, opts: CapOptions): CapCheck {
  const reasons: string[] = [];
  if (counts.pausedAt) reasons.push(`paused by \`marshall pause\` at ${counts.pausedAt}`);
  if (counts.pausedUntil) reasons.push(`paused until ${counts.pausedUntil}`);
  if (counts.live >= config.maxAgents) {
    reasons.push(`concurrency: ${counts.live} of ${config.maxAgents} agents busy`);
  }
  if (opts.firstStart) {
    if (counts.today >= config.dailyStartCap) {
      reasons.push(
        `daily: ${counts.today} of ${config.dailyStartCap} starts used today (resets at local midnight)`,
      );
    }
    if (counts.window >= config.windowStartCap) {
      const when = counts.windowFreesAt ? ` (next slot at ${counts.windowFreesAt})` : "";
      reasons.push(
        `window: ${counts.window} of ${config.windowStartCap} starts in the last ${config.windowHours} h${when}`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function capCheck(db: Database, config: Config, now: Date, opts: CapOptions): CapCheck {
  return evaluateCaps(readCapCounts(db, config, now), config, opts);
}

/** The counts after a start at `now` of the given kind, for a dry run. */
export function countsAfterStart(
  counts: CapCounts,
  opts: CapOptions,
  now: Date,
  config: Config,
): CapCounts {
  if (!opts.firstStart) return { ...counts, live: counts.live + 1 };
  return {
    ...counts,
    live: counts.live + 1,
    today: counts.today + 1,
    window: counts.window + 1,
    // A start into an empty window is the one that will free it.
    windowFreesAt:
      counts.windowFreesAt ??
      new Date(now.getTime() + config.windowHours * 3_600_000).toISOString(),
  };
}
