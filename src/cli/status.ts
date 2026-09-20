// Last edited: 2026-09-20 10:56 CDT
// `marshall status [--json]` — config, state dir, schema version, and row counts.

import { existsSync } from "node:fs";
import { type Config, loadConfig, resolveConfigPath } from "../config.ts";
import { type Counts, counts, openDb, schemaVersion } from "../db/index.ts";
import { dbPath, marshallHome } from "../paths.ts";

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

export function runStatus(opts: StatusOptions): void {
  const report = collectStatus(opts.configPath);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatStatus(report));
}
