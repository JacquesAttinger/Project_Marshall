// Last edited: 2026-09-20 22:45 CDT
// Runs once on boot, before the first tick. Every live claim either has a live agent (kept), gets
// resumed through the step 08 hook while it has budget, or goes back to Todo. Parked claims
// (a PR waiting on a human, a rebase waiting on CI, a rate-limit pause) are kept without a
// liveness check: no agent is expected there. Every kept claim is handed to `hooks.attach`.

import { bumpResumes, claimsInStates, insertEvent, liveClaims, releaseClaim } from "./store.ts";
import {
  CLAIMING,
  type Claim,
  PARKED_CLAIM_STATES,
  type ReconcileDecision,
  type SchedulerDeps,
} from "./types.ts";

const ORPHAN_COMMENT =
  "Marshall restarted in the middle of picking this issue up and released it. It will be picked up again on the next tick.";

function noAgentComment(claim: Claim): string {
  const kept = claim.branch ? ` The branch \`${claim.branch}\` and its worktree are kept.` : "";
  return `Marshall restarted and found no live agent for this issue after ${claim.resumes} resumes. Released to Todo.${kept}`;
}

async function release(
  deps: SchedulerDeps,
  claim: Claim,
  type: string,
  comment: string,
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.linear.release(claim.issueId, { comment });
  releaseClaim(deps.db, claim.issueId, now);
  insertEvent(deps.db, now, type, claim.issueId, claim.agentId, {
    state: claim.state,
    resumes: claim.resumes,
  });
  deps.log.info(type, { issueId: claim.issueId, state: claim.state });
}

/** Ask the runner. An error means "unknown", and an unknown agent is kept, never released. */
async function isAlive(deps: SchedulerDeps, claim: Claim): Promise<boolean> {
  try {
    return await deps.runner.isAlive(claim);
  } catch (err) {
    deps.log.error("reconcile.liveness_error", {
      issueId: claim.issueId,
      error: (err as Error).message,
    });
    return true;
  }
}

/** Kept: log it, then hand it to the master agent. A throwing attach is logged, never fatal. */
async function keep(deps: SchedulerDeps, claim: Claim, why: string): Promise<ReconcileDecision> {
  const now = deps.now().toISOString();
  insertEvent(deps.db, now, "reconcile.kept", claim.issueId, claim.agentId, {
    state: claim.state,
    why,
  });
  deps.log.info("reconcile.kept", { issueId: claim.issueId, state: claim.state, why });
  try {
    await deps.hooks.attach?.(claim);
  } catch (err) {
    deps.log.error("reconcile.attach_failed", {
      issueId: claim.issueId,
      error: (err as Error).message,
    });
  }
  return { issueId: claim.issueId, action: "kept" };
}

async function reconcileOne(deps: SchedulerDeps, claim: Claim): Promise<ReconcileDecision> {
  const { db, config, hooks, log } = deps;
  if (claim.state === CLAIMING) {
    await release(deps, claim, "reconcile.orphan_released", ORPHAN_COMMENT);
    return { issueId: claim.issueId, action: "orphan_released" };
  }
  if (PARKED_CLAIM_STATES.includes(claim.state)) return keep(deps, claim, "parked");
  if (await isAlive(deps, claim)) return keep(deps, claim, "alive");
  if (claim.resumes < config.maxResumes) {
    const now = deps.now().toISOString();
    const resumed = bumpResumes(db, claim.issueId, now);
    insertEvent(db, now, "reconcile.resumed", claim.issueId, claim.agentId, {
      resumes: resumed.resumes,
    });
    log.info("reconcile.resumed", { issueId: claim.issueId, resumes: resumed.resumes });
    try {
      await hooks.resume(resumed);
    } catch (err) {
      log.error("reconcile.resume_failed", {
        issueId: claim.issueId,
        error: (err as Error).message,
      });
      await release(deps, resumed, "reconcile.released", noAgentComment(resumed));
      return { issueId: claim.issueId, action: "released" };
    }
    return { issueId: claim.issueId, action: "resumed" };
  }
  await release(deps, claim, "reconcile.released", noAgentComment(claim));
  return { issueId: claim.issueId, action: "released" };
}

/** Every claim reconcile looks at: the live ones, plus the parked ones that hold no slot. */
function claimsToReconcile(deps: SchedulerDeps): Claim[] {
  const live = liveClaims(deps.db);
  const seen = new Set(live.map((c) => c.issueId));
  const parked = claimsInStates(deps.db, PARKED_CLAIM_STATES).filter((c) => !seen.has(c.issueId));
  return [...live, ...parked];
}

export async function reconcile(deps: SchedulerDeps): Promise<ReconcileDecision[]> {
  const decisions: ReconcileDecision[] = [];
  for (const claim of claimsToReconcile(deps)) {
    decisions.push(await reconcileOne(deps, claim));
  }
  return decisions;
}
