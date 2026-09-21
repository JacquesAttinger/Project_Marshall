// Last edited: 2026-09-21 01:00 CDT
// `marshall logs [identifier]`: no argument tails the orchestrator's JSONL log; with an issue it
// finds the newest run in that issue's worktree, prints the transcript path, and hands the terminal
// to `claude logs <jobId>`.

import { existsSync } from "node:fs";
import { migrate, openDb } from "../db/index.ts";
import { dbPath, ensureHome, logPath, transcriptPath } from "../paths.ts";
import { claudeBin } from "../runner/index.ts";
import { latestRunInCwd } from "../runner/store.ts";
import { getClaimByIdentifier } from "../scheduler/index.ts";

/** Run a command with the terminal attached and return its exit code. */
async function inherit(argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export interface LogsOptions {
  identifier?: string;
  /** Injected for tests; the default runs the command with the terminal attached. */
  exec?: (argv: string[]) => Promise<number>;
}

export async function runLogs(opts: LogsOptions = {}): Promise<number> {
  const exec = opts.exec ?? inherit;
  if (!opts.identifier) {
    const path = logPath();
    if (!existsSync(path)) {
      console.error(`marshall logs: ${path} does not exist yet`);
      return 1;
    }
    return exec(["tail", "-n", "50", "-f", path]);
  }
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const claim = getClaimByIdentifier(db, opts.identifier);
    if (!claim?.worktreePath) {
      console.error(`marshall logs: no claim with a worktree for ${opts.identifier}`);
      return 1;
    }
    const run = latestRunInCwd(db, claim.worktreePath);
    if (!run) {
      console.error(
        `marshall logs: no run recorded for ${opts.identifier} in ${claim.worktreePath}`,
      );
      return 1;
    }
    console.log(`run        ${run.runId} (${run.name}, ${run.state})`);
    if (run.sessionId) console.log(`transcript ${transcriptPath(run.cwd, run.sessionId)}`);
    if (!run.jobId) {
      console.error("marshall logs: the run has no daemon job id yet");
      return 1;
    }
    console.log(`job        ${run.jobId}`);
    return exec([claudeBin(), "logs", run.jobId]);
  } finally {
    db.close();
  }
}
