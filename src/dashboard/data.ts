// Last edited: 2026-10-03 18:27 CDT
// Everything the dashboard shows, read from the DB and the files the agents write. The slow or
// remote inputs (launchd, the daemon's session roster, Linear) are fetched by the caller and
// passed in, so this module is pure over the DB and the filesystem. Each per-item file read is
// caught on its own: a half-written state.json blanks one field, never the page.
//
// Two keys are in play: `claims.issue_id` is the Linear UUID (kill flags, events), and the
// identifier (`TOD-17`) names the files (hand-off, implement.json).

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { type CapCounts, readCapCounts } from "../caps.ts";
import { collectQueue, type QueueReport } from "../cli/queue.ts";
import { modelFor } from "../cli/status-ops.ts";
import type { Config } from "../config.ts";
import { readHandoffMeta } from "../handoff/meta.ts";
import { type ImplementStatus, readImplementStatus } from "../implement/status.ts";
import type { PickableIssue } from "../linear/index.ts";
import { linearIssueUrl } from "../linear/url.ts";
import { tldrOf } from "../markdown.ts";
import { IMPLEMENTING, killFlag, RESOLVING } from "../master/types.ts";
import { handoffPath } from "../paths.ts";
import {
  type DaemonSession,
  latestRunInCwd,
  readJobState,
  stalledFrom,
  statusFrom,
} from "../runner/index.ts";
import {
  AWAITING_HUMAN,
  BLOCKED,
  type Claim,
  claimsInStates,
  liveClaims,
  REBASING,
} from "../scheduler/index.ts";
import { getFlag } from "../scheduler/store.ts";
import { blockReason } from "./block-reason.ts";

/** What the last Linear fetch returned. The lists stay from the last good fetch after a failure. */
export interface LinearSnapshot {
  pickable: PickableIssue[] | null;
  /** UUIDs Linear lists as Needs Verification or Blocked. */
  awaitingIds: ReadonlySet<string> | null;
  fetchedAt: string | null;
  /** The last fetch's error, or why Linear is not used at all (no key). */
  error: string | null;
}

export interface CollectDeps {
  db: Database;
  config: Config;
  now: Date;
  /** True when a pidfile or launchd says an orchestrator is running. */
  daemonRunning: boolean;
  /** The daemon's roster, listed once per window. Null when the listing failed. */
  sessions: readonly DaemonSession[] | null;
  linear: LinearSnapshot;
}

export interface StripData {
  daemonRunning: boolean;
  counts: CapCounts;
  caps: Pick<Config, "maxAgents" | "dailyStartCap" | "windowStartCap" | "windowHours">;
  /** No fresh or bounce row in the queue. Null when the queue is unknown. */
  queueEmpty: boolean | null;
}

export interface AgentInfo {
  issueId: string;
  identifier: string;
  title: string | null;
  url: string;
  state: string;
  phase: string;
  /** The implementer's own step while implementing ("review cycle 2/4"). */
  subPhase: string | null;
  model: string;
  elapsedMs: number;
  tokens: number | null;
  lastAction: string | null;
  /** Why a person should look now, or null. */
  needsYou: string | null;
  killRequested: boolean;
  /** False for a resolver: the orchestrator cannot stop one (see src/kill.ts). */
  killable: boolean;
}

export interface AgentSlot {
  slot: number;
  agent: AgentInfo | null;
}

export interface NeedsYouCard {
  issueId: string;
  identifier: string;
  title: string | null;
  url: string;
  state: string;
  prUrl: string | null;
  updatedAt: string;
  tldr: string | null;
  round: number | null;
  hasHandoff: boolean;
  blockReason: string | null;
}

export interface QueueData {
  report: QueueReport | null;
  fetchedAt: string | null;
  error: string | null;
}

export interface DashboardData {
  now: string;
  strip: StripData;
  agents: AgentSlot[];
  needsYou: { cards: NeedsYouCard[]; checkedAgainstLinear: boolean };
  queue: QueueData;
}

/** Run `fn`; on a throw, the fallback. One bad file must not take the page down. */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const PHASE_LABELS: Record<string, string> = {
  claiming: "Starting",
  claimed: "Starting",
  planning: "Planning",
  implementing: "Implementing",
  handoff: "Writing hand-off",
  resolving: "Resolving conflicts",
  rate_limited: "Rate-limited",
};

export function phaseLabel(state: string): string {
  return PHASE_LABELS[state] ?? state;
}

/** The implementer's step, from its implement.json. */
export function implementSubPhase(status: ImplementStatus | null): string | null {
  if (!status) return null;
  const cycle = `${status.cycle}/${status.maxCycles}`;
  switch (status.phase) {
    case "starting":
      return "starting";
    case "implementing":
      return "writing code";
    case "testing":
      return "running tests";
    case "pr_open":
      return "PR open";
    case "reviewing":
      return `review cycle ${cycle}`;
    case "fixing":
      return `fixing · cycle ${cycle}`;
    case "done":
      return "done";
  }
}

interface RunFacts {
  tokens: number | null;
  lastAction: string | null;
  needsYou: string | null;
}

