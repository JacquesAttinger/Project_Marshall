// Last edited: 2026-09-20 12:45 CDT
// `marshall plan <identifier> --cwd <worktree> [--revise] [--json]` runs the planning phase by hand
// on an issue, in a worktree the caller already made. `marshall plan check <file>` is the heading
// check alone. Both exist for the recorded example run and for manual tests; step 08 calls the API.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { dbPath, ensureHome, expandTilde } from "../paths.ts";
import {
  checkPlanFile,
  createRunWaiter,
  type PlanPhaseResult,
  runPlanPhase,
} from "../plan/index.ts";

export interface PlanOptions {
  identifier: string;
  cwd?: string;
  revise: boolean;
  json: boolean;
  configPath?: string;
}

export function formatPlanResult(result: PlanPhaseResult): string {
  if (result.ok) {
    const how = result.classification
      ? `${result.classification.complexity} (${result.classification.reason})`
      : "given";
    return [
      `Plan written: ${result.planPath}`,
      `Run: ${result.runId}`,
      `Brief: ${result.briefPath}`,
      `Model: ${result.model}, complexity ${how}`,
      "Linear comment posted.",
    ].join("\n");
  }
  return [
    `Plan failed: ${result.reason}`,
    `Detail: ${result.detail}`,
    ...(result.runId ? [`Run: ${result.runId}`] : []),
    ...(result.briefPath ? [`Brief: ${result.briefPath}`] : []),
  ].join("\n");
}

/** Exit code 0 when the plan landed, 1 otherwise. */
export async function runPlan(opts: PlanOptions): Promise<number> {
  if (!opts.cwd) throw new Error("plan needs --cwd <worktree>");
  const cwd = resolve(expandTilde(opts.cwd));
  if (!existsSync(cwd)) throw new Error(`--cwd does not exist: ${cwd}`);
  const config = loadConfig(opts.configPath);
  const apiKey = requireLinearApiKey(loadEnv());
  const log = createLogger({ command: "plan", issue: opts.identifier });
  const linear = await connectLinear({
    apiKey,
    teamId: config.teamId,
    workspace: config.workspace,
    log,
  });
  const issue = await linear.getIssue(opts.identifier);
  ensureHome();
  const db = openDb(dbPath());
  migrate(db);
  const waiter = createRunWaiter(db);
  try {
    const result = await runPlanPhase({
      db,
      linear,
      config,
      issue,
      cwd,
      mode: opts.revise ? "revise" : "fresh",
      waiter,
      onLaunched: (run) => {
        if (!opts.json) console.log(`Launched ${run.runId} (job ${run.jobId}) in ${cwd}`);
      },
    });
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatPlanResult(result));
    return result.ok ? 0 : 1;
  } finally {
    waiter.stop();
    db.close();
  }
}

/** `marshall plan check <file>`: exit 0 when every required section is present and in order. */
export function runPlanCheck(file: string, json: boolean): number {
  const path = resolve(expandTilde(file));
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const check = checkPlanFile(path);
  if (json) {
    console.log(JSON.stringify({ path, ...check }, null, 2));
  } else if (check.ok) {
    console.log(`OK: ${path} has every required section in order`);
  } else {
    for (const s of check.missing) console.log(`missing: ${s}`);
    for (const s of check.misordered) console.log(`out of order: ${s}`);
  }
  return check.ok ? 0 : 1;
}
