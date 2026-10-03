// Last edited: 2026-10-03 18:36 CDT
// Stop one issue's agent and park the issue in Blocked; `marshall kill` and the dashboard's Kill
// button both call `requestKill`. With a live orchestrator, write the kill flag and let its pulse
// do the work in-process: no race with a master agent that is mid-transition. Without one, do it
// here: kill the runs in the claim's worktree and block the issue through the same `blockIssue`
// the master agent uses.

import type { Database } from "bun:sqlite";
import { type DaemonDeps, daemonStatus } from "./launchd.ts";
import type { LinearClient } from "./linear/index.ts";
import type { Logger } from "./log.ts";
import { KILLED, killFlag, RESOLVING } from "./master/types.ts";
import { defaultMarshallHome, marshallHome } from "./paths.ts";
import { liveOrchestrator } from "./pidfile.ts";
import { kill, listActiveRuns } from "./runner/index.ts";
import { type Claim, getClaimByIdentifier, isLive } from "./scheduler/index.ts";
import { getFlag, setFlag } from "./scheduler/store.ts";
import { blockIssue } from "./scheduler/tick.ts";

export type KillResult =
  | { kind: "flagged"; identifier: string; state: string; pid: number }
  | { kind: "already_requested"; identifier: string }
  | { kind: "killed_directly"; identifier: string; runsStopped: number }
  | { kind: "no_claim"; identifier: string }
  | { kind: "not_live"; identifier: string; state: string }
  /** The orchestrator builds no agent for a resolver, so its pulse would drop the flag. */
  | { kind: "not_killable"; identifier: string; state: string };

export interface KillDeps {
  db: Database;
  log: Logger;
  now: () => Date;
  /** Called only on the direct path. The CLI connects here; the dashboard passes its client. */
  linear: () => Promise<LinearClient>;
  /** Overrides the launchd half of the orchestrator check (tests). */
  daemon?: DaemonDeps;
  /** The state root the launchd job serves. Default `~/.marshall` (the plist sets no other). */
  launchdHome?: string;
}

/**
 * The pid of an orchestrator that will act on a flag in this DB, or null. The pidfile is written
 * only after the daemon has connected to Linear and migrated, so a daemon that launchd reports
 * running counts too: a direct kill in that gap would race the daemon's reconcile.
 */
export async function orchestratorPid(
  deps: Pick<KillDeps, "daemon" | "launchdHome"> = {},
): Promise<number | null> {
  const proc = liveOrchestrator();
  if (proc) return proc.pid;
  if (marshallHome() !== (deps.launchdHome ?? defaultMarshallHome())) return null;
  const daemon = await daemonStatus(deps.daemon);
  return daemon.state === "running" ? daemon.pid : null;
}

/** Stop every non-terminal run in the claim's worktree. Returns the run ids it killed. */
async function killRuns(db: Database, claim: Claim): Promise<string[]> {
  const killed: string[] = [];
  for (const run of listActiveRuns(db).filter((r) => r.cwd === claim.worktreePath)) {
    await kill(db, run.runId);
    killed.push(run.runId);
  }
  return killed;
}

const DIRECT_COMMENT =
  "Marshall stopped this issue on request (`marshall kill`) while no orchestrator was running. Move it back to Todo to give it another run.";

export async function requestKill(deps: KillDeps, identifier: string): Promise<KillResult> {
  const { db } = deps;
  const claim = getClaimByIdentifier(db, identifier);
  if (!claim) return { kind: "no_claim", identifier };
  const name = claim.identifier ?? identifier;
  if (!isLive(claim)) return { kind: "not_live", identifier: name, state: claim.state };
  const pid = await orchestratorPid(deps);
  if (pid !== null) {
    if (claim.state === RESOLVING) {
      return { kind: "not_killable", identifier: name, state: claim.state };
    }
    if (getFlag(db, killFlag(claim.issueId)))
      return { kind: "already_requested", identifier: name };
    setFlag(db, killFlag(claim.issueId), deps.now().toISOString());
    return { kind: "flagged", identifier: name, state: claim.state, pid };
  }
  // No orchestrator: nothing else will act, so do it here, Linear included.
  const linear = await deps.linear();
  const killed = await killRuns(db, claim);
  await blockIssue(
    { db, linear, log: deps.log, now: deps.now },
    { id: claim.issueId, identifier: name },
    claim,
    KILLED,
    DIRECT_COMMENT,
    "master.blocked",
  );
  return { kind: "killed_directly", identifier: name, runsStopped: killed.length };
}

/** One line for a person: the CLI prints it and the dashboard shows it on the panel. */
export function killMessage(result: KillResult): string {
  switch (result.kind) {
    case "flagged":
      return `kill requested for ${result.identifier} (${result.state}). The orchestrator (pid ${result.pid}) stops it on its next pulse and marks it Blocked.`;
    case "already_requested":
      return `kill of ${result.identifier} already requested; waiting on the pulse`;
    case "killed_directly":
      return `${result.identifier} killed directly (no orchestrator running): ${result.runsStopped} run(s) stopped, issue Blocked.`;
    case "no_claim":
      return `no claim for ${result.identifier}`;
    case "not_live":
      return `${result.identifier} is not running (state: ${result.state})`;
    case "not_killable":
      return `${result.identifier} is resolving a rebase conflict, and the orchestrator cannot stop a resolver. Run \`marshall stop\`, then kill it again.`;
  }
}

/** Results that did what was asked (or had already been asked). */
export function killSucceeded(result: KillResult): boolean {
  return (
    result.kind === "flagged" ||
    result.kind === "already_requested" ||
    result.kind === "killed_directly"
  );
}
