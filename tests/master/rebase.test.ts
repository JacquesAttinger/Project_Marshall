// Last edited: 2026-09-21 02:05 CDT
// Merge detection and the serial rebase queue (spec 5.4, decision 2), driven through the pulse
// over seeded parked claims: a sibling merge queues the others; a clean rebase re-posts the
// hand-off with a badge; a conflict or red CI takes a slot for a resolver run; one at a time.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveStatusPath } from "../../src/phases/rebase.ts";
import { updateRun } from "../../src/runner/store.ts";
import { getClaim, lowestFreeSlot } from "../../src/scheduler/store.ts";
import { seedClaim } from "../scheduler/helpers.ts";
import {
  eventPayloads,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  PLAN,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const PR = (n: number) => `https://github.com/example/chessbuddy/pull/${n}`;

/** A parked claim with an open PR, as the hand-off phase leaves it. */
function parked(n: number, state = "awaiting_human", extra: Record<string, unknown> = {}) {
  seedClaim(h.db, {
    issueId: `issue-${n}`,
    identifier: `CB-${n}`,
    slot: 0,
    state,
    branch: `cb-${n}-issue`,
    worktreePath: `${h.home.dir}/wt-CB-${n}`,
    planPath: PLAN,
    prUrl: PR(n),
    claimedAt: new Date(h.clock.now.getTime() - n * 60_000).toISOString(),
    updatedAt: h.clock.now.toISOString(),
    ...extra,
  });
  h.linear.issues.set(`issue-${n}`, {
    issue: {
      id: `issue-${n}`,
      identifier: `CB-${n}`,
      title: `Issue ${n}`,
      description: null,
      priority: 3,
      url: `https://linear.app/chessbuddy/issue/CB-${n}`,
      branchName: `cb-${n}-issue`,
      createdAt: "2026-09-10T00:00:00.000Z",
      labels: [],
      comments: [],
    },
    state: { name: "Needs Verification", type: "started" },
    labels: [],
  });
}

const green = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }];
const red = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }];
const running = [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }];

describe("merge detection", () => {
  test("a merged PR releases its claim and queues every other parked PR", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    parked(3, "rebasing");
    h.gh.views.set(PR(1), { mergedAt: "2026-09-20T18:00:00Z", state: "MERGED" });
    h.gh.views.set(PR(3), { statusCheckRollup: running });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(getClaim(h.db, "issue-2")).toMatchObject({
      state: "awaiting_human",
      rebaseAfter: PR(1),
    });
    expect(getClaim(h.db, "issue-3")).toMatchObject({ state: "rebasing", rebaseAfter: PR(1) });
    expect(masterEvents(h.db, "issue-1")).toEqual(["phase_changed", "pr_merged"]);
    expect(masterEvents(h.db, "issue-2")).toEqual(["rebase_queued"]);
    // Serial: CB-3 is still rebasing, so CB-2 waits.
    expect(h.git.calls.filter((c) => c.op === "rebase")).toHaveLength(0);
  });

  test("a closed PR releases its claim without queueing anything", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.gh.views.set(PR(1), { state: "CLOSED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(getClaim(h.db, "issue-2")?.rebaseAfter).toBeNull();
    expect(masterEvents(h.db, "issue-1")).toEqual(["phase_changed", "pr_closed"]);
  });

  test("a failing gh call is logged and the other PRs are still polled", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    const run = h.gh.run.bind(h.gh);
    h.gh.run = async (args, cwd) => {
      if (args[2] === PR(1)) throw new Error("gh: boom");
      return run(args, cwd);
    };
    h.gh.views.set(PR(2), { state: "MERGED", mergedAt: "x" });
    await h.hooks.pulse();
    expect(h.lines.find((l) => l.event === "master.merge_poll_failed")?.fields.error).toBe(
      "gh: boom",
    );
    expect(getClaim(h.db, "issue-2")?.state).toBe("released");
  });
});

