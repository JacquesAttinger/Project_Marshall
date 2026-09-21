// Last edited: 2026-09-21 02:45 CDT
// `marshall run [--once]` — the orchestrator: reconcile, then loop with the real master agent
// hooks until SIGINT or SIGTERM. `--once` does one reconcile + tick + pulse and exits, for a
// manual check. launchd wiring around this command is step 09.

import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { createMasterAgentHooks, defaultMasterDeps } from "../master-agent.ts";
import { dbPath, ensureHome } from "../paths.ts";
import { createRunWaiter } from "../plan/index.ts";
import {
  reconcile,
  runnerLiveness,
  type SchedulerDeps,
  startLoop,
  tick,
} from "../scheduler/index.ts";
import { gitWorktrees } from "../worktree.ts";

export interface RunOptions {
  once: boolean;
  configPath?: string;
}

/** Resolves on the first SIGINT or SIGTERM. */
function untilSignal(): Promise<string> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => resolve(signal));
    }
  });
}

export async function runLoop(opts: RunOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const apiKey = requireLinearApiKey(loadEnv());
  const log = createLogger({ command: "run" });
  const linear = await connectLinear({
    apiKey,
    teamId: config.teamId,
    workspace: config.workspace,
    log,
  });
  ensureHome();
  const db = openDb(dbPath());
  const waiter = createRunWaiter(db);
  try {
    migrate(db);
    const now = () => new Date();
    const hooks = createMasterAgentHooks(
      defaultMasterDeps({ db, config, linear, log, now, waiter }),
    );
    const deps: SchedulerDeps = {
      db,
      config,
      linear,
      runner: runnerLiveness(db),
      hooks,
      worktrees: gitWorktrees,
      log,
      now,
    };
    if (opts.once) {
      const decisions = await reconcile(deps);
      await hooks.pulse();
      const result = await tick(deps);
      console.log(JSON.stringify({ reconcile: decisions, tick: result }, null, 2));
      return;
    }
    const loop = startLoop(deps);
    await loop.ready;
    log.info("run.started", { pollSeconds: config.pollSeconds, maxAgents: config.maxAgents });
    console.log(`marshall: running (poll every ${config.pollSeconds} s, Ctrl-C to stop)`);
    const signal = await untilSignal();
    loop.stop();
    log.info("run.stopping", { signal, liveAgents: hooks.agents.size });
    console.log(
      `marshall: ${signal}, stopping. Live agents keep their jobs; reconcile picks them up.`,
    );
  } finally {
    waiter.stop();
    db.close();
  }
}
