// Last edited: 2026-09-20 15:45 CDT
// Public shapes and constants for the hand-off phase. Step 08 builds a HandoffPhaseInput and
// reads the result; the writer skill and the validator agree on the section names below.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { IssueDetail, LinearClient } from "../linear/index.ts";
import type { RunWaiter } from "../plan/types.ts";
import type { Run } from "../runner/index.ts";

/** The six sections, in order. `TLDR` is also satisfied by a `**TLDR:**` paragraph under the H1. */
export const HANDOFF_SECTIONS = [
  "TLDR",
  "Where to find it",
  "Orientation",
  "What was wrong and why",
  "What the agent did",
  "Verification recipe",
] as const;

/** The PR body keeps the package between these two lines; a re-post replaces only what is inside. */
export const HANDOFF_START = "<!-- marshall-handoff:start -->";
export const HANDOFF_END = "<!-- marshall-handoff:end -->";
export const HANDOFF_HEADING = "## Hand-off";
/** What `/marshall:implement` leaves between the markers until the hand-off step runs. */
export const HANDOFF_PLACEHOLDER = "_Filled in by the hand-off step._";

/** Bold sub-list labels that section 5 must carry, even when each says `(none)`. */
export const REVIEW_NOTES_LABEL = "Review notes (not fixed)";
export const FOLLOWUPS_LABEL = "Follow-ups proposed";

/** The optional bounce block, an H2 right after the TLDR: `## Round 2 — what changed`. */
export const ROUND_HEADING = /^round\s+(\d+)\s*[—–-]+\s*what changed$/i;
export const PR_URL_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
/** `- Branch: \`x\``, `**Branch:** x`, `Branch: x`; the colon is required so prose never matches. */
export const BRANCH_LINE = /^\s*(?:[-*]\s*)?\**branch\**\s*:\**\s*`?([^\s`]+)`?/im;

export interface HandoffCheck {
  ok: boolean;
  missing: string[];
  misordered: string[];
  /** N from the optional `Round N — what changed` heading. */
  round: number | null;
  /** From section 6. */
  prUrl: string | null;
  branch: string | null;
  /** Every failure, one line each. The resume nudge and the CLI print these. */
  problems: string[];
}

export type GhRunner = (args: string[], cwd: string) => Promise<string>;

export type SpliceAction =
  | "appended"
  | "filled_placeholder"
  | "inserted_after_heading"
  | "replaced";

export interface HandoffPhaseInput {
  db: Database;
  linear: Pick<LinearClient, "comment" | "updateComment">;
  config: Config;
  issue: IssueDetail;
  /** The issue's worktree, on the issue branch, with the PR already open. */
  cwd: string;
  /** The plan file relative to `cwd`, from the claim. */
  planPath: string;
  /** Default: the sidecar's round + 1, else 1. */
  round?: number;
  /** Default `handoffModel(config)`. */
  model?: string;
  /** Ref the branch was cut from. Default `origin/<config.baseBranch>`. */
  base?: string;
  waiter?: RunWaiter;
  onLaunched?: (run: Run) => void;
  gh?: GhRunner;
}

export type WriteInput = Omit<HandoffPhaseInput, "linear" | "gh">;

export type HandoffFailure =
  | "no_pr"
  | "worktree_dirty"
  | "launch_failed"
  | "run_failed"
  | "timeout"
  | "handoff_invalid"
  | "post_failed";

export type WriteOutcome =
  | {
      ok: true;
      handoffPath: string;
      round: number;
      prUrl: string;
      branch: string;
      model: string;
      runId: string;
      /** The first file failed validation and one resume fixed it. */
      resumed: boolean;
    }
  | { ok: false; reason: HandoffFailure; detail: string; runId?: string; handoffPath?: string };

export type HandoffPhaseResult =
  | {
      ok: true;
      handoffPath: string;
      metaPath: string;
      commentId: string;
      round: number;
      prUrl: string;
      model: string;
      runId: string;
      resumed: boolean;
    }
  | { ok: false; reason: HandoffFailure; detail: string; runId?: string; handoffPath?: string };

export type PostFailure = "invalid" | "markers_unbalanced" | "gh_failed" | "linear_failed";

export type PostResult =
  | {
      ok: true;
      commentId: string;
      commentAction: "created" | "updated";
      prAction: SpliceAction | "unchanged";
      metaPath: string;
      /** The rendered package, as posted to both places. */
      text: string;
    }
  | { ok: false; reason: PostFailure; detail: string };

export class HandoffError extends Error {
  override name = "HandoffError";
}
