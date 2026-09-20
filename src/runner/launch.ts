// Last edited: 2026-09-20 10:50 CDT
// launch / resume / kill around `claude --bg`. The run id is minted before the spawn because the
// hook command (which names the events file) must exist before the daemon's job id does.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { createLogger } from "../log.ts";
import { ensureHome } from "../paths.ts";
import { runClaude } from "./claude.ts";
import { stopJob } from "./events.ts";
import { buildAgentSettings } from "./settings.ts";
import { getRun, insertRun, isTerminal, updateRun } from "./store.ts";
import { type LaunchOpts, type ResumeOpts, type Run, RunnerError } from "./types.ts";

const log = createLogger({ module: "runner" });

/** `<name>-<8 hex>`, with the name reduced to a filesystem-safe slug. */
export function mintRunId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "run";
  return `${slug}-${randomBytes(4).toString("hex")}`;
}

/** The first 8-hex-digit token in `claude --bg`'s stdout is the job id. */
export function parseJobId(stdout: string): string | null {
  return /\b[0-9a-f]{8}\b/.exec(stdout)?.[0] ?? null;
}

interface ArgvOpts extends Omit<LaunchOpts, "model"> {
  model?: string;
  resumeSessionId?: string;
}

/** Build the exact argv for one run. Documented in docs/runner.md; the tests assert on it. */
export function buildArgv(runId: string, opts: ArgvOpts): string[] {
  const argv = ["--bg", "--name", opts.name];
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  argv.push(
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--settings",
    buildAgentSettings(runId),
  );
  if (opts.systemPromptAppend) argv.push("--append-system-prompt", opts.systemPromptAppend);
  if (opts.maxBudgetUsd !== undefined) argv.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.extraArgs) argv.push(...opts.extraArgs);
  argv.push(opts.prompt);
  return argv;
}

async function spawn(db: Database, runId: string, opts: ArgvOpts): Promise<Run> {
  const argv = buildArgv(runId, opts);
  let stdout: string;
  try {
    stdout = await runClaude(argv, { cwd: opts.cwd });
  } catch (err) {
    updateRun(db, runId, { state: "failed", error: "launch_failed" });
    log.error("run.launch_failed", { runId, error: (err as Error).message });
    throw err;
  }
  const jobId = parseJobId(stdout);
  if (!jobId) {
    updateRun(db, runId, { state: "failed", error: "no_job_id" });
    throw new RunnerError(`claude --bg printed no job id: ${stdout.trim().slice(0, 200)}`);
  }
  const run = updateRun(db, runId, { jobId, state: "running" });
  log.info("run.launched", { runId, jobId, name: opts.name, cwd: opts.cwd, model: opts.model });
  return run;
}

/** Start a new background session. Resolves once the daemon has printed the job id. */
export async function launch(db: Database, opts: LaunchOpts): Promise<Run> {
  ensureHome();
  const runId = opts.runId ?? mintRunId(opts.name);
  insertRun(db, { runId, name: opts.name, cwd: opts.cwd });
  return spawn(db, runId, opts);
}

/**
 * Continue a stopped session in the background under a fresh run id. The caller supplies the
 * nudge prompt. `resumedFrom` records the old session; the daemon forks the conversation into a
 * new session id (and job id), which the SessionStart hook reveals.
 */
export async function resume(db: Database, opts: ResumeOpts): Promise<Run> {
  if (!opts.sessionId) throw new RunnerError("resume needs a sessionId");
  ensureHome();
  const runId = mintRunId(opts.name);
  insertRun(db, { runId, name: opts.name, cwd: opts.cwd, resumedFrom: opts.sessionId });
  return spawn(db, runId, { ...opts, resumeSessionId: opts.sessionId });
}

/** `claude stop <jobId>` and mark the run killed. A run without a job id is just marked. */
export async function kill(db: Database, runId: string): Promise<Run> {
  const run = getRun(db, runId);
  if (!run) throw new RunnerError(`Unknown run ${runId}`);
  if (isTerminal(run.state)) return run;
  if (run.jobId) await stopJob(run.jobId);
  const updated = updateRun(db, runId, {
    state: "killed",
    finishedAt: new Date().toISOString(),
  });
  log.info("run.killed", { runId, jobId: run.jobId });
  return updated;
}
