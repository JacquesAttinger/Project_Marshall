// Last edited: 2026-09-21 01:00 CDT
// `marshall kill <identifier>`: stop one issue's agent and park the issue in Blocked. With a live
// orchestrator (pidfile), write the kill flag and let its pulse do the work in-process: no race
// with a master agent that is mid-transition. Without one, do it here: kill the runs in the
// claim's worktree and block the issue through the same `blockIssue` the master agent uses.

import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { KILLED, killFlag } from "../master/types.ts";
import { dbPath, ensureHome } from "../paths.ts";
import { liveOrchestrator } from "../pidfile.ts";
import { kill, listActiveRuns } from "../runner/index.ts";
import { type Claim, getClaimByIdentifier, isLive } from "../scheduler/index.ts";
import { getFlag, setFlag } from "../scheduler/store.ts";
import { blockIssue } from "../scheduler/tick.ts";

export interface KillOptions {
  identifier: string;
  configPath?: string;
  now?: () => Date;
}

/** Stop every non-terminal run in the claim's worktree. Returns the run ids it killed. */
async function killRuns(db: ReturnType<typeof openDb>, claim: Claim): Promise<string[]> {
  const killed: string[] = [];
  for (const run of listActiveRuns(db).filter((r) => r.cwd === claim.worktreePath)) {
    await kill(db, run.runId);
    killed.push(run.runId);
  }
  return killed;
}

export async function runKill(opts: KillOptions): Promise<number> {
  const now = opts.now ?? (() => new Date());
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const claim = getClaimByIdentifier(db, opts.identifier);
    if (!claim) {
      console.error(`marshall kill: no claim for ${opts.identifier}`);
      return 1;
    }
    if (!isLive(claim)) {
      console.error(`marshall kill: ${opts.identifier} is not running (state: ${claim.state})`);
      return 1;
    }
    const orchestrator = liveOrchestrator();
    if (orchestrator) {
      if (getFlag(db, killFlag(claim.issueId))) {
        console.log(`marshall: kill of ${opts.identifier} already requested; waiting on the pulse`);
        return 0;
      }
      setFlag(db, killFlag(claim.issueId), now().toISOString());
      console.log(
        `marshall: kill requested for ${opts.identifier} (${claim.state}). The orchestrator (pid ${orchestrator.pid}) stops it on its next pulse and marks it Blocked.`,
      );
      return 0;
    }
    // No orchestrator: nothing else will act, so do it here, Linear included.
    const config = loadConfig(opts.configPath);
    const apiKey = requireLinearApiKey(loadEnv());
    const log = createLogger({ command: "kill" });
    const linear = await connectLinear({
      apiKey,
      teamId: config.teamId,
      workspace: config.workspace,
      log,
    });
    const killed = await killRuns(db, claim);
    await blockIssue(
      { db, linear, log, now },
      { id: claim.issueId, identifier: opts.identifier },
      claim,
      KILLED,
      "Marshall stopped this issue on request (`marshall kill`) while no orchestrator was running. Move it back to Todo to give it another run.",
      "master.blocked",
    );
    console.log(
      `marshall: ${opts.identifier} killed directly (no orchestrator running): ${killed.length} run(s) stopped, issue Blocked.`,
    );
    return 0;
  } finally {
    db.close();
  }
}
