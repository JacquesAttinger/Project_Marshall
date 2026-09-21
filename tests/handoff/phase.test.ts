// Last edited: 2026-09-20 23:05 CDT
// runHandoffPhase end to end with the fake claude shim: its --bg branch runs a script that plays
// the writer (copies a fixture to the hand-off path), then the test appends the Stop hook line
// and the watcher finishes the run. Linear is a recording stub; gh is the fake shim.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, parseConfig } from "../../src/config.ts";
import { writeHandoffMeta } from "../../src/handoff/meta.ts";
import { runHandoffPhase, writeHandoff } from "../../src/handoff/phase.ts";
import type { HandoffPhaseInput } from "../../src/handoff/types.ts";
import { HANDOFF_END, HANDOFF_START } from "../../src/handoff/types.ts";
import { handoffMetaPath, handoffPath, issueDir } from "../../src/paths.ts";
import { PLUGIN_DIR } from "../../src/plan/phase.ts";
import type { RunWaiter } from "../../src/plan/types.ts";
import { createRunWaiter } from "../../src/plan/wait.ts";
import { eventsFile } from "../../src/runner/settings.ts";
import { getRun } from "../../src/runner/store.ts";
import type { Run } from "../../src/runner/types.ts";
import { makeRepo, sampleIssue, type TempRepo } from "../plan/helpers.ts";
import {
  fakeCalls,
  fakeStops,
  hookFixture,
  type RunnerEnv,
  useRunnerEnv,
} from "../runner/helpers.ts";
import {
  BRANCH,
  fakeLinearStub,
  type GhEnv,
  ghCalls,
  HANDOFF_FIXTURES,
  type LinearStub,
  PR_URL,
  prBody,
  prBodyFixture,
  setPrBody,
  useGhEnv,
  writeImplementStatus,
} from "./helpers.ts";

let env: RunnerEnv;
let gh: GhEnv;
let repo: TempRepo;
let config: Config;
let waiter: RunWaiter;
let stub: LinearStub;

beforeEach(() => {
  env = useRunnerEnv();
  gh = useGhEnv();
  repo = makeRepo();
  config = parseConfig({ workspace: "w", teamId: "t", repoPath: env.home.dir });
  waiter = createRunWaiter(env.db, { pollMs: 50 });
  stub = fakeLinearStub();
  writeImplementStatus("CB-12");
  setPrBody(gh, prBodyFixture("fresh"));
});

afterEach(() => {
  waiter.stop();
  repo.remove();
  gh.restore();
  env.restore();
});

