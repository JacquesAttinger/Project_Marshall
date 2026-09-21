// Last edited: 2026-09-21 01:45 CDT
// The limits from spec 6.6 and 10.2, driven through the pulse with a fake clock: stall → resume
// → resume → fresh restart → Blocked (and the 20-minute guard), the 2-hour clock, and the
// rate-limit pause with a parsed reset time or the probe fallback.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isPaused, pauseUntil } from "../../src/caps.ts";
import { implementStatusPath } from "../../src/implement/status.ts";
import { getClaim, lowestFreeSlot } from "../../src/scheduler/store.ts";
import {
  claimFor,
  eventPayloads,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  PLAN,
  registerIssue,
  until,
  writeStatus,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function startImplementing() {
  const issue = registerIssue(h, "CB-1");
  const claim = claimFor(h, issue);
  await h.hooks.start(claim, issue);
  await until(() => h.runner.launches.length === 1, 2000, "implement launch");
  return { issue, runId: h.runner.launches[0]?.runId as string };
}

/** Mark the current run stalled and pulse: the agent kills it and recovers. */
async function stallAndPulse(runId: string) {
  h.runner.stalled.add(runId);
  await h.hooks.pulse();
  h.runner.stalled.delete(runId);
}

describe("stall", () => {
  test("resume → resume → fresh restart → Blocked, with the events and the discard", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    writeStatus("CB-1", { outcome: null, phase: "implementing", prUrl: null, ciState: null });

    await stallAndPulse(runId);
    await until(() => h.runner.resumes.length === 1, 2000, "first resume");
    expect(h.runner.kills).toEqual([runId]);
    expect(getClaim(h.db, issue.id)?.resumes).toBe(1);
    expect(h.runner.resumes[0]?.opts.prompt).toMatch(/interrupted/);

    await stallAndPulse(h.runner.resumes[0]?.runId as string);
    await until(() => h.runner.resumes.length === 2, 2000, "second resume");
    expect(getClaim(h.db, issue.id)?.resumes).toBe(2);

    // Out of resumes: the branch goes back to the plan commit and the phase starts fresh.
    await stallAndPulse(h.runner.resumes[1]?.runId as string);
    await until(() => h.runner.launches.length === 2, 2000, "fresh launch");
    expect(getClaim(h.db, issue.id)).toMatchObject({ resumes: 2, freshRestarts: 1 });
    const ops = h.git.calls.map((c) => c.op);
    expect(ops.slice(ops.indexOf("lastCommitTouching"))).toEqual([
      "lastCommitTouching",
      "resetHard",
      "forcePush",
    ]);
    expect(h.git.calls.findLast((c) => c.op === "resetHard")?.args[1]).toBe("plansha");
    // No PR yet, so implement.json is simply gone for the fresh run.
    expect(existsSync(implementStatusPath("CB-1"))).toBe(false);
    expect(h.runner.launches[1]?.opts.prompt).toBe(`/marshall:implement ${PLAN} CB-1`);

    // The fresh run stalls too: Blocked, one terminal event.
    await stallAndPulse(h.runner.launches[1]?.runId as string);
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(h.linear.stateOf(issue.id)).toBe("Blocked");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "stalled",
      "resumed",
      "stalled",
      "resumed",
      "stalled",
      "fresh_restart",
      "stalled",
      "blocked",
    ]);
    expect(eventPayloads(h.db, "blocked")[0]?.why).toBe("exhausted");
    expect(lowestFreeSlot(h.db, 2)).toBe(0);
  });

  test("a fresh restart keeps the PR when one exists: implement.json becomes a resume point", async () => {
    h = makeMasterHarness({ config: { maxResumes: 1 } });
    const { runId } = await startImplementing();
    writeStatus("CB-1", { outcome: null, phase: "reviewing", cycle: 2 });
    await stallAndPulse(runId);
    await until(() => h.runner.resumes.length === 1, 2000, "resume");
    await stallAndPulse(h.runner.resumes[0]?.runId as string);
    await until(() => h.runner.launches.length === 2, 2000, "fresh launch");
    expect(existsSync(implementStatusPath("CB-1"))).toBe(true);
    const status = JSON.parse(await Bun.file(implementStatusPath("CB-1")).text());
    expect(status).toMatchObject({ outcome: null, phase: "starting", cycle: 0 });
    expect(status.prUrl).toMatch(/pull\/12/);
  });
});

describe("stall: the fresh restart guard", () => {
  test("under 20 minutes of clock left, the fresh restart is skipped: straight to Blocked", async () => {
    h = makeMasterHarness({ config: { maxResumes: 1 } });
    const { issue, runId } = await startImplementing();
    await stallAndPulse(runId);
    await until(() => h.runner.resumes.length === 1, 2000, "resume");
    h.tickClock(2 * HOUR - 15 * MINUTE);
    await stallAndPulse(h.runner.resumes[0]?.runId as string);
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)).toMatchObject({ state: "blocked", freshRestarts: 0 });
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "stalled",
      "resumed",
      "stalled",
      "blocked",
    ]);
    expect(h.git.calls.filter((c) => c.op === "forcePush")).toHaveLength(0);
    expect(h.runner.launches).toHaveLength(1);
  });

  test("the pulse leaves a live, active run alone", async () => {
    h = makeMasterHarness();
    const { runId } = await startImplementing();
    await h.hooks.pulse();
    await h.hooks.pulse();
    expect(h.runner.kills).toHaveLength(0);
    expect(h.waiter.pending()).toEqual([runId]);
  });
});

