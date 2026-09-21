// Last edited: 2026-09-21 15:10 CDT

import { afterEach, describe, expect, test } from "bun:test";
import { setPause } from "../../src/caps.ts";
import { getClaim } from "../../src/scheduler/store.ts";
import { orderIssues, tick } from "../../src/scheduler/tick.ts";
import { pickable } from "./fake-client.ts";
import {
  eventTypes,
  type Harness,
  makeHarness,
  NOW,
  seedClaim,
  startRows,
  todoAgain,
} from "./helpers.ts";

let h: Harness;

afterEach(() => {
  h?.close();
});

describe("orderIssues", () => {
  test("Urgent first, then oldest; priority 0 (none) sorts last", () => {
    const issues = [
      pickable({ identifier: "CB-1", priority: 0, createdAt: "2026-09-01T00:00:00.000Z" }),
      pickable({ identifier: "CB-2", priority: 3, createdAt: "2026-09-05T00:00:00.000Z" }),
      pickable({ identifier: "CB-3", priority: 1, createdAt: "2026-09-09T00:00:00.000Z" }),
      pickable({ identifier: "CB-4", priority: 3, createdAt: "2026-09-02T00:00:00.000Z" }),
      pickable({ identifier: "CB-5", priority: 4, createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(orderIssues(issues).map((i) => i.identifier)).toEqual([
      "CB-3",
      "CB-4",
      "CB-2",
      "CB-5",
      "CB-1",
    ]);
    expect(issues[0]?.identifier).toBe("CB-1"); // input untouched
  });
});

const tenIssues = () =>
  Array.from({ length: 10 }, (_, i) =>
    pickable({ identifier: `CB-${i + 1}`, priority: i === 6 ? 1 : 3 }),
  );

describe("tick: first-time starts", () => {
  test("10 pickable, caps 2/6/2: exactly 2 start on the first tick, in priority order", async () => {
    h = makeHarness({ issues: tenIssues() });
    const result = await tick(h.deps);
    expect(result.paused).toBe(false);
    const started = result.decisions.filter((d) => d.action === "started");
    expect(started.map((d) => d.identifier)).toEqual(["CB-7", "CB-1"]);
    expect(h.starts.map((s) => s.claim.slot)).toEqual([0, 1]);
    expect(h.starts.map((s) => s.claim.agentId)).toEqual(["agent-0", "agent-1"]);
    expect(h.starts[0]?.issue.identifier).toBe("CB-7");
    expect(startRows(h.db)).toHaveLength(2);
    expect(h.linear.stateOf("issue-7")).toBe("In Progress");
    expect(h.linear.labelsOf("issue-7")).toEqual(["marshall/agent-0"]);
    expect(h.linear.stateOf("issue-2")).toBe("Todo");
    expect(eventTypes(h.db)).toEqual(["scheduler.started", "scheduler.started"]);
  });

  test("the other eight report the concurrency cap", async () => {
    h = makeHarness({ issues: tenIssues() });
    const result = await tick(h.deps);
    const skipped = result.decisions.filter((d) => d.action === "skipped");
    expect(skipped).toHaveLength(8);
    for (const d of skipped) {
      expect(d.reason).toBe("caps");
      expect(d.detail?.[0]).toBe("concurrency: 2 of 2 agents busy");
    }
  });

  test("no third start until a slot frees and the window allows", async () => {
    const issues = Array.from({ length: 4 }, (_, i) => pickable({ identifier: `CB-${i + 1}` }));
    h = makeHarness({ issues });
    await tick(h.deps);
    expect(h.starts).toHaveLength(2);
    h.tickClock(60_000);
    await tick(h.deps);
    expect(h.starts).toHaveLength(2);
    // Free a slot: the window still holds 2 starts, so nothing new.
    h.db.run("UPDATE claims SET state = 'released' WHERE issue_id = 'issue-1'");
    const d = (await tick(h.deps)).decisions.find((x) => x.identifier === "CB-3");
    expect(d?.detail?.[0]).toMatch(/^window: 2 of 2 starts in the last 5 h/);
    expect(h.starts).toHaveLength(2);
    // Past the window: one more starts.
    h.tickClock(5 * 3_600_000);
    await tick(h.deps);
    expect(h.starts.map((s) => s.issue.identifier)).toEqual(["CB-1", "CB-2", "CB-3"]);
  });
});

describe("tick: the claim row", () => {
  test("the worktree is created off the base branch and the claim row records it", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-9" })] });
    await tick(h.deps);
    expect(h.worktreeCalls).toEqual([
      {
        op: "create",
        spec: { repoPath: h.config.repoPath, branch: "cb-9-issue", baseBranch: "main" },
      },
    ]);
    const claim = h.starts[0]?.claim;
    expect(claim).toMatchObject({
      state: "claimed",
      slot: 0,
      agentId: "agent-0",
      branch: "cb-9-issue",
      worktreePath: `${h.config.repoPath}-cb-9-issue`,
      bounces: 0,
      resumes: 0,
      claimedAt: NOW.toISOString(),
    });
    expect(getClaim(h.db, "issue-9")).toEqual(claim ?? null);
  });

  test("claim() returning false skips the issue and removes the write-ahead row", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" }), pickable({ identifier: "CB-2" })],
    });
    h.linear.loseClaims.add("issue-1");
    const result = await tick(h.deps);
    expect(result.decisions.map((d) => [d.identifier, d.action, d.reason])).toEqual([
      ["CB-1", "skipped", "claim_lost"],
      ["CB-2", "started", undefined],
    ]);
    expect(getClaim(h.db, "issue-1")).toBeNull();
    expect(getClaim(h.db, "issue-2")?.slot).toBe(0);
    expect(startRows(h.db).map((r) => r.issue_id)).toEqual(["issue-2"]);
    expect(h.worktreeCalls).toHaveLength(1);
  });

  test("an issue whose claim row is still live is skipped, not restarted", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "implementing", branch: "cb-1-issue" });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "skipped", reason: "live_claim" });
    expect(h.linear.calls.filter((c) => c.method === "claim")).toHaveLength(0);
    expect(h.lines.some((l) => l.event === "scheduler.skip_live_claim")).toBe(true);
  });
});

