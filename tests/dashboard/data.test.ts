// Last edited: 2026-10-03 18:27 CDT
// `collectDashboard` over seeded claims, runs, events, and job fixtures: tokens, last action, the
// needs-you flag (tempo, needs, stall), the implement sub-phase, the block reason (new comment,
// old code + implement.json, plain words), the Linear filter on stale Blocked rows, and fault
// isolation for half-written files.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, parseConfig } from "../../src/config.ts";
import {
  type CollectDeps,
  collectDashboard,
  type LinearSnapshot,
} from "../../src/dashboard/data.ts";
import { writeHandoffMeta } from "../../src/handoff/meta.ts";
import { implementStatusPath } from "../../src/implement/status.ts";
import { killFlag } from "../../src/master/types.ts";
import { handoffPath } from "../../src/paths.ts";
import type { DaemonSession } from "../../src/runner/index.ts";
import { insertRun, updateRun } from "../../src/runner/store.ts";
import { insertEvent, setFlag } from "../../src/scheduler/store.ts";
import { type RunnerEnv, useRunnerEnv } from "../runner/helpers.ts";
import { pickable } from "../scheduler/fake-client.ts";
import { seedClaim } from "../scheduler/helpers.ts";

let env: RunnerEnv;
let config: Config;
const NOW = new Date("2026-10-03T19:00:00.000Z");

beforeEach(() => {
  env = useRunnerEnv();
  config = parseConfig({ workspace: "w", teamId: "t", repoPath: env.home.dir, maxAgents: 3 });
});

afterEach(() => {
  env.restore();
});

const noLinear: LinearSnapshot = { pickable: null, awaitingIds: null, fetchedAt: null, error: "x" };

function deps(overrides: Partial<CollectDeps> = {}): CollectDeps {
  return {
    db: env.db,
    config,
    now: NOW,
    daemonRunning: true,
    sessions: [],
    linear: noLinear,
    ...overrides,
  };
}

function session(id: string, pid: number | null): DaemonSession {
  return { id, pid, cwd: "/wt/1", sessionId: null, name: id, state: "working", startedAt: 1 };
}

