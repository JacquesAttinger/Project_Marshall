// Last edited: 2026-09-21 14:40 CDT
// The master agent's driver end to end with fakes: the happy path, the honest give-ups from
// implement.json, the bounce (revise plan, same branch, hand-off rewritten), and a restart of the
// orchestrator in the middle of the implement phase.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { implementStatusPath } from "../../src/implement/status.ts";
import { getRun } from "../../src/runner/store.ts";
import { getClaim, lowestFreeSlot } from "../../src/scheduler/store.ts";
import {
  claimFor,
  eventPayloads,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  PLAN,
  PR_URL,
  registerIssue,
  until,
  writeStatus,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

/** Start CB-1 through the hooks and wait for its implement run to be launched. */
async function startThroughPlanning(identifier = "CB-1") {
  const issue = registerIssue(h, identifier);
  const claim = claimFor(h, issue);
  await h.hooks.start(claim, issue);
  await until(() => h.runner.launches.length >= 1, 2000, "implement launch");
  return { issue, claim, implementRun: h.runner.launches[0]?.runId as string };
}

describe("happy path", () => {
  test("plan → implement → hand-off → Needs Verification, finished, slot freed", async () => {
    h = makeMasterHarness({ config: { fileFollowUps: true } });
    const { issue, implementRun } = await startThroughPlanning();

    // Planning ran fresh, and its result landed on the claim.
    expect(h.phases.planCalls).toHaveLength(1);
    expect(h.phases.planCalls[0]).toMatchObject({ mode: "fresh", cwd: `${h.home.dir}/wt-CB-1` });
    expect(h.phases.planCalls[0]?.model).toBeUndefined();
    expect(getClaim(h.db, issue.id)).toMatchObject({
      state: "implementing",
      planPath: PLAN,
      model: "opus",
    });

    // The implement launch: the skill prompt, the slot env, the status file, opus.
    const launch = h.runner.launches[0]?.opts;
    expect(launch?.prompt).toBe(`/marshall:implement ${PLAN} CB-1`);
    expect(launch?.name).toBe("CB-1 implement");
    expect(launch?.model).toBe("opus");
    expect(launch?.statusFile).toBe(implementStatusPath("CB-1"));
    expect(launch?.env).toMatchObject({
      MARSHALL_SLOT: "0",
      MARSHALL_ISSUE_DIR: expect.any(String),
    });
    expect(launch?.extraArgs?.[0]).toBe("--plugin-dir");

    writeStatus("CB-1");
    h.waiter.finish(implementRun, { kind: "finished" });
    await h.hooks.settled();

    expect(h.phases.handoffCalls).toHaveLength(1);
    expect(h.phases.handoffCalls[0]).toMatchObject({ planPath: PLAN, round: 1 });
    expect(h.linear.stateOf(issue.id)).toBe("Needs Verification");
    expect(h.linear.followUps).toEqual([
      { title: "Mirror the queen-side test", description: "Same path, other rook." },
    ]);
    expect(getClaim(h.db, issue.id)).toMatchObject({ state: "awaiting_human", prUrl: PR_URL });
    expect(lowestFreeSlot(h.db, 2)).toBe(0);
    expect(masterEvents(h.db)).toEqual([
      "phase_changed",
      "phase_changed",
      "phase_changed",
      "followup_filed",
      "phase_changed",
      "finished",
    ]);
    expect(eventPayloads(h.db, "phase_changed").map((p) => p.to)).toEqual([
      "planning",
      "implementing",
      "handoff",
      "awaiting_human",
    ]);
    expect(eventPayloads(h.db, "finished")[0]).toMatchObject({ prUrl: PR_URL, followups: 1 });
    expect(h.hooks.agents.size).toBe(0);
  });

  test("hooks.start returns before the phases finish; the tick is never blocked", async () => {
    h = makeMasterHarness();
    const issue = registerIssue(h, "CB-1");
    const claim = claimFor(h, issue);
    const started = h.hooks.start(claim, issue);
    await started;
    expect(h.hooks.agents.size).toBe(1);
    await until(() => h.runner.launches.length === 1);
    expect(getClaim(h.db, issue.id)?.state).toBe("implementing");
  });
});

describe("follow-ups", () => {
  test("with fileFollowUps off (the default) nothing is filed; the proposals are only counted", async () => {
    h = makeMasterHarness();
    expect(h.config.fileFollowUps).toBe(false);
    const issue = registerIssue(h, "CB-1");
    const claim = claimFor(h, issue);
    await h.hooks.start(claim, issue);
    await until(() => h.runner.launches.length === 1);
    const implementRun = h.runner.launches[0]?.runId as string;
    writeStatus("CB-1");
    h.waiter.finish(implementRun, { kind: "finished" });
    await h.hooks.settled();

    expect(h.linear.stateOf(issue.id)).toBe("Needs Verification");
    expect(h.linear.followUps).toEqual([]);
    expect(masterEvents(h.db)).not.toContain("followup_filed");
    expect(eventPayloads(h.db, "finished")[0]).toMatchObject({ prUrl: PR_URL, followups: 0 });
    expect(h.lines.find((l) => l.event === "master.followups_skipped")?.fields).toMatchObject({
      proposed: 1,
    });
  });
});

describe("honest give-ups", () => {
  test.each(["review_exhausted", "tests_red", "blocked"] as const)(
    "%s → Blocked with one event and the reason in the comment",
    async (outcome) => {
      h = makeMasterHarness();
      const { issue, implementRun } = await startThroughPlanning();
      writeStatus("CB-1", { outcome, reason: "4 cycles; still open: null check", prDraft: true });
      h.waiter.finish(implementRun, { kind: "finished" });
      await h.hooks.settled();
      expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
      expect(h.linear.stateOf(issue.id)).toBe("Blocked");
      expect(h.linear.comments.at(-1)?.body).toContain("4 cycles; still open: null check");
      expect(h.linear.comments.at(-1)?.body).toContain(PR_URL);
      expect(masterEvents(h.db).filter((e) => !e.startsWith("phase"))).toEqual(["blocked"]);
      expect(eventPayloads(h.db, "blocked")[0]?.why).toBe(outcome);
      expect(h.phases.handoffCalls).toHaveLength(0);
      expect(lowestFreeSlot(h.db, 2)).toBe(0);
    },
  );

  test("a run that stops with no outcome is resumed, then a fresh restart, then Blocked", async () => {
    h = makeMasterHarness();
    const { issue, implementRun } = await startThroughPlanning();
    h.waiter.finish(implementRun, { kind: "finished" });
    await until(() => h.runner.resumes.length === 1);
    expect(getClaim(h.db, issue.id)?.resumes).toBe(1);
    h.waiter.finish(h.runner.resumes[0]?.runId as string, { kind: "finished" });
    await until(() => h.runner.resumes.length === 2);
    h.waiter.finish(h.runner.resumes[1]?.runId as string, { kind: "finished" });
    await until(() => h.runner.launches.length === 2, 2000, "fresh launch");
    expect(getClaim(h.db, issue.id)?.freshRestarts).toBe(1);
    h.waiter.finish(h.runner.launches[1]?.runId as string, { kind: "finished" });
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "resumed",
      "resumed",
      "fresh_restart",
      "blocked",
    ]);
  });
});