describe("clean rebase", () => {
  test("fetch, rebase, push → rebasing; green CI → badge re-post → awaiting_human", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.gh.views.set(PR(1), { mergedAt: "2026-09-20T18:00:00Z", state: "MERGED" });
    h.gh.views.set(PR(2), { statusCheckRollup: [] });
    await h.hooks.pulse();
    expect(h.git.calls.map((c) => c.op)).toEqual(["fetch", "rebase", "forcePush"]);
    expect(h.git.calls[1]?.args).toEqual([`${h.home.dir}/wt-CB-2`, "main"]);
    expect(getClaim(h.db, "issue-2")?.state).toBe("rebasing");
    expect(lowestFreeSlot(h.db, 2)).toBe(0);

    // Right after the push, no checks yet: pending inside the grace period.
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("rebasing");
    expect(h.phases.postCalls).toHaveLength(0);

    h.gh.views.set(PR(2), { statusCheckRollup: green });
    await h.hooks.pulse();
    expect(h.phases.postCalls).toHaveLength(1);
    expect(h.phases.postCalls[0]).toMatchObject({
      issue: { id: "issue-2", identifier: "CB-2" },
      prUrl: PR(2),
      round: 1,
      badge: `rebased after ${PR(1)}`,
    });
    expect(getClaim(h.db, "issue-2")).toMatchObject({ state: "awaiting_human", rebaseAfter: null });
    expect(masterEvents(h.db, "issue-2")).toEqual([
      "rebase_queued",
      "phase_changed",
      "phase_changed",
      "rebased",
    ]);
  });
});

describe("serial rebases", () => {
  test("one stale PR per tick, oldest first; the next starts once the first lands", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    parked(3);
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    h.gh.views.set(PR(2), { statusCheckRollup: green });
    h.gh.views.set(PR(3), { statusCheckRollup: green });
    await h.hooks.pulse();
    // CB-3 was claimed earlier (claimedAt is `now - n minutes`), so it rebases first.
    expect(getClaim(h.db, "issue-3")?.state).toBe("rebasing");
    expect(getClaim(h.db, "issue-2")).toMatchObject({
      state: "awaiting_human",
      rebaseAfter: PR(1),
    });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-3")?.state).toBe("awaiting_human");
    expect(getClaim(h.db, "issue-2")?.state).toBe("awaiting_human");
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("rebasing");
    expect(h.git.calls.filter((c) => c.op === "rebase")).toHaveLength(2);
  });

  test("a second merge during a rebase keeps the PR queued after it lands", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    parked(4);
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    h.gh.views.set(PR(2), { statusCheckRollup: green });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-4")?.state).toBe("rebasing");
    h.gh.views.set(PR(2), { mergedAt: "y", state: "MERGED" });
    h.gh.views.set(PR(4), { statusCheckRollup: green });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-4")).toMatchObject({
      state: "awaiting_human",
      rebaseAfter: PR(2),
    });
    expect(eventPayloads(h.db, "rebased")[0]).toMatchObject({ requeued: PR(2) });
  });
});

describe("conflict and red CI: the resolver", () => {
  function resolveGreen(identifier: string) {
    const path = resolveStatusPath(identifier);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ outcome: "green", reason: null }));
  }

  test("conflict → resolver takes a slot; its green run lands with the badge and frees it", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    parked(3);
    h.git.conflict = true;
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    await h.hooks.pulse();
    const claim = getClaim(h.db, "issue-3");
    expect(claim).toMatchObject({ state: "resolving", slot: 0, agentId: "agent-0" });
    expect(lowestFreeSlot(h.db, 2)).toBe(1);
    expect(h.git.calls.filter((c) => c.op === "abortRebase")).toHaveLength(0);
    expect(h.runner.launches).toHaveLength(1);
    const launch = h.runner.launches[0]?.opts;
    expect(launch?.prompt).toBe(`/marshall:resolve-conflicts ${PLAN} CB-3 conflict`);
    expect(launch?.name).toBe("CB-3 resolve");
    expect(launch?.statusFile).toBe(resolveStatusPath("CB-3"));
    expect(launch?.env?.COMPOSE_PROJECT_NAME).toBe("marshall-0");
    expect(masterEvents(h.db, "issue-3")).toEqual([
      "rebase_queued",
      "rebase_conflict",
      "phase_changed",
    ]);
    // Serial: CB-2 waits while CB-3 resolves, even with a slot free.
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("awaiting_human");
    expect(h.runner.launches).toHaveLength(1);

    // The resolver finishes green; CI agrees.
    resolveGreen("CB-3");
    updateRun(h.db, h.runner.launches[0]?.runId as string, { state: "finished" });
    h.gh.views.set(PR(3), { statusCheckRollup: green });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-3")).toMatchObject({ state: "awaiting_human", rebaseAfter: null });
    expect(h.phases.postCalls[0]).toMatchObject({ badge: `rebased after ${PR(1)}` });
    expect(lowestFreeSlot(h.db, 2)).toBe(0);
    expect(masterEvents(h.db, "issue-3").at(-1)).toBe("rebased");
  });
});