/** Tokens, last action, and the needs-you flag from the claim's newest run. */
function runFacts(deps: CollectDeps, claim: Claim): RunFacts {
  const none: RunFacts = { tokens: null, lastAction: null, needsYou: null };
  const run = claim.worktreePath ? latestRunInCwd(deps.db, claim.worktreePath) : null;
  if (!run?.jobId) return none;
  const job = attempt(() => readJobState(run.jobId as string), null);
  const facts: RunFacts = {
    tokens: job?.tokens ?? null,
    lastAction: job?.detail ?? null,
    needsYou: null,
  };
  if (job?.tempo === "blocked" || job?.needs) facts.needsYou = job.needs ?? "waiting on input";
  if (!facts.needsYou && deps.sessions) {
    const sessions = deps.sessions;
    const stalled = attempt(
      () =>
        stalledFrom(
          statusFrom(deps.db, run, job, sessions),
          deps.config.stallMinutes,
          deps.now.getTime(),
        ),
      false,
    );
    if (stalled) facts.needsYou = `no activity for ${deps.config.stallMinutes}+ min`;
  }
  return facts;
}

function agentInfo(deps: CollectDeps, claim: Claim): AgentInfo {
  const identifier = claim.identifier ?? claim.issueId;
  const subPhase =
    claim.state === IMPLEMENTING
      ? attempt(() => implementSubPhase(readImplementStatus(identifier)), null)
      : null;
  return {
    issueId: claim.issueId,
    identifier,
    title: claim.title,
    url: linearIssueUrl(deps.config.workspace, identifier),
    state: claim.state,
    phase: phaseLabel(claim.state),
    subPhase,
    model: modelFor(claim, deps.config),
    elapsedMs: Math.max(0, deps.now.getTime() - Date.parse(claim.claimedAt)),
    ...runFacts(deps, claim),
    killRequested: getFlag(deps.db, killFlag(claim.issueId)) !== null,
    killable: claim.state !== RESOLVING,
  };
}

/** One entry per slot up to `maxAgents`, plus any claim on a slot above it (config lowered). */
export function agentSlots(deps: CollectDeps): AgentSlot[] {
  const bySlot = new Map(liveClaims(deps.db).map((c) => [c.slot, c]));
  const top = Math.max(deps.config.maxAgents, ...[...bySlot.keys()].map((s) => s + 1));
  return Array.from({ length: top }, (_, slot) => {
    const claim = bySlot.get(slot);
    return { slot, agent: claim ? agentInfo(deps, claim) : null };
  });
}

/** The hand-off's TLDR without its `**TLDR:**` label, or null. */
function handoffTldr(identifier: string): string | null {
  const path = handoffPath(identifier);
  if (!existsSync(path)) return null;
  const tldr = attempt(() => tldrOf(readFileSync(path, "utf8")), null);
  return tldr ? tldr.replace(/^\*\*TLDR:?\*\*:?\s*/i, "") : null;
}

function needsYouCard(deps: CollectDeps, claim: Claim): NeedsYouCard {
  const identifier = claim.identifier ?? claim.issueId;
  const awaiting = claim.state === AWAITING_HUMAN;
  return {
    issueId: claim.issueId,
    identifier,
    title: claim.title,
    url: linearIssueUrl(deps.config.workspace, identifier),
    state: claim.state,
    prUrl: claim.prUrl,
    updatedAt: claim.updatedAt,
    tldr: awaiting ? handoffTldr(identifier) : null,
    round: awaiting ? attempt(() => readHandoffMeta(identifier)?.round ?? null, null) : null,
    hasHandoff: awaiting && existsSync(handoffPath(identifier)),
    blockReason:
      claim.state === BLOCKED
        ? attempt(() => blockReason(deps.db, claim.issueId, identifier), null)
        : null,
  };
}

/**
 * Claims parked on a person, kept only while Linear still lists the issue as Needs Verification
 * or Blocked: nothing moves a claim out of `blocked` once the issue is Done or cancelled.
 */
export function needsYou(deps: CollectDeps): DashboardData["needsYou"] {
  const claims = claimsInStates(deps.db, [AWAITING_HUMAN, BLOCKED, REBASING]);
  const ids = deps.linear.awaitingIds;
  const kept = ids ? claims.filter((c) => ids.has(c.issueId)) : claims;
  // Newest first: the issue that just landed on you is the one to read.
  kept.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    cards: kept.map((c) => needsYouCard(deps, c)),
    checkedAgainstLinear: ids !== null,
  };
}

async function queueData(deps: CollectDeps): Promise<QueueData> {
  const { pickable, fetchedAt, error } = deps.linear;
  if (!pickable) return { report: null, fetchedAt, error: error ?? "not loaded yet" };
  const report = await collectQueue({
    db: deps.db,
    config: deps.config,
    linear: { listPickable: async () => pickable },
    now: () => deps.now,
  });
  return { report, fetchedAt, error };
}

export async function collectDashboard(deps: CollectDeps): Promise<DashboardData> {
  const queue = await queueData(deps);
  const rows = queue.report?.rows;
  return {
    now: deps.now.toISOString(),
    strip: {
      daemonRunning: deps.daemonRunning,
      counts: readCapCounts(deps.db, deps.config, deps.now),
      caps: {
        maxAgents: deps.config.maxAgents,
        dailyStartCap: deps.config.dailyStartCap,
        windowStartCap: deps.config.windowStartCap,
        windowHours: deps.config.windowHours,
      },
      queueEmpty:
        rows && !queue.error ? !rows.some((r) => r.kind === "fresh" || r.kind === "bounce") : null,
    },
    agents: agentSlots(deps),
    needsYou: needsYou(deps),
    queue,
  };
}