/** A released row with a branch: the issue was worked on before and came back. */
const bounced = (bounces: number) =>
  seedClaim(h.db, {
    issueId: "issue-1",
    slot: 1,
    state: "released",
    branch: "cb-1-old-title",
    worktreePath: "/wt/old",
    bounces,
    resumes: 2,
  });

describe("tick: bounces", () => {
  test("reuses the recorded branch, counts the bounce, resets resumes, inserts no starts row", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1", branchName: "cb-1-new-title" })] });
    bounced(1);
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "started", bounce: true });
    expect(h.worktreeCalls).toEqual([
      {
        op: "reuse",
        spec: { repoPath: h.config.repoPath, branch: "cb-1-old-title", baseBranch: "main" },
      },
    ]);
    expect(getClaim(h.db, "issue-1")).toMatchObject({
      state: "claimed",
      slot: 0,
      agentId: "agent-0",
      branch: "cb-1-old-title",
      bounces: 2,
      resumes: 0,
    });
    expect(startRows(h.db)).toHaveLength(0);
    expect(h.starts[0]?.claim.bounces).toBe(2);
  });

  test("a bounce ignores the daily and window caps", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    bounced(0);
    for (let i = 0; i < 6; i++) {
      h.db.run("INSERT INTO starts (issue_id, started_at) VALUES (?, ?)", [
        `x${i}`,
        new Date(NOW.getTime() - i * 60_000).toISOString(),
      ]);
    }
    expect((await tick(h.deps)).decisions[0]?.action).toBe("started");
    expect(startRows(h.db)).toHaveLength(6);
  });

  test("a bounce still waits for a free slot", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    bounced(0);
    seedClaim(h.db, { issueId: "a", slot: 0, state: "claimed" });
    seedClaim(h.db, { issueId: "b", slot: 1, state: "claimed" });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "skipped", reason: "caps", bounce: true });
    expect(result.decisions[0]?.detail).toEqual(["concurrency: 2 of 2 agents busy"]);
    todoAgain(h, "issue-1");
    h.db.run("UPDATE claims SET state = 'released' WHERE issue_id = 'a'");
    expect((await tick(h.deps)).decisions[0]?.action).toBe("started");
    expect(getClaim(h.db, "issue-1")?.slot).toBe(0);
  });
});