describe("the resolver: slots and failures", () => {
  test("conflict with no free slot: the rebase is aborted and retried next tick", async () => {
    h = makeMasterHarness({ config: { maxAgents: 1 } });
    parked(1);
    parked(2);
    seedClaim(h.db, { issueId: "issue-9", slot: 0, state: "implementing" });
    h.git.conflict = true;
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")).toMatchObject({
      state: "awaiting_human",
      rebaseAfter: PR(1),
    });
    expect(h.git.calls.map((c) => c.op)).toEqual(["fetch", "rebase", "abortRebase"]);
    expect(h.runner.launches).toHaveLength(0);
    h.db.run("UPDATE claims SET state = 'released' WHERE issue_id = 'issue-9'");
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("resolving");
  });

  test("red CI after a clean rebase launches the resolver in ci mode", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    h.gh.views.set(PR(2), { statusCheckRollup: red });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("rebasing");
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("resolving");
    expect(h.runner.launches[0]?.opts.prompt).toBe(`/marshall:resolve-conflicts ${PLAN} CB-2 ci`);
    expect(eventPayloads(h.db, "rebase_conflict")[0]).toMatchObject({ kind: "ci_red" });
  });
});

describe("the resolver: give-ups", () => {
  test("a resolver that gives up blocks the issue with one event and restores the worktree", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.git.conflict = true;
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    await h.hooks.pulse();
    const path = resolveStatusPath("CB-2");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ outcome: "blocked", reason: "tests red after merge" }));
    updateRun(h.db, h.runner.launches[0]?.runId as string, { state: "finished" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.state).toBe("blocked");
    expect(h.linear.stateOf("issue-2")).toBe("Blocked");
    expect(h.linear.comments.at(-1)?.body).toContain("tests red after merge");
    expect(h.git.calls.slice(-2).map((c) => c.op)).toEqual(["abortRebase", "resetHard"]);
    expect(h.git.calls.at(-1)?.args[1]).toBe("origin/cb-2-issue");
    expect(
      masterEvents(h.db, "issue-2")
        .filter((e) => e !== "phase_changed")
        .at(-1),
    ).toBe("blocked");
    expect(lowestFreeSlot(h.db, 2)).toBe(0);
  });

  test("a stalled resolver is killed and the issue blocked", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.git.conflict = true;
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    await h.hooks.pulse();
    const runId = h.runner.launches[0]?.runId as string;
    h.runner.stalled.add(runId);
    await h.hooks.pulse();
    expect(h.runner.kills).toEqual([runId]);
    expect(getClaim(h.db, "issue-2")?.state).toBe("blocked");
    expect(eventPayloads(h.db, "blocked")[0]?.why).toBe("resolver_stalled");
  });

  test("a rate-limited resolver pauses the queue and re-queues the PR", async () => {
    h = makeMasterHarness();
    parked(1);
    parked(2);
    h.git.conflict = true;
    h.gh.views.set(PR(1), { mergedAt: "x", state: "MERGED" });
    await h.hooks.pulse();
    updateRun(h.db, h.runner.launches[0]?.runId as string, {
      state: "failed",
      error: "rate_limit",
    });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")).toMatchObject({
      state: "awaiting_human",
      rebaseAfter: PR(1),
    });
    expect(masterEvents(h.db, "issue-2").at(-1)).toBe("rate_limited");
    expect(lowestFreeSlot(h.db, 2)).toBe(0);
  });
});
