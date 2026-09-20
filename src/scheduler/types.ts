// Last edited: 2026-09-20 15:25 CDT
// Shapes shared by the scheduler, the caps, and step 08. A Claim is one row of the `claims` table.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { AgentId, LinearClient, PickableIssue } from "../linear/index.ts";
import type { Logger } from "../log.ts";

/**
 * The claim states step 07 writes. Step 08 adds the phase states in between (`planning`,
 * `implementing`, ...); the scheduler only cares whether a row is live (holds a slot) or not.
 */
export const CLAIMING = "claiming";
export const CLAIMED = "claimed";
export const RELEASED = "released";
export const BLOCKED = "blocked";

/** States that free the slot. Must match the `claims_live_slot` partial index in 001_init.sql. */
export const TERMINAL_CLAIM_STATES: readonly string[] = [RELEASED, BLOCKED];

export interface Claim {
  issueId: string;
  agentId: AgentId;
  slot: number;
  state: string;
  branch: string | null;
  worktreePath: string | null;
  /** Restarts after a human bounce. `maxBounces` blocks the issue. */
  bounces: number;
  /** Resumes of a dead or stalled agent within this claim. `maxResumes` releases the issue. */
  resumes: number;
  claimedAt: string;
  updatedAt: string;
}

/**
 * What step 08 plugs in. `start` receives a claim whose worktree exists and whose Linear issue is
 * In Progress with our label. `resume` receives a claim reconcile found without a live agent.
 * Neither may throw after it has launched a job: the scheduler releases the claim on a throw.
 */
export interface MasterAgentHooks {
  start(claim: Claim, issue: PickableIssue): Promise<void>;
  resume(claim: Claim): Promise<void>;
}

/** The one question the scheduler asks the runner. */
export interface Liveness {
  isAlive(claim: Claim): Promise<boolean>;
}

export interface WorktreeSpec {
  repoPath: string;
  branch: string;
  baseBranch: string;
}

/** The two git operations a start needs, injected so scheduler tests run without git. */
export interface WorktreeOps {
  create(spec: WorktreeSpec): Promise<string>;
  reuse(spec: WorktreeSpec): Promise<string>;
}

export interface SchedulerDeps {
  db: Database;
  config: Config;
  linear: LinearClient;
  runner: Liveness;
  hooks: MasterAgentHooks;
  worktrees: WorktreeOps;
  log: Logger;
  now: () => Date;
}

export type SkipReason =
  | "paused"
  | "live_claim"
  | "blocked"
  | "caps"
  | "claim_lost"
  | "start_failed";

export interface TickDecision {
  issueId: string;
  identifier: string;
  action: "started" | "skipped";
  bounce: boolean;
  reason?: SkipReason;
  /** The cap reasons when `reason` is `caps`. */
  detail?: string[];
}

export interface TickResult {
  paused: boolean;
  decisions: TickDecision[];
}

export type ReconcileAction = "orphan_released" | "kept" | "resumed" | "released";

export interface ReconcileDecision {
  issueId: string;
  action: ReconcileAction;
}
