// Last edited: 2026-09-20 23:50 CDT
// One MasterAgent per claim. The driver runs planning → implementing → handoff in order and ends
// in exactly one terminal state (awaiting_human, or blocked with one event). The pulse (see
// orchestrator.ts) pokes it from outside: the 2-hour clock, the stall check, the rate-limit wake.
// Everything durable is on the claims row, so a restart rebuilds the object from it.

import { isPaused, setPause } from "../caps.ts";
import type { IssueDetail } from "../linear/index.ts";
import { runHandoffPhase } from "../phases/handoff.ts";
import { runImplementPhase } from "../phases/implement.ts";
import { runPlanningPhase } from "../phases/plan.ts";
import { latestRunNamed, type Run, type Terminal } from "../runner/index.ts";
import {
  bumpFreshRestarts,
  CLAIMED,
  type Claim,
  type ClaimPatch,
  getClaim,
  insertEvent,
  patchClaim,
  RATE_LIMITED,
  setClaimState,
} from "../scheduler/index.ts";
import { blockIssue } from "../scheduler/tick.ts";
import { pauseUntilFor } from "./ratelimit.ts";
import {
  type Entry,
  FRESH_RESTART_MIN_MS,
  HANDOFF,
  IMPLEMENTING,
  type MasterDeps,
  type MasterEvent,
  OVER_BUDGET,
  PLANNING,
  STALLED,
} from "./types.ts";

export type Phase = typeof PLANNING | typeof IMPLEMENTING | typeof HANDOFF;

/**
 * The lifecycle phase a claim is in: from its state, or for a row the scheduler just handed over
 * (`claimed`, fresh or bounce) planning, or for a parked state such as `rate_limited` from what
 * this lifecycle has produced so far: no plan → planning, no PR → implementing.
 */
export function phaseFor(claim: Claim): Phase {
  if (claim.state === PLANNING || claim.state === IMPLEMENTING || claim.state === HANDOFF) {
    return claim.state;
  }
  if (claim.state === CLAIMED || !claim.planPath) return PLANNING;
  if (!claim.prUrl) return IMPLEMENTING;
  return HANDOFF;
}

export type RetryVerdict = "retry" | "blocked";

export class MasterAgent {
  claim: Claim;
  /** The run the pulse watches for stalls and kills on the clock, while a phase waits on one. */
  runId: string | null = null;
  /** Set by the pulse before it settles the waiter, so the phase knows why its wait ended. */
  interrupt: typeof STALLED | typeof OVER_BUDGET | null = null;
  /** True once the driver reached a terminal state. */
  done = false;
  /** Epoch ms when the issue clock runs out: `claimedAt + issueTimeoutHours`. */
  readonly deadline: number;
  private wake: (() => void) | null = null;

  constructor(
    readonly deps: MasterDeps,
    claim: Claim,
    readonly issue: IssueDetail,
  ) {
    this.claim = claim;
    this.deadline = Date.parse(claim.claimedAt) + deps.config.issueTimeoutHours * 3_600_000;
  }

  get cwd(): string {
    if (!this.claim.worktreePath) throw new Error(`claim ${this.claim.issueId} has no worktree`);
    return this.claim.worktreePath;
  }

  get identifier(): string {
    return this.issue.identifier;
  }

  now(): Date {
    return this.deps.now();
  }

  remainingMs(now: Date = this.now()): number {
    return this.deadline - now.getTime();
  }

  overBudget(now: Date = this.now()): boolean {
    return this.remainingMs(now) <= 0;
  }

  refresh(): Claim {
    this.claim = getClaim(this.deps.db, this.claim.issueId) ?? this.claim;
    return this.claim;
  }

  emit(event: MasterEvent, payload: Record<string, unknown> = {}): void {
    insertEvent(
      this.deps.db,
      this.now().toISOString(),
      `master.${event}`,
      this.claim.issueId,
      this.claim.agentId,
      payload,
    );
  }

  transition(state: string, payload: Record<string, unknown> = {}): Claim {
    const from = this.claim.state;
    this.claim = setClaimState(this.deps.db, this.claim.issueId, state, this.now().toISOString());
    this.emit("phase_changed", { from, to: state, ...payload });
    this.deps.log.info("master.phase_changed", { issueId: this.claim.issueId, from, to: state });
    return this.claim;
  }

  patch(patch: ClaimPatch): Claim {
    this.claim = patchClaim(this.deps.db, this.claim.issueId, patch, this.now().toISOString());
    return this.claim;
  }

  /** The newest run of one phase in this worktree, whatever its state. */
  runFor(phase: "plan" | "implement" | "handoff" | "resolve"): Run | null {
    return latestRunNamed(this.deps.db, this.cwd, `${this.identifier} ${phase}`);
  }

  /** Wait on a run, with the pulse watching it meanwhile. Never longer than the issue clock. */
  async waitRun(runId: string, timeoutMs: number = this.remainingMs()): Promise<Terminal | null> {
    this.runId = runId;
    this.interrupt = null;
    try {
      return await this.deps.waiter.wait(runId, Math.max(0, timeoutMs));
    } finally {
      this.runId = null;
    }
  }

  /** Pulse: kill the run and end the phase's wait when the issue clock has run out. */
  async checkClock(now: Date): Promise<boolean> {
    if (this.done || !this.overBudget(now)) return false;
    await this.interruptRun(OVER_BUDGET);
    return true;
  }

