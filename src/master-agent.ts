// Last edited: 2026-09-21 00:20 CDT
// Public surface of the master agent (step 08). `createMasterAgentHooks` is what `startLoop`
// takes in place of `defaultHooks`; `defaultMasterDeps` wires the real runner, git, gh, and the
// step 04 / 06 phases. Tests build a MasterDeps with fakes instead.

import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { runGh } from "./gh.ts";
import { postHandoff, runHandoffPhase } from "./handoff/index.ts";
import type { LinearClient } from "./linear/index.ts";
import type { Logger } from "./log.ts";
import { gitOps } from "./master/git.ts";
import { createOrchestrator, type Orchestrator } from "./master/orchestrator.ts";
import type { MasterDeps } from "./master/types.ts";
import { createRunWaiter, runPlanPhase } from "./plan/index.ts";
import type { RunWaiter } from "./plan/types.ts";
import { isStalled, kill, launch, resume } from "./runner/index.ts";

export { MasterAgent, phaseFor } from "./master/agent.ts";
export { emitMaster, transitionClaim } from "./master/events.ts";
export { discardImplementWork, gitOps } from "./master/git.ts";
export { createOrchestrator, type Orchestrator } from "./master/orchestrator.ts";
export { parseResetTime, pauseUntilFor } from "./master/ratelimit.ts";
export {
  type Entry,
  FRESH_RESTART_MIN_MS,
  type GitOps,
  HANDOFF,
  IMPLEMENTING,
  type Interrupt,
  KILL_FLAG_PREFIX,
  KILLED,
  killFlag,
  MASTER_EVENTS,
  type MasterDeps,
  type MasterEvent,
  OVER_BUDGET,
  type PhaseRunners,
  PLANNING,
  RESOLVING,
  type RunnerOps,
  STALLED,
} from "./master/types.ts";
export { ciStateOf, viewPr } from "./phases/pr.ts";
export { pulseRebases, readResolveOutcome, resolveStatusPath } from "./phases/rebase.ts";

export interface DefaultDepsInput {
  db: Database;
  config: Config;
  linear: LinearClient;
  log: Logger;
  now?: () => Date;
  /** Built over one watcher when omitted; the caller stops it on shutdown. */
  waiter?: RunWaiter;
}

/** The production wiring. Everything injectable points at the real module. */
export function defaultMasterDeps(input: DefaultDepsInput): MasterDeps {
  return {
    db: input.db,
    config: input.config,
    linear: input.linear,
    log: input.log,
    now: input.now ?? (() => new Date()),
    waiter: input.waiter ?? createRunWaiter(input.db),
    runner: { launch, resume, kill, isStalled },
    git: gitOps,
    gh: runGh,
    phases: { plan: runPlanPhase, handoff: runHandoffPhase, postHandoff },
  };
}

/** The hooks the scheduler loop takes. */
export function createMasterAgentHooks(deps: MasterDeps): Orchestrator {
  return createOrchestrator(deps);
}
