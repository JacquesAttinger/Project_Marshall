// Last edited: 2026-10-03 18:36 CDT
// `marshall kill <identifier>`: a thin wrapper over `requestKill` (src/kill.ts), which the
// dashboard's Kill button calls too. This file opens the DB, connects to Linear only when the
// direct path needs it, and prints the result.

import { loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { killMessage, killSucceeded, requestKill } from "../kill.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { dbPath, ensureHome } from "../paths.ts";

export interface KillOptions {
  identifier: string;
  configPath?: string;
  now?: () => Date;
}

export async function runKill(opts: KillOptions): Promise<number> {
  const now = opts.now ?? (() => new Date());
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const log = createLogger({ command: "kill" });
    const result = await requestKill(
      {
        db,
        log,
        now,
        linear: () => {
          const config = loadConfig(opts.configPath);
          const apiKey = requireLinearApiKey(loadEnv());
          return connectLinear({
            apiKey,
            teamId: config.teamId,
            workspace: config.workspace,
            log,
          });
        },
      },
      opts.identifier,
    );
    if (!killSucceeded(result)) {
      console.error(`marshall kill: ${killMessage(result)}`);
      return 1;
    }
    console.log(`marshall: ${killMessage(result)}`);
    return 0;
  } finally {
    db.close();
  }
}