describe("bounce", () => {
  test("revise plan with the stored model → implement on the same branch → hand-off round 2", async () => {
    h = makeMasterHarness({ config: { fileFollowUps: true } });
    const issue = registerIssue(h, "CB-1");
    // The first lifecycle, done: awaiting_human with a PR and a finished implement.json.
    const first = claimFor(h, issue);
    h.db.run(
      "UPDATE claims SET state = 'awaiting_human', plan_path = ?, model = 'fable', pr_url = ? WHERE issue_id = ?",
      [PLAN, PR_URL, issue.id],
    );
    writeStatus("CB-1", { followups: [{ title: "Already filed", body: "x" }] });
    h.db.run("INSERT INTO events (ts, issue_id, agent_id, type, payload) VALUES (?, ?, ?, ?, ?)", [
      h.clock.now.toISOString(),
      issue.id,
      first.agentId,
      "master.followup_filed",
      JSON.stringify({ title: "Already filed" }),
    ]);

    // The scheduler's bounce start.
    h.git.subjectOfHead = "Add the fix";
    const claim = claimFor(h, issue, 0, true);
    expect(claim.bounces).toBe(1);
    await h.hooks.start(claim, issue);
    await until(() => h.runner.launches.length === 1);

    expect(h.phases.planCalls[0]).toMatchObject({
      mode: "revise",
      model: "fable",
      planPath: PLAN,
      revision: 1,
    });
    // The branch was left where it was (no revision commit to strip) and the plan re-stored.
    expect(h.git.calls.find((c) => c.op === "resetHard")?.args[1]).toBe("headsha");
    // implement.json became a resume point so the skill reuses the PR.
    const status = JSON.parse(readFileSync(implementStatusPath("CB-1"), "utf8"));
    expect(status).toMatchObject({ outcome: null, phase: "starting", cycle: 0, prUrl: PR_URL });
    expect(h.runner.launches[0]?.opts.prompt).toBe(`/marshall:implement ${PLAN} CB-1`);

    writeStatus("CB-1", {
      followups: [
        { title: "Already filed", body: "x" },
        { title: "New one", body: "y" },
      ],
    });
    h.waiter.finish(h.runner.launches[0]?.runId as string, { kind: "finished" });
    await h.hooks.settled();
    expect(h.phases.handoffCalls[0]?.round).toBe(2);
    expect(h.linear.followUps.map((f) => f.title)).toEqual(["New one"]);
    expect(getClaim(h.db, issue.id)).toMatchObject({ state: "awaiting_human", bounces: 1 });
  });

  test("a revision commit already on the tip is stripped before the planner runs again", async () => {
    h = makeMasterHarness();
    const issue = registerIssue(h, "CB-1");
    claimFor(h, issue);
    h.db.run("UPDATE claims SET state = 'awaiting_human', plan_path = ? WHERE issue_id = ?", [
      PLAN,
      issue.id,
    ]);
    h.git.subjectOfHead = "Plan: revision 1";
    const claim = claimFor(h, issue, 0, true);
    await h.hooks.start(claim, issue);
    await until(() => h.phases.planCalls.length === 1);
    expect(h.git.calls.find((c) => c.op === "resetHard")?.args[1]).toBe("headsha~1");
    await until(() => h.runner.launches.length === 1);
    h.waiter.finish(h.runner.launches[0]?.runId as string, { kind: "failed", error: "killed" });
    await until(() => h.runner.resumes.length === 1);
    h.waiter.settle(h.runner.resumes[0]?.runId as string, { kind: "failed", error: "over_budget" });
    await h.hooks.settled();
    expect(existsSync(implementStatusPath("CB-1"))).toBe(false);
  });
});

