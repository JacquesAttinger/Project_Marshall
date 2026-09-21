// Last edited: 2026-09-21 01:10 CDT
// The operational half of `marshall status`: the daemon (launchd + pidfile), the pause flags, the
// live agents (claims × their newest run), the "needs you" list (Needs Verification / Blocked with
// the hand-off path), and the queue dry run. Collect and format are split so tests read the data.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { manualPauseAt, pauseUntil } from "../caps.ts";
import { type Config, handoffModel, implementModel } from "../config.ts";
import { type DaemonDeps, type DaemonStatus, daemonStatus } from "../launchd.ts";
import { HANDOFF, IMPLEMENTING, PLANNING, RESOLVING } from "../master/types.ts";
import { handoffPath } from "../paths.ts";
import { liveOrchestrator, type OrchestratorProcess } from "../pidfile.ts";
import { latestRunInCwd, type Run } from "../runner/index.ts";
import {
  AWAITING_HUMAN,
  BLOCKED,
  type Claim,
  claimsInStates,
  liveClaims,
} from "../scheduler/index.ts";
import { formatQueue, type QueueReport } from "./queue.ts";

export interface AgentRow {
  slot: number;
  identifier: string;
  title: string | null;
  phase: string;
  model: string;
  /** Since `claimedAt`, as ms. */
  elapsedMs: number;
  run: Pick<Run, "runId" | "name" | "state" | "jobId"> | null;
}

export interface NeedsYouRow {
  identifier: string;
  title: string | null;
  state: string;
  prUrl: string | null;
  /** The hand-off package on disk, when it exists. */
  handoffPath: string | null;
  updatedAt: string;
}

export interface OpsReport {
  daemon: DaemonStatus;
  process: OrchestratorProcess | null;
  pausedAt: string | null;
  pausedUntil: string | null;
  agents: AgentRow[];
  needsYou: NeedsYouRow[];
  queue: QueueReport | null;
  /** Why the queue is missing: no key, or what Linear said. */
  queueError: string | null;
}

export interface OpsDeps {
  db: Database;
  config: Config;
  now: () => Date;
  /** The queue dry run, when Linear is reachable; omitted → `queueError` says why. */
  queue?: () => Promise<QueueReport>;
  queueError?: string;
  daemon?: DaemonDeps;
}

/** The model a claim's phase runs, from the claim (planner) or the config (the fixed phases). */
export function modelFor(claim: Claim, config: Config): string {
  switch (claim.state) {
    case PLANNING:
      return claim.model ?? "(classifying)";
    case IMPLEMENTING:
    case RESOLVING:
      return implementModel(config);
    case HANDOFF:
      return handoffModel(config);
    default:
      return "-";
  }
}

export function agentRows(db: Database, config: Config, now: Date): AgentRow[] {
  return liveClaims(db).map((claim) => {
    const run = claim.worktreePath ? latestRunInCwd(db, claim.worktreePath) : null;
    return {
      slot: claim.slot,
      identifier: claim.identifier ?? claim.issueId,
      title: claim.title,
      phase: claim.state,
      model: modelFor(claim, config),
      elapsedMs: Math.max(0, now.getTime() - Date.parse(claim.claimedAt)),
      run: run ? { runId: run.runId, name: run.name, state: run.state, jobId: run.jobId } : null,
    };
  });
}

export function needsYouRows(db: Database): NeedsYouRow[] {
  return claimsInStates(db, [AWAITING_HUMAN, BLOCKED]).map((claim) => {
    const identifier = claim.identifier ?? claim.issueId;
    const path = handoffPath(identifier);
    return {
      identifier,
      title: claim.title,
      state: claim.state,
      prUrl: claim.prUrl,
      handoffPath: existsSync(path) ? path : null,
      updatedAt: claim.updatedAt,
    };
  });
}

export async function collectOps(deps: OpsDeps): Promise<OpsReport> {
  const now = deps.now();
  let queue: QueueReport | null = null;
  let queueError = deps.queueError ?? null;
  if (deps.queue) {
    try {
      queue = await deps.queue();
    } catch (err) {
      queueError = (err as Error).message;
    }
  }
  return {
    daemon: await daemonStatus(deps.daemon),
    process: liveOrchestrator(),
    pausedAt: manualPauseAt(deps.db),
    pausedUntil: pauseUntil(deps.db)?.toISOString() ?? null,
    agents: agentRows(deps.db, deps.config, now),
    needsYou: needsYouRows(deps.db),
    queue,
    queueError,
  };
}

/** `1h 05m`, `12m`, `45s`. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function grid(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function daemonSection(ops: OpsReport): string[] {
  const process = ops.process
    ? `alive (pid ${ops.process.pid}, since ${ops.process.startedAt})`
    : "none (no pidfile, or a stale one)";
  const pause = ops.pausedAt
    ? `PAUSED by \`marshall pause\` at ${ops.pausedAt} (marshall resume)`
    : ops.pausedUntil
      ? `rate-limit pause until ${ops.pausedUntil}`
      : "no";
  return [
    "Daemon",
    ...grid([
      ["launchd", ops.daemon.detail],
      ["orchestrator", process],
      ["paused", pause],
    ]),
  ];
}

function agentsSection(ops: OpsReport): string[] {
  if (ops.agents.length === 0) return ["Agents", "none running"];
  return [
    "Agents",
    ...grid([
      ["Slot", "Issue", "Phase", "Model", "Elapsed", "Run", "Title"],
      ...ops.agents.map((a) => [
        String(a.slot),
        a.identifier,
        a.phase,
        a.model,
        formatElapsed(a.elapsedMs),
        a.run ? `${a.run.name} (${a.run.state}${a.run.jobId ? `, job ${a.run.jobId}` : ""})` : "-",
        a.title ?? "",
      ]),
    ]),
  ];
}

function needsYouSection(ops: OpsReport): string[] {
  if (ops.needsYou.length === 0) return ["Needs you", "nothing"];
  return [
    "Needs you",
    ...grid([
      ["Issue", "State", "PR", "Hand-off", "Title"],
      ...ops.needsYou.map((n) => [
        n.identifier,
        n.state === AWAITING_HUMAN ? "Needs Verification" : "Blocked",
        n.prUrl ?? "-",
        n.handoffPath ?? "-",
        n.title ?? "",
      ]),
    ]),
  ];
}

export function formatOps(ops: OpsReport): string {
  const queue = ops.queue
    ? ["Queue", formatQueue(ops.queue)]
    : ["Queue", `unavailable: ${ops.queueError ?? "unknown"}`];
  return [
    ...daemonSection(ops),
    "",
    ...agentsSection(ops),
    "",
    ...queue,
    "",
    ...needsYouSection(ops),
  ].join("\n");
}
