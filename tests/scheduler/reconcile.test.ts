// Last edited: 2026-09-20 16:40 CDT

import { afterEach, describe, expect, test } from "bun:test";
import { defaultHooks, startLoop } from "../../src/scheduler/index.ts";
import { reconcile } from "../../src/scheduler/reconcile.ts";
import { getClaim, liveClaims } from "../../src/scheduler/store.ts";
import { pickable } from "./fake-client.ts";
import { eventTypes, type Harness, makeHarness, seedClaim } from "./helpers.ts";

let h: Harness;

afterEach(() => {
  h?.close();
});

/** An issue the fake Linear holds as In Progress under our label, as after a real claim. */
function inProgress(h: Harness, issueId: string, slot: number): void {
  const entry = h.linear.issues.get(issueId);
  if (!entry) throw new Error(issueId);
  entry.state = { name: "In Progress", type: "started" };
  entry.labels = [`marshall/agent-${slot}`];
}

describe("reconcile", () => {
  test("releases a dead claim that is out of resumes and leaves Linear consistent", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    inProgress(h, "issue-1", 0);
    seedClaim(h.db, {
      issueId: "issue-1",
      slot: 0,
      state: "implementing",
      branch: "cb-1-issue",
      worktreePath: "/wt/1",
      resumes: 2,
    });
    const decisions = await reconcile(h.deps);
    expect(decisions).toEqual([{ issueId: "issue-1", action: "released" }]);
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(h.linear.stateOf("issue-1")).toBe("Todo");
    expect(h.linear.labelsOf("issue-1")).toEqual([]);
    expect(h.linear.comments[0]?.body).toMatch(/after 2 resumes.*branch `cb-1-issue`.*kept/);
    expect(eventTypes(h.db)).toEqual(["reconcile.released"]);
    expect(h.resumes).toHaveLength(0);
    // The issue is pickable again and nothing holds a slot.
    expect(liveClaims(h.db)).toEqual([]);
    expect((await h.linear.listPickable()).map((i) => i.id)).toEqual(["issue-1"]);
  });

  test("resumes a dead claim that has budget, through the hook, and counts it", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    inProgress(h, "issue-1", 1);
    seedClaim(h.db, {
      issueId: "issue-1",
      slot: 1,
      state: "planning",
      branch: "cb-1-issue",
      worktreePath: "/wt/1",
      resumes: 1,
    });
    const decisions = await reconcile(h.deps);
    expect(decisions).toEqual([{ issueId: "issue-1", action: "resumed" }]);
    expect(h.resumes).toHaveLength(1);
    expect(h.resumes[0]).toMatchObject({ issueId: "issue-1", resumes: 2, state: "planning" });
    expect(getClaim(h.db, "issue-1")?.resumes).toBe(2);
    expect(h.linear.stateOf("issue-1")).toBe("In Progress");
    expect(eventTypes(h.db)).toEqual(["reconcile.resumed"]);
  });

  test("repairs a claiming orphan: released, comment, no runner call", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    inProgress(h, "issue-1", 0);
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "claiming" });
    h.alive.add("issue-1"); // would be alive, but a claiming row never has a job
    const decisions = await reconcile(h.deps);
    expect(decisions).toEqual([{ issueId: "issue-1", action: "orphan_released" }]);
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(h.linear.stateOf("issue-1")).toBe("Todo");
    expect(h.linear.comments[0]?.body).toMatch(/in the middle of picking this issue up/);
    expect(eventTypes(h.db)).toEqual(["reconcile.orphan_released"]);
  });

  test("keeps an alive claim untouched", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    inProgress(h, "issue-1", 0);
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "implementing", worktreePath: "/wt/1" });
    h.alive.add("issue-1");
    expect(await reconcile(h.deps)).toEqual([{ issueId: "issue-1", action: "kept" }]);
    expect(getClaim(h.db, "issue-1")?.state).toBe("implementing");
    expect(h.linear.calls).toHaveLength(0);
    expect(eventTypes(h.db)).toEqual(["reconcile.kept"]);
  });
});

