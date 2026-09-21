// Last edited: 2026-09-21 01:10 CDT
// `marshall status [--json]` — config, state dir, schema version, row counts, then the operational
// sections from status-ops.ts: daemon, agents, queue, needs you. The queue needs Linear, so it is
// attempted only when the DB exists and a key is set; everything else works offline.

import { existsSync } from "node:fs";
import { type Config, loadConfig, loadEnv, resolveConfigPath } from "../config.ts";
import { type Counts, counts, openDb, schemaVersion } from "../db/index.ts";
import { connectLinear } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { dbPath, marshallHome } from "../paths.ts";
import { collectQueue, type QueueReport } from "./queue.ts";
import { collectOps, formatOps, type OpsReport } from "./status-ops.ts";

export interface StatusReport {
  configPath: string;
  config: Config;
  marshallHome: string;
  dbPath: string;
  dbExists: boolean;
  schemaVersion: number;
  counts: Counts;
}

export function collectStatus(configPath?: string): StatusReport {
  const resolved = resolveConfigPath(configPath);
  const config = loadConfig(resolved);
  const path = dbPath();
  const dbExists = existsSync(path);
  let version = 0;
  let rows: Counts = { claims: 0, starts: 0, events: 0, runs: 0 };
  if (dbExists) {
    // Open read-only-ish: no migrate, no ensureHome. Status never changes state.
    const db = openDb(path);
    try {
      version = schemaVersion(db);
      rows = counts(db);
    } finally {
      db.close();
    }
  }
  return {
    configPath: resolved,
    config,
    marshallHome: marshallHome(),
    dbPath: path,
    dbExists,
    schemaVersion: version,
    counts: rows,
  };
}

function table(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

export function formatStatus(report: StatusReport): string {
  const configRows = Object.entries(report.config).map(
    ([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string],
  );
  const sections = [
    `Config (${report.configPath})`,
    table(configRows),
    "",
    "State",
    table([
      ["MARSHALL_HOME", report.marshallHome],
      [
        "db",
        `${report.dbPath}${report.dbExists ? "" : " (not created; run `marshall db migrate`)"}`,
      ],
      ["schema version", String(report.schemaVersion)],
      ["claims", String(report.counts.claims)],
      ["starts", String(report.counts.starts)],
      ["events", String(report.counts.events)],
      ["runs", String(report.counts.runs)],
    ]),
  ];
  return sections.join("\n");
}

export interface StatusOptions {
  json: boolean;
  configPath?: string;
}

/** The queue dry run over a live Linear connection, or the reason it cannot run. */
function queueSource(
  db: ReturnType<typeof openDb>,
  config: Config,
  now: () => Date,
): { queue?: () => Promise<QueueReport>; queueError?: string } {
  const apiKey = loadEnv().MARSHALL_LINEAR_API_KEY;
  if (!apiKey) return { queueError: "MARSHALL_LINEAR_API_KEY is not set" };
  return {
    queue: async () => {
      const log = createLogger({ command: "status" });
      const linear = await connectLinear({
        apiKey,
        teamId: config.teamId,
        workspace: config.workspace,
        log,
      });
      return collectQueue({ db, config, linear, now });
    },
  };
}

/** The operational sections, or null before the DB exists (nothing can be running). */
export async function collectStatusOps(report: StatusReport): Promise<OpsReport | null> {
  if (!report.dbExists) return null;
  const db = openDb(report.dbPath);
  try {
    const now = () => new Date();
    return await collectOps({
      db,
      config: report.config,
      now,
      ...queueSource(db, report.config, now),
    });
  } finally {
    db.close();
  }
}

export async function runStatus(opts: StatusOptions): Promise<void> {
  const report = collectStatus(opts.configPath);
  const ops = await collectStatusOps(report);
  if (opts.json) {
    console.log(JSON.stringify({ ...report, ops }, null, 2));
    return;
  }
  const text = formatStatus(report);
  console.log(ops ? `${text}\n\n${formatOps(ops)}` : text);
}