describe("a crash inside the driver", () => {
  test("ends in Blocked with one crashed event; a failing block is only logged", async () => {
    h = makeMasterHarness();
    h.phases.plan = async () => {
      throw new Error("planner exploded");
    };
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(h.linear.comments.at(-1)?.body).toContain("planner exploded");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual(["crashed"]);

    const other = registerIssue(h, "CB-2");
    h.linear.setState = async () => {
      throw new Error("linear down");
    };
    await h.hooks.start(claimFor(h, other, 1), other);
    await h.hooks.settled();
    expect(h.lines.find((l) => l.event === "master.crashed_unrecovered")?.fields.error).toBe(
      "linear down",
    );
    expect(h.hooks.agents.size).toBe(0);
  });
});

describe("restart of the orchestrator", () => {
  test("attach mid-implementing continues from the row without a second job", async () => {
    h = makeMasterHarness();
    const { issue, implementRun } = await startThroughPlanning();
    // The process dies: the agent object is gone, the run and the row are not.
    h.hooks.agents.clear();
    const again = h.restart();
    const claim = getClaim(h.db, issue.id);
    if (!claim) throw new Error("claim");
    await again.attach(claim);
    expect(again.agents.size).toBe(1);
    expect(h.runner.launches).toHaveLength(1);
    expect(h.phases.planCalls).toHaveLength(1);
    writeStatus("CB-1");
    h.waiter.finish(implementRun, { kind: "finished" });
    await again.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("awaiting_human");
    expect(h.runner.launches).toHaveLength(1);
    expect(h.runner.resumes).toHaveLength(0);
  });

  test("attach after the run ended while the orchestrator was down reads its outcome", async () => {
    h = makeMasterHarness();
    const { issue, implementRun } = await startThroughPlanning();
    h.hooks.agents.clear();
    writeStatus("CB-1");
    h.waiter.finish(implementRun, { kind: "finished" });
    const again = h.restart();
    await again.attach(getClaim(h.db, issue.id) as NonNullable<ReturnType<typeof getClaim>>);
    await again.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("awaiting_human");
    expect(h.runner.launches).toHaveLength(1);
  });
});

