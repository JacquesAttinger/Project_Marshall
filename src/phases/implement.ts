// Last edited: 2026-09-21 00:05 CDT
// The implement + review phase: launch `/marshall:implement`, wait for its Stop, and read the
// outcome from implement.json. This is where the spec's limits live: a stall (killed by the
// pulse) resumes the session up to `maxResumes`, then one fresh restart from the plan commit;
// a rate limit pauses the queue and probes by resuming; the 2-hour clock ends everything.

import { implementModel } from "../config.ts";
import { implementStatusPath } from "../implement/status.ts";
import { implementEnv } from "../isolation.ts";
import type { MasterAgent } from "../master/agent.ts";
import { discardImplementWork } from "../master/git.ts";
import { IMPLEMENTING, OVER_BUDGET, STALLED } from "../master/types.ts";
import { PLUGIN_DIR } from "../plan/index.ts";
import { terminalOf } from "../plan/wait.ts";
import { getRun, type Run, type Terminal } from "../runner/index.ts";
import { bumpFreshRestarts, bumpResumes } from "../scheduler/index.ts";
import { IMPLEMENT_RESUME_PROMPT, implementPrompt, runName } from "./names.ts";
import { prepareBounceStatus, readImplementOutcome } from "./status.ts";

/** Outcomes the skill reports honestly; none of them gets a retry. */
const GIVE_UP_COMMENTS: Record<string, string> = {
  review_exhausted: "The review loop ran out of cycles with blocking findings still open",
  tests_red: "The local gate stayed red",
  blocked: "The implementer hit something it could not get past",
};

function launchOpts(agent: MasterAgent) {
  const { deps, claim, issue } = agent;
  return {
    name: runName(agent.identifier, "implement"),
    cwd: agent.cwd,
    effort: "high" as const,
    extraArgs: ["--plugin-dir", PLUGIN_DIR],
    env: implementEnv(agent.identifier, issue.url, claim.slot, deps.config),
    statusFile: implementStatusPath(agent.identifier),
  };
}

async function launchFresh(agent: MasterAgent): Promise<Run> {
  const planPath = agent.claim.planPath as string;
  return agent.deps.runner.launch(agent.deps.db, {
    ...launchOpts(agent),
    model: implementModel(agent.deps.config),
    prompt: implementPrompt(planPath, agent.identifier),
  });
}

/** Continue the session of `run` when it has one; else a fresh launch that resumes via the file. */
async function continueRun(agent: MasterAgent, run: Run): Promise<Run> {
  const sessionId = getRun(agent.deps.db, run.runId)?.sessionId;
  if (!sessionId) return launchFresh(agent);
  return agent.deps.runner.resume(agent.deps.db, {
    ...launchOpts(agent),
    sessionId,
    prompt: IMPLEMENT_RESUME_PROMPT,
  });
}

/**
 * The first run of the phase, for the three ways in. Attach waits on the newest run: alive, or
 * ended while the orchestrator was down (the waiter then answers from the row). Resume means
 * reconcile found no live process and counted a resume: a run that had already stopped on its
 * own is read like an attach; otherwise the row is made to agree and the session continues.
 */
async function enter(agent: MasterAgent, entry: { kind: string }): Promise<Run> {
  if (entry.kind === "start") {
    if (agent.claim.bounces > 0) prepareBounceStatus(agent.identifier);
    return launchFresh(agent);
  }
  const existing = agent.runFor("implement");
  if (!existing) return launchFresh(agent);
  const ended = terminalOf(agent.deps.db, existing.runId);
  if (entry.kind === "attach" || ended?.kind === "finished") return existing;
  if (!ended) await agent.deps.runner.kill(agent.deps.db, existing.runId);
  agent.emit("resumed", { runId: existing.runId, resumes: agent.claim.resumes, how: "boot" });
  return continueRun(agent, existing);
}

/** A stall or a crash: resume while the budget lasts, else one fresh restart, else null. */
async function recover(agent: MasterAgent, run: Run, why: string): Promise<Run | null> {
  const { deps, claim } = agent;
  if (claim.resumes < deps.config.maxResumes) {
    agent.claim = bumpResumes(deps.db, claim.issueId, agent.now().toISOString());
    agent.emit("resumed", { runId: run.runId, resumes: agent.claim.resumes, why });
    return continueRun(agent, run);
  }
  if (!agent.canFreshRestart()) return null;
  const target = await discardImplementWork({
    git: deps.git,
    cwd: agent.cwd,
    identifier: agent.identifier,
    planPath: claim.planPath as string,
  });
  agent.patch({ prUrl: null });
  agent.claim = bumpFreshRestarts(deps.db, claim.issueId, agent.now().toISOString());
  agent.emit("fresh_restart", { phase: IMPLEMENTING, why, resetTo: target });
  return launchFresh(agent);
}

/** The run stopped on its own: read implement.json. True = PR green; false = blocked. */
async function finished(agent: MasterAgent): Promise<boolean | "retry"> {
  const read = readImplementOutcome(agent.identifier);
  if (!read.ok) return "retry";
  const { status, outcome } = read;
  agent.patch({ prUrl: status.prUrl });
  if (outcome === "pr_green") return true;
  const because = GIVE_UP_COMMENTS[outcome] ?? outcome;
  const detail = status.reason ? `: ${status.reason}` : "";
  const pr = status.prUrl ? ` Draft PR: ${status.prUrl}.` : "";
  await agent.block(outcome, `${because}${detail}.${pr}`);
  return false;
}

async function afterFailure(agent: MasterAgent, run: Run, terminal: Terminal): Promise<Run | null> {
  const error = terminal.kind === "failed" ? terminal.error : "no_outcome";
  const details = terminal.kind === "failed" ? terminal.details : undefined;
  if (error === "rate_limit") {
    await agent.pauseForRateLimit(details);
    if (agent.cutByClock()) return null;
    // The probe: continue the same session; a second rate limit re-pauses without a resume.
    return continueRun(agent, run);
  }
  if (error === OVER_BUDGET) return null;
  return recover(agent, run, error === STALLED ? STALLED : error);
}

/** True when the PR is green and stored on the claim; false when the issue is blocked. */
export async function runImplementPhase(
  agent: MasterAgent,
  entry: { kind: "start" | "resume" | "attach" },
): Promise<boolean> {
  if (agent.claim.state !== IMPLEMENTING) agent.transition(IMPLEMENTING);
  if (agent.overBudget()) return agent.blockOverBudget().then(() => false);
  let run = await enter(agent, entry);
  for (;;) {
    const terminal = await agent.waitRun(run.runId);
    if (!terminal) {
      await agent.deps.runner.kill(agent.deps.db, run.runId);
      await agent.blockOverBudget();
      return false;
    }
    if (terminal.kind === "finished") {
      const outcome = await finished(agent);
      if (outcome !== "retry") return outcome;
    }
    const next = await afterFailure(agent, run, terminal);
    if (!next) {
      if (agent.cutByClock() || agent.overBudget()) await agent.blockOverBudget();
      else if (!agent.done) {
        await agent.block(
          "exhausted",
          `The implement phase stalled or crashed ${agent.claim.resumes} times and a fresh restart was not possible.`,
        );
      }
      return false;
    }
    run = next;
  }
}
