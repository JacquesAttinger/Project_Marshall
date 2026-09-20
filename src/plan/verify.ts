// Last edited: 2026-09-20 10:56 CDT
// The write boundary, checked after the fact: the planner ran with bypassPermissions, so git is the
// proof that it changed nothing but the plan file. Fresh mode expects exactly one commit ahead of the
// base touching exactly one docs/*_plan.md. Revise mode expects the newest commit to touch only that.

import { GitError, gitLines } from "../git.ts";
import { isPlanPath } from "./template.ts";
import type { PlanMode } from "./types.ts";

export interface VerifyOpts {
  cwd: string;
  /** The ref the branch was cut from, for example `origin/main`. */
  base: string;
  mode: PlanMode;
}

export type VerifyFailure =
  | "dirty"
  | "no_commit"
  | "extra_commits"
  | "extra_files"
  | "no_plan_file"
  | "many_plan_files"
  | "git_failed";

export type VerifyResult =
  | { ok: true; planPath: string }
  | { ok: false; reason: VerifyFailure; detail: string; files: string[] };

function fail(reason: VerifyFailure, detail: string, files: string[] = []): VerifyResult {
  return { ok: false, reason, detail, files };
}

/** Plan files in the branch's diff against the base. Revise callers use this to find the plan. */
export async function planFilesOnBranch(cwd: string, base: string): Promise<string[]> {
  const files = await gitLines(["diff", "--name-only", `${base}..HEAD`], cwd);
  return files.filter(isPlanPath);
}

async function checkCommits(opts: VerifyOpts): Promise<VerifyResult | null> {
  const [count] = await gitLines(["rev-list", "--count", `${opts.base}..HEAD`], opts.cwd);
  const ahead = Number(count ?? "0");
  if (ahead < 1) return fail("no_commit", `no commit ahead of ${opts.base}`);
  if (opts.mode === "fresh" && ahead > 1) {
    return fail("extra_commits", `${ahead} commits ahead of ${opts.base}, expected 1`);
  }
  return null;
}

/** Everything the agent changed, or why it is not exactly one plan file. Never throws. */
export async function verifyPlanCommit(opts: VerifyOpts): Promise<VerifyResult> {
  try {
    const dirty = await gitLines(["status", "--porcelain"], opts.cwd);
    if (dirty.length > 0) {
      // Porcelain rows are `XY path`; keep the paths.
      const paths = dirty.map((l) => l.slice(3));
      return fail("dirty", "worktree has uncommitted changes", paths);
    }
    const commitProblem = await checkCommits(opts);
    if (commitProblem) return commitProblem;
    const range = opts.mode === "fresh" ? `${opts.base}..HEAD` : "HEAD~1..HEAD";
    const files = await gitLines(["diff", "--name-only", range], opts.cwd);
    const plans = files.filter(isPlanPath);
    if (plans.length === 0) return fail("no_plan_file", `no docs/*_plan.md in ${range}`, files);
    if (plans.length > 1) return fail("many_plan_files", `${plans.length} plan files`, plans);
    const others = files.filter((f) => !isPlanPath(f));
    if (others.length > 0) {
      return fail("extra_files", `${others.length} file(s) besides the plan changed`, others);
    }
    return { ok: true, planPath: plans[0] as string };
  } catch (err) {
    const message = err instanceof GitError ? err.message : String(err);
    return fail("git_failed", message);
  }
}
