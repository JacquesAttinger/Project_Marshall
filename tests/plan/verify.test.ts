// Last edited: 2026-09-20 10:56 CDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { planFilesOnBranch, verifyPlanCommit } from "../../src/plan/verify.ts";
import { commitFile, git, makeRepo, type TempRepo } from "./helpers.ts";

let repo: TempRepo;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  repo.remove();
});

const PLAN = "docs/fix-castling_plan.md";
const fresh = () => verifyPlanCommit({ cwd: repo.dir, base: repo.base, mode: "fresh" });
const revise = () => verifyPlanCommit({ cwd: repo.dir, base: repo.base, mode: "revise" });

describe("verifyPlanCommit, fresh", () => {
  test("one commit with only the plan file → ok with its path", async () => {
    commitFile(repo, PLAN, "# Plan\n", "Plan: fix castling");
    expect(await fresh()).toEqual({ ok: true, planPath: PLAN });
    expect(await planFilesOnBranch(repo.dir, repo.base)).toEqual([PLAN]);
  });

  test("nothing committed → no_commit", async () => {
    expect(await fresh()).toMatchObject({ ok: false, reason: "no_commit" });
  });

  test("uncommitted changes → dirty, listing them", async () => {
    commitFile(repo, PLAN, "# Plan\n", "Plan: x");
    await Bun.write(join(repo.dir, "src", "app.ts"), "export const x = 2;\n");
    await Bun.write(join(repo.dir, "notes.txt"), "scratch\n");
    const result = await fresh();
    expect(result).toMatchObject({ ok: false, reason: "dirty" });
    expect(result.ok ? [] : result.files.sort()).toEqual(["notes.txt", "src/app.ts"]);
  });

  test("a second file in the commit → extra_files naming it", async () => {
    await Bun.write(join(repo.dir, PLAN), "# Plan\n");
    await Bun.write(join(repo.dir, "src", "app.ts"), "export const x = 2;\n");
    git(["add", "-A"], repo.dir);
    git(["commit", "-q", "-m", "Plan: x"], repo.dir);
    expect(await fresh()).toMatchObject({
      ok: false,
      reason: "extra_files",
      files: ["src/app.ts"],
    });
  });

  test("two commits → extra_commits", async () => {
    commitFile(repo, PLAN, "# Plan\n", "Plan: x");
    commitFile(repo, "src/app.ts", "export const x = 3;\n", "Sneaky");
    expect(await fresh()).toMatchObject({ ok: false, reason: "extra_commits" });
  });

  test("a commit without a plan file → no_plan_file", async () => {
    commitFile(repo, "docs/notes.md", "x\n", "Not a plan");
    expect(await fresh()).toMatchObject({
      ok: false,
      reason: "no_plan_file",
      files: ["docs/notes.md"],
    });
  });

  test("two plan files → many_plan_files", async () => {
    await Bun.write(join(repo.dir, PLAN), "# Plan\n");
    await Bun.write(join(repo.dir, "docs/other_plan.md"), "# Plan\n");
    git(["add", "-A"], repo.dir);
    git(["commit", "-q", "-m", "Plan: x"], repo.dir);
    expect(await fresh()).toMatchObject({ ok: false, reason: "many_plan_files" });
  });

  test("not a git repo → git_failed", async () => {
    const result = await verifyPlanCommit({ cwd: "/", base: "origin/main", mode: "fresh" });
    expect(result).toMatchObject({ ok: false, reason: "git_failed" });
  });
});

describe("verifyPlanCommit, revise", () => {
  test("earlier implementation commits are fine; only the newest commit must be the plan", async () => {
    commitFile(repo, PLAN, "# Plan\n", "Plan: x");
    commitFile(repo, "src/app.ts", "export const x = 3;\n", "Implement");
    commitFile(repo, PLAN, "# Plan\n\n## Revision 1\n", "Plan: revision 1");
    expect(await revise()).toEqual({ ok: true, planPath: PLAN });
  });

  test("newest commit touching code too → extra_files", async () => {
    commitFile(repo, PLAN, "# Plan\n", "Plan: x");
    await Bun.write(join(repo.dir, PLAN), "# Plan 2\n");
    await Bun.write(join(repo.dir, "src", "app.ts"), "export const x = 2;\n");
    git(["add", "-A"], repo.dir);
    git(["commit", "-q", "-m", "Plan: revision 1"], repo.dir);
    expect(await revise()).toMatchObject({
      ok: false,
      reason: "extra_files",
      files: ["src/app.ts"],
    });
  });

  test("no commit on the branch at all → no_commit", async () => {
    expect(await revise()).toMatchObject({ ok: false, reason: "no_commit" });
  });
});
