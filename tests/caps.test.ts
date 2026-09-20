// Last edited: 2026-09-20 15:40 CDT

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  capCheck,
  countsAfterStart,
  evaluateCaps,
  isPaused,
  localDayEnd,
  localDayStart,
  pauseUntil,
  readCapCounts,
  setPause,
  startsInWindow,
  startsToday,
} from "../src/caps.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { insertStart } from "../src/scheduler/store.ts";

let db: Database;
let config: Config;

/** A local-time afternoon, so "today" and "yesterday" are unambiguous in every zone. */
const NOW = new Date(2026, 8, 20, 14, 0, 0);

function insertClaim(issueId: string, slot: number, state: string): void {
  db.run(
    `INSERT INTO claims (issue_id, agent_id, slot, state, claimed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [issueId, `agent-${slot}`, slot, state, NOW.toISOString(), NOW.toISOString()],
  );
}

function startAt(when: Date, issueId = "CB-1"): void {
  insertStart(db, issueId, when.toISOString());
}

function minutesAgo(m: number, from = NOW): Date {
  return new Date(from.getTime() - m * 60_000);
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  config = parseConfig({ workspace: "w", teamId: "t", repoPath: tmpdir() });
});

afterEach(() => {
  db.close();
});

describe("concurrency cap", () => {
  test("counts live claims only", () => {
    insertClaim("CB-1", 0, "claimed");
    insertClaim("CB-2", 1, "released");
    expect(capCheck(db, config, NOW, { firstStart: true }).ok).toBe(true);
    insertClaim("CB-3", 1, "implementing");
    const check = capCheck(db, config, NOW, { firstStart: true });
    expect(check.ok).toBe(false);
    expect(check.reasons).toEqual(["concurrency: 2 of 2 agents busy"]);
  });

  test("applies to bounces and resumes too", () => {
    insertClaim("CB-1", 0, "claimed");
    insertClaim("CB-2", 1, "planning");
    expect(capCheck(db, config, NOW, { firstStart: false }).ok).toBe(false);
  });
});

describe("daily cap on a local calendar day", () => {
  test("day bounds are local midnights", () => {
    expect(localDayStart(NOW)).toEqual(new Date(2026, 8, 20, 0, 0, 0));
    expect(localDayEnd(NOW)).toEqual(new Date(2026, 8, 21, 0, 0, 0));
  });

  test("a start one minute before local midnight is yesterday's", () => {
    startAt(new Date(2026, 8, 19, 23, 59, 0));
    startAt(new Date(2026, 8, 20, 0, 0, 0));
    startAt(new Date(2026, 8, 20, 13, 0, 0));
    expect(startsToday(db, NOW)).toBe(2);
  });

  test("the count resets at local midnight", () => {
    for (let i = 0; i < 6; i++) startAt(new Date(2026, 8, 20, 8 + i, 0, 0), `CB-${i}`);
    const before = capCheck(db, config, new Date(2026, 8, 20, 23, 59, 59), { firstStart: true });
    expect(before.reasons).toContain("daily: 6 of 6 starts used today (resets at local midnight)");
    const after = capCheck(db, config, new Date(2026, 8, 21, 0, 0, 0), { firstStart: true });
    expect(after.reasons.some((r) => r.startsWith("daily:"))).toBe(false);
  });
});

describe("window cap on a true rolling window", () => {
  test("a start exactly windowHours ago has left the window", () => {
    startAt(minutesAgo(5 * 60));
    startAt(minutesAgo(5 * 60 - 1));
    expect(startsInWindow(db, NOW, 5)).toBe(1);
  });

  test("blocks at windowStartCap and says when the next slot opens", () => {
    startAt(minutesAgo(4 * 60));
    startAt(minutesAgo(30));
    const check = capCheck(db, config, NOW, { firstStart: true });
    expect(check.ok).toBe(false);
    const freesAt = new Date(minutesAgo(4 * 60).getTime() + 5 * 3_600_000).toISOString();
    expect(check.reasons).toEqual([
      `window: 2 of 2 starts in the last 5 h (next slot at ${freesAt})`,
    ]);
    // One hour later the oldest start has rolled off.
    expect(capCheck(db, config, minutesAgo(-61), { firstStart: true }).ok).toBe(true);
  });
});

describe("firstStart: false", () => {
  test("skips the daily and window checks but not concurrency", () => {
    for (let i = 0; i < 6; i++) startAt(minutesAgo(10 * i), `CB-${i}`);
    expect(capCheck(db, config, NOW, { firstStart: true }).reasons).toHaveLength(2);
    expect(capCheck(db, config, NOW, { firstStart: false })).toEqual({ ok: true, reasons: [] });
    insertClaim("CB-1", 0, "claimed");
    insertClaim("CB-2", 1, "claimed");
    expect(capCheck(db, config, NOW, { firstStart: false }).reasons).toEqual([
      "concurrency: 2 of 2 agents busy",
    ]);
  });
});

describe("pause flag", () => {
  test("reads and writes pause_until, and clears itself by time", () => {
    expect(pauseUntil(db)).toBeNull();
    expect(isPaused(db, NOW)).toBe(false);
    const until = new Date(NOW.getTime() + 60_000);
    setPause(db, until);
    expect(pauseUntil(db)).toEqual(until);
    expect(isPaused(db, NOW)).toBe(true);
    expect(isPaused(db, until)).toBe(false);
    expect(capCheck(db, config, NOW, { firstStart: false }).reasons).toEqual([
      `paused until ${until.toISOString()}`,
    ]);
    setPause(db, null);
    expect(pauseUntil(db)).toBeNull();
  });

  test("a garbage value reads as not paused", () => {
    db.run("INSERT INTO flags (key, value) VALUES ('pause_until', 'soon')");
    expect(pauseUntil(db)).toBeNull();
  });
});

describe("dry-run helpers", () => {
  test("countsAfterStart bumps today and window for a first start only", () => {
    const counts = readCapCounts(db, config, NOW);
    expect(counts).toEqual({
      live: 0,
      today: 0,
      window: 0,
      windowFreesAt: null,
      pausedUntil: null,
    });
    const freesAt = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    const fresh = countsAfterStart(counts, { firstStart: true }, NOW, config);
    expect(fresh).toMatchObject({ live: 1, today: 1, window: 1, windowFreesAt: freesAt });
    const bounce = countsAfterStart(counts, { firstStart: false }, NOW, config);
    expect(bounce).toMatchObject({ live: 1, today: 0, window: 0, windowFreesAt: null });
    const two = countsAfterStart(fresh, { firstStart: true }, NOW, config);
    expect(evaluateCaps(two, config, { firstStart: true }).reasons).toEqual([
      "concurrency: 2 of 2 agents busy",
      `window: 2 of 2 starts in the last 5 h (next slot at ${freesAt})`,
    ]);
  });
});
