// Last edited: 2026-09-20 23:10 CDT
// The RunWaiter's two step 08 additions: `settle` ends a pending wait by hand, and `terminalOf`
// reads a failure's details back from the hook row after a restart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunWaiter } from "../../src/plan/types.ts";
import { createRunWaiter, terminalOf } from "../../src/plan/wait.ts";
import { insertHookEvent, insertRun, updateRun } from "../../src/runner/store.ts";
import { hookFixture, type RunnerEnv, useRunnerEnv } from "../runner/helpers.ts";

let env: RunnerEnv;
let waiter: RunWaiter;

beforeEach(() => {
  env = useRunnerEnv();
  waiter = createRunWaiter(env.db, { pollMs: 0 });
});

afterEach(() => {
  waiter.stop();
  env.restore();
});

describe("settle", () => {
  test("resolves a pending wait with the given terminal and clears its timer", async () => {
    insertRun(env.db, { runId: "r1", name: "r1", cwd: "/tmp" });
    const pending = waiter.wait("r1", 60_000);
    expect(waiter.settle("r1", { kind: "failed", error: "stalled" })).toBe(true);
    expect(await pending).toEqual({ kind: "failed", error: "stalled" });
  });

  test("returns false when nothing waits on that run", () => {
    expect(waiter.settle("nope", { kind: "finished" })).toBe(false);
  });

  test("a wait registered after the run ended resolves from the row, not from settle", async () => {
    insertRun(env.db, { runId: "r2", name: "r2", cwd: "/tmp" });
    updateRun(env.db, "r2", { state: "finished" });
    expect(await waiter.wait("r2", 10)).toEqual({ kind: "finished" });
    expect(waiter.settle("r2", { kind: "failed", error: "x" })).toBe(false);
  });
});

describe("terminalOf", () => {
  test("null while active; finished; failed with the StopFailure details from the hook row", () => {
    insertRun(env.db, { runId: "r3", name: "r3", cwd: "/tmp" });
    expect(terminalOf(env.db, "r3")).toBeNull();
    const payload = hookFixture("stop-failure-rate-limit");
    insertHookEvent(env.db, "r3", "StopFailure", "2026-09-20T15:00:00Z", payload);
    updateRun(env.db, "r3", { state: "failed", error: "rate_limit" });
    expect(terminalOf(env.db, "r3")).toEqual({
      kind: "failed",
      error: "rate_limit",
      details: "You've hit your usage limit. Resets at 3pm.",
    });
  });

  test("a killed run reads as failed with the state as the error and no details", () => {
    insertRun(env.db, { runId: "r4", name: "r4", cwd: "/tmp" });
    updateRun(env.db, "r4", { state: "killed" });
    expect(terminalOf(env.db, "r4")).toEqual({ kind: "failed", error: "killed" });
  });
});