describe("restart of the orchestrator: resume and planning", () => {
  test("resume (reconcile found the job dead) continues the session, no extra count", async () => {
    h = makeMasterHarness();
    const { issue, implementRun } = await startThroughPlanning();
    h.hooks.agents.clear();
    // Reconcile counted the resume before calling the hook.
    h.db.run("UPDATE claims SET resumes = 1 WHERE issue_id = ?", [issue.id]);
    const again = h.restart();
    await again.resume(getClaim(h.db, issue.id) as NonNullable<ReturnType<typeof getClaim>>);
    await until(() => h.runner.resumes.length === 1);
    expect(h.runner.kills).toEqual([implementRun]);
    expect(h.runner.resumes[0]?.opts.sessionId).toBe(
      getRun(h.db, implementRun)?.sessionId ?? "missing",
    );
    expect(getClaim(h.db, issue.id)?.resumes).toBe(1);
    expect(eventPayloads(h.db, "resumed")[0]).toMatchObject({ how: "boot" });
  });

  test("resume with a run that finished while the orchestrator was down reads its outcome", async () => {
    h = makeMasterHarness();
    const { issue, implementRun } = await startThroughPlanning();
    h.hooks.agents.clear();
    writeStatus("CB-1");
    h.waiter.finish(implementRun, { kind: "finished" });
    h.db.run("UPDATE claims SET resumes = 1 WHERE issue_id = ?", [issue.id]);
    const again = h.restart();
    await again.resume(getClaim(h.db, issue.id) as NonNullable<ReturnType<typeof getClaim>>);
    await again.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("awaiting_human");
    expect(h.runner.resumes).toHaveLength(0);
    expect(h.runner.launches).toHaveLength(1);
  });

  test("attach in planning waits on the live planner run instead of relaunching", async () => {
    h = makeMasterHarness();
    const issue = registerIssue(h, "CB-1");
    const claim = claimFor(h, issue);
    // A planner run is alive from before the restart.
    const planner = await h.runner.launch(h.db, {
      name: "CB-1 plan",
      cwd: claim.worktreePath as string,
      prompt: "/marshall:plan brief",
      model: "opus",
    });
    h.db.run("UPDATE claims SET state = 'planning', model = 'opus' WHERE issue_id = ?", [issue.id]);
    await h.hooks.attach(getClaim(h.db, issue.id) as NonNullable<ReturnType<typeof getClaim>>);
    await until(() => h.phases.planCalls.length === 1);
    expect(h.phases.planCalls[0]).toMatchObject({ attachRunId: planner.runId, model: "opus" });
    expect(h.git.calls.filter((c) => c.op === "resetHard")).toHaveLength(0);
  });
});
