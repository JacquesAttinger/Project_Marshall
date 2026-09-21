// Last edited: 2026-09-20 23:25 CDT
// The real GitOps over src/git.ts, plus `discard`: put a worktree back to a known commit before a
// fresh restart. Step 08 never runs `git worktree`; the scheduler owns that.

import { existsSync, rmSync } from "node:fs";
import { GitError, runGit } from "../git.ts";
import { implementStatusPath, readImplementStatus } from "../implement/status.ts";
import { writeImplementResumeStatus } from "../phases/status.ts";
import type { GitOps } from "./types.ts";

export const gitOps: GitOps = {
  async fetch(cwd) {
    await runGit(["fetch", "origin", "--prune"], cwd);
  },
  head(cwd) {
    return runGit(["rev-parse", "HEAD"], cwd);
  },
  subject(cwd, ref) {
    return runGit(["log", "-1", "--format=%s", ref], cwd);
  },
  async lastCommitTouching(cwd, path) {
    const sha = await runGit(["log", "-1", "--format=%H", "--", path], cwd);
    return sha.length > 0 ? sha : null;
  },
  async resetHard(cwd, ref) {
    await runGit(["reset", "--hard", ref], cwd);
    await runGit(["clean", "-fd"], cwd);
  },
  async rebase(cwd, base) {
    try {
      await runGit(["rebase", `origin/${base}`], cwd);
      return true;
    } catch (err) {
      if (err instanceof GitError && /conflict/i.test(err.message)) return false;
      throw err;
    }
  },
  async abortRebase(cwd) {
    await runGit(["rebase", "--abort"], cwd);
  },
  async forcePush(cwd) {
    await runGit(["push", "--force-with-lease", "origin", "HEAD"], cwd);
  },
};

export interface DiscardInput {
  git: GitOps;
  cwd: string;
  identifier: string;
  /** The plan file relative to `cwd`; the branch is reset to the newest commit that touched it. */
  planPath: string;
}

/**
 * Discard the implement phase's work: reset the branch to the plan commit (the revision commit on
 * a bounce), push that so the remote matches, and put `implement.json` back to the shape the
 * skill treats as a resume when a PR already exists (so it is reused, never recreated), or
 * remove it when none does. Returns the commit the branch now sits on.
 */
export async function discardImplementWork(input: DiscardInput): Promise<string> {
  const { git, cwd, identifier, planPath } = input;
  const target = (await git.lastCommitTouching(cwd, planPath)) ?? (await git.head(cwd));
  await git.resetHard(cwd, target);
  await git.forcePush(cwd);
  const statusPath = implementStatusPath(identifier);
  let previous: ReturnType<typeof readImplementStatus> = null;
  try {
    previous = readImplementStatus(identifier);
  } catch {
    // A malformed file is dropped like a missing one.
  }
  if (previous?.prUrl) writeImplementResumeStatus(identifier, previous);
  else if (existsSync(statusPath)) rmSync(statusPath);
  rmSync(`${statusPath}.stop-blocks`, { force: true });
  return target;
}
