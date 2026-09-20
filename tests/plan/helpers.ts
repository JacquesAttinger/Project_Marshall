// Last edited: 2026-09-20 11:10 CDT
// Plan-phase test setup: sample issues, a temp git repo with an `origin`, and a git runner.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../src/git.ts";
import type { IssueDetail } from "../../src/linear/index.ts";

export function sampleIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: "issue-1",
    identifier: "CB-12",
    title: "Fix castling through check",
    description: "The king can castle while the square it crosses is attacked.",
    priority: 2,
    url: "https://linear.app/chessbuddy/issue/CB-12",
    branchName: "cb-12-fix-castling-through-check",
    createdAt: "2026-09-19T00:00:00.000Z",
    labels: ["bug"],
    comments: [],
    state: { name: "In Progress", type: "started" },
    agentId: "agent-0",
    latestHumanComment: null,
    relatedIssueIds: [],
    ...overrides,
  };
}

export function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

export interface TempRepo {
  /** The working clone, on branch `cb-12-fix`, one commit behind nothing (equal to origin/main). */
  dir: string;
  base: string;
  remove(): void;
}

/** A bare `origin` with one commit on `main`, cloned, with the issue branch checked out. */
export function makeRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "marshall-plan-repo-"));
  const origin = join(root, "origin.git");
  const dir = join(root, "work");
  git(["init", "--bare", "-q", "-b", "main", origin], root);
  git(["clone", "-q", origin, dir], root);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["checkout", "-q", "-b", "main"], dir);
  Bun.spawnSync(["mkdir", "-p", join(dir, "docs"), join(dir, "src")]);
  Bun.write(join(dir, "README.md"), "# Test repo\n");
  Bun.write(join(dir, "docs", "existing.md"), "existing\n");
  Bun.write(join(dir, "src", "app.ts"), "export const x = 1;\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  git(["push", "-q", "-u", "origin", "main"], dir);
  git(["checkout", "-q", "-b", "cb-12-fix"], dir);
  return { dir, base: "origin/main", remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write a file in the repo and commit it. */
export function commitFile(repo: TempRepo, path: string, content: string, message: string): void {
  const full = join(repo.dir, path);
  Bun.spawnSync(["mkdir", "-p", join(full, "..")]);
  Bun.write(full, content);
  git(["add", path], repo.dir);
  git(["commit", "-q", "-m", message], repo.dir);
}