describe("the 2-hour clock", () => {
  test("expiry mid-implement kills the run, marks Blocked, emits over_budget once", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    h.tickClock(2 * HOUR - MINUTE);
    await h.hooks.pulse();
    expect(h.runner.kills).toHaveLength(0);
    h.tickClock(2 * MINUTE);
    await h.hooks.pulse();
    await h.hooks.settled();
    expect(h.runner.kills).toEqual([runId]);
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(h.linear.stateOf(issue.id)).toBe("Blocked");
    expect(h.linear.comments.at(-1)?.body).toMatch(
      /2-hour clock ran out in the implementing phase/,
    );
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual(["over_budget"]);
    expect(h.runner.resumes).toHaveLength(0);
  });

  test("no phase launches past the clock: a plan result after expiry ends in over_budget", async () => {
    h = makeMasterHarness();
    let release: () => void = () => {};
    h.phases.plan = async (input) => {
      h.phases.planCalls.push(input);
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        ok: true,
        planPath: PLAN,
        classification: null,
        model: "opus",
        runId: "p",
        briefPath: "",
      };
    };
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => h.phases.planCalls.length === 1);
    h.tickClock(3 * HOUR);
    release();
    await h.hooks.settled();
    expect(h.runner.launches).toHaveLength(0);
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual(["over_budget"]);
  });

  test("the clock also ends a rate-limit wait", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    h.waiter.finish(runId, { kind: "failed", error: "rate_limit" });
    await until(() => getClaim(h.db, issue.id)?.state === "rate_limited");
    h.tickClock(3 * HOUR);
    await h.hooks.pulse();
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("blocked");
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "rate_limited",
      "over_budget",
    ]);
  });
});

describe("rate limit", () => {
  test("a parsed reset time pauses the queue until then; the probe resumes the same session", async () => {
    h = makeMasterHarness();
    const { issue, runId } = await startImplementing();
    h.waiter.finish(runId, {
      kind: "failed",
      error: "rate_limit",
      details: "You've hit your usage limit. Resets at 3pm.",
    });
    await until(() => getClaim(h.db, issue.id)?.state === "rate_limited");
    expect(pauseUntil(h.db)?.getTime()).toBe(new Date(2026, 8, 20, 15, 0, 0).getTime());
    expect(eventPayloads(h.db, "rate_limited")[0]).toMatchObject({ parsed: true });
    // The claim keeps its slot while paused.
    expect(lowestFreeSlot(h.db, 2)).toBe(1);

    h.tickClock(30 * MINUTE);
    await h.hooks.pulse();
    expect(h.runner.resumes).toHaveLength(0);
    expect(getClaim(h.db, issue.id)?.state).toBe("rate_limited");

    h.tickClock(31 * MINUTE);
    await h.hooks.pulse();
    await until(() => h.runner.resumes.length === 1, 2000, "probe resume");
    expect(isPaused(h.db, h.clock.now)).toBe(false);
    expect(getClaim(h.db, issue.id)).toMatchObject({ state: "implementing", resumes: 0 });
    expect(h.runner.resumes[0]?.opts.sessionId).toBe(`session-${runId.slice("run-".length)}`);
    expect(masterEvents(h.db).filter((e) => e !== "phase_changed")).toEqual([
      "rate_limited",
      "rate_limit_resumed",
    ]);

    // The probe hits the limit again, with nothing to parse: the probe delay, no resume spent.
    h.waiter.finish(h.runner.resumes[0]?.runId as string, { kind: "failed", error: "rate_limit" });
    await until(() => getClaim(h.db, issue.id)?.state === "rate_limited");
    expect(pauseUntil(h.db)?.getTime()).toBe(h.clock.now.getTime() + 30 * MINUTE);
    expect(eventPayloads(h.db, "rate_limited")[1]).toMatchObject({ parsed: false });
    expect(getClaim(h.db, issue.id)?.resumes).toBe(0);

    h.tickClock(31 * MINUTE);
    await h.hooks.pulse();
    await until(() => h.runner.resumes.length === 2, 2000, "second probe");
    writeStatus("CB-1");
    h.waiter.finish(h.runner.resumes[1]?.runId as string, { kind: "finished" });
    await h.hooks.settled();
    expect(getClaim(h.db, issue.id)?.state).toBe("awaiting_human");
  });

  test("a rate limit during planning pauses, then re-runs the plan phase uncounted", async () => {
    h = makeMasterHarness();
    h.phases.planResults.push({ ok: false, reason: "run_failed", detail: "rate_limit" });
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => getClaim(h.db, issue.id)?.state === "rate_limited");
    expect(h.phases.planCalls).toHaveLength(1);
    h.tickClock(31 * MINUTE);
    await h.hooks.pulse();
    await until(() => h.runner.launches.length === 1, 2000, "implement after re-plan");
    expect(h.phases.planCalls).toHaveLength(2);
    expect(getClaim(h.db, issue.id)).toMatchObject({ freshRestarts: 0, state: "implementing" });
  });
});
