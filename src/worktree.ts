// Last edited: 2026-09-20 15:50 CDT
// Worktrees for agent branches, mirroring ship-plan step 2: `<repo>/../<repo>-<branch>` off
// `origin/<base>`, with the main checkout's ignored `.env` files copied in. The scheduler owns
// this (step 07 decision 1); step 08 never runs `git worktree`.

import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GitError, gitLines, runGit } from "./git.ts";
import type { WorktreeOps, WorktreeSpec } from "./scheduler/types.ts";

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * `<parent of repo>/<repo dir name>-<branch>`, the same shape ship-plan uses. Symlinks are
 * resolved (macOS `/var` is `/private/var`) so the path compares equal to what git prints.
 */
export function worktreePathFor(repoPath: string, branch: string): string {
  const repo = realOrResolved(repoPath);
  return join(dirname(repo), `${basename(repo)}-${branch}`);
}

/** Ignored files named `.env*` anywhere in the checkout, as repo-relative paths. */
export async function listEnvFiles(repoPath: string): Promise<string[]> {
  const lines = await gitLines(
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    repoPath,
  );
  return lines.filter((f) => /(^|\/)\.env/.test(f));
}

/** Copy every `.env*` the main checkout ignores into the worktree. Returns what was copied. */
export async function copyEnvFiles(repoPath: string, worktreePath: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of await listEnvFiles(repoPath)) {
    const target = join(worktreePath, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoPath, rel), target);
    copied.push(rel);
  }
  return copied;
}

/** Paths git currently lists as worktrees of `repoPath`, as git prints them (real paths). */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const lines = await gitLines(["worktree", "list", "--porcelain"], repoPath);
  return lines.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

/** Fresh branch off the latest `origin/<base>`, in a new worktree. Throws if the branch exists. */
export async function createWorktree(spec: WorktreeSpec): Promise<string> {
  const path = worktreePathFor(spec.repoPath, spec.branch);
  await runGit(["fetch", "origin", "--prune"], spec.repoPath);
  await runGit(["worktree", "prune"], spec.repoPath);
  await runGit(
    ["worktree", "add", path, "-b", spec.branch, `origin/${spec.baseBranch}`],
    spec.repoPath,
  );
  await copyEnvFiles(spec.repoPath, path);
  return path;
}

/**
 * The worktree for a bounce: the existing directory when git still knows it; else a worktree on
 * the existing branch (local, or a remote-tracking one git adopts by name); else a fresh one.
 */
export async function reuseWorktree(spec: WorktreeSpec): Promise<string> {
  const path = worktreePathFor(spec.repoPath, spec.branch);
  await runGit(["worktree", "prune"], spec.repoPath);
  if (existsSync(path) && (await listWorktrees(spec.repoPath)).includes(path)) return path;
  await runGit(["fetch", "origin", "--prune"], spec.repoPath);
  try {
    await runGit(["worktree", "add", path, spec.branch], spec.repoPath);
  } catch (err) {
    if (
      !(err instanceof GitError) ||
      !/invalid reference|not a valid|not found/i.test(err.message)
    ) {
      throw err;
    }
    return createWorktree(spec);
  }
  await copyEnvFiles(spec.repoPath, path);
  return path;
}

/** Drop the worktree directory. The branch stays, so a later bounce can still reuse it. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoPath);
  await runGit(["worktree", "prune"], repoPath);
}

export const gitWorktrees: WorktreeOps = { create: createWorktree, reuse: reuseWorktree };