describe("tick: bounce limit", () => {
  test("blocks at maxBounces: Todo with labels off, then Blocked, row blocked, one event", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    bounced(3);
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({
      action: "skipped",
      reason: "blocked",
      bounce: true,
    });
    expect(h.linear.stateOf("issue-1")).toBe("Blocked");
    expect(h.linear.labelsOf("issue-1")).toEqual([]);
    expect(h.linear.comments[0]?.body).toMatch(/bounced 3 times, the maximum \(3\)/);
    expect(getClaim(h.db, "issue-1")?.state).toBe("blocked");
    expect(eventTypes(h.db)).toEqual(["scheduler.blocked"]);
    expect(h.starts).toHaveLength(0);
    // Not pickable any more, so the next tick does nothing.
    expect((await tick(h.deps)).decisions).toEqual([]);
  });

  test("a blocked issue moved back to Todo by a human gets a fresh bounce budget", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    seedClaim(h.db, {
      issueId: "issue-1",
      slot: 0,
      state: "blocked",
      branch: "cb-1-issue",
      bounces: 3,
    });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "started", bounce: true });
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "claimed", bounces: 1 });
    expect(eventTypes(h.db)).toEqual(["scheduler.unblocked", "scheduler.started"]);
  });
});

describe("tick: pause and failures", () => {
  test("the pause flag stops starts but not polling, and clears itself by time", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    setPause(h.db, new Date(NOW.getTime() + 10 * 60_000));
    const paused = await tick(h.deps);
    expect(paused).toEqual({ paused: true, decisions: [] });
    expect(h.linear.calls).toHaveLength(0);
    expect(h.lines.at(-1)?.event).toBe("scheduler.paused");
    h.tickClock(10 * 60_000);
    const resumed = await tick(h.deps);
    expect(resumed.paused).toBe(false);
    expect(resumed.decisions[0]?.action).toBe("started");
  });

  test("a worktree failure after the Linear claim blocks the issue with the reason", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" }), pickable({ identifier: "CB-2" })],
      failWorktree: new Set(["cb-1-issue"]),
    });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({
      action: "skipped",
      reason: "start_failed",
      detail: ["git failed for cb-1-issue"],
    });
    expect(h.linear.stateOf("issue-1")).toBe("Blocked");
    expect(h.linear.labelsOf("issue-1")).toEqual([]);
    expect(h.linear.comments[0]?.body).toMatch(/could not start this issue \(worktree\)/);
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "blocked", branch: null });
    expect(startRows(h.db).map((r) => r.issue_id)).toEqual(["issue-2"]);
    // The failed start freed its slot, so CB-2 took slot 0.
    expect(getClaim(h.db, "issue-2")?.slot).toBe(0);
    expect(eventTypes(h.db)).toEqual(["scheduler.blocked", "scheduler.started"]);
  });

  test("a throwing hooks.start blocks the issue and keeps the branch for a retry", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" })],
      failStart: new Set(["issue-1"]),
    });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "skipped", reason: "start_failed" });
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "blocked", branch: "cb-1-issue" });
    expect(h.linear.stateOf("issue-1")).toBe("Blocked");
    expect(eventTypes(h.db)).toEqual(["scheduler.started", "scheduler.blocked"]);
  });

  test("an error on one issue is logged and the pass goes on", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" }), pickable({ identifier: "CB-2" })],
    });
    h.linear.issues.delete("issue-1");
    h.linear.listPickable = async () => [
      pickable({ identifier: "CB-1" }),
      pickable({ identifier: "CB-2" }),
    ];
    const result = await tick(h.deps);
    expect(result.decisions.map((d) => d.identifier)).toEqual(["CB-2"]);
    expect(h.lines.find((l) => l.event === "scheduler.issue_error")?.fields.issueId).toBe(
      "issue-1",
    );
    // The write-ahead row did not survive to hold a slot: CB-2 took slot 0.
    expect(getClaim(h.db, "issue-1")).toBeNull();
    expect(getClaim(h.db, "issue-2")?.slot).toBe(0);
  });
});

describe("tick: human-only label", () => {
  test("skips an issue labeled human-only without touching Linear or the claim table", async () => {
    h = makeHarness({
      issues: [
        pickable({ identifier: "CB-1", labels: ["human-only"] }),
        pickable({ identifier: "CB-2" }),
      ],
    });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({
      identifier: "CB-1",
      action: "skipped",
      reason: "human_only",
    });
    expect(h.linear.calls.filter((c) => c.issueId === "issue-1")).toHaveLength(0);
    expect(getClaim(h.db, "issue-1")).toBeNull();
    expect(result.decisions.find((d) => d.identifier === "CB-2")?.action).toBe("started");
  });
});
