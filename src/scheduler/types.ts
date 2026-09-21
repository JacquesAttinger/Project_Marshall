// Last edited: 2026-09-20 23:40 CDT
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
/** The PR is open and a human decides next. The row and worktree stay for rebases and bounces. */
export const AWAITING_HUMAN = "awaiting_human";
/** Rebased on the base branch and pushed; waiting for CI. No agent runs. */
export const REBASING = "rebasing";
/** The agent hit the usage limit; the claim keeps its slot until the pause ends. */
export const RATE_LIMITED = "rate_limited";

/** States that free the slot. Must match the `claims_live_slot` partial index in 004_master.sql. */
export const TERMINAL_CLAIM_STATES: readonly string[] = [
  RELEASED,
  BLOCKED,
  AWAITING_HUMAN,
  REBASING,
];

/**
 * States reconcile keeps without a liveness check or a resume: no agent is expected to be alive.
 * The master agent's pulse owns them (merge poll, rebase queue, rate-limit probe).
 */
export const PARKED_CLAIM_STATES: readonly string[] = [AWAITING_HUMAN, REBASING, RATE_LIMITED];

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
  /** The human key (`CB-12`) that names the issue's files. Null on rows older than migration 004. */
  identifier: string | null;
  /** Fresh restarts of a phase after the resumes ran out. One is allowed. */
  freshRestarts: number;
  /** The plan file relative to the worktree, once the planner has committed it. */
  planPath: string | null;
  /** The planner model the classifier picked; a bounce reuses it. */
  model: string | null;
  /** The PR the implement phase opened. */
  prUrl: string | null;
  /** The sibling PR whose merge queued a rebase, until that rebase lands. */
  rebaseAfter: string | null;
  /** The issue title at claim time. Null on rows older than migration 005. */
  title: string | null;
  claimedAt: string;
  updatedAt: string;
}

/**
 * What step 08 plugs in. `start` receives a claim whose worktree exists and whose Linear issue is
 * In Progress with our label. `resume` receives a claim reconcile found without a live agent.
 * Neither may throw after it has launched a job: the scheduler releases the claim on a throw.
 * `attach` receives a claim reconcile kept (agent alive, or a parked state), so a restarted
 * orchestrator can rebuild its object. `pulse` runs before every tick, paused or not.
 */
export interface MasterAgentHooks {
  start(claim: Claim, issue: PickableIssue): Promise<void>;
  resume(claim: Claim): Promise<void>;
  attach?(claim: Claim): Promise<void>;
  pulse?(): Promise<void>;
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