/** The fake writer: a shell script the shim runs in the worktree before printing the job id. */
function writerScript(body: string): void {
  const path = join(env.fakeDir, "writer.sh");
  writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`);
  process.env.FAKE_CLAUDE_PLAN_SCRIPT = path;
}

const copy = (fixture: string) =>
  `cp ${join(HANDOFF_FIXTURES, `${fixture}.md`)} ${handoffPath("CB-12")}`;

/** First call copies `first`, later calls copy `then`. */
function copyThen(first: string, then: string): string {
  const flag = join(env.fakeDir, "second-call");
  return `if [ -f ${flag} ]; then ${copy(then)}; else ${copy(first)}; touch ${flag}; fi`;
}

/** Append a hook line for the run, as hook-sink.sh would. */
function hookLine(run: Run, fixture: string): void {
  const line = JSON.stringify({
    received_at: new Date().toISOString(),
    event: hookFixture(fixture),
  });
  appendFileSync(eventsFile(run.runId), `${line}\n`);
}

function input(overrides: Partial<HandoffPhaseInput> = {}): HandoffPhaseInput {
  return {
    db: env.db,
    linear: stub.linear,
    config,
    issue: sampleIssue(),
    cwd: repo.dir,
    planPath: "docs/fix-castling_plan.md",
    waiter,
    onLaunched: (run) => hookLine(run, "stop-empty"),
    ...overrides,
  };
}

/** The parsed `--settings` JSON of a fake-claude argv. */
function settingsOf(argv: string[]): {
  env: Record<string, string>;
  hooks: Record<string, unknown>;
} {
  return JSON.parse(argv[argv.indexOf("--settings") + 1] as string);
}

const settingsEnv = (argv: string[]) => settingsOf(argv).env;

describe("runHandoffPhase, happy path", () => {
  test("launches the writer with the env, validates, posts to Linear and the PR, writes the sidecar", async () => {
    writerScript(copy("good"));
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({
      ok: true,
      handoffPath: handoffPath("CB-12"),
      metaPath: handoffMetaPath("CB-12"),
      commentId: "comment-1",
      round: 1,
      prUrl: PR_URL,
      model: "opus",
      resumed: false,
    });
    if (!result.ok) return;
    expect(result.runId).toMatch(/^cb-12-handoff-[0-9a-f]{8}$/);
    expect(getRun(env.db, result.runId)?.state).toBe("finished");

    const [launch] = fakeCalls(env);
    expect(launch?.slice(0, 5)).toEqual(["--bg", "--name", "CB-12 handoff", "--model", "opus"]);
    expect(launch?.slice(-3)).toEqual([
      "--plugin-dir",
      PLUGIN_DIR,
      "/marshall:handoff docs/fix-castling_plan.md CB-12",
    ]);
    expect(launch).not.toContain("--resume");
    // The base agent-settings env is merged under these six.
    expect(settingsEnv(launch as string[])).toMatchObject({
      MARSHALL_ISSUE_DIR: issueDir("CB-12"),
      MARSHALL_ISSUE_URL: "https://linear.app/chessbuddy/issue/CB-12",
      MARSHALL_HANDOFF_PATH: handoffPath("CB-12"),
      MARSHALL_ROUND: "1",
      MARSHALL_BASE_BRANCH: "main",
      MARSHALL_PR_URL: PR_URL,
    });
    // No statusFile: the Stop guard must not hold the writer, so the Stop hook has no file arg.
    expect(JSON.stringify(settingsOf(launch as string[]).hooks.Stop)).not.toContain(
      "implement.json",
    );

    expect(stub.comments).toHaveLength(1);
    expect(stub.comments[0]?.issueId).toBe("issue-1");
    expect(stub.comments[0]?.body).toContain("## Verification recipe");
    expect(ghCalls(gh).map((c) => c[1])).toEqual(["view", "edit"]);
    expect(prBody(gh)).toContain(`${HANDOFF_START}\n**TLDR:** The king could castle`);
    expect(prBody(gh)).toContain(`${HANDOFF_END}\n\nCloses`);
    expect(existsSync(handoffMetaPath("CB-12"))).toBe(true);
  });
});

describe("runHandoffPhase, round and model", () => {
  test("the round defaults to the sidecar's round + 1, and an explicit model wins", async () => {
    writeHandoffMeta("CB-12", {
      issueId: "CB-12",
      commentId: "comment-old",
      round: 2,
      prUrl: PR_URL,
      postedAt: "2026-09-20T17:00:00.000Z",
    });
    writerScript(copy("good"));
    const result = await runHandoffPhase(input({ model: "sonnet" }));
    expect(result).toMatchObject({ ok: true, round: 3, model: "sonnet", commentId: "comment-old" });
    expect(settingsEnv(fakeCalls(env)[0] as string[]).MARSHALL_ROUND).toBe("3");
    expect(stub.updates).toHaveLength(1);
    expect(stub.comments).toHaveLength(0);
  });

  test("models.handoff picks the writer model", async () => {
    writerScript(copy("good"));
    const withHandoff = parseConfig({
      workspace: "w",
      teamId: "t",
      repoPath: env.home.dir,
      models: { handoff: "haiku" },
    });
    const result = await writeHandoff(input({ config: withHandoff }));
    expect(result).toMatchObject({ ok: true, model: "haiku", branch: BRANCH });
  });
});

describe("runHandoffPhase, invalid file", () => {
  test("invalid then fixed: one resume with the problems as the prompt, resumed: true", async () => {
    writerScript(copyThen("no_pr", "good"));
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: true, resumed: true, commentId: "comment-1" });
    const calls = fakeCalls(env).filter((c) => c[0] === "--bg");
    expect(calls).toHaveLength(2);
    const second = calls[1] as string[];
    expect(second.slice(0, 5)).toEqual([
      "--bg",
      "--name",
      "CB-12 handoff",
      "--resume",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(second.at(-1)).toBe(
      `The hand-off at ${handoffPath("CB-12")} failed validation: "Verification recipe" has no PR URL; "Verification recipe" has no "- Branch:" line. Fix that file in place. Write nothing else, then stop.`,
    );
    expect(settingsEnv(second).MARSHALL_HANDOFF_PATH).toBe(handoffPath("CB-12"));
    expect(stub.comments).toHaveLength(1);
  });

  test("invalid twice → handoff_invalid, nothing posted", async () => {
    writerScript(copy("missing_sections"));
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "handoff_invalid" });
    expect(result.ok ? "" : result.detail).toBe(
      'missing "Orientation"; missing "Verification recipe"',
    );
    expect(fakeCalls(env).filter((c) => c[0] === "--bg")).toHaveLength(2);
    expect(stub.comments).toEqual([]);
    expect(ghCalls(gh)).toEqual([]);
    expect(existsSync(handoffMetaPath("CB-12"))).toBe(false);
  });

  test("no session id on the run → handoff_invalid without a resume", async () => {
    writerScript(copy("no_pr"));
    const withoutSession: RunWaiter = {
      wait: async () => ({ kind: "finished" }),
      settle: () => false,
      stop() {},
    };
    const result = await runHandoffPhase(input({ waiter: withoutSession, onLaunched: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "handoff_invalid" });
    expect(result.ok ? "" : result.detail).toContain("cannot resume: no session id");
    expect(fakeCalls(env).filter((c) => c[0] === "--bg")).toHaveLength(1);
  });
});

describe("runHandoffPhase, guards", () => {
  test("no implement.json → no_pr, nothing launched", async () => {
    Bun.spawnSync(["rm", "-rf", issueDir("CB-12")]);
    const result = await runHandoffPhase(input());
    expect(result).toEqual({
      ok: false,
      reason: "no_pr",
      detail: "no implement.json",
      runId: expect.stringMatching(/^cb-12-handoff-/),
      handoffPath: undefined,
    });
    expect(fakeCalls(env)).toEqual([]);
  });

  test("implement.json without a PR → no_pr", async () => {
    writeImplementStatus("CB-12", { prUrl: null, outcome: "blocked", reason: "x" });
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "no_pr" });
    expect(fakeCalls(env)).toEqual([]);
  });

  test("a dirty worktree before launch → worktree_dirty, nothing launched", async () => {
    writeFileSync(join(repo.dir, "notes.txt"), "scratch\n");
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "worktree_dirty" });
    expect(result.ok ? "" : result.detail).toBe("before launch: notes.txt");
    expect(fakeCalls(env)).toEqual([]);
  });

  test("the writer touches the worktree → worktree_dirty, nothing posted", async () => {
    writerScript(`${copy("good")}\necho scratch > notes.txt`);
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "worktree_dirty" });
    expect(result.ok ? "" : result.detail).toBe("after the run: uncommitted changes: notes.txt");
    expect(stub.comments).toEqual([]);
    expect(ghCalls(gh)).toEqual([]);
  });

  test("the writer commits → worktree_dirty naming the moved HEAD", async () => {
    writerScript(`${copy("good")}\necho x > src/app.ts\ngit commit -q -am "oops"`);
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "worktree_dirty" });
    expect(result.ok ? "" : result.detail).toContain("HEAD moved from");
  });
});

describe("runHandoffPhase, run failures", () => {
  test("launch failure → launch_failed", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const result = await runHandoffPhase(input({ onLaunched: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "launch_failed" });
    expect(getRun(env.db, (result as { runId: string }).runId)?.state).toBe("failed");
  });

  test("StopFailure → run_failed with the error kind", async () => {
    writerScript(copy("good"));
    const result = await runHandoffPhase(
      input({ onLaunched: (run) => hookLine(run, "stop-failure-rate-limit") }),
    );
    expect(result).toMatchObject({ ok: false, reason: "run_failed", detail: "rate_limit" });
  });

  test("no Stop in time → timeout, and the job is killed", async () => {
    writerScript(copy("good"));
    const never: RunWaiter = { wait: async () => null, settle: () => false, stop() {} };
    const result = await runHandoffPhase(input({ waiter: never, onLaunched: undefined }));
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(fakeStops(env)).toEqual(["fa4e0001"]);
    expect(getRun(env.db, (result as { runId: string }).runId)?.state).toBe("killed");
  });

  test("a post failure surfaces as post_failed with the inner reason", async () => {
    writerScript(copy("good"));
    process.env.FAKE_GH_FAIL = "1";
    const result = await runHandoffPhase(input());
    expect(result).toMatchObject({ ok: false, reason: "post_failed" });
    expect(result.ok ? "" : result.detail).toContain("gh_failed:");
    expect(stub.comments).toHaveLength(1);
  });
});
