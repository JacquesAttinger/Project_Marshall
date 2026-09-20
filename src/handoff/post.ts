// Last edited: 2026-09-20 16:20 CDT
// Post a validated hand-off: the full package as one Linear comment (edited in place on a
// re-post), then spliced into the PR body between the markers. The sidecar is written between
// the two, so a `gh` failure never loses the comment id.

import { readFileSync } from "node:fs";
import type { IssueDetail, LinearClient } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { handoffPath } from "../paths.ts";
import { readHandoffMeta, writeHandoffMeta } from "./meta.ts";
import { readPrBody, writePrBody } from "./pr.ts";
import { renderPackage } from "./render.ts";
import { spliceHandoff } from "./splice.ts";
import type { GhRunner, PostResult } from "./types.ts";
import { checkHandoffFile } from "./validate.ts";

const log = createLogger({ module: "handoff" });

export interface PostInput {
  /** `id` is the Linear UUID (comments), `identifier` the human key (paths, implement.json). */
  issue: Pick<IssueDetail, "id" | "identifier">;
  linear: Pick<LinearClient, "comment" | "updateComment">;
  /** Default `handoffPath(issue.identifier)`. */
  handoffPath?: string;
  prUrl: string;
  /** Where `gh` runs; any directory inside the repo. */
  cwd: string;
  round: number;
  /** Rendered as `_<badge>_` under the TLDR, for example `rebased after <PR URL>`. */
  badge?: string;
  gh?: GhRunner;
  now?: () => Date;
}

async function postComment(
  input: PostInput,
  text: string,
): Promise<{ commentId: string; commentAction: "created" | "updated" } | PostResult> {
  const previous = readHandoffMeta(input.issue.identifier);
  try {
    if (previous) {
      await input.linear.updateComment(previous.commentId, text);
      return { commentId: previous.commentId, commentAction: "updated" };
    }
    const { id } = await input.linear.comment(input.issue.id, text);
    return { commentId: id, commentAction: "created" };
  } catch (err) {
    return { ok: false, reason: "linear_failed", detail: (err as Error).message };
  }
}

export async function postHandoff(input: PostInput): Promise<PostResult> {
  const identifier = input.issue.identifier;
  const path = input.handoffPath ?? handoffPath(identifier);
  const check = checkHandoffFile(path, { prUrl: input.prUrl });
  if (!check.ok) return { ok: false, reason: "invalid", detail: check.problems.join("; ") };
  const text = renderPackage(readFileSync(path, "utf8"), { badge: input.badge });

  const posted = await postComment(input, text);
  if ("ok" in posted) return posted;
  const metaPath = writeHandoffMeta(identifier, {
    issueId: identifier,
    commentId: posted.commentId,
    round: input.round,
    prUrl: input.prUrl,
    postedAt: (input.now ?? (() => new Date()))().toISOString(),
    ...(input.badge ? { badge: input.badge } : {}),
  });
  log.info("handoff.comment_posted", { issue: identifier, ...posted, round: input.round });

  try {
    const body = await readPrBody(input.prUrl, input.cwd, input.gh);
    const spliced = spliceHandoff(body, text);
    if (!spliced.ok) return { ok: false, reason: "markers_unbalanced", detail: spliced.detail };
    if (spliced.changed)
      await writePrBody(input.prUrl, spliced.body, identifier, input.cwd, input.gh);
    const prAction = spliced.changed ? spliced.action : "unchanged";
    log.info("handoff.pr_body_updated", { issue: identifier, prUrl: input.prUrl, prAction });
    return { ok: true, ...posted, prAction, metaPath, text };
  } catch (err) {
    return { ok: false, reason: "gh_failed", detail: (err as Error).message };
  }
}
