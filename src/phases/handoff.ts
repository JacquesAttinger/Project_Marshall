// Last edited: 2026-09-21 00:15 CDT
// The hand-off phase as the master agent runs it: one `runHandoffPhase` call (step 06), then
// Needs Verification, the follow-ups from implement.json (filed in batch, once per title), the
// claim parked in `awaiting_human` (which frees the slot), and the `finished` event.

import type { HandoffPhaseInput, HandoffPhaseResult } from "../handoff/index.ts";
import { readImplementStatus } from "../implement/status.ts";
import { NEEDS_VERIFICATION_STATE } from "../linear/index.ts";
import type { MasterAgent } from "../master/agent.ts";
import { HANDOFF } from "../master/types.ts";
import { terminalOf } from "../plan/wait.ts";
import { AWAITING_HUMAN } from "../scheduler/index.ts";

const FOLLOWUP_EVENT = "master.followup_filed";

function handoffInput(agent: MasterAgent, attachRunId?: string): HandoffPhaseInput {
  const { deps, claim, issue } = agent;
  const input: HandoffPhaseInput = {
    db: deps.db,
    linear: deps.linear,
    config: deps.config,
    issue,
    cwd: agent.cwd,
    planPath: claim.planPath as string,
    round: claim.bounces + 1,
    waiter: deps.waiter,
    gh: deps.gh,
    onLaunched: (run) => {
      agent.runId = run.runId;
    },
  };
  if (attachRunId) input.attachRunId = attachRunId;
  return input;
}

function detailsOf(agent: MasterAgent, result: HandoffPhaseResult): string | undefined {
  if (result.ok || !result.runId) return undefined;
  const terminal = terminalOf(agent.deps.db, result.runId);
  return terminal?.kind === "failed" ? terminal.details : undefined;
}

/** Titles already filed for this issue, from the events table, so a bounce never files twice. */
function filedTitles(agent: MasterAgent): Set<string> {
  const rows = agent.deps.db
    .query<{ payload: string | null }, [string, string]>(
      "SELECT payload FROM events WHERE issue_id = ? AND type = ?",
    )
    .all(agent.claim.issueId, FOLLOWUP_EVENT);
  const titles = new Set<string>();
  for (const row of rows) {
    try {
      const title = (JSON.parse(row.payload ?? "{}") as { title?: unknown }).title;
      if (typeof title === "string") titles.add(title);
    } catch {
      // A bad payload only means that title may be filed again.
    }
  }
  return titles;
}

/** Batch-file the follow-ups after the package is posted. One failure never stops the rest. */
export async function fileFollowUps(agent: MasterAgent): Promise<number> {
  const { deps, issue } = agent;
  let status: ReturnType<typeof readImplementStatus> = null;
  try {
    status = readImplementStatus(agent.identifier);
  } catch (err) {
    deps.log.warn("master.followups_unreadable", {
      issueId: issue.id,
      error: (err as Error).message,
    });
    return 0;
  }
  const seen = filedTitles(agent);
  let filed = 0;
  for (const followup of status?.followups ?? []) {
    if (seen.has(followup.title)) continue;
    try {
      const created = await deps.linear.createFollowUp(issue.id, {
        title: followup.title,
        description: followup.body,
      });
      deps.db.run(
        "INSERT INTO events (ts, issue_id, agent_id, type, payload) VALUES (?, ?, ?, ?, ?)",
        [
          agent.now().toISOString(),
          issue.id,
          agent.claim.agentId,
          FOLLOWUP_EVENT,
          JSON.stringify({
            title: followup.title,
            identifier: created.identifier,
            url: created.url,
          }),
        ],
      );
      seen.add(followup.title);
      filed += 1;
    } catch (err) {
      deps.log.error("master.followup_failed", {
        issueId: issue.id,
        title: followup.title,
        error: (err as Error).message,
      });
    }
  }
  return filed;
}

async function finishIssue(agent: MasterAgent, result: Extract<HandoffPhaseResult, { ok: true }>) {
  const { deps, issue } = agent;
  await deps.linear.setState(issue.id, NEEDS_VERIFICATION_STATE);
  const followups = await fileFollowUps(agent);
  agent.patch({ prUrl: result.prUrl });
  agent.transition(AWAITING_HUMAN, { round: result.round });
  agent.emit("finished", {
    prUrl: result.prUrl,
    handoffPath: result.handoffPath,
    round: result.round,
    followups,
  });
  deps.log.info("master.finished", { issueId: issue.id, identifier: issue.identifier });
}

/** True when the issue is in Needs Verification with its package posted; false when blocked. */
export async function runHandoffPhase(
  agent: MasterAgent,
  entry: { kind: "start" | "resume" | "attach" },
): Promise<boolean> {
  if (agent.claim.state !== HANDOFF) agent.transition(HANDOFF);
  const live = entry.kind === "attach" ? agent.runFor("handoff") : null;
  let attachRunId = live && !terminalOf(agent.deps.db, live.runId) ? live.runId : undefined;
  for (;;) {
    if (agent.overBudget()) {
      await agent.blockOverBudget();
      return false;
    }
    const result = await agent.deps.phases.handoff(handoffInput(agent, attachRunId));
    agent.runId = null;
    if (result.ok) {
      await finishIssue(agent, result);
      return true;
    }
    const verdict = await agent.decideRetry(result.reason, result.detail, detailsOf(agent, result));
    if (verdict === "blocked") return false;
    attachRunId = undefined;
  }
}