  /** Pulse: a live run with no activity for `stallMinutes` is killed; the phase resumes it. */
  async checkStall(now: Date): Promise<boolean> {
    const runId = this.runId;
    if (this.done || !runId) return false;
    const stalled = await this.deps.runner.isStalled(
      this.deps.db,
      runId,
      this.deps.config.stallMinutes,
      now.getTime(),
    );
    if (!stalled) return false;
    this.emit("stalled", { runId, state: this.claim.state });
    await this.interruptRun(STALLED);
    return true;
  }

  private async interruptRun(why: typeof STALLED | typeof OVER_BUDGET): Promise<void> {
    this.interrupt = why;
    const runId = this.runId;
    if (runId) {
      await this.deps.runner.kill(this.deps.db, runId);
      this.deps.waiter.settle(runId, { kind: "failed", error: why });
    }
    this.wake?.();
  }

  /** Pulse: end the rate-limit wait once the pause flag has expired (or the clock ran out). */
  wakeIfPauseOver(now: Date): boolean {
    if (!this.wake) return false;
    if (isPaused(this.deps.db, now) && !this.overBudget(now)) return false;
    this.wake();
    return true;
  }

  /**
   * Decision 3. Set the queue pause (parsed reset time, else the probe delay), park the claim in
   * `rate_limited`, and wait for the pulse to wake this agent. Resolves once the phase may probe.
   */
  async pauseForRateLimit(details?: string): Promise<void> {
    const { until, parsed } = pauseUntilFor(details, this.now(), this.deps.config);
    setPause(this.deps.db, until);
    const phase = this.claim.state;
    this.transition(RATE_LIMITED, { until: until.toISOString() });
    this.emit("rate_limited", { until: until.toISOString(), parsed, details: details ?? null });
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    this.wake = null;
    if (this.cutByClock()) return;
    setPause(this.deps.db, null);
    this.transition(phase);
    this.emit("rate_limit_resumed", {});
  }

  /**
   * After an opaque phase (plan, hand-off) failed: over budget → blocked; a rate limit → pause,
   * then retry uncounted; else one fresh restart while the clock allows it; else blocked.
   */
  async decideRetry(reason: string, detail: string, details?: string): Promise<RetryVerdict> {
    if (this.interrupt === OVER_BUDGET || this.overBudget()) {
      await this.blockOverBudget();
      return "blocked";
    }
    if (detail === "rate_limit" || reason === "rate_limit") {
      await this.pauseForRateLimit(details);
      if (this.cutByClock()) {
        await this.blockOverBudget();
        return "blocked";
      }
      return "retry";
    }
    if (this.canFreshRestart()) {
      this.claim = bumpFreshRestarts(this.deps.db, this.claim.issueId, this.now().toISOString());
      this.emit("fresh_restart", { phase: this.claim.state, reason, detail });
      return "retry";
    }
    await this.block(reason, `${this.phaseWord()} failed (${reason}): ${detail}`);
    return "blocked";
  }

  /** The pulse ended the last wait because the issue clock ran out. */
  cutByClock(): boolean {
    return this.interrupt === OVER_BUDGET;
  }

  /** Decision 4: one fresh restart, and only with at least 20 minutes of issue clock left. */
  canFreshRestart(): boolean {
    return this.claim.freshRestarts < 1 && this.remainingMs() >= FRESH_RESTART_MIN_MS;
  }

  private phaseWord(): string {
    return `The ${phaseFor(this.claim)} phase`;
  }

  async blockOverBudget(): Promise<void> {
    const hours = this.deps.config.issueTimeoutHours;
    await this.block(
      OVER_BUDGET,
      `Marshall stopped this issue: the ${hours}-hour clock ran out in the ${phaseFor(this.claim)} phase.`,
      "over_budget",
    );
  }

  /** The one terminal failure path: Blocked in Linear, `blocked` on the row, one event. */
  async block(
    why: string,
    comment: string,
    event: "blocked" | "over_budget" | "crashed" = "blocked",
  ): Promise<false> {
    await blockIssue(
      this.deps,
      this.issue,
      this.claim,
      why,
      `${comment} Move it back to Todo to give it another run.`,
      `master.${event}`,
    );
    this.refresh();
    this.done = true;
    return false;
  }

  /** Run the phases from wherever the claim is. Every path ends with `done` set. */
  async drive(entry: Entry): Promise<void> {
    try {
      let phase = phaseFor(this.claim);
      let how = entry;
      if (phase === PLANNING) {
        if (!(await runPlanningPhase(this, how))) return;
        phase = IMPLEMENTING;
        how = { kind: "start" };
      }
      if (phase === IMPLEMENTING) {
        if (!(await runImplementPhase(this, how))) return;
        phase = HANDOFF;
        how = { kind: "start" };
      }
      await runHandoffPhase(this, how);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.deps.log.error("master.crashed", { issueId: this.claim.issueId, error: message });
      if (this.runId) await this.deps.runner.kill(this.deps.db, this.runId).catch(() => {});
      await this.block(
        "crashed",
        `Marshall crashed while driving this issue: ${message}.`,
        "crashed",
      );
    } finally {
      this.done = true;
    }
  }
}
