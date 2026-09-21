// Last edited: 2026-09-21 00:40 CDT
// Merge detection and rebasing, driven from the claims table on every pulse (spec 5.4). When a
// Marshall PR merges, every other parked PR is queued (`rebase_after`). One rebase runs at a
// time, oldest first: `git rebase origin/<base>` + push inline, then CI. Clean and green
// re-posts the hand-off with a badge. A conflict or red CI launches a resolver agent, which
// takes a concurrency slot but no daily or window start.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setPause } from "../caps.ts";
import { implementModel } from "../config.ts";
import { implementEnv } from "../isolation.ts";
import { emitMaster, transitionClaim } from "../master/events.ts";
import { pauseUntilFor } from "../master/ratelimit.ts";
import { type MasterDeps, RESOLVING } from "../master/types.ts";
import { issueDir } from "../paths.ts";
import { PLUGIN_DIR } from "../plan/index.ts";
import { terminalOf } from "../plan/wait.ts";
import { latestRunNamed, type Run } from "../runner/index.ts";
import {
  AWAITING_HUMAN,
  type Claim,
  claimsInStates,
  getClaim,
  lowestFreeSlot,
  patchClaim,
  REBASING,
  RELEASED,
} from "../scheduler/index.ts";
import { blockIssue } from "../scheduler/tick.ts";
import { RESOLVE_STATUS_FILE, resolvePrompt, runName } from "./names.ts";
import { viewPr } from "./pr.ts";

/** The merged PR each in-flight rebase was started for; a later merge re-queues on landing. */
const inflightFor = new Map<string, string>();

type Ctx = MasterDeps & { claim: Claim; identifier: string };

function ctxOf(deps: MasterDeps, claim: Claim): Ctx | null {
  if (!claim.prUrl || !claim.worktreePath || !claim.identifier || !claim.planPath) return null;
  return { ...deps, claim, identifier: claim.identifier };
}

function cwdOf(ctx: Ctx): string {
  return ctx.claim.worktreePath as string;
}

async function release(ctx: Ctx, event: "pr_merged" | "pr_closed"): Promise<void> {
  ctx.claim = transitionClaim(ctx, ctx.claim, RELEASED, { prUrl: ctx.claim.prUrl });
  emitMaster(ctx, ctx.claim, event, { prUrl: ctx.claim.prUrl });
  ctx.log.info(`master.${event}`, { issueId: ctx.claim.issueId, prUrl: ctx.claim.prUrl });
}

/** A sibling merged: every other parked PR gets `rebase_after` set to it. */
function queueSiblings(deps: MasterDeps, mergedPr: string, exceptIssue: string): void {
  for (const other of claimsInStates(deps.db, [AWAITING_HUMAN, REBASING, RESOLVING])) {
    if (other.issueId === exceptIssue || !other.prUrl) continue;
    const queued = patchClaim(
      deps.db,
      other.issueId,
      { rebaseAfter: mergedPr },
      deps.now().toISOString(),
    );
    emitMaster(deps, queued, "rebase_queued", { after: mergedPr });
  }
}

/** Poll every parked PR for a merge or a close. Never throws: one bad `gh` call is logged. */
async function pollMerges(deps: MasterDeps): Promise<void> {
  for (const claim of claimsInStates(deps.db, [AWAITING_HUMAN, REBASING])) {
    const ctx = ctxOf(deps, claim);
    if (!ctx) continue;
    try {
      const view = await viewPr(
        deps.gh,
        claim.prUrl as string,
        cwdOf(ctx),
        claim.updatedAt,
        deps.now(),
      );
      if (view.mergedAt || view.state === "MERGED") {
        await release(ctx, "pr_merged");
        queueSiblings(deps, claim.prUrl as string, claim.issueId);
      } else if (view.state === "CLOSED") {
        await release(ctx, "pr_closed");
      }
    } catch (err) {
      deps.log.warn("master.merge_poll_failed", {
        issueId: claim.issueId,
        error: (err as Error).message,
      });
    }
  }
}

function badgeFor(ctx: Ctx): string {
  return `rebased after ${ctx.claim.rebaseAfter ?? "a sibling PR"}`;
}

