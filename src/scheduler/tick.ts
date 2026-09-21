// Last edited: 2026-09-20 23:40 CDT
// One pass of the scheduler: order the pickable issues and start what the caps allow. Each start
// writes a `claiming` row before it touches Linear, so a crash in the middle leaves a row reconcile
// can repair instead of an issue that is In Progress and invisible.

import { capCheck, isPaused } from "../caps.ts";
import { BLOCKED_STATE, type PickableIssue } from "../linear/index.ts";
import {
  abandonClaim,
  beginClaim,
  finishClaim,
  getClaim,
  insertEvent,
  insertStart,
  isLive,
  lowestFreeSlot,
  resetBounces,
  setClaimState,
} from "./store.ts";
import {
  BLOCKED,
  type Claim,
  type SchedulerDeps,
  type SkipReason,
  type TickDecision,
  type TickResult,
} from "./types.ts";

/** Linear priority 0 is "none"; it sorts after Low (4). Ties break on age, oldest first. */
export function priorityRank(priority: number): number {
  return priority === 0 ? Number.MAX_SAFE_INTEGER : priority;
}

export function orderIssues(issues: PickableIssue[]): PickableIssue[] {
  return [...issues].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) || a.createdAt.localeCompare(b.createdAt),
  );
}

function skipped(
  issue: PickableIssue,
  bounce: boolean,
  reason: SkipReason,
  detail?: string[],
): TickDecision {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    action: "skipped",
    bounce,
    reason,
    detail,
  };
}

/**
 * Park the issue in Blocked: back to Todo first so every agent label comes off (a human who moves
 * it to Todo later must be able to hand it back), then Blocked, then the local row. One event,
 * `scheduler.blocked` by default; the master agent passes its own terminal event type.
 */
export async function blockIssue(
  deps: Pick<SchedulerDeps, "db" | "linear" | "log" | "now">,
  issue: Pick<PickableIssue, "id" | "identifier">,
  claim: Claim,
  why: string,
  comment: string,
  eventType = "scheduler.blocked",
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.linear.release(issue.id, { comment });
  await deps.linear.setState(issue.id, BLOCKED_STATE);
  setClaimState(deps.db, issue.id, BLOCKED, now);
  insertEvent(deps.db, now, eventType, issue.id, claim.agentId, {
    why,
    bounces: claim.bounces,
    branch: claim.branch,
  });
  deps.log.warn(eventType, { issueId: issue.id, identifier: issue.identifier, why });
}

function bounceLimitComment(claim: Claim, max: number): string {
  return (
    `This issue bounced ${claim.bounces} times, the maximum (${max}), so Marshall marks it Blocked.` +
    " Move it back to Todo to give it one more run with a fresh bounce budget."
  );
}

/** Undo a start that failed after Linear said yes: Blocked with the reason, row blocked. */
async function failStart(
  deps: SchedulerDeps,
  issue: PickableIssue,
  claim: Claim,
  stage: string,
  err: unknown,
): Promise<TickDecision> {
  const message = (err as Error).message ?? String(err);
  deps.log.error("scheduler.start_failed", { issueId: issue.id, stage, error: message });
  const comment = `Marshall could not start this issue (${stage}): ${message}. Move it back to Todo to retry.`;
  await blockIssue(deps, issue, claim, `start_failed:${stage}`, comment);
  return skipped(issue, claim.bounces > 0, "start_failed", [message]);
}

async function startIssue(
  deps: SchedulerDeps,
  issue: PickableIssue,
  prior: Claim | null,
  bounce: boolean,
): Promise<TickDecision> {
  const { db, config, linear, worktrees, hooks, log } = deps;
  const now = deps.now().toISOString();
  const slot = lowestFreeSlot(db, config.maxAgents);
  if (slot === null) return skipped(issue, bounce, "caps", ["concurrency: no free slot"]);
  const claiming = beginClaim(db, issue.id, slot, now);
  let won: boolean;
  try {
    won = await linear.claim(issue.id, claiming.agentId);
  } catch (err) {
    // Linear did not answer: the write-ahead row must not keep the slot until the next boot.
    abandonClaim(db, issue.id, prior, now);
    throw err;
  }
  if (!won) {
    abandonClaim(db, issue.id, prior, now);
    log.info("scheduler.claim_lost", { issueId: issue.id, identifier: issue.identifier, slot });
    return skipped(issue, bounce, "claim_lost");
  }
  const branch = (bounce && prior?.branch) || issue.branchName;
  const spec = { repoPath: config.repoPath, branch, baseBranch: config.baseBranch };
  let worktreePath: string;
  try {
    worktreePath = bounce ? await worktrees.reuse(spec) : await worktrees.create(spec);
  } catch (err) {
    return failStart(deps, issue, claiming, "worktree", err);
  }
  const claim = finishClaim(
    db,
    issue.id,
    { identifier: issue.identifier, title: issue.title, branch, worktreePath, bounce },
    now,
  );
  if (!bounce) insertStart(db, issue.id, now);
  insertEvent(db, now, "scheduler.started", issue.id, claim.agentId, {
    slot,
    bounce,
    bounces: claim.bounces,
    branch,
    worktreePath,
  });
  log.info("scheduler.started", { issueId: issue.id, identifier: issue.identifier, slot, bounce });
  try {
    await hooks.start(claim, issue);
  } catch (err) {
    return failStart(deps, issue, claim, "hooks.start", err);
  }
  return { issueId: issue.id, identifier: issue.identifier, action: "started", bounce };
}

/** Decide one issue. Reads the row, applies the bounce rules and the caps, then starts. */
export async function consider(deps: SchedulerDeps, issue: PickableIssue): Promise<TickDecision> {
  const { db, config, log } = deps;
  const existing = getClaim(db, issue.id);
  if (existing && isLive(existing)) {
    log.warn("scheduler.skip_live_claim", { issueId: issue.id, state: existing.state });
    return skipped(issue, false, "live_claim");
  }
  let prior = existing;
  if (existing?.state === BLOCKED) {
    // The issue is pickable again, so a human moved it out of Blocked: forgive the bounces.
    const now = deps.now().toISOString();
    prior = resetBounces(db, issue.id, now);
    insertEvent(db, now, "scheduler.unblocked", issue.id, existing.agentId, {
      bounces: existing.bounces,
    });
  }
  const bounce = Boolean(prior?.branch);
  if (prior && bounce && prior.bounces >= config.maxBounces) {
    await blockIssue(
      deps,
      issue,
      prior,
      "bounce_limit",
      bounceLimitComment(prior, config.maxBounces),
    );
    return skipped(issue, true, "blocked");
  }
  const check = capCheck(db, config, deps.now(), { firstStart: !bounce });
  if (!check.ok) {
    log.debug("scheduler.skip_caps", { issueId: issue.id, reasons: check.reasons });
    return skipped(issue, bounce, "caps", check.reasons);
  }
  return startIssue(deps, issue, prior, bounce);
}

export async function tick(deps: SchedulerDeps): Promise<TickResult> {
  const now = deps.now();
  if (isPaused(deps.db, now)) {
    deps.log.info("scheduler.paused", { now: now.toISOString() });
    return { paused: true, decisions: [] };
  }
  const issues = orderIssues(await deps.linear.listPickable());
  const decisions: TickDecision[] = [];
  for (const issue of issues) {
    try {
      decisions.push(await consider(deps, issue));
    } catch (err) {
      // One bad issue must not stop the pass; the next tick sees it again.
      deps.log.error("scheduler.issue_error", { issueId: issue.id, error: (err as Error).message });
    }
  }
  return { paused: false, decisions };
}
