// Last edited: 2026-09-20 12:20 CDT
// runPlanPhase end to end with the fake claude shim: its --bg branch runs a script that plays the
// planner (writes the plan file and commits), then the test appends the Stop hook line and the
// watcher finishes the run. A fake Linear client records the comment.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, parseConfig } from "../../src/config.ts";
import { PLUGIN_DIR, runPlanPhase } from "../../src/plan/index.ts";
import type { PlanPhaseInput, RunWaiter } from "../../src/plan/types.ts";
import { createRunWaiter } from "../../src/plan/wait.ts";
import { eventsFile } from "../../src/runner/settings.ts";
import { getRun } from "../../src/runner/store.ts";
import type { Run } from "../../src/runner/types.ts";
import {
  fakeCalls,
  fakeStops,
  hookFixture,
  type RunnerEnv,
  setFakePrint,
  useRunnerEnv,
} from "../runner/helpers.ts";
import { commitFile, git, makeRepo, sampleIssue, type TempRepo } from "./helpers.ts";

const PLANS = resolve(import.meta.dir, "..", "fixtures", "plans");
const PLAN = "docs/fix-castling_plan.md";

let env: RunnerEnv;
let repo: TempRepo;
let config: Config;
let waiter: RunWaiter;
let comments: { issueId: string; body: string }[];

beforeEach(() => {
  env = useRunnerEnv();
  repo = makeRepo();
  config = parseConfig({ workspace: "w", teamId: "t", repoPath: env.home.dir });
  waiter = createRunWaiter(env.db, { pollMs: 50 });
  comments = [];
});

afterEach(() => {
  waiter.stop();
  repo.remove();
  env.restore();
});

