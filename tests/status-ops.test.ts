// Last edited: 2026-09-21 01:40 CDT
// The operational sections of `marshall status` over a seeded DB: agents × runs with the model per
// phase, the needs-you list with hand-off paths, the daemon and pause lines, and the queue fallback.
// The launchctl runner is faked; the queue is injected.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setManualPause } from "../src/caps.ts";
import type { QueueReport } from "../src/cli/queue.ts";
import { rotateLogs } from "../src/cli/run.ts";
import { collectOps, formatElapsed, formatOps, modelFor } from "../src/cli/status-ops.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { handoffPath, launchdLogPaths, logPath } from "../src/paths.ts";
import { writePidfile } from "../src/pidfile.ts";
import { insertRun, updateRun } from "../src/runner/store.ts";
import { type TempHome, useTempHome } from "./helpers.ts";
import { NOW, seedClaim } from "./scheduler/helpers.ts";

let home: TempHome;
let db: Database;
let config: Config;

beforeEach(() => {
  home = useTempHome();
  db = openDb(":memory:");
  migrate(db);
  config = parseConfig({
    workspace: "chessbuddy",
    teamId: "t",
    repoPath: home.dir,
    models: { implement: "opus", handoff: "sonnet" },
  });
});

afterEach(() => {
  db.close();
  home.restore();
});

const linux = { platform: "linux" as const };

function seedTwoAgentsAndTwoParked() {
  seedClaim(db, {
    issueId: "i-1",
    slot: 0,
    state: "implementing",
    identifier: "CB-1",
    title: "Fix castling",
    worktreePath: "/wt/1",
    model: "fable",
    claimedAt: new Date(NOW.getTime() - 65 * 60_000).toISOString(),
  });
  insertRun(db, { runId: "r1", name: "CB-1 implement", cwd: "/wt/1" });
  updateRun(db, "r1", { jobId: "job1", state: "running" });
  seedClaim(db, {
    issueId: "i-2",
    slot: 1,
    state: "planning",
    identifier: "CB-2",
    worktreePath: "/wt/2",
    claimedAt: new Date(NOW.getTime() - 40_000).toISOString(),
  });
  seedClaim(db, {
    issueId: "i-3",
    slot: 0,
    state: "awaiting_human",
    identifier: "CB-3",
    title: "Opening explorer",
    prUrl: "https://github.com/x/y/pull/3",
  });
  seedClaim(db, { issueId: "i-4", slot: 1, state: "blocked", identifier: "CB-4" });
  const path = handoffPath("CB-3");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# hand-off");
}

describe("collectOps", () => {
  test("agents join their newest run; the model follows the phase; parked claims are needs-you", async () => {
    seedTwoAgentsAndTwoParked();
    const ops = await collectOps({ db, config, now: () => NOW, daemon: linux });
    expect(ops.agents).toEqual([
      {
        slot: 0,
        identifier: "CB-1",
        title: "Fix castling",
        phase: "implementing",
        model: "opus",
        elapsedMs: 65 * 60_000,
        run: { runId: "r1", name: "CB-1 implement", state: "running", jobId: "job1" },
      },
      {
        slot: 1,
        identifier: "CB-2",
        title: null,
        phase: "planning",
        model: "(classifying)",
        elapsedMs: 40_000,
        run: null,
      },
    ]);
    expect(ops.needsYou.map((n) => [n.identifier, n.state, n.handoffPath !== null])).toEqual([
      ["CB-3", "awaiting_human", true],
      ["CB-4", "blocked", false],
    ]);
    expect(ops.needsYou[0]?.prUrl).toBe("https://github.com/x/y/pull/3");
    expect(ops.daemon.state).toBe("unavailable");
    expect(ops.process).toBeNull();
    expect(ops.queue).toBeNull();
    expect(ops.queueError).toBeNull();
  });

  test("the pidfile, the manual pause, and a failing queue source are reported", async () => {
    writePidfile(NOW);
    setManualPause(db, NOW);
    const ops = await collectOps({
      db,
      config,
      now: () => NOW,
      daemon: linux,
      queue: async () => {
        throw new Error("Linear said no");
      },
    });
    expect(ops.process?.pid).toBe(process.pid);
    expect(ops.pausedAt).toBe(NOW.toISOString());
    expect(ops.queueError).toBe("Linear said no");
    const text = formatOps(ops);
    expect(text).toContain(`orchestrator  alive (pid ${process.pid}`);
    expect(text).toContain("PAUSED by `marshall pause`");
    expect(text).toContain("Queue\nunavailable: Linear said no");
    expect(text).toContain("Agents\nnone running");
    expect(text).toContain("Needs you\nnothing");
  });
});

describe("formatOps", () => {
  test("prints the four sections with aligned columns and the queue table", async () => {
    seedTwoAgentsAndTwoParked();
    const queue: QueueReport = {
      now: NOW.toISOString(),
      pausedUntil: null,
      pausedAt: null,
      counts: {
        live: 2,
        today: 2,
        window: 2,
        windowFreesAt: null,
        pausedUntil: null,
        pausedAt: null,
      },
      caps: { maxAgents: 2, dailyStartCap: 6, windowStartCap: 2, windowHours: 5 },
      rows: [],
    };
    const ops = await collectOps({
      db,
      config,
      now: () => NOW,
      daemon: linux,
      queue: async () => queue,
    });
    const text = formatOps(ops);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Daemon");
    expect(lines[1]).toBe("launchd       launchd is macOS-only");
    expect(text).toContain("Slot  Issue  Phase         Model          Elapsed  Run");
    expect(text).toContain(
      "0     CB-1   implementing  opus           1h 05m   CB-1 implement (running, job job1)  Fix castling",
    );
    expect(text).toContain("1     CB-2   planning      (classifying)  40s      -");
    expect(text).toContain("Agents 2/2 busy");
    expect(text).toContain("Nothing pickable.");
    expect(text).toContain(
      `CB-3   Needs Verification  https://github.com/x/y/pull/3  ${handoffPath("CB-3")}  Opening explorer`,
    );
    expect(text).toContain("CB-4   Blocked             -                              -");
  });

  test("formatElapsed and modelFor", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(61_000)).toBe("1m");
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe("1h 05m");
    const claim = { state: "handoff", model: "fable" } as Parameters<typeof modelFor>[0];
    expect(modelFor(claim, config)).toBe("sonnet");
    expect(modelFor({ ...claim, state: "resolving" }, config)).toBe("opus");
    expect(modelFor({ ...claim, state: "planning" }, config)).toBe("fable");
    expect(modelFor({ ...claim, state: "rate_limited" }, config)).toBe("-");
  });
});

describe("rotateLogs", () => {
  test("rotates the orchestrator log and launchd's two when they are over the limit", () => {
    const { out, err } = launchdLogPaths();
    mkdirSync(dirname(logPath()), { recursive: true });
    writeFileSync(logPath(), "x".repeat(6 * 1024 * 1024));
    writeFileSync(out, "small");
    writeFileSync(err, "y".repeat(6 * 1024 * 1024));
    expect(rotateLogs().sort()).toEqual([logPath(), err].sort());
    expect(rotateLogs()).toEqual([]);
  });
});
