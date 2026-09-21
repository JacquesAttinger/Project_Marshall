// Last edited: 2026-09-21 00:10 CDT
// `marshall queue [--json]` — a dry run of one scheduler tick. Prints the ordered pickable list and,
// for each issue, what the next tick would do with it and why. Reads Linear and the DB; writes nothing.

import type { Database } from "bun:sqlite";
import { type CapCounts, countsAfterStart, evaluateCaps, readCapCounts } from "../caps.ts";
import { type Config, loadConfig, loadEnv, requireLinearApiKey } from "../config.ts";
import { migrate, openDb } from "../db/index.ts";
import { connectLinear, type LinearClient, type PickableIssue } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { dbPath, ensureHome } from "../paths.ts";
import { BLOCKED, getClaim, isLive, liveClaims, orderIssues } from "../scheduler/index.ts";

export type QueueKind = "fresh" | "bounce" | "live" | "blocked";

export interface QueueRow {
  identifier: string;
  title: string;
  priority: number;
  createdAt: string;
  kind: QueueKind;
  bounces: number;
  wouldStart: boolean;
  slot: number | null;
  /** Why it would not start, or a note on why it would. */
  reasons: string[];
}

export interface QueueReport {
  now: string;
  pausedUntil: string | null;
  pausedAt: string | null;
  counts: CapCounts;
  caps: Pick<Config, "maxAgents" | "dailyStartCap" | "windowStartCap" | "windowHours">;
  rows: QueueRow[];
}

export interface QueueDeps {
  db: Database;
  config: Config;
  linear: LinearClient;
  now: () => Date;
}

/** Walk the ordered list the way `tick` would, bumping a simulated count per start. */
export async function collectQueue(deps: QueueDeps): Promise<QueueReport> {
  const { db, config } = deps;
  const now = deps.now();
  let counts = readCapCounts(db, config, now);
  const initial = counts;
  const taken = new Set(liveClaims(db).map((c) => c.slot));
  const rows: QueueRow[] = [];
  for (const issue of orderIssues(await deps.linear.listPickable())) {
    const row = rowFor(issue, db, config, counts);
    if (row.wouldStart) {
      row.slot = lowestFree(taken, config.maxAgents);
      if (row.slot !== null) taken.add(row.slot);
      counts = countsAfterStart(counts, { firstStart: row.kind === "fresh" }, now, config);
    }
    rows.push(row);
  }
  return {
    now: now.toISOString(),
    pausedUntil: initial.pausedUntil,
    pausedAt: initial.pausedAt,
    counts: initial,
    caps: {
      maxAgents: config.maxAgents,
      dailyStartCap: config.dailyStartCap,
      windowStartCap: config.windowStartCap,
      windowHours: config.windowHours,
    },
    rows,
  };
}

function lowestFree(taken: Set<number>, maxAgents: number): number | null {
  for (let slot = 0; slot < maxAgents; slot++) if (!taken.has(slot)) return slot;
  return null;
}

function rowFor(issue: PickableIssue, db: Database, config: Config, counts: CapCounts): QueueRow {
  const base = {
    identifier: issue.identifier,
    title: issue.title,
    priority: issue.priority,
    createdAt: issue.createdAt,
    slot: null,
  };
  const existing = getClaim(db, issue.id);
  if (existing && isLive(existing)) {
    return {
      ...base,
      kind: "live",
      bounces: existing.bounces,
      wouldStart: false,
      reasons: [`claim row is still live (${existing.state}); step 08 must release it first`],
    };
  }
  const unblocked = existing?.state === BLOCKED;
  const bounces = unblocked ? 0 : (existing?.bounces ?? 0);
  const bounce = Boolean(existing?.branch);
  if (existing && bounce && bounces >= config.maxBounces) {
    return {
      ...base,
      kind: "blocked",
      bounces,
      wouldStart: false,
      reasons: [`bounce limit: ${bounces} of ${config.maxBounces}; the next tick marks it Blocked`],
    };
  }
  const check = evaluateCaps(counts, config, { firstStart: !bounce });
  const notes = unblocked ? ["moved out of Blocked by a human: bounce budget resets"] : [];
  return {
    ...base,
    kind: bounce ? "bounce" : "fresh",
    bounces,
    wouldStart: check.ok,
    reasons: check.ok ? notes : [...notes, ...check.reasons],
  };
}

const PRIORITY_NAMES: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function column(rows: string[][], widths: number[]): string[] {
  return rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

export function formatQueue(report: QueueReport): string {
  const { counts, caps } = report;
  const window = `last ${caps.windowHours} h ${counts.window}/${caps.windowStartCap}`;
  const frees = counts.windowFreesAt ? ` (next window slot at ${counts.windowFreesAt})` : "";
  const head = [
    `Now ${report.now}`,
    ...(report.pausedAt
      ? [`PAUSED by \`marshall pause\` at ${report.pausedAt} (marshall resume)`]
      : []),
    ...(report.pausedUntil ? [`PAUSED until ${report.pausedUntil}`] : []),
    `Agents ${counts.live}/${caps.maxAgents} busy · starts today ${counts.today}/${caps.dailyStartCap} · ${window}${frees}`,
    "",
  ];
  if (report.rows.length === 0) return [...head, "Nothing pickable."].join("\n");
  const table = [
    ["#", "Issue", "Priority", "Created", "Kind", "Next tick", "Why"],
    ...report.rows.map((r, i) => [
      String(i + 1),
      r.identifier,
      PRIORITY_NAMES[r.priority] ?? String(r.priority),
      r.createdAt.slice(0, 10),
      r.kind === "bounce" ? `bounce #${r.bounces + 1}` : r.kind,
      r.wouldStart ? `start${r.slot === null ? "" : ` (slot ${r.slot})`}` : "wait",
      r.reasons.join("; "),
    ]),
  ];
  const widths = table[0]?.map((_, i) => Math.max(...table.map((r) => r[i]?.length ?? 0))) ?? [];
  return [...head, ...column(table, widths)].join("\n");
}

export interface QueueOptions {
  json: boolean;
  configPath?: string;
}

export async function runQueue(opts: QueueOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const apiKey = requireLinearApiKey(loadEnv());
  const log = createLogger({ command: "queue" });
  const linear = await connectLinear({
    apiKey,
    teamId: config.teamId,
    workspace: config.workspace,
    log,
  });
  ensureHome();
  const db = openDb(dbPath());
  try {
    migrate(db);
    const report = await collectQueue({ db, config, linear, now: () => new Date() });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatQueue(report));
  } finally {
    db.close();
  }
}
