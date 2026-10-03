// Last edited: 2026-10-03 18:27 CDT
// `marshall dashboard` — serve the dashboard on 127.0.0.1:<dashboardPort> until SIGINT or SIGTERM.
// Its own process and launchd job, so the page stays up (and says "daemon down") when the daemon
// stops. It never migrates the DB and works without a Linear key (the queue then says why).

import { loadConfig, loadEnv } from "../config.ts";
import { createDashboardContext } from "../dashboard/context.ts";
import { startDashboard } from "../dashboard/server.ts";
import { createLogger } from "../log.ts";
import { untilSignal } from "./run.ts";

export interface DashboardOptions {
  configPath?: string;
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const log = createLogger({ command: "dashboard" });
  const context = createDashboardContext({
    config,
    apiKey: loadEnv().MARSHALL_LINEAR_API_KEY,
    log,
  });
  const server = startDashboard({
    port: config.dashboardPort,
    context,
    workspace: config.workspace,
    log,
  });
  const url = `http://127.0.0.1:${server.port}`;
  log.info("dashboard.started", { url });
  console.log(`marshall: dashboard on ${url} (Ctrl-C to stop)`);
  const signal = await untilSignal();
  log.info("dashboard.stopping", { signal });
  await server.stop(true);
  context.close();
}
