// Last edited: 2026-09-20 10:56 CDT
// Public shapes for the planning phase. Step 08 builds a PlanPhaseInput and reads the result.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { IssueDetail, LinearClient } from "../linear/index.ts";
import type { Run, Terminal } from "../runner/index.ts";

export type Complexity = "simple" | "complex";

export interface Classification {
  complexity: Complexity;
  /** One sentence from the classifier. Logged and posted, never parsed. */
  reason: string;
}

/** Fresh: first plan on a new branch. Revise: a bounce; the plan exists and a human commented. */
export type PlanMode = "fresh" | "revise";

/** Tells a caller when a run reached a terminal state. Step 08 owns one; the CLI makes one. */
export interface RunWaiter {
  /** Resolves with the terminal event, or null once `timeoutMs` passes. Never kills the run. */
  wait(runId: string, timeoutMs: number): Promise<Terminal | null>;
  stop(): void;
}

export interface PlanPhaseInput {
  db: Database;
  linear: Pick<LinearClient, "comment">;
  config: Config;
  issue: IssueDetail;
  /** The issue's worktree, already on the issue branch. */
  cwd: string;
  mode?: PlanMode;
  /** Ref the branch was cut from. Default `origin/<config.baseBranch>`. */
  base?: string;
  /** Revise mode: which revision this is (1 for the first bounce). */
  revision?: number;
  /** Revise mode: the plan file relative to `cwd`. Found from git when omitted. */
  planPath?: string;
  /** Skip the classifier and plan with this model (revise mode reuses the stored one). */
  model?: string;
  waiter?: RunWaiter;
  onLaunched?: (run: Run) => void;
}

export type PlanFailure =
  | "classifier_failed"
  | "launch_failed"
  | "run_failed"
  | "timeout"
  | "unexpected_changes"
  | "missing_sections";

export type PlanPhaseResult =
  | {
      ok: true;
      /** Relative to `cwd`, for example `docs/fix-castling_plan.md`. */
      planPath: string;
      classification: Classification | null;
      model: string;
      runId: string;
      briefPath: string;
    }
  | { ok: false; reason: PlanFailure; detail: string; runId?: string; briefPath?: string };

export class PlanError extends Error {
  override name = "PlanError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