describe("reconcile: errors and mixes", () => {
  test("a liveness error keeps the claim rather than releasing a possibly live agent", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" })],
      failLiveness: new Set(["issue-1"]),
    });
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "implementing", worktreePath: "/wt/1" });
    expect(await reconcile(h.deps)).toEqual([{ issueId: "issue-1", action: "kept" }]);
    expect(h.lines.some((l) => l.event === "reconcile.liveness_error")).toBe(true);
  });

  test("a throwing resume hook falls back to a release", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" })],
      failResume: new Set(["issue-1"]),
    });
    inProgress(h, "issue-1", 0);
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "planning", worktreePath: "/wt/1" });
    expect(await reconcile(h.deps)).toEqual([{ issueId: "issue-1", action: "released" }]);
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "released", resumes: 1 });
    expect(h.linear.stateOf("issue-1")).toBe("Todo");
    expect(eventTypes(h.db)).toEqual(["reconcile.resumed", "reconcile.released"]);
  });

  test("handles every live claim and ignores terminal rows", async () => {
    h = makeHarness({
      issues: [
        pickable({ identifier: "CB-1" }),
        pickable({ identifier: "CB-2" }),
        pickable({ identifier: "CB-3" }),
      ],
    });
    inProgress(h, "issue-1", 0);
    inProgress(h, "issue-2", 1);
    seedClaim(h.db, {
      issueId: "issue-1",
      slot: 0,
      state: "claimed",
      worktreePath: "/wt/1",
      resumes: 2,
    });
    seedClaim(h.db, { issueId: "issue-2", slot: 1, state: "claimed", worktreePath: "/wt/2" });
    seedClaim(h.db, { issueId: "issue-3", slot: 0, state: "released" });
    h.alive.add("issue-2");
    expect(await reconcile(h.deps)).toEqual([
      { issueId: "issue-1", action: "released" },
      { issueId: "issue-2", action: "kept" },
    ]);
  });
});

describe("defaultHooks", () => {
  test("resume releases to Todo with a comment; start only logs", async () => {
    h = makeHarness({ issues: [pickable({ identifier: "CB-1" })] });
    inProgress(h, "issue-1", 0);
    seedClaim(h.db, { issueId: "issue-1", slot: 0, state: "planning", worktreePath: "/wt/1" });
    h.deps.hooks = defaultHooks(h.deps);
    expect(await reconcile(h.deps)).toEqual([{ issueId: "issue-1", action: "resumed" }]);
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "released", resumes: 1 });
    expect(h.linear.stateOf("issue-1")).toBe("Todo");
    expect(h.linear.comments[0]?.body).toMatch(/no master agent yet/);
    const claim = getClaim(h.db, "issue-1");
    if (!claim) throw new Error("claim");
    await h.deps.hooks.start(claim, pickable({ identifier: "CB-1" }));
    expect(h.lines.at(-1)?.event).toBe("scheduler.no_master_agent");
  });
});

describe("startLoop", () => {
  test("reconciles once, ticks at once, then keeps polling until stopped", async () => {
    h = makeHarness({
      issues: [pickable({ identifier: "CB-1" }), pickable({ identifier: "CB-2" })],
    });
    seedClaim(h.db, { issueId: "issue-9", slot: 1, state: "claiming" });
    h.linear.issues.set("issue-9", {
      issue: pickable({ identifier: "CB-9" }),
      state: { name: "In Progress", type: "started" },
      labels: ["marshall/agent-1"],
    });
    const loop = startLoop(h.deps, { pollMs: 20 });
    await loop.ready;
    expect(eventTypes(h.db)[0]).toBe("reconcile.orphan_released");
    const polls = () => h.linear.calls.filter((c) => c.method === "listPickable").length;
    expect(polls()).toBe(1);
    expect(h.starts).toHaveLength(2);
    while (polls() < 3) await Bun.sleep(5);
    loop.stop();
    const after = polls();
    await Bun.sleep(60);
    expect(polls()).toBe(after);
  });

  test("a tick that throws is logged and the loop goes on", async () => {
    h = makeHarness();
    let calls = 0;
    h.linear.listPickable = async () => {
      calls += 1;
      if (calls === 1) throw new Error("linear down");
      return [];
    };
    const loop = startLoop(h.deps, { pollMs: 10 });
    await loop.ready;
    expect(h.lines.find((l) => l.event === "scheduler.tick_error")?.fields.error).toBe(
      "linear down",
    );
    while (calls < 2) await Bun.sleep(5);
    loop.stop();
  });
});
