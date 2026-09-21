// Last edited: 2026-09-21 00:20 CDT
// The hooks the scheduler calls, over a map of live MasterAgents. `start` and `resume` build an
// agent and let its driver run detached (a tick must not wait two hours). `attach` rebuilds one
// after a restart. `pulse` runs before every tick: the kill flags, then the clock, the rate-limit
// wake, the stall check for each agent, then the DB-driven rebase machinery for the parked PRs.

import type { IssueDetail, PickableIssue } from "../linear/index.ts";
import { pulseRebases } from "../phases/rebase.ts";
import { AWAITING_HUMAN, type Claim, type MasterAgentHooks, REBASING } from "../scheduler/index.ts";
import { setFlag } from "../scheduler/store.ts";
import { MasterAgent } from "./agent.ts";
import { type Entry, KILL_FLAG_PREFIX, killFlag, type MasterDeps, RESOLVING } from "./types.ts";

/** Parked states the pulse handles from the claims table; no agent object is built for them. */
const PULSE_OWNED_STATES: readonly string[] = [AWAITING_HUMAN, REBASING, RESOLVING];

export interface Orchestrator extends MasterAgentHooks {
  agents: Map<string, MasterAgent>;
  pulse(): Promise<void>;
  attach(claim: Claim): Promise<void>;
  /** Resolves once every live driver has reached a terminal state (tests and shutdown). */
  settled(): Promise<void>;
}

/**
 * Execute `marshall kill` flags. One with a live agent that has something to interrupt is run and
 * cleared; one whose agent sits between runs waits for the next pulse; one with no agent at all
 * is cleared with a log line (the CLI handles the no-daemon case itself).
 */
async function pulseKills(deps: MasterDeps, agents: Map<string, MasterAgent>): Promise<void> {
  const rows = deps.db
    .query<{ key: string }, [string]>("SELECT key FROM flags WHERE key LIKE ? || '%'")
    .all(KILL_FLAG_PREFIX);
  for (const { key } of rows) {
    const issueId = key.slice(KILL_FLAG_PREFIX.length);
    const agent = agents.get(issueId);
    if (!agent || agent.done) {
      deps.log.warn("master.kill_no_agent", { issueId });
      setFlag(deps.db, key, null);
      continue;
    }
    try {
      if (await agent.kill()) {
        deps.log.info("master.killed", { issueId, state: agent.claim.state });
        setFlag(deps.db, killFlag(issueId), null);
      } else {
        deps.log.info("master.kill_deferred", { issueId, state: agent.claim.state });
      }
    } catch (err) {
      deps.log.error("master.kill_error", { issueId, error: (err as Error).message });
    }
  }
}

export function createOrchestrator(deps: MasterDeps): Orchestrator {
  const agents = new Map<string, MasterAgent>();
  const drivers = new Map<string, Promise<void>>();

  /**
   * Build the agent and let its driver run detached. The issue is re-read from Linear so a
   * bounce sees the human's latest comment. `drive` never throws; the catch is a last guard so
   * a lost agent can never surface as an unhandled rejection.
   */
  async function spawn(claim: Claim, entry: Entry): Promise<void> {
    if (agents.has(claim.issueId)) {
      deps.log.warn("master.already_running", { issueId: claim.issueId, entry: entry.kind });
      return;
    }
    const issue: IssueDetail = await deps.linear.getIssue(claim.issueId);
    const agent = new MasterAgent(deps, claim, issue);
    agents.set(claim.issueId, agent);
    const driver = agent
      .drive(entry)
      .catch((err) => {
        deps.log.error("master.driver_error", {
          issueId: claim.issueId,
          error: (err as Error).message,
        });
      })
      .finally(() => {
        agents.delete(claim.issueId);
        drivers.delete(claim.issueId);
      });
    drivers.set(claim.issueId, driver);
  }

  return {
    agents,
    async start(claim, _issue: PickableIssue) {
      await spawn(claim, { kind: "start" });
    },
    async resume(claim) {
      await spawn(claim, { kind: "resume" });
    },
    async attach(claim) {
      if (PULSE_OWNED_STATES.includes(claim.state)) return;
      await spawn(claim, { kind: "attach" });
    },
    async pulse() {
      const now = deps.now();
      await pulseKills(deps, agents);
      for (const agent of [...agents.values()]) {
        if (agent.done) continue;
        try {
          if (await agent.checkClock(now)) continue;
          if (agent.wakeIfPauseOver(now)) continue;
          await agent.checkStall(now);
        } catch (err) {
          deps.log.error("master.pulse_agent_error", {
            issueId: agent.claim.issueId,
            error: (err as Error).message,
          });
        }
      }
      await pulseRebases(deps);
    },
    async settled() {
      await Promise.all([...drivers.values()]);
    },
  };
}