/** CI is green on the rebased branch: re-post the hand-off with the badge, back to Awaiting Human. */
async function land(ctx: Ctx): Promise<void> {
  const badge = badgeFor(ctx);
  const posted = await ctx.phases.postHandoff({
    issue: { id: ctx.claim.issueId, identifier: ctx.identifier },
    linear: ctx.linear,
    prUrl: ctx.claim.prUrl as string,
    cwd: cwdOf(ctx),
    round: ctx.claim.bounces + 1,
    badge,
    gh: ctx.gh,
    now: ctx.now,
  });
  if (!posted.ok) {
    ctx.log.error("master.rebase_repost_failed", {
      issueId: ctx.claim.issueId,
      reason: posted.reason,
      detail: posted.detail,
    });
  }
  const startedFor = inflightFor.get(ctx.claim.issueId);
  inflightFor.delete(ctx.claim.issueId);
  const current = getClaim(ctx.db, ctx.claim.issueId)?.rebaseAfter ?? null;
  const rebaseAfter = startedFor && current !== startedFor ? current : null;
  ctx.claim = patchClaim(ctx.db, ctx.claim.issueId, { rebaseAfter }, ctx.now().toISOString());
  ctx.claim = transitionClaim(ctx, ctx.claim, AWAITING_HUMAN, { badge });
  emitMaster(ctx, ctx.claim, "rebased", { badge, posted: posted.ok, requeued: rebaseAfter });
}

async function block(ctx: Ctx, why: string, comment: string): Promise<void> {
  inflightFor.delete(ctx.claim.issueId);
  await blockIssue(
    ctx,
    { id: ctx.claim.issueId, identifier: ctx.identifier },
    ctx.claim,
    why,
    `${comment} The PR is ${ctx.claim.prUrl}. Move the issue back to Todo to give it another run.`,
    "master.blocked",
  );
}

export function resolveStatusPath(identifier: string): string {
  return join(issueDir(identifier), RESOLVE_STATUS_FILE);
}

/** `{ outcome: "green" | "blocked", reason }` from resolve.json, or null when unusable. */
export function readResolveOutcome(
  identifier: string,
): { outcome: string; reason: string | null } | null {
  const path = resolveStatusPath(identifier);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.outcome !== "string") return null;
    return {
      outcome: parsed.outcome,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return null;
  }
}

/**
 * Take a slot and launch the resolver. False when no slot is free (the caller waits a tick);
 * the partial index is what makes the slot take atomic across processes.
 */
async function startResolver(ctx: Ctx, mode: "conflict" | "ci"): Promise<boolean> {
  const slot = lowestFreeSlot(ctx.db, ctx.config.maxAgents);
  if (slot === null) return false;
  const now = ctx.now().toISOString();
  try {
    ctx.claim = patchClaim(ctx.db, ctx.claim.issueId, { slot }, now);
    ctx.claim = transitionClaim(ctx, ctx.claim, RESOLVING, { mode, slot });
  } catch (err) {
    ctx.log.info("master.resolver_slot_lost", {
      issueId: ctx.claim.issueId,
      error: (err as Error).message,
    });
    return false;
  }
  rmSync(resolveStatusPath(ctx.identifier), { force: true });
  rmSync(`${resolveStatusPath(ctx.identifier)}.stop-blocks`, { force: true });
  const issueUrl = `https://linear.app/${ctx.config.workspace}/issue/${ctx.identifier}`;
  try {
    await ctx.runner.launch(ctx.db, {
      name: runName(ctx.identifier, "resolve"),
      cwd: cwdOf(ctx),
      model: implementModel(ctx.config),
      effort: "high",
      prompt: resolvePrompt(ctx.claim.planPath as string, ctx.identifier, mode),
      extraArgs: ["--plugin-dir", PLUGIN_DIR],
      env: implementEnv(ctx.identifier, issueUrl, slot, ctx.config),
      statusFile: resolveStatusPath(ctx.identifier),
    });
  } catch (err) {
    await block(
      ctx,
      "resolver_launch_failed",
      `The conflict resolver could not start: ${(err as Error).message}.`,
    );
    return true;
  }
  return true;
}

/** Undo whatever a failed resolver left: abort a rebase in progress, back to the pushed tip. */
async function restoreWorktree(ctx: Ctx): Promise<void> {
  const cwd = cwdOf(ctx);
  await ctx.git.abortRebase(cwd).catch(() => {});
  if (ctx.claim.branch) await ctx.git.resetHard(cwd, `origin/${ctx.claim.branch}`).catch(() => {});
}

