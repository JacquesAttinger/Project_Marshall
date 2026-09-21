// Last edited: 2026-09-21 00:30 CDT
// `marshall kill <issue>` as the pulse executes it: the flag ends the live run, the claim lands in
// Blocked with one `blocked` event (the push the tailer sends), and the flag is cleared. Also the
// deferred case (nothing to interrupt yet), a rate-limit wait, and a flag with no agent behind it.

import { afterEach, describe, expect, test } from "bun:test";
import { pauseUntil } from "../../src/caps.ts";
import { killFlag } from "../../src/master/types.ts";
import { getClaim, getFlag, setFlag } from "../../src/scheduler/store.ts";
import {
  claimFor,
  eventPayloads,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  registerIssue,
  until,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

async function startImplementing() {
  const issue = registerIssue(h, "CB-1");
  const claim = claimFor(h, issue);
  await h.hooks.start(claim, issue);
  await until(() => h.runner.launches.length === 1, 2000, "implement launch");
  return { issue, runId: h.runner.launches[0]?.runId as string };
}

/**
 * Replace the plan phase with one that (optionally) launches a run, then blocks until the returned
 * release function is called, then fails with `detail`.
 */
function blockingPlan(launch: boolean, detail: string): { release(): void; ready(): boolean } {
  let release: (() => void) | null = null;
  h.phases.plan = async (input) => {
    h.phases.planCalls.push(input);
    if (launch) {
      input.onLaunched?.(
        await h.runner.launch(h.db, {
          name: "CB-1 plan",
          cwd: input.cwd,
          prompt: "",
          model: "opus",
        }),
      );
    }
    await new Promise<void>((r) => {
      release = r;
    });
    return { ok: false, reason: "run_failed", detail, runId: "p" };
  };
  return {
    release: () => (release as unknown as () => void)(),
    ready: () => release !== null,
  };
}

describe("kill flag through the pulse", () => {
  test("mid-implement: the run is killed, the issue is Blocked with one blocked event, flag cleared", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    setFlag(h.db, killFlag(issue.id), h.clock.now.toISOString());
    await h.hooks.pulse();
    await h.hooks.settled();
    expect(h.runner.kills).toEqual([runId]);
    expect(h.runner.resumes).toHaveLength(0);
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(h.linear.stateOf(issue.id)).toBe("Blocked");
    expect(h.linear.comments.at(-1)?.body).toMatch(/marshall kill.*implementing phase/);
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual(["blocked"]);
    expect(eventPayloads(h.db, "blocked")[0]?.why).toBe("killed");
    expect(getFlag(h.db, killFlag(issue.id))).toBeNull();
    expect(h.lines.map((l) => l.event)).toContain("master.killed");
  });

  test("mid-plan: the opaque phase's failure is read as a kill, not a fresh restart", async () => {
    h = makeMasterHarness();
    const plan = blockingPlan(true, "killed");
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => plan.ready() && h.runner.launches.length === 1, 2000, "plan launch");
    setFlag(h.db, killFlag(issue.id), h.clock.now.toISOString());
    await h.hooks.pulse();
    plan.release();
    await h.hooks.settled();
    expect(h.runner.kills).toEqual([h.runner.launches[0]?.runId as string]);
    expect(getClaim(h.db, issue.id)).toMatchObject({ state: "blocked", freshRestarts: 0 });
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual(["blocked"]);
    expect(h.phases.planCalls).toHaveLength(1);
  });

  test("during a rate-limit wait: the wait ends, the queue pause stays, the issue is Blocked", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    h.waiter.finish(runId, { kind: "failed", error: "rate_limit" });
    await until(() => getClaim(h.db, issue.id)?.state === "rate_limited");
    setFlag(h.db, killFlag(issue.id), h.clock.now.toISOString());
    await h.hooks.pulse();
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(pauseUntil(h.db)).not.toBeNull();
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "rate_limited",
      "blocked",
    ]);
    expect(h.runner.resumes).toHaveLength(0);
  });
});

describe("kill flag: deferred and stray", () => {
  test("between runs the flag waits for the next pulse instead of being lost", async () => {
    h = makeMasterHarness();
    // No run launched yet: the agent has nothing to interrupt.
    const first = blockingPlan(false, "boom");
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(first.ready);
    setFlag(h.db, killFlag(issue.id), h.clock.now.toISOString());
    await h.hooks.pulse();
    expect(getFlag(h.db, killFlag(issue.id))).not.toBeNull();
    expect(h.lines.map((l) => l.event)).toContain("master.kill_deferred");

    // The first plan fails on its own → one fresh restart → the second plan call launches a run.
    const second = blockingPlan(true, "killed");
    first.release();
    await until(() => second.ready() && h.runner.launches.length === 1, 2000, "2nd plan");
    await h.hooks.pulse();
    expect(getFlag(h.db, killFlag(issue.id))).toBeNull();
    expect(h.runner.kills).toEqual([h.runner.launches[0]?.runId as string]);
    second.release();
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "fresh_restart",
      "blocked",
    ]);
  });

  test("a flag with no agent behind it is cleared with a warning", async () => {
    h = makeMasterHarness();
    setFlag(h.db, killFlag("issue-404"), h.clock.now.toISOString());
    await h.hooks.pulse();
    expect(getFlag(h.db, killFlag("issue-404"))).toBeNull();
    expect(h.lines.find((l) => l.event === "master.kill_no_agent")?.fields.issueId).toBe(
      "issue-404",
    );
  });
});
