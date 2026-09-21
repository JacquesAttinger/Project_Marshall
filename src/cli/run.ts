// Last edited: 2026-09-21 01:20 CDT
// `marshall run [--once]` — the orchestrator: reconcile, then loop with the real master agent
// hooks until SIGINT or SIGTERM. `--once` does one reconcile + tick + pulse + notify tick and
// exits, for a manual check. launchd runs this command (scripts/launchd/); it rotates the logs
// once at start, writes the pidfile `marshall kill` and `status` read, and ticks the ntfy tailer.

import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger, rotateLog } from "../log.ts";
import { createMasterAgentHooks, defaultMasterDeps } from "../master-agent.ts";
import { createNotifier } from "../notify.ts";
import { dbPath, ensureHome, launchdLogPaths, logPath } from "../paths.ts";
import { removePidfile, writePidfile } from "../pidfile.ts";
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

/** How often the ntfy tailer reads new events. */
export const NOTIFY_INTERVAL_MS = 10_000;

/** Rotate the orchestrator log and launchd's two. Before the logger's first line of this run. */
export function rotateLogs(): string[] {
  const { out, err } = launchdLogPaths();
  return [logPath(), out, err].filter((path) => rotateLog(path));
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
  const env = loadEnv();
  const apiKey = requireLinearApiKey(env);
  ensureHome();
  const rotated = opts.once ? [] : rotateLogs();
  const log = createLogger({ command: "run" });
  if (rotated.length > 0) log.info("run.logs_rotated", { rotated });
  const linear = await connectLinear({
    apiKey,
    teamId: config.teamId,
    workspace: config.workspace,
    log,
  });
  const db = openDb(dbPath());
  const waiter = createRunWaiter(db);
  const notifier = createNotifier({ db, env, workspace: config.workspace, log });
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
      const pushed = await notifier.tick();
      console.log(JSON.stringify({ reconcile: decisions, tick: result, pushed }, null, 2));
      return;
    }
    writePidfile(now());
    const loop = startLoop(deps);
    await loop.ready;
    notifier.start(NOTIFY_INTERVAL_MS);
    log.info("run.started", {
      pollSeconds: config.pollSeconds,
      maxAgents: config.maxAgents,
      notify: notifier.enabled,
    });
    console.log(`marshall: running (poll every ${config.pollSeconds} s, Ctrl-C to stop)`);
    const signal = await untilSignal();
    loop.stop();
    log.info("run.stopping", { signal, liveAgents: hooks.agents.size });
    console.log(
      `marshall: ${signal}, stopping. Live agents keep their jobs; reconcile picks them up.`,
    );
  } finally {
    notifier.stop();
    waiter.stop();
    if (!opts.once) removePidfile();
    db.close();
  }
}
