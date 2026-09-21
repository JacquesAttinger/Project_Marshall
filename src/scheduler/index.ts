// Last edited: 2026-09-20 23:40 CDT
// Public surface of the scheduler. Step 08 plugs its master agent in through `MasterAgentHooks`
// and calls `startLoop`; `marshall queue` uses `tick`'s building blocks for a dry run.

import type { Database } from "bun:sqlite";
import { listActiveRuns, status } from "../runner/index.ts";
import { reconcile } from "./reconcile.ts";
import { insertEvent, releaseClaim } from "./store.ts";
import { tick } from "./tick.ts";
import type { Claim, Liveness, MasterAgentHooks, SchedulerDeps } from "./types.ts";

export { reconcile } from "./reconcile.ts";
export {
  bumpFreshRestarts,
  bumpResumes,
  type ClaimPatch,
  claimsInStates,
  getClaim,
  getClaimByIdentifier,
  insertEvent,
  isLive,
  liveClaims,
  lowestFreeSlot,
  patchClaim,
  releaseClaim,
  setClaimState,
} from "./store.ts";
export { blockIssue, consider, orderIssues, priorityRank, tick } from "./tick.ts";
export type {
  Claim,
  Liveness,
  MasterAgentHooks,
  ReconcileAction,
  ReconcileDecision,
  SchedulerDeps,
  SkipReason,
  TickDecision,
  TickResult,
  WorktreeOps,
  WorktreeSpec,
} from "./types.ts";
export {
  AWAITING_HUMAN,
  BLOCKED,
  CLAIMED,
  CLAIMING,
  PARKED_CLAIM_STATES,
  RATE_LIMITED,
  REBASING,
  RELEASED,
  TERMINAL_CLAIM_STATES,
} from "./types.ts";

/** A claim is alive when any non-terminal run in its worktree has a live daemon process. */
export function runnerLiveness(db: Database): Liveness {
  return {
    async isAlive(claim) {
      if (!claim.worktreePath) return false;
      for (const run of listActiveRuns(db).filter((r) => r.cwd === claim.worktreePath)) {
        if ((await status(db, run.runId)).alive) return true;
      }
      return false;
    },
  };
}

const NO_MASTER_AGENT_COMMENT =
  "Marshall restarted and found no live agent for this issue. Released to Todo (no master agent yet).";

/**
 * Until step 08 lands: `start` only logs (the claim stays, so the loop is not for production
 * yet), and `resume` releases the issue to Todo with a comment (decision 2 fallback).
 */
export function defaultHooks(
  deps: Pick<SchedulerDeps, "db" | "linear" | "log" | "now">,
): MasterAgentHooks {
  return {
    async start(claim: Claim) {
      deps.log.warn("scheduler.no_master_agent", { issueId: claim.issueId, slot: claim.slot });
    },
    async resume(claim: Claim) {
      const now = deps.now().toISOString();
      await deps.linear.release(claim.issueId, { comment: NO_MASTER_AGENT_COMMENT });
      releaseClaim(deps.db, claim.issueId, now);
      insertEvent(deps.db, now, "reconcile.released", claim.issueId, claim.agentId, {
        why: "no_master_agent",
      });
    },
  };
}

export interface Loop {
  /** Resolves once reconcile and the first tick are done. */
  ready: Promise<void>;
  stop(): void;
}

/**
 * Reconcile once, then tick every `pollMs` (default `config.pollSeconds`). Ticks never overlap:
 * the next one is scheduled when the current one ends. A tick that throws is logged and the loop
 * goes on. The master agent's `pulse` runs before each tick, paused or not, so a resolver run
 * takes a free slot before a new start does and a rate-limit probe fires when the pause ends.
 */
export function startLoop(deps: SchedulerDeps, opts: { pollMs?: number } = {}): Loop {
  const pollMs = opts.pollMs ?? deps.config.pollSeconds * 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const safeTick = async () => {
    try {
      await deps.hooks.pulse?.();
    } catch (err) {
      deps.log.error("scheduler.pulse_error", { error: (err as Error).message });
    }
    try {
      await tick(deps);
    } catch (err) {
      deps.log.error("scheduler.tick_error", { error: (err as Error).message });
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await safeTick();
      schedule();
    }, pollMs);
  };
  const ready = (async () => {
    await reconcile(deps);
    await safeTick();
    schedule();
  })();
  return {
    ready,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
