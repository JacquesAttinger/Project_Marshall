// Last edited: 2026-09-20 16:20 CDT
// Read and write a PR body through `gh`. The body is parsed from `--json body` in TypeScript,
// not with `--jq .body`, which appends a newline and would break byte-identity outside the markers.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGh } from "../gh.ts";
import { issueDir } from "../paths.ts";
import { type GhRunner, HandoffError } from "./types.ts";

export type { GhRunner } from "./types.ts";

export async function readPrBody(
  prUrl: string,
  cwd: string,
  gh: GhRunner = runGh,
): Promise<string> {
  const out = await gh(["pr", "view", prUrl, "--json", "body"], cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new HandoffError(`gh pr view printed no JSON: ${out.trim().slice(0, 200)}`);
  }
  const body = (parsed as { body?: unknown }).body;
  if (typeof body !== "string") throw new HandoffError("gh pr view --json body had no body field");
  return body;
}

/**
 * `gh pr edit --body-file` from a file under the issue dir (never inside the worktree, which must
 * stay clean). The file is left in place as a record of the last body Marshall wrote.
 */
export async function writePrBody(
  prUrl: string,
  body: string,
  issueId: string,
  cwd: string,
  gh: GhRunner = runGh,
): Promise<string> {
  const dir = issueDir(issueId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pr_body.md");
  writeFileSync(file, body);
  await gh(["pr", "edit", prUrl, "--body-file", file], cwd);
  return file;
}
