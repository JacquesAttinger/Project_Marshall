// Last edited: 2026-10-03 18:27 CDT
// `requestKill` (src/kill.ts), branch by branch: no claim, not live, the flag with a live
// orchestrator (pidfile, or launchd running with no pidfile yet), a resolver it refuses, and the
// direct path with no orchestrator. The fake runner env stands in for `claude stop`; Linear is
// the in-memory fake client; launchctl is faked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KillDeps,
  killMessage,
  killSucceeded,
  orchestratorPid,
  requestKill,
} from "../src/kill.ts";
import { killFlag } from "../src/master/types.ts";
import { writePidfile } from "../src/pidfile.ts";
import { getRun, insertRun, updateRun } from "../src/runner/store.ts";
import { getClaim, getFlag, latestBlockEvent } from "../src/scheduler/store.ts";
import { recordingLogger } from "./helpers.ts";
import { type RunnerEnv, useRunnerEnv } from "./runner/helpers.ts";
import { type FakeLinearClient, fakeClient, pickable } from "./scheduler/fake-client.ts";
import { NOW, seedClaim } from "./scheduler/helpers.ts";

let env: RunnerEnv;
let linear: FakeLinearClient;
let connects: number;

beforeEach(() => {
  env = useRunnerEnv();
  linear = fakeClient([pickable({ identifier: "CB-1" })]);
  connects = 0;
});

afterEach(() => {
  env.restore();
});

function deps(overrides: Partial<KillDeps> = {}): KillDeps {
  return {
    db: env.db,
    log: recordingLogger().log,
    now: () => NOW,
    linear: async () => {
      connects += 1;
      return linear;
    },
    daemon: { platform: "linux" },
    ...overrides,
  };
}

function seedLive(state = "implementing"): void {
  seedClaim(env.db, {
    issueId: "issue-1",
    slot: 0,
    state,
    identifier: "CB-1",
    worktreePath: "/wt/1",
    branch: "cb-1-issue",
  });
}

/** A launchctl fake that reports the daemon running, and a plist file that exists. */
function launchdRunning(): Pick<KillDeps, "daemon" | "launchdHome"> {
  const plist = join(env.home.dir, "daemon.plist");
  writeFileSync(plist, "");
  return {
    launchdHome: env.home.dir,
    daemon: {
      platform: "darwin",
      plist,
      launchctl: async () => ({ code: 0, stdout: "state = running\npid = 777\n", stderr: "" }),
    },
  };
}

describe("requestKill: refusals", () => {
  test("unknown identifier → no_claim; a parked claim → not_live", async () => {
    expect(await requestKill(deps(), "CB-9")).toEqual({ kind: "no_claim", identifier: "CB-9" });
    seedLive("blocked");
    const result = await requestKill(deps(), "cb-1");
    expect(result).toEqual({ kind: "not_live", identifier: "CB-1", state: "blocked" });
    expect(killSucceeded(result)).toBe(false);
    expect(killMessage(result)).toBe("CB-1 is not running (state: blocked)");
    expect(connects).toBe(0);
  });

  test("a resolver with a live orchestrator → not_killable, no flag", async () => {
    seedLive("resolving");
    writePidfile(NOW);
    const result = await requestKill(deps(), "CB-1");
    expect(result.kind).toBe("not_killable");
    expect(killMessage(result)).toMatch(/marshall stop/);
    expect(getFlag(env.db, killFlag("issue-1"))).toBeNull();
  });
});

describe("requestKill: live orchestrator", () => {
  test("pidfile alive → flag set once, then already_requested", async () => {
    seedLive();
    writePidfile(NOW);
    const first = await requestKill(deps(), "CB-1");
    expect(first).toEqual({
      kind: "flagged",
      identifier: "CB-1",
      state: "implementing",
      pid: process.pid,
    });
    expect(getFlag(env.db, killFlag("issue-1"))).toBe(NOW.toISOString());
    expect(await requestKill(deps(), "CB-1")).toEqual({
      kind: "already_requested",
      identifier: "CB-1",
    });
    expect(connects).toBe(0);
  });

  test("launchd running with no pidfile yet → flag path, not a direct kill", async () => {
    seedLive();
    expect(await orchestratorPid(launchdRunning())).toBe(777);
    const result = await requestKill(deps(launchdRunning()), "CB-1");
    expect(result).toMatchObject({ kind: "flagged", pid: 777 });
    expect(connects).toBe(0);
  });

  test("launchd serves another state root → ignored", async () => {
    const other = { ...launchdRunning(), launchdHome: "/somewhere/else" };
    expect(await orchestratorPid(other)).toBeNull();
  });
});

describe("requestKill: no orchestrator", () => {
  test("stops the worktree's runs and blocks the issue in Linear and the DB", async () => {
    seedLive();
    insertRun(env.db, { runId: "r1", name: "CB-1 implement", cwd: "/wt/1" });
    updateRun(env.db, "r1", { jobId: "job00002", state: "running" });
    insertRun(env.db, { runId: "r2", name: "other", cwd: "/wt/2" });
    const result = await requestKill(deps(), "CB-1");
    expect(result).toEqual({ kind: "killed_directly", identifier: "CB-1", runsStopped: 1 });
    expect(connects).toBe(1);
    expect(getRun(env.db, "r1")?.state).toBe("killed");
    expect(getRun(env.db, "r2")?.state).toBe("starting");
    expect(getClaim(env.db, "issue-1")?.state).toBe("blocked");
    expect(linear.stateOf("issue-1")).toBe("Blocked");
    expect(latestBlockEvent(env.db, "issue-1")).toMatchObject({
      type: "master.blocked",
      why: "killed",
      comment: expect.stringMatching(/while no orchestrator was running/),
    });
  });

  test("a Linear connect failure surfaces before any run is stopped", async () => {
    seedLive();
    insertRun(env.db, { runId: "r1", name: "CB-1 implement", cwd: "/wt/1" });
    const failing = deps({
      linear: async () => {
        throw new Error("MARSHALL_LINEAR_API_KEY is not set");
      },
    });
    await expect(requestKill(failing, "CB-1")).rejects.toThrow(/MARSHALL_LINEAR_API_KEY/);
    expect(getRun(env.db, "r1")?.state).toBe("starting");
    expect(getClaim(env.db, "issue-1")?.state).toBe("implementing");
  });
});
