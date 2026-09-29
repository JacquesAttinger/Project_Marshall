// Last edited: 2026-09-29 19:20 CDT
// Marking Linear issues Done when their PR merges: the merge poll's event path and the timed
// sweep that repairs the merges the poll missed (Marshall off, or the claim reused for a re-run).

import { afterEach, describe, expect, test } from "bun:test";
import { DONE_SWEEP_FLAG } from "../../src/phases/done.ts";
import { getClaim, getFlag } from "../../src/scheduler/store.ts";
import { pickable } from "../scheduler/fake-client.ts";
import { seedClaim } from "../scheduler/helpers.ts";
import {
  eventPayloads,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  PLAN,
  type PrListStub,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const PR = (n: number) => `https://github.com/example/chessbuddy/pull/${n}`;
const MERGED_AT = "2026-09-29T17:00:00Z";

function register(n: number, state: string, type = "started") {
  const issue = pickable({ identifier: `CB-${n}` });
  h.linear.issues.set(issue.id, { issue, state: { name: state, type }, labels: [] });
  return issue;
}

/** A parked claim with an open PR, as the hand-off phase leaves it. */
function parked(n: number, state = "awaiting_human") {
  const issue = register(n, "Needs Verification");
  seedClaim(h.db, {
    issueId: issue.id,
    identifier: issue.identifier,
    slot: 0,
    state,
    branch: issue.branchName,
    worktreePath: `${h.home.dir}/wt-CB-${n}`,
    planPath: PLAN,
    prUrl: PR(n),
    updatedAt: h.clock.now.toISOString(),
  });
  return issue;
}

function pr(n: number, title: string, state: string, mergedAt: string | null = null): PrListStub {
  return { number: n, url: PR(n), title, state, mergedAt };
}

const completes = () => h.linear.calls.filter((c) => c.method === "complete");

describe("merge poll", () => {
  test("a merged PR marks its issue Done with one comment naming the PR", async () => {
    h = makeMasterHarness();
    const issue = parked(1);
    h.gh.views.set(PR(1), { mergedAt: MERGED_AT, state: "MERGED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, issue.id)?.state).toBe("released");
    expect(h.linear.stateOf(issue.id)).toBe("Done");
    expect(h.linear.comments).toEqual([
      { issueId: issue.id, body: `Marked Done: ${PR(1)} merged at ${MERGED_AT}.` },
    ]);
    expect(masterEvents(h.db, issue.id)).toEqual(["phase_changed", "pr_merged", "done"]);
    expect(eventPayloads(h.db, "done")).toEqual([{ prUrl: PR(1), source: "merge_poll" }]);
  });

  test("a Linear failure leaves the claim released and is logged", async () => {
    h = makeMasterHarness();
    const issue = parked(1);
    h.gh.views.set(PR(1), { mergedAt: MERGED_AT, state: "MERGED" });
    h.linear.complete = async () => {
      throw new Error("linear: boom");
    };
    await h.hooks.pulse();
    expect(getClaim(h.db, issue.id)?.state).toBe("released");
    expect(h.lines.find((l) => l.event === "master.done_failed")?.fields.error).toBe(
      "linear: boom",
    );
    expect(masterEvents(h.db, issue.id)).not.toContain("done");
  });

  test("a closed PR does not mark Done", async () => {
    h = makeMasterHarness();
    const issue = parked(1);
    h.gh.views.set(PR(1), { state: "CLOSED" });
    h.gh.lists.set("CB-1", [pr(1, "CB-1: Issue 1", "CLOSED")]);
    await h.hooks.pulse();
    expect(getClaim(h.db, issue.id)?.state).toBe("released");
    expect(completes()).toHaveLength(0);
    expect(h.linear.stateOf(issue.id)).toBe("Needs Verification");
  });
});

describe("done sweep", () => {
  test("a Blocked issue with a merged PR and a released claim goes Done (the TOD-16 case)", async () => {
    h = makeMasterHarness();
    const issue = register(16, "Blocked");
    seedClaim(h.db, { issueId: issue.id, identifier: issue.identifier, slot: 0, state: "blocked" });
    h.gh.lists.set("CB-16", [pr(22, "CB-16: Issue 16", "MERGED", MERGED_AT)]);
    await h.hooks.pulse();
    expect(h.linear.stateOf(issue.id)).toBe("Done");
    expect(h.linear.comments[0]?.body).toBe(`Marked Done: ${PR(22)} merged at ${MERGED_AT}.`);
    expect(eventPayloads(h.db, "done")).toEqual([{ prUrl: PR(22), source: "sweep" }]);
    expect(h.gh.calls.find((c) => c[1] === "list")?.[3]).toBe("all");
  });

  test("an issue that was never claimed here is swept too", async () => {
    h = makeMasterHarness();
    const issue = register(5, "Needs Verification");
    h.gh.lists.set("CB-5", [pr(9, "CB-5: Issue 5", "MERGED", MERGED_AT)]);
    await h.hooks.pulse();
    expect(h.linear.stateOf(issue.id)).toBe("Done");
  });

  test("an issue with another PR still open stays put (the TOD-17 case)", async () => {
    h = makeMasterHarness();
    const issue = register(17, "Blocked");
    h.gh.lists.set("CB-17", [
      pr(10, "CB-17: Issue 17", "MERGED", MERGED_AT),
      pr(11, "CB-17: Issue 17, retry", "OPEN"),
    ]);
    await h.hooks.pulse();
    expect(completes()).toHaveLength(0);
    expect(h.linear.stateOf(issue.id)).toBe("Blocked");
  });
});

describe("done sweep guards", () => {
  test("a live claim is never swept", async () => {
    h = makeMasterHarness();
    const issue = register(3, "Blocked");
    seedClaim(h.db, {
      issueId: issue.id,
      identifier: issue.identifier,
      slot: 0,
      state: "implementing",
    });
    h.gh.lists.set("CB-3", [pr(4, "CB-3: Issue 3", "MERGED", MERGED_AT)]);
    await h.hooks.pulse();
    expect(completes()).toHaveLength(0);
    expect(h.gh.calls.some((c) => c[1] === "list")).toBe(false);
  });

  test("does nothing until doneSweepMinutes has passed since the last sweep", async () => {
    h = makeMasterHarness({ config: { doneSweepMinutes: 10 } });
    register(6, "Blocked");
    await h.hooks.pulse();
    expect(getFlag(h.db, DONE_SWEEP_FLAG)).toBe(h.clock.now.toISOString());
    const later = register(7, "Blocked");
    h.gh.lists.set("CB-7", [pr(8, "CB-7: Issue 7", "MERGED", MERGED_AT)]);

    h.tickClock(9 * 60_000);
    await h.hooks.pulse();
    expect(h.linear.stateOf(later.id)).toBe("Blocked");

    h.tickClock(60_000);
    await h.hooks.pulse();
    expect(h.linear.stateOf(later.id)).toBe("Done");
  });

  test("one failing gh call is logged and the next issue is still swept", async () => {
    h = makeMasterHarness();
    register(1, "Blocked");
    const second = register(2, "Blocked");
    const run = h.gh.run.bind(h.gh);
    h.gh.run = async (args, cwd) => {
      if (args[1] === "list" && args[5]?.startsWith("CB-1 ")) throw new Error("gh: boom");
      return run(args, cwd);
    };
    h.gh.lists.set("CB-2", [pr(2, "CB-2: Issue 2", "MERGED", MERGED_AT)]);
    await h.hooks.pulse();
    expect(h.lines.find((l) => l.event === "master.done_sweep_failed")?.fields.error).toBe(
      "gh: boom",
    );
    expect(h.linear.stateOf(second.id)).toBe("Done");
  });

  test("a Linear failure while listing is logged and the pulse survives", async () => {
    h = makeMasterHarness();
    h.linear.listAwaitingMerge = async () => {
      throw new Error("linear: down");
    };
    await h.hooks.pulse();
    expect(h.lines.find((l) => l.event === "master.done_sweep_failed")?.fields.error).toBe(
      "linear: down",
    );
  });
});