/** A live claim with a run on `jobId` in its worktree. */
function seedAgent(state: string, jobId: string, slot = 0, identifier = "TOD-17"): void {
  seedClaim(env.db, {
    issueId: `uuid-${identifier}`,
    slot,
    state,
    identifier,
    title: "QA pass",
    worktreePath: `/wt/${slot + 1}`,
    claimedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
  });
  const runId = `run-${identifier}`;
  insertRun(
    env.db,
    { runId, name: `${identifier} implement`, cwd: `/wt/${slot + 1}` },
    NOW.toISOString(),
  );
  updateRun(env.db, runId, { jobId, state: "running" });
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function implementJson(identifier: string, fields: Record<string, unknown>): void {
  write(
    implementStatusPath(identifier),
    JSON.stringify({
      issueId: identifier,
      slot: 0,
      phase: "reviewing",
      cycle: 2,
      maxCycles: 4,
      branch: "b",
      prUrl: null,
      prDraft: false,
      ciState: null,
      outcome: null,
      reason: null,
      followups: [],
      reviewNotes: [],
      updatedAt: NOW.toISOString(),
      ...fields,
    }),
  );
}

describe("agents", () => {
  test("one slot per maxAgents; a busy one carries tokens, last action, model, sub-phase", async () => {
    seedAgent("implementing", "job00002");
    implementJson("TOD-17", {});
    const { agents } = await collectDashboard(deps());
    expect(agents.map((a) => a.agent?.identifier ?? null)).toEqual(["TOD-17", null, null]);
    expect(agents[0]?.agent).toMatchObject({
      url: "https://linear.app/w/issue/TOD-17",
      phase: "Implementing",
      subPhase: "review cycle 2/4",
      model: "opus",
      elapsedMs: 30 * 60_000,
      tokens: 2103,
      lastAction: "redacted",
      needsYou: null,
      killRequested: false,
      killable: true,
    });
  });

  test("tempo blocked + needs → needs-you flag; a kill flag shows; a resolver is not killable", async () => {
    seedAgent("planning", "job00001");
    seedAgent("resolving", "job00003", 1, "TOD-18");
    setFlag(env.db, killFlag("uuid-TOD-17"), NOW.toISOString());
    const { agents } = await collectDashboard(deps());
    expect(agents[0]?.agent).toMatchObject({
      phase: "Planning",
      subPhase: null,
      needsYou: "send a prompt to start",
      killRequested: true,
    });
    expect(agents[1]?.agent).toMatchObject({ phase: "Resolving conflicts", killable: false });
  });

  test("a live session with no activity past stallMinutes is flagged; no roster → no stall check", async () => {
    seedAgent("implementing", "job00002");
    const stale = { now: new Date(NOW.getTime() + 60 * 60_000) };
    const alive = await collectDashboard(deps({ ...stale, sessions: [session("job00002", 4242)] }));
    expect(alive.agents[0]?.agent?.needsYou).toBe("no activity for 15+ min");
    const unknown = await collectDashboard(deps({ ...stale, sessions: null }));
    expect(unknown.agents[0]?.agent?.needsYou).toBeNull();
  });

  test("a corrupt state.json or implement.json blanks those fields only", async () => {
    seedAgent("implementing", "job00002");
    writeFileSync(join(env.claudeDir, "jobs", "job00002", "state.json"), "{ half");
    write(implementStatusPath("TOD-17"), "{ half");
    const { agents } = await collectDashboard(deps());
    expect(agents[0]?.agent).toMatchObject({ identifier: "TOD-17", tokens: null, subPhase: null });
  });
});

describe("needs you", () => {
  test("an awaiting card reads the TLDR (label stripped), the round, and the hand-off", async () => {
    seedClaim(env.db, {
      issueId: "uuid-12",
      slot: 0,
      state: "awaiting_human",
      identifier: "TOD-12",
      prUrl: "https://github.com/o/r/pull/9",
    });
    write(
      handoffPath("TOD-12"),
      "# TOD-12\n\n<!-- x -->\n\n**TLDR:** It works now.\nSee PR.\n\n## Where\n",
    );
    writeHandoffMeta("TOD-12", {
      issueId: "TOD-12",
      commentId: "c",
      round: 2,
      prUrl: "https://github.com/o/r/pull/9",
      postedAt: NOW.toISOString(),
    });
    const { needsYou } = await collectDashboard(deps());
    expect(needsYou.cards[0]).toMatchObject({
      identifier: "TOD-12",
      tldr: "It works now.\nSee PR.",
      round: 2,
      hasHandoff: true,
      blockReason: null,
    });
  });

  test("block reasons: the new comment, an old outcome with implement.json, plain words", async () => {
    for (const [n, why] of [
      ["1", "killed"],
      ["2", "review_exhausted"],
      ["3", "missing_sections"],
    ]) {
      seedClaim(env.db, {
        issueId: `uuid-${n}`,
        slot: 0,
        state: "blocked",
        identifier: `TOD-${n}`,
      });
      insertEvent(env.db, NOW.toISOString(), "master.blocked", `uuid-${n}`, null, {
        why,
        ...(n === "1" ? { comment: "Marshall stopped this issue on request." } : {}),
      });
    }
    implementJson("TOD-2", { outcome: "review_exhausted", reason: "two findings left" });
    const { needsYou } = await collectDashboard(deps());
    const reasons = Object.fromEntries(needsYou.cards.map((c) => [c.identifier, c.blockReason]));
    expect(reasons).toEqual({
      "TOD-1": "Marshall stopped this issue on request.",
      "TOD-2": "The review rounds ran out before the PR was clean. Two findings left.",
      "TOD-3": "The hand-off package was missing required sections.",
    });
  });

  test("Linear's Needs Verification / Blocked list drops stale rows; without it, all show", async () => {
    seedClaim(env.db, { issueId: "uuid-a", slot: 0, state: "blocked", identifier: "TOD-6" });
    seedClaim(env.db, { issueId: "uuid-b", slot: 1, state: "blocked", identifier: "TOD-17" });
    seedClaim(env.db, { issueId: "uuid-c", slot: 2, state: "released", identifier: "TOD-15" });
    const checked = await collectDashboard(
      deps({ linear: { ...noLinear, awaitingIds: new Set(["uuid-b"]), error: null } }),
    );
    expect(checked.needsYou.cards.map((c) => c.identifier)).toEqual(["TOD-17"]);
    expect(checked.needsYou.checkedAgainstLinear).toBe(true);
    const unchecked = await collectDashboard(deps());
    expect(unchecked.needsYou.cards.map((c) => c.identifier).sort()).toEqual(["TOD-17", "TOD-6"]);
    expect(unchecked.needsYou.checkedAgainstLinear).toBe(false);
  });
});

describe("queue and strip", () => {
  test("the cached pickable list feeds collectQueue; an empty queue sets the badge", async () => {
    const issue = pickable({ identifier: "TOD-19" });
    const linear = {
      pickable: [issue],
      awaitingIds: new Set<string>(),
      fetchedAt: NOW.toISOString(),
      error: null,
    };
    const full = await collectDashboard(deps({ linear }));
    expect(full.queue.report?.rows.map((r) => [r.identifier, r.status])).toEqual([
      ["TOD-19", "next_start"],
    ]);
    expect(full.strip.queueEmpty).toBe(false);
    expect(full.strip.counts.live).toBe(0);
    const empty = await collectDashboard(deps({ linear: { ...linear, pickable: [] } }));
    expect(empty.strip.queueEmpty).toBe(true);
  });

  test("no list yet → the error, and no queue-empty badge", async () => {
    const { queue, strip } = await collectDashboard(deps());
    expect(queue).toEqual({ report: null, fetchedAt: null, error: "x" });
    expect(strip.queueEmpty).toBeNull();
  });
});
