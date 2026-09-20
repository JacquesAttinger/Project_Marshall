// Last edited: 2026-09-20 15:35 CDT
// The three start caps (concurrency, calendar day, rolling window) and the pause flag. Pure over
// the DB and an injected clock, so tests pin `now`. `readCapCounts` + `evaluateCaps` are split so
// `marshall queue` can simulate a tick by bumping the counts it would have produced.

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

export interface CapCounts {
  /** Claims holding a slot. */
  live: number;
  /** `starts` rows dated today, local time. */
  today: number;
  /** `starts` rows in the last `windowHours`. */
  window: number;
  /** When the oldest start in the window leaves it, as ISO, or null when the window is empty. */
  windowFreesAt: string | null;
  /** The pause flag, when it is still in the future. */
  pausedUntil: string | null;
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

export function isPaused(db: Database, now: Date): boolean {
  const until = pauseUntil(db);
  return until !== null && now.getTime() < until.getTime();
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
  };
}

/** Apply the rules to a snapshot. Pure. */
export function evaluateCaps(counts: CapCounts, config: Config, opts: CapOptions): CapCheck {
  const reasons: string[] = [];
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

/** The counts after a start of the given kind, for a dry run. */
export function countsAfterStart(counts: CapCounts, opts: CapOptions): CapCounts {
  return {
    ...counts,
    live: counts.live + 1,
    today: opts.firstStart ? counts.today + 1 : counts.today,
    window: opts.firstStart ? counts.window + 1 : counts.window,
  };
}
