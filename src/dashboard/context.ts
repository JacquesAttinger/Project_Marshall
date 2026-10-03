// Last edited: 2026-10-03 18:27 CDT
// The dashboard's long-lived state: one DB handle (opened without `migrate()`, so it never races
// the daemon's migration at login), the 4 s section cache, the 60 s Linear cache, and the
// hand-off reader. The server asks this module for data and never touches the DB itself.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { listMigrations, openDb, schemaVersion } from "../db/index.ts";
import { type KillResult, orchestratorPid, requestKill } from "../kill.ts";
import type { DaemonDeps } from "../launchd.ts";
import { connectLinear, type LinearClient } from "../linear/index.ts";
import type { Logger } from "../log.ts";
import { dbPath, handoffPath } from "../paths.ts";
import { type DaemonSession, listDaemonSessions } from "../runner/index.ts";
import { liveClaims } from "../scheduler/index.ts";
import { createLinearCache, memo } from "./cache.ts";
import { collectDashboard, type DashboardData } from "./data.ts";
import { renderMarkdown } from "./html.ts";

export const SECTION_TTL_MS = 4_000;
export const LINEAR_TTL_MS = 60_000;

/** Why there is nothing to read yet: no DB file, or one older than this code. */
export type DbProblem = "missing" | "outdated";

export type DashboardView =
  | { kind: "ok"; data: DashboardData }
  | { kind: "no_db"; problem: DbProblem; daemonRunning: boolean; now: string };

export interface ContextDeps {
  config: Config;
  /** Unset: the queue explains that the key is missing, and the needs-you list is unfiltered. */
  apiKey: string | undefined;
  log: Logger;
  now?: () => Date;
  connect?: () => Promise<LinearClient>;
  listSessions?: () => Promise<DaemonSession[]>;
  daemon?: DaemonDeps;
  launchdHome?: string;
}

export interface DashboardContext {
  view(): Promise<DashboardView>;
  /** The sanitized hand-off for an identifier, or null when there is none. */
  handoffHtml(identifier: string): string | null;
  kill(identifier: string): Promise<KillResult | { kind: "no_db" }>;
  close(): void;
}

/** `TOD-17`, `CB-5`: a team key and a number. Anything else never reaches a path. */
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;

/** Opens the DB once it exists; reports a missing or outdated one instead of migrating it. */
function dbHandle(): { get(): Database | DbProblem; close(): void } {
  const latest = listMigrations().at(-1)?.version ?? 0;
  let db: Database | null = null;
  return {
    get() {
      if (!db) {
        if (!existsSync(dbPath())) return "missing";
        db = openDb(dbPath());
      }
      return schemaVersion(db) < latest ? "outdated" : db;
    },
    close() {
      db?.close();
      db = null;
    },
  };
}

export function createDashboardContext(deps: ContextDeps): DashboardContext {
  const now = deps.now ?? (() => new Date());
  const handle = dbHandle();
  const { config, apiKey, log } = deps;
  const connect =
    deps.connect ??
    (apiKey
      ? () => connectLinear({ apiKey, teamId: config.teamId, workspace: config.workspace, log })
      : null);
  const linear = createLinearCache({ connect, ttlMs: LINEAR_TTL_MS, now, log });
  const listSessions = deps.listSessions ?? listDaemonSessions;
  const launchd = { daemon: deps.daemon, launchdHome: deps.launchdHome };

  const sessionsFor = async (db: Database): Promise<DaemonSession[] | null> => {
    // No live claim, no run to check: skip the `claude agents` spawn.
    if (liveClaims(db).length === 0) return [];
    try {
      return await listSessions();
    } catch (err) {
      log.warn("dashboard.sessions_failed", { error: (err as Error).message });
      return null;
    }
  };

  const sections = memo(SECTION_TTL_MS, now, async (): Promise<DashboardView> => {
    const daemonRunning = (await orchestratorPid(launchd)) !== null;
    const db = handle.get();
    if (typeof db === "string") {
      return { kind: "no_db", problem: db, daemonRunning, now: now().toISOString() };
    }
    const [sessions, snapshot] = await Promise.all([sessionsFor(db), linear.snapshot()]);
    const data = await collectDashboard({
      db,
      config,
      now: now(),
      daemonRunning,
      sessions,
      linear: snapshot,
    });
    return { kind: "ok", data };
  });

  return {
    view: () => sections.get(),
    handoffHtml(identifier) {
      if (!IDENTIFIER.test(identifier)) return null;
      const path = handoffPath(identifier.toUpperCase());
      if (!existsSync(path)) return null;
      return renderMarkdown(readFileSync(path, "utf8")).value;
    },
    async kill(identifier) {
      const db = handle.get();
      if (typeof db === "string") return { kind: "no_db" };
      try {
        return await requestKill({ db, log, now, linear: linear.client, ...launchd }, identifier);
      } finally {
        sections.invalidate();
      }
    },
    close: () => handle.close(),
  };
}