async function resolverEnded(ctx: Ctx, run: Run): Promise<void> {
  const terminal = terminalOf(ctx.db, run.runId);
  if (!terminal) return;
  if (terminal.kind === "failed" && terminal.error === "rate_limit") {
    await restoreWorktree(ctx);
    const { until } = pauseUntilFor(terminal.details, ctx.now(), ctx.config);
    setPause(ctx.db, until);
    ctx.claim = transitionClaim(ctx, ctx.claim, AWAITING_HUMAN, { requeued: true });
    emitMaster(ctx, ctx.claim, "rate_limited", { until: until.toISOString(), phase: RESOLVING });
    return;
  }
  if (terminal.kind === "failed") {
    await restoreWorktree(ctx);
    await block(ctx, "resolver_failed", `The conflict resolver run failed (${terminal.error}).`);
    return;
  }
  const outcome = readResolveOutcome(ctx.identifier);
  if (outcome?.outcome !== "green") {
    await restoreWorktree(ctx);
    const reason = outcome?.reason ?? "no outcome written";
    await block(
      ctx,
      "resolver_gave_up",
      `The conflict resolver could not get the PR green: ${reason}.`,
    );
    return;
  }
  const view = await viewPr(
    ctx.gh,
    ctx.claim.prUrl as string,
    cwdOf(ctx),
    ctx.claim.updatedAt,
    ctx.now(),
  );
  if (view.ci === "red") {
    await block(ctx, "resolver_ci_red", "The conflict resolver reported green but CI is red.");
    return;
  }
  await land(ctx);
}

/** A resolver run in progress: watch its clock and stall; on its Stop, judge the result. */
async function progressResolving(ctx: Ctx): Promise<void> {
  const run = latestRunNamed(ctx.db, cwdOf(ctx), runName(ctx.identifier, "resolve"));
  if (!run) {
    await block(ctx, "resolver_missing", "The conflict resolver run is missing.");
    return;
  }
  if (terminalOf(ctx.db, run.runId)) return resolverEnded(ctx, run);
  const now = ctx.now();
  const deadline = Date.parse(run.createdAt) + ctx.config.issueTimeoutHours * 3_600_000;
  const stalled = await ctx.runner.isStalled(
    ctx.db,
    run.runId,
    ctx.config.stallMinutes,
    now.getTime(),
  );
  if (now.getTime() < deadline && !stalled) return;
  await ctx.runner.kill(ctx.db, run.runId);
  await restoreWorktree(ctx);
  const why = stalled ? "resolver_stalled" : "resolver_over_budget";
  await block(
    ctx,
    why,
    stalled ? "The conflict resolver stalled." : "The conflict resolver ran out of time.",
  );
}

/** A pushed rebase waiting on CI: green lands it, red hands it to a resolver, pending waits. */
async function progressRebasing(ctx: Ctx): Promise<void> {
  const view = await viewPr(
    ctx.gh,
    ctx.claim.prUrl as string,
    cwdOf(ctx),
    ctx.claim.updatedAt,
    ctx.now(),
  );
  if (view.ci === "green") return land(ctx);
  if (view.ci === "red") {
    emitMaster(ctx, ctx.claim, "rebase_conflict", { kind: "ci_red" });
    await startResolver(ctx, "ci");
    return;
  }
  const waited = ctx.now().getTime() - Date.parse(ctx.claim.updatedAt);
  if (waited > ctx.config.issueTimeoutHours * 3_600_000) {
    await block(ctx, "rebase_ci_timeout", "CI never finished after the rebase.");
  }
}

/** Decision 2: the oldest queued PR, rebased inline. A conflict goes to a resolver if a slot is free. */
async function startNextRebase(deps: MasterDeps): Promise<void> {
  const next = claimsInStates(deps.db, [AWAITING_HUMAN]).find((c) => c.rebaseAfter);
  if (!next) return;
  const ctx = ctxOf(deps, next);
  if (!ctx) return;
  const cwd = cwdOf(ctx);
  await ctx.git.fetch(cwd);
  const clean = await ctx.git.rebase(cwd, ctx.config.baseBranch);
  if (clean) {
    await ctx.git.forcePush(cwd);
    inflightFor.set(ctx.claim.issueId, ctx.claim.rebaseAfter as string);
    ctx.claim = transitionClaim(ctx, ctx.claim, REBASING, { after: ctx.claim.rebaseAfter });
    return;
  }
  emitMaster(ctx, ctx.claim, "rebase_conflict", { kind: "conflict", after: ctx.claim.rebaseAfter });
  inflightFor.set(ctx.claim.issueId, ctx.claim.rebaseAfter as string);
  if (!(await startResolver(ctx, "conflict"))) {
    inflightFor.delete(ctx.claim.issueId);
    await ctx.git.abortRebase(cwd);
  }
}

/** One pulse of the rebase machinery. Serial: at most one PR is rebasing or resolving. */
export async function pulseRebases(deps: MasterDeps): Promise<void> {
  await pollMerges(deps);
  const inflight = claimsInStates(deps.db, [REBASING, RESOLVING])[0];
  if (inflight) {
    const ctx = ctxOf(deps, inflight);
    if (!ctx) return;
    if (inflight.state === REBASING) await progressRebasing(ctx);
    else await progressResolving(ctx);
    return;
  }
  await startNextRebase(deps);
}