/** The fake planner: a shell script the shim runs in the worktree before printing the job id. */
function planScript(body: string): void {
  const path = join(env.fakeDir, "plan.sh");
  writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`);
  process.env.FAKE_CLAUDE_PLAN_SCRIPT = path;
}

function copyAndCommit(fixture: string, message = "Plan: Fix castling through check"): string {
  return `cp ${join(PLANS, fixture)} ${PLAN}\ngit add ${PLAN}\ngit commit -q -m "${message}"`;
}

/** Append a hook line for the run, as hook-sink.sh would. */
function hookLine(run: Run, fixture: string): void {
  const line = JSON.stringify({
    received_at: new Date().toISOString(),
    event: hookFixture(fixture),
  });
  appendFileSync(eventsFile(run.runId), `${line}\n`);
}

function input(overrides: Partial<PlanPhaseInput> = {}): PlanPhaseInput {
  return {
    db: env.db,
    linear: { comment: async (issueId, body) => void comments.push({ issueId, body }) },
    config,
    issue: sampleIssue(),
    cwd: repo.dir,
    base: repo.base,
    waiter,
    onLaunched: (run) => hookLine(run, "stop-empty"),
    ...overrides,
  };
}

describe("runPlanPhase, fresh", () => {
  test("classifies, briefs, launches with the plugin, verifies, and posts the summary", async () => {
    planScript(copyAndCommit("good_plan.md"));
    const result = await runPlanPhase(input());
    expect(result).toMatchObject({
      ok: true,
      planPath: PLAN,
      classification: { complexity: "simple", reason: "canned" },
      model: "opus",
    });
    if (!result.ok) return;
    expect(result.runId).toMatch(/^cb-12-plan-[0-9a-f]{8}$/);
    expect(result.briefPath).toBe(join(env.home.dir, "briefs", `${result.runId}.md`));
    expect(readFileSync(result.briefPath, "utf8")).toContain(
      "# CB-12 — Fix castling through check",
    );

    const [classify, launch] = fakeCalls(env);
    expect(classify?.[0]).toBe("-p");
    expect(launch?.slice(0, 5)).toEqual(["--bg", "--name", "CB-12 plan", "--model", "opus"]);
    expect(launch).toContain("--strict-mcp-config");
    expect(launch?.slice(-3)).toEqual([
      "--plugin-dir",
      PLUGIN_DIR,
      `/marshall:plan ${result.briefPath}`,
    ]);
    expect(getRun(env.db, result.runId)?.state).toBe("finished");

    expect(comments).toHaveLength(1);
    expect(comments[0]?.issueId).toBe("issue-1");
    expect(comments[0]?.body).toContain(
      "**Plan for CB-12** — `docs/fix-castling_plan.md` on `cb-12-fix-castling-through-check`",
    );
    expect(comments[0]?.body).toContain("**TLDR:** The king can castle");
    expect(comments[0]?.body).toContain(
      "**Decisions made alone**\n\n- Kept the fix in `castlingMoves()`",
    );
  });

  test("a complex classification picks planComplex", async () => {
    setFakePrint(env, { structured_output: { complexity: "complex", reason: "big" } });
    planScript(copyAndCommit("good_plan.md"));
    const result = await runPlanPhase(input());
    expect(result).toMatchObject({ ok: true, model: "fable" });
  });

  test("an explicit model skips the classifier", async () => {
    planScript(copyAndCommit("good_plan.md"));
    const result = await runPlanPhase(input({ model: "sonnet" }));
    expect(result).toMatchObject({ ok: true, model: "sonnet", classification: null });
    // No `-p` call; the watcher's auto-stop follows the launch.
    expect(fakeCalls(env).map((c) => c[0])).toEqual(["--bg", "stop"]);
  });
});

describe("runPlanPhase, failures", () => {
  test("classifier garbage → classifier_failed, nothing launched", async () => {
    setFakePrint(env, "nonsense");
    const result = await runPlanPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "classifier_failed" });
    expect(fakeCalls(env)).toHaveLength(1);
    expect(comments).toEqual([]);
  });

  test("launch failure → launch_failed with the brief already written", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const result = await runPlanPhase(input({ model: "opus", onLaunched: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "launch_failed" });
    if (result.ok) return;
    expect(result.briefPath).toBeDefined();
    expect(readFileSync(result.briefPath as string, "utf8")).toContain("# CB-12");
    expect(getRun(env.db, result.runId as string)?.state).toBe("failed");
  });

  test("the agent edits a second file → unexpected_changes naming it", async () => {
    planScript(
      `${copyAndCommit("good_plan.md")}\necho hacked > src/app.ts\ngit commit -q -am "oops"`,
    );
    const result = await runPlanPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "unexpected_changes" });
    expect(result.ok ? "" : result.detail).toContain("extra_commits");
    expect(comments).toEqual([]);
  });

  test("a dirty worktree → unexpected_changes listing the files", async () => {
    planScript(`${copyAndCommit("good_plan.md")}\necho scratch > notes.txt`);
    const result = await runPlanPhase(input());
    expect(result.ok ? "" : result.detail).toContain(
      "dirty: worktree has uncommitted changes (notes.txt)",
    );
  });

  test("missing sections → missing_sections naming them", async () => {
    planScript(copyAndCommit("missing_plan.md"));
    const result = await runPlanPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "missing_sections" });
    expect(result.ok ? "" : result.detail).toBe(
      `${PLAN}: missing "Likely touched files"; missing "Out of scope found"`,
    );
  });

  test("StopFailure → run_failed with the error kind", async () => {
    planScript(copyAndCommit("good_plan.md"));
    const result = await runPlanPhase(
      input({ onLaunched: (run) => hookLine(run, "stop-failure-rate-limit") }),
    );
    expect(result).toMatchObject({ ok: false, reason: "run_failed", detail: "rate_limit" });
  });

  test("no Stop in time → timeout, and the job is killed", async () => {
    planScript(copyAndCommit("good_plan.md"));
    const never: RunWaiter = { wait: async () => null, stop() {} };
    const result = await runPlanPhase(input({ waiter: never, onLaunched: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(fakeStops(env)).toEqual(["fa4e0001"]);
    expect(getRun(env.db, (result as { runId: string }).runId)?.state).toBe("killed");
  });
});

describe("runPlanPhase, revise", () => {
  test("keeps earlier commits, requires the revision section, posts what changed", async () => {
    commitFile(repo, PLAN, readFileSync(join(PLANS, "good_plan.md"), "utf8"), "Plan: x");
    commitFile(repo, "src/app.ts", "export const x = 2;\n", "Implement");
    const revised = `${readFileSync(join(PLANS, "good_plan.md"), "utf8")}\n## Revision 1\n\nYou said: use a helper.\n\nChanged step 1.\n`;
    writeFileSync(join(env.fakeDir, "revised.md"), revised);
    planScript(
      `cp ${join(env.fakeDir, "revised.md")} ${PLAN}\ngit add ${PLAN}\ngit commit -q -m "Plan: revision 1"`,
    );
    const latest = {
      id: "c",
      body: "Use a helper.",
      createdAt: "2026-09-19T03:00:00Z",
      fromMarshall: false,
    };
    const issue = sampleIssue({ comments: [latest], latestHumanComment: latest });
    const result = await runPlanPhase(input({ issue, mode: "revise", revision: 1, model: "opus" }));
    expect(result).toMatchObject({ ok: true, planPath: PLAN, model: "opus" });
    if (!result.ok) return;
    const brief = readFileSync(result.briefPath, "utf8");
    expect(brief).toContain(
      "## Revision\n\n- Number: 1\n- Existing plan: docs/fix-castling_plan.md",
    );
    expect(brief).toContain("Use a helper.");
    expect(comments[0]?.body).toContain("**Plan revision 1 for CB-12**");
    expect(comments[0]?.body).toContain(
      "**What changed**\n\nYou said: use a helper.\n\nChanged step 1.",
    );
    expect(git(["rev-list", "--count", `${repo.base}..HEAD`], repo.dir)).toBe("3");
  });

  test("the revision number defaults to one past the newest in the file", async () => {
    const withOne = `${readFileSync(join(PLANS, "good_plan.md"), "utf8")}\n## Revision 1\n\nx\n`;
    commitFile(repo, PLAN, withOne, "Plan: x");
    planScript(
      `printf '\\n## Revision 2\\n\\ny\\n' >> ${PLAN}\ngit commit -q -am "Plan: revision 2"`,
    );
    const result = await runPlanPhase(input({ mode: "revise", model: "opus" }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(readFileSync(result.briefPath, "utf8")).toContain("- Number: 2");
    expect(comments[0]?.body).toContain("**Plan revision 2 for CB-12**");
  });

  test("a revision commit without the Revision section → missing_sections", async () => {
    commitFile(repo, PLAN, readFileSync(join(PLANS, "good_plan.md"), "utf8"), "Plan: x");
    planScript(`echo "\n" >> ${PLAN}\ngit commit -q -am "Plan: revision 1"`);
    const result = await runPlanPhase(input({ mode: "revise", model: "opus" }));
    expect(result).toMatchObject({ ok: false, reason: "missing_sections" });
    expect(result.ok ? "" : result.detail).toContain('missing "Revision 1"');
  });
});
