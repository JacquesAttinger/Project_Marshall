// Last edited: 2026-09-20 23:20 CDT
// Shapes for the master agent: the phase states it writes to `claims.state`, the events it
// records, and the injectable seams (runner, git, gh, phases) so the state machine is tested
// with fakes and a fake clock, never with a live agent.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type {
  GhRunner,
  HandoffPhaseInput,
  HandoffPhaseResult,
  PostInput,
  PostResult,
} from "../handoff/index.ts";
import type { LinearClient } from "../linear/index.ts";
import type { Logger } from "../log.ts";
import type { PlanPhaseInput, PlanPhaseResult, RunWaiter } from "../plan/index.ts";
import type { LaunchOpts, ResumeOpts, Run } from "../runner/index.ts";

/** Phase states, in lifecycle order. The parked and terminal ones live in scheduler/types.ts. */
export const PLANNING = "planning";
export const IMPLEMENTING = "implementing";
export const HANDOFF = "handoff";
/** A resolver agent is fixing a rebase conflict or red CI on a parked PR. Holds a slot. */
export const RESOLVING = "resolving";

/** Every event the master agent writes, as `master.<name>`. Step 09 maps six of them to pushes. */
export const MASTER_EVENTS = [
  "phase_changed",
  "finished",
  "blocked",
  "over_budget",
  "stalled",
  "resumed",
  "fresh_restart",
  "rate_limited",
  "rate_limit_resumed",
  "crashed",
  "pr_merged",
  "pr_closed",
  "rebase_queued",
  "rebased",
  "rebase_conflict",
] as const;
export type MasterEvent = (typeof MASTER_EVENTS)[number];

/** Why a phase's wait ended early: the pulse killed the run and settled the waiter with this. */
export const STALLED = "stalled";
export const OVER_BUDGET = "over_budget";

/** Below this much issue clock, a fresh restart is skipped and the issue goes to Blocked. */
export const FRESH_RESTART_MIN_MS = 20 * 60_000;

/** The runner calls the master agent makes. Defaults to `src/runner`; tests inject a fake. */
export interface RunnerOps {
  launch(db: Database, opts: LaunchOpts): Promise<Run>;
  resume(db: Database, opts: ResumeOpts): Promise<Run>;
  kill(db: Database, runId: string): Promise<Run>;
  isStalled(db: Database, runId: string, minutes: number, now: number): Promise<boolean>;
}

/** The git calls the discard and rebase paths make inside a worktree. */
export interface GitOps {
  fetch(cwd: string): Promise<void>;
  head(cwd: string): Promise<string>;
  /** The commit subject of `ref`. */
  subject(cwd: string, ref: string): Promise<string>;
  /** The newest commit that touched `path`, or null when none did. */
  lastCommitTouching(cwd: string, path: string): Promise<string | null>;
  /** `git reset --hard <ref>` then `git clean -fd` (ignored files such as `.env` stay). */
  resetHard(cwd: string, ref: string): Promise<void>;
  /** `git rebase origin/<base>`. False on a conflict, which is left in place for the resolver. */
  rebase(cwd: string, base: string): Promise<boolean>;
  abortRebase(cwd: string): Promise<void>;
  /** `git push --force-with-lease origin HEAD`. */
  forcePush(cwd: string): Promise<void>;
}

/** The three phase calls from steps 04 and 06, injectable so the driver is tested with stubs. */
export interface PhaseRunners {
  plan(input: PlanPhaseInput): Promise<PlanPhaseResult>;
  handoff(input: HandoffPhaseInput): Promise<HandoffPhaseResult>;
  postHandoff(input: PostInput): Promise<PostResult>;
}

export interface MasterDeps {
  db: Database;
  config: Config;
  linear: LinearClient;
  log: Logger;
  now: () => Date;
  /** One waiter over one watcher, shared by every phase of every agent. */
  waiter: RunWaiter;
  runner: RunnerOps;
  git: GitOps;
  gh: GhRunner;
  phases: PhaseRunners;
}

/** How a master agent comes to life. */
export type Entry =
  /** The scheduler just claimed the issue and made its worktree. */
  | { kind: "start" }
  /** Reconcile found the claim without a live agent and already counted the resume. */
  | { kind: "resume" }
  /** Reconcile kept the claim: the agent is alive, or the claim is parked. */
  | { kind: "attach" };
