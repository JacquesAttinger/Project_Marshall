// Last edited: 2026-09-20 12:45 CDT
// Dev launcher for one `/marshall:implement` run, until step 08's orchestrator exists.
//
//   bun scripts/launch-implement.ts --cwd <worktree> --plan docs/x_plan.md --issue CB-12 --slot 0
//     [--issue-url <url>] [--model opus] [--effort high] [--max-budget-usd <n>] [--watch]
//
// Prints the run id and job id. With --watch it stays up, ingests the run's hook events, stops the
// session when its turn ends, and exits with the run's terminal state.

import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { implementStatusPath } from "../src/implement/status.ts";
import { implementEnv } from "../src/isolation.ts";
import { ensureHome } from "../src/paths.ts";
import {
  type Effort,
  getRun,
  isTerminal,
  launch,
  startWatcher,
  type Watcher,
} from "../src/runner/index.ts";

const PLUGIN_DIR = resolve(import.meta.dir, "..", "plugin");

interface Args {
  cwd: string;
  plan: string;
  issue: string;
  slot: number;
  issueUrl?: string;
  model: string;
  effort: Effort;
  maxBudgetUsd?: number;
  watch: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: bun scripts/launch-implement.ts --cwd <worktree> --plan <path> --issue <ID> --slot <n>" +
      " [--issue-url <url>] [--model opus] [--effort high] [--max-budget-usd <n>] [--watch]",
  );
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  let watch = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--watch") watch = true;
    else if (a.startsWith("--")) {
      const next = argv[++i];
      if (next === undefined) usage(`${a} needs a value`);
      values[a.slice(2)] = next;
    } else usage(`Unexpected argument: ${a}`);
  }
  for (const key of ["cwd", "plan", "issue", "slot"]) {
    if (!values[key]) usage(`--${key} is required`);
  }
  const slot = Number(values.slot);
  if (!Number.isInteger(slot)) usage("--slot must be an integer");
  return {
    cwd: resolve(values.cwd as string),
    plan: values.plan as string,
    issue: values.issue as string,
    slot,
    issueUrl: values["issue-url"],
    model: values.model ?? "opus",
    effort: (values.effort ?? "high") as Effort,
    maxBudgetUsd: values["max-budget-usd"] ? Number(values["max-budget-usd"]) : undefined,
    watch,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const issueUrl = args.issueUrl ?? `https://linear.app/${config.workspace}/issue/${args.issue}`;
  ensureHome();
  const db = openDb();
  migrate(db);
  const env = implementEnv(args.issue, issueUrl, args.slot, config);
  const run = await launch(db, {
    name: args.issue,
    cwd: args.cwd,
    prompt: `/marshall:implement ${args.plan} ${args.issue}`,
    model: args.model,
    effort: args.effort,
    maxBudgetUsd: args.maxBudgetUsd,
    extraArgs: ["--plugin-dir", PLUGIN_DIR],
    env,
    statusFile: implementStatusPath(args.issue),
  });
  console.log(`run ${run.runId} job ${run.jobId} slot ${args.slot} cwd ${args.cwd}`);
  console.log(`status file: ${env.MARSHALL_ISSUE_DIR}/implement.json`);
  if (!args.watch) {
    db.close();
    return;
  }
  await watchUntilTerminal(db, run.runId);
  db.close();
}

/** Ingest events until this run ends, then stop the watcher and let its queue drain. */
async function watchUntilTerminal(db: Database, runId: string): Promise<void> {
  let poll: ReturnType<typeof setInterval> | null = null;
  let watcher: Watcher | null = null;
  await new Promise<void>((done) => {
    watcher = startWatcher(db, (finished, _event, terminal) => {
      if (finished.runId !== runId) return;
      const detail = "error" in terminal ? `: ${terminal.error}` : "";
      console.log(`run ${runId} ${terminal.kind}${detail}`);
      done();
    });
    poll = setInterval(() => {
      const current = getRun(db, runId);
      if (current && isTerminal(current.state)) done();
    }, 5000);
  });
  if (poll) clearInterval(poll);
  if (watcher) {
    (watcher as Watcher).stop();
    // The terminal callback runs inside the watcher's queue; wait for that pass to finish.
    await (watcher as Watcher).scan();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
